import path from "node:path";
import type { PlanRecord, PlanRecordStatus, PlanStepRecord } from "./storage/plan-repository";
import { isInsideWorkspace } from "./workspace-guard";

const STATUS_LABELS: Record<PlanRecordStatus, string> = {
  draft: "草稿",
  waiting_review: "待审批",
  approved: "已批准",
  executing: "执行中",
  paused: "已暂停",
  completed: "已完成",
  abandoned: "已放弃",
  cancelled: "已取消",
};

const STEP_STATUS_LABELS: Record<PlanStepRecord["status"], string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
  skipped: "已跳过",
};

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 把标题转成文件名安全的 slug 段，例如「Login System」→ login-system。 */
function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.slice(0, 60) || "plan";
}

/** 生成计划 Markdown 文件名前缀，例如 2026-08-05-login-system。 */
export function planSlug(title: string, date: Date): string {
  const datePart = date.toISOString().slice(0, 10);
  return `${datePart}-${slugifyTitle(title)}`;
}

/** 工作区内相对路径：`.lingdong/plans/<slug>.md`。 */
export function planMarkdownRelativePath(plan: PlanRecord, date?: Date): string {
  const slug = planSlug(plan.title, date ?? new Date(plan.createdAt));
  return `.lingdong/plans/${slug}.md`;
}

/** 校验相对路径在工作区内；合法则返回绝对路径，否则 undefined。 */
export function assertPlanPathSafe(workspaceRoot: string, relativePath: string): string | undefined {
  if (!isInsideWorkspace(workspaceRoot, relativePath)) return undefined;
  return path.resolve(path.resolve(workspaceRoot), relativePath);
}

function renderStep(step: PlanStepRecord, currentStepId?: string): string {
  const marker = step.id === currentStepId ? " ← 当前" : "";
  const lines = [`${step.order}. [${STEP_STATUS_LABELS[step.status]}] ${step.title}${marker}`];
  if (step.description) lines.push(`   ${step.description}`);
  if (step.files.length > 0) lines.push(`   涉及文件：${step.files.join("、")}`);
  return lines.join("\n");
}

/** 把 PlanRecord 渲染为可读 Markdown，供 `.lingdong/plans/` 归档。 */
export function toPlanMarkdown(plan: PlanRecord): string {
  const lines: string[] = [`# ${plan.title}`, ""];

  lines.push("## 目标");
  lines.push(plan.goal?.trim() || plan.title);
  lines.push("");

  lines.push("## 步骤");
  if (plan.steps.length === 0) {
    lines.push("（无结构化步骤）");
  } else {
    lines.push(plan.steps.map((step) => renderStep(step, plan.currentStepId)).join("\n"));
  }
  lines.push("");

  lines.push("## 涉及文件");
  if (plan.files.length === 0) {
    lines.push("（无）");
  } else {
    for (const file of plan.files) lines.push(`- \`${file}\``);
  }
  lines.push("");

  lines.push("## 风险");
  if (plan.risks.length === 0) {
    lines.push("（无）");
  } else {
    for (const risk of plan.risks) lines.push(`- ${risk}`);
  }
  lines.push("");

  lines.push("## 当前进度");
  lines.push(`- 状态：${STATUS_LABELS[plan.status]}`);
  if (plan.currentStepId) {
    const current = plan.steps.find((step) => step.id === plan.currentStepId);
    if (current) lines.push(`- 当前步骤：${current.order}. ${current.title}`);
  }
  const completedCount = plan.steps.filter((step) => step.status === "completed").length;
  if (plan.steps.length > 0) {
    lines.push(`- 步骤进度：${completedCount}/${plan.steps.length}`);
  }
  lines.push("");

  lines.push("## 时间");
  lines.push(`- 创建：${formatTimestamp(plan.createdAt)}`);
  lines.push(`- 更新：${formatTimestamp(plan.updatedAt)}`);
  if (plan.approvedAt !== undefined) lines.push(`- 批准：${formatTimestamp(plan.approvedAt)}`);
  if (plan.completedAt !== undefined) lines.push(`- 完成：${formatTimestamp(plan.completedAt)}`);
  lines.push("");

  if (plan.raw?.trim()) {
    lines.push("## 原始计划");
    lines.push(plan.raw.trim());
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
