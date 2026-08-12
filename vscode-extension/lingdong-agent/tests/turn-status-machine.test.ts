import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPreparingFailure,
  TurnStatusMachine,
  TURN_STATUS_LABEL,
  WAITING_LABEL,
  type TurnMainStatus,
} from "../src/services/turn-status-machine";

function machine(options: {
  now?: () => number;
  isDev?: boolean;
  illegal?: Array<[TurnMainStatus, TurnMainStatus]>;
} = {}) {
  const illegal: Array<[TurnMainStatus, TurnMainStatus]> = options.illegal ?? [];
  let clock = 0;
  const m = new TurnStatusMachine({
    now: options.now ?? (() => clock),
    isDev: options.isDev ?? false,
    onIllegal: (from, to) => illegal.push([from, to]),
  });
  return {
    m,
    illegal,
    advance(ms: number) { clock += ms; },
    set(ms: number) { clock = ms; },
  };
}

test("主路径 preparing → thinking → working → completed", () => {
  const { m } = machine();
  m.beginTurn();
  assert.equal(m.current, "preparing");
  assert.ok(m.transition("thinking"));
  assert.ok(m.transition("working"));
  assert.ok(m.transition("completed"));
  assert.equal(m.current, "completed");
  assert.ok(m.isTerminal);
  assert.ok(m.discardStream);
});

test("waiting_for_user 进入与恢复到 working", () => {
  const { m } = machine();
  m.beginTurn();
  m.transition("thinking");
  m.transition("working");
  m.transition("waiting_for_user");
  assert.equal(m.snapshot().label, TURN_STATUS_LABEL.waiting_for_user);
  assert.equal(m.snapshot().showElapsed, false);
  assert.ok(m.transition("working"));
  assert.equal(m.current, "working");
});

// 关键差别：等人回话该停表，等子 Agent 不该——那会儿活正在被干，
// 停表会让状态栏的秒数凭空冻住，看着像卡死。
test("等待子 Agent 期间计时继续走，和等用户不是一回事", () => {
  const { m, advance } = machine();
  m.beginTurn();
  m.transition("working");
  advance(3_000);
  assert.ok(m.transition("waiting_for_subagent", "等待子 Agent：梳理构建脚本…"));
  advance(7_000);

  const snap = m.snapshot();
  assert.equal(snap.label, "等待子 Agent：梳理构建脚本…");
  assert.equal(snap.showElapsed, true);
  assert.equal(snap.activeElapsedMs, 10_000, "子 Agent 干活的时间必须计入");
  assert.equal(snap.canStop, true);
});

test("子 Agent 交回结果后能回到 working，也能直接收尾", () => {
  const { m } = machine();
  m.beginTurn();
  m.transition("working");
  m.transition("waiting_for_subagent");
  assert.ok(m.transition("working"));

  const second = machine();
  second.m.beginTurn();
  second.m.transition("working");
  second.m.transition("waiting_for_subagent");
  assert.ok(second.m.transition("completed"));
});

test("等待子 Agent 时可停", () => {
  const { m } = machine();
  m.beginTurn();
  m.transition("working");
  m.transition("waiting_for_subagent");
  assert.ok(m.transition("stopping"));
  assert.ok(m.transition("stopped"));
});

test("stopping → stopped；stopped 后丢弃流", () => {
  const { m } = machine();
  m.beginTurn();
  m.transition("thinking");
  assert.ok(m.transition("stopping"));
  assert.ok(m.transition("stopped"));
  assert.ok(m.discardStream);
  assert.equal(m.snapshot().canStop, false);
});

test("waiting_for_user 时可停：走 stopping → stopped", () => {
  const { m } = machine();
  m.beginTurn();
  m.transition("thinking");
  m.transition("waiting_for_user");
  assert.equal(m.snapshot().canStop, true);
  assert.ok(m.transition("stopping"));
  assert.ok(m.transition("stopped"));
});

test("非法转换被拦截且不改状态", () => {
  const { m, illegal } = machine({ isDev: false });
  m.beginTurn();
  assert.equal(m.transition("completed"), false);
  assert.equal(m.current, "preparing");
  assert.deepEqual(illegal, [["preparing", "completed"]]);
});

