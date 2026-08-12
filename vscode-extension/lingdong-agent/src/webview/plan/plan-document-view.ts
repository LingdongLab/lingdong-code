import type { PlanEditPayload } from "../../messages";
import { reconcilePlanStepsFromMarkdown } from "../../plan-steps-from-markdown";
import { enhanceMarkdownDom, renderMarkdownToHtml } from "../message-renderer";
import { el } from "./dom";
import { extractMarkdownTitle, htmlToMarkdown } from "./html-to-markdown";
import { renderPlanActionBar } from "./plan-action-bar";
import { renderPlanClarifications } from "./plan-clarifications";
import { renderPlanStepEditor } from "./plan-step-editor";
import { renderPlanStepList } from "./plan-step-list";
import { synthesizePlanMarkdown } from "./plan-synthesize";
import {
  formatPlanUpdatedAt,
  type PlanDocumentViewModel,
  type PlanStepViewModel,
} from "./plan-view-model";

export interface PlanDocumentActions {
  onSave: (payload: PlanEditPayload) => void;
  onDiscard: () => void;
  onStartBuild: () => void;
  onOpenFile: (relativePath: string) => void;
  onOpenLink?: (href: string) => void;
  /** 步骤勾选：宿主据此把步骤记成 pending / skipped。 */
  onToggleStep?: (stepId: string, included: boolean) => void;
  /**
   * 结构化步骤编排（拖拽、上移下移、增删、改标题与文件）。
   * 给了才渲染编排区；调用方负责把整份新列表翻译成宿主的增删改重排。
   */
  onEditSteps?: (steps: PlanStepViewModel[]) => void;
}

type CollectHost = HTMLElement & { __collectPlan?: () => PlanEditPayload | undefined };

function buildPayload(model: PlanDocumentViewModel, markdown: string): PlanEditPayload | undefined {
  let raw = markdown.trim();
  if (!raw) return undefined;
  // 阅读态会剥掉与头部重复的 h1；落盘时补回，避免丢标题。
  if (!/^#\s+/m.test(raw)) {
    raw = `# ${model.title}\n\n${raw}`;
  }
  raw = `${raw.trimEnd()}\n`;
  const title = (extractMarkdownTitle(raw) || model.title).trim().slice(0, 200);
  if (!title) return undefined;
  // Tasks 读 steps：正文删了的章节/勾选必须从 steps 里拿掉，不能冻结旧清单。
  const steps = reconcilePlanStepsFromMarkdown(raw, model.steps.map((step) => ({
    ...(step.id.startsWith("step-local-") || step.id.startsWith("card-step-")
      ? {}
      : { id: step.id }),
    title: step.title,
    ...(step.description.trim() ? { description: step.description } : {}),
    files: [...step.files],
  })));
  return {
    planId: model.id,
    title,
    ...(model.goal ? { goal: model.goal } : {}),
    files: [...model.files],
    risks: [...model.risks],
    steps,
    raw,
  };
}

function bindWysiwyg(
  md: HTMLElement,
  model: PlanDocumentViewModel,
  onDirtyChange: (dirty: boolean) => void,
): () => PlanEditPayload | undefined {
  const initial = htmlToMarkdown(md);
  md.contentEditable = "true";
  md.spellcheck = false;
  md.setAttribute("role", "textbox");
  md.setAttribute("aria-multiline", "true");
  md.setAttribute("aria-label", "计划正文");
  md.classList.add("plan-raw-editable", "plan-wysiwyg");
  md.dataset.planWysiwyg = "1";

  // 工具条按钮不要进编辑区撤销栈。
  for (const chrome of Array.from(md.querySelectorAll("button, .code-block-bar"))) {
    (chrome as HTMLElement).contentEditable = "false";
  }

  md.addEventListener("input", () => {
    onDirtyChange(htmlToMarkdown(md) !== initial);
  });

  // 点链接仍走打开，不抢光标编辑。
  md.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button, .code-copy")) return;
  });

  return () => buildPayload(model, htmlToMarkdown(md));
}

/**
 * Cursor 式计划文档：渲染态直接改（WYSIWYG），没有「下面改 Markdown」的源码框。
 */
export function renderPlanDocumentView(
  model: PlanDocumentViewModel,
  actions: PlanDocumentActions,
): HTMLElement {
  const root = el("section", "plan-card plan-mode-read plan-mode-wysiwyg") as CollectHost;
  root.dataset.planRoot = "1";
  root.dataset.planId = model.id;

  const header = el("header", "plan-doc-header");
  const titleEl = el("h2", "plan-doc-title", model.title);
  header.appendChild(titleEl);
  const meta = el("div", "plan-doc-meta");
  meta.appendChild(el("span", "badge plan-status", model.statusLabel));
  meta.appendChild(el("span", "plan-version", `v${model.version}`));
  const updated = formatPlanUpdatedAt(model.updatedAt);
  if (updated) meta.appendChild(el("span", "plan-updated", `更新于 ${updated}`));
  header.appendChild(meta);
  root.appendChild(header);

  const body = el("div", "plan-doc");
  const sourceMarkdown = model.raw.trim() ? model.raw : synthesizePlanMarkdown(model);

  const rawSec = el("section", "plan-section plan-raw");
  const md = el("div", "plan-raw-md md-body");
  md.innerHTML = renderMarkdownToHtml(sourceMarkdown);
  enhanceMarkdownDom(md, actions.onOpenLink);
  rawSec.appendChild(md);
  body.appendChild(rawSec);

  body.appendChild(renderPlanClarifications({ items: model.clarifications }));
  body.appendChild(renderPlanStepList({
    steps: model.steps,
    onOpenFile: actions.onOpenFile,
    ...(actions.onToggleStep ? { onToggleStep: actions.onToggleStep } : {}),
  }));

  // 结构化编排与上面的正文共存：正文管「怎么说」，这里管「按什么顺序做哪几步」。
  // 默认折叠——大多数时候看清单就够了，要动顺序的人自己展开。
  if (actions.onEditSteps) {
    const onEditSteps = actions.onEditSteps;
    const fold = el("details", "plan-step-arrange") as HTMLDetailsElement;
    fold.appendChild(el("summary", "plan-step-arrange-summary", "步骤编排（拖拽排序 / 增删）"));
    fold.appendChild(renderPlanStepEditor({
      steps: model.steps.map((step) => ({ ...step, files: [...step.files] })),
      onChange: (steps) => onEditSteps(steps),
      onOpenFile: actions.onOpenFile,
    }));
    body.appendChild(fold);
  }

  root.appendChild(body);

  const barHost = el("div");
  root.appendChild(barHost);

  let dirty = false;
  const paintBar = (): void => {
    barHost.replaceChildren(renderPlanActionBar({
      canBuild: model.canBuild,
      dirty,
      onSave: () => {
        const payload = root.__collectPlan?.();
        if (payload) actions.onSave(payload);
      },
      onDiscard: actions.onDiscard,
      onStartBuild: () => {
        if (dirty) {
          const payload = root.__collectPlan?.();
          if (payload) actions.onSave(payload);
        }
        actions.onStartBuild();
      },
    }));
  };

  root.__collectPlan = bindWysiwyg(md, model, (next) => {
    dirty = next;
    paintBar();
  });
  paintBar();

  return root;
}

export function collectPlanPayloadFromDocument(root: HTMLElement): PlanEditPayload | undefined {
  return (root as CollectHost).__collectPlan?.();
}
