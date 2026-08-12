export type JsonRpcId = number | string;

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: T;
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: Record<string, unknown>;
  authMethods?: unknown[];
}

export interface SessionNewResult {
  sessionId: string;
  models?: unknown;
  modes?: unknown;
  _meta?: Record<string, unknown>;
}

export interface SessionUpdateParams {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate?: string };
  _meta?: Record<string, unknown>;
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface PermissionRequestParams {
  sessionId: string;
  toolCall: Record<string, unknown> & {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: unknown[];
    _meta?: Record<string, unknown>;
  };
  options: PermissionOption[];
}

export interface ExitPlanModeParams {
  sessionId: string;
  toolCallId?: string;
  planContent: string;
}

export interface DecodeResult {
  messages: JsonRpcMessage[];
  errors: Error[];
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if (hasOwn(value, "method")) return typeof value.method === "string";
  return hasOwn(value, "id") && (hasOwn(value, "result") || hasOwn(value, "error"));
}

export class JsonLineDecoder {
  private buffer = "";

  push(chunk: string): DecodeResult {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isJsonRpcMessage(parsed)) {
          throw new Error("不是有效的 JSON-RPC 2.0 消息");
        }
        messages.push(parsed);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return { messages, errors };
  }

  finish(): DecodeResult {
    if (this.buffer.trim() === "") {
      this.buffer = "";
      return { messages: [], errors: [] };
    }
    const tail = `${this.buffer}\n`;
    this.buffer = "";
    return this.push(tail);
  }
}

export function buildCancelNotification(sessionId: string): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  };
}
