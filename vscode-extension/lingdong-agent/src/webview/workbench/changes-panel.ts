import type { ChangeListView, HunkView, RailChangeState } from "../../change-view";
import { describeLineDiff } from "../../presentation/line-diff";
import type { Post } from "../app-context";
import { renderDiffText } from "../diff-render";
import { element, emptyPanel } from "../dom-utils";

/**
 * 右侧 Changes 工具（对标 Cursor 的 Review 面板）：
 * 上半是文件列表（含 +N/−N、逐项接受/拒绝），点选后下半就地渲染该文件 diff，
 * 不用离开面板去开编辑器页；「在编辑器中打开」保留为次要入口。
 */

export interface ChangesPanelOptions {
  canApply: boolean;
  canRestore: boolean;
}

export interface ChangesPanelDeps {
  options: ChangesPanelOptions;
  /** 当前选中与 diff 装载状态；undefined = 尚未选中任何文件。 */
  selection: RailChangeState | undefined;
  /** 选中一个文件（会触发向宿主索取 diff 并重绘面板）。 */
  onSelect(changeId: string): void;
  post: Post;
}

export function renderChangesPanel(
  panel: HTMLElement,
  view: ChangeListView | undefined,
  deps: ChangesPanelDeps,
): void {
  panel.replaceChildren();
  panel.appendChild(element("div", "panel-title", "Changes"));
  if (!view || view.rows.length === 0) {
    panel.appendChild(emptyPanel("本轮暂无变更", "Agent 修改文件后，可在此查看 Diff 并接受或拒绝。"));
    return;
  }
  panel.appendChild(element("div", "session-meta", `本轮变更 ${view.rows.length} · ${view.statusLabel}`));

  // 没有选中时自动选第一个：打开面板就该看到内容，而不是一列名字。
  const selection = deps.selection;
  if (!selection) {
    deps.onSelect(view.rows[0]!.changeId);
    return;
  }

  const list = element("div", "change-rail-list");
  for (const row of view.rows) {
    const block = element("div", "change-row");
    if (row.changeId === selection.selectedId) block.classList.add("selected");
    block.appendChild(element("span", `change-letter letter-${row.letter}`, row.letter));

    const mid = element("button", "change-row-main");
    mid.type = "button";
    mid.appendChild(element("span", "change-path", row.relativePath));
    const lines = describeLineDiff(row.lines);
    if (lines && row.lines) {
      const badge = element("span", "change-summary-lines");
      badge.appendChild(element("span", "diff-added", `+${row.lines.added}`));
      badge.appendChild(element("span", "diff-removed", `-${row.lines.deleted}`));
      badge.title = lines;
      mid.appendChild(badge);
    }
    if (row.status !== "pending") {
      mid.appendChild(element("span", "change-summary-flag", row.statusLabel));
    }
    mid.addEventListener("click", () => deps.onSelect(row.changeId));
    block.appendChild(mid);

    const actions = element("div", "change-actions");
    if (row.status === "pending") {
      const accept = element("button", "link", "接受");
      accept.disabled = !deps.options.canApply;
      accept.addEventListener("click", () => deps.post({ type: "acceptChange", changeId: row.changeId }));
      const reject = element("button", "link reject", "拒绝");
      reject.disabled = !deps.options.canApply;
      reject.addEventListener("click", () => deps.post({ type: "rejectChange", changeId: row.changeId }));
      actions.append(accept, reject);
    }
    if (row.status === "conflict") {
      const conflict = element("button", "link reject", "冲突");
      conflict.addEventListener("click", () => deps.post({ type: "showConflict", changeId: row.changeId }));
      actions.appendChild(conflict);
    }
    block.appendChild(actions);
    list.appendChild(block);
  }
  panel.appendChild(list);

  panel.appendChild(renderDetail(view, selection, deps.post, deps.options.canApply));

  const footer = element("div", "panel-footer");
  const acceptAll = element("button", "btn-primary", "接受全部");
  acceptAll.disabled = !view.canAcceptAll || !deps.options.canApply;
  acceptAll.addEventListener("click", () => deps.post({ type: "acceptAll", turnId: view.turnId }));
  const rejectAll = element("button", "btn-danger", "拒绝全部");
  rejectAll.disabled = !view.canRejectAll || !deps.options.canApply;
  rejectAll.addEventListener("click", () => deps.post({ type: "rejectAll", turnId: view.turnId }));
  const undo = element("button", "btn-ghost", "撤销本轮");
  undo.disabled = !view.canUndo || !deps.options.canRestore;
  undo.addEventListener("click", () => deps.post({ type: "undoTurn", turnId: view.turnId }));
  footer.append(acceptAll, rejectAll, undo);
  panel.appendChild(footer);
}

