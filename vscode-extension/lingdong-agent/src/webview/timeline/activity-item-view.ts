import { type ActivityItem, describeActivityItem } from "../../presentation/activity-item";
import { element } from "../dom-utils";

/**
 * 展开后的单行活动。
 * 只有用户展开分组时才会被创建，折叠时整块释放。
 */

export interface ItemRowDeps {
  /** 失败详情引导到输出面板，正文里不铺整份终端日志。 */
  onShowLog(): void;
}

export function createItemRow(item: ActivityItem, deps: ItemRowDeps): HTMLElement {
  const row = element("div", "tl-item");
  row.dataset.itemId = item.id;
  paintItemRow(row, item, deps);
  return row;
}

export function paintItemRow(row: HTMLElement, item: ActivityItem, deps: ItemRowDeps): void {
  row.className = `tl-item tl-${item.status}`;
  row.replaceChildren();

  const line = element("div", "tl-item-line");
  line.appendChild(element("span", "tl-item-dot"));
  line.appendChild(element("span", "tl-item-text", describeActivityItem(item)));
  row.appendChild(line);

  // 展开状态下，运行中的命令行下面挂实时输出尾巴。
  if (item.status === "running" && item.outputTail) {
    row.appendChild(element("pre", "tl-item-output", item.outputTail));
  }

  if (item.status !== "failed") return;
  if (item.detail) row.appendChild(element("pre", "tl-item-detail", item.detail));
  const link = element("button", "tl-item-log", "在输出中查看详情");
  link.type = "button";
  link.addEventListener("click", () => deps.onShowLog());
  row.appendChild(link);
}
