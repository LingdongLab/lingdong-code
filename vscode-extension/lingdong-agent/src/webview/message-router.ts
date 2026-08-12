import type { CandidateGroup } from "../composer/context-candidate";
import type { HostToWebviewMessage } from "../messages";
import { PLAN_STATUS_LABELS } from "../plan-view-model";
import { extractSearchable, type SearchableDraft } from "../search/search-result";
import { MODE_LABELS, type AppElements, type AppState, type Post } from "./app-context";
import { fillChangeSummaryCard } from "./change-summary-card";
import type { ComposerView } from "./composer";
import type { ConversationView, RenderUnit } from "./conversation";
import { collapseCard, element } from "./dom-utils";
import { friendlyRecoveryMessage, isDisplayNoise } from "./message-renderer";
import type { PlanController } from "./plan-controller";
import { createRepoTreeState, renderRepoTree, type RepoTreeState } from "./repo-tree";
import type { TodoCardView } from "./todo-card";
import type { TurnStatusBar } from "./turn-status-bar";
import type { WorkbenchView } from "./workbench/workbench-view";

/**
 * 宿主消息 → 各 UI 模块的唯一分发点。
 * 这里不做渲染细节，只更新 AppState 并调用对应模块。
 */

export interface RouterDeps {
  el: AppElements;
  state: AppState;
  post: Post;
  conversation: ConversationView;
  composer: ComposerView;
  plan: PlanController;
  workbench: WorkbenchView;
  /** 重绘某个右侧工具（仅在其已打开时生效）。 */
  refreshTool(tool: "changes" | "tasks" | "context" | "files" | "plan"): void;
  turnStatus: TurnStatusBar;
  todo: TodoCardView;
  requestFiles(query: string): void;
  /** 内联 @ 候选回包。 */
  onSuggestResults(query: string, groups: CandidateGroup[], truncated: boolean): void;
  /** 在右栏 Changes 面板中查看某个变更（undefined = 只开面板）。 */
  openChangeInRail(changeId: string | undefined): void;
}

export class MessageRouter {
  /** 会话内消息时序号：todo 卡靠它忽略「加载更早消息」重放的旧快照。 */
  private todoSeq = 0;
  /** 仓库树的折叠状态。存在这里才能在每次收到 sessions 消息后保持不变。 */
  private readonly repoTree: RepoTreeState = createRepoTreeState();
  /** 本轮变更已到、但助手还在写：先别插卡，避免把回复劈成两段。 */
  private pendingChangeSummary = false;
  /** 上一次画进列表的「运行中」会话，用来避免每条 busy 消息都重画整棵树。 */
  private paintedRunningSessionId: string | undefined;

  constructor(private readonly deps: RouterDeps) {}

  /**
   * 重连按钮的可见性只有这一个出口。
   *
   * 两个来源：连接确实断了，或者本轮是以「连接中断」收尾的。
   * 两者都会随后续事件自然翻转 —— 连上会发 connection，新一轮会把状态推离 interrupted ——
   * 所以按钮能自己灭掉，不必等下一次重启子进程。
   */
  private syncReconnect(): void {
    const interrupted = this.deps.turnStatus.status === "interrupted";
    this.deps.el.reconnect.hidden = !this.deps.state.connectionFailed && !interrupted;
  }