/** 选中文件的 diff 区：装载中 / 出错 / 内容三态，底部带编辑器入口。 */
function renderDetail(view: ChangeListView, selection: RailChangeState, post: Post, canApply: boolean): HTMLElement {
  const detail = element("div", "change-rail-detail");
  const row = view.rows.find((item) => item.changeId === selection.selectedId);

  const head = element("div", "change-rail-detail-head");
  head.appendChild(element("span", "change-path", row?.relativePath ?? ""));
  const openEditor = element("button", "link", "在编辑器中打开");
  openEditor.type = "button";
  openEditor.addEventListener("click", () => post({ type: "openDiff", changeId: selection.selectedId }));
  head.appendChild(openEditor);
  detail.appendChild(head);

  const body = element("div", "change-rail-detail-body");
  if (selection.loading) {
    body.appendChild(element("div", "change-diff-hint", "正在读取改动…"));
  } else if (selection.error) {
    body.appendChild(element("div", "change-diff-hint", selection.error));
  } else if (selection.hunks && selection.hunks.length > 0 && canApply) {
    // Grok hunk-tracker 在线：逐块渲染，每块自带接受/拒绝（对标 Cursor 的分块审阅）。
    renderHunks(body, selection.hunks, selection.selectedId, post);
  } else if (selection.diff) {
    renderDiffText(body, selection.diff);
  } else {
    body.appendChild(element("div", "change-diff-hint", "没有可展示的改动。"));
  }
  detail.appendChild(body);
  return detail;
}

/** 逐 hunk 渲染：@@ 头 + 删除行 + 新增行，每块头部带接受/拒绝小按钮。 */
function renderHunks(body: HTMLElement, hunks: HunkView[], changeId: string, post: Post): void {
  body.appendChild(element("div", "change-diff-hint", `${hunks.length} 处改动，可逐块接受或拒绝。`));
  for (const hunk of hunks) {
    const block = element("div", "change-diff-hunk");

    const head = element("div", "change-diff-header hunk-head");
    const label = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    head.appendChild(element("span", "hunk-range", label));
    if (hunk.external) head.appendChild(element("span", "hunk-source", "手动改动"));
    const actions = element("span", "hunk-actions");
    const accept = element("button", "link", "接受");
    accept.type = "button";
    accept.addEventListener("click", () => post({ type: "hunkAction", changeId, hunkId: hunk.id, action: "accept" }));
    const reject = element("button", "link reject", "拒绝");
    reject.type = "button";
    reject.addEventListener("click", () => post({ type: "hunkAction", changeId, hunkId: hunk.id, action: "reject" }));
    actions.append(accept, reject);
    head.appendChild(actions);
    block.appendChild(head);

    appendHunkLines(block, hunk.oldText, "del", hunk.oldStart);
    appendHunkLines(block, hunk.newText, "add", hunk.newStart);
    body.appendChild(block);
  }
}

function appendHunkLines(block: HTMLElement, text: string, kind: "add" | "del", start: number): void {
  if (!text) return;
  const lines = text.replace(/\n$/, "").split("\n");
  lines.forEach((line, index) => {
    const record = element("div", `change-diff-line diff-${kind}`);
    record.appendChild(element("span", "change-diff-num", kind === "del" ? String(start + index) : ""));
    record.appendChild(element("span", "change-diff-num", kind === "add" ? String(start + index) : ""));
    record.appendChild(element("span", "change-diff-sign", kind === "add" ? "+" : "−"));
    record.appendChild(element("span", "change-diff-text", line));
    block.appendChild(record);
  });
}
