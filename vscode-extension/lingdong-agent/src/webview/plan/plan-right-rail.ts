import { el } from "./dom";
import {
  STEP_STATUS_LABELS,
  type PlanDocumentViewModel,
  type PlanStepUiStatus,
} from "./plan-view-model";

export interface PlanRightRailActions {
  onStartBuild: () => void;
  /** 省略时不渲染保存按钮，用于只读投影。 */
  onSave?: () => void;
  /** 省略时不渲染「在主面板打开」，用于主面板内自身复用。 */
  onOpenMain?: () => void;
}

/** 步骤标记用符号而不是图标字体：侧栏窄，字形对齐比图标一致性更要紧。 */
const STEP_MARKS: Record<PlanStepUiStatus, string> = {
  completed: "✓",
  in_progress: "▸",
  failed: "!",
  skipped: "–",
  pending: "",
};

function renderProgress(model: PlanDocumentViewModel): HTMLElement {
  const { done, total } = model.progress;
  const wrap = el("div", "plan-right-progress");

  const meta = el("div", "plan-right-progress-meta");
  meta.appendChild(el("span", "plan-right-progress-count", `${done}/${total}`));
  meta.appendChild(el("span", "plan-right-progress-label", model.statusLabel));
  wrap.appendChild(meta);

  const track = el("div", "plan-right-progress-track");
  const fill = el("div", "plan-right-progress-fill");
  // 0 步时不画 0% 的空槽——那看起来像加载失败。
  const ratio = total > 0 ? Math.round((done / total) * 100) : 0;
  fill.style.width = `${ratio}%`;
  if (model.status === "failed" || model.steps.some((step) => step.status === "failed")) {
    fill.classList.add("has-failure");
  }
  track.appendChild(fill);
  wrap.appendChild(track);
  return wrap;
}

function renderStep(step: PlanDocumentViewModel["steps"][number]): HTMLElement {
  const row = el("div", `plan-right-step is-${step.status}`);
  row.appendChild(el("span", "plan-right-step-mark", STEP_MARKS[step.status]));

  const body = el("div", "plan-right-step-body");
  body.appendChild(el("div", "plan-right-step-title", step.title));
  const meta = el("div", "plan-right-step-meta");
  meta.appendChild(el("span", "plan-right-step-status", STEP_STATUS_LABELS[step.status]));
  if (step.files.length > 0) {
    // 只报数量：窄栏里铺路径会把标题挤成两三行，详情在主面板看。
    meta.appendChild(el("span", "plan-right-step-files", `${step.files.length} 个文件`));
  }
  body.appendChild(meta);
  row.appendChild(body);
  return row;
}

/** 右侧精简 Plan：标题 / 进度条 / 步骤状态 / 底部操作条。无完整编辑表单。 */
export function renderPlanRightRail(
  model: PlanDocumentViewModel | undefined,
  actions: PlanRightRailActions,
): HTMLElement {
  const root = el("div", "plan-right-rail");

  if (!model || model.empty) {
    const empty = el("div", "plan-right-empty");
    empty.appendChild(el("div", "plan-right-empty-title", "暂无计划"));
    empty.appendChild(el(
      "div",
      "plan-right-empty-hint",
      "切到 Plan 模式描述目标，生成的计划会在这里显示进度。",
    ));
    root.appendChild(empty);
    return root;
  }

  const head = el("div", "plan-right-head");
  head.appendChild(el("div", "plan-right-title", model.title));
  if (model.goal) head.appendChild(el("div", "plan-right-goal", model.goal));
  root.appendChild(head);
  root.appendChild(renderProgress(model));

  const steps = el("div", "plan-right-steps");
  for (const step of model.steps) steps.appendChild(renderStep(step));
  root.appendChild(steps);

  const footer = el("div", "plan-right-footer");
  const build = el("button", "btn-primary", "开始构建");
  build.type = "button";
  build.disabled = !model.canBuild;
  build.addEventListener("click", actions.onStartBuild);
  footer.appendChild(build);
  if (actions.onSave) {
    const save = el("button", "btn-ghost", "保存");
    save.type = "button";
    save.addEventListener("click", actions.onSave);
    footer.appendChild(save);
  }
  if (actions.onOpenMain) {
    // 替掉过去那句裸文本提示：告诉用户"去主面板改"却不给入口，等于让他自己找。
    const open = el("button", "btn-ghost", "在主面板编辑");
    open.type = "button";
    open.addEventListener("click", actions.onOpenMain);
    footer.appendChild(open);
  }
  root.appendChild(footer);
  return root;
}
