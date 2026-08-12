import type { SessionListItemView } from "../messages";
import type { Post } from "./app-context";
import { element, relativeTime } from "./dom-utils";

/**
 * 左栏的「仓库 → 会话」统一树。
 *
 * 对齐 Cursor Agents 的 Repositories：
 * - 仓库是扁平列表，当前仓库展开后下面只挂它自己的会话；
 * - 其它仓库各占一行，点一下切过去；
 * - 不把「编辑器里还开着的文件夹」嵌进当前仓库——那会看起来像子项，
 *   一点就整仓切换，用户感觉「点里面却跳到外面去了」。
 *
 * 跨仓库的会话不做索引：那需要遍历所有仓库的存储目录，收益不抵复杂度。
 */

export interface RepoTreeView {
  /** 当前活动仓库，会话按它归档。还没选过时缺省。 */
  current?: { path: string; name: string };
  /**
   * @deprecated 不再嵌进当前节点。宿主仍可能下发，渲染时忽略，
   * 其它根应已合并进 recent。
   */
  extraFolders?: Array<{ path: string; name: string }>;
  /** 其它仓库（最近用过的 + 编辑器里还开着的），扁平列在当前下面。 */
  recent: Array<{ path: string; name: string }>;
  sessions: SessionListItemView[];
  activeSessionId?: string;
  /** 正在跑任务的会话；只用于列表上的脉冲点，不参与排序。 */
  runningSessionId?: string;
  /** 搜索词非空时不折叠任何东西，避免"搜到了却看不见"。 */
  query?: string;
}

/** 展开/折叠状态由调用方持有，否则每次收到 sessions 消息都会弹回默认值。 */
export interface RepoTreeState {
  currentExpanded: boolean;
  showArchived: boolean;
  /** 时间分组的折叠状态，键是分组 id。缺省即展开。 */
  collapsedGroups: Record<string, boolean>;
}

export function createRepoTreeState(): RepoTreeState {
  return { currentExpanded: true, showArchived: false, collapsedGroups: {} };
}

export interface SessionGroup {
  id: string;
  label: string;
  sessions: SessionListItemView[];
}

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 会话按时间分段（对标 Cursor 的历史列表）。
 * 固定项单独成组置顶，其余按 updatedAt 落进今天/昨天/本周/更早。
 * 空组不返回，避免窄栏里堆一串只有标题的段头。
 */
export function groupSessions(
  sessions: readonly SessionListItemView[],
  now = Date.now(),
): SessionGroup[] {
  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  const weekAgo = today - 6 * DAY_MS;

  const buckets: SessionGroup[] = [
    { id: "pinned", label: "固定", sessions: [] },
    { id: "today", label: "今天", sessions: [] },
    { id: "yesterday", label: "昨天", sessions: [] },
    { id: "week", label: "本周", sessions: [] },
    { id: "older", label: "更早", sessions: [] },
  ];
  const by = (id: string): SessionGroup => buckets.find((group) => group.id === id) as SessionGroup;

  // 宿主已按 updatedAt 倒序给出，这里只分桶不重排，保持同组内的既有顺序。
  for (const session of sessions) {
    if (session.pinned) by("pinned").sessions.push(session);
    else if (session.updatedAt >= today) by("today").sessions.push(session);
    else if (session.updatedAt >= yesterday) by("yesterday").sessions.push(session);
    else if (session.updatedAt >= weekAgo) by("week").sessions.push(session);
    else by("older").sessions.push(session);
  }
  return buckets.filter((group) => group.sessions.length > 0);
}

function sessionMeta(session: SessionListItemView): string {
  return [
    relativeTime(session.updatedAt),
    session.pendingChanges > 0 ? `${session.pendingChanges} 个变更` : undefined,
    session.conflictChanges > 0 ? `${session.conflictChanges} 个冲突` : undefined,
    session.hasUnfinishedPlan ? "未完成计划" : undefined,
  ].filter(Boolean).join(" · ");
}

function caret(open: boolean): HTMLElement {
  const mark = element("span", "repo-caret", open ? "▾" : "▸");
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

function removeButton(
  path: string,
  label: string,
  post: Post,
): HTMLButtonElement {
  const button = element("button", "repo-remove", "×");
  button.type = "button";
  button.title = `从列表移除「${label}」`;
  button.setAttribute("aria-label", `从列表移除 ${label}`);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    post({ type: "removeWorkspace", path });
  });
  return button;
}

function renderSessionRow(
  session: SessionListItemView,
  activeSessionId: string | undefined,
  post: Post,
  runningSessionId?: string,
): HTMLElement {
  const row = element("div", "repo-session-row");
  const item = element("button", `repo-session${session.id === activeSessionId ? " active" : ""}`);
  item.type = "button";
  item.title = session.title;

  const label = element("span", "repo-session-label");
  if (session.id === runningSessionId) {
    const dot = element("span", "repo-session-dot");
    dot.title = "正在运行";
    dot.setAttribute("aria-label", "正在运行");
    label.appendChild(dot);
  }
  // 固定项用图钉标记而不是单独一个分组：分组头在窄栏里占掉的高度比它承载的信息多。
  if (session.pinned) {
    const pin = element("span", "repo-session-pin", "📌");
    pin.setAttribute("aria-label", "已固定");
    label.appendChild(pin);
  }
  label.appendChild(element("span", "repo-session-title", session.title));
  // 冲突要在收起的列表里就能看见，光靠 meta 那行灰字会被忽略。
  if (session.conflictChanges > 0) {
    const badge = element("span", "repo-session-badge conflict", String(session.conflictChanges));
    badge.title = `${session.conflictChanges} 个文件有冲突`;
    label.appendChild(badge);
  } else if (session.pendingChanges > 0) {
    const badge = element("span", "repo-session-badge", String(session.pendingChanges));
    badge.title = `${session.pendingChanges} 个待处理变更`;
    label.appendChild(badge);
  }
  item.appendChild(label);
  item.appendChild(element("span", "repo-session-meta", sessionMeta(session)));
  item.addEventListener("click", () => post({ type: "loadSession", sessionId: session.id }));

  const openMenu = (): void => post({ type: "openSessionMenu", sessionId: session.id });
  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu();
  });

  const more = element("button", "repo-session-more", "⋯");
  more.type = "button";
  more.title = "会话操作";
  more.setAttribute("aria-label", `${session.title} 的操作`);
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu();
  });

  row.append(item, more);
  return row;
}

