import { Buffer } from "node:buffer";
import path from "node:path";
import type { AgentPlan, AgentRuntimeHandle } from "@lingdong/agent-runtime";
import type { FileSystemPort } from "../file-system-port";
import { findGrokSessionPlanPath, grokSessionPlanPath } from "../grok-plan-path";
import type { HostToWebviewMessage, PlanEditPayload, UiAgentMode } from "../messages";
import { compilePlanBuildPrompt, planHasExecutableContent } from "../plan-build";
import { planFinished, planGateAction, runnableSteps, stepOutcome } from "../plan-gate";
import { reconcilePlanStepsFromMarkdown } from "../plan-steps-from-markdown";
import { diffExecutingSteps } from "../plan-step-sync";
import {
  assertPlanPathSafe,
  planMarkdownRelativePath,
  toPlanMarkdown,
} from "../plan-markdown";
import { toPlanCard, type PlanStatus } from "../plan-view-model";
import type { SessionPersistence } from "../session-persistence";
import type { PlanRecord } from "../storage/plan-repository";
import type { UiStateMachine } from "../ui-state";
import type { AgentWorkspaceStore } from "../workspace-store";
import type { TurnState } from "./turn-state";

/**
 * 计划编排：读写 PlanRecord、编辑步骤、开始/暂停/继续构建。
 * UI 侧 PlanRecord 与 Grok 会话目录下的 plan.md 必须双写，否则 Agent 再读仍是旧稿。
 */

export interface PlanFacadeDeps {
  post(message: HostToWebviewMessage): void;
  postState(detail?: string): void;
  postModeState(serverMode?: string): void;
  readonly ui: UiStateMachine;
  readonly store: AgentWorkspaceStore;
  readonly turn: TurnState;
  readonly fs: FileSystemPort;
  workspaceRoot(): string | undefined;
  /** 当前 Runtime 使用的 GROK_HOME（托管目录或探测目录）。 */
  grokHome(): string | undefined;
  /** 当前会话绑定的 Grok session id，用来定位 plan.md。 */
  grokSessionId(): string | undefined;
  ensureStorage(): Promise<void>;
  persistence(): SessionPersistence | undefined;
  flushPersistence(): Promise<void>;
  activeSessionId(): string | undefined;
  setActiveSession(record: { id: string }): void;
  runtime(): AgentRuntimeHandle | undefined;
  setMode(mode: UiAgentMode): Promise<void>;
  /** 批准计划后直接把本地模式记为 agent，不再回写 Runtime。 */
  forceMode(mode: UiAgentMode): void;
  sendPrompt(text: string, options: { skipIntentCheck?: boolean }): Promise<void>;
  stop(): Promise<void>;
  /**
   * 当前是否有在飞的轮次。
   * 批准即开跑要靠它区分「等本轮收尾再补发」和「现在就没有轮次，直接开跑」。
   */
  turnPending(): boolean;
  /**
   * 是否由宿主逐步下发计划步骤。
   * 关掉就退回「整份计划一次性发出去」的老行为，用于对照与兜底。
   */
  stepGating(): boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** UI 只接受工作区相对路径，绝对盘符路径一律丢弃。 */
function sanitizePaths(files: string[]): string[] {
  return files
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => !/^[A-Za-z]:/.test(file));
}

export class PlanFacade {
  /**
   * 已批准、等着自动开跑的计划 id。
   * 只有 approve 会布防，撤防有三处：模型自己动起来了、本轮非正常收尾、补发完成。
   */
  private autoBuildPlanId: string | undefined;
  /**
   * 门控下发出去、正在跑的那一步。
   * 轮次收尾时靠它把结果记回对应步骤——模型自己报的进度不可信。
   */
  private gatedStepId: string | undefined;
  /**
   * 逐步门控接管后、等着开跑第一步的计划 id。
   *
   * 批准时 Grok 还卡在 exit_plan_mode 的回执上，此刻发提示词只会进排队，
   * 所以要等这一轮真正收尾。与 autoBuildPlanId 是互斥的两条路：
   * 那条整份计划一次性发，这条一步一步发。
   */
  private gatedStartPlanId: string | undefined;

