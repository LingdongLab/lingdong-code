/**
 * 最近用过的工作区。
 *
 * 只记灵动 Code 自己打开过的文件夹，不去读 VS Code 的系统最近列表——
 * 那个列表没有稳定的公开接口，能拿到它的命令是私有的，会随版本失效。
 * 代价是第一次使用时这里是空的，换来的是行为可预期。
 *
 * 存的是绝对路径，不存任何文件内容。
 */

export interface WorkspaceEntry {
  path: string;
  name: string;
  /** 最后一次打开的时间，用于排序。 */
  openedAt: number;
}

export interface WorkspaceHistoryPort {
  get(): WorkspaceEntry[];
  set(entries: readonly WorkspaceEntry[]): PromiseLike<void> | void;
}

/** 列表只用来快速切换，长了反而难找。 */
export const MAX_WORKSPACE_HISTORY = 8;

const HISTORY_KEY = "lingdongAgent.recentWorkspaces";

/** Windows 上大小写与分隔符都可能不同，同一个目录不该出现两条。 */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
}

function isEntry(value: unknown): value is WorkspaceEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && record.path !== ""
    && typeof record.name === "string"
    && typeof record.openedAt === "number" && Number.isFinite(record.openedAt);
}

/** 把一个工作区提到最前；已存在则更新时间而不是加一条。 */
export function rememberWorkspace(
  history: readonly WorkspaceEntry[],
  entry: WorkspaceEntry,
): WorkspaceEntry[] {
  const rest = history.filter((item) => !samePath(item.path, entry.path));
  return [entry, ...rest].slice(0, MAX_WORKSPACE_HISTORY);
}

export function forgetWorkspace(
  history: readonly WorkspaceEntry[],
  path: string,
): WorkspaceEntry[] {
  return history.filter((item) => !samePath(item.path, path));
}

/**
 * 用户从左栏移除过的路径。宿主工作区根仍会存在，但不得再自动冒回 recent，
 * 否则点 × 立刻又出现，看起来像「删除不了」。
 */
const DISMISSED_KEY = "lingdongAgent.dismissedWorkspaces";
const MAX_DISMISSED = 32;

function isPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

export function dismissWorkspace(dismissed: readonly string[], path: string): string[] {
  const rest = dismissed.filter((item) => !samePath(item, path));
  return [path, ...rest].slice(0, MAX_DISMISSED);
}

export function undismissWorkspace(dismissed: readonly string[], path: string): string[] {
  return dismissed.filter((item) => !samePath(item, path));
}

export function isDismissed(dismissed: readonly string[], path: string): boolean {
  return dismissed.some((item) => samePath(item, path));
}

export interface DismissedWorkspacesPort {
  get(): string[];
  set(paths: readonly string[]): PromiseLike<void> | void;
}

export function globalStateDismissedWorkspaces(state: {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}): DismissedWorkspacesPort {
  return {
    get: () => {
      const raw = state.get<unknown>(DISMISSED_KEY);
      return isPathList(raw) ? raw.slice(0, MAX_DISMISSED) : [];
    },
    set: (paths) => state.update(DISMISSED_KEY, [...paths].slice(0, MAX_DISMISSED)),
  };
}

export function memoryDismissedWorkspaces(initial: readonly string[] = []): DismissedWorkspacesPort {
  let paths = [...initial];
  return {
    get: () => [...paths],
    set: (next) => { paths = [...next]; },
  };
}

/**
 * 落在 globalState 上：最近工作区天然是跨工作区的，
 * 存进 workspaceState 就只有当前这一个能看到。
 */
export function globalStateWorkspaceHistory(state: {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}): WorkspaceHistoryPort {
  return {
    get: () => {
      const raw = state.get<unknown>(HISTORY_KEY);
      if (!Array.isArray(raw)) return [];
      return raw.filter(isEntry).slice(0, MAX_WORKSPACE_HISTORY);
    },
    set: (entries) => state.update(HISTORY_KEY, [...entries]),
  };
}

export function memoryWorkspaceHistory(initial: readonly WorkspaceEntry[] = []): WorkspaceHistoryPort {
  let entries = [...initial];
  return {
    get: () => [...entries],
    set: (next) => { entries = [...next]; },
  };
}
