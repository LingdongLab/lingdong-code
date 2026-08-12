import type { ChangeListView, RailChangeState } from "../change-view";
import type {
  ComposerCapabilities,
  ContextItemView,
  SessionListItemView,
  UiAgentMode,
  UsageView,
  WebviewToHostMessage,
} from "../messages";
import type { ModelDescriptor } from "../model-registry";
import type { PlanCardView } from "../plan-view-model";
import type { BackgroundTaskView } from "../services/background-task-tracker";
import type { SubagentTaskView } from "../services/subagent-tracker";
import type { PlanRecord } from "../storage/plan-repository";
import type { UiState } from "../ui-state";

/**
 * Webview 的共享装配件：元素索引、可变视图状态与消息出口。
 * 各 UI 模块只读写这里的状态，不互相持有引用，main.ts 负责接线。
 */

export type Post = (message: WebviewToHostMessage) => void;

export const MODE_LABELS: Record<UiAgentMode, string> = {
  ask: "Ask",
  plan: "Plan",
  agent: "Agent",
  auto: "Auto",
  debug: "Debug",
};

export interface WorkspaceFileEntry {
  relativePath: string;
  directory: boolean;
}

export interface AppElements {
  shell: HTMLElement;
  openFolder: HTMLButtonElement;
  /** 仓库 → 会话统一树的挂载点。 */
  repoTree: HTMLElement;
  sessionSearch: HTMLInputElement;
  /** 左栏拖宽手柄。 */
  leftResize: HTMLElement;
  /** 左栏收起后的图标条按钮。 */
  leftMiniExpand: HTMLButtonElement;
  leftMiniNew: HTMLButtonElement;
  leftMiniSearch: HTMLButtonElement;
  leftMiniRepo: HTMLButtonElement;
  newSession: HTMLButtonElement;
  openSettings: HTMLButtonElement;
  showLogs: HTMLButtonElement;
  sessionTitle: HTMLElement;
  statusLine: HTMLElement;
  turnStatus: HTMLElement;
  turnStatusLabel: HTMLElement;
  turnStatusElapsed: HTMLElement;
  turnStatusSummary: HTMLElement;
  turnStatusActions: HTMLElement;
  taskProgress: HTMLButtonElement;
  /** 忙时发送队列 chips，挂在 composer 上方。 */
  queueChips: HTMLElement;
  toggleLeft: HTMLButtonElement;
  toggleRight: HTMLButtonElement;
  reconnect: HTMLButtonElement;
  messages: HTMLElement;
  messagesInner: HTMLElement;
  empty: HTMLElement;
  searchBar: HTMLElement;
  composerShell: HTMLElement;
  /** 拖文件悬停时盖在输入壳上的提示层（对齐 Cursor 的 Drop here to attach）。 */
  dropHint: HTMLElement;
  contextSuggest: HTMLElement;
  slashSuggest: HTMLElement;
  contextItems: HTMLElement;
  input: HTMLTextAreaElement;
  context: HTMLButtonElement;
  plusMenu: HTMLElement;
  /** 模式芯片：点击打开工作模式菜单（与「＋」添加上下文分开）。 */
  modeChip: HTMLButtonElement;
  /** 模式菜单独立成层，跟「＋」菜单互不覆盖定位。 */
  modeMenu: HTMLElement;
  modelBtn: HTMLButtonElement;
  modelName: HTMLElement;
  modelPopover: HTMLElement;
  usageLabel: HTMLButtonElement;
  usagePct: HTMLElement;
  usagePopover: HTMLElement;
  composerBar: HTMLElement;
  /** 发送/停止形态切换按钮：空闲=发送，任务执行中=停止。 */
  send: HTMLButtonElement;
  rightRail: HTMLElement;
  wbTabs: HTMLElement;
  wbClose: HTMLButtonElement;
  wbResize: HTMLElement;
  panelPlan: HTMLElement;
  panelTasks: HTMLElement;
  panelChanges: HTMLElement;
  panelContext: HTMLElement;
  panelFiles: HTMLElement;
  panelBrowser: HTMLElement;
  panelTerminal: HTMLElement;
  panelPreview: HTMLElement;
}

