import type { AgentEvent, AgentRuntimeHandle, ToolDisplayKind } from "@lingdong/agent-runtime";
import { detectWriteIntent } from "../ask-intent";
import { composePrompt } from "../context-model";
import { EventPresenter } from "../event-presenter";
import type { HostToWebviewMessage, UiAgentMode } from "../messages";
import { groupKindForAction, groupTitle } from "../presentation/activity-group";
import { classifyTool } from "../presentation/event-classifier";
import type { TurnStatus } from "../presentation/turn-presentation";
import { buildAgentReplyPrompt, buildPlanResearchPrompt } from "../plan-research";
import { describeRuntimeFailure } from "../runtime-failure";
import { turnOutcomeNotice } from "../turn-summary";
import type { UiStateMachine } from "../ui-state";
import type { ChangeFacade } from "./change-facade";
import type { ContextFacade } from "./context-facade";
import type { PermissionFacade } from "./permission-facade";
import type { PlanFacade } from "./plan-facade";
import type { QuestionFacade } from "./question-facade";
import type { SessionService } from "./session-service";
import { isSurfaced } from "./surfaced-error";
import type { TimelineService } from "./timeline-service";
import type { TurnState } from "./turn-state";
import { buildCompletedSummary, parseTestsPassedHint } from "./completed-summary";
import { BackgroundTaskTracker } from "./background-task-tracker";
import { SubagentTracker } from "./subagent-tracker";
import {
  classifyPreparingFailure,
  TurnStatusMachine,
  WAITING_LABEL,
} from "./turn-status-machine";

/**
 * 一轮任务的执行链路：意图拦截 → 连接与会话 → 提示词落盘 → 流式事件 → 变更结算。
 * Runtime 事件的分发也在这里，统一保证「先处理副作用，再推送展示消息」的顺序。
 */

export interface TurnServiceDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  postState(detail?: string): void;
  postModeState(serverMode?: string): void;
  readonly ui: UiStateMachine;
  readonly turn: TurnState;
  readonly changes: ChangeFacade;
  readonly context: ContextFacade;
  readonly permissions: PermissionFacade;
  readonly plans: PlanFacade;
  readonly questions: QuestionFacade;
  readonly sessions: SessionService;
  readonly timeline: TimelineService;
  /**
   * 编辑器里的实时 diff 预览。可选：测试替身与不带编辑器的宿主可以不给，
   * 预览失败也绝不能影响这一轮的执行。
   */
  readonly preview?: EditPreviewSink;
  /**
   * 要不要把模型推理原文送到面板折叠区。缺省视为开。
   * 原文任何情况下都不落盘，这个开关管的只是「界面上给不给看」。
   */
  showReasoning?(): boolean;
  runtime(): AgentRuntimeHandle | undefined;
  ensureStarted(): Promise<AgentRuntimeHandle>;
  ensureStorage(): Promise<void>;
  mode(): UiAgentMode;
  /** Plan 模式下注入的工作区概览。 */
  planOverview(): Promise<string>;
  /** Runtime 回报的模式变化。 */
  onModeChanged(mode: string, source: "server" | "client"): void;
  /** 本轮结束后应用排队中的模式切换。 */
  applyPendingMode(): Promise<void>;
  onDisconnected(reason: string): void;
}

/** TurnService 对预览服务的最小依赖面；实现见 services/edit-preview-service.ts。 */
export interface EditPreviewSink {
  noteEditTarget(toolCallId: string, kind: string, target: string | undefined): void;
  noteDiff(input: {
    toolCallId: string;
    file: string;
    change: "create" | "modify" | "delete";
    oldText: string;
    newText: string;
    pending: boolean;
  }): void;
  reset(): void;
}

/**
 * 参数流阶段只有工具名，没有 Grok 给的 kind，只能按名字猜。
 * 与 tool_started 的 kind 同名同义，用于 Working 文案与编辑预览。
 */
