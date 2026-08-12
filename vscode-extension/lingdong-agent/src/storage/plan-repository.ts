import { randomBytes } from "node:crypto";
import { redactText } from "@lingdong/agent-runtime";
import type { PlanCardView, PlanStatus } from "../plan-view-model";
import { JsonStore, type LoadStatus } from "./json-store";

/**
 * 计划持久化仓库。
 * 与会话 transcript 分离存储：计划有独立生命周期（审批、执行、暂停），
 * 且需要版本号追踪每次实质性变更。
 */

export type PlanRecordStatus =
  | "draft"
  | "waiting_review"
  | "approved"
  | "executing"
  | "paused"
  | "completed"
  | "abandoned"
  | "cancelled";

export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed"
  | "skipped";

export interface PlanStepRecord {
  id: string;
  order: number;
  title: string;
  description?: string;
  files: string[];
  status: PlanStepStatus;
  startedAt?: number;
  completedAt?: number;
}

export interface PlanClarification {
  id: string;
  question: string;
  answer?: string;
  askedAt: number;
}

export interface PlanRecord {
  id: string;
  sessionId: string;
  version: number;
  title: string;
  goal?: string;
  steps: PlanStepRecord[];
  files: string[];
  risks: string[];
  status: PlanRecordStatus;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  completedAt?: number;
  raw?: string;
  source: "grok" | "user";
  currentStepId?: string;
  clarifications?: PlanClarification[];
}

/** 仍算「活跃」、可被恢复或继续执行的状态。 */
const ACTIVE_STATUSES: ReadonlySet<PlanRecordStatus> = new Set([
  "waiting_review",
  "approved",
  "executing",
  "paused",
]);

const PLAN_STATUSES: ReadonlySet<PlanRecordStatus> = new Set([
  "draft",
  "waiting_review",
  "approved",
  "executing",
  "paused",
  "completed",
  "abandoned",
  "cancelled",
]);

const STEP_STATUSES: ReadonlySet<PlanStepStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "failed",
  "skipped",
]);

function createStepId(): string {
  return `step-${randomBytes(6).toString("hex")}`;
}

function createClarificationId(): string {
  return `ask-${randomBytes(6).toString("hex")}`;
}

function validateClarification(data: unknown): PlanClarification | undefined {
  if (!isRecordObject(data)) return undefined;
  if (typeof data.id !== "string" || data.id === "") return undefined;
  if (typeof data.question !== "string" || data.question === "") return undefined;
  return {
    id: data.id,
    question: data.question,
    ...(optionalString(data.answer) ? { answer: data.answer as string } : {}),
    askedAt: numberOr(data.askedAt, 0),
  };
}

