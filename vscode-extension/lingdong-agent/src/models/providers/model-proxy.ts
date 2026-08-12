/**
 * 本地转发层：Grok 不直连服务商，改连 127.0.0.1 上的这个服务，由它转发并修补响应。
 *
 * 存在的唯一理由是 usage 里的 null（见 usage-sanitizer.ts 的说明）：Grok 是外部
 * 二进制，改不了它的反序列化，只能在它看到字节之前把话说圆。
 *
 * 几条安全约束刻在实现里，不靠调用方自觉：
 *
 * - 只监听 127.0.0.1，端口由系统随机分配，不进任何持久化文件。
 * - 不是通用代理。上游地址只能来自 `register()` 登记过的 ProviderConfig.baseUrl，
 *   路径里那段随机 token 决定用哪一条，认不出来就 404。本机别的进程既猜不到 token，
 *   也没法让它转发到任意地址。
 * - **绝不注入凭据**。Authorization 原样透传：Grok 带什么我们转什么。
 *   这样这个服务本身不持有、也变不出任何 key，不构成新的凭据出口。
 * - 响应体按 SSE 分帧流式转发，不整块缓冲，否则刚修好的出字节奏又会被这里毁掉。
 * - **请求体**在 POST JSON 时会整包读入：Grok 本来就是整包发来的，读完整包不影响
 *   出字；代价是我们能在出站前修空 call_id（切模型后 DeepSeek 会因此 400），
 *   以及把图片标记换成真正的图片块。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";

import type { ImageStore } from "../../services/image-store";
import { hasImageMarker, injectImages } from "./image-injection";
import { sanitizeOutboundRequest } from "./request-sanitizer";
import { sanitizeJsonText, sanitizeSseEvent } from "./usage-sanitizer";

/** 逐跳头部：这些描述的是单段连接，不能原样转给上游或转回给 Grok。 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  // 改写过内容之后原长度就不对了；SSE 本来也是分块传的。
  "content-length",
  // 要拿明文才能修补，所以不让上游压缩。
  "content-encoding",
  "accept-encoding",
]);

export interface ProxyRoute {
  /** 登记时分配的随机段，出现在本地地址的路径里。 */
  token: string;
  /** 上游真实地址，例如 https://api.poe.com/v1。 */
  upstream: string;
}

export type ProxyFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 出站超时。
 *
 * 没有这两个值时，上游握手后不吐字节的情况会一路挂到 ACP 那 10 分钟的静默看门狗，
 * 用户看到的就是「发完消息什么都没有，也不报错」。分两段是因为两段的正常耗时量级不同：
 * 等响应头是网络问题，等下一个数据块是模型在想。
 *
 * 都刻意留在 10 分钟看门狗之下，让报错发生在知道原因的这一层——
 * 这里能说清是哪个服务商、卡在握手还是卡在流中间，看门狗只能说「模型没反应」。
 */
export interface ProxyTimeouts {
  /** 建连到拿到响应头。流式接口通常秒回头，慢也是网络或网关的问题。 */
  headersMs: number;
  /** 流式响应里两个数据块之间的最长间隔。 */
  streamIdleMs: number;
}

export const DEFAULT_PROXY_TIMEOUTS: ProxyTimeouts = {
  headersMs: 120_000,
  streamIdleMs: 180_000,
};

export interface ModelProxyDeps {
  log?: (line: string) => void;
  /** 可注入是为了可测；默认用 Node 的全局 fetch。 */
  fetch?: ProxyFetch;
  /**
   * 本轮粘贴的图片。返回 undefined 表示没有图片通道，此时请求体一律流式直传。
   * 拿的是函数而不是实例，因为代理比会话活得久，中途换会话要能跟着变。
   */
  images?: () => ImageStore | undefined;
  /** 可注入是为了可测；生产用 DEFAULT_PROXY_TIMEOUTS。 */
  timeouts?: Partial<ProxyTimeouts>;
  /** 可注入是为了可测。 */
  now?: () => number;
}

/** 谁掐断了这次转发。区分它才知道该不该报错：Grok 自己放弃不必报，超时必须报。 */
type CancelReason = "client" | "headers-timeout" | "idle-timeout";

const CANCEL_MESSAGE: Record<Exclude<CancelReason, "client">, string> = {
  "headers-timeout": "模型服务在超时时间内没有返回响应头，请求已中止。",
  "idle-timeout": "模型服务中途停止输出，请求已中止。",
};

export class ModelProxy {
  private server: Server | undefined;
  private portValue: number | undefined;
  private readonly routes = new Map<string, string>();
  private readonly fetchImpl: ProxyFetch;
  private readonly timeouts: ProxyTimeouts;
  private readonly now: () => number;

