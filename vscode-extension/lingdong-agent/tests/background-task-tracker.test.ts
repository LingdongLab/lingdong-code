import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, BackgroundTaskFrame } from "@lingdong/agent-runtime";
import { BackgroundTaskTracker } from "../src/services/background-task-tracker";

function frame(payload: BackgroundTaskFrame): AgentEvent {
  return { type: "background_task", frame: payload };
}

function launched(tracker: BackgroundTaskTracker, id = "call-1", command = "npm run dev"): void {
  tracker.handleEvent(frame({ phase: "started", toolCallId: id, command, kind: "command" }), 1_000);
}

test("派发即建卡，卡片主键是 toolCallId 而不是 task_id", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  const tasks = tracker.snapshot();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, "call-1");
  assert.equal(tasks[0]?.taskId, undefined, "id 要等命令返回才有");
  assert.equal(tasks[0]?.status, "running");
});

test("登记 task_id 后才能按 id 找回这张卡", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  // 还没登记时，带 task_id 的帧无处安放，只能忽略。
  assert.equal(tracker.handleEvent(frame({ phase: "output", taskId: "t1", text: "hi" })), false);

  assert.equal(
    tracker.handleEvent(frame({ phase: "registered", toolCallId: "call-1", taskId: "t1" })),
    true,
  );
  assert.equal(tracker.handleEvent(frame({ phase: "output", taskId: "t1", text: "hi\n" })), true);
  assert.equal(tracker.output("call-1"), "hi\n");
});

test("同一个 task_id 重复登记不算变化", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  tracker.handleEvent(frame({ phase: "registered", toolCallId: "call-1", taskId: "t1" }));
  assert.equal(
    tracker.handleEvent(frame({ phase: "registered", toolCallId: "call-1", taskId: "t1" })),
    false,
  );
});

// 派发那次调用自己的输出（启动回执、日志路径）也是这张卡的输出。
test("command_output 按 toolCallId 归到对应卡片", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  assert.equal(
    tracker.handleEvent({ type: "command_output", toolCallId: "call-1", text: "Background task t1 started\n" }),
    true,
  );
  assert.match(tracker.output("call-1") ?? "", /Background task t1 started/);
  // 不认识的 toolCallId 不该凭空造卡。
  assert.equal(
    tracker.handleEvent({ type: "command_output", toolCallId: "other", text: "noise" }),
    false,
  );
  assert.equal(tracker.snapshot().length, 1);
});

test("输出行数用于卡片上的「N 行输出」，末尾换行不多算一行", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  tracker.handleEvent({ type: "command_output", toolCallId: "call-1", text: "a\nb\nc\n" });
  assert.equal(tracker.snapshot()[0]?.outputLines, 3);
});

test("退出码回填并据此判定成功失败", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  tracker.handleEvent(frame({ phase: "registered", toolCallId: "call-1", taskId: "t1" }));
  tracker.handleEvent(frame({ phase: "exited", taskId: "t1", success: false, exitCode: 1 }), 9_000);

  const task = tracker.snapshot()[0];
  assert.equal(task?.status, "failed");
  assert.equal(task?.exitCode, 1);
  assert.equal(task?.endedAt, 9_000);
});

// 关键区别：起后台任务那次调用是立刻返回 task_id 的，它 completed 不代表任务结束。
// 所以除了 exited / killed，没有任何东西该把这张卡 settle 掉。
test("已经结束的任务不会被后到的 exited 帧改写", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  tracker.handleEvent(frame({ phase: "registered", toolCallId: "call-1", taskId: "t1" }));
  tracker.handleEvent(frame({ phase: "exited", taskId: "t1", success: true, exitCode: 0 }), 9_000);
  assert.equal(
    tracker.handleEvent(frame({ phase: "exited", taskId: "t1", success: false, exitCode: 1 }), 10_000),
    false,
  );
  assert.equal(tracker.snapshot()[0]?.exitCode, 0);
});

test("终止把卡片标成已终止", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  tracker.handleEvent(frame({ phase: "registered", toolCallId: "call-1", taskId: "t1" }));
  tracker.handleEvent(frame({ phase: "killed", taskId: "t1" }), 5_000);
  assert.equal(tracker.snapshot()[0]?.status, "killed");
});

test("用户点终止时可以先乐观标记，但只对运行中的卡生效", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  assert.equal(tracker.markKilled("call-1"), true);
  assert.equal(tracker.markKilled("call-1"), false);
  assert.equal(tracker.markKilled("不存在"), false);
});

test("运行中的排在前面，并能数出还有几个在跑", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker, "a", "先起的");
  launched(tracker, "b", "后起的");
  tracker.handleEvent(frame({ phase: "registered", toolCallId: "a", taskId: "ta" }));
  tracker.handleEvent(frame({ phase: "exited", taskId: "ta", success: true, exitCode: 0 }));

  assert.deepEqual(tracker.snapshot().map((task) => task.command), ["后起的", "先起的"]);
  assert.equal(tracker.runningCount, 1);
});

test("monitor 也是后台任务，只是 kind 不同", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.handleEvent(frame({
    phase: "started",
    toolCallId: "call-1",
    command: "tail -f app.log",
    kind: "monitor",
  }));
  assert.equal(tracker.snapshot()[0]?.kind, "monitor");
});

test("会话切换清空台账，连 task_id 索引一起清", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  tracker.handleEvent(frame({ phase: "registered", toolCallId: "call-1", taskId: "t1" }));
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), []);
  assert.equal(tracker.handleEvent(frame({ phase: "output", taskId: "t1", text: "x" })), false);
});

test("快照不外泄整段输出，免得每次推 UI 都搬几十万字符", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  tracker.handleEvent({ type: "command_output", toolCallId: "call-1", text: "x".repeat(1_000) });
  assert.equal("output" in (tracker.snapshot()[0] as object), false);
});

test("输出只留尾部：后台任务的报错与退出都在末尾", () => {
  const tracker = new BackgroundTaskTracker();
  launched(tracker);
  tracker.handleEvent({ type: "command_output", toolCallId: "call-1", text: "A".repeat(210_000) });
  tracker.handleEvent({ type: "command_output", toolCallId: "call-1", text: "TAIL" });
  const output = tracker.output("call-1") ?? "";
  assert.ok(output.length <= 200_000);
  assert.ok(output.endsWith("TAIL"));
});
