import assert from "node:assert/strict";
import test from "node:test";
import { compilePlanBuildPrompt, planHasExecutableContent } from "../src/plan-build";
import type { PlanRecord } from "../src/storage/plan-repository";

function sample(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: "plan-abc",
    sessionId: "ses-1",
    version: 2,
    title: "登录改造",
    goal: "完成鉴权",
    steps: [
      { id: "step-1", order: 1, title: "改路由", files: ["a.ts"], status: "pending" },
      { id: "step-2", order: 2, title: "补测试", files: [], status: "completed" },
    ],
    files: ["a.ts"],
    risks: ["影响登录"],
    status: "approved",
    createdAt: 1,
    updatedAt: 2,
    source: "user",
    ...overrides,
  };
}

test("空计划不能开始构建", () => {
  assert.equal(planHasExecutableContent(sample({ steps: [] })), false);
  assert.equal(planHasExecutableContent(sample()), true);
});

test("开始构建提示包含结构化步骤且可续跑", () => {
  const prompt = compilePlanBuildPrompt(sample(), { resume: false });
  assert.match(prompt, /开始构建/);
  assert.match(prompt, /改路由/);
  assert.match(prompt, /补测试/);
  const resume = compilePlanBuildPrompt(sample(), { resume: true });
  assert.match(resume, /继续执行/);
});