  apply(message: HostToWebviewMessage, todoSeq?: number): void {
    const { state, conversation, composer, plan, workbench } = this.deps;
    switch (message.type) {
      case "connection":
        state.connectionFailed = message.state === "failed";
        this.syncReconnect();
        return;

      case "turnStatus":
        state.turnCanStop = message.canStop;
        state.turnActive = message.visible
          && message.status !== "completed"
          && message.status !== "failed"
          && message.status !== "stopped"
          && message.status !== "interrupted"
          && message.status !== "idle";
        // 工具一开始干（working）就结束会话流里的「思考 Ns」块。
        // 否则写文件的几分钟会计进思考时长，出现「思考 257s」这种让人看不懂的数字。
        if (message.status === "working" || message.status === "waiting_for_user") {
          conversation.finishThinking();
        }
        this.deps.turnStatus.apply(message);
        // 放在 apply 之后：syncReconnect 要读 turnStatus 更新后的状态。
        this.syncReconnect();
        // 回合结束后再挂变更卡（对标 Cursor：先答完，再审文件）。
        if (!state.turnActive) this.flushChangeSummary();
        composer.updateChrome();
        this.syncRunningIndicator();
        return;

      case "session":
        state.model = message.model;
        state.mode = message.mode;
        if (message.sessionId.startsWith("ses-")) state.activeSessionId = message.sessionId;
        if (message.title) this.deps.el.sessionTitle.textContent = message.title;
        composer.updateChrome();
        this.renderSessions();
        return;

      case "mode":
        state.mode = message.mode;
        composer.updateChrome();
        return;

      case "modeState":
        state.mode = message.mode;
        state.canSwitchMode = message.canSwitch;
        state.askOnly = message.askOnly === true;
        state.askOnlyReason = message.askOnlyReason ?? "";
        composer.updateChrome();
        return;

      case "state": {
        const approvalWasPending = state.uiState === "waiting_plan_approval";
        state.uiState = message.state;
        state.busy = message.busy;
        state.canSend = message.canSend;
        state.canCancel = message.canCancel;
        state.canSwitchMode = message.canSwitchMode;
        state.canApplyChanges = message.canApplyChanges;
        state.canRestoreChanges = message.canRestoreChanges;
        composer.updateChrome();
        this.deps.refreshTool("changes");
        // 审批未决状态切换会影响计划文档的按钮语义与修改意见输入框，需要重绘。
        if ((message.state === "waiting_plan_approval") !== approvalWasPending) plan.renderCenter();
        return;
      }

      case "busy":
        state.busy = message.busy;
        if (!message.busy) {
          conversation.finishThinking();
          conversation.sealStreaming();
          conversation.noteStopRequested(false);
          this.flushChangeSummary();
        }
        composer.updateChrome();
        this.syncRunningIndicator();
        return;

      case "userMessage":
        conversation.sealStreaming();
        conversation.appendUserMessage(message.text);
        return;

      case "assistantDelta":
        conversation.appendAssistantDelta(message.text);
        return;

      case "assistantEnd":
        conversation.finalizeAssistant(message.stopReason, message.modelId);
        conversation.collapsePlanDuplicates();
        this.flushChangeSummary();
        return;

      // 活动文案不驱动全局 Status Bar（主状态只认 turnStatus），
      // 但要进会话流的思考块，否则模型想几十秒时中间是一片空白。
      // 工具已经在跑时不再往思考块记账——否则写文件的时间会被算成「思考 257s」。
      case "activity":
        if (this.deps.turnStatus.status === "working") return;
        conversation.showThinking(message.message);
        return;

      // 推理原文进折叠块的展开区。与 activity 一样，工具跑起来之后就不再往里记，
      // 否则写文件那几分钟会被算进「思考 Ns」。
      case "reasoningDelta":
        if (this.deps.turnStatus.status === "working") return;
        conversation.appendReasoning(message.text);
        return;

      case "toolOutput":
      case "clarifications":
        return;

      case "notice": {
        // 会话切换是瞬时状态，常驻卡片会一直杵在对话里。
        if (/^已加载会话：/.test(message.message)) {
          conversation.appendEphemeralNotice(message.message);
          return;
        }
        const friendly = friendlyRecoveryMessage(message.message);
        if (friendly) {
          conversation.sealStreaming();
          conversation.appendRow(`notice ${message.level}`, friendly, message.actions);
          return;
        }
        if (isDisplayNoise(message.message)) return;
        if (conversation.shouldSuppressNotice(message.message)) return;
        conversation.sealStreaming();
        // info 级别是「做完了」的回执（已接受 9 个文件的修改、计划已保存……）：
        // 看一眼就够了，常驻只会把对话流堆满。warn/error 要留，用户得能回头看。
        // 带按钮的一律留下，否则按钮还没点就自己消失了。
        if (message.level === "info" && !message.actions?.length) {
          conversation.appendEphemeralNotice(message.message, 6_000);
          return;
        }
        conversation.appendRow(`notice ${message.level}`, message.message, message.actions);
        return;
      }

      case "error": {
        conversation.sealStreaming();
        // 连接中断只在 Status Bar；聊天区不再叠错误卡。
        if (this.deps.turnStatus.status === "interrupted") {
          this.syncReconnect();
          return;
        }
        const friendly = friendlyRecoveryMessage(message.message);
        const fallback = isDisplayNoise(message.message)
          ? "操作未成功，详情见输出日志。"
          : message.message;
        conversation.appendRow("notice error", friendly ?? fallback, message.actions);
        // 这里刻意不碰重连按钮。recoverable 的含义是「这次操作失败了但还能接着用」，
        // 打开 Diff 失败、保存计划失败、权限回执失败都算，跟连接好不好没有关系。
        // 以前拿它当信号，结果任何一次无关失败都会让重连按钮常亮到下次重启子进程为止。
        return;
      }

      case "openPlusMenu":
        this.deps.composer.togglePlusMenu();
        return;

      case "beginAtMention":
        this.deps.composer.beginAtMention();
        return;

      case "plan":
        // 执行期的实时 todo 走会话流里的清单卡片，逐项勾选；
        // 同时喂给右侧 Tasks，避免只在对话卡里动、Tasks 面板僵住。
        if (message.plan.status === "executing") {
          this.deps.todo.apply(message.plan, todoSeq ?? ++this.todoSeq);
          state.liveTaskSteps = message.plan.steps.map((step) => ({
            title: step.title,
            status: step.status ?? "pending",
          }));
          this.deps.refreshTool("tasks");
          return;
        }
        state.planCardView = message.plan;
        state.liveTaskSteps = undefined;
        plan.renderCenter();
        // 完整文档在右侧（对标 Cursor）：计划到达时建议打开，手动关过则不强开。
        workbench.suggest("plan");
        this.deps.refreshTool("tasks");
        conversation.collapsePlanDuplicates();
        return;

      case "subagents":
        state.subagentTasks = message.tasks;
        // 有子 Agent 在跑就把 Tasks 推到用户眼前，否则并行进度只存在于时间线深处。
        if (message.tasks.some((task) => task.status === "running")) workbench.suggest("tasks");
        this.deps.refreshTool("tasks");
        return;

      case "backgroundTasks":
        state.backgroundTasks = message.tasks;
        if (message.tasks.some((task) => task.status === "running")) workbench.suggest("tasks");
        this.deps.refreshTool("tasks");
        return;

      case "planStatus":
        if (message.message && !/ses-/i.test(message.message)) {
          conversation.appendRow("notice info", message.message);
        }
        plan.patchStatusBadge(PLAN_STATUS_LABELS[message.status]);
        if (message.status === "completed" || message.status === "abandoned" || message.status === "failed") {
          state.liveTaskSteps = undefined;
          this.deps.refreshTool("tasks");
        }
        return;

      case "planRecord":
        state.activePlan = message.plan;
        if (message.plan.status !== "executing") state.liveTaskSteps = undefined;
        plan.renderCenter();
        workbench.suggest("plan");
        this.deps.refreshTool("tasks");
        conversation.collapsePlanDuplicates();
        return;

      case "permission":
        conversation.renderPermission(message.card, message.waiting);
        return;

      case "permissionResolved":
        conversation.resolvePermission(message.requestId, message.message);
        return;

      case "askQuestion":
        conversation.renderQuestion(message.card);
        return;

      case "askQuestionResolved":
        conversation.resolveQuestion(message.requestId, message.message, message.answers);
        return;

      case "timelineTurn":
        conversation.applyTimelineTurn(message.turn);
        return;

      case "timelineGroup":
        conversation.applyTimelineGroup(message.turnId, message.group);
        if (state.mode !== "ask") workbench.suggest("tasks");
        return;

      case "timelineItem":
        conversation.applyTimelineItem(message.turnId, message.groupId, message.item);
        return;

      case "timelineRestore":
        conversation.restoreTimeline(message.presentation);
        return;

      // 以下三条只在恢复 v1 会话记录时出现；新会话由时间线接管。
      case "toolStarted": {
        // 先封口当前助手气泡，保证时间顺序：正文片段 → 工具 → 后续答复。
        conversation.sealStreaming();
        const { group } = conversation.tools.start({
          toolCallId: message.toolCallId,
          kind: message.kind,
          label: message.label,
          ...(message.target ? { target: message.target } : {}),
          readOnly: message.readOnly,
          at: Date.now(),
        });
        conversation.paintToolGroup(group.id);
        if (state.mode !== "ask") workbench.suggest("tasks");
        return;
      }

      case "toolStatus": {
        const group = conversation.tools.status(message.toolCallId, message.status);
        if (group) conversation.paintToolGroup(group.id);
        return;
      }

      case "askIntent":
        conversation.renderAskIntent(message.reason, message.keyword, MODE_LABELS);
        return;

      case "contextItems":
        state.contextItems = message.items;
        composer.renderContextChips();
        this.deps.refreshTool("context");
        return;

      case "contextSuggestResults":
        this.deps.onSuggestResults(message.query, message.groups, message.truncated);
        return;

      case "changes": {
        state.latestChanges = message.view;
        // 选中的文件不在新列表里（新一轮/被撤销）就清掉，避免右栏挂着幽灵 diff。
        const selected = state.railChange?.selectedId;
        if (selected && !message.view.rows.some((row) => row.changeId === selected)) {
          state.railChange = undefined;
        }
        this.renderChangeSummary();
        return;
      }

      case "changeDiff": {
        // 回包只喂右栏；选中已经变了就丢弃，不必提示。
        const rail = state.railChange;
        if (rail?.selectedId !== message.changeId) return;
        state.railChange = {
          selectedId: rail.selectedId,
          loading: false,
          ...(message.diff ? { diff: message.diff } : {}),
          ...(message.error ? { error: message.error } : {}),
          ...(message.hunks && message.hunks.length > 0 ? { hunks: message.hunks } : {}),
        };
        this.deps.refreshTool("changes");
        return;
      }

      case "usage":
      case "usageDetail":
        state.usage = message.usage;
        composer.updateChrome();
        if (composer.usagePopoverOpen) composer.renderUsagePopover();
        this.deps.refreshTool("context");
        return;

      case "workspaceFiles":
        state.files = {
          items: message.files,
          query: message.query,
          truncated: message.truncated,
          matched: message.matched,
          scanLimit: message.scanLimit,
        };
        this.deps.refreshTool("files");
        return;

      case "compactState":
        if (state.usage) {
          state.usage = {
            ...state.usage,
            compactCapability: message.capability,
            compactBusy: message.busy,
          };
          this.deps.refreshTool("context");
        }
        if (message.message) conversation.appendRow("notice info", message.message);
        return;

      case "composerStatus":
        state.composerLine = message.line;
        composer.updateChrome();
        return;

      case "models":
        state.models = message.models;
        state.model = message.selected;
        state.capabilities = message.capabilities;
        state.modelLabel = message.models.find((m) => m.id === message.selected)?.displayName
          ?? message.selected;
        composer.updateChrome();
        return;

      case "sessions":
        state.sessions = message.sessions;
        state.activeSessionId = message.activeSessionId ?? state.activeSessionId;
        state.sessionQuery = message.query;
        // 宿主只在这条消息里给工作区名；还没收到 workspaces 时先据此立起当前仓库节点。
        state.workspaces.current ??= { path: "", name: message.workspaceName };
        this.deps.el.sessionSearch.value = message.query;
        this.renderSessions();
        return;

      case "workspaces":
        state.workspaces = {
          ...(message.current ? { current: message.current } : {}),
          ...(message.extraFolders ? { extraFolders: message.extraFolders } : {}),
          recent: message.recent,
        };
        this.renderSessions();
        return;

      case "debugState":
        if (message.phase === "await_confirm") conversation.renderDebugConfirm();
        return;

      case "sendQueue":
        state.sendQueue = message.items;
        composer.renderQueueChips();
        return;

      case "clear":
        conversation.clear();
        plan.reset();
        this.deps.todo.reset();
        state.activeSessionId = undefined;
        state.activePlan = undefined;
        state.planCardView = undefined;
        state.liveTaskSteps = undefined;
        state.latestChanges = undefined;
        state.sendQueue = [];
        this.deps.el.sessionTitle.textContent = "新会话";
        composer.renderQueueChips();
        this.renderSessions();
        this.deps.refreshTool("plan");
        this.deps.refreshTool("tasks");
        this.deps.refreshTool("changes");
        return;

      case "restore":
        this.restore(message);
        return;
    }
  }

