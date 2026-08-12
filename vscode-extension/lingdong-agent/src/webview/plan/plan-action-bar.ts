import { el } from "./dom";

/**
 * 对标 Cursor Plan：底部只留关键动作。
 * - 开始构建 = Build
 * - 放弃 = 拒批 / 丢掉本地草案
 * - 保存 = 仅编辑正文时出现（改完 markdown 落盘）
 */
export interface PlanActionBarOptions {
  canBuild: boolean;
  /** 正在编辑正文时显示「保存」。 */
  dirty?: boolean;
  onSave?: () => void;
  onDiscard: () => void;
  onStartBuild: () => void;
}

export function renderPlanActionBar(options: PlanActionBarOptions): HTMLElement {
  const bar = el("div", "plan-action-bar");

  if (options.onSave && options.dirty) {
    const save = el("button", "btn-ghost", "保存");
    save.type = "button";
    save.addEventListener("click", options.onSave);
    bar.appendChild(save);
  }

  const discard = el("button", "btn-danger", "放弃");
  discard.type = "button";
  discard.addEventListener("click", options.onDiscard);

  const build = el("button", "btn-primary", "开始构建");
  build.type = "button";
  build.disabled = !options.canBuild;
  build.addEventListener("click", options.onStartBuild);

  bar.append(discard, build);
  return bar;
}