const PLAN_SOURCES: ReadonlySet<PlanRecord["source"]> = new Set(["grok", "user"]);

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createPlanId(): string {
  return `plan-${randomBytes(8).toString("hex")}`;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** UI 卡片状态 → 持久化状态。 */
function cardStatusToRecord(status: PlanStatus): PlanRecordStatus {
  switch (status) {
    case "generating":
    case "revising":
      return "draft";
    case "ready":
      return "waiting_review";
    case "approved":
      return "approved";
    case "executing":
      return "executing";
    case "abandoned":
      return "abandoned";
    case "completed":
      return "completed";
    case "failed":
      return "cancelled";
  }
}

function validateStep(data: unknown): PlanStepRecord | undefined {
  if (!isRecordObject(data)) return undefined;
  if (typeof data.id !== "string" || data.id === "") return undefined;
  if (typeof data.title !== "string" || data.title === "") return undefined;
  const status = STEP_STATUSES.has(data.status as PlanStepStatus)
    ? (data.status as PlanStepStatus)
    : "pending";
  return {
    id: data.id,
    order: numberOr(data.order, 0),
    title: data.title,
    ...(optionalString(data.description) ? { description: data.description as string } : {}),
    files: stringArray(data.files),
    status,
    ...(typeof data.startedAt === "number" ? { startedAt: data.startedAt } : {}),
    ...(typeof data.completedAt === "number" ? { completedAt: data.completedAt } : {}),
  };
}

/** 宽松校验：缺字段用默认值，步骤数组里坏条目直接丢弃。 */
function validatePlan(data: unknown): PlanRecord | undefined {
  if (!isRecordObject(data)) return undefined;
  if (typeof data.id !== "string" || data.id === "") return undefined;
  if (typeof data.sessionId !== "string" || data.sessionId === "") return undefined;

  const status = PLAN_STATUSES.has(data.status as PlanRecordStatus)
    ? (data.status as PlanRecordStatus)
    : "draft";
  const source = PLAN_SOURCES.has(data.source as PlanRecord["source"])
    ? (data.source as PlanRecord["source"])
    : "grok";
  const updatedAt = numberOr(data.updatedAt, numberOr(data.createdAt, 0));
  const steps = Array.isArray(data.steps)
    ? data.steps.map(validateStep).filter((step): step is PlanStepRecord => step !== undefined)
    : [];
  const clarifications = Array.isArray(data.clarifications)
    ? data.clarifications
      .map(validateClarification)
      .filter((item): item is PlanClarification => item !== undefined)
    : undefined;

  return {
    id: data.id,
    sessionId: data.sessionId,
    version: Math.max(1, numberOr(data.version, 1)),
    title: typeof data.title === "string" && data.title !== "" ? data.title : "实施计划",
    ...(optionalString(data.goal) ? { goal: data.goal as string } : {}),
    steps,
    files: stringArray(data.files),
    risks: stringArray(data.risks),
    status,
    createdAt: numberOr(data.createdAt, updatedAt),
    updatedAt,
    ...(typeof data.approvedAt === "number" ? { approvedAt: data.approvedAt } : {}),
    ...(typeof data.completedAt === "number" ? { completedAt: data.completedAt } : {}),
    ...(optionalString(data.raw) ? { raw: data.raw as string } : {}),
    source,
    ...(optionalString(data.currentStepId) ? { currentStepId: data.currentStepId as string } : {}),
    ...(clarifications && clarifications.length > 0 ? { clarifications } : {}),
  };
}

function validatePlans(data: unknown): { plans: PlanRecord[] } | undefined {
  if (!isRecordObject(data) || !Array.isArray(data.plans)) return undefined;
  const plans = data.plans
    .map(validatePlan)
    .filter((plan): plan is PlanRecord => plan !== undefined);
  return { plans };
}

/** 落盘前脱敏：仅处理可能含密钥的文本字段。 */
function sanitizePlan(plan: PlanRecord): PlanRecord {
  return {
    ...plan,
    title: redactText(plan.title),
    ...(plan.goal !== undefined ? { goal: redactText(plan.goal) } : {}),
    risks: plan.risks.map((risk) => redactText(risk)),
    ...(plan.raw !== undefined ? { raw: redactText(plan.raw) } : {}),
    ...(plan.clarifications
      ? {
          clarifications: plan.clarifications.map((item) => ({
            ...item,
            question: redactText(item.question),
            ...(item.answer !== undefined ? { answer: redactText(item.answer) } : {}),
          })),
        }
      : {}),
  };
}

function reindexSteps(steps: readonly PlanStepRecord[]): PlanStepRecord[] {
  return steps.map((step, index) => ({ ...step, order: index + 1 }));
}

export interface PlanRepositoryOptions {
  onDamage?: (detail: string) => void;
  now?: () => number;
}

export class PlanRepository {
  private plansValue: PlanRecord[] = [];
  private readonly onDamage: (detail: string) => void;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private file: string,
    private readonly store: JsonStore,
    options: PlanRepositoryOptions = {},
  ) {
    this.onDamage = options.onDamage ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
  }

  get plans(): PlanRecord[] {
    return [...this.plansValue];
  }

  /** 活跃计划里 updatedAt 最新的一条。 */
  get active(): PlanRecord | undefined {
    let latest: PlanRecord | undefined;
    for (const plan of this.plansValue) {
      if (!ACTIVE_STATUSES.has(plan.status)) continue;
      if (!latest || plan.updatedAt > latest.updatedAt) latest = plan;
    }
    return latest;
  }

  async open(file: string): Promise<LoadStatus> {
    await this.flush();
    this.file = file;
    const result = await this.store.read<{ plans: PlanRecord[] }>(file, {
      kind: "plans",
      fallback: () => ({ plans: [] }),
      validate: validatePlans,
    });
    if (result.status !== "ok" && result.status !== "missing") {
      this.onDamage(`计划记录：${result.detail ?? result.status}`);
    }
    this.plansValue = result.data.plans;
    this.dirty = false;
    return result.status;
  }

  /** 同 id 替换；若 version 未递增则自动 +1。 */
  upsert(plan: PlanRecord): void {
    const index = this.plansValue.findIndex((item) => item.id === plan.id);
    const timestamp = this.now();
    if (index >= 0) {
      const existing = this.plansValue[index];
      if (!existing) return;
      const version = plan.version <= existing.version ? existing.version + 1 : plan.version;
      this.plansValue[index] = { ...plan, version, updatedAt: timestamp };
    } else {
      this.plansValue.push({ ...plan, updatedAt: timestamp });
    }
    this.dirty = true;
  }

  /** 从 Plan 卡片视图创建新记录，默认来源 grok。 */
  createFromCard(sessionId: string, card: PlanCardView, status?: PlanRecordStatus): PlanRecord {
    const timestamp = this.now();
    const recordStatus = status ?? cardStatusToRecord(card.status);
    const steps: PlanStepRecord[] = card.steps.map((step) => ({
      id: `step-${step.index}`,
      order: step.index,
      title: step.title,
      ...(step.detail ? { description: step.detail } : {}),
      files: [...step.files],
      status: "pending",
    }));
    return {
      id: createPlanId(),
      sessionId,
      version: 1,
      title: card.title,
      steps,
      files: [...card.files],
      risks: [...card.risks],
      status: recordStatus,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(card.raw ? { raw: card.raw } : {}),
      source: "grok",
    };
  }

  setStatus(planId: string, status: PlanRecordStatus, _message?: string): PlanRecord | undefined {
    const index = this.plansValue.findIndex((plan) => plan.id === planId);
    if (index < 0) return undefined;
    const existing = this.plansValue[index];
    if (!existing) return undefined;
    const timestamp = this.now();
    const updated: PlanRecord = {
      ...existing,
      status,
      version: existing.version + 1,
      updatedAt: timestamp,
    };
    if (status === "approved" && existing.approvedAt === undefined) {
      updated.approvedAt = timestamp;
    }
    if (status === "completed" && existing.completedAt === undefined) {
      updated.completedAt = timestamp;
    }
    this.plansValue[index] = updated;
    this.dirty = true;
    return updated;
  }

  updateStep(planId: string, stepId: string, patch: Partial<PlanStepRecord>): PlanRecord | undefined {
    const planIndex = this.plansValue.findIndex((plan) => plan.id === planId);
    if (planIndex < 0) return undefined;
    const existing = this.plansValue[planIndex];
    if (!existing) return undefined;
    const stepIndex = existing.steps.findIndex((step) => step.id === stepId);
    if (stepIndex < 0) return undefined;
    const currentStep = existing.steps[stepIndex];
    if (!currentStep) return undefined;

    const timestamp = this.now();
    const steps = [...existing.steps];
    const merged: PlanStepRecord = { ...currentStep, ...patch };
    if (patch.status === "in_progress" && merged.startedAt === undefined) {
      merged.startedAt = timestamp;
    }
    if (
      (patch.status === "completed" || patch.status === "failed" || patch.status === "skipped")
      && merged.completedAt === undefined
    ) {
      merged.completedAt = timestamp;
    }
    steps[stepIndex] = merged;

    const updated: PlanRecord = {
      ...existing,
      steps,
      version: existing.version + 1,
      updatedAt: timestamp,
    };
    if (patch.status === "in_progress") {
      updated.currentStepId = stepId;
    }
    this.plansValue[planIndex] = updated;
    this.dirty = true;
    return updated;
  }

  updateMeta(
    planId: string,
    meta: { title?: string; goal?: string; files?: string[]; risks?: string[]; raw?: string },
  ): PlanRecord | undefined {
    const index = this.plansValue.findIndex((plan) => plan.id === planId);
    if (index < 0) return undefined;
    const existing = this.plansValue[index];
    if (!existing) return undefined;
    const title = meta.title?.trim();
    const updated: PlanRecord = {
      ...existing,
      ...(title ? { title } : {}),
      ...(meta.files ? { files: [...meta.files] } : {}),
      ...(meta.risks ? { risks: [...meta.risks] } : {}),
      version: existing.version + 1,
      updatedAt: this.now(),
      source: existing.source === "grok" ? "user" : existing.source,
    };
    if (meta.goal !== undefined) {
      const goal = meta.goal.trim();
      if (goal) updated.goal = goal;
      else delete updated.goal;
    }
    if (meta.raw !== undefined) {
      const raw = meta.raw;
      if (raw.trim()) updated.raw = raw;
      else delete updated.raw;
    }
    this.plansValue[index] = updated;
    this.dirty = true;
    return updated;
  }

  addStep(
    planId: string,
    input: { title: string; description?: string; files?: string[]; at?: number },
  ): PlanRecord | undefined {
    const index = this.plansValue.findIndex((plan) => plan.id === planId);
    if (index < 0) return undefined;
    const existing = this.plansValue[index];
    if (!existing) return undefined;
    const title = input.title.trim();
    if (title === "") return undefined;
    const step: PlanStepRecord = {
      id: createStepId(),
      order: existing.steps.length + 1,
      title,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      files: input.files ? [...input.files] : [],
      status: "pending",
    };
    const steps = [...existing.steps];
    const at = typeof input.at === "number" ? Math.max(0, Math.min(input.at, steps.length)) : steps.length;
    steps.splice(at, 0, step);
    const updated: PlanRecord = {
      ...existing,
      steps: reindexSteps(steps),
      version: existing.version + 1,
      updatedAt: this.now(),
      source: "user",
    };
    this.plansValue[index] = updated;
    this.dirty = true;
    return updated;
  }

  removeStep(planId: string, stepId: string): PlanRecord | undefined {
    const index = this.plansValue.findIndex((plan) => plan.id === planId);
    if (index < 0) return undefined;
    const existing = this.plansValue[index];
    if (!existing) return undefined;
    const steps = existing.steps.filter((step) => step.id !== stepId);
    if (steps.length === existing.steps.length) return undefined;
    const updated: PlanRecord = {
      ...existing,
      steps: reindexSteps(steps),
      version: existing.version + 1,
      updatedAt: this.now(),
      source: "user",
    };
    if (existing.currentStepId === stepId) delete updated.currentStepId;
    this.plansValue[index] = updated;
    this.dirty = true;
    return updated;
  }

  /** stepIds 为期望的新顺序；未列出的步骤追加在末尾保持相对次序。 */
  reorderSteps(planId: string, stepIds: readonly string[]): PlanRecord | undefined {
    const index = this.plansValue.findIndex((plan) => plan.id === planId);
    if (index < 0) return undefined;
    const existing = this.plansValue[index];
    if (!existing) return undefined;
    const byId = new Map(existing.steps.map((step) => [step.id, step]));
    const ordered: PlanStepRecord[] = [];
    for (const id of stepIds) {
      const step = byId.get(id);
      if (!step) continue;
      ordered.push(step);
      byId.delete(id);
    }
    for (const step of existing.steps) {
      if (byId.has(step.id)) ordered.push(step);
    }
    const updated: PlanRecord = {
      ...existing,
      steps: reindexSteps(ordered),
      version: existing.version + 1,
      updatedAt: this.now(),
      source: "user",
    };
    this.plansValue[index] = updated;
    this.dirty = true;
    return updated;
  }

  addClarification(planId: string, question: string): PlanRecord | undefined {
    const index = this.plansValue.findIndex((plan) => plan.id === planId);
    if (index < 0) return undefined;
    const existing = this.plansValue[index];
    if (!existing) return undefined;
    const trimmed = question.trim();
    if (trimmed === "") return undefined;
    const item: PlanClarification = {
      id: createClarificationId(),
      question: trimmed,
      askedAt: this.now(),
    };
    const updated: PlanRecord = {
      ...existing,
      clarifications: [...(existing.clarifications ?? []), item],
      version: existing.version + 1,
      updatedAt: this.now(),
    };
    this.plansValue[index] = updated;
    this.dirty = true;
    return updated;
  }

  answerClarification(planId: string, clarificationId: string, answer: string): PlanRecord | undefined {
    const index = this.plansValue.findIndex((plan) => plan.id === planId);
    if (index < 0) return undefined;
    const existing = this.plansValue[index];
    if (!existing?.clarifications) return undefined;
    const clarifications = existing.clarifications.map((item) =>
      item.id === clarificationId ? { ...item, answer: answer.trim() } : item,
    );
    if (!clarifications.some((item) => item.id === clarificationId)) return undefined;
    const updated: PlanRecord = {
      ...existing,
      clarifications,
      version: existing.version + 1,
      updatedAt: this.now(),
    };
    this.plansValue[index] = updated;
    this.dirty = true;
    return updated;
  }

  /** 用户手写空计划草稿。 */
  createDraft(sessionId: string, title = "实施计划"): PlanRecord {
    const timestamp = this.now();
    return {
      id: createPlanId(),
      sessionId,
      version: 1,
      title,
      steps: [],
      files: [],
      risks: [],
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
      source: "user",
    };
  }

  clear(): void {
    this.plansValue = [];
    this.dirty = true;
  }

  flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const plans = this.plansValue.map(sanitizePlan);
      await this.store.write(this.file, "plans", { plans });
    });
    return this.queue;
  }
}
