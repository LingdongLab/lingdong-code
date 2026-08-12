import "./main.css";
import "./message-markdown.css";
import "./plan/plan.css";
import "./timeline/timeline.css";
import "./suggestion-popup.css";
import "./conversation-search.css";
import { parseFileUriList } from "../dropped-file";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../messages";
import { createAppState, queryElements, type Post } from "./app-context";
import { ComposerView } from "./composer";
import { ContextSuggestions } from "./composer/context-suggestions";
import { SlashSuggestions } from "./composer/slash-suggestions";
import { ConversationSearch, createSearchBar } from "./conversation-search";
import { ConversationView } from "./conversation";
import { MessageRouter } from "./message-router";
import { TodoCardView } from "./todo-card";
import { TurnStatusBar } from "./turn-status-bar";
import { PlanController } from "./plan-controller";
import { readWorkbenchState, type WorkbenchTool } from "./workbench-state";
import { renderChangesPanel } from "./workbench/changes-panel";
import { renderContextPanel } from "./workbench/context-panel";
import { renderFilesPanel } from "./workbench/files-panel";
import { renderTasksPanel } from "./workbench/tasks-panel";
import { WorkbenchView, type LayoutState } from "./workbench/workbench-view";

/**
 * Agent 主面板入口：只做装配与事件接线。
 * 具体渲染在 conversation / composer / repo-tree / plan / workbench 各模块中。
 */

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const SESSION_SEARCH_DEBOUNCE_MS = 200;

const vscode = acquireVsCodeApi();
const post: Post = (message) => vscode.postMessage(message);

const el = queryElements();
const state = createAppState();

const persisted = (typeof vscode.getState() === "object" && vscode.getState()
  ? vscode.getState()
  : {}) as LayoutState;
const layout: LayoutState = {
  ...(typeof persisted.leftCollapsed === "boolean" ? { leftCollapsed: persisted.leftCollapsed } : {}),
  ...(typeof persisted.leftPinned === "boolean" ? { leftPinned: persisted.leftPinned } : {}),
  ...(typeof persisted.leftWidth === "number" ? { leftWidth: persisted.leftWidth } : {}),
};

const conversation = new ConversationView({
  el,
  post,
  canSend: () => state.canSend,
  onOpenLink: (href) => post({ type: "openExternalUrl", url: href }),
  onOpenFile: (ref) => post({
    type: "openWorkspaceFile",
    relativePath: ref.relativePath,
    ...(ref.line ? { line: ref.line } : {}),
  }),
  onViewPlan: () => {
    workbench.open("plan");
    plan.cardElement?.scrollIntoView({ block: "nearest" });
  },
});

const composer = new ComposerView({
  el,
  state,
  post,
  notice: (text) => conversation.appendRow("notice info", text),
  openWorkbenchTool: (tool) => workbench.open(tool),
  // Slash 命令绝不作为普通消息发给模型：命中即在这里被消费。
  interceptSubmit: () => slash.consumeSubmit(),
  closeExtraPopovers: () => {
    const had = suggestions.isOpen || slash.isOpen;
    suggestions.close();
    slash.close();
    return had;
  },
  onSend: (text) => {
    conversation.noteStopRequested(false);
    post({ type: "sendPrompt", text });
  },
});

const suggestions = new ContextSuggestions({
  input: el.input,
  root: el.contextSuggest,
  post,
});

const slash = new SlashSuggestions({
  input: el.input,
  root: el.slashSuggest,
  post,
  state: () => ({
    canSwitchMode: state.canSwitchMode,
    canCancel: state.canCancel,
    canSend: state.canSend,
  }),
  notice: (text) => conversation.appendRow("notice info", text),
  onClientAction: (action) => {
    if (action === "retry") conversation.retryLast();
    else if (action === "openChanges") workbench.open("changes");
    else if (action === "openFiles") workbench.open("files");
  },
  onPrompt: (text) => {
    conversation.noteStopRequested(false);
    post({ type: "sendPrompt", text });
  },
});

