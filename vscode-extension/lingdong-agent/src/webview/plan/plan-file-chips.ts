import { el } from "./dom";
import { sanitizePathList } from "./plan-view-model";

export interface PlanFileChipsOptions {
  files: readonly string[];
  editable?: boolean;
  onOpen?: (relativePath: string) => void;
  onRemove?: (relativePath: string) => void;
  onAdd?: (relativePath: string) => void;
}

/** 文件 chip / 紧凑列表：仅相对路径。 */
export function renderPlanFileChips(options: PlanFileChipsOptions): HTMLElement {
  const root = el("div", "plan-file-chips");
  const files = sanitizePathList(options.files);

  if (files.length === 0 && !options.editable) {
    root.classList.add("is-empty");
    return root;
  }

  const list = el("div", "plan-file-chip-list");
  for (const file of files) {
    const chip = el("span", "plan-file-chip");
    const label = el("button", "plan-file-chip-label", file);
    label.type = "button";
    label.title = file;
    label.addEventListener("click", () => options.onOpen?.(file));
    chip.appendChild(label);
    if (options.editable && options.onRemove) {
      const remove = el("button", "plan-file-chip-x", "×");
      remove.type = "button";
      remove.title = "移除文件";
      remove.addEventListener("click", () => options.onRemove?.(file));
      chip.appendChild(remove);
    }
    list.appendChild(chip);
  }
  root.appendChild(list);

  if (options.editable && options.onAdd) {
    const row = el("div", "plan-file-add-row");
    const input = el("input", "plan-inline-input") as HTMLInputElement;
    input.placeholder = "添加相对路径，如 src/auth/session.ts";
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      options.onAdd?.(value);
      input.value = "";
    });
    const add = el("button", "btn-ghost plan-mini-btn", "添加");
    add.type = "button";
    add.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) return;
      options.onAdd?.(value);
      input.value = "";
    });
    row.append(input, add);
    root.appendChild(row);
  }

  return root;
}