  constructor(private readonly deps: PlanFacadeDeps) {}

  get active(): PlanRecord | undefined {
    return this.deps.persistence()?.plans.active;
  }

  setStatusMessage(status: PlanStatus, message: string): void {
    this.deps.post({ type: "planStatus", status, message });
  }

  publishActive(): void {
    const plan = this.deps.persistence()?.plans.active;
    this.deps.store.setActivePlan(plan);
    if (!plan) return;
    this.deps.post({ type: "planRecord", plan });
    if (plan.clarifications?.length) {
      this.deps.post({ type: "clarifications", items: plan.clarifications });
    }
  }

  /** 导出计划为工作区内的 Markdown；路径越界一律拒写。 */
  async saveToWorkspace(): Promise<void> {
    await this.deps.ensureStorage();
    const plans = this.deps.persistence()?.plans;
    const root = this.deps.workspaceRoot();
    const plan = plans?.active ?? plans?.plans.at(-1);
    if (!plans || !root || !plan) {
      this.deps.post({ type: "notice", level: "warn", message: "当前没有可保存的计划。" });
      return;
    }
    const relative = planMarkdownRelativePath(plan);
    const absolute = assertPlanPathSafe(root, relative);
    if (!absolute) {
      this.deps.post({ type: "notice", level: "warn", message: "计划保存路径非法，已拒绝写入。" });
      return;
    }
    try {
      await this.deps.fs.write(absolute, Buffer.from(`${toPlanMarkdown(plan)}\n`, "utf8"));
      this.deps.post({ type: "notice", level: "info", message: `计划已保存到 ${relative}` });
    } catch (error) {
      this.deps.post({ type: "error", message: `保存计划失败：${errorText(error)}`, recoverable: true });
    }
  }

  async saveEdits(payload: PlanEditPayload): Promise<void> {
    await this.deps.ensureStorage();
    const plans = this.deps.persistence()?.plans;
    if (!plans) return;
    // 审批卡尚未推送 planRecord 时，webview 会用占位 id「plan-card」；落到当前活动计划。
    let plan = payload.planId !== "plan-card"
      ? plans.plans.find((item) => item.id === payload.planId)
      : undefined;
    if (!plan) plan = plans.active;
    if (!plan) {
      this.deps.post({ type: "notice", level: "warn", message: "找不到要编辑的计划。" });
      return;
    }
    const planId = plan.id;
    plans.updateMeta(planId, {
      title: payload.title,
      ...(payload.goal !== undefined ? { goal: payload.goal } : {}),
      files: sanitizePaths(payload.files),
      risks: payload.risks,
      ...(payload.raw !== undefined ? { raw: payload.raw } : {}),
    });

    // 宿主再收敛一次：防止旧 webview 只带 raw、steps 仍是删段前的快照。
    const incomingSteps = payload.raw !== undefined
      ? reconcilePlanStepsFromMarkdown(payload.raw, payload.steps.length > 0
        ? payload.steps
        : plan.steps)
      : payload.steps;

    const existingIds = new Set(plan.steps.map((step) => step.id));
    const keep = new Set(incomingSteps.map((step) => step.id).filter((id): id is string => !!id));
    for (const step of plan.steps) {
      if (!keep.has(step.id)) plans.removeStep(planId, step.id);
    }
    plan = plans.plans.find((item) => item.id === planId);
    if (!plan) return;

    const orderedIds: string[] = [];
    for (const [index, step] of incomingSteps.entries()) {
      const files = sanitizePaths(step.files);
      if (step.id && existingIds.has(step.id)) {
        plans.updateStep(planId, step.id, {
          title: step.title,
          ...(step.description !== undefined ? { description: step.description } : {}),
          files,
        });
        orderedIds.push(step.id);
        continue;
      }
      const before = new Set(
        (plans.plans.find((item) => item.id === planId)?.steps ?? []).map((s) => s.id),
      );
      plans.addStep(planId, {
        title: step.title,
        ...(step.description !== undefined ? { description: step.description } : {}),
        files,
        at: index,
      });
      const added = plans.plans
        .find((item) => item.id === planId)
        ?.steps.find((s) => !before.has(s.id));
      if (added) orderedIds.push(added.id);
    }
    if (orderedIds.length > 0) plans.reorderSteps(planId, orderedIds);

    for (const item of payload.clarifications ?? []) {
      const question = item.question.trim();
      if (!question) continue;
      if (item.id && !item.id.startsWith("ask-local-")) {
        if (item.answer !== undefined) plans.answerClarification(planId, item.id, item.answer);
        continue;
      }
      const created = plans.addClarification(planId, question);
      const last = created?.clarifications?.at(-1);
      if (last && item.answer?.trim()) plans.answerClarification(planId, last.id, item.answer);
    }

    await this.deps.flushPersistence();
    this.publishActive();
    // 同步回写 Grok 的 plan.md，否则对话里 Agent 再 Read 仍是旧五段。
    if (payload.raw !== undefined) {
      await this.syncGrokPlanMarkdown(payload.raw);
    }
    this.deps.post({ type: "notice", level: "info", message: "计划已保存。" });
  }