const search = new ConversationSearch({
  root: el.searchBar,
  ...createSearchBar(el.searchBar),
  records: () => conversation.searchableRecords(),
  reveal: (record) => conversation.revealRecord(record),
  onClose: () => composer.focus(),
  scrollTop: () => el.messages.scrollTop,
  restoreScroll: (top) => { el.messages.scrollTop = top; },
});

const plan = new PlanController({
  el,
  state,
  post,
  appendNode: (node) => conversation.appendNode(node),
  notice: (text) => conversation.appendRow("notice info", text),
  fillComposer: (text) => composer.fill(text),
  openPlanTool: () => workbench.open("plan"),
  isPlanToolOpen: () => workbench.isOpen("plan"),
  refreshTool: (tool) => workbench.refresh(tool),
});

const workbench = new WorkbenchView(
  {
    el,
    post,
    layout,
    persist: (next) => vscode.setState(next),
    renderTool: (tool) => paintTool(tool),
    // 打开 Files 时才向宿主要一次列表；重绘不再触发请求，避免来回刷新。
    onActivate: (tool) => {
      if (tool === "files") requestFiles(state.files.query);
    },
  },
  readWorkbenchState(persisted.workbench ?? persisted),
);

function paintTool(tool: WorkbenchTool): void {
  switch (tool) {
    case "plan":
      plan.renderRight();
      return;
    case "tasks":
      renderTasksPanel(el.panelTasks, {
        ...(state.activePlan ? { plan: state.activePlan } : {}),
        ...(state.liveTaskSteps ? { liveSteps: state.liveTaskSteps } : {}),
        subagents: state.subagentTasks,
        backgroundTasks: state.backgroundTasks,
      }, post);
      return;
    case "changes":
      renderChangesPanel(el.panelChanges, state.latestChanges, {
        options: {
          canApply: state.canApplyChanges,
          canRestore: state.canRestoreChanges,
        },
        selection: state.railChange,
        onSelect: (changeId) => openChangeInRail(changeId),
        post,
      });
      return;
    case "context":
      renderContextPanel(el.panelContext, state.contextItems, state.usage, post);
      return;
    case "files":
      renderFilesPanel(el.panelFiles, state.files, post, (query) => requestFiles(query));
      return;
    default:
      return;
  }
}

function requestFiles(query: string): void {
  state.files = { ...state.files, query };
  post({ type: "listWorkspaceFiles", ...(query ? { query } : {}) });
}

/**
 * 在右栏 Changes 面板里查看某个文件的改动（对标 Cursor：点卡片行 → 右侧看内容）。
 * 选中即向宿主要 diff；面板未开则顺手打开。changeId 为空时只开面板（自动选第一个）。
 */
function openChangeInRail(changeId: string | undefined): void {
  if (changeId) {
    state.railChange = { selectedId: changeId, loading: true };
    post({ type: "requestChangeDiff", changeId });
  }
  workbench.open("changes");
}

const turnStatus = new TurnStatusBar({
  el: {
    root: el.turnStatus,
    label: el.turnStatusLabel,
    elapsed: el.turnStatusElapsed,
    summary: el.turnStatusSummary,
    actions: el.turnStatusActions,
  },
  onReconnect: () => post({ type: "reconnect" }),
  onRetry: () => conversation.retryLast(),
  onViewChanges: () => {
    const first = state.latestChanges?.rows[0];
    if (first) openChangeInRail(first.changeId);
  },
});

const todo = new TodoCardView({
  mount: (node) => {
    conversation.sealStreaming();
    conversation.appendNode(node);
  },
  progress: el.taskProgress,
});

const router = new MessageRouter({
  el,
  state,
  post,
  conversation,
  composer,
  plan,
  workbench,
  turnStatus,
  todo,
  refreshTool: (tool) => workbench.refresh(tool),
  requestFiles,
  onSuggestResults: (query, groups, truncated) => suggestions.applyResults(query, groups, truncated),
  openChangeInRail: (changeId) => openChangeInRail(changeId),
});

function requestStop(): void {
  if (!state.canCancel && !state.turnCanStop) return;
  conversation.noteStopRequested(true);
  // 立刻切换到「正在停止」观感：宿主随后会推 turnStatus=stopping。
  state.turnCanStop = false;
  composer.updateChrome();
  post({ type: "stop" });
}

