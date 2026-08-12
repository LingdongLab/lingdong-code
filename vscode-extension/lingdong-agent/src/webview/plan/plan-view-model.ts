/**
 * Plan 专用 ViewModel：阅读/编辑共用，禁止把绝对路径与分析噪声当步骤。
 */

import type { PlanCardView } from "../../plan-view-model";
import { PLAN_STATUS_LABELS, type PlanStatus } from "../../plan-view-model";
import type {
  PlanClarification,
  PlanRecord,
  PlanRecordStatus,
  PlanStepRecord,
  PlanStepStatus,
} from "../../storage/plan-repository";

export type PlanStepUiStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface PlanStepViewModel {
  id: string;
  order: number;
  title: string;
  description: string;
  files: string[];
  status: PlanStepUiStatus;
  validation?: string;
}

export interface PlanClarificationViewModel {
  id: string;
  question: string;
  answer?: string;
}

export interface PlanDocumentViewModel {
  id: string;
  version: number;
  status: string;
  statusLabel: string;
  title: string;
  goal: string;
  /** 已脱敏的计划原文 markdown；有它时文档正文走 markdown 渲染。 */
  raw: string;
  clarifications: PlanClarificationViewModel[];
  files: string[];
  risks: string[];
  steps: PlanStepViewModel[];
  progress: { done: number; total: number };
  createdAt: number;
  updatedAt: number;
  canBuild: boolean;
  empty: boolean;
}

