import { bindAutosize, el } from "./dom";
import { renderPlanFileChips } from "./plan-file-chips";
import { moveStep, sanitizePathList, type PlanStepViewModel } from "./plan-view-model";

export interface PlanStepEditorOptions {
  steps: PlanStepViewModel[];
  onChange: (steps: PlanStepViewModel[]) => void;
  onOpenFile?: (relativePath: string) => void;
}

function renumber(steps: PlanStepViewModel[]): PlanStepViewModel[] {
  return steps.map((step, index) => ({ ...step, order: index + 1 }));
}

/** 每一步独立结构化编辑器：上移/下移 + 拖拽排序。 */
export function renderPlanStepEditor(options: PlanStepEditorOptions): HTMLElement {
  const root = el("section", "plan-section plan-steps-edit");
  root.appendChild(el("h3", "plan-sec-title", "实施步骤"));
  const list = el("div", "plan-step-editor-list");
  let steps = renumber(options.steps.map((s) => ({
    ...s,
    files: sanitizePathList(s.files),
    description: s.description ?? "",
  })));

  const emit = (): void => {
    steps = renumber(steps);
    options.onChange(steps.map((s) => ({ ...s, files: [...s.files] })));
  };

  const paint = (): void => {
    list.replaceChildren();
    steps.forEach((step, index) => {
      list.appendChild(renderOne(step, index));
    });
  };

  const renderOne = (step: PlanStepViewModel, index: number): HTMLElement => {
    const card = el("article", "plan-step-editor");
    card.draggable = true;
    card.dataset.stepId = step.id;
    card.dataset.stepBlock = "1";

    card.addEventListener("dragstart", (event) => {
      card.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("drag-over");
      const from = Number(event.dataTransfer?.getData("text/plain"));
      if (!Number.isFinite(from)) return;
      steps = renumber(moveStep(steps, from, index));
      emit();
      paint();
    });

    const toolbar = el("div", "plan-step-toolbar");
    toolbar.appendChild(el("span", "plan-step-index", String(index + 1)));
    const grip = el("span", "plan-step-grip", "⋮⋮");
    grip.title = "拖拽排序";
    toolbar.appendChild(grip);

    const up = el("button", "btn-ghost plan-mini-btn", "上移");
    up.type = "button";
    up.disabled = index === 0;
    up.addEventListener("click", () => {
      steps = renumber(moveStep(steps, index, index - 1));
      emit();
      paint();
    });
    const down = el("button", "btn-ghost plan-mini-btn", "下移");
    down.type = "button";
    down.disabled = index >= steps.length - 1;
    down.addEventListener("click", () => {
      steps = renumber(moveStep(steps, index, index + 1));
      emit();
      paint();
    });
    const remove = el("button", "btn-danger plan-mini-btn", "删除步骤");
    remove.type = "button";
    remove.addEventListener("click", () => {
      steps = renumber(steps.filter((_, i) => i !== index));
      emit();
      paint();
    });
    toolbar.append(up, down, remove);
    card.appendChild(toolbar);

    const title = el("input", "plan-field") as HTMLInputElement;
    title.dataset.stepTitle = "1";
    title.placeholder = "步骤标题";
    title.value = step.title;
    title.addEventListener("input", () => {
      steps[index] = { ...steps[index]!, title: title.value };
      emit();
    });
    card.appendChild(title);

    const desc = el("textarea", "plan-field") as HTMLTextAreaElement;
    desc.dataset.stepDesc = "1";
    desc.placeholder = "步骤说明";
    desc.value = step.description;
    bindAutosize(desc);
    desc.addEventListener("input", () => {
      steps[index] = { ...steps[index]!, description: desc.value };
      emit();
    });
    card.appendChild(desc);

    const filesHost = el("div", "plan-step-files");
    const paintFiles = (): void => {
      filesHost.replaceChildren();
      filesHost.appendChild(renderPlanFileChips({
        files: steps[index]!.files,
        editable: true,
        ...(options.onOpenFile ? { onOpen: options.onOpenFile } : {}),
        onRemove: (path) => {
          steps[index] = {
            ...steps[index]!,
            files: steps[index]!.files.filter((f) => f !== path),
          };
          emit();
          paintFiles();
        },
        onAdd: (path) => {
          const files = sanitizePathList([...steps[index]!.files, path]);
          steps[index] = { ...steps[index]!, files };
          emit();
          paintFiles();
        },
      }));
    };
    paintFiles();
    card.appendChild(filesHost);
    return card;
  };

  paint();
  root.appendChild(list);

  const add = el("button", "btn-ghost", "新增步骤");
  add.type = "button";
  add.addEventListener("click", () => {
    steps = renumber([
      ...steps,
      {
        id: `step-local-${Date.now()}`,
        order: steps.length + 1,
        title: "",
        description: "",
        files: [],
        status: "pending",
      },
    ]);
    emit();
    paint();
  });
  root.appendChild(add);
  return root;
}

export function collectStepsFromEditor(root: HTMLElement): PlanStepViewModel[] {
  // 优先从 data 缓存读取：编辑器通过 onChange 同步；此处兜底扫 DOM。
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-step-block]"));
  return blocks.map((block, index) => {
    const title = (block.querySelector("[data-step-title]") as HTMLInputElement | null)?.value.trim() || "未命名步骤";
    const description = (block.querySelector("[data-step-desc]") as HTMLTextAreaElement | null)?.value.trim() ?? "";
    const files = Array.from(block.querySelectorAll(".plan-file-chip-label"))
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean);
    return {
      id: block.dataset.stepId || `step-${index + 1}`,
      order: index + 1,
      title,
      description,
      files: sanitizePathList(files),
      status: "pending" as const,
    };
  });
}
