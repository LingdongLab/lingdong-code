import assert from "node:assert/strict";
import test from "node:test";
import { isLocalStepId, planStepOps, type StepSnapshot } from "../src/plan-step-ops";

function step(id: string, title = id, files: string[] = []): StepSnapshot {
  return { id, title, description: "", files };
}

test("没有改动就没有操作", () => {
  const steps = [step("a"), step("b")];
  assert.deepEqual(planStepOps(steps, steps), []);
});

test("删掉的步骤产生 remove", () => {
  const ops = planStepOps([step("a"), step("b")], [step("a")]);
  assert.deepEqual(ops, [{ kind: "remove", stepId: "b" }]);
});

test("新步骤只发标题与说明，等落库后再谈别的", () => {
  const ops = planStepOps(
    [step("a")],
    [step("a"), { id: "step-local-1", title: "补充测试", description: "跑一遍", files: ["x.ts"] }],
  );
  assert.deepEqual(ops, [{ kind: "add", title: "补充测试", description: "跑一遍" }]);
});

test("标题还空着的新步骤先不落库", () => {
  const ops = planStepOps([step("a")], [step("a"), { id: "step-local-1", title: "  ", description: "", files: [] }]);
  assert.deepEqual(ops, []);
});

test("改标题产生 update", () => {
  const ops = planStepOps([step("a", "旧标题")], [step("a", "新标题")]);
  assert.deepEqual(ops, [
    { kind: "update", stepId: "a", title: "新标题", description: "", files: [] },
  ]);
});

test("改文件列表也产生 update", () => {
  const ops = planStepOps([step("a", "标题", ["x.ts"])], [step("a", "标题", ["x.ts", "y.ts"])]);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], {
    kind: "update",
    stepId: "a",
    title: "标题",
    description: "",
    files: ["x.ts", "y.ts"],
  });
});

test("说明从有到空也要发出去，否则删不掉", () => {
  const before: StepSnapshot = { id: "a", title: "标题", description: "旧说明", files: [] };
  const after: StepSnapshot = { id: "a", title: "标题", description: "", files: [] };
  assert.deepEqual(planStepOps([before], [after]), [
    { kind: "update", stepId: "a", title: "标题", description: "", files: [] },
  ]);
});

test("顺序变了产生 reorder", () => {
  const ops = planStepOps([step("a"), step("b"), step("c")], [step("c"), step("a"), step("b")]);
  assert.deepEqual(ops, [{ kind: "reorder", stepIds: ["c", "a", "b"] }]);
});

test("只剩一步时不发 reorder", () => {
  assert.deepEqual(planStepOps([step("a"), step("b")], [step("b")]), [
    { kind: "remove", stepId: "a" },
  ]);
});

test("删除排在重排之前，重排的 id 列表里不留待删的步骤", () => {
  const ops = planStepOps(
    [step("a"), step("b"), step("c")],
    [step("c"), step("a")],
  );
  assert.deepEqual(ops, [
    { kind: "remove", stepId: "b" },
    { kind: "reorder", stepIds: ["c", "a"] },
  ]);
});

test("新增排在重排之前，新步骤不参与这次的顺序", () => {
  const ops = planStepOps(
    [step("a"), step("b")],
    [{ id: "step-local-9", title: "插一步", description: "", files: [] }, step("b"), step("a")],
  );
  assert.deepEqual(ops, [
    { kind: "add", title: "插一步" },
    { kind: "reorder", stepIds: ["b", "a"] },
  ]);
});

test("一次拖拽同时改标题：两个操作都发，顺序在后", () => {
  const ops = planStepOps([step("a", "甲"), step("b", "乙")], [step("b", "乙"), step("a", "甲改")]);
  assert.deepEqual(ops, [
    { kind: "update", stepId: "a", title: "甲改", description: "", files: [] },
    { kind: "reorder", stepIds: ["b", "a"] },
  ]);
});

test("审批卡的占位 id 也算本地，会被当成新步骤落库", () => {
  assert.equal(isLocalStepId("card-step-1"), true);
  assert.equal(isLocalStepId("step-local-123"), true);
  assert.equal(isLocalStepId("s1"), false);
  const ops = planStepOps([], [{ id: "card-step-1", title: "第一步", description: "", files: [] }]);
  assert.deepEqual(ops, [{ kind: "add", title: "第一步" }]);
});
