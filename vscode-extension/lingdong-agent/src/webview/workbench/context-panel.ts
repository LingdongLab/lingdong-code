import type { ContextItemView, UsageView } from "../../messages";
import type { Post } from "../app-context";
import { sourceLabel } from "../composer";
import { element, emptyPanel } from "../dom-utils";

/** 右侧 Context 工具：完整的上下文管理界面（Composer 只放 chips 与浮层）。 */
export function renderContextPanel(
  panel: HTMLElement,
  items: ContextItemView[],
  usage: UsageView | undefined,
  post: Post,
): void {
  panel.replaceChildren();
  panel.appendChild(element("div", "panel-title", "Context"));
  if (usage?.label) {
    for (const line of usage.label.split(" · ")) {
      panel.appendChild(element("div", undefined, line));
    }
  } else {
    panel.appendChild(element("div", undefined, "上下文用量暂不可用"));
  }
  if (usage?.source && usage.source !== "unavailable") {
    panel.appendChild(element("div", "activity", `来源：${sourceLabel(usage.source)}`));
  }

  if (items.length === 0) {
    panel.appendChild(emptyPanel("尚未添加上下文", "用「+」添加文件、选区或问题面板。", true));
  } else {
    for (const item of items) {
      const row = element("div", "ctx-row");
      row.appendChild(element("span", undefined, `@${item.label}`));
      const show = element("button", "btn-ghost", "查看");
      show.addEventListener("click", () => post({ type: "showContext", id: item.id }));
      row.appendChild(show);
      panel.appendChild(row);
    }
  }

  const footer = element("div", "panel-footer");
  const clear = element("button", "btn-ghost", "清空已添加上下文");
  clear.addEventListener("click", () => post({ type: "clearContext" }));
  const compact = element("button", "btn-primary", usage?.compactBusy ? "压缩中…" : "压缩上下文");
  compact.disabled = usage?.compactCapability !== "available" || !!usage?.compactBusy;
  compact.addEventListener("click", () => post({ type: "compactContext" }));
  footer.append(clear, compact);
  panel.appendChild(footer);
}
