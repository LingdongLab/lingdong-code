import { samePath } from "../workspace-history";

/**
 * 活动仓库：灵动 Code 正在操作的那个目录。
 *
 * 以前这一律等于 `vscode.workspace.workspaceFolders[0]`，代价是「换个仓库」
 * 必须去动 VS Code 的工作区，而 VS Code 在「单文件夹 → 多文件夹」这一步必然
 * 重载整个窗口——用户看到的就是「加个文件夹怎么重开了一个」。这是基座的核心
 * 行为，改源码也不该碰。
 *
 * 所以把两件事分开：VS Code 的工作区归编辑器，活动仓库归我们自己存。
 * 换仓库于是变成一次纯内部的重挂，窗口一动不动。
 *
 * 回落到宿主的第一个根，是为了让「直接打开一个文件夹就用」这条路照样成立：
 * 没有任何记录时行为跟以前完全一样，用户不需要先去选一次仓库。
 */

export const ACTIVE_REPO_KEY = "lingdongAgent.activeRepo";

/**
 * 用户明确清空活动仓库后写入 globalState 的占位。
 * 与「从未选过」(key 缺失 / stored === undefined) 必须区分：
 * 从未选过 → 回落到宿主第一个根（打开文件夹就能用）；
 * 明确清空 → 不得回落，否则左栏点 × 会立刻又变回当前，看起来像删不掉。
 */
export const ACTIVE_REPO_CLEARED = "";

export interface ActiveRepoInput {
  /**
   * 我们自己存下来的选择。
   * - `undefined`：从未选过，可回落宿主根
   * - `""`（ACTIVE_REPO_CLEARED）：用户清空过，禁止回落
   * - 其它非空字符串：活动仓库路径
   */
  readonly stored: string | undefined;
  /** VS Code 工作区的本地根，按它给的顺序。 */
  readonly hostRoots: readonly string[];
}

/**
 * 算出当前该操作哪个目录。
 *
 * 刻意不在这里判断目录是否还存在：那是异步的，而这个结果在同步路径上被反复取用
 * （取会话目录、拼相对路径）。失效路径由切换入口负责清理。
 */
export function resolveActiveRepo(input: ActiveRepoInput): string | undefined {
  // 明确清空：不要回落到宿主根，否则「删除当前」会马上复活。
  if (input.stored === ACTIVE_REPO_CLEARED) return undefined;
  const stored = input.stored?.trim();
  if (stored) return stored;
  return input.hostRoots[0];
}

/**
 * 活动仓库是不是宿主工作区里的某个根。
 *
 * 决定了两件事能不能做：把文件显示在资源管理器里、用 VS Code 的工作区级 API。
 * 不是的话就得走我们自己的目录遍历。
 */
export function insideHostWorkspace(
  active: string | undefined,
  hostRoots: readonly string[],
): boolean {
  if (!active) return false;
  return hostRoots.some((root) => samePath(root, active));
}

export interface ActiveRepoStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface ActiveRepoPort {
  stored(): string | undefined;
  remember(absolutePath: string | undefined): Promise<void>;
}

/**
 * 存在 globalState 而不是 workspaceState：活动仓库天生跨工作区，
 * 而且空窗口也要能记住上次在哪个仓库里干活。
 */
export function globalStateActiveRepo(state: ActiveRepoStateStore): ActiveRepoPort {
  return {
    stored: () => {
      const raw = state.get<unknown>(ACTIVE_REPO_KEY);
      // 空串是「明确清空」哨兵，必须原样返回给 resolveActiveRepo。
      if (raw === ACTIVE_REPO_CLEARED) return ACTIVE_REPO_CLEARED;
      return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
    },
    remember: async (absolutePath) => {
      // undefined → 写入清空哨兵，而不是删掉 key（删 key 会被当成「从未选过」又回落宿主根）。
      await state.update(
        ACTIVE_REPO_KEY,
        absolutePath === undefined ? ACTIVE_REPO_CLEARED : absolutePath,
      );
    },
  };
}

export function memoryActiveRepo(initial?: string): ActiveRepoPort {
  let value: string | undefined = initial;
  return {
    stored: () => value,
    remember: (absolutePath) => {
      value = absolutePath === undefined ? ACTIVE_REPO_CLEARED : absolutePath;
      return Promise.resolve();
    },
  };
}
