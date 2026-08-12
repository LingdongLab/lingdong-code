import { el } from "./dom";
import type { PlanDocumentViewModel } from "./plan-view-model";

/**
 * 会话流紧凑卡（对标 Cursor）：标题 / 状态 / 进度。
 * 完整文档默认在右侧；审批未决时只留「开始构建」主按钮。
 * 点卡片本身可聚焦右侧 Plan（若尚未打开）。
 */
export interface PlanCompactCardActions {
  onOpenSide: () => void;
  /** 审批未决时：批准并开始构建。 */
  onApprove?: () => void;
}

export function renderPlanCompactCard(
  model: PlanDocumentViewModel,
  actions: PlanCompactCardActions,
): HTMLElement {
  const root = el("section", "plan-card plan-compact-card");
  root.dataset.planRoot = "1";
  root.dataset.planId = model.id;

  const head = el("div", "plan-compact-head");
  const title = el("button", "plan-compact-title-btn", model.title);
  title.type = "button";
  title.title = "在右侧查看计划";
  title.addEventListener("click", actions.onOpenSide);
  head.appendChild(title);
  const meta = el("div", "plan-doc-meta");
  meta.appendChild(el("span", "badge plan-status", model.statusLabel));
  meta.appendChild(el("span", "plan-progress", `进度 ${model.progress.done}/${model.progress.total}`));
  head.appendChild(meta);
  root.appendChild(head);

  if (actions.onApprove) {
    const bar = el("div", "plan-compact-actions");
    const approve = el("button", "btn-primary", "开始构建");
    approve.type = "button";
    approve.addEventListener("click", (event) => {
      event.stopPropagation();
      actions.onApprove?.();
    });
    bar.appendChild(approve);
    root.appendChild(bar);
  }

  return root;
}