  constructor(private readonly deps: ModelProxyDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.timeouts = { ...DEFAULT_PROXY_TIMEOUTS, ...deps.timeouts };
    this.now = deps.now ?? (() => Date.now());
  }

  get port(): number | undefined {
    return this.portValue;
  }

  get running(): boolean {
    return this.portValue !== undefined;
  }

  /**
   * 登记一个上游并拿到本地地址。同一个上游重复登记复用同一段 token，
   * 免得每次重写配置都换地址、把 Grok 那边的连接池作废。
   */
  register(upstream: string): string {
    for (const [token, existing] of this.routes) {
      if (existing === upstream) return this.localUrl(token);
    }
    const token = randomBytes(12).toString("hex");
    this.routes.set(token, upstream);
    return this.localUrl(token);
  }

  private localUrl(token: string): string {
    if (this.portValue === undefined) throw new Error("转发层尚未启动");
    return `http://127.0.0.1:${this.portValue}/${token}`;
  }

  async start(): Promise<number> {
    if (this.portValue !== undefined) return this.portValue;

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      // 只绑回环，端口交给系统。
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("无法确定转发层端口"));
          return;
        }
        resolve(address.port);
      });
    });

    server.removeAllListeners("error");
    server.on("error", (error) => this.deps.log?.(`[proxy] ${errorText(error)}`));
    this.portValue = port;
    return port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.portValue = undefined;
    this.routes.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? "/";
    const match = /^\/([0-9a-f]{24})(\/.*)?$/.exec(url);
    const upstream = match ? this.routes.get(match[1] ?? "") : undefined;
    if (!match || upstream === undefined) {
      // 认不出的 token 一律 404，不透露这里有几条路由。
      response.writeHead(404).end();
      return;
    }

    const target = `${upstream.replace(/\/+$/, "")}${match[2] ?? ""}`;
    const host = hostOf(target);
    const started = this.now();
    const abort = new AbortController();
    let cancelled: CancelReason | undefined;
    const cancel = (reason: CancelReason): void => {
      if (cancelled) return;
      cancelled = reason;
      abort.abort();
    };

    // 监听的是 response 的关闭，不是 request 的 "aborted"。
    // 后者只在请求体还没读完就被中止时才触发，而等上游响应的这段时间里请求体早已读完 ——
    // 也就是说在真正会挂住的那个窗口内，"aborted" 永远不会来。
    // 结果就是 Grok 掐断连接后，这里的 fetch 和转发循环仍在跑，上游连接一直不释放。
    response.on("close", () => {
      if (!response.writableEnded) cancel("client");
    });

    const headersTimer = setTimeout(() => cancel("headers-timeout"), this.timeouts.headersMs);
    this.deps.log?.(`[proxy] → ${request.method ?? "GET"} ${host}`);
    try {
      const rewritten = await this.rewriteBody(request);
      const upstreamResponse = await this.fetchImpl(target, {
        method: request.method ?? "GET",
        headers: forwardHeaders(request.headers, rewritten?.body.byteLength),
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : rewritten
            ? { body: rewritten.body }
            : { body: Readable.toWeb(request) as ReadableStream, duplex: "half" }),
        signal: abort.signal,
        redirect: "error",
      } as RequestInit);
      clearTimeout(headersTimer);

      if (rewritten && rewritten.injected > 0 && upstreamResponse.status >= 400) {
        // 目录声明支持图片、实际调用被拒的情况一定会有。错误正文会原样回给 Grok，
        // 但那串 JSON 看不出是图的问题，日志里得替用户点破。
        this.deps.log?.(
          `[proxy] 带图请求被上游拒绝（${upstreamResponse.status}）；`
          + "该模型可能实际不接受图片输入，换一个视觉模型再试。",
        );
      }
      await this.relay(upstreamResponse, response, cancel);
      this.deps.log?.(
        `[proxy] ← ${upstreamResponse.status} ${host} ${this.now() - started}ms`,
      );
    } catch (error) {
      clearTimeout(headersTimer);
      // Grok 自己放弃了这条请求：它已经不在听了，写什么都没意义。
      if (cancelled === "client") {
        this.deps.log?.(`[proxy] × 客户端断开 ${host} ${this.now() - started}ms`);
        response.destroy();
        return;
      }
      const detail = cancelled ? CANCEL_MESSAGE[cancelled] : "本地转发层无法连接模型服务。";
      this.deps.log?.(
        `[proxy] × ${cancelled ?? "转发失败"} ${host} ${this.now() - started}ms：${errorText(error)}`,
      );
      this.fail(response, detail);
    }
  }

  /**
   * 把失败告诉 Grok。
   *
   * 分两种写法，因为流已经开始之后 writeHead 是无效的：那时只能用 SSE 的语义说话。
   * 早先这里在两种情况下都直接 end 一段裸 JSON —— 流开始之后那段既不是合法 SSE 事件、
   * 也不是终止标记，解析器会把它丢掉然后以为流正常结束，错误就此蒸发，
   * 表现成「一直没有回复」或者「回了个空的」。
   */
  private fail(response: ServerResponse, message: string): void {
    const body = { error: { message } };
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    // [DONE] 不能省：少了它，按 OpenAI 流式约定写的客户端会继续等终止标记。
    response.end(`event: error\ndata: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`);
  }

  /**
   * POST JSON 整包读入后改写出站请求；非 JSON / 非 POST 返回 undefined，走流式直传。
   *
   * 两件事都在这里做：
   * 1. 修补空 call_id / 空 tool_calls（切模型后 DeepSeek 严格校验会 400）
   * 2. 有粘贴图片时，把标记换成真正的图片块
   */
  private async rewriteBody(
    request: IncomingMessage,
  ): Promise<{ body: Buffer; injected: number } | undefined> {
    if (request.method !== "POST") return undefined;
    if (!(request.headers["content-type"] ?? "").includes("json")) return undefined;

    const chunks: Buffer[] = [];
    for await (const piece of request) chunks.push(piece as Buffer);
    let text = Buffer.concat(chunks).toString("utf8");

    const repaired = sanitizeOutboundRequest(text);
    if (repaired.changed) {
      text = repaired.body;
      this.deps.log?.(
        `[proxy] 已修补出站工具历史：补 call_id ${repaired.fixedCallIds} 处`
        + (repaired.strippedEmptyToolCalls > 0
          ? `、去掉空 tool_calls ${repaired.strippedEmptyToolCalls} 处`
          : ""),
      );
    }

    const store = this.deps.images?.();
    if (!store || store.isEmpty || !hasImageMarker(text)) {
      return { body: Buffer.from(text, "utf8"), injected: 0 };
    }

    const result = injectImages(text, (id) => store.dataUrl(id));
    if (!result) return { body: Buffer.from(text, "utf8"), injected: 0 };
    this.deps.log?.(
      result.injected > 0
        ? `[proxy] 已注入 ${result.injected} 张图片`
        : "[proxy] 请求里的图片标记无法注入，已清理",
    );
    return { body: Buffer.from(result.body, "utf8"), injected: result.injected };
  }

  private async relay(
    upstream: Response,
    response: ServerResponse,
    cancel: (reason: CancelReason) => void,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    });

    const contentType = upstream.headers.get("content-type") ?? "";
    const streaming = contentType.includes("text/event-stream");

    if (!upstream.body) {
      response.writeHead(upstream.status, headers).end();
      return;
    }

    if (!streaming) {
      // 非流式响应本来就要整块读完才能用，这里缓冲不影响出字节奏。
      const text = await upstream.text();
      const fixed = contentType.includes("json") ? sanitizeJsonText(text) : text;
      const body = Buffer.from(fixed, "utf8");
      response.writeHead(upstream.status, { ...headers, "Content-Length": String(body.byteLength) });
      response.end(body);
      return;
    }

    response.writeHead(upstream.status, headers);
    response.flushHeaders?.();

    // 头发完了不等于后面一定有字节。上游可能就此静默，而这时 Grok 已经在等流，
    // 所以流中间也要有自己的看门狗，每收到一块就重置。
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => cancel("idle-timeout"), this.timeouts.streamIdleMs);
    };

    // 按 SSE 的空行分帧：凑齐一个完整事件就立刻发走，绝不多攒。
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      armIdle();
      for await (const piece of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        armIdle();
        buffer += decoder.decode(piece, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          response.write(`${sanitizeSseEvent(block)}\n\n`);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
    buffer += decoder.decode();
    if (buffer !== "") response.write(sanitizeSseEvent(buffer));
    response.end();
  }
}

/** 日志里只留主机名：路径可能带上游自定义的标识，没必要记。 */
function hostOf(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return "未知上游";
  }
}

/** 透传请求头，去掉逐跳头部。Authorization 属于要原样带上的那一类。 */
function forwardHeaders(
  incoming: IncomingMessage["headers"],
  /** 改写过请求体时的新长度；HOP_BY_HOP 抹掉了原来的 content-length，注了图就变长了。 */
  bodyLength?: number,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  // 明确要明文，才能修补。
  headers["accept-encoding"] = "identity";
  if (bodyLength !== undefined) headers["content-length"] = String(bodyLength);
  return headers;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