  /** 运行中的会话只可能是当前这条；状态没变就别重画整棵树。 */
  private runningSessionId(): string | undefined {
    const state = this.deps.state;
    if (!state.busy && !state.turnActive) return undefined;
    return state.activeSessionId;
  }

  private syncRunningIndicator(): void {
    const running = this.runningSessionId();
    if (running === this.paintedRunningSessionId) return;
    this.renderSessions();
  }

  /** sessions 与 workspaces 两类消息都落到这棵树上，任一到达就整体重画。 */
  private renderSessions(): void {
    const state = this.deps.state;
    const running = this.runningSessionId();
    this.paintedRunningSessionId = running;
    renderRepoTree(
      this.deps.el.repoTree,
      {
        ...(state.workspaces.current ? { current: state.workspaces.current } : {}),
        ...(state.workspaces.extraFolders ? { extraFolders: state.workspaces.extraFolders } : {}),
        recent: state.workspaces.recent,
        sessions: state.sessions,
        ...(state.activeSessionId ? { activeSessionId: state.activeSessionId } : {}),
        ...(running ? { runningSessionId: running } : {}),
        ...(state.sessionQuery ? { query: state.sessionQuery } : {}),
      },
      this.repoTree,
      this.deps.post,
      (entry) => this.optimisticSwitchWorkspace(entry),
    );
    this.deps.el.leftMiniRepo.textContent = state.workspaces.current?.name.slice(0, 2) ?? "";
    this.deps.el.leftMiniRepo.title = state.workspaces.current?.path ?? "未选择仓库";
  }

