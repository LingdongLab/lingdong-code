import * as path from "node:path";
import * as vscode from "vscode";
import type { HostToWebviewMessage } from "../messages";
import { hostRoots } from "./host-workspace";
import {
  dismissWorkspace,
  forgetWorkspace,
  isDismissed,
  rememberWorkspace,
  samePath,
  undismissWorkspace,
  type DismissedWorkspacesPort,
  type WorkspaceEntry,
  type WorkspaceHistoryPort,
} from "../workspace-history";

/**
 * 左栏的仓库区块：显示当前仓库、列出最近用过的、添加一个或换一个。
 *
 * 「加」和「换」曾经是两件事，因为两者对窗口的影响不同：加走
 * `updateWorkspaceFolders`，换走 `vscode.openFolder`。但无论走哪条，用户都会撞上
 * 重开或重载——`openFolder` 本质是换掉整个窗口的工作区，而
 * `updateWorkspaceFolders` 在「单文件夹 → 多文件夹」这一步也必然重载。这是 VS Code
 * 的核心行为，改源码也不该碰。
 *
 * 根子在于「仓库」当时就是 VS Code 的工作区文件夹。现在仓库归扩展自己存
 * （见 services/active-repo.ts），这里就只剩两件轻活：维护列表、请控制器切过去。
 * 于是「加」和「换」合并成同一件事，都不动窗口。
 */

export interface WorkspaceSwitcherDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  /** agent 正在操作的目录；「当前」显示的是它，不是宿主工作区的第一个根。 */
  activeRoot(): string | undefined;
  /** 真正的切换动作由控制器编排：停活、重挂存储、重起 Grok。 */
  activateRepo(target: string): Promise<void>;
  /** 列表里一个都不剩时，清掉活动仓库并空出对话面。 */
  clearRepo(): Promise<void>;
  readonly history: WorkspaceHistoryPort;
  /** 用户点 × 移除过的路径；宿主根仍在也不再自动冒回列表。 */
  readonly dismissed: DismissedWorkspacesPort;
  /** 目录是否还在；路径失效的条目不该留在列表里。 */
  directoryExists(absolutePath: string): Promise<boolean>;
  now(): number;
}

export class WorkspaceSwitcher {
  constructor(private readonly deps: WorkspaceSwitcherDeps) {}

  /**
   * 「当前仓库」显示的是活动仓库。
   *
   * 名字取路径的最后一段，不再用 `vscode.workspace.name`：那是窗口标题，
   * 多根时它是「未命名（工作区）」，跟 agent 实际在操作的目录没关系。
   */
  private currentRepo(): { path: string; name: string } | undefined {
    const root = this.deps.activeRoot();
    if (!root) return undefined;
    return { path: root, name: path.basename(root) || root };
  }

  /** 启动时把当前仓库记进历史，用户下次就能从列表切回来。 */
  async recordCurrent(): Promise<void> {
    const current = this.currentRepo();
    if (!current) return;
    const entry: WorkspaceEntry = { ...current, openedAt: this.deps.now() };
    await this.deps.history.set(rememberWorkspace(this.deps.history.get(), entry));
  }

  publish(): void {
    const current = this.currentRepo();
    const dismissed = this.deps.dismissed.get();
    // 其它仓库扁平列出——跟 Cursor 的 Repositories 一样。
    // 编辑器里还开着、但不是当前活动仓库的根，并进 recent，不再嵌进当前节点：
    // 嵌进去会被点成「子项」，一点却整仓切换，用户感觉点里面跳到外面去了。
    // 用户点 × 移除过的路径（含仍开着的宿主根）不再自动冒回。
    const peers = new Map<string, { path: string; name: string }>();
    const rememberPeer = (absolutePath: string, name: string): void => {
      if (current && samePath(absolutePath, current.path)) return;
      if (isDismissed(dismissed, absolutePath)) return;
      const key = absolutePath.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
      if (!peers.has(key)) peers.set(key, { path: absolutePath, name });
    };
    for (const root of hostRoots()) {
      rememberPeer(root, path.basename(root) || root);
    }
    for (const entry of this.deps.history.get()) {
      rememberPeer(entry.path, entry.name);
    }
    this.deps.post({
      type: "workspaces",
      ...(current ? { current } : {}),
      recent: [...peers.values()],
    });
  }

  /**
   * 从列表移除一个仓库。只忘记录，不删磁盘上的文件夹或会话归档。
   *
   * 若移除的是当前仓库：有其它可切就切过去，否则清空活动仓库，界面回到「未选择」。
   */
  async remove(target: string): Promise<void> {
    await this.deps.history.set(forgetWorkspace(this.deps.history.get(), target));
    // 宿主根仍在 VS Code 工作区里；不记入 dismissed 的话 publish 会立刻把它塞回 recent。
    await this.deps.dismissed.set(dismissWorkspace(this.deps.dismissed.get(), target));
    const active = this.deps.activeRoot();
    if (active && samePath(active, target)) {
      const dismissed = this.deps.dismissed.get();
      const fallback = this.deps.history.get().find((entry) => !isDismissed(dismissed, entry.path))?.path
        ?? hostRoots().find((root) => !samePath(root, target) && !isDismissed(dismissed, root));
      if (fallback) await this.deps.activateRepo(fallback);
      else await this.deps.clearRepo();
    }
    this.publish();
    this.deps.post({
      type: "notice",
      level: "info",
      message: `已从列表移除：${path.basename(target) || target}`,
    });
  }

  /**
   * 添加一个仓库并切过去。窗口不动。
   *
   * 以前这里要么 `vscode.openFolder`（换掉整个窗口的工作区，必然重开），要么
   * `updateWorkspaceFolders` 追加（单文件夹→多文件夹那一步 VS Code 必然重载）。
   * 两条路都躲不开重开，因为「仓库」当时就是 VS Code 的工作区文件夹。
   * 现在仓库归我们自己存，所以这里只做两件事：记进列表、请控制器切过去。
   */
  async addFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "作为仓库打开",
      title: "选择一个文件夹作为仓库",
    });
    const folder = picked?.[0];
    if (!folder) return;

    const active = this.deps.activeRoot();
    if (active && samePath(active, folder.fsPath)) {
      this.deps.post({
        type: "notice",
        level: "info",
        message: `已经在这个仓库里了：${path.basename(folder.fsPath)}`,
      });
      return;
    }
    await this.remember(folder.fsPath);
    await this.deps.activateRepo(folder.fsPath);
    // activate 内已乐观推过；这里再推一次，把 remember 后的 recent/dismissed 对齐。
    this.publish();
  }

  /** 切到列表里的某一个仓库。 */
  async switchTo(target: string): Promise<void> {
    if (!(await this.deps.directoryExists(target))) {
      await this.deps.history.set(forgetWorkspace(this.deps.history.get(), target));
      this.publish();
      this.deps.post({
        type: "notice",
        level: "warn",
        message: `文件夹已不存在，已从列表移除：${path.basename(target)}`,
      });
      return;
    }
    const active = this.deps.activeRoot();
    if (active && samePath(active, target)) return;
    await this.remember(target);
    await this.deps.activateRepo(target);
    this.publish();
  }

  private async remember(absolutePath: string): Promise<void> {
    await this.deps.dismissed.set(undismissWorkspace(this.deps.dismissed.get(), absolutePath));
    await this.deps.history.set(rememberWorkspace(this.deps.history.get(), {
      path: absolutePath,
      name: path.basename(absolutePath) || absolutePath,
      openedAt: this.deps.now(),
    }));
  }
}
