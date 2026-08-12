import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentController } from "./agent-controller";
import type { SessionRecord } from "./storage/session-repository";

type SessionNodeKind = "repo" | "group" | "session";

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    readonly kind: SessionNodeKind,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly session?: SessionRecord,
    readonly groupId?: "pinned" | "recent" | "archived",
  ) {
    super(label, collapsible);
  }
}

/**
 * 左侧会话树：仓库根 → 固定 / 最近 / 已归档 → 会话。
 *
 * 顶层那一层仓库节点不是装饰：会话按打开的文件夹隔离，没有它，用户看到的是一堆
 * 不知道属于哪个项目的会话，切过文件夹之后更难判断。数据来自 SessionRepository，
 * 徽章读 Store 同源字段。
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem>, vscode.Disposable {
  static readonly viewId = "lingdongAgent.sessionTree";

  private readonly emitter = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sessions: SessionRecord[] = [];
  private query = "";
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly controller: AgentController) {
    const onChange = (partitions: readonly string[]): void => {
      if (partitions.includes("session") || partitions.includes("plan") || partitions.includes("changes")) {
        this.sessions = this.controller.store.snapshot.sessions;
        this.query = this.controller.store.snapshot.sessionQuery;
        this.emitter.fire();
      }
    };
    this.controller.store.on("change", onChange);
    this.disposables.push({ dispose: () => { this.controller.store.off("change", onChange); } });
  }

  refresh(): void {
    void this.controller.refreshSessionList(this.query).then((sessions) => {
      this.sessions = sessions;
      this.emitter.fire();
    });
  }

  setQuery(query: string): void {
    this.query = query;
    this.controller.setSessionQuery(query);
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeItem): SessionTreeItem[] {
    if (!element) {
      const repo = this.repositoryNode();
      return repo ? [repo] : [];
    }
    if (element.kind === "repo") {
      return [
        this.group("pinned", "固定"),
        this.group("recent", "最近"),
        this.group("archived", "已归档"),
      ];
    }
    if (element.kind !== "group" || !element.groupId) return [];
    const activeId = this.controller.activeSessionId;
    const list = this.sessions.filter((session) => {
      if (element.groupId === "pinned") return session.pinned && !session.archived;
      if (element.groupId === "archived") return session.archived;
      return !session.pinned && !session.archived;
    });
    return list.map((session) => {
      const item = new SessionTreeItem(
        "session",
        session.title,
        vscode.TreeItemCollapsibleState.None,
        session,
      );
      item.id = session.id;
      item.contextValue = "lingdongSession";
      item.description = [
        session.localMode,
        session.pendingChanges > 0 ? `${session.pendingChanges} 变更` : undefined,
        session.conflictChanges > 0 ? `${session.conflictChanges} 冲突` : undefined,
        session.hasUnfinishedPlan ? "计划中" : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      item.tooltip = session.lastSummary ?? session.title;
      item.iconPath = new vscode.ThemeIcon(session.pinned ? "pinned" : "comment-discussion");
      if (session.id === activeId) item.resourceUri = vscode.Uri.parse(`lingdong-session:${session.id}`);
      item.command = {
        command: "lingdongAgent.openSession",
        title: "打开会话",
        arguments: [session.id],
      };
      return item;
    });
  }

  /** 没有活动仓库时返回 undefined：树显示 viewsWelcome 比显示三个空分组更清楚。 */
  private repositoryNode(): SessionTreeItem | undefined {
    const root = this.controller.activeRoot();
    if (!root) return undefined;
    const item = new SessionTreeItem(
      "repo",
      path.basename(root) || root,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `repo:${root}`;
    item.contextValue = "lingdongRepo";
    item.iconPath = new vscode.ThemeIcon("repo");
    item.resourceUri = vscode.Uri.file(root);
    const total = this.sessions.length;
    item.description = total > 0 ? `${total} 个会话` : "暂无会话";
    item.tooltip = root;
    return item;
  }

  private group(id: "pinned" | "recent" | "archived", label: string): SessionTreeItem {
    const item = new SessionTreeItem("group", label, vscode.TreeItemCollapsibleState.Expanded, undefined, id);
    item.contextValue = "lingdongSessionGroup";
    return item;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.emitter.dispose();
  }
}
