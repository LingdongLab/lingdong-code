import type {
  AskQuestionCardView,
  AskQuestionItemView,
  PermissionCardView,
  PermissionStepView,
  SetupActionButton,
} from "../messages";
import {
  extractSearchable,
  type SearchableDraft,
  type SearchableRecord,
  type TimelineAnchor,
} from "../search/search-result";
import { describeStopReason } from "../turn-summary";
import type { AppElements, Post } from "./app-context";
import { collapseCard, disableActions, element } from "./dom-utils";
import { attachMessageActions, createUserMessage, markStopped } from "./message-actions";
import {
  collapseDuplicatePlanMarkdown,
  createStreamingAssistant,
  isDisplayNoise,
  mountAssistantMessage,
  type StreamRenderHandle,
} from "./message-renderer";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolTurnAggregator } from "./tool-aggregate";
import { TimelineView } from "./timeline/timeline-view";
import type { ActivityGroupHeader } from "../presentation/activity-group";
import type { ActivityItem } from "../presentation/activity-item";
import type { TurnPresentation, TurnPresentationHeader } from "../presentation/turn-presentation";

/**
 * 中间会话流：用户气泡、流式助手正文、工具摘要、权限卡片与提示行。
 *
 * 两条硬规则：
 * 1. 任何非流式内容入场前先给当前助手气泡「封口」，保证时间顺序，
 *    否则最终答复会停在工具摘要上方。
 * 2. 恢复长会话时只渲染尾部若干条，其余按页补渲染，避免一次性铺几千个节点。
 */

/**
 * 风险等级 → 卡片上的安全结论。
 *
 * 不再把「高风险」三个字直接甩给用户：那句话只说了严重程度，没说严重在哪，
 * 看第二遍还是不知道该不该点允许。这里只给一个能一眼判断要不要细看的结论，
 * 具体后果交给下面的「要注意」逐条讲。
 */
const RISK_VERDICT: Record<string, { text: string; tone: string }> = {
  low: { text: "可放心执行", tone: "safe" },
  medium: { text: "需要留意", tone: "caution" },
  high: { text: "有风险", tone: "danger" },
  blocked: { text: "已拦下", tone: "danger" },
};

const OPERATION_LABELS: Record<string, string> = {
  read: "读取文件",
  write: "修改文件",
  delete: "删除文件",
  execute: "运行命令",
};

/** 步骤里重复展示的命令段长度上限；完整命令在上面的代码块里已经有了。 */
const MAX_STEP_COMMAND = 80;
/** 模型自述意图的长度上限：这段文本由模型控制，不让它把卡片顶出屏幕。 */
const MAX_INTENT = 300;

function clipText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function permissionSection(label: string, body: HTMLElement): HTMLElement {
  const box = element("div", "perm-section");
  box.appendChild(element("div", "perm-section-title", label));
  box.appendChild(body);
  return box;
}

/** 单步直接一句话；多步编号列出，并带上各自对应的命令段，链式命令才对得上。 */
function permissionSteps(steps: readonly PermissionStepView[]): HTMLElement {
  if (steps.length <= 1) {
    return element("div", "perm-step-single", steps[0]?.action ?? "");
  }
  const list = element("ol", "perm-steps");
  for (const step of steps) {
    const item = element("li");
    if (step.command) {
      item.appendChild(element("code", "perm-step-cmd", clipText(step.command, MAX_STEP_COMMAND)));
    }
    item.appendChild(element("span", "perm-step-action", step.action));
    list.appendChild(item);
  }
  return list;
}

function permissionNotes(notes: readonly string[]): HTMLElement {
  const list = element("ul", "perm-notes");
  for (const note of notes) list.appendChild(element("li", undefined, note));
  return list;
}

/** 恢复时先渲染的最新条目数，其余折叠成「加载更早消息」。 */
export const RESTORE_PAGE_SIZE = 60;

/** 问答卡给出结论后锁死整卡：按钮和选项/文本输入一起禁用。 */
function lockQuestionCard(card: HTMLElement): void {
  disableActions(card);
  for (const input of Array.from(card.querySelectorAll("input"))) input.disabled = true;
}

export interface ConversationDeps {
  el: Pick<AppElements, "messages" | "messagesInner" | "empty">;
  post: Post;
  canSend(): boolean;
  onOpenLink(href: string): void;
  /** 点正文里的 `path:line` 引用。 */
  onOpenFile(ref: { relativePath: string; line?: number }): void;
  onViewPlan(): void;
}

export type RenderUnit = () => void;

/** 会话流里的「思考 Ns」折叠块：思考期间转动，结束后停成一行历史。 */
interface ThinkingBlock {
  root: HTMLDetailsElement;
  label: HTMLElement;
  elapsed: HTMLElement;
  steps: HTMLElement;
  seen: Set<string>;
  indicator: ThinkingIndicator;
  /** 推理原文的容器；只有真收到原文时才挂进 DOM。 */
  reasoning: HTMLElement;
  reasoningText: string;
  /**
   * 这一轮累计的思考秒数。
   *
   * 模型会把推理和正文交替吐出来，中间每次停表都会让指示器从零重新计时，
   * 所以总时长得自己累加，否则标题上显示的只是最后那一小段。
   */
  elapsedSeconds: number;
}

/**
 * 推理原文的显示上限。
 *
 * 一轮能想出几万字，全塞进 DOM 会让长会话越滚越卡。留尾部：
 * 推理是越往后越接近结论，开头那些试探反而没什么用。
 */
