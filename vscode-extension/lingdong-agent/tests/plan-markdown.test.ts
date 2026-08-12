import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
  assertPlanPathSafe,
  planMarkdownRelativePath,
  planSlug,
  toPlanMarkdown,
} from "../src/plan-markdown";
import type { PlanRecord } from "../src/storage/plan-repository";

function samplePlan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: "plan-test",
    sessionId: "ses-abc",
    version: 1,
    title: "Login System",
    goal: "重构登录流程",
    steps: [
      {
        id: "step-1",
        order: 1,
        title: "更新路由",
        description: "调整 auth 路由",
        files: ["src/router.ts"],
        status: "completed",
        startedAt: 1_000,
        completedAt: 2_000,
      },
      {
        id: "step-2",
        order: 2,
        title: "补充测试",
        files: ["tests/auth.test.ts"],
        status: "in_progress",
        startedAt: 3_000,
      },
    ],
    files: ["src/router.ts", "tests/auth.test.ts"],
    risks: ["可能影响现有登录流程"],
    status: "executing",
    createdAt: Date.parse("2026-08-05T08:00:00+08:00"),
    updatedAt: Date.parse("2026-08-05T09:30:00+08:00"),
    approvedAt: Date.parse("2026-08-05T08:15:00+08:00"),
    source: "grok",
    currentStepId: "step-2",
    ...overrides,
  };
}

test("planSlug 生成日期前缀与标题 slug", () => {
  const slug = planSlug("Login System", new Date("2026-08-05T12:00:00+08:00"));
  assert.equal(slug, "2026-08-05-login-system");
});

test("planMarkdownRelativePath 返回 .lingdong/plans 下的相对路径", () => {
  const plan = samplePlan();
  const relative = planMarkdownRelativePath(plan, new Date("2026-08-05T12:00:00+08:00"));
  assert.equal(relative, ".lingdong/plans/2026-08-05-login-system.md");
});

test("toPlanMarkdown 包含目标、步骤、文件、风险、进度与时间", () => {
  const markdown = toPlanMarkdown(samplePlan());
  assert.ok(markdown.includes("# Login System"));
  assert.ok(markdown.includes("## 目标"));
  assert.ok(markdown.includes("重构登录流程"));
  assert.ok(markdown.includes("## 步骤"));
  assert.ok(markdown.includes("[已完成] 更新路由"));
  assert.ok(markdown.includes("[进行中] 补充测试"));
  assert.ok(markdown.includes("← 当前"));
  assert.ok(markdown.includes("## 涉及文件"));
  assert.ok(markdown.includes("`src/router.ts`"));
  assert.ok(markdown.includes("## 风险"));
  assert.ok(markdown.includes("可能影响现有登录流程"));
  assert.ok(markdown.includes("## 当前进度"));
  assert.ok(markdown.includes("状态：执行中"));
  assert.ok(markdown.includes("步骤进度：1/2"));
  assert.ok(markdown.includes("## 时间"));
  assert.ok(markdown.includes("创建："));
  assert.ok(markdown.includes("更新："));
  assert.ok(markdown.includes("批准："));
});

test("assertPlanPathSafe 合法路径返回绝对路径", () => {
  const workspace = path.resolve("E:/LingdongCode/demo");
  const absolute = assertPlanPathSafe(workspace, ".lingdong/plans/2026-08-05-login-system.md");
  assert.equal(absolute, path.join(workspace, ".lingdong/plans/2026-08-05-login-system.md"));
});

test("assertPlanPathSafe 拒绝工作区外路径", () => {
  const workspace = path.resolve("E:/LingdongCode/demo");
  assert.equal(assertPlanPathSafe(workspace, "../secret/plan.md"), undefined);
  assert.equal(assertPlanPathSafe(workspace, "../../outside/plan.md"), undefined);
});

test("toPlanMarkdown 无步骤时展示占位说明", () => {
  const markdown = toPlanMarkdown(samplePlan({ steps: [] }));
  assert.ok(markdown.includes("（无结构化步骤）"));
});

test("toPlanMarkdown 保留原始计划段落", () => {
  const markdown = toPlanMarkdown(samplePlan({ raw: "## 原始 Markdown\n\n详细说明" }));
  assert.ok(markdown.includes("## 原始计划"));
  assert.ok(markdown.includes("详细说明"));
});
