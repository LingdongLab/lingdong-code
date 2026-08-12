/**
 * Provider HTTP 客户端。
 *
 * 这是整个扩展里唯一直接访问模型服务商的地方，因此几条安全约束都落在 API 形状上，
 * 而不是靠调用方自觉：
 *
 * - 请求目标只能由 `ProviderConfig.baseUrl`（保存时已过 validateBaseUrl）加上一个
 *   固定路径字面量拼出。函数签名里没有「任意 URL」这个入口，Webview 结构上就传不进来。
 * - 传输层可注入，默认实现基于 Node 20 的全局 fetch。注入是为了可测：仓库里此前
 *   没有任何 HTTP 用法，也没有 mock 先例。
 * - 跨域重定向直接失败。放行跨域跳转等于让服务商把凭据引到别的主机上。
 * - 日志只记方法、主机、路径、状态与耗时，且整行过 redact。不记请求正文，
 *   不记 Authorization——那是最容易泄漏凭据的两处。
 */

import { redact } from "../../privacy/secret-redactor";
import type { ProviderConfig } from "./provider-types";

/** 允许访问的路径；联合类型而不是 string，避免拼出任意地址。 */
export type ProviderPath = "/models" | "/chat/completions" | "/responses";

/**
 * 少数端点不在 `base_url` 的路径之下。
 *
 * Poe 的余额查询就是这种：`base_url` 是 `https://api.poe.com/v1`，
 * 而余额在 `https://api.poe.com/usage/current_balance`。这类路径单独成一个联合，
 * 只能配 `base: "origin"` 使用，避免把它误拼到 `/v1` 后面。
 */
export type ProviderOriginPath = "/usage/current_balance";

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** 传输层故障（连不上、超时、体积超限、跨域跳转）；HTTP 状态码类错误不走这里。 */
export type TransportFailureKind =
  | "timeout"
  | "cancelled"
  | "network"
  | "tls"
  | "too-large"
  | "cross-origin-redirect";