// —— 事件接线 ——
el.newSession.addEventListener("click", () => post({ type: "newSession" }));
el.openFolder.addEventListener("click", () => post({ type: "openFolder" }));
el.openSettings.addEventListener("click", () => post({ type: "openSettings" }));
el.showLogs.addEventListener("click", () => post({ type: "showLogs" }));
el.reconnect.addEventListener("click", () => post({ type: "reconnect" }));
el.send.addEventListener("click", () => {
  if (state.busy || state.turnActive) requestStop();
  else composer.submit();
});

// 每敲一个字就往宿主发一次检索，会话多时列表会一直闪。200ms 静默后再发。
let searchTimer: ReturnType<typeof setTimeout> | undefined;
el.sessionSearch.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = undefined;
    post({ type: "searchSessions", query: el.sessionSearch.value });
  }, SESSION_SEARCH_DEBOUNCE_MS);
});
el.sessionSearch.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== "Escape") return;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = undefined;
  if (event.key === "Escape") el.sessionSearch.value = "";
  post({ type: "searchSessions", query: el.sessionSearch.value });
});

function expandLeft(): void {
  layout.leftCollapsed = false;
  layout.leftPinned = true;
  workbench.save();
}

el.leftMiniExpand.addEventListener("click", expandLeft);
el.leftMiniRepo.addEventListener("click", expandLeft);
el.leftMiniNew.addEventListener("click", () => post({ type: "newSession" }));
el.leftMiniSearch.addEventListener("click", () => {
  expandLeft();
  el.sessionSearch.focus();
});

// 对标 Cursor：＋ 只加上下文；模式芯片只切 Ask/Plan/Agent…
el.context.addEventListener("click", (event) => {
  event.stopPropagation();
  composer.togglePlusMenu();
});
el.modeChip.addEventListener("click", (event) => {
  event.stopPropagation();
  composer.toggleModeMenu();
});
el.plusMenu.addEventListener("click", (event) => composer.handlePlusMenuClick(event.target));
el.modeMenu.addEventListener("click", (event) => composer.handlePlusMenuClick(event.target));
el.modelBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  composer.toggleModelPopover();
});
el.usageLabel.addEventListener("click", (event) => {
  event.stopPropagation();
  composer.toggleUsagePopover();
});
el.usagePopover.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => composer.closeAllPopovers());

el.toggleLeft.addEventListener("click", () => {
  layout.leftCollapsed = !layout.leftCollapsed;
  layout.leftPinned = !layout.leftCollapsed;
  workbench.save();
});
el.toggleRight.addEventListener("click", () => workbench.toggle());
el.wbClose.addEventListener("click", () => workbench.closeAll());
for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>(".left-tool"))) {
  button.addEventListener("click", () => {
    const tool = button.dataset.tool as WorkbenchTool | undefined;
    if (tool) workbench.open(tool);
  });
}
workbench.bindResize();

el.input.addEventListener("input", () => {
  composer.autoResize();
  suggestions.handleInput();
  slash.handleInput();
});
el.input.addEventListener("keydown", (event) => {
  // 建议浮层优先吃掉 上下 / Enter / Tab / Escape，否则 Enter 会直接发送。
  if (suggestions.handleKeydown(event)) return;
  if (slash.handleKeydown(event)) return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (composer.recallPrompt(event.key === "ArrowUp" ? "up" : "down")) event.preventDefault();
    return;
  }
  if (event.key !== "Enter") return;
  if (event.ctrlKey || event.metaKey || !event.shiftKey) {
    event.preventDefault();
    composer.submit();
  }
});

el.input.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (composer.handleImageDrop(files)) event.preventDefault();
});

/**
 * 拖放接到会话区 / 输入壳 / 整页，三路分发：
 * 1. 应用内拖拽（编辑器标签 / 资源管理器）带 uri-list → 交宿主按路径加上下文；
 * 2. 系统资源管理器拖入的图片 → 走看图附件；
 * 3. 其余文件 → 读名字和内容交宿主按名字还原仓库路径。
 *
 * 前提是 Code-OSS 侧的拖放策略已反转（默认交给 webview，按住 Shift 才让编辑器
 * 打开文件）：源码补丁在 desktop/vscode 的 webviewWindowDragMonitor.ts，
 * 已打包的产物用 desktop/scripts/patch-webview-drag.mjs 就地翻转。
 * 没有那一层时 webview 在拖文件期间 pointer-events 被关掉，这里一个事件都收不到。
 */
