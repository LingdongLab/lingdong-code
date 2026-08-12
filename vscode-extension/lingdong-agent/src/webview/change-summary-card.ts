import type { ChangeListView, ChangeRowView } from "../change-view";
import { describeLineDiff } from "../presentation/line-diff";
import type { Post } from "./app-context";
import { element } from "./dom-utils";

/**
 * 会话流内的本轮变更摘要（对标 Cursor 的「N Files Changed | Review」）：
 * - 一行头部：文件数 + 合计 +N/−N + Review
 * - 每行只有 变更字母 + 路径 + 行数角标，点击整行在右栏看 diff
 * - 行内不再放展开/Diff/接受/拒绝——细看与逐项操作都在右栏 Changes 面板
 * - pending 时底部保留一排紧凑的批量操作
 */

export interface ChangeSummaryOptions {
  canApply: boolean;
  canRestore: boolean;
  /** 点击文件行 / Review：打开右栏 Changes 并选中该文件（undefined = 只开面板）。 */
  onOpenChange(changeId: string | undefined): void;
}

export function fillChangeSummaryCard(
  card: HTMLElement,
  view: ChangeListView,
  options: ChangeSummaryOptions,
  post: Post,
): void {
  card.classList.remove("card-collapsed");
  card.replaceChildren();

  const header = element("div", "card-header change-summary-header");
  header.appendChild(element("span", "card-title", `${view.rows.length} 个文件已修改`));
  const total = describeLineDiff(view.lines);
  if (total && view.lines) {
    const badge = element("span", "change-summary-lines");
    badge.appendChild(element("span", "diff-added", `+${view.lines.added}`));
    badge.appendChild(element("span", "diff-removed", `-${view.lines.deleted}`));
    badge.title = `合计 ${total}`;
    header.appendChild(badge);
  }
  const review = element("button", "link change-summary-review", "Review");
  review.type = "button";
  review.title = "在右侧查看全部改动";
  review.addEventListener("click", () => options.onOpenChange(view.rows[0]?.changeId));
  header.appendChild(review);
  card.appendChild(header);

  const statsParts = summaryParts(view);
  card.dataset.collapseSummary = `${view.title || "变更摘要"} · ${statsParts.join(" · ")}`;

  const list = element("div", "change-summary-list");
  for (const row of view.rows) {
    list.appendChild(renderRow(row, options));
  }
  card.appendChild(list);

  if (view.canAcceptAll || view.canRejectAll || view.canUndo) {
    const footer = element("div", "card-actions change-summary-actions");
    if (view.canAcceptAll) {
      const acceptAll = element("button", "btn-primary", "接受全部");
      acceptAll.type = "button";
      acceptAll.disabled = !options.canApply;
      acceptAll.addEventListener("click", () => post({ type: "acceptAll", turnId: view.turnId }));
      footer.appendChild(acceptAll);
    }
    if (view.canRejectAll) {
      const rejectAll = element("button", "btn-danger", "拒绝全部");
      rejectAll.type = "button";
      rejectAll.disabled = !options.canApply;
      rejectAll.addEventListener("click", () => post({ type: "rejectAll", turnId: view.turnId }));
      footer.appendChild(rejectAll);
    }
    if (view.canUndo) {
      const undo = element("button", "btn-ghost", "撤销本轮");
      undo.type = "button";
      undo.disabled = !options.canRestore;
      undo.addEventListener("click", () => post({ type: "undoTurn", turnId: view.turnId }));
      footer.appendChild(undo);
    }
    card.appendChild(footer);
  }
}

function summaryParts(view: ChangeListView): string[] {
  const created = view.rows.filter((row) => row.kind === "create").length;
  const modified = view.rows.filter((row) => row.kind === "modify" || row.kind === "rename").length;
  const deleted = view.rows.filter((row) => row.kind === "delete").length;
  const parts = [`修改 ${modified}`];
  if (created) parts.push(`新增 ${created}`);
  if (deleted) parts.push(`删除 ${deleted}`);
  if (view.pending > 0) parts.push(`待处理 ${view.pending}`);
  const total = describeLineDiff(view.lines);
  if (total) parts.push(total);
  return parts;
}

function renderRow(row: ChangeRowView, options: ChangeSummaryOptions): HTMLElement {
  const block = element("button", "change-summary-row");
  block.type = "button";
  block.dataset.changeId = row.changeId;
  block.title = "在右侧查看改动";
  block.addEventListener("click", () => options.onOpenChange(row.changeId));

  block.appendChild(element("span", `change-letter letter-${row.letter}`, row.letter));
  block.appendChild(element("span", "change-summary-path", row.relativePath));

  const lines = describeLineDiff(row.lines);
  if (lines && row.lines) {
    const badge = element("span", "change-summary-lines");
    badge.appendChild(element("span", "diff-added", `+${row.lines.added}`));
    badge.appendChild(element("span", "diff-removed", `-${row.lines.deleted}`));
    badge.title = lines;
    block.appendChild(badge);
  }

  // 常态不重复状态文字；冲突必须显眼，其余终态一个小字即可。
  if (row.status === "conflict") {
    block.appendChild(element("span", "change-summary-flag reject", "冲突"));
  } else if (row.status !== "pending") {
    block.appendChild(element("span", "change-summary-flag", row.statusLabel));
  }

  return block;
}