test("开发态非法转换抛错", () => {
  const m = new TurnStatusMachine({ isDev: true, now: () => 0 });
  m.beginTurn();
  assert.throws(() => m.transition("completed"), /非法转换/);
});

test("终态不再转出", () => {
  const { m, illegal } = machine();
  m.beginTurn();
  m.transition("thinking");
  m.transition("completed");
  assert.equal(m.transition("thinking"), false);
  assert.equal(m.current, "completed");
  assert.deepEqual(illegal, [["completed", "thinking"]]);
});

test("waiting 期间不计显示耗时，恢复后接着累加", () => {
  const { m, advance } = machine();
  m.beginTurn();
  m.transition("thinking");
  advance(10_000);
  assert.equal(m.snapshot().activeElapsedMs, 10_000);

  m.transition("waiting_for_user");
  advance(30_000);
  assert.equal(m.snapshot().activeElapsedMs, 10_000, "waiting 不计时");

  m.transition("working");
  advance(5_000);
  assert.equal(m.snapshot().activeElapsedMs, 15_000);
});

test("preparing 失败分流：连接类 interrupted，请求类 failed", () => {
  assert.equal(classifyPreparingFailure("Grok 握手失败"), "interrupted");
  assert.equal(classifyPreparingFailure("ECONNREFUSED"), "interrupted");
  assert.equal(classifyPreparingFailure("Invalid API key"), "failed");
  assert.equal(classifyPreparingFailure("HTTP 401 Unauthorized"), "failed");
  assert.equal(classifyPreparingFailure("model not found"), "failed");
});

test("beginTurn 可从上轮终态重新开一轮", () => {
  const { m } = machine();
  m.beginTurn();
  m.transition("thinking");
  m.transition("completed");
  m.beginTurn();
  assert.equal(m.current, "preparing");
  assert.equal(m.snapshot().activeElapsedMs, 0);
  assert.equal(m.discardStream, false);
});

test("working 文案可被 Timeline group 覆盖", () => {
  const { m } = machine();
  m.beginTurn();
  m.transition("thinking");
  m.transition("working");
  assert.equal(m.setWorkingLabel("正在探索代码库…"), true);
  assert.equal(m.snapshot().label, "正在探索代码库…");
  assert.equal(m.setWorkingLabel("正在探索代码库…"), false, "同文案不重复变更，避免参数流刷屏");
  assert.equal(m.setWorkingLabel("正在修改 models.html…"), true);
});

test("interrupted 快照带连接动作标记", () => {
  const { m } = machine();
  m.beginTurn();
  m.transition("interrupted");
  assert.equal(m.snapshot().connectionActions, true);
  assert.match(m.snapshot().label, /连接已中断/);
});

test("进行中的状态以单个省略号收尾，终态不带", () => {
  const running: TurnMainStatus[] = ["preparing", "thinking", "working", "waiting_for_subagent", "stopping"];
  for (const status of running) {
    const label = TURN_STATUS_LABEL[status];
    assert.match(label, /…$/, status);
    assert.doesNotMatch(label, /……/, status);
  }
  for (const status of ["completed", "failed", "stopped", "interrupted"] as TurnMainStatus[]) {
    assert.doesNotMatch(TURN_STATUS_LABEL[status], /…/, status);
  }
});

test("终态文案是完整短语，不是光秃秃的名词", () => {
  assert.equal(TURN_STATUS_LABEL.failed, "执行失败");
  assert.equal(TURN_STATUS_LABEL.completed, "已完成");
  assert.equal(TURN_STATUS_LABEL.stopped, "已停止");
});

test("三种等待用各自的文案，说清要用户做什么", () => {
  const labels = [WAITING_LABEL.permission, WAITING_LABEL.plan, WAITING_LABEL.question];
  assert.equal(new Set(labels).size, 3, "三种等待不能共用一句话");
  for (const label of labels) {
    const { m } = machine();
    m.beginTurn();
    m.transition("thinking");
    assert.ok(m.transition("waiting_for_user", label));
    assert.equal(m.snapshot().label, label);
    assert.equal(m.snapshot().showElapsed, false, "等人回话时不该继续涨秒数");
    assert.equal(m.snapshot().canStop, true);
  }
});
