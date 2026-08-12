/**
 * 最小 MCP stdio 传输。
 * 同时支持：
 * - 换行分隔 JSON（Grok 0.2.x 实际使用的格式）
 * - Content-Length 分帧（LSP / 部分 MCP SDK）
 * 响应帧格式与当前请求一致。
 */

import { createInterface } from "node:readline";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type McpHandler = (request: JsonRpcRequest) => Promise<unknown> | unknown;

export type McpFraming = "ndjson" | "content-length";

export function startMcpStdio(handler: McpHandler): void {
  let buffer = Buffer.alloc(0);
  let expected = -1;
  let framing: McpFraming | undefined;
  let pending = 0;
  let stdinEnded = false;

  const maybeExit = (): void => {
    // stdin 关闭且无在途请求才退出；避免 search 还在飞就被 end 信号杀掉。
    if (stdinEnded && pending === 0) process.exit(0);
  };

  const handleBody = (body: string, mode: McpFraming): void => {
    framing = mode;
    pending += 1;
    void dispatch(body, handler, mode).finally(() => {
      pending -= 1;
      maybeExit();
    });
  };

  const flush = (): void => {
    while (true) {
      if (buffer.length === 0) return;

      // 尚未判定帧格式时：跳过前导空白，再按首字节分流。
      if (!framing && expected < 0) {
        const start = skipLeadingWs(buffer);
        if (start > 0) buffer = buffer.subarray(start);
        if (buffer.length === 0) return;
        const first = buffer[0];
        if (first === 0x7b /* { */) {
          framing = "ndjson";
        } else if (
          first === 0x43 /* C */ || first === 0x63 /* c */
          || looksLikeHeader(buffer)
        ) {
          framing = "content-length";
        } else {
          // 无法识别则等更多数据；若已有换行则丢掉坏行。
          const nl = buffer.indexOf(0x0a);
          if (nl < 0) return;
          buffer = buffer.subarray(nl + 1);
          continue;
        }
      }

      if (framing === "ndjson") {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) return;
        const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
        buffer = buffer.subarray(nl + 1);
        if (!line.trim()) continue;
        handleBody(line, "ndjson");
        continue;
      }

      // content-length
      if (expected < 0) {
        const headerEnd = indexOfHeaderEnd(buffer);
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        expected = Number(match[1]);
        buffer = buffer.subarray(headerEnd + 4);
      }
      if (buffer.length < expected) return;
      const body = buffer.subarray(0, expected).toString("utf8");
      buffer = buffer.subarray(expected);
      expected = -1;
      handleBody(body, "content-length");
    }
  };

  process.stdin.on("data", (chunk: Buffer | string) => {
    const next = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    buffer = Buffer.concat([buffer, next]);
    flush();
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeExit();
  });
  process.stdin.resume();
}

/** 测试用：不绑 stdin，直接处理一条请求。 */
export async function handleMcpMessage(raw: string, handler: McpHandler): Promise<JsonRpcResponse | undefined> {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
  }
  if (!message.method) {
    return {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
  // 通知无 id，不回应。
  if (message.id === undefined) {
    try { await handler(message); } catch { /* ignore */ }
    return undefined;
  }
  try {
    const result = await handler(message);
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      && typeof (error as { code: unknown }).code === "number"
      ? (error as { code: number }).code
      : -32000;
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function dispatch(
  body: string,
  handler: McpHandler,
  framing: McpFraming = "content-length",
): Promise<void> {
  const response = await handleMcpMessage(body, handler);
  if (response) writeMessage(response, framing);
}

export function writeMessage(message: unknown, framing: McpFraming = "content-length"): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (framing === "ndjson") {
    process.stdout.write(body);
    process.stdout.write("\n");
    return;
  }
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function skipLeadingWs(buffer: Buffer): number {
  let i = 0;
  while (i < buffer.length) {
    const c = buffer[i]!;
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) i += 1;
    else break;
  }
  return i;
}

function looksLikeHeader(buffer: Buffer): boolean {
  const preview = buffer.subarray(0, Math.min(buffer.length, 32)).toString("utf8");
  return /^content-length\s*:/i.test(preview);
}

function indexOfHeaderEnd(buffer: Buffer): number {
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (
      buffer[i] === 13 && buffer[i + 1] === 10
      && buffer[i + 2] === 13 && buffer[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

/** 供不走 Content-Length、按行调试时使用（生产路径不用）。 */
export function startMcpStdioLineMode(handler: McpHandler): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    void handleMcpMessage(line, handler).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}
