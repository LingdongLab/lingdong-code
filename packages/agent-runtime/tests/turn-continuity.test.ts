import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentRuntime, type AgentRuntime } from "../src/agent-runtime.js";
import type { WatchdogConfig } from "../src/acp-client.js";
import type { AgentEvent } from "../src/event-normalizer.js";

/**
 * 对话连续性一期（阶段 A/B）回归：
 * - 入站消息串行化：同帧到达的正文尾巴与 prompt 响应不得乱序，答案不能截断；
 * - 静默看门狗：挂死轮次被明确结束，持续输出的长任务不被误杀，人工门禁不计入静默；
 * - cancel 兜底：Grok 吞掉取消后合成取消完成，事件流不再永久挂起。
 */

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));

/** 断言失败也要释放子进程，否则泄漏的 stdin 会挂住整个测试运行。 */
async function withRuntime(
  watchdog: WatchdogConfig | undefined,
  run: (runtime: AgentRuntime) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), "lingdong-turn-"));
  const runtime = createAgentRuntime({
    executable: process.execPath,
    args: [fakeGrok],
    workspace,
    logDirectory: path.join(workspace, "logs"),
    ...(watchdog ? { watchdog } : {}),
  });
  await runtime.initialize();
  await runtime.createSession({ mode: "agent" });
  try {
    await run(runtime);
  } finally {
    await runtime.dispose();
  }
}

function textOf(events: AgentEvent[]): string {
  return events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("同帧收尾：正文尾巴先于 completed 产出，答案不截断", async () => {
  await withRuntime(undefined, async (runtime) => {
    const outside: AgentEvent[] = [];
    runtime.on("event", (event) => outside.push(event));

    const events: AgentEvent[] = [];
    for await (const event of runtime.sendMessage({ text: "同帧收尾" })) events.push(event);

    assert.equal(textOf(events), "第一段。结尾一句。");
    const lastDelta = events.map((event) => event.type).lastIndexOf("text_delta");
    const completedAt = events.findIndex((event) => event.type === "completed");
    assert.ok(completedAt > lastDelta, "completed 必须晚于最后一段正文");
    // 轮次外不得漏出任何正文（截断的典型症状：尾巴落到 sendMessage 迭代器之外）。
    assert.equal(outside.some((event) => event.type === "text_delta"), false);
  });
});

test("静默挂死：看门狗结束轮次并给出可行动的错误", async () => {
  await withRuntime({ promptIdleMs: 150, cancelGraceMs: 100 }, async (runtime) => {
    await assert.rejects(
      (async () => {
        for await (const event of runtime.sendMessage({ text: "静默挂死" })) void event;
      })(),
      /无响应/,
    );
  });
});

test("缓慢输出的长任务不被静默看门狗误杀", async () => {
  await withRuntime({ promptIdleMs: 300 }, async (runtime) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.sendMessage({ text: "缓慢输出" })) events.push(event);
    assert.ok(textOf(events).includes("第8段。"));
    const completed = events.find((event) => event.type === "completed");
    assert.equal(completed?.type === "completed" ? completed.stopReason : "", "end_turn");
  });
});

test("权限卡等待用户不算模型静默，看门狗顺延", async () => {
  await withRuntime({ promptIdleMs: 200 }, async (runtime) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.sendMessage({ text: "需要权限修改配置" })) {
      events.push(event);
      if (event.type === "permission_requested") {
        // 故意超过静默阈值再应答：门禁打开期间不得触发超时。
        await sleep(600);
        await runtime.respondPermission(event.requestId, "allow_once");
      }
    }
    assert.ok(textOf(events).includes("[permission:allow-once]"));
    const completed = events.find((event) => event.type === "completed");
    assert.equal(completed?.type === "completed" ? completed.stopReason : "", "end_turn");
  });
});

test("取消后 Grok 不回包：静默兜底合成取消完成，事件流不悬死", async () => {
  await withRuntime({ promptIdleMs: 0, cancelGraceMs: 150 }, async (runtime) => {
    const events: AgentEvent[] = [];
    const consuming = (async () => {
      for await (const event of runtime.sendMessage({ text: "取消不回包" })) events.push(event);
    })();
    await sleep(100);
    await runtime.cancel();
    await consuming;
    const completed = events.find((event) => event.type === "completed");
    assert.equal(completed?.type === "completed" ? completed.stopReason : "", "cancelled");
  });
});
