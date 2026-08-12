import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentRuntime, type AgentRuntime } from "../src/agent-runtime.js";
import type { AgentEvent } from "../src/event-normalizer.js";

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));

async function startRuntime(): Promise<AgentRuntime> {
  const workspace = await mkdtemp(path.join(tmpdir(), "lingdong-plan-"));
  const runtime = createAgentRuntime({
    executable: process.execPath,
    args: [fakeGrok],
    workspace,
    logDirectory: path.join(workspace, "logs"),
  });
  await runtime.initialize();
  await runtime.createSession({ mode: "plan" });
  return runtime;
}

function textOf(events: AgentEvent[]): string {
  return events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
}

test("批准计划后回执 approved 并把本地策略切到 Agent", async () => {
  const runtime = await startRuntime();
  assert.equal(runtime.mode, "plan");
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "请给出计划" })) {
    events.push(event);
    if (event.type === "plan_review_requested") {
      assert.equal(event.plan.steps.length, 2);
      assert.equal(event.plan.empty, false);
      await runtime.approvePlan();
    }
  }
  assert.ok(textOf(events).includes("[plan:approved]"));
  assert.equal(runtime.mode, "agent");
  const closed = events.find((event) => event.type === "plan_review_closed");
  assert.equal(closed?.type === "plan_review_closed" ? closed.outcome : "", "approved");
  const clientMode = events.find((event) => event.type === "mode_changed" && event.source === "client");
  assert.ok(clientMode);
  await runtime.dispose();
});

test("放弃计划回执 abandoned 且不切换模式", async () => {
  const runtime = await startRuntime();
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "请给出计划" })) {
    events.push(event);
    if (event.type === "plan_review_requested") await runtime.rejectPlan();
  }
  assert.ok(textOf(events).includes("[plan:abandoned]"));
  assert.equal(runtime.mode, "plan");
  await runtime.dispose();
});

test("要求修改会把反馈作为 cancelled 回执发回", async () => {
  const runtime = await startRuntime();
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "请给出计划" })) {
    events.push(event);
    if (event.type === "plan_review_requested") await runtime.revisePlan("请补充回归测试步骤");
  }
  assert.ok(textOf(events).includes("[plan:cancelled]"));
  assert.equal(runtime.mode, "plan");
  await runtime.dispose();
});

test("空计划仍会送达，由上层判定不可批准", async () => {
  const runtime = await startRuntime();
  let empty: boolean | undefined;
  for await (const event of runtime.sendMessage({ text: "空计划场景" })) {
    if (event.type !== "plan_review_requested") continue;
    empty = event.plan.empty;
    assert.equal(event.plan.steps.length, 0);
    await runtime.rejectPlan();
  }
  assert.equal(empty, true);
  await runtime.dispose();
});

test("没有待审批计划时批准会失败", async () => {
  const runtime = await startRuntime();
  const error = await runtime.approvePlan().catch((reason: unknown) => reason);
  assert.ok(error instanceof Error);
  assert.match((error as Error).message, /没有待审批的计划/);
  assert.equal(runtime.mode, "plan");
  await runtime.dispose();
});
