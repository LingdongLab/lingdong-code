/**
 * Provider 错误映射与有限退避。
 *
 * 状态码表来自 Poe 官方错误文档，但同一张表对 DeepSeek 与自定义 OpenAI-compatible
 * 网关同样成立（都是 OpenAI 风格的错误约定），所以放在公共层而不是某个 Provider 目录里。
 *
 * 三条硬规则写在这一层，让上层无法绕过：
 * - 只对 429 / 500 / 502 / 529 重试，且最多两次。
 * - 重试只是重发同一个请求，绝不换模型、换 Provider 或回退 xAI。
 * - 展示文案里没有 Key、Header、完整请求或完整响应的位置——类型里就没有这些字段。
 */

import { redact } from "../../privacy/secret-redactor";
import { TransportError, type TransportFailureKind } from "./provider-http-client";

export type ProviderErrorCode =
  | "invalid-key"
  | "insufficient-balance"
  | "forbidden"
  | "model-not-found"
  | "timeout"
  | "context-too-large"
  | "rate-limited"
  | "protocol-incompatible"
  | "network-unreachable"
  | "tls-error"
  | "provider-unavailable"
  | "invalid-response"
  | "cancelled"
  | "unknown";

export interface ProviderError {
  code: ProviderErrorCode;
  /** 用户能理解的原因，不含任何凭据或原始报文。 */
  reason: string;
  /** 可恢复操作提示。 */
  recovery: string;
  /** 原始 HTTP 状态码，仅用于诊断展示。 */
  status?: number;
  /** 服务端 Retry-After（秒），仅在存在时带上。 */
  retryAfterSeconds?: number;
}

const CODE_TEXT: Record<ProviderErrorCode, { reason: string; recovery: string }> = {
  "invalid-key": { reason: "API Key 无效或已过期。", recovery: "请重新录入该服务商的 API Key。" },
  "insufficient-balance": {
    reason: "服务商账户余额或积分不足。",
    recovery: "请为账户补充额度后重试；调用付费模型需要有效订阅或足够的附加积分。",
  },
  forbidden: { reason: "没有访问该模型的权限，或请求被服务商拒绝。", recovery: "请确认账户权限与模型可见性。" },
  "model-not-found": { reason: "服务商没有这个模型或 Bot。", recovery: "请检查 Model ID 是否拼写正确。" },
  timeout: { reason: "模型响应超时。", recovery: "可稍后重试；若持续超时，请换用更快的模型。" },
  "context-too-large": { reason: "输入超过该模型的上下文长度。", recovery: "请压缩上下文或改用上下文更长的模型。" },
  "rate-limited": { reason: "请求频率超过服务商限制。", recovery: "已自动退避重试仍未成功，请稍后再试。" },
  "protocol-incompatible": {
    reason: "该模型不接受当前协议的请求格式。",
    recovery: "可尝试兼容协议（Chat Completions）后重新测试。",
  },
  "network-unreachable": { reason: "无法连接到服务地址。", recovery: "请检查网络、代理与服务地址是否正确。" },
  "tls-error": { reason: "TLS 握手失败。", recovery: "请确认服务证书有效，且地址使用 https。" },
  "provider-unavailable": { reason: "服务商暂时不可用或过载。", recovery: "请稍后重试。" },
  "invalid-response": { reason: "服务返回了无法解析的响应。", recovery: "请确认该地址是 OpenAI 兼容接口。" },
  cancelled: { reason: "请求已取消。", recovery: "可重新发起测试。" },
  unknown: { reason: "出现未预期的错误。", recovery: "请重试；若持续失败请查看日志。" },
};

/** HTTP 状态码 → 错误码。表里的含义全部来自服务商公开文档，不臆造。 */
export function codeForStatus(status: number): ProviderErrorCode {
  switch (status) {
    case 400: return "protocol-incompatible";
    case 401: return "invalid-key";
    case 402: return "insufficient-balance";
    case 403: return "forbidden";
    case 404: return "model-not-found";
    case 408: return "timeout";
    case 413: return "context-too-large";
    case 429: return "rate-limited";
    case 500: return "provider-unavailable";
    case 502: return "provider-unavailable";
    case 503: return "provider-unavailable";
    case 529: return "provider-unavailable";
    default:
      if (status >= 500) return "provider-unavailable";
      if (status >= 400) return "unknown";
      return "invalid-response";
  }
}

