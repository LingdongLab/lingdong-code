/**
 * 右侧 Dynamic Workbench 纯 UI 状态。
 * 仅存 webview getState/setState，不写入 AgentWorkspaceStore。
 */

export const WORKBENCH_TOOLS = [
  "changes",
  "files",
  "tasks",
  "context",
  "browser",
  "terminal",
  "preview",
  "plan",
] as const;

export type WorkbenchTool = (typeof WORKBENCH_TOOLS)[number];

export interface WorkbenchState {
  collapsed: boolean;
  width: number;
  activeTool: WorkbenchTool | null;
  openTools: WorkbenchTool[];
  /** 用户主动固定展开时为 true；关闭后本会话不再自动抢开。 */
  userPinned: boolean;
  lastActiveTool: WorkbenchTool | null;
  /** 用户本会话手动关闭后为 true，抑制自动展开。 */
  suppressAutoOpen: boolean;
}

export const WORKBENCH_MIN_WIDTH = 280;
export const WORKBENCH_DEFAULT_WIDTH = 348;

export const TOOL_META: Record<
  WorkbenchTool,
  { label: string; enabled: boolean; hostAction?: "terminal" | "browser"; note?: string }
> = {
  changes: { label: "Changes", enabled: true },
  files: { label: "Files", enabled: true },
  tasks: { label: "Tasks", enabled: true },
  context: { label: "Context", enabled: true },
  browser: { label: "Browser", enabled: true, hostAction: "browser" },
  terminal: { label: "Terminal", enabled: true, hostAction: "terminal" },
  preview: { label: "Preview", enabled: false, note: "暂未配置" },
  plan: { label: "Plan", enabled: true },
};

export function defaultWorkbenchState(): WorkbenchState {
  return {
    collapsed: true,
    width: WORKBENCH_DEFAULT_WIDTH,
    activeTool: null,
    openTools: [],
    userPinned: false,
    lastActiveTool: null,
    suppressAutoOpen: false,
  };
}

export function isWorkbenchTool(value: unknown): value is WorkbenchTool {
  return typeof value === "string" && (WORKBENCH_TOOLS as readonly string[]).includes(value);
}

export function clampWorkbenchWidth(width: number, windowWidth: number): number {
  const max = Math.max(WORKBENCH_MIN_WIDTH, Math.floor(windowWidth * 0.5));
  return Math.min(max, Math.max(WORKBENCH_MIN_WIDTH, Math.round(width)));
}

export const LEFT_MIN_WIDTH = 200;
export const LEFT_DEFAULT_WIDTH = 256;

/** 左栏最多吃掉窗口的 40%，否则中间对话会被挤到没法读。 */
export function clampLeftWidth(width: number, windowWidth: number): number {
  const max = Math.max(LEFT_MIN_WIDTH, Math.floor(windowWidth * 0.4));
  return Math.min(max, Math.max(LEFT_MIN_WIDTH, Math.round(width)));
}

/** 从 webview state 中解析并合并 Workbench 字段。 */
export function readWorkbenchState(raw: unknown): WorkbenchState {
  const base = defaultWorkbenchState();
  if (!raw || typeof raw !== "object") return base;
  const data = raw as Record<string, unknown>;
  const wb = (data.workbench && typeof data.workbench === "object"
    ? data.workbench
    : data) as Record<string, unknown>;

  const openTools = Array.isArray(wb.openTools)
    ? wb.openTools.filter((t): t is WorkbenchTool => isWorkbenchTool(t) && TOOL_META[t].enabled)
    : base.openTools;
  const active =
    isWorkbenchTool(wb.activeTool) && TOOL_META[wb.activeTool].enabled ? wb.activeTool : null;
  const last =
    isWorkbenchTool(wb.lastActiveTool) && TOOL_META[wb.lastActiveTool].enabled
      ? wb.lastActiveTool
      : null;
  const width = typeof wb.width === "number" && Number.isFinite(wb.width) ? wb.width : base.width;

  const activeTool = active && openTools.includes(active) ? active : (openTools[openTools.length - 1] ?? null);
  const collapsed = openTools.length === 0 ? true : wb.collapsed === false ? false : true;
  return {
    collapsed,
    width,
    activeTool: collapsed ? null : activeTool,
    openTools,
    userPinned: wb.userPinned === true && !collapsed,
    lastActiveTool: last,
    suppressAutoOpen: wb.suppressAutoOpen === true,
  };
}

export function openTool(state: WorkbenchState, tool: WorkbenchTool): WorkbenchState {
  if (!TOOL_META[tool].enabled) return state;
  const openTools = state.openTools.includes(tool) ? state.openTools : [...state.openTools, tool];
  return {
    ...state,
    collapsed: false,
    userPinned: true,
    suppressAutoOpen: false,
    activeTool: tool,
    openTools,
    lastActiveTool: tool,
  };
}

export function closeTool(state: WorkbenchState, tool: WorkbenchTool): WorkbenchState {
  const openTools = state.openTools.filter((t) => t !== tool);
  const activeTool = state.activeTool === tool ? (openTools[openTools.length - 1] ?? null) : state.activeTool;
  const collapsed = openTools.length === 0;
  return {
    ...state,
    openTools,
    activeTool,
    collapsed,
    userPinned: !collapsed && state.userPinned,
    suppressAutoOpen: collapsed ? true : state.suppressAutoOpen,
    lastActiveTool: tool,
  };
}

export function closeWorkbench(state: WorkbenchState): WorkbenchState {
  return {
    ...state,
    collapsed: true,
    userPinned: false,
    suppressAutoOpen: true,
    activeTool: null,
  };
}

/** 自动建议展开：仅当用户未手动关闭、且未固定拒绝时。 */
export function suggestOpenTool(state: WorkbenchState, tool: WorkbenchTool): WorkbenchState {
  if (!TOOL_META[tool].enabled) return state;
  if (state.suppressAutoOpen) return state;
  if (state.userPinned && !state.collapsed) {
    // 已展开时切换到建议工具（加入 openTools）
    return openTool({ ...state, userPinned: state.userPinned }, tool);
  }
  if (state.collapsed && !state.userPinned) {
    const openTools = state.openTools.includes(tool) ? state.openTools : [...state.openTools, tool];
    return {
      ...state,
      collapsed: false,
      activeTool: tool,
      openTools,
      lastActiveTool: tool,
    };
  }
  return openTool(state, tool);
}
