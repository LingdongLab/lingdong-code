import { el, bindAutosize } from "./dom";
import type { PlanClarificationViewModel } from "./plan-view-model";

export interface PlanClarificationsOptions {
  items: readonly PlanClarificationViewModel[];
  editable?: boolean;
  onChange?: (items: PlanClarificationViewModel[]) => void;
}

export function renderPlanClarifications(options: PlanClarificationsOptions): HTMLElement {
  const root = el("section", "plan-section plan-clarifications");
  root.appendChild(el("h3", "plan-sec-title", "澄清事项"));

  if (!options.editable) {
    if (options.items.length === 0) {
      root.appendChild(el("p", "plan-compact-empty", "当前没有待确认事项。"));
      return root;
    }
    for (const item of options.items) {
      const box = el("div", "plan-clarify");
      box.appendChild(el("div", "plan-clarify-q", item.question));
      box.appendChild(el("div", "plan-clarify-a", item.answer?.trim() ? item.answer : "待回答"));
      root.appendChild(box);
    }
    return root;
  }

  const state = options.items.map((item) => ({ ...item }));
  const list = el("div", "plan-clarify-edit-list");

  const paint = (): void => {
    list.replaceChildren();
    state.forEach((item, index) => {
      const box = el("div", "plan-clarify-edit");
      const q = el("textarea", "plan-field") as HTMLTextAreaElement;
      q.placeholder = "澄清问题";
      q.value = item.question;
      bindAutosize(q);
      q.addEventListener("input", () => {
        state[index] = { ...state[index]!, question: q.value };
        options.onChange?.(state.map((x) => ({ ...x })));
      });
      const a = el("textarea", "plan-field") as HTMLTextAreaElement;
      a.placeholder = "答案（可选）";
      a.value = item.answer ?? "";
      bindAutosize(a);
      a.addEventListener("input", () => {
        const answer = a.value.trim();
        state[index] = {
          ...state[index]!,
          question: state[index]!.question,
          ...(answer ? { answer } : {}),
        };
        options.onChange?.(state.map((x) => ({ ...x })));
      });
      const remove = el("button", "btn-ghost plan-mini-btn", "移除");
      remove.type = "button";
      remove.addEventListener("click", () => {
        state.splice(index, 1);
        options.onChange?.(state.map((x) => ({ ...x })));
        paint();
      });
      box.append(q, a, remove);
      list.appendChild(box);
    });
  };

  paint();
  root.appendChild(list);

  const add = el("button", "btn-ghost plan-mini-btn", "增加澄清事项");
  add.type = "button";
  add.addEventListener("click", () => {
    state.push({ id: `ask-local-${Date.now()}`, question: "" });
    options.onChange?.(state.map((x) => ({ ...x })));
    paint();
  });
  root.appendChild(add);
  return root;
}
