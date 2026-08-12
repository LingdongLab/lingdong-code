import { el, bindAutosize } from "./dom";

export interface PlanRiskSectionOptions {
  risks: readonly string[];
  editable?: boolean;
  onChange?: (risks: string[]) => void;
}

export function renderPlanRiskSection(options: PlanRiskSectionOptions): HTMLElement {
  const root = el("section", "plan-section plan-risks");
  root.appendChild(el("h3", "plan-sec-title", "潜在风险"));

  if (!options.editable) {
    if (options.risks.length === 0) {
      root.appendChild(el("p", "plan-compact-empty", "暂未发现明显风险。"));
      return root;
    }
    const ul = el("ul", "plan-risk-list");
    for (const risk of options.risks) {
      ul.appendChild(el("li", undefined, risk));
    }
    root.appendChild(ul);
    return root;
  }

  const state = [...options.risks];
  const list = el("div", "plan-risk-edit-list");

  const paint = (): void => {
    list.replaceChildren();
    state.forEach((risk, index) => {
      const row = el("div", "plan-risk-edit-row");
      const input = el("textarea", "plan-field") as HTMLTextAreaElement;
      input.value = risk;
      input.placeholder = "描述一项风险";
      bindAutosize(input);
      input.addEventListener("input", () => {
        state[index] = input.value;
        options.onChange?.(state.map((s) => s.trim()).filter(Boolean));
      });
      const remove = el("button", "btn-ghost plan-mini-btn", "移除");
      remove.type = "button";
      remove.addEventListener("click", () => {
        state.splice(index, 1);
        options.onChange?.(state.map((s) => s.trim()).filter(Boolean));
        paint();
      });
      row.append(input, remove);
      list.appendChild(row);
    });
  };

  paint();
  root.appendChild(list);
  const add = el("button", "btn-ghost plan-mini-btn", "增加风险");
  add.type = "button";
  add.addEventListener("click", () => {
    state.push("");
    paint();
  });
  root.appendChild(add);
  return root;
}
