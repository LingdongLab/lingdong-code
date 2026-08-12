/**
 * 结构化步骤编辑 → 一串最小操作。
 *
 * 步骤编辑器手上是「整份新列表」，而宿主侧只有增/删/改/重排这几个粒度动作。
 * 直接把整份列表当 savePlanEdits 发出去有两个问题：一是会连带覆盖计划正文，
 * 二是正文里的步骤会被 markdown 反向收敛回来，把刚做的结构化改动吃掉。
 * 所以这里把「前后两份列表」翻译成明确的操作序列，让结构化编辑与文档正文各改各的。
 *
 * 纯函数，不碰 DOM 也不碰 vscode。
 */

export interface StepSnapshot {
  id: string;
  title: string;
  description: string;
  files: string[];
}

export type PlanStepOp =
  | { kind: "remove"; stepId: string }
  | { kind: "add"; title: string; description?: string }
  | {
      kind: "update";
      stepId: string;
      title: string;
      description: string;
      files: string[];
    }
  /** 期望的完整顺序；只在顺序真的变了时才产生。 */
  | { kind: "reorder"; stepIds: string[] };

/** 本地新建、还没在宿主落过库的步骤 id 前缀。 */
const LOCAL_PREFIXES = ["step-local-", "card-step-"];

export function isLocalStepId(id: string): boolean {
  return LOCAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((file, index) => file === b[index]);
}

/**
 * 算出把 previous 变成 next 需要的操作。
 *
 * 顺序有讲究：先删再加最后重排。删在前是因为留着待删的步骤会让重排的 id 列表对不上；
 * 重排在最后是因为新增的步骤要先存在，才能出现在顺序里。
 *
 * 新增步骤只发标题与说明：它此刻还没有宿主侧的 id，文件等改动等它落库、
 * 下一轮 planRecord 回来之后再走 update。
 */
export function planStepOps(
  previous: readonly StepSnapshot[],
  next: readonly StepSnapshot[],
): PlanStepOp[] {
  const ops: PlanStepOp[] = [];
  const before = new Map(previous.map((step) => [step.id, step]));
  const survivingIds = new Set(next.map((step) => step.id));

  for (const step of previous) {
    if (!survivingIds.has(step.id)) ops.push({ kind: "remove", stepId: step.id });
  }

  for (const step of next) {
    const existing = before.get(step.id);
    if (!existing || isLocalStepId(step.id)) {
      const title = step.title.trim();
      // 空标题的新步骤先不落库：用户往往是先点「新增」再打字。
      if (!title) continue;
      ops.push({
        kind: "add",
        title,
        ...(step.description.trim() ? { description: step.description } : {}),
      });
      continue;
    }
    if (
      existing.title !== step.title
      || existing.description !== step.description
      || !sameFiles(existing.files, step.files)
    ) {
      ops.push({
        kind: "update",
        stepId: step.id,
        title: step.title,
        description: step.description,
        files: [...step.files],
      });
    }
  }

  // 重排只认两边都有的、且非本地的 id；新增的那些等落库后自然排在末尾。
  const persistedNext = next.filter((step) => before.has(step.id) && !isLocalStepId(step.id));
  const persistedBefore = previous.filter((step) => survivingIds.has(step.id) && !isLocalStepId(step.id));
  const nextOrder = persistedNext.map((step) => step.id);
  const beforeOrder = persistedBefore.map((step) => step.id);
  if (nextOrder.length > 1 && !sameFiles(beforeOrder, nextOrder)) {
    ops.push({ kind: "reorder", stepIds: nextOrder });
  }

  return ops;
}