function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素：${id}`);
  return element as T;
}

export function queryElements(): AppElements {
  return {
    shell: need("app-shell"),
    openFolder: need<HTMLButtonElement>("open-folder"),
    repoTree: need("repo-tree"),
    sessionSearch: need<HTMLInputElement>("session-search"),
    leftResize: need("left-resize"),
    leftMiniExpand: need<HTMLButtonElement>("left-mini-expand"),
    leftMiniNew: need<HTMLButtonElement>("left-mini-new"),
    leftMiniSearch: need<HTMLButtonElement>("left-mini-search"),
    leftMiniRepo: need<HTMLButtonElement>("left-mini-repo"),
    newSession: need<HTMLButtonElement>("new-session"),
    openSettings: need<HTMLButtonElement>("open-settings"),
    showLogs: need<HTMLButtonElement>("show-logs"),
    sessionTitle: need("session-title"),
    statusLine: need("status-line"),
    turnStatus: need("turn-status"),
    turnStatusLabel: need("turn-status-label"),
    turnStatusElapsed: need("turn-status-elapsed"),
    turnStatusSummary: need("turn-status-summary"),
    turnStatusActions: need("turn-status-actions"),
    taskProgress: need<HTMLButtonElement>("task-progress"),
    queueChips: need("queue-chips"),
    toggleLeft: need<HTMLButtonElement>("toggle-left"),
    toggleRight: need<HTMLButtonElement>("toggle-right"),
    reconnect: need<HTMLButtonElement>("reconnect"),
    messages: need("messages"),
    messagesInner: need("messages-inner"),
    empty: need("empty"),
    searchBar: need("search-bar"),
    composerShell: need("composer-shell"),
    dropHint: need("drop-hint"),
    contextSuggest: need("context-suggest"),
    slashSuggest: need("slash-suggest"),
    contextItems: need("context-items"),
    input: need<HTMLTextAreaElement>("input"),
    context: need<HTMLButtonElement>("context"),
    plusMenu: need("plus-menu"),
    modeChip: need<HTMLButtonElement>("mode-chip"),
    modeMenu: need("mode-menu"),
    modelBtn: need<HTMLButtonElement>("model-btn"),
    modelName: need("model-btn").querySelector<HTMLElement>(".chip-model-name") as HTMLElement,
    modelPopover: need("model-popover"),
    usageLabel: need<HTMLButtonElement>("usage-label"),
    usagePct: need("usage-pct"),
    usagePopover: need("usage-popover"),
    composerBar: need("composer-bar"),
    send: need<HTMLButtonElement>("send"),
    rightRail: need("right-rail"),
    wbTabs: need("wb-tabs"),
    wbClose: need<HTMLButtonElement>("wb-close"),
    wbResize: need("wb-resize"),
    panelPlan: need("panel-plan"),
    panelTasks: need("panel-tasks"),
    panelChanges: need("panel-changes"),
    panelContext: need("panel-context"),
    panelFiles: need("panel-files"),
    panelBrowser: need("panel-browser"),
    panelTerminal: need("panel-terminal"),
    panelPreview: need("panel-preview"),
  };
}

/** 面板可变状态。所有渲染都从这里取值，避免各模块各存一份。 */
export interface AppState {
  mode: UiAgentMode;
  model: string;
  modelLabel: string;
  /** 宿主状态机状态；waiting_plan_approval 时计划操作必须先应答审批 RPC。 */
  uiState: UiState;
  busy: boolean;
  canSend: boolean;
  canCancel: boolean;
  canSwitchMode: boolean;
  /** 当前模型只支持 Ask；与 canSwitchMode 分开，两者的解释不一样。 */
  askOnly: boolean;
  askOnlyReason: string;
  canApplyChanges: boolean;
  canRestoreChanges: boolean;
  composerLine: string;
  /** 一轮任务主状态；Stop 按钮与 Status Bar 以此为准。 */
  turnCanStop: boolean;
  turnActive: boolean;
  /**
   * 与 Grok 的连接当前是断的。重连按钮只认这个，不认「刚才报过错」。
   *
   * 分开存是因为可恢复错误遍地都是（打开 Diff 失败、保存计划失败、权限回执失败……），
   * 拿它们当连接故障的信号，重连按钮会因为一次无关的失败常亮不灭。
   */
  connectionFailed: boolean;
  /** 忙时排队的消息（宿主为准的快照）。 */
  sendQueue: Array<{ id: string; text: string }>;
  contextItems: ContextItemView[];
  usage: UsageView | undefined;
  models: ModelDescriptor[];
  capabilities: ComposerCapabilities;
  sessions: SessionListItemView[];
  activeSessionId: string | undefined;
  sessionQuery: string;
  /** 仓库树需要 sessions 与 workspaces 两类消息合并驱动，所以两边的数据都存在这里。 */
  workspaces: {
    current?: { path: string; name: string };
    extraFolders?: Array<{ path: string; name: string }>;
    recent: Array<{ path: string; name: string }>;
  };
  latestChanges: ChangeListView | undefined;
  /** 右栏 Changes 面板的选中文件与 diff 装载状态。 */
  railChange: RailChangeState | undefined;
  activePlan: PlanRecord | undefined;
  planCardView: PlanCardView | undefined;
  /**
   * 执行期 Grok 实时推送的 todo 清单；有值时 Tasks 优先展示它（对标 Cursor 进度）。
   * 计划正文保存或会话清空时置空。
   */
  liveTaskSteps: Array<{ title: string; status: string }> | undefined;
  /** 子 Agent 并行任务；与计划步骤同处 Tasks 面板，各占一段。 */
  subagentTasks: SubagentTaskView[];
  /** 后台任务（background shell / monitor）；跨轮存活的常驻卡。 */
  backgroundTasks: BackgroundTaskView[];
  planEditing: boolean;
  files: {
    items: WorkspaceFileEntry[];
    query: string;
    truncated: boolean;
    matched: number | undefined;
    scanLimit: number | undefined;
  };
}

export function createAppState(): AppState {
  return {
    mode: "ask",
    model: "deepseek-v4-flash",
    modelLabel: "DeepSeek V4 Flash",
    uiState: "idle",
    busy: false,
    canSend: true,
    canCancel: false,
    canSwitchMode: true,
    askOnly: false,
    askOnlyReason: "",
    canApplyChanges: true,
    canRestoreChanges: true,
    composerLine: "",
    turnCanStop: false,
    turnActive: false,
    connectionFailed: false,
    sendQueue: [],
    contextItems: [],
    usage: undefined,
    models: [],
    capabilities: {
      skillsConfigured: false,
      mcpConfigured: false,
      imagesConfigured: false,
      autoSelectModels: false,
      hasVisionModel: false,
    },
    sessions: [],
    activeSessionId: undefined,
    sessionQuery: "",
    workspaces: { recent: [] },
    latestChanges: undefined,
    railChange: undefined,
    activePlan: undefined,
    planCardView: undefined,
    liveTaskSteps: undefined,
    subagentTasks: [],
    backgroundTasks: [],
    planEditing: false,
    files: { items: [], query: "", truncated: false, matched: undefined, scanLimit: undefined },
  };
}
