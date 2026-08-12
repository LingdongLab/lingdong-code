import type { AgentPlan } from "@lingdong/agent-runtime";

export type PlanStatus =
  | "generating"
  | "ready"
  | "revising"
  | "approved"
  | "executing"
  | "abandoned"
  | "completed"
  | "failed";

/**
 * 计划卡片状态文案。completed 指「计划本身已通过审批」，
 * 与任务执行结束是两回事，所以不能写成「已完成」。
 */
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  generating: "生成中",
  ready: "待审批",
  revising: "等待新计划",
  approved: "已批准",
  executing: "执行中",
  abandoned: "已放弃",
  completed: "计划已批准",
  failed: "已失败",
};

export type PlanStepViewStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface PlanStepView {
  index: number;
  title: string;
  detail?: string;
  files: string[];
  /** 实时 todo 更新才携带；审批计划的步骤没有状态。 */
  status?: PlanStepViewStatus;
}

export interface PlanCardView {
  title: string;
  steps: PlanStepView[];
  files: string[];
  risks: string[];
  /** 已脱敏的计划原文；计划文档正文用它渲染 markdown，解析失败时也作兜底。 */
  raw?: string;
  empty: boolean;
  canApprove: boolean;
  status: PlanStatus;
}

const MAX_STEPS = 40;
const MAX_FILES = 60;
const MAX_RISKS = 20;
const MAX_RAW = 8_000;

/** 空计划不可批准：没有步骤也没有原文时，批准按钮必须禁用。 */
export function canApprove(plan: AgentPlan): boolean {
  if (plan.empty) return false;
  return plan.steps.length > 0 || plan.raw.trim().length > 0;
}

export function toPlanCard(plan: AgentPlan, status: PlanStatus = "ready"): PlanCardView {
  const steps = plan.steps.slice(0, MAX_STEPS).map((step) => ({
    index: step.index,
    title: step.title,
    ...(step.detail ? { detail: step.detail } : {}),
    files: step.files.slice(0, MAX_FILES),
    ...(step.status ? { status: step.status } : {}),
  }));
  return {
    title: plan.title || "实施计划",
    steps,
    files: plan.files.slice(0, MAX_FILES),
    risks: plan.risks.slice(0, MAX_RISKS),
    // 原文始终随卡片下发：计划文档正文用它做 markdown 渲染，不再只当解析失败的兜底。
    ...(plan.raw.trim().length > 0 ? { raw: plan.raw.slice(0, MAX_RAW) } : {}),
    empty: plan.empty,
    canApprove: canApprove(plan),
    status,
  };
}
