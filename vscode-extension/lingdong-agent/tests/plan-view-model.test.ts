import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPlan } from "@lingdong/agent-runtime";
import { PLAN_STATUS_LABELS, canApprove, toPlanCard } from "../src/plan-view-model";

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    title: "修改首页标题",
    steps: [{ index: 1, title: "更新 index.html", detail: "修改 h1", files: ["index.html"] }],
    files: ["index.html"],
    risks: ["改动影响首屏"],
    raw: "# 修改首页标题",
    empty: false,
    ...overrides,
  };
}

test("正常计划转换为可批准的卡片", () => {
  const card = toPlanCard(plan());
  assert.equal(card.title, "修改首页标题");
  assert.equal(card.steps.length, 1);
  assert.deepEqual(card.files, ["index.html"]);
  assert.deepEqual(card.risks, ["改动影响首屏"]);
  assert.equal(card.canApprove, true);
  assert.equal(card.status, "ready");
  // 原文始终随卡片下发：计划文档正文用它渲染 markdown。
  assert.equal(card.raw, "# 修改首页标题");
});

test("空计划不可批准", () => {
  const empty = plan({ steps: [], files: [], risks: [], raw: "", empty: true });
  assert.equal(canApprove(empty), false);
  assert.equal(toPlanCard(empty).canApprove, false);
});

test("解析不出步骤但有原文时保留原文并允许批准", () => {
  const card = toPlanCard(plan({ steps: [], raw: "一段没有结构的计划说明", empty: false }));
  assert.equal(card.steps.length, 0);
  assert.equal(card.raw, "一段没有结构的计划说明");
  assert.equal(card.canApprove, true);
});

test("状态可由调用方指定", () => {
  assert.equal(toPlanCard(plan(), "executing").status, "executing");
});

test("步骤的结构化状态透传到卡片，缺省时不虚构", () => {
  const card = toPlanCard(plan({
    steps: [
      { index: 1, title: "读取文件", files: [], status: "completed" },
      { index: 2, title: "修改标题", files: [], status: "in_progress" },
      { index: 3, title: "运行校验", files: [] },
    ],
  }), "executing");
  assert.deepEqual(card.steps.map((step) => step.status), ["completed", "in_progress", undefined]);
});

test("计划状态文案不与任务执行完成混淆", () => {
  assert.equal(PLAN_STATUS_LABELS.completed, "计划已批准");
  assert.equal(PLAN_STATUS_LABELS.ready, "待审批");
  assert.equal(Object.values(PLAN_STATUS_LABELS).includes("已完成"), false);
});