  /** 把 UI 编辑后的正文写进当前 Grok 会话的 plan.md。 */
  private async syncGrokPlanMarkdown(raw: string): Promise<void> {
    const text = raw.trimEnd() ? `${raw.trimEnd()}\n` : "";
    if (!text) return;
    const grokHome = this.deps.grokHome()?.trim();
    const grokSessionId = this.deps.grokSessionId()?.trim();
    const workspaceRoot = this.deps.workspaceRoot()?.trim();
    if (!grokHome || !grokSessionId) return;

    try {
      const existing = await findGrokSessionPlanPath({
        grokHome,
        grokSessionId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        exists: (absolutePath) => this.deps.fs.exists(absolutePath),
        listEntries: (directory) => this.deps.fs.listEntries(directory),
      });
      const target = existing ?? (workspaceRoot
        ? grokSessionPlanPath({ grokHome, workspaceRoot, grokSessionId })
        : undefined);
      if (!target) {
        this.deps.post({
          type: "notice",
          level: "warn",
          message: "计划已写入本地，但未找到 Grok 的 plan.md，对话里可能仍看到旧内容。",
        });
        return;
      }
      await this.deps.fs.ensureDirectory(path.dirname(target));
      await this.deps.fs.write(target, Buffer.from(text, "utf8"));
    } catch (error) {
      this.deps.post({
        type: "notice",
        level: "warn",
        message: `计划已写入本地，同步 plan.md 失败：${errorText(error)}`,
      });
    }
  }

  async addStep(title: string, description?: string): Promise<void> {
    const plan = await this.ensureEditable();
    if (!plan) return;
    this.deps.persistence()?.plans.addStep(plan.id, {
      title,
      ...(description !== undefined ? { description } : {}),
    });
    await this.deps.flushPersistence();
    this.publishActive();
  }

  async removeStep(stepId: string): Promise<void> {
    const plan = this.deps.persistence()?.plans.active ?? this.deps.store.snapshot.activePlan;
    if (!plan) return;
    this.deps.persistence()?.plans.removeStep(plan.id, stepId);
    await this.deps.flushPersistence();
    this.publishActive();
  }

