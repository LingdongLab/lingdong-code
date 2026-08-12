import type { PlanEditPayload } from "../messages";
import { planStepOps, type StepSnapshot } from "../plan-step-ops";
import type { PlanStepRecord } from "../storage/plan-repository";
import type { AppElements, AppState, Post } from "./app-context";
import { el } from "./plan/dom";
import { renderPlanCompactCard } from "./plan/plan-compact-card";
import {
  collectPlanPayloadFromDocument,
  renderPlanDocumentView,
} from "./plan/plan-document-view";
import { buildPlanDocumentViewModel, type PlanStepViewModel } from "./plan/plan-view-model";

/**
 * 计划 UI（对标 Cursor）：
 * - 中间：紧凑卡（标题/进度；审批未决时「开始构建」）
 * - 右侧：渲染态文档直接改（WYSIWYG），底部只留构建 / 放弃 / 有改动时保存
 * - 保存后立刻同步 Tasks（steps 跟 raw 一起收敛）
 */

export interface PlanControllerDeps {
  el: Pick<AppElements, "panelPlan">;
  state: AppState;
  post: Post;
  appendNode(node: HTMLElement): HTMLElement;
  notice(text: string): void;
  fillComposer(text: string): void;
  openPlanTool(): void;
  isPlanToolOpen(): boolean;
  refreshTool(tool: "tasks" | "plan"): void;
}

export class PlanController {
  private card: HTMLElement | undefined;
  private rightRoot: HTMLElement | undefined;

  constructor(private readonly deps: PlanControllerDeps) {}

  get cardElement(): HTMLElement | undefined { return this.card; }

  reset(): void {
    this.card = undefined;
    this.rightRoot = undefined;
    this.deps.state.planEditing = false;
    this.deps.el.panelPlan.replaceChildren();
  }

  patchStatusBadge(label: string): void {
    const centerBadge = this.card?.querySelector(".badge");
    if (centerBadge) centerBadge.textContent = label;
    const rightBadge = this.rightRoot?.querySelector(".badge");
    if (rightBadge) rightBadge.textContent = label;
  }

  private approvalPending(): boolean {
    return this.deps.state.uiState === "waiting_plan_approval";
  }

