import assert from "node:assert/strict";
import test from "node:test";
import { UiStateMachine } from "../src/ui-state";

test("正常一轮任务的状态迁移", () => {
  const ui = new UiStateMachine();
  assert.equal(ui.state, "idle");
  assert.equal(ui.transition("initializing"), true);
  assert.equal(ui.transition("ready"), true);
  assert.equal(ui.transition("sending"), true);
  assert.equal(ui.transition("streaming"), true);
  assert.equal(ui.transition("completed"), true);
  assert.equal(ui.transition("ready"), true);
});

test("非法迁移被忽略且不会改变状态", () => {
  const ui = new UiStateMachine();
  assert.equal(ui.transition("streaming"), false);
  assert.equal(ui.state, "idle");
  ui.force("disposed");
  assert.equal(ui.transition("ready"), false);
  assert.equal(ui.state, "disposed");
});

test("执行中不能发送也不能切换模式，但可以取消", () => {
  const ui = new UiStateMachine();
  ui.force("streaming");
  assert.equal(ui.canSend, false);
  assert.equal(ui.canSwitchMode, false);
  assert.equal(ui.canCancel, true);
  assert.equal(ui.busy, true);
});

test("等待权限时只允许权限回执，等待计划时只允许计划审批", () => {
  const ui = new UiStateMachine();
  ui.force("waiting_permission");
  assert.equal(ui.canRespondPermission, true);
  assert.equal(ui.canApprovePlan, false);

  ui.force("waiting_plan_approval");
  assert.equal(ui.canApprovePlan, true);
  assert.equal(ui.canRespondPermission, false);
});

test("取消中不能重复取消，错误态可以重新发送", () => {
  const ui = new UiStateMachine();
  ui.force("cancelling");
  assert.equal(ui.canCancel, false);
  ui.force("error");
  assert.equal(ui.canSend, true);
  assert.equal(ui.canSwitchMode, true);
});

test("快照包含所有守卫结果", () => {
  const ui = new UiStateMachine();
  ui.force("ready");
  assert.deepEqual(ui.snapshot(), {
    state: "ready",
    busy: false,
    canSend: true,
    canCancel: false,
    canSwitchMode: true,
    canApprovePlan: false,
    canRespondPermission: false,
    canReviewChanges: true,
    canApplyChanges: true,
    canRestoreChanges: true,
  });
});

test("任务执行中不能接受或拒绝变更，但可以查看已产生的变更", () => {
  const ui = new UiStateMachine();
  ui.force("streaming");
  assert.equal(ui.canApplyChanges, false);
  assert.equal(ui.canReviewChanges, true);

  ui.force("waiting_permission");
  assert.equal(ui.canApplyChanges, false);
  assert.equal(ui.canReviewChanges, true);
  assert.equal(ui.canRestoreChanges, true);
});

test("恢复过程中禁止重复恢复，也不能发送新任务", () => {
  const ui = new UiStateMachine();
  ui.force("restoring_changes");
  assert.equal(ui.canRestoreChanges, false);
  assert.equal(ui.canApplyChanges, false);
  assert.equal(ui.canSend, false);
  assert.equal(ui.busy, true);
  assert.equal(ui.transition("reviewing_changes"), true);
});

test("轮次结束后可以进入变更审阅与冲突状态，并且仍能发送下一轮", () => {
  const ui = new UiStateMachine();
  ui.force("completed");
  assert.equal(ui.transition("reviewing_changes"), true);
  assert.equal(ui.canSend, true);
  assert.equal(ui.canApplyChanges, true);
  assert.equal(ui.canSwitchMode, true);

  assert.equal(ui.transition("conflict"), true);
  assert.equal(ui.canApplyChanges, true);
  assert.equal(ui.canSend, true);
  assert.equal(ui.transition("sending"), true);
});

test("已销毁后不允许任何变更操作", () => {
  const ui = new UiStateMachine();
  ui.force("disposed");
  assert.equal(ui.canReviewChanges, false);
  assert.equal(ui.canApplyChanges, false);
  assert.equal(ui.canRestoreChanges, false);
});
