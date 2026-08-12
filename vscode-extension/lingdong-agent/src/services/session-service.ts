import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentRuntimeHandle } from "@lingdong/agent-runtime";
import { ChangeTracker } from "../change-tracker";
import type { ContextUsageService } from "../context-usage";
import type { FileSystemPort } from "../file-system-port";
import type { HostToWebviewMessage, UiAgentMode } from "../messages";
import { toRuntimeMode } from "../messages";
import type { TurnPresentation } from "../presentation/turn-presentation";
import { SessionPersistence } from "../session-persistence";
import { MAX_TITLE_CHARS } from "../session-title";
import type { SnapshotStore } from "../snapshot-store";
import { filterSessions, type SessionRecord } from "../storage/session-repository";
import type { AgentWorkspaceStore } from "../workspace-store";

/**
 * 工作区会话编排：存储引导、会话激活与恢复、列表与增删改，以及对话记录落盘。
 * 变更追踪与快照由 ChangeFacade 提供，这里只负责会话维度的读写。
 */

/** 流式分片攒多久落一次盘。崩溃最多丢这段时间的正文，换来推分片不被写盘拖住。 */
const LAZY_FLUSH_MS = 400;

export interface SessionServiceDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  readonly store: AgentWorkspaceStore;
  readonly fs: FileSystemPort;
  /** 扩展 globalStorage 根目录。 */
  globalStorageRoot(): string;
  /** agent 正在操作的目录；会话归档目录按它求哈希。 */
  activeRoot(): string | undefined;
  tracker(): ChangeTracker | undefined;
  snapshots(): SnapshotStore | undefined;
  usage(): ContextUsageService;
  /** 首次确定工作区时建立追踪器。 */
  setupTracker(workspaceRoot: string): void;
  /** 恢复出的模式回写给控制器。 */
  applyRestoredMode(mode: UiAgentMode): void;
  /** 恢复界面时重新推送用量、模型与计划。 */
  refreshUi(): void;
  mode(): UiAgentMode;
  /** 模型所属的 Provider；会话要记住数据发给了哪一家。 */
  providerId(modelId: string): string | undefined;
  /** 切换会话前先停下正在执行的任务。 */
  stopIfBusy(): Promise<void>;
  clearPermissionCards(reason: string): void;
  /** 切换会话时清空忙时发送队列：排队消息是对旧会话说的。 */
  clearSendQueue(): void;
  /** 新建会话需要一个已连接的 Runtime。 */
  ensureRuntime(): Promise<AgentRuntimeHandle>;
  /** 新建会话时清空权限、上下文、变更与计划等轮次状态。 */
  resetForNewSession(): void;
  /** 新会话建立后重新推送模式、状态与用量。 */
  afterNewSession(): void;
  /** 包住 ACP session/load，避免历史回放重复写入 UI/transcript。 */
  beginSessionReplay(): void;
  endSessionReplay(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionService {
  private persistenceValue: SessionPersistence | undefined;
  private currentValue: SessionRecord | undefined;
  private storageReady: Promise<void> | undefined;
  private cleanupScheduled = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private workspaceRootValue: string | undefined;
  private lazyFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private queryValue = "";
  /** 会话内第一条提示词用于自动生成标题。 */
  firstPromptInSession = true;

  constructor(private readonly deps: SessionServiceDeps) {}

  get persistence(): SessionPersistence | undefined { return this.persistenceValue; }
  get current(): SessionRecord | undefined { return this.currentValue; }
  set current(record: SessionRecord | undefined) { this.currentValue = record; }
  get activeSessionId(): string | undefined { return this.currentValue?.id; }
  get workspaceRoot(): string | undefined { return this.workspaceRootValue; }
  get query(): string { return this.queryValue; }

  /** 初始化工作区会话仓库；有最近会话时只恢复界面，不启动 Grok。 */
  ensureStorage(): Promise<void> {
    this.storageReady ??= this.bootstrap().catch((error: unknown) => {
      this.storageReady = undefined;
      throw error;
    });
    return this.storageReady;
  }

  /**
   * 换仓库：把当前根的东西落盘收干净，然后按新根重建一整套。
   *
   * 顺序是有讲究的——
   * 1. 先 flush，队列里的转写还引用着当前的 persistence；
   * 2. 再取消延迟清理，那个闭包捕获了旧的 snapshots 和 persistence；
   * 3. 最后才丢引用并把 bootstrap 的三道闸门（storageReady、persistenceValue、
   *    cleanupScheduled）全部复位，否则 ensureStorage 直接返回旧的已完成
   *    Promise，新根一个字都不会建。
   *
   * 会话记录本身不用动：它们按根哈希分目录存着，切回来还在原处。
   */
  async resetForRoot(): Promise<void> {
    // Cursor 换 Project：先空出会话面，再落盘/拆句柄。
    // 界面 clear 必须抢在 flush 前面，否则用户要点很久才看到切换。
    this.deps.store.setActiveSession(undefined);
    this.deps.store.setActivePlan(undefined);
    this.deps.store.setChanges(undefined);
    this.deps.store.setSessions([], "");
    this.deps.post({ type: "clear" });

    // 落盘仍用旧 persistence（此时句柄还在）；写完再丢掉。
    await this.flush();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.persistenceValue = undefined;
    this.currentValue = undefined;
    this.storageReady = undefined;
    this.cleanupScheduled = false;
    this.workspaceRootValue = undefined;
    this.queryValue = "";
    this.firstPromptInSession = true;
  }

  async flush(): Promise<void> {
    if (this.lazyFlushTimer) {
      clearTimeout(this.lazyFlushTimer);
      this.lazyFlushTimer = undefined;
    }
    try {
      await this.persistenceValue?.flush();
    } catch (error) {
      this.deps.log(`[storage] 写入失败：${errorText(error)}`);
    }
  }

  /**
   * 流式分片专用的落盘节奏。
   * 一次回复能有上千个分片，每个都整份重写对话记录的话，扩展主机全耗在写盘上，
   * 分片就推不动了，界面看着就是一卡一卡。这里攒一下再写；
   * 真正需要落定的时刻（assistantEnd、切会话、关闭）都会直接调 flush() 补上。
   */
  private scheduleFlush(): void {
    if (this.lazyFlushTimer) return;
    this.lazyFlushTimer = setTimeout(() => {
      this.lazyFlushTimer = undefined;
      void this.flush();
    }, LAZY_FLUSH_MS);
  }

  private async bootstrap(): Promise<void> {
    const root = this.deps.activeRoot();
    if (!root) return;
    this.workspaceRootValue = root;
    this.deps.setupTracker(root);
    if (!this.persistenceValue) {
      this.persistenceValue = new SessionPersistence({
        globalStorageRoot: this.deps.globalStorageRoot(),
        workspaceRoot: root,
        fs: this.deps.fs,
        onDamage: (detail) => {
          this.deps.log(`[storage] ${detail}`);
          this.deps.post({ type: "notice", level: "warn", message: `存储恢复：${detail}` });
        },
      });
      this.deps.log(`[storage] 会话目录：${this.persistenceValue.sessions.directory}`);
    }
    // 权限规则必须在拉起 Runtime 之前读完：判定链上是同步查询，读不到就等于没记住。
    await this.persistenceValue.permissionRules.load();
    if (this.persistenceValue.permissionRules.size > 0) {
      this.deps.log(`[permission] 已加载 ${this.persistenceValue.permissionRules.size} 条「以后都允许」规则`);
    }
    const recent = await this.persistenceValue.sessions.mostRecent();
    if (recent) await this.activate(recent, { restoreUi: true });
    this.scheduleSnapshotCleanup();
  }

  async activate(record: SessionRecord, options: { restoreUi: boolean }): Promise<void> {
    const persistence = this.persistenceValue;
    const tracker = this.deps.tracker();
    const snapshots = this.deps.snapshots();
    if (!persistence || !tracker || !snapshots) return;

    const prepared = await persistence.prepareRestore({
      record,
      tracker,
      snapshots,
      usage: this.deps.usage(),
    });
    this.currentValue = prepared.record;
    this.deps.applyRestoredMode(prepared.restore.mode);
    this.firstPromptInSession = prepared.record.turnCount === 0;
    await persistence.sessions.touch(prepared.record.id);
    this.deps.store.setActiveSession(prepared.record);
    this.deps.store.patchRuntime({
      mode: prepared.restore.mode,
      model: prepared.record.modelId || "deepseek-v4-flash",
    });
    this.deps.store.setActivePlan(persistence.plans.active);

    if (options.restoreUi) {
      this.deps.post(prepared.restore);
      this.deps.post({ type: "mode", mode: prepared.restore.mode });
      this.deps.refreshUi();
    }
    void this.refreshList();
  }

  /**
   * 新建会话：先停下当前轮次，再重置各域状态，最后创建底层 Grok 会话与本地记录。
   * 失败时只提示可恢复错误，保留原会话，避免用户丢失现场。
   */
  async createNew(): Promise<void> {
    try {
      await this.ensureStorage();
      const runtime = await this.deps.ensureRuntime();
      await this.deps.stopIfBusy();
      this.deps.resetForNewSession();
      this.firstPromptInSession = true;
      this.deps.usage().reset();
      await this.flush();

      const grokSessionId = await runtime.createSession({ mode: toRuntimeMode(this.deps.mode()) });
      const persistence = this.persistenceValue;
      if (persistence) {
        const providerId = this.deps.providerId(runtime.model);
        const record = await persistence.sessions.create({
          modelId: runtime.model,
          localMode: this.deps.mode(),
          grokSessionId,
          ...(providerId ? { providerId } : {}),
        });
        await this.activate(record, { restoreUi: false });
      }
      this.deps.post({ type: "clear" });
      this.deps.post({
        type: "session",
        sessionId: grokSessionId,
        model: runtime.model,
        mode: this.deps.mode(),
        ...(this.currentValue ? { title: this.currentValue.title } : {}),
      });
      this.deps.afterNewSession();
      await this.refreshList();
    } catch (error) {
      this.deps.post({
        type: "error",
        message: `新建会话失败：${errorText(error)}`,
        recoverable: true,
      });
    }
  }

  /** 轮次开始前确保本地会话记录存在，并与底层 Grok 会话绑定。 */
  async ensureCurrent(runtime: AgentRuntimeHandle, grokSessionId?: string): Promise<void> {
    const persistence = this.persistenceValue;
    if (!persistence) return;
    const sessionId = grokSessionId ?? runtime.sessionId;
    if (!sessionId) return;
    const providerId = this.deps.providerId(runtime.model);
    if (this.currentValue) {
      const patched = await persistence.sessions.patch(this.currentValue.id, {
        grokSessionId: sessionId,
        modelId: runtime.model,
        localMode: this.deps.mode(),
        // 只在能确定归属时补写：猜一个 providerId 等于替用户改数据流向。
        ...(providerId ? { providerId } : {}),
      });
      if (patched) this.currentValue = patched;
      return;
    }
    const record = await persistence.sessions.create({
      modelId: runtime.model,
      localMode: this.deps.mode(),
      grokSessionId: sessionId,
      ...(providerId ? { providerId } : {}),
    });
    await this.activate(record, { restoreUi: false });
  }

  /** 尝试 session/load；失败时保留本地记录并创建新底层会话。 */
  async bindGrokSession(runtime: AgentRuntimeHandle, record: SessionRecord): Promise<string> {
    const grokSessionId = record.grokSessionId;
    if (!grokSessionId) {
      const created = await runtime.createSession({ mode: toRuntimeMode(this.deps.mode()) });
      await this.ensureCurrent(runtime, created);
      return created;
    }
    try {
      // Grok 会把历史以 session/update 回放一遍；那只服务模型上下文，
      // 绝不能再进面板或 transcript，否则每次加载会话正文都会翻倍。
      this.deps.beginSessionReplay();
      try {
        await runtime.loadSession(grokSessionId, undefined, toRuntimeMode(this.deps.mode()));
      } finally {
        this.deps.endSessionReplay();
      }
      return grokSessionId;
    } catch (error) {
      this.deps.log(`[session] load 失败：${errorText(error)}`);
      this.deps.post({
        type: "notice",
        level: "warn",
        message: "底层 Agent 会话无法恢复，已保留本地记录，可以从当前状态创建新会话继续。",
      });
      const created = await runtime.createSession({ mode: toRuntimeMode(this.deps.mode()) });
      const patched = await this.persistenceValue?.sessions.patch(record.id, { grokSessionId: created });
      if (patched) this.currentValue = patched;
      return created;
    }
  }

  // ---------------------------------------------------------------------------
  // 列表与增删改
  // ---------------------------------------------------------------------------

  async refreshList(query = this.queryValue): Promise<SessionRecord[]> {
    await this.ensureStorage();
    const persistence = this.persistenceValue;
    if (!persistence) {
      this.deps.store.setSessions([], query);
      this.publishList([], query);
      return [];
    }
    this.queryValue = query;
    const all = await persistence.sessions.list({ includeArchived: true });
    const filtered = filterSessions(all, query);
    this.deps.store.setSessions(filtered, query);
    this.publishList(filtered, query);
    return filtered;
  }

  private publishList(sessions: SessionRecord[], query: string): void {
    // 显示活动仓库的目录名，不用 vscode.workspace.name：那是窗口标题，
    // 多根时它是「未命名（工作区）」，跟这些会话归属的目录没关系。
    const root = this.workspaceRootValue ?? this.deps.activeRoot();
    const workspaceName = root ? path.basename(root) || root : "未选择仓库";
    this.deps.post({
      type: "sessions",
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        localMode: session.localMode,
        pinned: session.pinned,
        archived: session.archived,
        pendingChanges: session.pendingChanges,
        conflictChanges: session.conflictChanges,
        hasUnfinishedPlan: session.hasUnfinishedPlan,
      })),
      ...(this.activeSessionId ? { activeSessionId: this.activeSessionId } : {}),
      query,
      workspaceName,
    });
  }

  async setPinned(sessionId: string, pinned?: boolean): Promise<void> {
    await this.ensureStorage();
    const current = await this.persistenceValue?.sessions.load(sessionId);
    if (!current) return;
    await this.persistenceValue?.sessions.setPinned(sessionId, pinned ?? !current.pinned);
    await this.refreshList();
  }

  async setArchived(sessionId: string, archived?: boolean): Promise<void> {
    await this.ensureStorage();
    const current = await this.persistenceValue?.sessions.load(sessionId);
    if (!current) return;
    await this.persistenceValue?.sessions.setArchived(sessionId, archived ?? !current.archived);
    await this.refreshList();
  }

  async rename(sessionId?: string, title?: string): Promise<void> {
    await this.ensureStorage();
    const persistence = this.persistenceValue;
    const id = sessionId ?? this.currentValue?.id;
    if (!persistence || !id) {
      this.deps.post({ type: "notice", level: "warn", message: "当前没有可重命名的会话。" });
      return;
    }
    let next = title?.trim();
    if (!next) {
      const current = await persistence.sessions.load(id);
      next = await vscode.window.showInputBox({
        title: "重命名会话",
        value: current?.title ?? "",
        validateInput: (value) => {
          const trimmed = value.trim();
          if (trimmed === "") return "标题不能为空";
          if ([...trimmed].length > MAX_TITLE_CHARS) return `标题最多 ${MAX_TITLE_CHARS} 个字符`;
          return undefined;
        },
      });
    }
    if (!next) return;
    const renamed = await persistence.sessions.rename(id, next);
    if (!renamed) {
      this.deps.post({ type: "notice", level: "warn", message: "重命名失败。" });
      return;
    }
    if (this.currentValue?.id === id) this.currentValue = renamed;
    this.deps.post({ type: "notice", level: "info", message: `会话已重命名为「${renamed.title}」。` });
  }

  async remove(sessionId?: string): Promise<void> {
    await this.ensureStorage();
    const persistence = this.persistenceValue;
    const id = sessionId ?? this.currentValue?.id;
    if (!persistence || !id) {
      this.deps.post({ type: "notice", level: "warn", message: "当前没有可删除的会话。" });
      return;
    }
    const record = await persistence.sessions.load(id);
    if (!record) return;
    const warnings: string[] = [];
    if (record.pendingChanges > 0 || record.conflictChanges > 0) {
      warnings.push(`该会话仍有 ${record.pendingChanges} 个未处理变更、${record.conflictChanges} 个冲突。`);
    }
    warnings.push("删除只清理灵动 Code 的本地记录，不会删除 Grok 数据目录。");
    const confirmed = await vscode.window.showWarningMessage(
      `确定删除会话「${record.title}」？\n${warnings.join("\n")}`,
      { modal: true },
      "删除",
    );
    if (confirmed !== "删除") return;
    await persistence.sessions.remove(id);
    if (this.currentValue?.id === id) {
      this.currentValue = undefined;
      this.deps.post({ type: "clear" });
      const next = await persistence.sessions.mostRecent();
      if (next) await this.activate(next, { restoreUi: true });
    }
    this.deps.post({ type: "notice", level: "info", message: `已删除会话「${record.title}」。` });
  }

  /** 打开已有会话；已连接时同步切换底层 Grok 会话。 */
  private loadSeq = 0;
  async load(sessionId: string, runtime: AgentRuntimeHandle | undefined): Promise<void> {
    const seq = ++this.loadSeq;
    await this.ensureStorage();
    if (seq !== this.loadSeq) return;
    const persistence = this.persistenceValue;
    if (!persistence) return;
    const record = await persistence.sessions.load(sessionId);
    if (!record) {
      this.deps.post({ type: "notice", level: "warn", message: "找不到该会话记录。" });
      return;
    }
    await this.deps.stopIfBusy();
    if (seq !== this.loadSeq) return;
    this.deps.clearPermissionCards("已切换会话");
    this.deps.clearSendQueue();
    await this.activate(record, { restoreUi: true });
    if (seq !== this.loadSeq) return;
    if (runtime) {
      await this.bindGrokSession(runtime, record);
      if (seq !== this.loadSeq) return;
      this.deps.post({
        type: "session",
        sessionId: runtime.sessionId ?? record.id,
        model: runtime.model,
        mode: this.deps.mode(),
        ...(record.title ? { title: record.title } : {}),
      });
    } else {
      // 未连接时不再把 session/load 推迟到下次发送：后台预热，连上后补绑定，
      // 首条消息就能带着已恢复的模型上下文出发。
      void this.deps.ensureRuntime()
        .then(async (started) => {
          // 预热期间用户可能又切走了；也可能启动编排已经绑定了同一个会话。
          const active = this.currentValue;
          if (active?.id !== record.id) return;
          if (active.grokSessionId && started.sessionId === active.grokSessionId) return;
          const boundId = await this.bindGrokSession(started, active);
          this.deps.post({
            type: "session",
            sessionId: boundId,
            model: started.model,
            mode: this.deps.mode(),
            ...(active.title ? { title: active.title } : {}),
          });
        })
        .catch((error: unknown) => {
          this.deps.log(`[session] 预热后补载失败（发送时会重试）：${errorText(error)}`);
        });
    }
    if (seq !== this.loadSeq) return;
    // 只推面板，不落盘：否则下次 restore 会把「已加载会话」又播一遍。
    this.deps.post({ type: "notice", level: "info", message: `已加载会话：${record.title}` });
  }

  /** 会话右键操作走 VS Code 原生 QuickPick，Webview 侧不再使用 prompt / confirm。 */
  async openMenu(sessionId: string, runtime: AgentRuntimeHandle | undefined): Promise<void> {
    await this.ensureStorage();
    const record = await this.persistenceValue?.sessions.load(sessionId);
    if (!record) {
      this.deps.post({ type: "notice", level: "warn", message: "该会话已不存在。" });
      await this.refreshList();
      return;
    }

    type Action = "open" | "rename" | "pin" | "archive" | "delete";
    const items: Array<vscode.QuickPickItem & { action: Action }> = [
      { label: "$(comment-discussion) 打开会话", action: "open" },
      { label: "$(edit) 重命名", action: "rename" },
      { label: record.pinned ? "$(pinned) 取消固定" : "$(pin) 固定", action: "pin" },
      { label: record.archived ? "$(archive) 取消归档" : "$(archive) 归档", action: "archive" },
      { label: "$(trash) 删除", action: "delete" },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: record.title,
      placeHolder: "选择要执行的操作",
    });
    if (!picked) return;

    switch (picked.action) {
      case "open":
        await this.load(sessionId, runtime);
        return;
      case "rename":
        await this.rename(sessionId);
        break;
      case "pin":
        await this.setPinned(sessionId);
        return;
      case "archive":
        await this.setArchived(sessionId);
        return;
      case "delete":
        await this.remove(sessionId);
        break;
    }
    await this.refreshList();
  }

  async openHistory(runtime: AgentRuntimeHandle | undefined): Promise<void> {
    await this.ensureStorage();
    const persistence = this.persistenceValue;
    if (!persistence) {
      this.deps.post({ type: "notice", level: "warn", message: "请先打开一个本地工作区。" });
      return;
    }
    const records = await persistence.sessions.list({ includeArchived: true });
    if (records.length === 0) {
      this.deps.post({ type: "notice", level: "info", message: "当前工作区还没有会话历史。" });
      return;
    }

    type HistoryItem = vscode.QuickPickItem & { sessionId: string };
    const renameButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("edit"), tooltip: "重命名" };
    const deleteButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "删除" };
    const pinButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("pin"), tooltip: "固定/取消固定" };
    const archiveButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("archive"),
      tooltip: "归档/取消归档",
    };
    const buttons = [renameButton, pinButton, archiveButton, deleteButton];

    const toItem = (record: SessionRecord): HistoryItem => {
      const flags: string[] = [];
      if (record.pendingChanges > 0) flags.push(`${record.pendingChanges} 个未处理变更`);
      if (record.conflictChanges > 0) flags.push(`${record.conflictChanges} 个冲突`);
      if (record.hasUnfinishedPlan) flags.push("未完成计划");
      if (record.archived) flags.push("已归档");
      return {
        label: `${record.pinned ? "$(pinned) " : ""}${record.title}`,
        description: `${record.localMode} · ${record.modelId || "deepseek-v4-flash"} · `
          + new Date(record.updatedAt).toLocaleString(),
        detail: [record.lastSummary, ...flags].filter(Boolean).join(" · ") || "暂无摘要",
        sessionId: record.id,
        buttons,
      };
    };

    const picked = await new Promise<HistoryItem | undefined>((resolve) => {
      const quickPick = vscode.window.createQuickPick<HistoryItem>();
      quickPick.title = "灵动 Code 会话历史";
      quickPick.placeholder = "选择要打开的会话";
      quickPick.items = records.map(toItem);
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        quickPick.hide();
        resolve(selected);
      });
      quickPick.onDidTriggerItemButton(async (event) => {
        const id = event.item.sessionId;
        if (event.button === renameButton) {
          quickPick.hide();
          await this.rename(id);
          resolve(undefined);
          return;
        }
        if (event.button === deleteButton) {
          quickPick.hide();
          await this.remove(id);
          resolve(undefined);
          return;
        }
        const current = await persistence.sessions.load(id);
        if (current && event.button === pinButton) {
          await persistence.sessions.setPinned(id, !current.pinned);
        } else if (current && event.button === archiveButton) {
          await persistence.sessions.setArchived(id, !current.archived);
        } else {
          return;
        }
        quickPick.items = (await persistence.sessions.list({ includeArchived: true })).map(toItem);
      });
      quickPick.onDidHide(() => {
        quickPick.dispose();
        resolve(undefined);
      });
      quickPick.show();
    });

    if (picked) await this.load(picked.sessionId, runtime);
  }

  // ---------------------------------------------------------------------------
  // 落盘
  // ---------------------------------------------------------------------------

  appendUserPrompt(text: string, contextLabels: string[]): void {
    this.persistenceValue?.transcript.append({
      kind: "user",
      at: Date.now(),
      text,
      ...(contextLabels.length > 0 ? { contextLabels } : {}),
    });
    void this.flush();
  }

  appendNotice(message: string): void {
    this.persistenceValue?.transcript.append({
      kind: "notice",
      at: Date.now(),
      level: "info",
      message,
    });
    void this.flush();
  }

  /** 落盘一轮任务时间线。脱敏与截断在 transcript 的 sanitizeEntry 里统一处理。 */
  appendTimeline(presentation: TurnPresentation): void {
    this.persistenceValue?.transcript.append({
      kind: "timeline",
      at: presentation.completedAt ?? presentation.startedAt,
      turnId: presentation.turnId,
      presentation,
    });
    void this.flush();
  }

  /** 把推给面板的消息同步写入对话记录，供下次打开恢复。 */
  persistHostMessage(message: HostToWebviewMessage): void {
    const transcript = this.persistenceValue?.transcript;
    if (!transcript) return;
    const at = Date.now();
    switch (message.type) {
      case "assistantDelta":
        transcript.appendAssistantText(message.text, at);
        // 分片攒着写：紧接着的 assistantEnd 会立刻补一次完整落盘。
        this.scheduleFlush();
        return;
      case "assistantEnd":
        transcript.append({
          kind: "assistantEnd",
          at,
          stopReason: message.stopReason,
          ...(message.modelId ? { modelId: message.modelId } : {}),
        });
        break;
      case "activity":
        transcript.append({ kind: "activity", at, message: message.message });
        break;
      case "notice":
        // 会话切换类提示是瞬时 UI，写进 transcript 会在每次加载时重复出现。
        if (/^已加载会话：/.test(message.message)) return;
        transcript.append({ kind: "notice", at, level: message.level, message: message.message });
        break;
      case "error":
        transcript.append({ kind: "error", at, message: message.message });
        break;
      case "toolStarted":
        transcript.append({
          kind: "tool",
          at,
          toolCallId: message.toolCallId,
          toolKind: message.kind,
          label: message.label,
          readOnly: message.readOnly,
          status: "running",
          ...(message.target ? { target: message.target } : {}),
        });
        break;
      case "toolOutput":
        transcript.updateTool(message.toolCallId, { output: message.text });
        // 工具输出同样是高频流式，落盘节奏跟正文分片一致。
        this.scheduleFlush();
        return;
      case "toolStatus":
        transcript.updateTool(message.toolCallId, {
          status: message.status,
          ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
          completedAt: at,
        });
        break;
      case "plan":
        transcript.append({ kind: "plan", at, plan: message.plan, status: message.plan.status });
        break;
      case "planStatus":
        transcript.append({
          kind: "notice",
          at,
          level: "info",
          message: message.message ?? `计划状态：${message.status}`,
        });
        break;
      case "permission":
        transcript.append({
          kind: "permission",
          at,
          requestId: message.card.requestId,
          title: message.card.title,
          operation: message.card.operation,
          risk: message.card.risk,
          decision: "pending",
          ...(message.card.target ? { target: message.card.target } : {}),
          ...(message.card.command ? { command: message.card.command } : {}),
        });
        break;
      case "permissionResolved":
        transcript.updatePermission(message.requestId, message.resolution, message.message);
        break;
      case "askQuestion":
        transcript.append({
          kind: "question",
          at,
          requestId: message.card.requestId,
          questions: message.card.questions,
          outcome: "pending",
        });
        break;
      case "askQuestionResolved":
        transcript.updateQuestion(
          message.requestId,
          message.answers && message.answers.length > 0 ? "answered" : "cancelled",
          message.answers,
          message.message,
        );
        break;
      case "mode":
        transcript.append({ kind: "mode", at, mode: message.mode });
        break;
      default:
        break;
    }
    void this.flush();
  }

  /** 变更被接受/恢复后同步会话上的未处理计数。 */
  async syncCounters(patch: Parameters<SessionPersistence["syncSessionCounters"]>[1]): Promise<void> {
    if (!this.currentValue) return;
    const next = await this.persistenceValue?.syncSessionCounters(this.currentValue.id, patch);
    if (next) this.currentValue = next;
  }

  private scheduleSnapshotCleanup(): void {
    if (this.cleanupScheduled) return;
    const snapshots = this.deps.snapshots();
    const persistence = this.persistenceValue;
    if (!snapshots || !persistence) return;
    this.cleanupScheduled = true;
    const run = async () => {
      const settings = vscode.workspace.getConfiguration("lingdongAgent");
      const days = Math.max(1, settings.get<number>("snapshotRetentionDays", 30) || 30);
      const maxMb = Math.max(16, settings.get<number>("snapshotMaxTotalMb", 512) || 512);
      try {
        await snapshots.hydrate();
        const removable = persistence.turns.removableTurnIds();
        const known = new Set([...removable, ...persistence.turns.turns.map((turn) => turn.turnId)]);
        const result = await snapshots.cleanup({
          removableTurnIds: removable,
          maxAgeMs: days * 86_400_000,
          maxTotalBytes: maxMb * 1024 * 1024,
          knownTurnIds: known,
        });
        for (const orphan of result.orphanDirectories) {
          this.deps.log(`[snapshot] 孤立快照：${orphan}`);
        }
        if (result.removed.length > 0) {
          this.deps.log(`[snapshot] 已清理 ${result.removed.length} 个过期快照`);
        }
        const scanned = await snapshots.scan();
        const total = scanned.reduce((sum, turn) => sum + turn.totalBytes, 0);
        if (total > maxMb * 1024 * 1024) {
          this.deps.post({
            type: "notice",
            level: "warn",
            message: `灵动 Code 快照占用约 ${Math.round(total / (1024 * 1024))} MB，`
              + `已超过配额 ${maxMb} MB；未处理变更不会被自动删除。`,
            actions: [{ id: "dismiss", label: "知道了" }],
          });
        }
      } catch (error) {
        this.deps.log(`[snapshot] 清理失败：${errorText(error)}`);
      }
    };
    // 存下句柄才能在换仓库时取消：这个闭包捕获了旧的 snapshots 与 persistence，
    // 换根之后跑起来会对着旧哈希目录清理、按旧配额弹警告。
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      void run();
    }, 3_000);
    if (typeof this.cleanupTimer.unref === "function") this.cleanupTimer.unref();
  }

  /** 计划 Markdown 的落地路径基于工作区根目录。 */
  planStorageRoot(): string | undefined {
    return this.workspaceRootValue;
  }

  snapshotRootFor(globalStorage: string): string {
    return path.join(globalStorage, "agent-snapshots");
  }
}