function codeForTransport(kind: TransportFailureKind): ProviderErrorCode {
  switch (kind) {
    case "timeout": return "timeout";
    case "cancelled": return "cancelled";
    case "tls": return "tls-error";
    case "too-large": return "invalid-response";
    case "cross-origin-redirect": return "network-unreachable";
    default: return "network-unreachable";
  }
}

export interface MapErrorInput {
  status?: number;
  headers?: Record<string, string>;
  /** 响应正文，仅用于提取服务商的 error.message；不会原样展示。 */
  body?: string;
  error?: unknown;
}

export function mapProviderError(input: MapErrorInput): ProviderError {
  if (input.error !== undefined) {
    const kind = input.error instanceof TransportError ? input.error.kind : "network";
    const code = codeForTransport(kind);
    const text = CODE_TEXT[code];
    return { code, reason: text.reason, recovery: text.recovery };
  }

  const status = input.status ?? 0;
  const code = codeForStatus(status);
  const text = CODE_TEXT[code];
  const detail = extractMessage(input.body);
  const retryAfter = parseRetryAfter(input.headers);
  return {
    code,
    // 服务商自己的说明常常更具体，但必须脱敏后再拼进来，且长度受限。
    reason: detail ? `${text.reason}（服务返回：${detail}）` : text.reason,
    recovery: text.recovery,
    status,
    ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
  };
}

/** OpenAI 风格的 `{ error: { message } }`；解析不出来就不展示。 */
function extractMessage(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim() !== "") return clip(message);
    }
    const message = (parsed as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return clip(message);
    return undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return redact(text.trim()).slice(0, 200);
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const raw = headers["retry-after"] ?? headers["x-ratelimit-reset-requests"];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** 完整展示文案：Provider + 模型 + 原因 + 可恢复操作。 */
export function describeProviderError(
  error: ProviderError,
  context: { providerName: string; modelName?: string },
): string {
  const target = context.modelName
    ? `${context.providerName} · ${context.modelName}`
    : context.providerName;
  return `${target}：${error.reason}${error.recovery}`;
}

// ---------------------------------------------------------------------------
// 有限退避
// ---------------------------------------------------------------------------

/** 只有这些状态码值得重试；其余（尤其是 401 / 402 / 404）重试只是浪费额度。 */
const RETRYABLE_CODES: readonly ProviderErrorCode[] = ["rate-limited", "provider-unavailable"];

/** 两次退避的基准延迟，取自服务商文档建议的 250ms 起步 + jitter。 */
export const BACKOFF_BASE_MS: readonly number[] = [250, 1_000];

export const MAX_RETRIES = BACKOFF_BASE_MS.length;

export function isRetryable(error: ProviderError): boolean {
  return RETRYABLE_CODES.includes(error.code);
}

/**
 * 第 attempt 次（从 0 起）失败后的等待时长。
 * 服务端给了 Retry-After 就尊重它，但仍然夹在上限内，避免被要求等上几分钟。
 */
export function backoffDelayMs(
  attempt: number,
  error: ProviderError,
  random: () => number = Math.random,
): number {
  const base = BACKOFF_BASE_MS[attempt] ?? BACKOFF_BASE_MS[BACKOFF_BASE_MS.length - 1]!;
  const jitter = Math.round(base * 0.25 * random());
  const suggested = error.retryAfterSeconds !== undefined
    ? Math.min(error.retryAfterSeconds * 1_000, 10_000)
    : 0;
  return Math.max(base + jitter, suggested);
}

export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * 带上限的重试。
 *
 * 注意 `attempt` 只会重发**完全相同**的请求：调用方不得在回调里换模型或换 Provider。
 * 也因此只能用在尚未产生任何工具副作用的阶段（连接测试、能力检测、目录同步）。
 */
export async function withLimitedRetry<T>(
  attempt: (tryIndex: number) => Promise<{ ok: true; value: T } | { ok: false; error: ProviderError }>,
  deps: RetryDeps,
): Promise<{ ok: true; value: T } | { ok: false; error: ProviderError; attempts: number }> {
  let last: ProviderError = { code: "unknown", ...CODE_TEXT.unknown };
  for (let index = 0; index <= MAX_RETRIES; index += 1) {
    const result = await attempt(index);
    if (result.ok) return result;
    last = result.error;
    if (!isRetryable(result.error) || index === MAX_RETRIES) break;
    await deps.sleep(backoffDelayMs(index, result.error, deps.random));
  }
  return { ok: false, error: last, attempts: MAX_RETRIES + 1 };
}