const MAX_REASONING_CHARS = 20_000;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export class ConversationView {
  /** 旧版工具摘要，仅用于恢复 v1 会话记录；新会话由 timeline 接管。 */
  readonly tools = new ToolTurnAggregator();
  readonly timeline: TimelineView;

  /** 本会话已出现任务时间线时，旧版工具摘要一律不再渲染，杜绝两套工具记录并存。 */
  private timelineActive = false;
  private streaming: StreamRenderHandle | undefined;
  private streamingUnit: number | undefined;
  private readonly toolRoots = new Map<string, HTMLDetailsElement>();
  private currentPermission: { requestId: string; root: HTMLElement; title: string } | undefined;
  private currentQuestion: { requestId: string; root: HTMLElement } | undefined;
  /** 权限卡片已给出结论文案时，跳过紧随其后的重复 notice。 */
  private suppressPermissionNotice = false;
  private lastUserPrompt: string | undefined;
  /** 用户主动停止后，给当前气泡打「已停止生成」标记。 */
  private stopRequested = false;
  /** 未渲染的历史条目（越靠前越旧）。 */
  private pendingHistory: RenderUnit[] = [];
  private historyButton: HTMLButtonElement | undefined;
  private appendTarget: HTMLElement | undefined;
  /**
   * 当前轮次容器：用户消息开一个新的，本轮所有产物都挂进去。
   * 轮次边界靠它画分隔线，不然长会话里看不出「这段回复是回应哪句话」。
   */
  private currentTurn: HTMLElement | undefined;
  /** 当前正在渲染的单元下标；渲染历史分页时由调用处固定。 */
  private unitCursor = 0;
  private pinnedUnit: number | undefined;
  /** 与渲染单元一一对应的可搜内容，下标顺序天然与 DOM 顺序一致。 */
  private readonly records: SearchableRecord[] = [];
  /** 时间线挂载时所在的单元，供后到的组和条目复用同一个锚点。 */
  private readonly timelineUnits = new Map<string, number>();
  /**
   * 粘底状态：用户滚离底部后为 false，任何新内容都不再强制拉底；
   * 用户滚回底部（或点「回到底部」）恢复粘底。由 scroll 监听维护。
   */
  private stickToBottom = true;
  private jumpButton: HTMLButtonElement | undefined;
  /** 用户离底期间累计的新消息条数，标在「↓ 最新消息」上。 */
  private unseenCount = 0;
  private thinking: ThinkingBlock | undefined;

  constructor(private readonly deps: ConversationDeps) {
    this.timeline = new TimelineView({
      // 挂载前先给助手气泡封口，时间线才会落在正文片段之后。
      mount: (node) => { this.sealStreaming(); this.appendNode(node); },
      onShowLog: () => this.deps.post({ type: "showLogs" }),
    });
    this.deps.el.messages.addEventListener("scroll", () => {
      this.stickToBottom = this.nearBottom();
      this.syncJumpButton();
    });
    this.mountJumpButton();
  }

  get lastPrompt(): string | undefined { return this.lastUserPrompt; }
  get hasPendingPermission(): boolean { return !!this.currentPermission; }
  get hasPendingQuestion(): boolean { return !!this.currentQuestion; }
  get usesTimeline(): boolean { return this.timelineActive; }

  // ---------------------------------------------------------------------------
  // 基础追加
  // ---------------------------------------------------------------------------

  nearBottom(): boolean {
    const { messages } = this.deps.el;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  }

  /**
   * 回到底部。`smooth` 只给用户主动点击用：流式出字时每帧平滑滚动会互相打架，
   * 反而看着一顿一顿的，所以自动跟随一律瞬时。
   */
  scrollToEnd(smooth = false): void {
    const { messages } = this.deps.el;
    if (smooth && !prefersReducedMotion() && typeof messages.scrollTo === "function") {
      messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
    } else {
      messages.scrollTop = messages.scrollHeight;
    }
    this.stickToBottom = true;
    this.unseenCount = 0;
    this.syncJumpButton();
  }

  /** 当前是否应把新内容拉到视野里；用户已滚离底部时绝不打断。 */
  get sticking(): boolean {
    return this.stickToBottom;
  }

  /** 新内容的落点：轮次容器 > 历史分页容器 > 会话流根节点。 */
  private mountPoint(): HTMLElement {
    return this.currentTurn ?? this.appendTarget ?? this.deps.el.messagesInner;
  }

  appendNode(node: HTMLElement): HTMLElement {
    this.deps.el.empty.hidden = true;
    const target = this.mountPoint();
    this.stamp(node);
    target.appendChild(node);
    // 统一的粘底规则：只有用户还贴着底部才自动拉底；
    // 离底时保持阅读位置，靠浮动「回到底部」按钮提示有新内容。
    if (!this.appendTarget) {
      if (this.stickToBottom) this.scrollToEnd();
      else {
        this.unseenCount += 1;
        this.syncJumpButton();
      }
    }
    return node;
  }

  /** 浮动「回到最新」：贴在滚动区底部，粘底时隐藏。 */
  private mountJumpButton(): void {
    const wrap = element("div", "jump-bottom-wrap");
    const button = element("button", "jump-bottom", "↓ 最新消息");
    button.type = "button";
    button.title = "回到最新消息";
    button.setAttribute("aria-label", "回到最新消息");
    button.addEventListener("click", () => this.scrollToEnd(true));
    wrap.appendChild(button);
    wrap.hidden = true;
    this.deps.el.messages.appendChild(wrap);
    this.jumpButton = button;
  }

  private syncJumpButton(): void {
    const wrap = this.jumpButton?.parentElement;
    if (wrap) wrap.hidden = this.stickToBottom;
    if (!this.jumpButton) return;
    if (this.stickToBottom) this.unseenCount = 0;
    // 带条数才知道值不值得跳回去：只说「有新消息」和说「有 7 条」是两回事。
    this.jumpButton.textContent = this.unseenCount > 0
      ? `↓ ${this.unseenCount} 条新消息`
      : "↓ 最新消息";
  }

  appendRow(className: string, text: string, actions?: readonly SetupActionButton[]): HTMLElement {
    // 同一条提示连着来第二遍就不再叠一张卡，改在原卡上记次数。
    // 实测同一句「操作未成功，详情见输出日志。」会连出两张，看着像界面坏了。
    const repeated = this.repeatLastNotice(className, text, actions);
    if (repeated) return repeated;

    const node = element("div", className);
    const body = element("div", "notice-text", text);
    // 原文留在 data 上：显示的文本可能被加上「（×N）」，比对时不能拿它当依据。
    body.dataset.noticeText = text;
    node.appendChild(body);
    if (actions && actions.length > 0) {
      const bar = element("div", "card-actions notice-actions");
      for (const action of actions) {
        const button = element(
          "button",
          action.id === "dismiss" ? "btn-secondary" : "btn-primary",
          action.label,
        );
        button.type = "button";
        button.addEventListener("click", () => {
          if (action.id !== "dismiss") {
            this.deps.post({ type: "setupAction", action: action.id });
          }
          disableActions(node);
          collapseCard(node, text);
        });
        bar.appendChild(button);
      }
      node.appendChild(bar);
    }
    this.appendNode(node);
    if (className.includes("notice")) this.record({ field: "notice", text });
    return node;
  }

  /**
   * 上一张卡就是同一条提示时，累加次数而不是再叠一张。
   *
   * 只认紧邻的上一个节点：中间隔了别的内容说明是两次不同的事，
   * 那时候合并会把时间顺序搞乱。带按钮的不合并——按钮是要点的。
   */
  private repeatLastNotice(
    className: string,
    text: string,
    actions?: readonly SetupActionButton[],
  ): HTMLElement | undefined {
    if (!className.includes("notice") || (actions && actions.length > 0)) return undefined;
    const last = this.deps.el.messagesInner.lastElementChild;
    if (!(last instanceof HTMLElement)) return undefined;
    if (last.className !== className) return undefined;
    if (last.querySelector(".card-actions")) return undefined;
    const body = last.querySelector<HTMLElement>(".notice-text");
    if (!body || body.dataset.noticeText !== text) return undefined;

    const count = Number(body.dataset.noticeCount ?? "1") + 1;
    body.dataset.noticeCount = String(count);
    body.textContent = `${text}（×${count}）`;
    return last;
  }

  /** 瞬时提示：几秒后淡出移除，不长期占会话流（如「已加载会话」）。 */
  appendEphemeralNotice(text: string, ttlMs = 2_500): HTMLElement {
    const node = element("div", "notice info notice-ephemeral");
    node.appendChild(element("div", "notice-text", text));
    this.appendNode(node);
    const remove = (): void => {
      node.classList.add("notice-ephemeral-out");
      window.setTimeout(() => node.remove(), 220);
    };
    window.setTimeout(remove, ttlMs);
    return node;
  }

  appendUserMessage(text: string): void {
    this.lastUserPrompt = text;
    this.startTurn();
    this.appendNode(createUserMessage(text, { onResend: (value) => this.resend(value) }));
    this.record({ field: "user", text });
  }

  /** 开一个新轮次：容器本身挂在会话流上，之后所有产物都落进它里面。 */
  private startTurn(): void {
    this.currentTurn = undefined;
    const turn = element("section", "turn");
    this.deps.el.empty.hidden = true;
    (this.appendTarget ?? this.deps.el.messagesInner).appendChild(turn);
    this.currentTurn = turn;
  }

  // ---------------------------------------------------------------------------
  // 单元下标与可搜记录
  // ---------------------------------------------------------------------------

  /** 给顶层节点打上单元下标，搜索据此在分页历史中定位。 */
  private stamp(node: HTMLElement): void {
    node.dataset.unit = String(this.currentUnit);
    if (this.pinnedUnit === undefined) this.unitCursor += 1;
  }

  private get currentUnit(): number {
    return this.pinnedUnit ?? this.unitCursor;
  }

  /** 记录一条可搜内容；unitIndex 取自刚刚渲染的单元。 */
  private record(draft: SearchableDraft, unitIndex = this.lastUnit()): void {
    // 历史单元的记录由 seedSearchable 在恢复时一次性写好，
    // 补渲染时不能再记一遍，否则同一条会被搜到两次。
    if (this.pinnedUnit !== undefined) return;
    this.records.push({ ...draft, unitIndex });
  }

  /**
   * 恢复会话时按单元写入可搜内容。
   *
   * 搜索必须能命中尚未渲染的更早分页，所以记录不能等到渲染时才产生。
   */
  seedSearchable(perUnit: readonly SearchableDraft[][]): void {
    perUnit.forEach((drafts, unitIndex) => {
      for (const draft of drafts) this.records.push({ ...draft, unitIndex });
    });
  }

  private lastUnit(): number {
    return this.pinnedUnit ?? Math.max(0, this.unitCursor - 1);
  }

  /** 搜索源快照。调用方只读，不改内部数组。 */
  searchableRecords(): readonly SearchableRecord[] {
    return this.records;
  }

  /**
   * 让某条记录进入已渲染区域并滚动到位。
   * 命中未加载的更早分页时按需补渲染，而不是一次性加载全部历史。
   */
  revealRecord(record: SearchableRecord, pageSize = RESTORE_PAGE_SIZE): HTMLElement | undefined {
    let guard = 0;
    while (this.pendingHistory.length > record.unitIndex && guard < 1_000) {
      this.loadEarlierHistory(pageSize);
      guard += 1;
    }
    const root = this.deps.el.messagesInner
      .querySelector<HTMLElement>(`[data-unit="${record.unitIndex}"]`);
    if (!root) return undefined;
    const target = record.anchor ? this.openTimelineGroup(root, record.anchor) ?? root : root;
    target.scrollIntoView?.({ block: "center" });
    return target;
  }

  /** 命中折叠的时间线分组时临时展开它。 */
  private openTimelineGroup(root: HTMLElement, anchor: TimelineAnchor): HTMLElement | undefined {
    const turn = root.matches(`.timeline[data-turn-id="${anchor.turnId}"]`)
      ? root
      : root.querySelector<HTMLElement>(`.timeline[data-turn-id="${anchor.turnId}"]`);
    if (!turn) return undefined;
    if (!anchor.groupId) return turn;
    const group = turn.querySelector<HTMLDetailsElement>(`details.tl-group[data-group-id="${anchor.groupId}"]`);
    if (!group) return turn;
    group.open = true;
    return group;
  }

  resend(text: string): void {
    if (!text.trim()) return;
    if (!this.deps.canSend()) {
      this.appendRow("notice info", "任务执行中，请先停止再重试。");
      return;
    }
    // 重试会产生新一轮，旧时间线保留并打标记，不删除历史。
    this.timeline.markPreviousRetried();
    this.deps.post({ type: "sendPrompt", text });
  }

  retryLast(): void {
    if (!this.lastUserPrompt) {
      this.appendRow("notice info", "没有可重试的消息。");
      return;
    }
    this.resend(this.lastUserPrompt);
  }

  noteStopRequested(stopped: boolean): void { this.stopRequested = stopped; }

  // ---------------------------------------------------------------------------
  // 助手正文
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 思考块
  // ---------------------------------------------------------------------------

  /**
   * 思考期间在会话流里立一个「思考中 Ns」的折叠块。
   *
   * 模型能连想几十秒，期间会话流一个像素都不动，用户分不清「在想」还是「卡死」。
   * 块里只列宿主已经脱敏过的阶段文案，私有思维过程不外泄。
   */
  showThinking(label: string): void {
    const text = label.trim() || "思考中";
    const block = this.resumeThinking();
    if (!block.seen.has(text)) {
      block.seen.add(text);
      block.steps.appendChild(element("div", "thinking-step", text));
    }
    block.indicator.show(text);
  }

  /**
   * 追加一段推理原文。
   *
   * 折叠块的标题仍是脱敏后的阶段文案，展开才是原文——对标 Cursor 的可展开推理链。
   * 原文只存在于这个 DOM 节点里：宿主不落盘，刷新面板即消失。
   */
  appendReasoning(text: string): void {
    if (!text) return;
    const block = this.resumeThinking();
    if (!block.reasoning.isConnected) {
      // 第一段原文到了才把容器挂上，免得没有原文的轮次留一个空的展开区。
      block.root.appendChild(block.reasoning);
    }
    const combined = block.reasoningText + text;
    block.reasoningText = combined.length > MAX_REASONING_CHARS
      ? combined.slice(combined.length - MAX_REASONING_CHARS)
      : combined;
    block.reasoning.textContent = block.reasoningText;
    // 展开着看的时候要跟着往下走；折叠时这里是 0，不做无用功。
    if (block.root.open) block.reasoning.scrollTop = block.reasoning.scrollHeight;
  }

  /**
   * 拿到这一轮的思考块，没有就建一个；已经停表的话重新计时。
   *
   * 一轮只留一个块。之前是「有就用、没有就新建」，而 finishThinking 会把引用清掉，
   * 于是模型每次在推理与正文之间来回切，就多出一张「思考完成」卡片——
   * 实测一句话被切成九张，正文也跟着碎成九段。
   */
  private resumeThinking(): ThinkingBlock {
    const existing = this.thinking;
    if (!existing) return this.createThinkingBlock();
    existing.root.classList.remove("done");
    return existing;
  }

  /**
   * 正文开始出字：停表但把块留着，也留着引用。
   * 后面推理再来时接着往同一个块里写，不再另起一张卡。
   */
  private pauseThinking(): void {
    const block = this.thinking;
    if (!block) return;
    block.elapsedSeconds += block.indicator.finish();
    block.root.classList.add("done");
    block.label.textContent = block.elapsedSeconds > 0
      ? `思考 ${block.elapsedSeconds}s`
      : "思考完成";
    block.elapsed.textContent = "";
  }

  /** 本轮结束：停表并交出这个块，下一轮会新建。 */
  finishThinking(): void {
    const block = this.thinking;
    if (!block) return;
    this.pauseThinking();
    this.thinking = undefined;
    // 一步都没记到、也没有原文的空块没有任何信息量，不如不留。
    if (block.seen.size === 0 && block.reasoningText === "") block.root.remove();
  }

  private createThinkingBlock(): ThinkingBlock {
    const root = element("details", "thinking-block") as HTMLDetailsElement;
    const summary = element("summary", "thinking-summary");
    const dot = element("span", "thinking-dot");
    dot.setAttribute("aria-hidden", "true");
    const label = element("span", "thinking-label", "思考中");
    const elapsed = element("span", "thinking-elapsed");
    summary.append(dot, label, elapsed);
    const steps = element("div", "thinking-steps");
    root.append(summary, steps);

    this.sealStreaming();
    this.appendNode(root);
    const block: ThinkingBlock = {
      root,
      label,
      elapsed,
      steps,
      seen: new Set<string>(),
      // root 已经在流里，指示器不该再去改它的 hidden。
      indicator: new ThinkingIndicator({ el: { root: element("div"), label, elapsed } }),
      reasoning: element("div", "thinking-reasoning"),
      reasoningText: "",
      elapsedSeconds: 0,
    };
    this.thinking = block;
    return block;
  }

  appendAssistantDelta(text: string): void {
    // 只停表，不撤块：正文与推理会交替到达，撤了下一段推理就会另起一张卡。
    this.pauseThinking();
    if (!this.streaming) {
      this.deps.el.empty.hidden = true;
      this.streaming = createStreamingAssistant(this.mountPoint(), {
        onOpenLink: (href) => this.deps.onOpenLink(href),
        onOpenFile: (ref) => this.deps.onOpenFile(ref),
        // 与 appendNode 用同一份粘底状态：用户滚离底部后流式输出也不拉底。
        nearBottom: () => this.sticking,
        scrollToEnd: () => this.scrollToEnd(),
      });
      this.stamp(this.streaming.root);
      this.streamingUnit = this.lastUnit();
    }
    this.streaming.append(text);
  }

  /** 当前是否仍在流式输出助手正文（变更卡应等它结束后再挂，避免插进半截回复）。 */
  get isStreaming(): boolean {
    return this.streaming !== undefined;
  }

  /** 结束当前流式气泡，使后续工具 / 权限 / 新正文按时间顺序接在后面。 */
  sealStreaming(): void {
    if (!this.streaming) return;
    this.streaming.finalize();
    this.decorate(this.streaming.root);
    const text = this.streaming.root.dataset.rawMarkdown ?? this.streaming.root.textContent ?? "";
    if (text.trim()) {
      this.record({ field: "assistant", text }, this.streamingUnit ?? this.lastUnit());
    }
    this.streamingUnit = undefined;
    this.streaming = undefined;
  }

  finalizeAssistant(stopReason?: string, modelId?: string): void {
    if (stopReason && /cancel|abort|interrupt/i.test(stopReason)) this.stopRequested = true;
    this.finishThinking();
    this.sealStreaming();
    // 停止原因不再刷「已完成 · 模型名」类重复脚注。
    if (stopReason && stopReason !== "end_turn" && stopReason !== "stop") {
      const note = describeStopReason(stopReason);
      if (note && !isDisplayNoise(note)) this.appendRow("footnote", note);
    }
    void modelId;
  }

  collapsePlanDuplicates(): void {
    const nodes = this.deps.el.messagesInner.querySelectorAll<HTMLElement>(".assistant-msg");
    for (const node of Array.from(nodes)) {
      collapseDuplicatePlanMarkdown(node, () => this.deps.onViewPlan());
    }
  }

  private decorate(root: HTMLElement): void {
    collapseDuplicatePlanMarkdown(root, () => this.deps.onViewPlan());
    if (this.stopRequested) markStopped(root);
    attachMessageActions(root, {
      getText: () => root.dataset.rawMarkdown ?? root.textContent ?? "",
      onRetry: () => this.retryLast(),
    });
  }

  // ---------------------------------------------------------------------------
  // 通知与提示
  // ---------------------------------------------------------------------------

  /** 权限结论已在卡片上展示时，抑制紧随其后的重复通知。 */
  shouldSuppressNotice(message: string): boolean {
    if (!this.suppressPermissionNotice) return false;
    if (!/^(?:已允许|已拒绝|已根据本会话规则|安全策略)/.test(message.trim())) return false;
    this.suppressPermissionNotice = false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // 任务时间线
  // ---------------------------------------------------------------------------

  applyTimelineTurn(turn: TurnPresentationHeader): void {
    this.timelineActive = true;
    this.timeline.applyTurn(turn);
    this.noteTimelineUnit(turn.turnId);
  }

  applyTimelineGroup(turnId: string, group: ActivityGroupHeader): void {
    this.timelineActive = true;
    this.timeline.applyGroup(turnId, group);
    const unit = this.noteTimelineUnit(turnId);
    const anchor: TimelineAnchor = { turnId, groupId: group.id };
    this.record({ field: "timeline", text: group.title, anchor }, unit);
    if (group.subtitle) this.record({ field: "timeline", text: group.subtitle, anchor }, unit);
  }

  applyTimelineItem(turnId: string, groupId: string, item: ActivityItem): void {
    this.timelineActive = true;
    this.timeline.applyItem(turnId, groupId, item);
    if (!item.target) return;
    this.record(
      { field: "timeline", text: item.target, anchor: { turnId, groupId } },
      this.noteTimelineUnit(turnId),
    );
  }

  restoreTimeline(presentation: TurnPresentation): void {
    this.timelineActive = true;
    this.timeline.restore(presentation);
    const unit = this.noteTimelineUnit(presentation.turnId);
    for (const draft of extractSearchable({ type: "timelineRestore", presentation })) {
      this.record(draft, unit);
    }
  }

  /**
   * 时间线的组和条目会在挂载之后陆续到达，锚点必须回到挂载时那个单元，
   * 否则搜索会把命中定位到后来的消息上。
   */
  private noteTimelineUnit(turnId: string): number {
    const existing = this.timelineUnits.get(turnId);
    if (existing !== undefined) return existing;
    const unit = this.lastUnit();
    this.timelineUnits.set(turnId, unit);
    return unit;
  }

  // ---------------------------------------------------------------------------
  // 旧版工具摘要（仅 v1 会话恢复时使用）
  // ---------------------------------------------------------------------------

  paintToolGroup(groupId: string): void {
    if (this.timelineActive) return;
    const group = this.tools.list().find((item) => item.id === groupId);
    if (!group) return;
    let root = this.toolRoots.get(groupId);
    if (!root) {
      root = element("details", "tool-summary");
      root.open = false;
      this.toolRoots.set(groupId, root);
      this.appendNode(root);
    }
    root.replaceChildren();
    const summary = element("summary");
    summary.appendChild(element("span", "tool-title", group.title));
    summary.appendChild(element("span", `badge status-${group.status}`, this.tools.statusLabel(group.status)));
    summary.appendChild(element("span", "tool-stats", this.tools.summaryLines(group).join(" · ")));
    root.appendChild(summary);
    const details = element("div", "tool-details");
    for (const item of group.items) {
      details.appendChild(element("div", undefined, item.productDetail));
      details.appendChild(element("div", "activity", `内部：${item.rawLabel}`));
    }
    root.appendChild(details);
  }

  // ---------------------------------------------------------------------------
  // 权限卡片
  // ---------------------------------------------------------------------------

  /**
   * 权限卡。同一 requestId 重复下发时直接忽略，不追加第二张卡 —— 与提问卡同一道防护。
   *
   * 宿主会在两种情况下把同一张卡再推一次：面板重挂时补推，以及队列里别的请求结算时
   * 顺手重发队首。少了这道判断，会话流里就会并排出现两张一模一样的卡，
   * 而且先出现那张的按钮仍然可点 —— 结论只会收拢最后渲染的那一张。
   */
  renderPermission(card: PermissionCardView, waiting: number): void {
    if (this.currentPermission?.requestId === card.requestId) return;
    const verdict = RISK_VERDICT[card.risk] ?? { text: card.risk, tone: "caution" };
    const root = element("section", `card permission tone-${verdict.tone}`);
    const header = element("div", "card-header");
    header.appendChild(element("span", "card-title", "需要你的确认"));
    header.appendChild(element("span", `badge tone-${verdict.tone}`, verdict.text));
    root.appendChild(header);
    // 有命令块时标题里的命令原文是重复的 —— label 带着它是为了折叠行和通知，
    // 卡上只留操作类别，命令原文交给下面的代码块。
    const heading = card.command
      ? OPERATION_LABELS[card.operation] ?? card.title
      : card.title || OPERATION_LABELS[card.operation] || "批准操作";
    root.appendChild(element("div", "perm-action", heading));
    if (card.command) {
      root.appendChild(element("pre", "cmd-block", card.command));
    } else if (card.target) {
      root.appendChild(element("div", "perm-meta", `目标：${card.target}`));
    }
    if (card.cwd) root.appendChild(element("div", "perm-meta", `执行目录：${card.cwd}`));
    if (card.steps.length > 0) {
      root.appendChild(permissionSection("会做什么", permissionSteps(card.steps)));
    }
    if (card.notes.length > 0) {
      root.appendChild(permissionSection("要注意", permissionNotes(card.notes)));
    }
    // 模型的说法单独标注出处：上面那些是本地按命令原文算出来的，这一句是被审批方自己写的，
    // 两者混在一起会让人以为「灵动 Code 认为这样做是对的」。
    if (card.intent) {
      root.appendChild(element("div", "perm-intent", `模型说这么做是为了：${clipText(card.intent, MAX_INTENT)}`));
    }
    if (waiting > 0) root.appendChild(element("div", "activity", `队列中还有 ${waiting} 个请求`));

    const actions = element("div", "card-actions");
    const decide = (
      label: string,
      className: string,
      decision: "allow_once" | "allow_session" | "allow_always" | "reject",
    ): HTMLButtonElement => {
      const button = element("button", className, label);
      button.addEventListener("click", () => {
        this.deps.post({ type: "permissionDecision", requestId: card.requestId, decision });
        disableActions(root);
      });
      return button;
    };
    const once = decide("允许一次", "btn-primary", "allow_once");
    const session = decide("本次会话允许", "btn-ghost", "allow_session");
    session.disabled = !card.allowSession;
    if (!card.allowSession) session.title = "这类操作有风险，每次都要你亲自确认，不能批量放行";
    actions.append(once, session);
    // 只在真能记住时才给这个按钮：没有存储或风险过高时按钮存在本身就是个空承诺。
    if (card.allowAlways) {
      const always = decide("以后都允许", "btn-ghost", "allow_always");
      always.title = "记住这一类操作，之后不再询问；可在设置里清空";
      actions.appendChild(always);
    }
    actions.appendChild(decide("拒绝", "btn-danger", "reject"));
    root.appendChild(actions);
    this.sealStreaming();
    this.appendNode(root);
    this.currentPermission = {
      requestId: card.requestId,
      root,
      title: card.title || OPERATION_LABELS[card.operation] || "权限请求",
    };
  }

  resolvePermission(requestId: string, message: string): void {
    if (this.currentPermission?.requestId !== requestId) return;
    collapseCard(this.currentPermission.root, `${this.currentPermission.title} · ${message}`);
    this.currentPermission = undefined;
    this.suppressPermissionNotice = true;
  }

  // ---------------------------------------------------------------------------
  // 模型提问卡片（ask_user_question）
  // ---------------------------------------------------------------------------

  /**
   * 模型主动提问：单选题用 radio、多选题用 checkbox，每题都带「其他」自由文本。
   * 同一 requestId 重复下发（面板重挂时补推）就地替换，不追加第二张卡。
   */
  renderQuestion(card: AskQuestionCardView): void {
    if (this.currentQuestion?.requestId === card.requestId) return;
    const root = element("section", "card ask-question");
    const header = element("div", "card-header");
    header.appendChild(element("span", "card-title", "需要你的回答"));
    header.appendChild(element("span", "badge", card.questions.length > 1 ? `${card.questions.length} 个问题` : "提问"));
    root.appendChild(header);

    const blocks = card.questions.map((item, index) => this.buildQuestionBlock(card.requestId, item, index));
    for (const block of blocks) root.appendChild(block.root);

    const actions = element("div", "card-actions");
    const submit = element("button", "btn-primary", "提交回答");
    submit.disabled = true;
    const refresh = (): void => {
      submit.disabled = blocks.some((block) => block.answer() === undefined);
    };
    root.addEventListener("change", refresh);
    root.addEventListener("input", refresh);
    submit.addEventListener("click", () => {
      const answers = blocks.map((block) => block.answer() ?? "");
      this.deps.post({ type: "answerQuestion", requestId: card.requestId, answers });
      lockQuestionCard(root);
    });
    actions.appendChild(submit);
    root.appendChild(actions);
    root.appendChild(element("div", "hint", "任务会等你作答后继续；也可以点停止取消整轮。"));

    this.sealStreaming();
    this.appendNode(root);
    this.currentQuestion = { requestId: card.requestId, root };
    for (const item of card.questions) this.record({ field: "notice", text: item.question });
  }

  /** 单个问题块。answer() 未作答时返回 undefined，作答后返回合成文本。 */
  private buildQuestionBlock(
    requestId: string,
    item: AskQuestionItemView,
    index: number,
  ): { root: HTMLElement; answer(): string | undefined } {
    const root = element("div", "ask-q");
    root.appendChild(element("div", "ask-q-title", item.question));
    const name = `q-${requestId}-${index}`;
    const type = item.multiSelect ? "checkbox" : "radio";

    const inputs: HTMLInputElement[] = [];
    for (const option of item.options) {
      const row = element("label", "ask-q-option");
      const input = element("input");
      input.type = type;
      input.name = name;
      input.value = option.label;
      inputs.push(input);
      row.appendChild(input);
      const text = element("span", "ask-q-option-text");
      text.appendChild(element("span", "ask-q-option-label", option.label));
      if (option.preview) text.appendChild(element("span", "ask-q-option-preview", option.preview));
      row.appendChild(text);
      root.appendChild(row);
    }

    // 「其他」自由文本：单选时与选项互斥，多选时可与选项叠加。
    const otherRow = element("label", "ask-q-option ask-q-other");
    const otherToggle = element("input");
    otherToggle.type = type;
    otherToggle.name = name;
    otherToggle.value = "";
    otherRow.appendChild(otherToggle);
    otherRow.appendChild(element("span", "ask-q-option-label", "其他"));
    const otherInput = element("input", "ask-q-other-input");
    otherInput.type = "text";
    otherInput.placeholder = "输入你的回答…";
    otherInput.maxLength = 2_000;
    otherInput.addEventListener("focus", () => { otherToggle.checked = true; });
    otherRow.appendChild(otherInput);
    root.appendChild(otherRow);

    const answer = (): string | undefined => {
      const picked = inputs.filter((input) => input.checked).map((input) => input.value);
      const other = otherToggle.checked ? otherInput.value.trim() : "";
      if (item.multiSelect) {
        const parts = [...picked, ...(other ? [other] : [])];
        return parts.length > 0 ? parts.join("、") : undefined;
      }
      if (otherToggle.checked) return other || undefined;
      return picked[0];
    };
    return { root, answer };
  }

  resolveQuestion(requestId: string, message: string, answers?: string[]): void {
    if (this.currentQuestion?.requestId !== requestId) return;
    const detail = answers?.filter((item) => item.trim().length > 0).join("；");
    collapseCard(this.currentQuestion.root, detail ? `${message}：${detail}` : message);
    this.currentQuestion = undefined;
  }

  // ---------------------------------------------------------------------------
  // 其他卡片
  // ---------------------------------------------------------------------------

  renderAskIntent(reason: string, keyword: string | undefined, modeLabels: Record<string, string>): void {
    const card = element("section", "card");
    card.appendChild(element("div", "card-title", "Ask 模式不会修改任何文件"));
    card.appendChild(element("div", "perm-reason", `${reason}${keyword ? `（命中：${keyword}）` : ""}`));
    const actions = element("div", "card-actions");
    for (const next of ["plan", "agent", "auto"] as const) {
      const label = `切换到 ${modeLabels[next] ?? next}`;
      const button = element("button", "btn-ghost", label);
      button.addEventListener("click", () => {
        this.deps.post({ type: "setMode", mode: next });
        this.deps.post({ type: "askIntentOverride" });
        collapseCard(card, `已${label}`);
      });
      actions.appendChild(button);
    }
    const keep = element("button", "btn-primary", "仍然只做分析");
    keep.addEventListener("click", () => {
      this.deps.post({ type: "askIntentOverride" });
      collapseCard(card, "已选择：仍然只做分析");
    });
    actions.appendChild(keep);
    card.appendChild(actions);
    this.appendNode(card);
  }

  renderDebugConfirm(): void {
    const card = element("section", "card");
    card.appendChild(element("div", "card-title", "确认后进入修复"));
    card.appendChild(element("div", "perm-reason", "Debug 初始阶段只读。确认方案后将切换到 Agent 修改。"));
    const confirm = element("button", "btn-primary", "确认并开始修复");
    confirm.addEventListener("click", () => {
      this.deps.post({ type: "confirmDebugFix" });
      collapseCard(card, "已确认，开始修复");
    });
    card.appendChild(confirm);
    this.appendNode(card);
  }

  mountAssistant(rawMarkdown: string): HTMLElement {
    this.deps.el.empty.hidden = true;
    const target = this.mountPoint();
    const node = mountAssistantMessage(
      target,
      rawMarkdown,
      (href) => this.deps.onOpenLink(href),
      (ref) => this.deps.onOpenFile(ref),
    );
    this.stamp(node);
    this.record({ field: "assistant", text: rawMarkdown });
    attachMessageActions(node, {
      getText: () => node.dataset.rawMarkdown ?? "",
      onRetry: () => this.retryLast(),
    });
    return node;
  }

  // ---------------------------------------------------------------------------
  // 清空与分页恢复
  // ---------------------------------------------------------------------------

  clear(): void {
    this.thinking?.indicator.finish();
    this.thinking = undefined;
    this.streaming?.dispose();
    this.deps.el.messagesInner.replaceChildren(this.deps.el.empty);
    this.deps.el.empty.hidden = false;
    this.streaming = undefined;
    this.suppressPermissionNotice = false;
    this.lastUserPrompt = undefined;
    this.stopRequested = false;
    this.currentPermission = undefined;
    this.currentQuestion = undefined;
    this.pendingHistory = [];
    this.historyButton = undefined;
    this.appendTarget = undefined;
    this.currentTurn = undefined;
    this.unitCursor = 0;
    this.pinnedUnit = undefined;
    this.streamingUnit = undefined;
    this.records.length = 0;
    this.timelineUnits.clear();
    this.tools.reset();
    this.toolRoots.clear();
    this.timeline.clear();
    this.timelineActive = false;
    this.stickToBottom = true;
    this.unseenCount = 0;
    this.syncJumpButton();
  }

  /**
   * 只渲染最新的 pageSize 条，更早的留在 pendingHistory 里按需补渲染。
   * 返回实际立即渲染的条目数，便于测试断言。
   */
  renderHistory(units: RenderUnit[], pageSize = RESTORE_PAGE_SIZE): number {
    const head = Math.max(0, units.length - pageSize);
    this.pendingHistory = units.slice(0, head);
    this.refreshHistoryButton();
    const tail = units.slice(head);
    this.runUnits(tail, head);
    // 后续实时消息接在全部历史单元之后，下标保持单调递增。
    this.unitCursor = units.length;
    this.scrollToEnd();
    return tail.length;
  }

  /** 补渲染上一页历史，插到「加载更早消息」按钮之后，保持时间顺序。 */
  loadEarlierHistory(pageSize = RESTORE_PAGE_SIZE): void {
    if (this.pendingHistory.length === 0) return;
    // 在顶部插入内容会把当前视口整段推下去，读到一半的位置就丢了。
    // 记下插入前的滚动高度，插完按增量补偿回去。
    const { messages } = this.deps.el;
    const heightBefore = messages.scrollHeight;
    const topBefore = messages.scrollTop;
    const head = Math.max(0, this.pendingHistory.length - pageSize);
    const page = this.pendingHistory.slice(head);
    this.pendingHistory = this.pendingHistory.slice(0, head);

    const container = element("div", "history-page");
    this.appendTarget = container;
    try {
      this.runUnits(page, head);
    } finally {
      this.appendTarget = undefined;
    }
    const anchor = this.historyButton ?? this.deps.el.messagesInner.firstElementChild;
    if (anchor?.parentElement === this.deps.el.messagesInner) {
      anchor.after(container);
    } else {
      this.deps.el.messagesInner.prepend(container);
    }
    this.refreshHistoryButton();
    const grew = messages.scrollHeight - heightBefore;
    if (grew > 0) messages.scrollTop = topBefore + grew;
  }

  /** 渲染一批历史单元，并把每个单元的下标钉住，保证搜索定位与分页一致。 */
  private runUnits(units: readonly RenderUnit[], firstIndex: number): void {
    const previous = this.pinnedUnit;
    const previousTurn = this.currentTurn;
    // 补渲染的历史自成一批轮次，不能续到实时那一轮里去。
    this.currentTurn = undefined;
    try {
      units.forEach((unit, offset) => {
        this.pinnedUnit = firstIndex + offset;
        unit();
      });
    } finally {
      this.pinnedUnit = previous;
      this.currentTurn = previousTurn;
    }
  }

  private refreshHistoryButton(): void {
    const remaining = this.pendingHistory.length;
    if (remaining === 0) {
      this.historyButton?.remove();
      this.historyButton = undefined;
      return;
    }
    if (!this.historyButton) {
      const button = element("button", "history-more");
      button.type = "button";
      button.addEventListener("click", () => this.loadEarlierHistory());
      this.deps.el.messagesInner.prepend(button);
      this.historyButton = button;
    }
    this.historyButton.textContent = `加载更早消息（还有 ${remaining} 条）`;
  }
}