  /**
   * 结构化编排 → 宿主的增删改重排。
   *
   * 不走 savePlanEdits：那条路会按正文的章节把步骤清单反向收敛回去，
   * 刚拖好的顺序会被正文里的旧标题吃掉。这里只发粒度动作，正文原样不动。
   * 基线取当前 planRecord：宿主每次改完都会回推 planRecord，下一次编排就以它为准。
   */
  private applyStepOps(steps: PlanStepViewModel[]): void {
    const plan = this.deps.state.activePlan;
    if (!plan) return;
    const previous: StepSnapshot[] = plan.steps.map((step: PlanStepRecord) => ({
      id: step.id,
      title: step.title,
      description: step.description ?? "",
      files: [...step.files],
    }));
    const next: StepSnapshot[] = steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      files: [...step.files],
    }));

    for (const op of planStepOps(previous, next)) {
      switch (op.kind) {
        case "remove":
          this.deps.post({ type: "removePlanStep", stepId: op.stepId });
          break;
        case "add":
          this.deps.post({
            type: "addPlanStep",
            title: op.title,
            ...(op.description ? { description: op.description } : {}),
          });
          break;
        case "update":
          this.deps.post({
            type: "updatePlanStep",
            stepId: op.stepId,
            title: op.title,
            description: op.description,
            files: op.files,
          });
          break;
        case "reorder":
          this.deps.post({ type: "reorderPlanSteps", stepIds: op.stepIds });
          break;
      }
    }
  }

  renderCenter(): void {
    const model = buildPlanDocumentViewModel(this.deps.state.activePlan, this.deps.state.planCardView);
    if (!model) return;

    const pending = this.approvalPending();
    const next = renderPlanCompactCard(model, {
      onOpenSide: () => this.deps.openPlanTool(),
      ...(pending
        ? { onApprove: () => this.deps.post({ type: "approvePlan" }) }
        : {}),
    });

    if (this.card?.parentElement) this.card.replaceWith(next);
    else this.deps.appendNode(next);
    this.card = next;
    if (this.deps.isPlanToolOpen()) this.renderRight();
  }

  renderRight(): void {
    const model = buildPlanDocumentViewModel(this.deps.state.activePlan, this.deps.state.planCardView);
    if (!model) {
      this.rightRoot = undefined;
      const empty = el("div", "empty-state compact");
      empty.appendChild(el("strong", undefined, "暂无计划"));
      empty.appendChild(document.createTextNode("Plan 模式下发起研究后，计划文档会显示在这里。"));
      this.deps.el.panelPlan.replaceChildren(el("div", "panel-title", "Plan"), empty);
      return;
    }

    const next = renderPlanDocumentView(model, {
      onDiscard: () => {
        this.deps.post(
          this.approvalPending() || !this.deps.state.activePlan
            ? { type: "rejectPlan" }
            : { type: "discardPlanEdits" },
        );
        this.deps.state.planEditing = false;
        this.renderRight();
      },
      onStartBuild: () => {
        this.deps.state.planEditing = false;
        this.deps.post(
          this.approvalPending() || !this.deps.state.activePlan
            ? { type: "approvePlan" }
            : { type: "startPlanBuild" },
        );
      },
      onSave: (payload) => {
        this.save(payload);
      },
      onOpenFile: (relativePath: string) => this.deps.post({ type: "openWorkspaceFile", relativePath }),
      onOpenLink: (href) => this.deps.post({ type: "openExternalUrl", url: href }),
      // 勾选与编排只在已落库的计划上有意义：审批卡的步骤还没有真实 stepId。
      ...(this.deps.state.activePlan
        ? {
            onToggleStep: (stepId: string, included: boolean) =>
              this.deps.post({ type: "setPlanStepIncluded", stepId, included }),
            onEditSteps: (steps: PlanStepViewModel[]) => this.applyStepOps(steps),
          }
        : {}),
    });

    this.deps.el.panelPlan.replaceChildren(next);
    this.rightRoot = next;
  }

  /** 保存正文：只走 savePlanEdits，绝不能误触发审批。 */
  private save(payload?: PlanEditPayload): void {
    if (!payload) {
      this.deps.notice("没有可保存的计划内容。");
      return;
    }
    // 乐观写入本地状态，避免等 planRecord 回包前被旧稿盖回去。
    if (this.deps.state.activePlan && (
      payload.planId === this.deps.state.activePlan.id || payload.planId === "plan-card"
    )) {
      const prevById = new Map(this.deps.state.activePlan.steps.map((step) => [step.id, step]));
      const prevByTitle = new Map(
        this.deps.state.activePlan.steps.map((step) => [step.title.trim().toLowerCase(), step]),
      );
      const steps: PlanStepRecord[] = payload.steps.map((step, index) => {
        const prev = (step.id ? prevById.get(step.id) : undefined)
          ?? prevByTitle.get(step.title.trim().toLowerCase());
        return {
          id: step.id ?? prev?.id ?? `step-local-${index + 1}`,
          order: index + 1,
          title: step.title,
          ...(step.description ? { description: step.description } : {}),
          files: [...step.files],
          status: prev?.status ?? "pending",
        };
      });
      this.deps.state.activePlan = {
        ...this.deps.state.activePlan,
        title: payload.title,
        ...(payload.goal !== undefined ? { goal: payload.goal } : {}),
        files: [...payload.files],
        risks: [...payload.risks],
        steps,
        ...(payload.raw !== undefined ? { raw: payload.raw } : {}),
        updatedAt: Date.now(),
      };
      // 用户刚改完文档，执行期直播清单让位给最新 steps。
      this.deps.state.liveTaskSteps = undefined;
    }
    if (this.deps.state.planCardView) {
      this.deps.state.planCardView = {
        ...this.deps.state.planCardView,
        title: payload.title,
        ...(payload.raw !== undefined ? { raw: payload.raw } : {}),
        steps: payload.steps.map((step, index) => ({
          index: index + 1,
          title: step.title,
          ...(step.description ? { detail: step.description } : {}),
          files: [...step.files],
        })),
      };
    }
    this.deps.post({ type: "savePlanEdits", plan: payload });
    this.deps.state.planEditing = false;
    this.deps.refreshTool("tasks");
    this.renderCenter();
  }
}

/** @deprecated 兼容旧测试入口名；请改用 collectPlanPayloadFromDocument。 */
export { collectPlanPayloadFromDocument as collectPlanPayloadFromRoot };