export const STEP_STATUS_LABELS: Record<PlanStepUiStatus, string> = {
  pending: "待开始",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

const RECORD_STATUS_LABELS: Record<PlanRecordStatus, string> = {
  draft: "草稿",
  waiting_review: "待确认",
  approved: "已批准",
  executing: "执行中",
  paused: "已暂停",
  completed: "已完成",
  abandoned: "已放弃",
  cancelled: "已取消",
};

/** 将绝对路径压成 UI 相对路径；无法识别时取尾段，绝不展示盘符。 */
export function toUiRelativePath(input: string): string {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("//") || raw.startsWith("/")) {
    const stripped = raw.replace(/^[A-Za-z]:\/*/, "").replace(/^\/+/, "");
    const markers = [
      "src/",
      "tests/",
      "test/",
      "packages/",
      "docs/",
      "vscode-extension/",
      "apps/",
      "lib/",
    ];
    const lower = stripped.toLowerCase();
    for (const marker of markers) {
      const idx = lower.indexOf(marker);
      if (idx >= 0) return stripped.slice(idx);
    }
    const parts = stripped.split("/").filter(Boolean);
    return parts.slice(-3).join("/");
  }
  return raw.replace(/^\.\//, "");
}

export function sanitizePathList(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const rel = toUiRelativePath(path);
    if (!rel || seen.has(rel.toLowerCase())) continue;
    if (looksLikeAbsolutePath(rel)) continue;
    seen.add(rel.toLowerCase());
    out.push(rel);
  }
  return out;
}

export function looksLikeAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || /^\/(?:Users|home|tmp|var|mnt)\b/.test(value);
}

/** 文件分析结果 / 终端列目录噪声，不得当作 PlanStep。 */
export function isAnalysisNoiseStep(title: string, description = ""): boolean {
  const text = `${title}\n${description}`.trim();
  if (!text) return true;
  if (looksLikeAbsolutePath(title)) return true;
  if (/Get-ChildItem|\bDirectory:\s|Mode\s+LastWriteTime|----\s+----/i.test(text)) return true;
  if (/^(?:dir|ls|pwd)\b/i.test(title.trim())) return true;
  if (/^已(?:读取|列出|搜索|扫描)/.test(title) && !/步骤|改造|补充|抽出|调整/.test(title)) return true;
  return false;
}

function mapStepStatus(status: PlanStepStatus | string | undefined): PlanStepUiStatus {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "skipped":
    case "cancelled":
      return "skipped";
    default:
      return "pending";
  }
}

function statusLabelOf(record?: PlanRecord, card?: PlanCardView): string {
  if (record) return RECORD_STATUS_LABELS[record.status] ?? record.status;
  if (card) return PLAN_STATUS_LABELS[card.status as PlanStatus] ?? card.status;
  return "待确认";
}

function mapClarifications(items: PlanClarification[] | undefined): PlanClarificationViewModel[] {
  return (items ?? []).map((item) => ({
    id: item.id,
    question: item.question,
    ...(item.answer ? { answer: item.answer } : {}),
  }));
}

function mapRecordSteps(steps: PlanStepRecord[]): PlanStepViewModel[] {
  return steps
    .filter((step) => !isAnalysisNoiseStep(step.title, step.description ?? ""))
    .map((step, index) => ({
      id: step.id,
      order: step.order || index + 1,
      title: step.title,
      description: step.description ?? "",
      files: sanitizePathList(step.files),
      status: mapStepStatus(step.status),
    }));
}

function mapCardSteps(card: PlanCardView): PlanStepViewModel[] {
  return card.steps
    .filter((step) => !isAnalysisNoiseStep(step.title, step.detail ?? ""))
    .map((step, index) => ({
      id: `card-step-${step.index || index + 1}`,
      order: step.index || index + 1,
      title: step.title,
      description: step.detail ?? "",
      files: sanitizePathList(step.files),
      // 实时 todo 卡片带结构化状态；审批计划的卡片没有，视为待开始。
      status: mapStepStatus(step.status),
    }));
}

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 计划原文几乎总以自己的标题开头，而文档头部已经单独显示了标题。
 * 两个并排出来就是同一句话连着写两遍，第一眼像渲染坏了。
 * 只砍开头那一个、且文字要对得上——原文换了个说法就说明它不是重复。
 */
export function stripDuplicateHeading(raw: string, title: string): string {
  const wanted = normalizeHeading(title);
  if (!wanted) return raw;
  const lines = raw.split("\n");
  let index = 0;
  while (index < lines.length && !lines[index]?.trim()) index += 1;
  const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[index] ?? "");
  if (!heading || normalizeHeading(heading[1] ?? "") !== wanted) return raw;
  return lines.slice(index + 1).join("\n").trim();
}

export function buildPlanDocumentViewModel(
  record?: PlanRecord,
  card?: PlanCardView,
): PlanDocumentViewModel | undefined {
  if (!record && !card) return undefined;
  const steps = record ? mapRecordSteps(record.steps) : mapCardSteps(card!);
  const files = sanitizePathList(record?.files ?? card?.files ?? []);
  const risks = (record?.risks ?? card?.risks ?? []).map((r) => r.trim()).filter(Boolean);
  const done = steps.filter((s) => s.status === "completed").length;
  const title = (record?.title || card?.title || "实施计划").trim() || "实施计划";
  const goal = (record?.goal ?? "").trim();
  const raw = stripDuplicateHeading((record?.raw ?? card?.raw ?? "").trim(), title);
  const empty = steps.length === 0 && !goal && files.length === 0 && !(card && !card.empty && card.raw);
  const status = record?.status ?? card?.status ?? "ready";
  // 构建中给实时 N/M 进度头，对齐 Cursor 计划页的状态徽章。
  const statusLabel = status === "executing" && steps.length > 0
    ? `构建中 · ${done}/${steps.length}`
    : statusLabelOf(record, card);
  return {
    id: record?.id ?? "plan-card",
    version: record?.version ?? 1,
    status,
    statusLabel,
    title,
    goal,
    raw,
    clarifications: mapClarifications(record?.clarifications),
    files,
    risks,
    steps,
    progress: { done, total: steps.length },
    createdAt: record?.createdAt ?? 0,
    updatedAt: record?.updatedAt ?? 0,
    canBuild: !empty && (record ? steps.length > 0 : !!card?.canApprove),
    empty,
  };
}

export function formatPlanUpdatedAt(ts: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function moveStep<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) {
    return [...items];
  }
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...items];
  next.splice(to, 0, item);
  return next;
}