function renderCurrentRepo(
  view: RepoTreeView,
  state: RepoTreeState,
  post: Post,
  rerender: () => void,
): HTMLElement {
  const current = view.current;
  const node = element("div", "repo-node current");

  const headRow = element("div", "repo-head-row");
  const head = element("button", "repo-head");
  head.type = "button";
  head.title = current?.path ?? "未选择仓库";
  head.setAttribute("aria-expanded", String(state.currentExpanded));
  head.appendChild(caret(state.currentExpanded));
  head.appendChild(element("span", "repo-name", current?.name ?? "未选择仓库"));

  const live = view.sessions.filter((session) => !session.archived);
  const archived = view.sessions.filter((session) => session.archived);
  head.appendChild(element("span", "repo-count", String(live.length)));
  head.addEventListener("click", () => {
    state.currentExpanded = !state.currentExpanded;
    rerender();
  });
  headRow.appendChild(head);
  if (current) headRow.appendChild(removeButton(current.path, current.name, post));
  node.appendChild(headRow);

  if (!state.currentExpanded) return node;

  // 当前仓库下面只挂会话——跟 Cursor 一样。其它仓库是兄弟节点，不嵌在这里。
  const body = element("div", "repo-sessions");
  if (!current) {
    body.appendChild(element("div", "repo-hint", "先选一个文件夹作为仓库，对话会保存在它下面。"));
  } else if (live.length === 0 && archived.length === 0) {
    body.appendChild(element(
      "div",
      "repo-hint",
      view.query ? "没有匹配的对话。" : "还没有对话，点上面的「新建对话」开始。",
    ));
  }

  // 固定项置顶，其余按时间分段。搜索时不折叠任何段，否则「搜到了却看不见」。
  const searching = !!view.query;
  for (const group of groupSessions(live)) {
    const collapsed = !searching && !!state.collapsedGroups[group.id];
    const header = element("button", "repo-group-head");
    header.type = "button";
    header.setAttribute("aria-expanded", String(!collapsed));
    header.dataset.group = group.id;
    header.appendChild(caret(!collapsed));
    header.appendChild(element("span", "repo-section-title", group.label));
    header.appendChild(element("span", "repo-count", String(group.sessions.length)));
    header.addEventListener("click", () => {
      state.collapsedGroups[group.id] = !collapsed;
      rerender();
    });
    body.appendChild(header);
    if (collapsed) continue;
    for (const session of group.sessions) {
      body.appendChild(
        renderSessionRow(session, view.activeSessionId, post, view.runningSessionId),
      );
    }
  }

  if (archived.length > 0) {
    const toggle = element(
      "button",
      "repo-archived-toggle",
      `${state.showArchived ? "▾" : "▸"} 已归档 ${archived.length}`,
    );
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      state.showArchived = !state.showArchived;
      rerender();
    });
    body.appendChild(toggle);
    if (state.showArchived) {
      for (const session of archived) {
        const row = renderSessionRow(session, view.activeSessionId, post);
        row.classList.add("archived");
        body.appendChild(row);
      }
    }
  }

  node.appendChild(body);
  return node;
}

/**
 * 对标 Cursor：点其它仓库时先本地换皮，再通知宿主。
 * 宿主确认后的 workspaces/clear/sessions 会再校准一次。
 */
export interface RepoTreeHandlers {
  post: Post;
  /** 点击其它仓库：乐观切到该条目（可同步改 AppState 并重画）。 */
  onSwitchWorkspace?: (entry: { path: string; name: string }) => void;
}

function renderOtherRepo(
  entry: { path: string; name: string },
  handlers: RepoTreeHandlers,
): HTMLElement {
  const node = element("div", "repo-node");
  const headRow = element("div", "repo-head-row");
  const head = element("button", "repo-head");
  head.type = "button";
  head.title = `${entry.path}\n切换到这个仓库`;
  head.appendChild(caret(false));
  head.appendChild(element("span", "repo-name", entry.name));
  head.addEventListener("click", () => {
    handlers.onSwitchWorkspace?.(entry);
    handlers.post({ type: "switchWorkspace", path: entry.path });
  });
  headRow.append(head, removeButton(entry.path, entry.name, handlers.post));
  node.appendChild(headRow);
  return node;
}

export function renderRepoTree(
  container: HTMLElement,
  view: RepoTreeView,
  state: RepoTreeState,
  post: Post,
  onSwitchWorkspace?: (entry: { path: string; name: string }) => void,
): void {
  const handlers: RepoTreeHandlers = { post, ...(onSwitchWorkspace ? { onSwitchWorkspace } : {}) };
  const rerender = (): void => renderRepoTree(container, view, state, post, onSwitchWorkspace);
  container.replaceChildren();
  container.appendChild(renderCurrentRepo(view, state, post, rerender));
  for (const entry of view.recent) container.appendChild(renderOtherRepo(entry, handlers));
  if (view.recent.length === 0 && view.current) {
    container.appendChild(element("div", "repo-hint muted", "还没有用过其它仓库"));
  }
}
