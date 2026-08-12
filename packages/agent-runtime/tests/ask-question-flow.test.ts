import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AcpClient, type AcpTransport } from "../src/acp-client.js";
import { parseAskUserRequest } from "../src/ask-question.js";
import type { AgentEvent } from "../src/event-normalizer.js";
import { SafeLogger } from "../src/logger.js";
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "../src/protocol.js";

/**
 * ask_user_question 全链路（运行时侧）：
 * 反向请求登记 → question_requested 事件 → respondQuestion 回执 → Grok 收到 answers。
 * 报文形状以 0.2.118 实测为准，见 src/ask-question.ts 顶部说明。
 */

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
    queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: request.id, result }));
  }
}

/** handleMessage 里有真实的日志落盘，固定延迟不可靠，轮询等待条件成立。 */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  transport: FakeTransport;
  client: AcpClient;
  events: AgentEvent[];
}

async function createClient(): Promise<Harness> {
  const transport = new FakeTransport();
  const client = new AcpClient(transport, new SafeLogger("logs/test"), "E:\\LingdongCode\\workspace\\grok-test");
  const events: AgentEvent[] = [];
  client.on("event", (event) => events.push(event));
  await client.start();
  await client.newSession("E:\\LingdongCode\\workspace\\grok-test", "agent");
  return { transport, client, events };
}

/** 实测 0.2.118 发来的请求形状。 */
const ASK_PARAMS = {
  sessionId: "session-test",
  toolCallId: "call_00_abc",
  questions: [
    {
      question: "测试用哪种语言？",
      options: [
        { label: "TypeScript", preview: "与项目现有测试一致" },
        { label: "Python" },
      ],
      multiSelect: null,
    },
    {
      question: "要覆盖哪些场景？",
      options: [{ label: "单元测试" }, { label: "集成测试" }],
      multiSelect: true,
    },
  ],
  mode: "plan",
};

function responsesOf(transport: FakeTransport): JsonRpcResponse[] {
  return transport.sent.filter(
    (message): message is JsonRpcResponse => "id" in message && !("method" in message),
  );
}

test("parseAskUserRequest：对象/字符串选项都收，坏条目丢弃，multiSelect null 归一为 false", () => {
  const request = parseAskUserRequest({
    questions: [
      { question: "选一个", options: ["A", { label: "B", preview: "说明" }, { junk: 1 }, ""], multiSelect: null },
      { question: "", options: ["X"] },
      "not-an-object",
    ],
  });
  assert.ok(request);
  assert.equal(request.questions.length, 1);
  const [question] = request.questions;
  assert.equal(question?.multiSelect, false);
  assert.deepEqual(question?.options, [{ label: "A" }, { label: "B", preview: "说明" }]);

  assert.equal(parseAskUserRequest({ questions: [] }), undefined);
  assert.equal(parseAskUserRequest("junk"), undefined);
});

test("收到 _x.ai/ask_user_question 后登记待回执并发出 question_requested", async () => {
  const { transport, client, events } = await createClient();
  transport.emit("message", { jsonrpc: "2.0", id: 77, method: "_x.ai/ask_user_question", params: ASK_PARAMS });
  // pendingQuestionId 在事件发出之前就已登记（中间隔着一次日志落盘），等事件本身才不会竞态。
  await waitFor(() => events.some((event) => event.type === "question_requested"));

  assert.equal(client.pendingQuestionId, "77");
  const requested = events.find((event) => event.type === "question_requested");
  assert.ok(requested && requested.type === "question_requested");
  assert.equal(requested.requestId, "77");
  assert.equal(requested.request.questions.length, 2);
  assert.equal(requested.request.questions[0]?.multiSelect, false);
  assert.equal(requested.request.questions[1]?.multiSelect, true);
  assert.equal(requested.request.mode, "plan");
  // 未回答之前不给 Grok 发任何应答。
  assert.equal(responsesOf(transport).some((message) => message.id === 77), false);
  await client.shutdown();
});

test("respondQuestion 回执 answers 数组，与问题一一对应", async () => {
  const { transport, client, events } = await createClient();
  transport.emit("message", { jsonrpc: "2.0", id: 78, method: "_x.ai/ask_user_question", params: ASK_PARAMS });
  await waitFor(() => client.pendingQuestionId === "78");

  await client.respondQuestion("78", ["TypeScript", "单元测试、集成测试"]);

  const response = responsesOf(transport).find((message) => message.id === 78);
  assert.ok(response);
  // 应答形状（0.2.118 真实会话逐步验证）：内部标签枚举，answers 是「问题原文 → 答案」映射。
  assert.deepEqual(response.result, {
    outcome: "accepted",
    answers: { "测试用哪种语言？": "TypeScript", "要覆盖哪些场景？": "单元测试、集成测试" },
  });
  assert.equal(client.pendingQuestionId, undefined);
  const resolved = events.find((event) => event.type === "question_resolved");
  assert.ok(resolved && resolved.type === "question_resolved");
  assert.equal(resolved.outcome, "answered");
  await client.shutdown();
});

test("取消清场时用 skip_interview 温和跳过，不把工具打成失败", async () => {
  const { transport, client, events } = await createClient();
  transport.emit("message", { jsonrpc: "2.0", id: 79, method: "_x.ai/ask_user_question", params: ASK_PARAMS });
  await waitFor(() => client.pendingQuestionId === "79");

  await client.clearPendingAsync("用户取消任务");

  const response = responsesOf(transport).find((message) => message.id === 79);
  assert.ok(response);
  assert.deepEqual(response.result, { outcome: "skip_interview" });
  assert.equal(client.pendingQuestionId, undefined);
  const resolved = events.find((event) => event.type === "question_resolved");
  assert.ok(resolved && resolved.type === "question_resolved");
  assert.equal(resolved.outcome, "cancelled");
  await client.shutdown();
});

test("没有有效问题的请求直接跳过，不弹空卡也不悬死", async () => {
  const { transport, client, events } = await createClient();
  transport.emit("message", { jsonrpc: "2.0", id: 80, method: "_x.ai/ask_user_question", params: { questions: [] } });
  await waitFor(() => responsesOf(transport).some((message) => message.id === 80));

  const response = responsesOf(transport).find((message) => message.id === 80);
  assert.ok(response);
  assert.deepEqual(response.result, { outcome: "skip_interview" });
  assert.equal(client.pendingQuestionId, undefined);
  assert.equal(events.some((event) => event.type === "question_requested"), false);
  await client.shutdown();
});

test("重复回答或回答已失效的提问会抛错", async () => {
  const { transport, client } = await createClient();
  transport.emit("message", { jsonrpc: "2.0", id: 81, method: "_x.ai/ask_user_question", params: ASK_PARAMS });
  await waitFor(() => client.pendingQuestionId === "81");

  await client.respondQuestion("81", ["TypeScript", "单元测试"]);
  await assert.rejects(() => client.respondQuestion("81", ["again"]), /提问已失效/);
  await assert.rejects(() => client.respondQuestion("no-such", ["x"]), /提问已失效/);
  await client.shutdown();
});
