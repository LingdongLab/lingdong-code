import assert from "node:assert/strict";
import test from "node:test";
import { diffExecutingSteps, normalizeStepTitle } from "../src/plan-step-sync";
import type { PlanStepRecord } from "../src/storage/plan-repository";

function step(overrides: Partial<PlanStepRecord> & { id: string; order: number; title: string }): PlanStepRecord {
  return { files: [], status: "pending", ...overrides };
}

test("标题归一化抹平大小写、空白与标点", () => {
  assert.equal(normalizeStepTitle("补充 失败路径 测试！"), normalizeStepTitle("补充失败路径测试"));
  assert.equal(normalizeStepTitle("Add SessionService"), normalizeStepTitle("add sessionservice"));
  assert.notEqual(normalizeStepTitle("步骤一"), normalizeStepTitle("步骤二"));
});

test("标题匹配：todo 状态映射到对应步骤", () => {
  const records = [
    step({ id: "s1", order: 1, title: "补充失败路径测试" }),
    step({ id: "s2", order: 2, title: "抽出 SessionService" }),
  ];
  const patches = diffExecutingSteps(records, [
    { index: 1, title: "补充 失败路径 测试", status: "completed" },
    { index: 2, title: "抽出 SessionService", status: "in_progress" },
  ]);
  assert.deepEqual(patches, [
    { stepId: "s1", status: "completed" },
    { stepId: "s2", status: "in_progress" },
  ]);
});

test("标题对不上时按序号兜底", () => {
  const records = [
    step({ id: "s1", order: 1, title: "第一步" }),
    step({ id: "s2", order: 2, title: "第二步" }),
  ];
  const patches = diffExecutingSteps(records, [
    { index: 2, title: "模型改写过的标题", status: "completed" },
  ]);
  assert.deepEqual(patches, [{ stepId: "s2", status: "completed" }]);
});

test("序号也对不上但条数相同时按位置兜底", () => {
  const records = [
    step({ id: "s1", order: 1, title: "第一步" }),
    step({ id: "s2", order: 2, title: "第二步" }),
  ];
  const patches = diffExecutingSteps(records, [
    { index: 7, title: "改写一", status: "completed" },
    { index: 8, title: "改写二", status: "in_progress" },
  ]);
  assert.deepEqual(patches, [
    { stepId: "s1", status: "completed" },
    { stepId: "s2", status: "in_progress" },
  ]);
});

test("状态只推进不回退：已完成的步骤不被 pending/in_progress 抹掉", () => {
  const records = [
    step({ id: "s1", order: 1, title: "第一步", status: "completed" }),
    step({ id: "s2", order: 2, title: "第二步", status: "in_progress" }),
  ];
  assert.deepEqual(diffExecutingSteps(records, [
    { index: 1, title: "第一步", status: "in_progress" },
    { index: 2, title: "第二步", status: "pending" },
  ]), []);
  // 同级不同终态也不互换（completed → failed 不生效）
  assert.deepEqual(diffExecutingSteps(records, [
    { index: 1, title: "第一步", status: "failed" },
  ]), []);
});

test("无状态或未知状态的 todo 条目不产生补丁", () => {
  const records = [step({ id: "s1", order: 1, title: "第一步" })];
  assert.deepEqual(diffExecutingSteps(records, [
    { index: 1, title: "第一步" },
    { index: 1, title: "第一步", status: "someday" },
  ]), []);
});

test("同名步骤逐个认领，不重复打到同一条", () => {
  const records = [
    step({ id: "s1", order: 1, title: "跑测试" }),
    step({ id: "s2", order: 2, title: "跑测试" }),
  ];
  const patches = diffExecutingSteps(records, [
    { index: 1, title: "跑测试", status: "completed" },
    { index: 2, title: "跑测试", status: "in_progress" },
  ]);
  assert.deepEqual(patches, [
    { stepId: "s1", status: "completed" },
    { stepId: "s2", status: "in_progress" },
  ]);
});

test("todo 比计划多出的临时条目不误伤计划步骤", () => {
  const records = [step({ id: "s1", order: 1, title: "改造登录页" })];
  const patches = diffExecutingSteps(records, [
    { index: 1, title: "改造登录页", status: "in_progress" },
    { index: 2, title: "顺手修一下 lint", status: "completed" },
    { index: 3, title: "再跑一遍构建", status: "completed" },
  ]);
  assert.deepEqual(patches, [{ stepId: "s1", status: "in_progress" }]);
});