  /**
   * 结构化编辑单个步骤：只动这一步的标题/说明/文件，不碰计划正文。
   *
   * 与 saveEdits 分开是有意的：saveEdits 会按正文的章节反向收敛步骤清单，
   * 结构化编辑要是也走那条路，刚拖好的顺序和刚改的标题会被正文里的旧标题吃回去。
   */
  async updateStep(
    stepId: string,
    patch: { title: string; description?: string; files?: string[] },
  ): Promise<void> {
    const plans = this.deps.persistence()?.plans;
    const plan = plans?.active;
    if (!plans || !plan) return;
    if (!plan.steps.some((step) => step.id === stepId)) return;
    plans.updateStep(plan.id, stepId, {
      title: patch.title,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.files ? { files: sanitizePaths(patch.files) } : {}),
    });
    await this.deps.flushPersistence();
    this.publishActive();
  }

  /**
   * 步骤勾选。
   *
   * 取消勾选记成 skipped 而不是删掉：用户往往只是这次不想做它，
   * 正文里那一条还该看得见、随时能勾回来。已完成或正在跑的步骤不许改，
   * 否则会把「已经做过」这个事实一起抹掉。
   */
  async setStepIncluded(stepId: string, included: boolean): Promise<void> {
    const plans = this.deps.persistence()?.plans;
    const plan = plans?.active;
    if (!plans || !plan) return;
    const step = plan.steps.find((item) => item.id === stepId);
    if (!step) return;
    if (step.status === "completed" || step.status === "in_progress") {
      this.deps.post({
        type: "notice",
        level: "info",
        message: step.status === "completed" ? "这一步已经做完了。" : "这一步正在执行中。",
      });
      return;
    }
    plans.updateStep(plan.id, stepId, { status: included ? "pending" : "skipped" });
    await this.deps.flushPersistence();
    this.publishActive();
  }

  async reorderSteps(stepIds: string[]): Promise<void> {
    const plan = this.deps.persistence()?.plans.active ?? this.deps.store.snapshot.activePlan;
    if (!plan) return;
    this.deps.persistence()?.plans.reorderSteps(plan.id, stepIds);
    await this.deps.flushPersistence();
    this.publishActive();
  }

  async answerClarification(clarificationId: string, answer: string): Promise<void> {
    const plan = this.deps.persistence()?.plans.active;
    if (!plan) return;
    this.deps.persistence()?.plans.answerClarification(plan.id, clarificationId, answer);
    await this.deps.flushPersistence();
    this.publishActive();
  }

  discardEdits(): void {
    this.publishActive();
    this.deps.post({ type: "notice", level: "info", message: "已放弃未保存的计划编辑。" });
  }

  async startBuild(): Promise<void> {
    await this.deps.ensureStorage();
    const plan = this.deps.persistence()?.plans.active;
    if (!plan || !planHasExecutableContent(plan)) {
      this.deps.post({ type: "notice", level: "warn", message: "计划为空，无法开始构建。" });
      return;
    }
    this.deps.persistence()?.plans.setStatus(plan.id, "executing");
    await this.deps.flushPersistence();
    this.publishActive();
    await this.deps.setMode("agent");
    await this.dispatchNextStep({ resume: false });
  }

  /**
   * 下发一步。
   *
   * 门控开着就一轮只发一步，收尾后由 advanceGate 决定下一步；关掉则退回原来那种
   * 「整份计划一次性发出去 + 提示词里请它逐步完成」的软性推进。
   */
  private async dispatchNextStep(options: { resume: boolean }): Promise<void> {
    const plans = this.deps.persistence()?.plans;
    const plan = plans?.active;
    if (!plans || !plan) return;

    if (!this.deps.stepGating()) {
      await this.deps.sendPrompt(compilePlanBuildPrompt(plan, { resume: options.resume }), {
        skipIntentCheck: true,
      });
      return;
    }

    const action = planGateAction(plan);
    if (action.kind === "finished") {
      await this.finishPlan(plan.id);
      return;
    }
    if (action.kind === "idle") return;

    // 先落 in_progress 再发：这一步的归属在提示词出门之前就必须写下来，
    // 否则轮次收尾时分不清刚才跑的是哪一步。
    plans.updateStep(plan.id, action.step.id, { status: "in_progress" });
    await this.deps.flushPersistence();
    this.publishActive();
    this.gatedStepId = action.step.id;
    this.setStatusMessage(
      "executing",
      `正在执行第 ${action.progress.index}/${action.progress.total} 步：${action.step.title}`,
    );
    await this.deps.sendPrompt(action.prompt, { skipIntentCheck: true });
  }

  /**
   * 一轮收尾后推进门控：给刚跑完那一步记状态，然后决定要不要发下一步。
   *
   * 失败与被停都不自动往下走——继续往下做只会把错误累积到后面几步里，
   * 用户需要的是停在原地看清楚发生了什么。
   */
  private async advanceGate(status: "completed" | "failed" | "stopped"): Promise<void> {
    const stepId = this.gatedStepId;
    if (!stepId) return;
    this.gatedStepId = undefined;

    const plans = this.deps.persistence()?.plans;
    const plan = plans?.active;
    if (!plans || !plan) return;
    if (!plan.steps.some((step) => step.id === stepId)) return;

    plans.updateStep(plan.id, stepId, { status: stepOutcome(status) });
    await this.deps.flushPersistence();
    this.publishActive();

    if (status !== "completed") {
      plans.setStatus(plan.id, "paused");
      await this.deps.flushPersistence();
      this.publishActive();
      // 暂停不是 PlanStatus 里的状态（那套是审批态），所以走 notice，
      // 与手动「暂停构建」保持同一种提示方式。
      this.deps.post({
        type: "notice",
        level: status === "failed" ? "warn" : "info",
        message: status === "failed"
          ? "这一步没跑通，计划已暂停在当前步骤。修完可以点「继续构建」。"
          : "计划已暂停在当前步骤，点「继续构建」可以接着做。",
      });
      return;
    }

    const latest = plans.active;
    if (!latest) return;
    if (planFinished(latest)) {
      await this.finishPlan(latest.id);
      return;
    }
    await this.dispatchNextStep({ resume: true });
  }

  private async finishPlan(planId: string): Promise<void> {
    const plans = this.deps.persistence()?.plans;
    if (!plans) return;
    plans.setStatus(planId, "completed");
    await this.deps.flushPersistence();
    this.publishActive();
    this.setStatusMessage("completed", "计划的所有步骤都已完成。");
  }

  async pauseBuild(): Promise<void> {
    const plan = this.deps.persistence()?.plans.active;
    if (!plan) return;
    if (this.deps.ui.busy) await this.deps.stop();
    this.deps.persistence()?.plans.setStatus(plan.id, "paused");
    await this.deps.flushPersistence();
    this.publishActive();
    this.deps.post({ type: "notice", level: "info", message: "计划已暂停。" });
  }

  async resumeBuild(): Promise<void> {
    await this.deps.ensureStorage();
    const plans = this.deps.persistence()?.plans;
    const plan = plans?.plans.find((item) => item.status === "paused") ?? plans?.active;
    if (!plan) {
      this.deps.post({ type: "notice", level: "warn", message: "没有可继续的计划。" });
      return;
    }
    plans?.setStatus(plan.id, "executing");
    await this.deps.flushPersistence();
    this.publishActive();
    await this.deps.setMode("agent");
    await this.dispatchNextStep({ resume: true });
  }

  // ---------------------------------------------------------------------------
  // Runtime 侧的计划审批
  // ---------------------------------------------------------------------------

  /** Runtime 请求审批计划：落一份 PlanRecord，并把 UI 切到等待审批。 */
  handleReviewRequested(plan: Parameters<typeof toPlanCard>[0]): void {
    this.deps.turn.pendingPlan = true;
    const card = toPlanCard(plan, "ready");
    this.deps.post({ type: "plan", plan: card });
    const persistence = this.deps.persistence();
    const sessionId = this.deps.activeSessionId();
    if (sessionId && persistence) {
      const record = persistence.plans.createFromCard(sessionId, card, "waiting_review");
      persistence.plans.upsert(record);
      void persistence.sessions
        .patch(sessionId, { activePlanId: record.id, hasUnfinishedPlan: true })
        .then((next) => { if (next) this.deps.setActiveSession(next); })
        .catch((error: unknown) => this.deps.post({
          type: "notice",
          level: "warn",
          message: `计划已生成，但没能关联到当前会话：${errorText(error)}`,
        }));
      void this.deps.flushPersistence();
      // 必须推 planRecord：否则 webview 只有 plan-card 占位 id，保存会丢。
      this.publishActive();
    }
    this.deps.ui.transition("waiting_plan_approval");
    this.deps.postState();
  }

  /**
   * 执行期 todo 更新写回计划步骤：标题归一匹配 + 序号兜底，只推进不回退。
   * 只作用于已批准/执行中的计划，避免把模型研究期的临时清单错写进待审批的计划。
   */
  handleExecutingUpdate(plan: AgentPlan): void {
    const plans = this.deps.persistence()?.plans;
    const record = plans?.active;
    if (!plans || !record) return;
    if (record.status !== "approved" && record.status !== "executing") return;

    // 执行期 todo 标题/数量变化时，把清单对齐进 PlanRecord，Tasks 才能实时跟上。
    const liveTitles = plan.steps.map((step) => step.title.trim()).filter(Boolean);
    const recordTitles = record.steps.map((step) => step.title.trim());
    const structureChanged = liveTitles.length > 0 && (
      liveTitles.length !== recordTitles.length
      || liveTitles.some((title, index) => title !== recordTitles[index])
    );
    if (structureChanged) {
      const reconciled = reconcilePlanStepsFromMarkdown(
        liveTitles.map((title, index) => `${index + 1}. ${title}`).join("\n"),
        record.steps,
      );
      // 若归一后仍对不上长度，直接按 live todo 重建 pending 清单（保留已匹配 id）。
      const nextSteps = reconciled.length === liveTitles.length
        ? reconciled
        : liveTitles.map((title, index) => {
          const matched = record.steps.find((step) => step.title.trim() === title);
          return {
            ...(matched ? { id: matched.id } : {}),
            title,
            files: matched?.files ?? plan.steps[index]?.files ?? [],
          };
        });
      const existingIds = new Set(record.steps.map((step) => step.id));
      const keep = new Set(nextSteps.map((step) => step.id).filter((id): id is string => !!id));
      for (const step of record.steps) {
        if (!keep.has(step.id)) plans.removeStep(record.id, step.id);
      }
      const orderedIds: string[] = [];
      for (const [index, step] of nextSteps.entries()) {
        if (step.id && existingIds.has(step.id)) {
          plans.updateStep(record.id, step.id, { title: step.title, files: sanitizePaths(step.files) });
          orderedIds.push(step.id);
          continue;
        }
        const before = new Set(
          (plans.plans.find((item) => item.id === record.id)?.steps ?? []).map((s) => s.id),
        );
        plans.addStep(record.id, { title: step.title, files: sanitizePaths(step.files), at: index });
        const added = plans.plans
          .find((item) => item.id === record.id)
          ?.steps.find((s) => !before.has(s.id));
        if (added) orderedIds.push(added.id);
      }
      if (orderedIds.length > 0) plans.reorderSteps(record.id, orderedIds);
    }

    const latest = plans.plans.find((item) => item.id === record.id) ?? record;
    const patches = diffExecutingSteps(latest.steps, plan.steps);
    if (patches.length === 0 && !structureChanged) return;
    for (const patch of patches) {
      plans.updateStep(record.id, patch.stepId, { status: patch.status });
    }
    // 步骤状态真的在动，说明模型批准之后自己就接着干了。
    // 这时候再补一遍构建提示词等于让它把活儿重做一遍，撤防。
    if (patches.length > 0 && this.autoBuildPlanId === record.id) this.autoBuildPlanId = undefined;
    if (record.status === "approved") plans.setStatus(record.id, "executing");
    void this.deps.flushPersistence();
    this.publishActive();
  }

  handleReviewClosed(): void {
    this.deps.turn.pendingPlan = false;
    if (this.deps.ui.state !== "waiting_plan_approval") return;
    this.deps.ui.transition("streaming");
    this.deps.postState();
  }

  /**
   * 批准计划，并且直接开跑。
   *
   * 以前批准只是回一个 `approved` 给 Runtime，用户还得自己找到右侧文档再点一次
   * 「开始构建」——中间那段停顿看起来就像卡住了。现在批准之后自动补上构建提示词。
   *
   * 之所以不在这里同步发提示词：批准发生在一轮任务的中途（模型正等着
   * exit_plan_mode 的回复），此刻 UI 是 busy 的，发出去只会进排队。
   * 所以改成「布防 + 等本轮收尾」：
   * - 模型自己在同一轮里就开始干了（有 plan_updated 进来）→ 撤防，不补发，
   *   否则等于让它把活儿重做一遍；
   * - 本轮干干净净地结束了 → onTurnSettled 补发构建提示词；
   * - 本轮失败或被用户停掉 → 撤防，不自作主张继续。
   */
  async approve(): Promise<void> {
    // 逐步门控只有在真有步骤可发时才接管；步骤为空就退回让 Grok 自己跑完，
    // 否则批准之后什么都不会发生，看着就是点了没反应。
    const plan = this.deps.persistence()?.plans.active;
    const stepwise = this.deps.stepGating() && !!plan && runnableSteps(plan).length > 0;

    const approved = await this.runAction("approve", async (runtime) => {
      if (stepwise) await runtime.approvePlanStepwise();
      else await runtime.approvePlan();
      this.deps.forceMode("agent");
      this.setStatusMessage("approved", "计划已批准，开始执行。");
      this.persistStatus("approved");
      this.deps.postModeState();
      const planId = this.deps.persistence()?.plans.active?.id;
      if (stepwise) this.gatedStartPlanId = planId;
      else this.autoBuildPlanId = planId;
    });
    if (!approved) return;
    if (stepwise) {
      this.deps.post({
        type: "notice",
        level: "info",
        message: "计划已批准。将按步骤逐条执行，每步结束后再继续下一步。",
      });
    }
    // 没有在飞的轮次（例如从历史里翻出来的审批卡）：没有「收尾」可等，直接开跑。
    if (!this.deps.turnPending()) {
      if (stepwise) await this.flushGatedStart();
      else await this.flushAutoBuild();
    }
  }

  /**
   * 门控接管后开跑第一步。
   *
   * 收 completed 与 stopped 两种：回了 abandoned 之后 Grok 有可能把这一轮
   * 报成正常结束，也有可能报成被取消，两者都属于「我们自己造出来的收尾」。
   * failed 不接——那说明这一轮真出了问题，硬发第一步只会把错误带下去。
   */
  private async flushGatedStart(): Promise<void> {
    const planId = this.gatedStartPlanId;
    if (!planId) return;
    this.gatedStartPlanId = undefined;
    const plan = this.deps.persistence()?.plans.active;
    if (!plan || plan.id !== planId) return;
    if (plan.status !== "approved" && plan.status !== "executing") return;
    await this.startBuild();
  }

  /**
   * 一轮任务收尾。只有正常结束才补发构建提示词——
   * 失败或被停都意味着用户/环境有别的意思，替他继续跑只会添乱。
   */
  async onTurnSettled(status: "completed" | "failed" | "stopped"): Promise<void> {
    // 顺序不能反：advanceGate 结算的是刚跑完的那一步，两个 flush 才是「开始下一段」。
    // 先开跑的话，advanceGate 会把刚发出去、还没跑的那一步当成本轮结果直接判掉。
    await this.advanceGate(status);

    if (status === "failed") {
      this.autoBuildPlanId = undefined;
      this.gatedStartPlanId = undefined;
      return;
    }
    if (status === "stopped") {
      // 整份计划那条路不接受被停；门控接管的第一步例外——
      // 这个 stopped 极可能就是我们回 abandoned 自己造出来的收尾。
      this.autoBuildPlanId = undefined;
      await this.flushGatedStart();
      return;
    }
    await this.flushAutoBuild();
    await this.flushGatedStart();
  }

  /** 补发构建提示词。任何一处对不上就静默撤防，不硬发。 */
  private async flushAutoBuild(): Promise<void> {
    const planId = this.autoBuildPlanId;
    if (!planId) return;
    this.autoBuildPlanId = undefined;
    const plan = this.deps.persistence()?.plans.active;
    if (!plan || plan.id !== planId) return;
    if (plan.status !== "approved" && plan.status !== "executing") return;
    await this.startBuild();
  }

  async reject(): Promise<void> {
    // runAction 的布尔返回值只有 approve 需要（用来决定要不要接着开跑），这里丢掉。
    await this.runAction("reject", async (runtime) => {
      await runtime.rejectPlan();
      this.setStatusMessage("abandoned", "已放弃该计划。");
      this.persistStatus("abandoned");
    });
  }

  async revise(feedback: string): Promise<void> {
    await this.runAction("revise", async (runtime) => {
      await runtime.revisePlan(feedback);
      this.setStatusMessage("revising", "已请求修改计划。");
    });
  }

  private persistStatus(status: "approved" | "abandoned"): void {
    const persistence = this.deps.persistence();
    const planId = persistence?.plans.active?.id;
    if (planId) persistence?.plans.setStatus(planId, status);
    void this.deps.flushPersistence();
    this.publishActive();
  }

  /** @returns 动作是否真的执行成功；调用方据此决定要不要接着做后续动作。 */
  private async runAction(
    action: "approve" | "reject" | "revise",
    run: (runtime: AgentRuntimeHandle) => Promise<void>,
  ): Promise<boolean> {
    if (!this.deps.ui.canApprovePlan || !this.deps.turn.pendingPlan) {
      this.deps.post({ type: "notice", level: "warn", message: "当前没有待审批的计划。" });
      return false;
    }
    const runtime = this.deps.runtime();
    if (!runtime) return false;
    this.deps.turn.pendingPlan = false;
    try {
      await run(runtime);
    } catch (error) {
      this.deps.turn.pendingPlan = true;
      this.autoBuildPlanId = undefined;
      this.deps.post({
        type: "error",
        message: `计划操作失败（${action}）：${errorText(error)}`,
        recoverable: true,
      });
      return false;
    }
    if (this.deps.ui.state === "waiting_plan_approval") this.deps.ui.transition("streaming");
    this.deps.postState();
    return true;
  }

  /** 没有活动计划时创建一份草稿，供直接编辑步骤使用。 */
  private async ensureEditable(): Promise<PlanRecord | undefined> {
    await this.deps.ensureStorage();
    const persistence = this.deps.persistence();
    const sessionId = this.deps.activeSessionId();
    if (!persistence || !sessionId) {
      this.deps.post({ type: "notice", level: "warn", message: "请先打开会话再编辑计划。" });
      return undefined;
    }
    const existing = persistence.plans.active;
    if (existing) return existing;
    const plan = persistence.plans.createDraft(sessionId);
    persistence.plans.upsert(plan);
    await persistence.sessions.patch(sessionId, { activePlanId: plan.id, hasUnfinishedPlan: true });
    await this.deps.flushPersistence();
    return plan;
  }
}