export class TransportError extends Error {
  constructor(readonly kind: TransportFailureKind, message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/** 目录类响应可能有几百个模型；探测类响应必须很小。 */
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
export const MAX_PROBE_BYTES = 256 * 1024;

export const DEFAULT_TIMEOUT_MS = 30_000;

/** 同源跳转最多跟随两跳，够覆盖常见的规范化重定向，又不至于绕远。 */
const MAX_REDIRECTS = 2;

/**
 * 请求目标。两个分支互斥，所以 `/usage/current_balance` 在类型上就接不到
 * `baseUrl` 拼接那一支，反过来 `/chat/completions` 也没法要求走 origin。
 */
export type ProviderTarget =
  | { base?: "baseUrl"; path: ProviderPath }
  | { base: "origin"; path: ProviderOriginPath };

export type ProviderRequest = ProviderTarget & ProviderRequestBase;

interface ProviderRequestBase {
  provider: Pick<ProviderConfig, "id" | "displayName" | "baseUrl">;
  method: "GET" | "POST";
  /** 凭据；只在这一刻拼进 Authorization，不落任何日志。 */
  credential?: string;
  payload?: unknown;
  accept?: "json" | "text/event-stream";
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ProviderHttpClientDeps {
  transport?: HttpTransport;
  log?: (line: string) => void;
  now?: () => number;
}

/** 由 baseUrl 与固定路径拼出目标地址。 */
export function buildProviderUrl(baseUrl: string, path: ProviderPath): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** 由 baseUrl 的 origin 与固定路径拼出目标地址，用于 `/v1` 之外的端点。 */
export function buildOriginUrl(baseUrl: string, path: ProviderOriginPath): string {
  try {
    return `${new URL(baseUrl).origin}${path}`;
  } catch {
    throw new TransportError("network", "服务地址无法解析，无法定位该端点。");
  }
}

export class ProviderHttpClient {
  private readonly transport: HttpTransport;
  private readonly now: () => number;

  constructor(private readonly deps: ProviderHttpClientDeps = {}) {
    this.transport = deps.transport ?? fetchTransport;
    this.now = deps.now ?? (() => Date.now());
  }

  async send(request: ProviderRequest): Promise<HttpResponse> {
    const url = request.base === "origin"
      ? buildOriginUrl(request.provider.baseUrl, request.path)
      : buildProviderUrl(request.provider.baseUrl, request.path);
    const headers: Record<string, string> = {
      Accept: request.accept === "text/event-stream" ? "text/event-stream" : "application/json",
    };
    if (request.payload !== undefined) headers["Content-Type"] = "application/json";
    if (request.credential) headers.Authorization = `Bearer ${request.credential}`;

    const started = this.now();
    const wire: HttpRequest = {
      url,
      method: request.method,
      headers,
      ...(request.payload !== undefined ? { body: JSON.stringify(request.payload) } : {}),
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: request.maxBytes ?? MAX_PROBE_BYTES,
      ...(request.signal ? { signal: request.signal } : {}),
    };

    try {
      const response = await this.transport(wire);
      this.trace(request, url, started, String(response.status));
      return response;
    } catch (error) {
      const kind = error instanceof TransportError ? error.kind : "network";
      this.trace(request, url, started, kind);
      throw error;
    }
  }

  /**
   * 只记结构信息。请求正文可能含用户代码，Authorization 含凭据，两者都不进日志；
   * 整行仍然过一遍 redact 作为兜底。
   */
  private trace(request: ProviderRequest, url: string, started: number, outcome: string): void {
    if (!this.deps.log) return;
    const elapsed = this.now() - started;
    const host = safeHost(url);
    this.deps.log(
      redact(`[provider-http] ${request.method} ${host}${request.path} → ${outcome} (${elapsed}ms)`),
    );
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid-url>";
  }
}

/**
 * 默认传输：全局 fetch + 手动重定向 + 字节上限。
 *
 * `redirect: "manual"` 是刻意的——自动跟随会把 Authorization 一起带到新主机上。
 * 这里只在同源时跟随，跨域一律失败。
 */
export const fetchTransport: HttpTransport = async (request) => {
  let current = request.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchOnce({ ...request, url: current });
    if (!isRedirect(response.status)) return response;

    const location = response.headers.location;
    if (!location) return response;
    const next = resolveRedirect(current, location);
    if (!next) {
      throw new TransportError("network", "服务返回了无法解析的重定向地址。");
    }
    if (!sameOrigin(current, next)) {
      throw new TransportError(
        "cross-origin-redirect",
        `服务要求跳转到另一个域名（${safeHost(next)}），已拒绝：凭据不会被带到未确认的主机。`,
      );
    }
    current = next;
  }
  throw new TransportError("network", "重定向次数过多。");
};

async function fetchOnce(request: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutSignal()), request.timeoutMs);
  const onExternalAbort = (): void => controller.abort(new CancelSignal());
  request.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await readCapped(response, request.maxBytes);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, headers, body };
  } catch (error) {
    throw toTransportError(error, controller.signal.reason);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onExternalAbort);
  }
}

class TimeoutSignal {
  readonly kind = "timeout";
}

class CancelSignal {
  readonly kind = "cancelled";
}

function toTransportError(error: unknown, reason: unknown): TransportError {
  if (error instanceof TransportError) return error;
  if (reason instanceof TimeoutSignal) {
    return new TransportError("timeout", "请求超时。");
  }
  if (reason instanceof CancelSignal) {
    return new TransportError("cancelled", "请求已取消。");
  }
  const detail = error instanceof Error ? error.message : String(error);
  if (/certificate|tls|ssl|self.signed/i.test(detail)) {
    return new TransportError("tls", `TLS 握手失败：${detail}`);
  }
  return new TransportError("network", `无法连接到服务：${detail}`);
}

/** 按字节累计并在超限时立刻中止，不把超大响应整个读进内存。 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TransportError("too-large", `响应超过 ${Math.round(maxBytes / 1024)} KiB 上限，已中止。`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveRedirect(from: string, location: string): string | undefined {
  try {
    return new URL(location, from).toString();
  } catch {
    return undefined;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
