import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@lingdong/agent-runtime";
import { SubagentTracker } from "../src/services/subagent-tracker";

function started(overrides: Partial<Extract<AgentEvent, { type: "subagent_started" }>> = {}): AgentEvent {
  return {
    type: "subagent_started",
    toolCallId: "call-1",
    description: "梳理构建脚本",
    background: false,
    ...overrides,
  };
}

test("派发即建卡，运行中排在已结束的前面", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "a", description: "先跑的" }), 1_000);
  tracker.handleEvent(started({ toolCallId: "b", description: "后跑的" }), 2_000);
  tracker.handleEvent({ type: "subagent_completed", toolCallId: "a", success: true }, 3_000);

  assert.deepEqual(
    tracker.snapshot().map((task) => [task.description, task.status]),
    [["后跑的", "running"], ["先跑的", "completed"]],
  );
});

test("参数流先建的卡在正式 tool_call 到达时被补全，不会变成两张", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ description: "排查失败用例" }), 1_000);
  const changed = tracker.handleEvent(
    started({ description: "排查失败用例", subagentType: "explore", background: true }),
    1_200,
  );

  assert.equal(changed, true, "补全了字段就该推 UI");
  const tasks = tracker.snapshot();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.subagentType, "explore");
  assert.equal(tasks[0]?.background, true);
  // 起始时间保持第一次的，否则卡片上的耗时会凭空缩短。
  assert.equal(tasks[0]?.startedAt, 1_000);
});

test("字段没变就不报告变化，免得上万条参数分片把 UI 刷爆", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started(), 1_000);
  assert.equal(tracker.handleEvent(started(), 1_100), false);
});

test("完成事件回填汇总与状态，失败标成 failed", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "a" }), 1_000);
  tracker.handleEvent(started({ toolCallId: "b" }), 1_000);
  tracker.handleEvent({ type: "subagent_completed", toolCallId: "a", success: true, summary: "查清了。" }, 5_000);
  tracker.handleEvent({ type: "subagent_completed", toolCallId: "b", success: false }, 6_000);

  const byId = new Map(tracker.snapshot().map((task) => [task.id, task]));
  assert.equal(byId.get("a")?.status, "completed");
  assert.equal(byId.get("a")?.summary, "查清了。");
  assert.equal(byId.get("a")?.endedAt, 5_000);
  assert.equal(byId.get("b")?.status, "failed");
});

/**
 * 后台派发的子 Agent 不会有 subagent_completed：派发那次调用立刻就返回了，
 * 结果得等模型去取。取回来的那一段以前直接丢掉，卡片上永远是空的——
 * 用户于是问「最后那个子 Agent 返回了啥」。
 */
test("取回的输出落到卡片汇总上，并把卡片从运行中收尾", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "bg", background: true }), 1_000);
  const changed = tracker.handleEvent(
    { type: "subagent_output", toolCallId: "bg", text: "调研完成：会员分三档。" },
    4_000,
  );

  assert.equal(changed, true);
  const task = tracker.snapshot()[0];
  assert.equal(task?.summary, "调研完成：会员分三档。");
  assert.equal(task?.status, "completed");
  assert.equal(task?.endedAt, 4_000);
});

test("分多次取回的输出按顺序拼接", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "bg", background: true }), 1_000);
  tracker.handleEvent({ type: "subagent_output", toolCallId: "bg", text: "第一段" }, 2_000);
  tracker.handleEvent({ type: "subagent_output", toolCallId: "bg", text: "第二段" }, 3_000);
  assert.equal(tracker.snapshot()[0]?.summary, "第一段\n第二段");
});

test("空输出与不认识的 toolCallId 都不算变化", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "bg", background: true }), 1_000);
  assert.equal(tracker.handleEvent({ type: "subagent_output", toolCallId: "bg", text: "   " }), false);
  assert.equal(tracker.handleEvent({ type: "subagent_output", toolCallId: "nope", text: "x" }), false);
});

test("不认识的 toolCallId 完成事件被忽略，不凭空造卡", () => {
  const tracker = new SubagentTracker();
  assert.equal(
    tracker.handleEvent({ type: "subagent_completed", toolCallId: "unknown", success: true }),
    false,
  );
  assert.equal(tracker.snapshot().length, 0);
});

test("只有阻塞式子 Agent 会挡住父 Agent，background 的不算", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "bg", background: true }), 1_000);
  assert.equal(tracker.blockingTask(), undefined);

  tracker.handleEvent(started({ toolCallId: "block", description: "等这个" }), 1_000);
  assert.equal(tracker.blockingTask()?.description, "等这个");
});

// 宿主的状态机先于台账更新：处理 subagent_completed 时台账里那条还是 running，
// 不排掉它就会永远判定「还要继续等」，状态栏卡在「等待子 Agent」下不来。
test("blockingTask 能排除指定 id，供状态机判断是否还要继续等", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "only" }), 1_000);
  assert.equal(tracker.blockingTask("only"), undefined);

  tracker.handleEvent(started({ toolCallId: "another", description: "还有一个" }), 1_000);
  assert.equal(tracker.blockingTask("only")?.description, "还有一个");
});

test("轮次正常收尾只结算阻塞的，background 的继续活着", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "block" }), 1_000);
  tracker.handleEvent(started({ toolCallId: "bg", background: true }), 1_000);

  assert.equal(tracker.settleRunning("completed", { at: 9_000 }), true);
  const byId = new Map(tracker.snapshot().map((task) => [task.id, task]));
  assert.equal(byId.get("block")?.status, "completed");
  assert.equal(byId.get("bg")?.status, "running", "后台子 Agent 跨轮存活，不该被父轮次带走");
});

test("被停掉或断线时连 background 的一起结算，卡片不能永远转圈", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "bg", background: true }), 1_000);
  tracker.settleRunning("failed", { includeBackground: true, at: 9_000 });
  assert.equal(tracker.snapshot()[0]?.status, "failed");
});

test("重复结算不再报告变化", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started(), 1_000);
  assert.equal(tracker.settleRunning("completed"), true);
  assert.equal(tracker.settleRunning("completed"), false);
});

test("会话切换清空台账", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started(), 1_000);
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), []);
});

test("卡片数量有上限，且优先淘汰已结束的", () => {
  const tracker = new SubagentTracker();
  tracker.handleEvent(started({ toolCallId: "long-running", description: "一直在跑" }), 1_000);
  for (let i = 0; i < 40; i += 1) {
    tracker.handleEvent(started({ toolCallId: `t${i}`, description: `任务 ${i}` }), 1_000);
    tracker.handleEvent({ type: "subagent_completed", toolCallId: `t${i}`, success: true }, 1_100);
  }
  const tasks = tracker.snapshot();
  assert.ok(tasks.length <= 30, `实际 ${tasks.length} 张卡`);
  assert.ok(
    tasks.some((task) => task.id === "long-running"),
    "还在跑的那个不该被淘汰",
  );
});