function kindForToolName(name: string | undefined): ToolDisplayKind {
  if (!name) return "other";
  if (/write|edit|create|replace|patch/i.test(name)) return "edit";
  if (/terminal|bash|shell|command/i.test(name)) return "execute";
  if (/read|view|cat/i.test(name)) return "read";
  if (/search|grep|glob|list/i.test(name)) return "search";
  return "other";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 排队上限：防止误触连发把队列灌爆。 */
const SEND_QUEUE_LIMIT = 10;

export class TurnService {
  private readonly presenter = new EventPresenter();
  /** 子 Agent 台账。跨轮存活，只在会话切换时清空。 */
  private readonly subagents = new SubagentTracker();
  /** 后台任务台账。同样跨轮存活——dev server 就是要一直跑着的。 */
  private readonly backgroundTasks = new BackgroundTaskTracker();
  private readonly turnStatus = new TurnStatusMachine({
    isDev: false,
    log: (line) => this.deps.log(line),
  });
  private activeTurn: Promise<void> | undefined;
  /** 一次 sendPrompt 未走完前拒绝第二次进入，避免 UI 卡顿时重复发送。 */
  private sending = false;
  private queueSeq = 0;
  /** Status Bar 耗时刷新；waiting 时机器内部已暂停累计，这里只推快照。 */
  private statusTick: ReturnType<typeof setInterval> | undefined;
  /** 本轮命令输出拼接，仅用于完成摘要的单一 regex 取测试数。 */
  private turnCommandOutput = "";
  private testsPassedHint: number | undefined;
  /**
   * 上一次收到运行时事件的时刻。
   *
   * 状态栏那个秒数是「本轮总共跑了多久」，模型在想和模型不动了长得一模一样。
   * 这个值单独存，用来回答另一个问题：距离上一次有新输出过去多久了。
   */
  private lastActivityAt: number | undefined;
  /**
   * ACP session/load 回放深度。回放只为给模型恢复上下文，
   * 本地 transcript 才是 UI 真相；期间绝不能再 post/persist 历史正文。
   */
  private sessionReplayDepth = 0;

  constructor(private readonly deps: TurnServiceDeps) {}

  get pending(): Promise<void> | undefined { return this.activeTurn; }

  /** 包住 runtime.loadSession：抑制历史回放写入对话区与落盘。 */
  beginSessionReplay(): void {
    this.sessionReplayDepth += 1;
  }

  endSessionReplay(): void {
    this.sessionReplayDepth = Math.max(0, this.sessionReplayDepth - 1);
  }

  /** 会话切换时清掉主状态，避免旧轮次 Status Bar 残留。 */
  resetStatus(): void {
    this.stopStatusTick();
    this.turnStatus.reset();
    this.publishTurnStatus();
    this.subagents.reset();
    this.publishSubagents();
    this.backgroundTasks.reset();
    this.publishBackgroundTasks();
    // 换会话后编辑器里那份「改前」文本已经无从对应，留着只会误导。
    this.deps.preview?.reset();
  }

  private publishSubagents(): void {
    this.deps.post({ type: "subagents", tasks: this.subagents.snapshot() });
  }

  private publishBackgroundTasks(): void {
    this.deps.post({ type: "backgroundTasks", tasks: this.backgroundTasks.snapshot() });
  }

  /** 「查看输出」：返回已收到的输出，找不到卡片时返回 undefined。 */
  backgroundTaskOutput(id: string): string | undefined {
    return this.backgroundTasks.output(id);
  }

  backgroundTask(id: string): ReturnType<BackgroundTaskTracker["find"]> {
    return this.backgroundTasks.find(id);
  }

  /** 终止已被 Grok 确认后，把卡片标成已终止。 */
  noteBackgroundTaskKilled(id: string): void {
    if (this.backgroundTasks.markKilled(id)) this.publishBackgroundTasks();
  }

  private publishTurnStatus(summary?: { filesChanged?: number; testsPassed?: number }): void {
    const snap = this.turnStatus.snapshot();
    const silentMs = this.silentMs();
    this.deps.post({
      type: "turnStatus",
      status: snap.status,
      label: snap.label,
      activeElapsedMs: snap.activeElapsedMs,
      showElapsed: snap.showElapsed,
      visible: snap.visible,
      canStop: snap.canStop,
      connectionActions: snap.connectionActions,
      ...(silentMs !== undefined ? { silentMs } : {}),
      ...(summary ? { summary } : {}),
    });
  }

  /**
   * 距上一次有新输出过去了多久。等用户回卡片时不算静默 —— 那时候等的是人。
   * 返回 undefined 表示这一轮没在跑，或者还没开始计时。
   */
  private silentMs(): number | undefined {
    if (this.lastActivityAt === undefined) return undefined;
    if (!this.turnStatus.isActive) return undefined;
    if (this.turnStatus.current === "waiting_for_user") return undefined;
    return Math.max(0, Date.now() - this.lastActivityAt);
  }

  private startStatusTick(): void {
    this.stopStatusTick();
    this.statusTick = setInterval(() => {
      if (!this.turnStatus.isActive) {
        this.stopStatusTick();
        return;
      }
      this.publishTurnStatus();
    }, 1000);
  }

  private stopStatusTick(): void {
    if (this.statusTick !== undefined) {
      clearInterval(this.statusTick);
      this.statusTick = undefined;
    }
  }

  private transitionMain(
    next: Parameters<TurnStatusMachine["transition"]>[0],
    label?: string,
    summary?: { filesChanged?: number; testsPassed?: number },
  ): boolean {
    const ok = this.turnStatus.transition(next, label);
    if (ok) this.publishTurnStatus(summary);
    return ok;
  }

  /** 丢弃流式正文与普通 Timeline；侧效（停表、断开）仍可走。 */
  private shouldDiscardStreamEvent(event: AgentEvent): boolean {
    if (!this.turnStatus.discardStream) return false;
    switch (event.type) {
      case "text_delta":
      case "thought_delta":
      case "tool_started":
      case "tool_progress":
      case "tool_completed":
      case "command_output":
      case "file_changed":
      case "file_diff":
      case "status":
      case "subagent_started":
        return true;
      default:
        return false;
    }
  }

  private noteModelEvent(event: AgentEvent): void {
    // 正文出字：结束「准备/等待」进入思考态；已经在执行工具时不要被正文碎片拽回「思考中」。
    if (event.type === "text_delta") {
      if (this.turnStatus.current === "preparing" || this.turnStatus.current === "waiting_for_user") {
        this.transitionMain("thinking");
      }
      return;
    }
    // 私有推理：只在还没开始干活时显示「思考中」。
    // 工具参数流（写文件）期间 Grok 仍可能穿插 thought_chunk；若跟着切回思考，
    // 状态栏又会变成「思考中」+ 假静默，跟 Cursor 的 Editing 体验对着干。
    if (event.type === "thought_delta") {
      if (this.turnStatus.current === "preparing" || this.turnStatus.current === "waiting_for_user") {
        this.transitionMain("thinking");
      }
      // working / thinking 保持原状：工具进行中的穿插推理不该把状态拽回「思考中」。
      return;
    }
    if (event.type === "tool_started") {
      this.deps.preview?.noteEditTarget(event.toolCallId, event.kind, event.target);
      this.enterWorkingFromTool(event);
      return;
    }
    // 阻塞式派发：父 Agent 此刻什么也做不了，状态栏必须说清是在等谁，
    // 否则用户看到的只是「正在执行…」秒数不停涨，像是卡死了。
    if (event.type === "subagent_started" && !event.background) {
      this.transitionMain("waiting_for_subagent", `等待子 Agent：${event.description}…`);
      return;
    }
    if (event.type === "subagent_completed") {
      // 还有别的阻塞子 Agent 在跑就继续等，文案换成那一个。
      const blocking = this.subagents.blockingTask(event.toolCallId);
      if (blocking) {
        this.transitionMain("waiting_for_subagent", `等待子 Agent：${blocking.description}…`);
      } else if (this.turnStatus.current === "waiting_for_subagent") {
        this.transitionMain("working");
      }
      return;
    }
    // 参数还在流：若还停在思考态就切到 working。
    // 静默计时靠 handleEvent 入口的 lastActivityAt，不必每条 progress 都推状态栏
    // （一场写文件能有上万条 arguments_delta）。
    // 路径一旦从参数片段里解析出来，立刻把「正在修改代码…」收成「正在修改 models.html…」。
    if (event.type === "tool_progress") {
      // 参数流阶段就把目标文件揭示出来。前后全文要等工具报 diff，这中间可能有几秒，
      // 至少先让用户看见它在动哪个文件。
      this.deps.preview?.noteEditTarget(event.toolCallId, kindForToolName(event.name), event.target);
      const label = this.labelForToolName(event.name, event.target);
      if (
        this.turnStatus.current === "preparing"
        || this.turnStatus.current === "thinking"
        || this.turnStatus.current === "waiting_for_user"
      ) {
        this.transitionMain("working", label);
      } else if (this.turnStatus.current === "working" && event.target) {
        if (this.turnStatus.setWorkingLabel(label)) this.publishTurnStatus();
      }
    }
  }

  private enterWorkingFromTool(event: Extract<AgentEvent, { type: "tool_started" }>): void {
    const label = this.labelForToolName(event.name, event.target);
    if (
      this.turnStatus.current === "preparing"
      || this.turnStatus.current === "thinking"
      || this.turnStatus.current === "waiting_for_user"
      || this.turnStatus.current === "working"
    ) {
      this.transitionMain("working", label);
    } else {
      this.turnStatus.setWorkingLabel(label);
      this.publishTurnStatus();
    }
  }

  private labelForToolName(name: string | undefined, target?: string): string {
    if (!name && !target) return "正在执行…";
    const normalized = name
      ? classifyTool({
          toolCallId: "progress",
          kind: kindForToolName(name),
          name,
          label: name,
          readOnly: /read|list|search|grep|glob/i.test(name),
          ...(target ? { target } : {}),
        })
      : undefined;
    const title = normalized
      ? groupTitle(groupKindForAction(normalized.action), "running")
      : "正在执行";
    const short = target
      ? target.replace(/\\/g, "/").split("/").filter(Boolean).pop()
      : undefined;
    // 对标 Cursor：Working 跟具体文件走（Editing models.html），不一直停在笼统「修改代码」。
    if (short && normalized && (normalized.action === "edit" || normalized.action === "create"
      || normalized.action === "read" || normalized.action === "delete" || normalized.action === "rename")) {
      const verb = normalized.action === "read" ? "正在查看"
        : normalized.action === "create" ? "正在新建"
          : normalized.action === "delete" ? "正在删除"
            : "正在修改";
      return `${verb} ${short}…`;
    }
    return /…$/.test(title) ? title : `${title}…`;
  }

  private enterWaitingForUser(label?: string): void {
    if (
      this.turnStatus.current === "preparing"
      || this.turnStatus.current === "thinking"
      || this.turnStatus.current === "working"
      || this.turnStatus.current === "waiting_for_user"
    ) {
      this.transitionMain("waiting_for_user", label);
    }
  }

  private leaveWaitingForUser(next: "thinking" | "working" = "working"): void {
    if (this.turnStatus.current === "waiting_for_user") {
      this.transitionMain(next);
    }
  }

  private completedSummary() {
    return buildCompletedSummary({
      filesChanged: this.deps.changes.changedFileCount,
      commandOutput: this.turnCommandOutput,
    });
  }

  private noteCommandOutput(text: string): void {
    this.turnCommandOutput += text;
    const n = parseTestsPassedHint(this.turnCommandOutput);
    if (n !== undefined) this.testsPassedHint = n;
  }

  async send(text: string, options: { skipIntentCheck?: boolean } = {}): Promise<void> {
    // 对标 Cursor：忙时不再硬拒绝，入队等本轮结束后自动发送。
    if (this.sending || this.deps.ui.busy) {
      this.enqueue(text);
      return;
    }
    // initializing 是预热/重连的过渡态：直接放行，
    // sendInner 里的 ensureStarted 会等在飞的启动完成（启动有并发去重）。
    if (!this.deps.ui.canSend && this.deps.ui.state !== "initializing") {
      this.deps.post({ type: "error", message: "当前状态无法发送消息，请稍后重试。" });
      return;
    }
    this.sending = true;
    try {
      await this.sendInner(text, options);
    } finally {
      this.sending = false;
      this.maybeSendQueued();
    }
  }

  /** 删除一条排队中的消息。 */
  removeQueued(id: string): void {
    const queue = this.deps.turn.sendQueue;
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    queue.splice(index, 1);
    this.publishQueue();
  }

  /** 就地改写一条排队消息的文本；空文本视为删除。 */
  editQueued(id: string, text: string): void {
    const queue = this.deps.turn.sendQueue;
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    const next = text.trim();
    if (next.length === 0) {
      this.removeQueued(id);
      return;
    }
    item.text = next;
    this.publishQueue();
  }

  /** 按给定顺序重排队列；未列出的条目保持原相对次序追加在后。 */
  reorderQueue(orderedIds: string[]): void {
    const queue = this.deps.turn.sendQueue;
    if (queue.length === 0) return;
    const rank = new Map(orderedIds.map((id, index) => [id, index] as const));
    // 稳定排序：给出名次的按名次排，其余留在原处（用足够大的名次占位）。
    const decorated = queue.map((item, index) => ({ item, index }));
    decorated.sort((a, b) => {
      const ra = rank.get(a.item.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.item.id) ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : a.index - b.index;
    });
    const reordered = decorated.map((entry) => entry.item);
    if (reordered.every((item, index) => item === queue[index])) return;
    queue.splice(0, queue.length, ...reordered);
    this.publishQueue();
  }

  /** 立即发送一条排队中的消息；执行中只能等本轮结束自动出队。 */
  async flushQueued(id: string): Promise<void> {
    const queue = this.deps.turn.sendQueue;
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    if (this.sending || this.deps.ui.busy) {
      this.deps.post({ type: "notice", level: "info", message: "任务执行中，该消息会在本轮结束后自动发送。" });
      return;
    }
    const [item] = queue.splice(index, 1);
    this.publishQueue();
    if (item) await this.send(item.text);
  }

  /** 新建/切换会话时清空队列：排队消息是对旧会话说的。 */
  clearQueue(): void {
    this.resetStatus();
    if (this.deps.turn.sendQueue.length === 0) return;
    this.deps.turn.sendQueue.length = 0;
    this.publishQueue();
  }

  /** 连接就绪后排空队列：预热/重连期间入队的消息在这里续发。 */
  drainQueue(): void {
    this.maybeSendQueued();
  }

  /** 面板重新挂载时补发队列快照。 */
  publishQueue(): void {
    this.deps.post({
      type: "sendQueue",
      items: this.deps.turn.sendQueue.map((item) => ({ id: item.id, text: item.text })),
    });
  }

  private enqueue(text: string): void {
    const queue = this.deps.turn.sendQueue;
    if (queue.length >= SEND_QUEUE_LIMIT) {
      this.deps.post({ type: "notice", level: "warn", message: `排队消息已达上限（${SEND_QUEUE_LIMIT} 条），请等待当前任务完成。` });
      return;
    }
    queue.push({ id: `q${++this.queueSeq}`, text });
    this.publishQueue();
  }

  /**
   * 轮次收尾后的自动续发。只在正常结束时出队：
   * 用户主动停止（cancelled）说明想变更方向，队列保留待手动处理；
   * 失败（error 态）自动续发只会把队列灌进同一个坑。
   */
  private maybeSendQueued(): void {
    const queue = this.deps.turn.sendQueue;
    if (queue.length === 0) return;
    if (this.sending) return; // 发送路径内部的连接就绪回调，续发交给 finally
    if (this.deps.turn.pendingPrompt !== undefined) return; // Ask 意图拦截未决
    const reason = this.deps.turn.stopReason;
    if (reason === "cancelled" || reason === "canceled") return;
    if (this.deps.ui.state === "error" || !this.deps.ui.canSend) return;
    const next = queue.shift();
    if (!next) return;
    this.publishQueue();
    void this.send(next.text).catch((error: unknown) => {
      this.deps.log(`[queue] 自动续发失败：${errorText(error)}`);
    });
  }

  /** Ask 模式拦截后的「仍然只做分析」与「切换模式后继续」都走这里。 */
  async continuePending(): Promise<void> {
    const text = this.deps.turn.pendingPrompt;
    if (!text) {
      this.deps.post({ type: "notice", level: "info", message: "没有待发送的内容。" });
      return;
    }
    this.deps.turn.pendingPrompt = undefined;
    await this.send(text, { skipIntentCheck: true });
  }

  async stop(): Promise<void> {
    const canStop = this.turnStatus.snapshot().canStop || this.deps.ui.canCancel;
    if (!canStop) {
      this.deps.post({ type: "notice", level: "info", message: "当前没有正在执行的任务。" });
      return;
    }
    // 立刻进入 stopping：Status Bar 与停止按钮同时收口，不等 cancel RPC 返回。
    this.transitionMain("stopping");
    this.deps.ui.transition("cancelling");
    this.deps.postState();
    this.deps.timeline.stop();
    // waiting 时挂起的权限 / 提问 / Plan 审批必须清掉，不能悬空。
    this.deps.permissions.clearCards("任务已取消");
    const runtime = this.deps.runtime();
    if (!runtime) {
      // preparing 阶段可能还没拿到 Runtime：直接收口，避免「点了停却没反应」。
      this.deps.turn.stopReason = "cancelled";
      this.transitionMain("stopped");
      this.stopStatusTick();
      this.deps.post({ type: "busy", busy: false });
      if (this.deps.ui.state !== "disposed") this.deps.ui.force("ready");
      this.deps.postState();
      return;
    }
    try {
      await runtime.cancel();
    } catch (error) {
      this.deps.post({ type: "error", message: `停止失败：${errorText(error)}`, recoverable: true });
    }
  }

  private async sendInner(text: string, options: { skipIntentCheck?: boolean }): Promise<void> {
    const mode = this.deps.mode();
    if (!options.skipIntentCheck && (mode === "ask" || mode === "debug")) {
      const intent = detectWriteIntent(text);
      if (intent.matched) {
        this.deps.turn.pendingPrompt = text;
        if (mode === "debug") {
          this.deps.turn.debugPhase = "await_confirm";
          this.deps.post({
            type: "debugState",
            phase: "await_confirm",
            message: "Debug 初始阶段禁止直接写入；确认方案后可切到 Agent 修复。",
          });
        }
        this.deps.post({
          type: "askIntent",
          reason: intent.reason ?? "请求包含修改意图",
          ...(intent.keyword ? { keyword: intent.keyword } : {}),
        });
        return;
      }
    }
    if (mode === "debug" && this.deps.turn.debugPhase === "idle") {
      this.deps.turn.debugPhase = "propose";
      this.deps.post({
        type: "debugState",
        phase: "propose",
        message: "Debug：先只读收集问题与复现路径。",
      });
    }
    this.deps.turn.pendingPrompt = undefined;
    this.deps.post({ type: "userMessage", text });

    const contextItems = this.deps.context.take();
    this.deps.context.publishItems();
    if (contextItems.length > 0) {
      this.deps.post({
        type: "notice",
        level: "info",
        message: `已附加上下文：${contextItems.map((item) => item.label).join("、")}`,
      });
    }

    this.turnStatus.beginTurn();
    this.turnCommandOutput = "";
    this.testsPassedHint = undefined;
    this.lastActivityAt = Date.now();
    this.publishTurnStatus();
    this.startStatusTick();

    await this.deps.ensureStorage();

    let runtime: AgentRuntimeHandle;
    try {
      runtime = await this.deps.ensureStarted();
      await this.deps.sessions.ensureCurrent(runtime);
    } catch (error) {
      const detail = errorText(error);
      const kind = classifyPreparingFailure(detail);
      this.transitionMain(kind);
      this.stopStatusTick();
      this.deps.ui.force("error");
      this.deps.postState(detail);
      if (kind === "interrupted") {
        // 连接类：只在 Status Bar，聊天区不刷错误卡。
        this.deps.post({ type: "connection", state: "failed", detail });
      } else if (!isSurfaced(error)) {
        // Provider / 模型类：只聊天区一张卡。
        // 编排层已经发过带按钮的卡时不再补一张，否则同一句话出现两遍。
        this.deps.post({
          type: "error",
          message: describeRuntimeFailure(detail, { ...(this.deps.runtime()?.model ? { modelId: this.deps.runtime()!.model } : {}) }),
          recoverable: true,
        });
      }
      return;
    }

    // 必须等会话建立后再写：transcript 在 ensureCurrent 里才切到本会话文件，
    // 更早 append 会落进占位文件并在切换时被丢弃，导致新会话第一条用户消息恢复不出来。
    this.deps.sessions.appendUserPrompt(text, contextItems.map((item) => item.label));

    const promptForRuntime = this.deps.mode() === "plan"
      ? buildPlanResearchPrompt(text, await this.deps.planOverview())
      : buildAgentReplyPrompt(text);
    const running = this.run(runtime, text, contextItems, promptForRuntime);
    this.activeTurn = running.finally(() => { this.activeTurn = undefined; });
    await this.activeTurn;
  }

  /** 一轮任务的完整执行：轮次登记、事件消费、结束后的变更结算。 */
  private async run(
    runtime: AgentRuntimeHandle,
    text: string,
    contextItems: ReturnType<ContextFacade["take"]>,
    runtimeText: string,
  ): Promise<void> {
    this.presenter.reset();
    this.resetStats();
    const sessionId = runtime.sessionId ?? "unknown-session";
    this.deps.changes.startTurn({
      sessionId,
      mode: this.deps.mode(),
      prompt: text,
      contextLabels: contextItems.map((item) => item.label),
    });
    // 时间线与变更共用 ChangeTracker 分配的 turnId，保证两边指的是同一轮。
    const turnId = this.deps.changes.currentTurnId;
    if (turnId) this.deps.timeline.begin({ sessionId, turnId });
    this.deps.ui.transition("sending");
    this.deps.postState();
    this.deps.post({ type: "busy", busy: true });
    let failed = false;
    try {
      const request = { text: composePrompt(runtimeText, contextItems) };
      for await (const event of runtime.sendMessage(request)) {
        this.handleEvent(event);
      }
      this.deps.ui.transition("completed");
    } catch (error) {
      failed = true;
      // 日志留原文，界面给能据以行动的那一句。
      this.deps.log(`[prompt] ${errorText(error)}`);
      this.deps.ui.force("error");
      const detail = errorText(error);
      const kind = classifyPreparingFailure(detail);
      if (kind === "interrupted" && !this.turnStatus.isTerminal) {
        this.transitionMain("interrupted");
        this.deps.post({ type: "connection", state: "failed", detail });
      } else if (!this.turnStatus.isTerminal) {
        this.transitionMain("failed");
        const modelId = this.deps.runtime()?.model;
        this.deps.post({
          type: "error",
          message: `任务失败：${describeRuntimeFailure(detail, { ...(modelId ? { modelId } : {}) })}`,
          recoverable: true,
        });
      }
    } finally {
      this.stopStatusTick();
      this.deps.permissions.clearCards("本轮任务已结束");
      this.deps.turn.pendingPlan = false;
      const timelineStatus = this.resolveTurnStatus(failed);
      if (this.turnStatus.current === "stopping") {
        this.transitionMain("stopped");
      } else if (!this.turnStatus.isTerminal) {
        if (timelineStatus === "stopped") {
          this.transitionMain("stopping");
          this.transitionMain("stopped");
        } else if (timelineStatus === "failed") {
          this.transitionMain("failed");
        } else {
          this.transitionMain("completed", undefined, this.completedSummary());
        }
      } else if (this.turnStatus.current === "completed") {
        this.publishTurnStatus(this.completedSummary());
      } else {
        this.publishTurnStatus();
      }
      // 阻塞式子 Agent 若到这一步还在转圈，说明它的收尾事件没送到，别让卡片永远转下去。
      // 被停掉或失败时连 background 的一起结算：那种情况下 CLI 已经带着它们一起没了。
      const abnormal = timelineStatus === "failed" || timelineStatus === "stopped";
      if (this.subagents.settleRunning(
        timelineStatus === "failed" ? "failed" : "completed",
        { includeBackground: abnormal },
      )) {
        this.publishSubagents();
      }
      if (this.deps.ui.state !== "error" && this.deps.ui.state !== "disposed") {
        this.deps.ui.transition("ready");
      }
      this.deps.post({ type: "busy", busy: false });
      await this.finalize(timelineStatus);
      await this.deps.applyPendingMode();
      this.deps.postState();
      // 批准即开跑：这里补发的构建提示词会先进队列，紧随其后的 maybeSendQueued
      // （在 send 的 finally 里）负责发出去。放在 postState 之后是为了让
      // UI 已经回到 ready，队列才肯出队。
      await this.deps.plans.onTurnSettled(timelineStatus === "failed"
        ? "failed"
        : timelineStatus === "stopped" ? "stopped" : "completed");
    }
  }

  /** 时间线终态：异常即失败，用户取消即已停止，其余为已完成。 */
  private resolveTurnStatus(failed: boolean): TurnStatus {
    if (failed) return "failed";
    const reason = this.deps.turn.stopReason;
    return reason === "cancelled" || reason === "canceled" ? "stopped" : "completed";
  }

  private resetStats(): void {
    this.deps.changes.resetTurnStats();
    this.deps.permissions.resetTurnStats();
    this.deps.turn.stopReason = undefined;
    this.turnCommandOutput = "";
    this.testsPassedHint = undefined;
  }

  private async finalize(status: TurnStatus): Promise<void> {
    const stopReason = this.deps.turn.stopReason;
    const cancelled = stopReason === "cancelled" || stopReason === "canceled";
    const turn = await this.deps.changes.finalize(cancelled);
    // 变更结算完才有可靠的文件数量，时间线在这之后才收尾。
    this.deps.timeline.finish({ status });
    if (!turn) return;

    const persistence = this.deps.sessions.persistence;
    await persistence?.syncTurn(turn, {
      completedAt: Date.now(),
      ...(stopReason ? { stopReason } : {}),
      verificationStatus: this.deps.permissions.turnRejectedExecute ? "unverified" : "unknown",
    });

    const current = this.deps.sessions.current;
    if (current) {
      if (this.deps.sessions.firstPromptInSession) {
        await persistence?.sessions.applyAutoTitle(current.id, turn.prompt);
        this.deps.sessions.firstPromptInSession = false;
      }
      await this.deps.sessions.syncCounters({
        lastTurnId: turn.turnId,
        turnCount: (current.turnCount ?? 0) + 1,
        messageCount: (current.messageCount ?? 0) + 1,
        lastSummary: turn.prompt.trim().slice(0, 80),
        localMode: this.deps.mode(),
        contextUsage: this.deps.context.usage.current,
      });
      void this.deps.sessions.flush();
    }

    if (turn.changedFiles.length === 0) return;
    const conflicts = this.deps.changes.publishFinalized(turn);
    if (this.deps.ui.transition(conflicts ? "conflict" : "reviewing_changes")) {
      this.deps.postState();
    }
  }

  /** Runtime 事件入口；轮次之外的事件（模式切换、异常退出）也走这里。 */
  handleEvent(event: AgentEvent): void {
    // 收到任何东西都算「还活着」，哪怕是被下面几段吞掉的事件。
    this.lastActivityAt = Date.now();
    // session/load 回放：本地已 restore，这里只放行模式/断线，其余一律吞掉。
    if (this.sessionReplayDepth > 0) {
      if (event.type === "status") {
        this.deps.log(`[status:replay] ${event.message}`);
        return;
      }
      if (event.type === "mode_changed") {
        this.applySideEffects(event);
        for (const message of this.presenter.present(event)) this.deps.post(message);
        return;
      }
      if (event.type === "disconnected") {
        this.applySideEffects(event);
        for (const message of this.presenter.present(event)) this.deps.post(message);
        return;
      }
      return;
    }

    if (this.shouldDiscardStreamEvent(event)) return;

    if (this.deps.ui.state === "sending") this.deps.ui.transition("streaming");
    this.noteModelEvent(event);
    this.applySideEffects(event);

    // stopped / completed 等终态后不再往 Timeline 灌普通事件（discard 已挡）；
    // 断开与完成仍要让时间线收尾。
    if (!this.turnStatus.discardStream || event.type === "disconnected" || event.type === "completed") {
      this.deps.timeline.handleEvent(event);
    }

    if (this.turnStatus.discardStream && (event.type === "text_delta" || event.type === "thought_delta")) {
      return;
    }

    for (const message of this.presenter.present(event)) {
      // 连接中断不在聊天区再刷错误卡（Status Bar 已有）。
      if (this.turnStatus.current === "interrupted" && message.type === "error") continue;
      if (message.type === "reasoningDelta") {
        // 推理原文：开关关掉就整条不发；无论开关如何都不落盘。
        if (this.deps.showReasoning?.() !== false) this.deps.post(message);
        continue;
      }
      this.deps.post(message);
      this.deps.sessions.persistHostMessage(message);
    }
    if (event.type === "completed") this.postOutcome(event.stopReason);
  }

  private applySideEffects(event: AgentEvent): void {
    switch (event.type) {
      case "status":
        // 模式与会话类信息只进日志，对话区只显示最终模式。
        this.deps.log(`[status] ${event.message}`);
        return;
      case "file_changed":
        this.deps.changes.noteFileChanged(event.path);
        return;
      case "file_diff":
        // 边写边看：Grok 一给出前后全文就把 diff 摆进编辑器，不等这一轮收尾。
        this.deps.preview?.noteDiff({
          toolCallId: event.toolCallId,
          file: event.path,
          change: event.change,
          oldText: event.oldText,
          newText: event.newText,
          pending: event.pending,
        });
        return;
      case "subagent_started":
      case "subagent_completed":
      case "subagent_output":
        if (this.subagents.handleEvent(event)) this.publishSubagents();
        return;
      case "background_task":
        if (this.backgroundTasks.handleEvent(event)) this.publishBackgroundTasks();
        return;
      case "command_output":
        this.deps.context.appendTerminalBuffer(event.text);
        this.noteCommandOutput(event.text);
        // 后台任务派发那次调用的输出（启动回执、日志路径）要归到它的卡片上。
        if (this.backgroundTasks.handleEvent(event)) this.publishBackgroundTasks();
        return;
      case "permission_requested":
        this.enterWaitingForUser(WAITING_LABEL.permission);
        this.deps.permissions.noteOperation(event.requestId, event.decision.operation);
        this.deps.permissions.handleRequested(event.requestId, event.decision, event.label);
        return;
      case "permission_resolved":
        this.deps.permissions.handleResolved(event.requestId, event.resolution);
        // 超时拒绝：回到 working（模型继续），不是 failed。
        if (event.resolution === "expired") this.leaveWaitingForUser("working");
        else if (event.resolution === "cancelled") { /* stop 路径会进 stopping */ }
        else this.leaveWaitingForUser("working");
        return;
      case "plan_updated":
        // 执行进度写回 PlanRecord，计划文档里的步骤随执行打勾；卡片呈现仍由 presenter 出。
        this.deps.plans.handleExecutingUpdate(event.plan);
        return;
      case "plan_review_requested":
        this.enterWaitingForUser(WAITING_LABEL.plan);
        this.deps.plans.handleReviewRequested(event.plan);
        return;
      case "plan_review_closed":
        this.deps.plans.handleReviewClosed();
        this.leaveWaitingForUser("working");
        return;
      case "question_requested":
        this.enterWaitingForUser(WAITING_LABEL.question);
        this.deps.questions.handleRequested(event.requestId, event.request);
        return;
      case "question_resolved":
        this.deps.questions.handleResolved(event.requestId, event.outcome, event.answers);
        this.leaveWaitingForUser("thinking");
        return;
      case "mode_changed":
        this.deps.onModeChanged(event.mode, event.source);
        return;
      case "token_usage":
        this.recordUsage(event);
        return;
      case "context_compacted":
        this.deps.context.usage.compactionCompleted(event.trigger);
        this.deps.context.pushUsage();
        return;
      case "disconnected":
        // 先停表再交给控制器重连，旧时间线不得继续显示「正在执行」。
        if (!this.turnStatus.isTerminal) this.transitionMain("interrupted");
        this.stopStatusTick();
        this.deps.timeline.noteDisconnected(event.reason);
        this.deps.onDisconnected(event.reason);
        return;
      case "completed": {
        this.deps.turn.stopReason = event.stopReason;
        const cancelled = event.stopReason === "cancelled" || event.stopReason === "canceled";
        if (cancelled && !this.turnStatus.isTerminal) {
          // 合法路径是 * → stopping → stopped；Runtime 直接报 cancelled 时补上中间态。
          if (this.turnStatus.current !== "stopping") this.transitionMain("stopping");
          this.transitionMain("stopped");
        }
        return;
      }
      default:
        return;
    }
  }

  private recordUsage(event: Extract<AgentEvent, { type: "token_usage" }>): void {
    const before = this.deps.context.usage.current;
    if (event.source === "exact") {
      this.deps.context.usage.recordExact({
        ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
        ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
        ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
        ...(event.cachedReadTokens === undefined ? {} : { cachedReadTokens: event.cachedReadTokens }),
        ...(event.reasoningTokens === undefined ? {} : { reasoningTokens: event.reasoningTokens }),
      });
    } else if (event.totalTokens !== undefined && event.totalTokens > 0) {
      // 流式 _meta.totalTokens：以前直接丢弃，Composer 圆环永远不亮。
      this.deps.context.usage.recordStream(event.totalTokens);
    } else {
      return;
    }
    const after = this.deps.context.usage.current;
    // recordStream 在数值不变时短路且不 emit；这里也别空推。
    if (
      after.usedTokens === before.usedTokens
      && after.source === before.source
      && after.percentage === before.percentage
    ) {
      return;
    }
    const current = this.deps.sessions.current;
    if (current && event.source === "exact") {
      // 用量落盘失败不该打断这一轮，但也不能让异常裸奔成
      // 「rejected promise not handled」——那种报错既吓人又指不到现场。
      void this.deps.sessions.persistence?.sessions
        .patch(current.id, { contextUsage: this.deps.context.usage.current })
        .catch((error: unknown) => this.deps.log(`[storage] 用量写入失败：${errorText(error)}`));
    }
    // recordExact/recordStream 已通过 emit → pushUsage；此处兜底一次，
    // 避免未来改掉 emit 链路后 UI 又静默。
    this.deps.context.pushUsage();
  }

  private postOutcome(stopReason: string): void {
    const notice = turnOutcomeNotice({
      stopReason,
      changedFiles: this.deps.changes.changedFileCount,
      rejectedExecute: this.deps.permissions.turnRejectedExecute,
    });
    if (notice) this.deps.post({ type: "notice", level: notice.level, message: notice.message });
  }
}