  /**
   * Cursor 式：点击当下就换「当前仓库」并空出对话面，不等宿主拆建完。
   * 随后 host 的 workspaces / clear / sessions 会校准到权威状态。
   */
  private optimisticSwitchWorkspace(entry: { path: string; name: string }): void {
    const state = this.deps.state;
    const previous = state.workspaces.current;
    const same = previous
      && previous.path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase()
        === entry.path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    if (same) return;

    const recent = state.workspaces.recent
      .filter((item) => item.path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase()
        !== entry.path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase());
    if (previous) recent.unshift(previous);

    state.workspaces = {
      current: { path: entry.path, name: entry.name },
      recent,
      ...(state.workspaces.extraFolders ? { extraFolders: state.workspaces.extraFolders } : {}),
    };
    state.sessions = [];
    state.activeSessionId = undefined;
    state.activePlan = undefined;
    state.planCardView = undefined;
    state.liveTaskSteps = undefined;
    state.latestChanges = undefined;
    state.sendQueue = [];
    this.deps.el.sessionTitle.textContent = "新会话";
    this.deps.conversation.clear();
    this.deps.plan.reset();
    this.deps.todo.reset();
    this.deps.composer.renderQueueChips();
    this.renderSessions();
    this.deps.refreshTool("plan");
    this.deps.refreshTool("tasks");
    this.deps.refreshTool("changes");
  }

