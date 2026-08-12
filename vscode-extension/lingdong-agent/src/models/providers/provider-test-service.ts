/**
 * 模型测试：基础连接、流式、Agent 能力，三步各自独立可测。
 *
 * 所有请求体都由固定常量构造，不接受调用方传入内容——因此「测试不携带项目代码、
 * 会话、文件、选区、Context、Plan、Timeline 与终端输出」是签名保证的。
 *
 * 协议选择刻意不自动串联：Responses 失败后不会偷偷改用 Chat Completions，
 * 而是把 `canTryFallback` 交给界面，由用户点「尝试兼容协议」再测一次。
 * 静默换协议会让用户以为自己在用 A，实际跑的是 B。
 */

import {
  extractChatToolCalls,
  extractResponsesToolCalls,
  judgeProbe,
  probeChatPayload,
  probeResponsesPayload,
  type ProbeVerdict,
} from "./capability-probe";
import {
  mapProviderError,
  withLimitedRetry,
  type ProviderError,
} from "./provider-error-mapper";
import {
  MAX_PROBE_BYTES,
  type ProviderHttpClient,
  type ProviderPath,
} from "./provider-http-client";
import type { ProviderConfig, ProviderProtocol } from "./provider-types";

/** 测试用的固定提示词，无任何隐私内容。 */
export const CONNECTION_PROMPT = "Reply with exactly: OK";

/** 只有这两种协议可以被测试与自动候选；messages 属 Anthropic 形态，本轮不测。 */
export type TestableProtocol = "responses" | "chat_completions";

export const PROTOCOL_ORDER: readonly TestableProtocol[] = ["responses", "chat_completions"];

export function toTestableProtocol(protocol: ProviderProtocol): TestableProtocol {
  return protocol === "responses" ? "responses" : "chat_completions";
}

export function protocolLabel(protocol: TestableProtocol): string {
  return protocol === "responses" ? "Responses" : "Chat Completions";
}

function pathFor(protocol: TestableProtocol): ProviderPath {
  return protocol === "responses" ? "/responses" : "/chat/completions";
}

/** 基础连接测试的请求体。 */
export function connectionPayload(
  apiModelId: string,
  protocol: TestableProtocol,
  stream: boolean,
): Record<string, unknown> {
  if (protocol === "responses") {
    return { model: apiModelId, input: CONNECTION_PROMPT, max_output_tokens: 16, stream };
  }
  // 刻意不传 n：Poe 只接受 n === 1，传了反而可能被判为非法请求。
  return {
    model: apiModelId,
    messages: [{ role: "user", content: CONNECTION_PROMPT }],
    max_tokens: 16,
    stream,
  };
}

export interface TestTarget {
  provider: Pick<ProviderConfig, "id" | "displayName" | "baseUrl">;
  apiModelId: string;
  protocol: TestableProtocol;
  credential: string;
}

export interface StepOk {
  ok: true;
  /** 服务端返回的正文片段，仅用于展示「确实回话了」，长度受限。 */
  sample?: string;
}

export interface StepFailed {
  ok: false;
  error: ProviderError;
  /** Responses 失败且还没试过兼容协议时为 true，界面据此显示按钮。 */
  canTryFallback: boolean;
}

export type StepResult = StepOk | StepFailed;

export interface ProbeStepResult {
  ok: boolean;
  verdict: ProbeVerdict;
  error?: ProviderError;
}

