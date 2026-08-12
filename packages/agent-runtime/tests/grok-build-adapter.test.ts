import assert from "node:assert/strict";
import test from "node:test";
import { GrokBuildAdapter, type CompactClient } from "../src/grok-build-adapter.js";

class MockCompactClient implements CompactClient {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly responses = new Map<string, unknown | Error>();

  when(method: string, result: unknown | Error): void {
    this.responses.set(method, result);
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push(params === undefined ? { method } : { method, params });
    const configured = this.responses.get(method);
    if (configured instanceof Error) throw configured;
    if (configured !== undefined) return configured as T;
    throw new Error(`ACP -32601: Method not found: ${method}`);
  }
}

test("discoverCapabilities 识别 agentCapabilities 中的 compact 声明", () => {
  const adapter = new GrokBuildAdapter({
    request: async <T = unknown>() => ({}) as T,
  });
  assert.equal(adapter.compactCapability, "unknown");
  adapter.discoverCapabilities({ compact_conversation: true });
  assert.equal(adapter.compactCapability, "available");
});

test("probeCompact 按顺序尝试方法名，首个成功记 available", async () => {
  const client = new MockCompactClient();
  client.when("compact_conversation", new Error("ACP -32601: Method not found"));
  client.when("_x.ai/compact_conversation", { ok: true });
  const adapter = new GrokBuildAdapter(client, { sessionId: () => "session-1" });

  const capability = await adapter.probeCompact();

  assert.equal(capability, "available");
  assert.equal(adapter.compactCapability, "available");
  assert.deepEqual(client.calls.map((call) => call.method), [
    "compact_conversation",
    "_x.ai/compact_conversation",
  ]);
  assert.deepEqual(client.calls[1]?.params, { sessionId: "session-1" });
});

test("probeCompact 全部 -32601 时记 unavailable", async () => {
  const client = new MockCompactClient();
  const adapter = new GrokBuildAdapter(client);

  const capability = await adapter.probeCompact();

  assert.equal(capability, "unavailable");
  assert.equal(adapter.compactCapability, "unavailable");
  assert.deepEqual(client.calls.map((call) => call.method), [
    "compact_conversation",
    "_x.ai/compact_conversation",
    "session/compact",
  ]);
});

test("compactConversation 在 unavailable 时抛错且不发起请求", async () => {
  const client = new MockCompactClient();
  const adapter = new GrokBuildAdapter(client);
  await adapter.probeCompact();

  await assert.rejects(
    () => adapter.compactConversation("手动压缩"),
    /不支持 compact_conversation/,
  );
  assert.equal(client.calls.length, 3);
});

test("compactConversation 成功时使用已探测到的方法", async () => {
  const client = new MockCompactClient();
  client.when("compact_conversation", new Error("ACP -32601: Method not found"));
  client.when("session/compact", { ok: true });
  const adapter = new GrokBuildAdapter(client, { sessionId: () => "session-2" });
  await adapter.probeCompact();

  await adapter.compactConversation("保留计划摘要");

  const last = client.calls.at(-1);
  assert.equal(last?.method, "session/compact");
  assert.deepEqual(last?.params, { sessionId: "session-2", context: "保留计划摘要" });
});