  /**
   * 变更摘要每轮一张卡（Cursor 式）：挂在本轮回复之后，文件列表可 Diff / 接受 / 拒绝。
   * 流式中途只更新数据与右侧栏，不 seal、不插 DOM，避免卡片插进半截 Markdown。
   */
  private renderChangeSummary(): void {
    const view = this.deps.state.latestChanges;
    if (!view) return;
    // 空列表不配一张卡：卡片标题是「N 个文件已修改」，N 为 0 时那张卡什么也没说。
    // 右栏面板照常刷新——它需要知道当前没有待处理改动。
    if (view.rows.length === 0) {
      this.pendingChangeSummary = false;
      this.deps.refreshTool("changes");
      return;
    }
    const selector = `[data-change-summary="${view.turnId}"]`;
    const existing = this.deps.el.messagesInner.querySelector<HTMLElement>(selector);

    if (!existing && this.shouldDeferChangeSummary()) {
      this.pendingChangeSummary = true;
      this.deps.refreshTool("changes");
      return;
    }

    const card = existing ?? element("section", "card change-summary");
    card.dataset.changeSummary = view.turnId;
    fillChangeSummaryCard(card, view, {
      canApply: this.deps.state.canApplyChanges,
      canRestore: this.deps.state.canRestoreChanges,
      onOpenChange: (changeId) => this.deps.openChangeInRail(changeId),
    }, this.deps.post);

    if (!existing) {
      this.pendingChangeSummary = false;
      this.collapseStaleChangeSummaries(view.turnId);
      this.deps.conversation.appendNode(card);
    }
    this.deps.refreshTool("changes");
  }

