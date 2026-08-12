import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AcpClient, describeRpcError, type AcpTransport } from "../src/acp-client.js";
import { SafeLogger } from "../src/logger.js";
import type { JsonRpcMessage, JsonRpcRequest } from "../src/protocol.js";

class FakeTransport extends EventEmitter implements AcpTransport {
  readonly sent: JsonRpcMessage[] = [];
  async start(): Promise<void> {}
  async close() { return { code: 0, signal: null, expected: true } as const; }
  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if (!("id" in message) || !("method" in message)) return;
    const request = message as JsonRpcRequest;
    let result: unknown = {};
    if (request.method === "initialize") result = { protocolVersion: 1 };
    if (request.method === "session/new") result = { sessionId: "session-test" };
    if (request.method === "session/load") result = {};
    if (request.method === "session/set_model") result = {};
    if (request.method === "session/set_mode") result = {};
    queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: request.id, result }));
  }
}

test("JSON-RPC 错误保留 data：真正说得清原因的是它", () => {
  // Grok 解析上游响应失败时，message 只有一句 Internal error。
  assert.equal(
    describeRpcError({
      code: -32603,
      message: "Internal error",
      data: "serialization error: invalid type: null, expected u32 at line 1 column 334",
    }),
    "ACP -32603: Internal error — serialization error: "
      + "invalid type: null, expected u32 at line 1 column 334",
  );
});

test("没有 data 时不画蛇添足，结构化 data 序列化后带上", () => {
  assert.equal(
    describeRpcError({ code: -32601, message: "Method not found" }),
    "ACP -32601: Method not found",
  );
  assert.equal(
    describeRpcError({ code: -32602, message: "Invalid params", data: null }),
    "ACP -32602: Invalid params",
  );
  assert.equal(
    describeRpcError({ code: -32000, message: "Failed", data: { field: "modelId" } }),
    "ACP -32000: Failed — {\"field\":\"modelId\"}",
  );
});

test("超长的 data 截断，避免把整段响应糊到界面上", () => {
  const message = describeRpcError({ code: -32603, message: "Internal error", data: "x".repeat(900) });
  assert.ok(message.length < 500);
  assert.ok(message.endsWith("…"));
});

test("用户取消使用无 id 的 session/cancel 通知", async () => {
  const transport = new FakeTransport();
  const logger = new SafeLogger("logs/test");
  const client = new AcpClient(transport, logger, "E:\\LingdongCode\\workspace\\grok-test");
  await client.start();
  await client.newSession("E:\\LingdongCode\\workspace\\grok-test", "ask");
  await client.cancel();
  const cancel = transport.sent.at(-1);
  assert.ok(cancel);
  assert.ok("method" in cancel);
  assert.equal(cancel.method, "session/cancel");
  assert.equal("id" in cancel, false);
  await client.shutdown();
});

test("loadSession 恢复后在 set_model 之后同步当前安全模式", async () => {
  const transport = new FakeTransport();
  const logger = new SafeLogger("logs/test");
  const cwd = "E:\\LingdongCode\\workspace\\grok-test";
  const client = new AcpClient(transport, logger, cwd);
  await client.start();
  await client.newSession(cwd, "agent");
  transport.sent.length = 0;

  await client.loadSession("session-test", cwd);

  const methods = transport.sent
    .filter((message): message is JsonRpcRequest => "method" in message)
    .map((message) => message.method);
  assert.ok(methods.includes("session/load"));
  assert.ok(methods.includes("session/set_model"));
  assert.ok(methods.includes("session/set_mode"));
  assert.ok(methods.indexOf("session/set_mode") > methods.indexOf("session/set_model"));
  assert.equal(client.mode, "agent");
  await client.shutdown();
});

test("setModel 成功后更新本地 modelId；同模型为幂等", async () => {
  const transport = new FakeTransport();
  const logger = new SafeLogger("logs/test");
  const cwd = "E:\\LingdongCode\\workspace\\grok-test";
  const client = new AcpClient(transport, logger, cwd, { modelId: "deepseek-v4-flash" });
  await client.start();
  await client.newSession(cwd, "ask");
  const before = transport.sent.length;
  await client.setModel("deepseek-v4-flash");
  assert.equal(client.model, "deepseek-v4-flash");
  assert.equal(transport.sent.length, before);

  await client.setModel("deepseek-v4-flash-alt");
  assert.equal(client.model, "deepseek-v4-flash-alt");
  const last = transport.sent.at(-1) as JsonRpcRequest;
  assert.equal(last.method, "session/set_model");
  assert.equal((last.params as { modelId: string }).modelId, "deepseek-v4-flash-alt");
  await client.shutdown();
});

test("_x.ai/session/update 的 turn_completed 会 emit token_usage", async () => {
  const transport = new FakeTransport();
  const logger = new SafeLogger("logs/test");
  const cwd = "E:\\LingdongCode\\workspace\\grok-test";
  const client = new AcpClient(transport, logger, cwd);
  const usagePromise = new Promise<{ type: string; source?: string; totalTokens?: number }>((resolve) => {
    client.on("event", (event) => {
      if (event.type === "token_usage") resolve(event);
    });
  });

  await client.start();
  await client.newSession(cwd, "ask");

  transport.emit("message", {
    jsonrpc: "2.0",
    method: "_x.ai/session/update",
    params: {
      sessionId: "session-test",
      update: {
        sessionUpdate: "turn_completed",
        usage: { totalTokens: 23404, inputTokens: 22744, outputTokens: 660 },
      },
    },
  });

  const usage = await usagePromise;
  assert.equal(usage.source, "exact");
  assert.equal(usage.totalTokens, 23404);
  await client.shutdown();
});

test("子进程非预期退出先发 disconnected，再让在途请求失败", async () => {
  const transport = new FakeTransport();
  const logger = new SafeLogger("logs/test");
  const cwd = "E:\\LingdongCode\\workspace\\grok-test";
  const client = new AcpClient(transport, logger, cwd);
  const events: string[] = [];
  client.on("event", (event) => events.push(event.type));

  await client.start();
  await client.newSession(cwd, "ask");
  events.length = 0;

  transport.emit("exit", { code: 1, signal: null, expected: false });

  // disconnected 必须排在 error 前面，宿主才来得及在轮次失败前作废缓存。
  assert.equal(events[0], "disconnected");
  assert.ok(events.includes("error"));
});

test("预期内的关闭不会触发 disconnected", async () => {
  const transport = new FakeTransport();
  const logger = new SafeLogger("logs/test");
  const cwd = "E:\\LingdongCode\\workspace\\grok-test";
  const client = new AcpClient(transport, logger, cwd);
  const events: string[] = [];
  client.on("event", (event) => events.push(event.type));

  await client.start();
  await client.newSession(cwd, "ask");
  events.length = 0;

  transport.emit("exit", { code: 0, signal: null, expected: true });
  assert.equal(events.includes("disconnected"), false);
});

test("传输层错误也会广播 disconnected", async () => {
  const transport = new FakeTransport();
  const logger = new SafeLogger("logs/test");
  const cwd = "E:\\LingdongCode\\workspace\\grok-test";
  const client = new AcpClient(transport, logger, cwd);
  const reasons: string[] = [];
  client.on("event", (event) => {
    if (event.type === "disconnected") reasons.push(event.reason);
  });

  await client.start();
  transport.emit("error", new Error("EPIPE"));
  assert.deepEqual(reasons, ["EPIPE"]);
});
