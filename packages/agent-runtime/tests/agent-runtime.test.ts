import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentRuntime, type AgentRuntime } from "../src/agent-runtime.js";
import type { AgentEvent } from "../src/event-normalizer.js";

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));

async function makeRuntime(): Promise<AgentRuntime> {
  const workspace = await mkdtemp(path.join(tmpdir(), "lingdong-ws-"));
  const logDirectory = path.join(workspace, "logs");
  return createAgentRuntime({
    executable: process.execPath,
    args: [fakeGrok],
    workspace,
    logDirectory,
  });
}

test("sendMessage 以异步迭代方式产出流式文本并以 completed 结束", async () => {
  const runtime = await makeRuntime();
  const info = await runtime.initialize();
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.grok.exists, true);

  await runtime.createSession({ mode: "ask" });
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "请用中文分析当前项目。" })) {
    events.push(event);
  }

  const text = events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
  assert.equal(text, "你好，这是流式回复。");
  const completed = events.at(-1);
  assert.equal(completed?.type, "completed");
  assert.equal(completed?.type === "completed" ? completed.stopReason : "", "end_turn");
  await runtime.dispose();
});

test("cancel 让当前轮次以 cancelled 结束", async () => {
  const runtime = await makeRuntime();
  await runtime.initialize();
  await runtime.createSession({ mode: "ask" });

  const events: AgentEvent[] = [];
  const stream = runtime.sendMessage({ text: "写一篇很长的中文分析。" });
  const consume = (async () => {
    for await (const event of stream) events.push(event);
  })();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await runtime.cancel();
  await consume;

  const completed = events.at(-1);
  assert.equal(completed?.type === "completed" ? completed.stopReason : "", "cancelled");
  await runtime.dispose();
});

test("dispose 后 Grok 子进程被释放且可重复调用", async () => {
  const runtime = await makeRuntime();
  await runtime.initialize();
  await runtime.createSession({ mode: "ask" });
  assert.equal(runtime.processRunning, true);

  const exit = await runtime.dispose();
  assert.equal(exit?.expected, true);
  assert.equal(runtime.processRunning, false);
  assert.equal(await runtime.dispose(), undefined);
});
