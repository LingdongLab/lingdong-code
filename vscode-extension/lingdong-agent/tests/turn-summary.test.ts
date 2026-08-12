import assert from "node:assert/strict";
import test from "node:test";
import { describeStopReason, turnOutcomeNotice } from "../src/turn-summary";

test("停止原因翻译成中文，不再出现裸的英文标识", () => {
  assert.equal(describeStopReason("end_turn"), "已完成");
  assert.equal(describeStopReason("cancelled"), "已停止");
  assert.equal(describeStopReason("max_tokens"), "已达到长度上限");
  assert.equal(describeStopReason("something_new"), "已结束（something_new）");
});

test("文件已改完但验证命令被拒绝时给出明确说明", () => {
  const notice = turnOutcomeNotice({ stopReason: "cancelled", changedFiles: 2, rejectedExecute: true });
  assert.equal(notice?.level, "warn");
  assert.equal(notice?.message, "代码修改已完成，但验证命令被拒绝，尚未完成最终验证。");
});

test("中途停止但已有修改时提示可查看或撤销", () => {
  const notice = turnOutcomeNotice({ stopReason: "cancelled", changedFiles: 3, rejectedExecute: false });
  assert.equal(notice?.level, "info");
  assert.match(notice?.message ?? "", /3 个文件修改/);
});

test("没有产生修改或正常结束时不额外提示", () => {
  assert.equal(turnOutcomeNotice({ stopReason: "cancelled", changedFiles: 0, rejectedExecute: true }), undefined);
  assert.equal(turnOutcomeNotice({ stopReason: "end_turn", changedFiles: 2, rejectedExecute: true }), undefined);
});
