import type { DiffText } from "../diff-text";
import { element } from "./dom-utils";

/**
 * DiffText 的统一渲染：右栏 Changes 面板与任何需要就地看 diff 的地方共用。
 * 只做展示，不带任何操作按钮；textContent 落字，永不拼 HTML。
 */
export function renderDiffText(body: HTMLElement, diff: DiffText): void {
  if (diff.hunks.length === 0) {
    body.appendChild(element("div", "change-diff-hint", "内容没有变化。"));
    return;
  }
  const stats = element("div", "change-diff-stats");
  stats.appendChild(element("span", "diff-added", `+${diff.added}`));
  stats.appendChild(element("span", "diff-removed", `−${diff.removed}`));
  if (diff.degraded) {
    stats.appendChild(element("span", "change-diff-hint", "文件过大，只显示整体替换"));
  }
  body.appendChild(stats);

  for (const hunk of diff.hunks) {
    const table = element("div", "change-diff-hunk");
    table.appendChild(element("div", "change-diff-header", hunk.header));
    for (const line of hunk.lines) {
      const record = element("div", `change-diff-line diff-${line.kind}`);
      record.appendChild(element("span", "change-diff-num", line.oldLine ? String(line.oldLine) : ""));
      record.appendChild(element("span", "change-diff-num", line.newLine ? String(line.newLine) : ""));
      const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
      record.appendChild(element("span", "change-diff-sign", sign));
      record.appendChild(element("span", "change-diff-text", line.text));
      table.appendChild(record);
    }
    body.appendChild(table);
  }

  if (diff.omittedHunks > 0) {
    body.appendChild(element(
      "div",
      "change-diff-hint",
      `还有 ${diff.omittedHunks} 处改动，可在编辑器中打开看全。`,
    ));
  }
}
