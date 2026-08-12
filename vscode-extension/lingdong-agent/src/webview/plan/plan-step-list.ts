import { enhanceMarkdownDom, renderMarkdownToHtml } from "../message-renderer";
import { el } from "./dom";
import { renderPlanFileChips } from "./plan-file-chips";
import { STEP_STATUS_LABELS, type PlanStepViewModel } from "./plan-view-model";

export interface PlanStepListOptions {
  steps: readonly PlanStepViewModel[];
  onOpenFile?: (relativePath: string) => void;
  /**
   * 步骤勾选。给了才渲染勾选框——纯展示的场合（例如历史计划）
   * 摆一排点不动的勾选框只会让人以为坏了。
   */
  onToggleStep?: (stepId: string, included: boolean) => void;
}

/**
 * 步骤说明按 markdown 渲染。
 * 模型写步骤时会用表格、加粗、行内代码，之前这里是纯文本塞进 <p>，
 * 于是一整张对照表被压成一行 `| 项 | 现状 | 目标 | |----|----|` 的竖线。
 */
function renderStepDescription(markdown: string): HTMLElement {
  const body = el("div", "plan-step-desc md-body");
  body.innerHTML = renderMarkdownToHtml(markdown);
  enhanceMarkdownDom(body);
  return body;
}

/**
 * 步骤勾选框。取消勾选表示这一步这次不做（宿主记成 skipped，逐步门控就不下发它）。
 * 已完成与正在执行的步骤禁用：那两种状态改不动，让它可点只会让人白点一下。
 */
function stepCheckbox(
  step: PlanStepViewModel,
  onToggle: (stepId: string, included: boolean) => void,
): HTMLElement {
  const box = el("input", "plan-step-check") as HTMLInputElement;
  box.type = "checkbox";
  box.checked = step.status !== "skipped";
  const locked = step.status === "completed" || step.status === "in_progress";
  box.disabled = locked;
  box.title = locked
    ? step.status === "completed" ? "这一步已经做完了" : "这一步正在执行中"
    : box.checked ? "取消勾选表示这次不做这一步" : "勾选后这一步会重新参与执行";
  box.addEventListener("change", () => onToggle(step.id, box.checked));
  return box;
}

/** 阅读态步骤列表：序号 + 标题 + 状态 + 文件。 */
export function renderPlanStepList(options: PlanStepListOptions): HTMLElement {
  const root = el("section", "plan-section plan-steps-read");
  root.appendChild(el("h3", "plan-sec-title", "实施步骤"));

  if (options.steps.length === 0) {
    root.appendChild(el("p", "plan-compact-empty", "尚未拆分实施步骤。"));
    return root;
  }

  const list = el("ol", "plan-step-list");
  options.steps.forEach((step, index) => {
    const item = el("li", "plan-step-row");
    item.dataset.stepId = step.id;
    if (step.status === "skipped") item.classList.add("plan-step-excluded");

    const head = el("div", "plan-step-head");
    if (options.onToggleStep) head.appendChild(stepCheckbox(step, options.onToggleStep));
    head.appendChild(el("span", "plan-step-index", String(index + 1)));
    head.appendChild(el("span", "plan-step-title", step.title));
    head.appendChild(el("span", `plan-step-status status-${step.status}`, STEP_STATUS_LABELS[step.status]));
    item.appendChild(head);

    if (step.description.trim()) {
      item.appendChild(renderStepDescription(step.description));
    }
    if (step.files.length > 0) {
      item.appendChild(renderPlanFileChips({
        files: step.files,
        ...(options.onOpenFile ? { onOpen: options.onOpenFile } : {}),
      }));
    }
    list.appendChild(item);
  });
  root.appendChild(list);
  return root;
}
