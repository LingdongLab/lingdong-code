import type { PlanRecord, PlanStepRecord } from "./storage/plan-repository";

/**
 * 计划的逐步门控。
 *
 * 以前推进只靠提示词里一句「逐步完成」：模型可以一口气把十步全做完，
 * 也可以做完第一步就宣布收工，宿主完全没有话语权。这里把节奏权拿回来——
 * 一轮只下发一步，轮次收尾后由宿主决定下一步是什么。
 *
 * 全是纯函数：谁是下一步、提示词长什么样、这一轮该记成什么状态，
 * 都可以脱离 VS Code 与 Runtime 单测。
 */

/** 参与执行的步骤：被取消或跳过的不算。 */
export function runnableSteps(plan: PlanRecord): PlanStepRecord[] {
  return plan.steps
    .filter((step) => step.status !== "cancelled" && step.status !== "skipped")
    .filter((step) => step.title.trim() !== "");
}

/**
 * 下一个该下发的步骤。
 *
 * in_progress 优先：上一轮下发过但没走完（失败、被停、扩展重启），
 * 应该接着做那一步，而不是跳过去做下一步。
 */
export function nextStep(plan: PlanRecord): PlanStepRecord | undefined {
  const steps = runnableSteps(plan);
  return steps.find((step) => step.status === "in_progress")
    ?? steps.find((step) => step.status === "pending" || step.status === "failed");
}

/** 全部可执行步骤都已完成。 */
export function planFinished(plan: PlanRecord): boolean {
  const steps = runnableSteps(plan);
  return steps.length > 0 && steps.every((step) => step.status === "completed");
}

export interface StepProgress {
  /** 这一步在可执行步骤里的序号，从 1 开始。 */
  index: number;
  total: number;
  completed: number;
}

export function stepProgress(plan: PlanRecord, step: PlanStepRecord): StepProgress {
  const steps = runnableSteps(plan);
  return {
    index: steps.findIndex((item) => item.id === step.id) + 1,
    total: steps.length,
    completed: steps.filter((item) => item.status === "completed").length,
  };
}

/**
 * 单步提示词。
 *
 * 三件事必须写清楚：
 * - 只做这一步（否则门控就白做了，模型会顺手把后面几步一起干掉）；
 * - 已完成的步骤别重做；
 * - 这一步做完就停下来汇报，把下一步的下发权留给宿主。
 */
export function compileStepPrompt(plan: PlanRecord, step: PlanStepRecord): string {
  const progress = stepProgress(plan, step);
  const done = runnableSteps(plan)
    .filter((item) => item.status === "completed")
    .map((item) => `- ${item.title}`)
    .join("\n");
  const files = step.files.length > 0 ? step.files.join("、") : "";
  const retry = step.status === "failed" || step.status === "in_progress";

  return [
    `按已批准的计划《${plan.title}》执行第 ${progress.index}/${progress.total} 步${retry ? "（上一轮没走完，继续这一步）" : ""}：`,
    "",
    `## 第 ${progress.index} 步：${step.title}`,
    step.description ? step.description : undefined,
    files ? `涉及文件：${files}` : undefined,
    "",
    done ? `## 已完成的步骤（不要重做）\n${done}` : undefined,
    done ? "" : undefined,
    "## 执行要求",
    "- 只做这一步，不要提前动后面的步骤。",
    "- 改动尽量限制在这一步声明的文件范围内。",
    "- 做完就停下来，用一两句话说清这一步的结果；下一步会由我再发给你。",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** 一轮收尾后这一步该记成什么状态。 */
export type StepOutcome = "completed" | "failed" | "pending";

/**
 * 轮次结果 → 步骤状态。
 *
 * stopped 记回 pending 而不是 failed：用户主动停下来不是这一步做错了，
 * 下次继续时应该原样重来，而不是背着一个「失败」的标签。
 */
export function stepOutcome(turn: "completed" | "failed" | "stopped"): StepOutcome {
  if (turn === "completed") return "completed";
  return turn === "failed" ? "failed" : "pending";
}

/** 逐步推进的下一动作。 */
export type GateAction =
  /** 下发这一步。 */
  | { kind: "dispatch"; step: PlanStepRecord; prompt: string; progress: StepProgress }
  /** 全部步骤已完成。 */
  | { kind: "finished" }
  /** 没有可执行步骤，或者计划已经不在执行态。 */
  | { kind: "idle" };

/** 根据当前计划算出下一动作。计划状态不对时一律 idle，不自作主张开跑。 */
export function planGateAction(plan: PlanRecord | undefined): GateAction {
  if (!plan) return { kind: "idle" };
  if (plan.status !== "approved" && plan.status !== "executing") return { kind: "idle" };
  const step = nextStep(plan);
  if (!step) return planFinished(plan) ? { kind: "finished" } : { kind: "idle" };
  return {
    kind: "dispatch",
    step,
    prompt: compileStepPrompt(plan, step),
    progress: stepProgress(plan, step),
  };
}