  /** 助手还在写 / 本轮还没收尾：变更卡先别进会话流。 */
  private shouldDeferChangeSummary(): boolean {
    return this.deps.conversation.isStreaming
      || this.deps.state.turnActive
      || this.deps.state.busy;
  }

  /** 回复或回合结束后，把延迟的变更卡接到会话末尾。 */
  private flushChangeSummary(): void {
    if (!this.pendingChangeSummary && !this.deps.state.latestChanges) return;
    if (this.shouldDeferChangeSummary()) return;
    this.pendingChangeSummary = false;
    this.renderChangeSummary();
  }

  /** 把更早轮次的变更摘要卡收拢成一行，避免逐轮堆积占满会话流。 */
  private collapseStaleChangeSummaries(currentTurnId: string): void {
    const stale = this.deps.el.messagesInner.querySelectorAll<HTMLElement>("[data-change-summary]");
    for (const old of Array.from(stale)) {
      if (old.dataset.changeSummary === currentTurnId || old.classList.contains("card-collapsed")) continue;
      collapseCard(old, old.dataset.collapseSummary ?? "更早轮次的变更摘要");
    }
  }

  /**
   * 恢复历史：先把条目折成渲染单元（连续的 assistantDelta 合成一条消息），
   * 再交给会话流分页渲染，长会话不会一次性铺满 DOM。
   */
  private restore(message: Extract<HostToWebviewMessage, { type: "restore" }>): void {
    const { state, conversation, composer } = this.deps;
    conversation.clear();
    this.deps.plan.reset();
    this.deps.todo.reset();
    state.model = message.model;
    state.mode = message.mode;
    // 用本地 ses- id 高亮左栏；Grok UUID 不能用来对会话列表。
    if (message.sessionId.startsWith("ses-")) state.activeSessionId = message.sessionId;
    if (message.title) this.deps.el.sessionTitle.textContent = message.title;
    composer.updateChrome();

    const units: RenderUnit[] = [];
    // 与 units 一一对应的可搜内容：搜索要能命中还没渲染的更早分页。
    const drafts: SearchableDraft[][] = [];
    let buffer = "";
    const flush = (): void => {
      const text = buffer;
      buffer = "";
      if (!text.trim()) return;
      units.push(() => conversation.mountAssistant(text));
      drafts.push([{ field: "assistant", text }]);
    };
    for (const entry of message.entries) {
      if (entry.type === "restore" || entry.type === "session") continue;
      if (entry.type === "assistantDelta") {
        buffer += entry.text;
        continue;
      }
      if (entry.type === "assistantEnd") {
        flush();
        continue;
      }
      flush();
      // 时序号在建单元时按时间顺序分配：分页懒渲染乱序执行时，todo 卡仍能识别谁新谁旧。
      const seq = ++this.todoSeq;
      units.push(() => this.apply(entry, seq));
      drafts.push(extractSearchable(entry));
    }
    flush();
    conversation.seedSearchable(drafts);
    conversation.renderHistory(units);
    conversation.collapsePlanDuplicates();
  }
}
