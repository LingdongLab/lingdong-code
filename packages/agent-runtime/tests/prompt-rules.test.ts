import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AcpClient, type AcpTransport } from "../src/acp-client.js";
import { SafeLogger } from "../src/logger.js";
import {
  DEFAULT_PROMPT_RULES,
  PROMPT_RULES_MAX_LENGTH,
  composePromptRules,
} from "../src/prompt-rules.js";
import type { JsonRpcMessage, JsonRpcRequest } from "../src/protocol.js";

const CWD = "E:\\LingdongCode\\workspace\\grok-test";

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

  /** 取出 session/new 的 _meta，规则注入的唯一落点。 */
  sessionNewMeta(): Record<string, unknown> {
    const request = this.sent
      .filter((message): message is JsonRpcRequest => "method" in message)
      .find((message) => message.method === "session/new");
    assert.ok(request, "应当发出 session/new");
    const params = request.params as { _meta?: Record<string, unknown> };
    return params._meta ?? {};
  }
}

test("默认规则逐条成行，实测短板一条不落", () => {
  const composed = composePromptRules();
  for (const rule of DEFAULT_PROMPT_RULES) {
    assert.ok(composed.includes(rule.text), `缺少规则 ${rule.id}`);
  }
  assert.equal(composed.split("\n").length, DEFAULT_PROMPT_RULES.length);
  // 最要紧的一条：禁止整文件重写。它没了就等于这次改造没做。
  assert.match(composed, /严禁把整个文件/);
});

test("身份规则把自我介绍钉在灵动 Code，但不要求它否认底层模型", () => {
  const composed = composePromptRules();
  assert.match(composed, /灵动 Code/);
  // 不加这条时模型会自称「我是 Grok，运行在 Grok Build 里」。
  assert.match(composed, /不得自称 Grok/);
  // 撒谎会在用户查看诊断信息时当场崩塌，所以只管名字，不管否认。
  assert.match(composed, /照实回答/);
});

test("身份规则排在第一条：整段被追加到系统提示末尾，越靠前越压得住 Grok 原文的自我声明", () => {
  assert.equal(DEFAULT_PROMPT_RULES[0]?.id, "identity");
  assert.match(composePromptRules().split("\n")[0] ?? "", /灵动 Code/);
});

test("项目自定义规则追加在默认规则之后", () => {
  const composed = composePromptRules(undefined, "  提交前必须跑 npm run lint  ");
  const lines = composed.split("\n");
  assert.equal(lines.at(-1), "提交前必须跑 npm run lint");
});

test("空规则集拼出空串，调用方据此省略 _meta.rules", () => {
  assert.equal(composePromptRules([]), "");
  assert.equal(composePromptRules([{ id: "blank", text: "   " }]), "");
});

test("超长规则截断而不是抛错：规则是增益项，不该让建会话失败", () => {
  const composed = composePromptRules([{ id: "long", text: "规".repeat(PROMPT_RULES_MAX_LENGTH * 2) }]);
  assert.ok(composed.length <= PROMPT_RULES_MAX_LENGTH);
  assert.ok(composed.endsWith("…"));
});

test("session/new 带上 _meta.rules，Grok 才会包进 <human_rules>", async () => {
  const transport = new FakeTransport();
  const client = new AcpClient(transport, new SafeLogger("logs/test"), CWD, {
    promptRules: composePromptRules(),
  });
  await client.start();
  await client.newSession(CWD, "ask");

  const meta = transport.sessionNewMeta();
  assert.equal(typeof meta.rules, "string");
  assert.match(String(meta.rules), /严禁把整个文件/);
  assert.equal(client.injectedRules, composePromptRules());
  await client.shutdown();
});

test("没有规则时不发 rules 字段，避免给 Grok 一个空的 <human_rules>", async () => {
  const transport = new FakeTransport();
  const client = new AcpClient(transport, new SafeLogger("logs/test"), CWD, { promptRules: "   " });
  await client.start();
  await client.newSession(CWD, "ask");

  assert.equal("rules" in transport.sessionNewMeta(), false);
  assert.equal(client.injectedRules, "");
  await client.shutdown();
});

test("setPromptRules 只影响之后新建的会话（系统提示随建会话定稿）", async () => {
  const transport = new FakeTransport();
  const client = new AcpClient(transport, new SafeLogger("logs/test"), CWD, { promptRules: "旧规则" });
  await client.start();
  await client.newSession(CWD, "ask");
  assert.equal(transport.sessionNewMeta().rules, "旧规则");

  client.setPromptRules("新规则");
  transport.sent.length = 0;
  await client.newSession(CWD, "ask");
  assert.equal(transport.sessionNewMeta().rules, "新规则");
  await client.shutdown();
});