const URI_LIST_TYPES = ["application/vnd.code.uri-list", "text/uri-list"];

function droppedUris(drag: DragEvent): string[] {
  for (const type of URI_LIST_TYPES) {
    const raw = drag.dataTransfer?.getData(type) ?? "";
    if (!raw) continue;
    const uris = parseFileUriList(raw);
    if (uris.length > 0) return uris.slice(0, 20);
  }
  return [];
}

/** 拖拽悬停提示：dragover 连续触发期间常亮，事件停了（离开/放下/取消）自动熄。
    比数 dragenter/dragleave 可靠——后者在子元素间移动时会乱序成对触发。 */
let dropHintTimer: number | undefined;

function showDropHint(): void {
  el.dropHint.hidden = false;
  el.composerShell.classList.add("drop-target");
  if (dropHintTimer !== undefined) window.clearTimeout(dropHintTimer);
  dropHintTimer = window.setTimeout(hideDropHint, 250);
}

function hideDropHint(): void {
  if (dropHintTimer !== undefined) {
    window.clearTimeout(dropHintTimer);
    dropHintTimer = undefined;
  }
  el.dropHint.hidden = true;
  el.composerShell.classList.remove("drop-target");
}

function bindDropTarget(target: HTMLElement | Document): void {
  target.addEventListener("dragover", (event) => {
    const drag = event as DragEvent;
    const types = Array.from(drag.dataTransfer?.types ?? []);
    if (!types.includes("Files") && !URI_LIST_TYPES.some((type) => types.includes(type))) return;
    drag.preventDefault();
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = "copy";
    showDropHint();
  });
  target.addEventListener("drop", (event) => {
    const drag = event as DragEvent;
    hideDropHint();
    const uris = droppedUris(drag);
    if (uris.length > 0) {
      post({ type: "addDroppedUris", uris });
      drag.preventDefault();
      drag.stopPropagation();
      return;
    }
    const files = Array.from(drag.dataTransfer?.files ?? []);
    const tookImages = composer.handleImageDrop(files);
    const tookFiles = composer.handleFileDrop(files);
    if (!tookImages && !tookFiles) return;
    drag.preventDefault();
    drag.stopPropagation();
  });
}
bindDropTarget(el.composerShell);
bindDropTarget(el.messages);
bindDropTarget(document);

document.addEventListener("keydown", (event) => {
  const chord = event.ctrlKey || event.metaKey;
  if (chord && !event.altKey && event.key.toLowerCase() === "f") {
    // 面板未启用 findWidget，这里接管不会影响编辑器的全局查找。
    event.preventDefault();
    search.show();
    return;
  }
  if (event.key === "Escape") {
    if (search.handleKeydown(event)) return;
    const hadPopover = composer.closeAllPopovers();
    if (!hadPopover && (state.canCancel || state.turnCanStop)) {
      event.preventDefault();
      requestStop();
    }
    return;
  }
  if (chord && !event.altKey && event.key.toLowerCase() === "i") {
    event.preventDefault();
    composer.focus();
    return;
  }
  if (chord && event.altKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    post({ type: "newSession" });
  }
});

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  router.apply(event.data);
  // 会话内容变化后刷新命中，避免查找条停在过时的结果上。
  search.refresh();
});

// 启动时强制关闭浮层，避免 display 覆盖 [hidden] 留下空白气泡。
composer.closeAllPopovers();
composer.renderContextChips();
workbench.save();
// 恢复上次留在右侧的工具内容；Terminal / Browser 不在启动时触发宿主命令。
const restoredTool = workbench.collapsed ? undefined : workbench.state.activeTool;
if (restoredTool) {
  paintTool(restoredTool);
  if (restoredTool === "files") requestFiles(state.files.query);
}
composer.updateChrome();
composer.autoResize();
composer.observeWidth();
post({ type: "ready" });