export interface ProviderTestServiceDeps {
  http: ProviderHttpClient;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class ProviderTestService {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ProviderTestServiceDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** 基础连接测试：Key、地址、模型是否存在、协议是否兼容、返回格式是否有效。 */
  async testConnection(target: TestTarget): Promise<StepResult> {
    const result = await this.post(target, connectionPayload(target.apiModelId, target.protocol, false));
    if (!result.ok) return this.fail(target, result.error);
    const sample = readText(result.value.body, target.protocol);
    return { ok: true, ...(sample ? { sample } : {}) };
  }

  /** 流式测试：至少要收到一个 SSE 事件。 */
  async testStreaming(target: TestTarget): Promise<StepResult> {
    const result = await this.post(
      target,
      connectionPayload(target.apiModelId, target.protocol, true),
      "text/event-stream",
    );
    if (!result.ok) return this.fail(target, result.error);
    if (!/(^|\n)data:/.test(result.value.body)) {
      return {
        ok: false,
        error: {
          code: "invalid-response",
          reason: "服务没有返回流式事件。",
          recovery: "该模型可能不支持流式输出，可仍以非流式方式使用。",
        },
        canTryFallback: false,
      };
    }
    return { ok: true };
  }

  /** Agent 能力检测：完全无副作用的工具回显。 */
  async probeAgentCapability(target: TestTarget): Promise<ProbeStepResult> {
    const payload = target.protocol === "responses"
      ? probeResponsesPayload(target.apiModelId)
      : probeChatPayload(target.apiModelId);
    const result = await this.post(target, payload);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        verdict: { agentCompatible: false, reason: "no-tool-call", detail: result.error.reason },
      };
    }
    const parsed = safeJson(result.value.body);
    const calls = target.protocol === "responses"
      ? extractResponsesToolCalls(parsed)
      : extractChatToolCalls(parsed);
    const verdict = judgeProbe(calls);
    return { ok: verdict.agentCompatible, verdict };
  }

  private async post(
    target: TestTarget,
    payload: Record<string, unknown>,
    accept: "json" | "text/event-stream" = "json",
  ): Promise<{ ok: true; value: { body: string } } | { ok: false; error: ProviderError }> {
    const outcome = await withLimitedRetry<{ body: string }>(
      async () => {
        try {
          const response = await this.deps.http.send({
            provider: target.provider,
            path: pathFor(target.protocol),
            method: "POST",
            credential: target.credential,
            payload,
            accept,
            maxBytes: MAX_PROBE_BYTES,
          });
          if (response.status >= 200 && response.status < 300) {
            return { ok: true, value: { body: response.body } };
          }
          return {
            ok: false,
            error: mapProviderError({
              status: response.status,
              headers: response.headers,
              body: response.body,
            }),
          };
        } catch (error) {
          return { ok: false, error: mapProviderError({ error }) };
        }
      },
      { sleep: this.sleep, ...(this.deps.random ? { random: this.deps.random } : {}) },
    );
    return outcome.ok ? outcome : { ok: false, error: outcome.error };
  }

  private fail(target: TestTarget, error: ProviderError): StepFailed {
    // 只在「用 Responses 试过且像是格式不合」时才提议兼容协议。
    const worthFallback = target.protocol === "responses"
      && (error.code === "protocol-incompatible"
        || error.code === "model-not-found"
        || error.code === "invalid-response");
    return { ok: false, error, canTryFallback: worthFallback };
  }
}

/** 六种结论，对应规格第十五节。 */
export type TestConclusion =
  | "agent-ready"
  | "ask-only"
  | "protocol-incompatible"
  | "model-not-found"
  | "invalid-key"
  | "unreachable";

export interface FullTestOutcome {
  conclusion: TestConclusion;
  protocol: TestableProtocol;
  connection: StepResult;
  streaming?: StepResult;
  probe?: ProbeStepResult;
  /** 是否可以保存为已启用模型：连接测试通过就可以，能力不足只是限制到 Ask。 */
  savable: boolean;
  canTryFallback: boolean;
}

export function concludeFromError(error: ProviderError): TestConclusion {
  switch (error.code) {
    case "invalid-key": return "invalid-key";
    case "model-not-found": return "model-not-found";
    case "protocol-incompatible": return "protocol-incompatible";
    case "network-unreachable":
    case "tls-error":
    case "provider-unavailable":
    case "timeout":
      return "unreachable";
    default:
      return "unreachable";
  }
}

export const CONCLUSION_TEXT: Record<TestConclusion, string> = {
  "agent-ready": "完全支持 Agent",
  "ask-only": "仅支持 Ask",
  "protocol-incompatible": "协议不兼容",
  "model-not-found": "模型不存在",
  "invalid-key": "Key 无效",
  unreachable: "服务不可访问",
};

/**
 * 依次跑三步。连接失败就停下——后面两步没有意义，而且会白烧额度。
 */
export async function runFullTest(
  service: ProviderTestService,
  target: TestTarget,
): Promise<FullTestOutcome> {
  const connection = await service.testConnection(target);
  if (!connection.ok) {
    return {
      conclusion: concludeFromError(connection.error),
      protocol: target.protocol,
      connection,
      savable: false,
      canTryFallback: connection.canTryFallback,
    };
  }

  const streaming = await service.testStreaming(target);
  const probe = await service.probeAgentCapability(target);
  return {
    conclusion: probe.verdict.agentCompatible ? "agent-ready" : "ask-only",
    protocol: target.protocol,
    connection,
    streaming,
    probe,
    // 连接通了就允许保存；能力检测没过只是限制到 Ask，不是拒绝保存。
    savable: true,
    canTryFallback: false,
  };
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** 取一小段回复用于展示，确认「确实是模型在说话」。 */
function readText(body: string, protocol: TestableProtocol): string | undefined {
  const parsed = safeJson(body);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (protocol === "chat_completions") {
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return undefined;
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    const content = message?.content;
    return typeof content === "string" ? content.trim().slice(0, 80) : undefined;
  }
  const output = (parsed as { output_text?: unknown }).output_text;
  if (typeof output === "string") return output.trim().slice(0, 80);
  return undefined;
}
