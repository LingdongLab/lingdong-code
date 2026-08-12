import type { PlanStepRecord, PlanStepStatus } from "./storage/plan-repository";

/**
 * 执行期 todo 更新 → PlanRecord 步骤状态的映射。
 * Grok 构建时推送的 todo 清单与审批时落盘的步骤是两份数据，
 * 这里按「标题归一匹配 + 序号兜底」对齐，让计划文档里的步骤随执行打勾。
 */

export interface ExecutingStepUpdate {
  index: number;
  title: string;
  status?: string | undefined;
}

export interface StepStatusPatch {
  stepId: string;
  status: PlanStepStatus;
}

/** 状态只推进不回退：回放旧快照或模型漏报 pending 时不能把已完成的勾抹掉。 */
const STATUS_RANK: Record<PlanStepStatus, number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
  skipped: 2,
};

/** 归一化标题：大小写、空白与标点全部抹平，容忍模型复述时的微小改写。 */
export function normalizeStepTitle(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function toRecordStatus(status: string | undefined): PlanStepStatus | undefined {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      // pending 或未知状态不产生推进，交给 STATUS_RANK 的「只进不退」兜底。
      return undefined;
  }
}

export function diffExecutingSteps(
  recordSteps: readonly PlanStepRecord[],
  updates: readonly ExecutingStepUpdate[],
): StepStatusPatch[] {
  const byTitle = new Map<string, PlanStepRecord[]>();
  for (const step of recordSteps) {
    const key = normalizeStepTitle(step.title);
    if (!key) continue;
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(step);
    else byTitle.set(key, [step]);
  }
  const byOrder = new Map(recordSteps.map((step) => [step.order, step]));
  const sameLength = recordSteps.length === updates.length;

  const patches: StepStatusPatch[] = [];
  const claimed = new Set<string>();
  updates.forEach((update, position) => {
    const status = toRecordStatus(update.status);
    if (!status) return;

    let target = byTitle.get(normalizeStepTitle(update.title))?.find((step) => !claimed.has(step.id));
    if (!target) {
      const ordered = byOrder.get(update.index);
      if (ordered && !claimed.has(ordered.id)) target = ordered;
    }
    if (!target && sameLength) {
      const positional = recordSteps[position];
      if (positional && !claimed.has(positional.id)) target = positional;
    }
    if (!target) return;

    claimed.add(target.id);
    if (STATUS_RANK[status] <= STATUS_RANK[target.status]) return;
    patches.push({ stepId: target.id, status });
  });
  return patches;
}
