/**
 * 一轮 Agent 任务的主状态。
 *
 * Composer、Status Bar、Controller 都只读这里，禁止各自猜 busy/thinking。
 * Timeline item 的成功/失败仍是局部标记，不替代本机。
 *
 * 与 presentation/turn-presentation 里的 Timeline 终态（running/completed/…）是两件事：
 * 那边描述时间线卡片收尾，这边描述整轮任务给用户看的主状态。
 */

export type TurnMainStatus =
  | "idle"
  | "preparing"
  | "thinking"
  | "working"
  | "waiting_for_user"
  /**
   * 阻塞式派发的子 Agent 正在干活，父 Agent 挡在这里。
   * 和 waiting_for_user 不是一回事：那是人没回，计时该停；这是活儿正在被干，计时必须继续走。
   */
  | "waiting_for_subagent"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

/** 文档里的合法转换；其余一律非法。idle 仅作「没有进行中的轮次」。 */
const TRANSITIONS: Record<TurnMainStatus, readonly TurnMainStatus[]> = {
  idle: ["preparing"],
  // preparing 也可直接进 working：Grok 常在第一条 thought 之前就流式吐工具参数。
  preparing: ["thinking", "working", "waiting_for_subagent", "interrupted", "failed", "stopping"],
  thinking: ["working", "waiting_for_user", "waiting_for_subagent", "completed", "failed", "interrupted", "stopping"],
  // working → thinking 保留给「工具间隙又开始推理」的场景；状态栏文案由 noteModelEvent 决定是否真切。
  working: ["thinking", "waiting_for_user", "waiting_for_subagent", "completed", "failed", "interrupted", "stopping"],
  waiting_for_user: ["thinking", "working", "waiting_for_subagent", "stopping"],
  // 子 Agent 交回结果后父 Agent 继续跑；中途也可能直接失败或被停。
  waiting_for_subagent: [
    "thinking", "working", "waiting_for_user", "completed", "failed", "interrupted", "stopping",
  ],
  stopping: ["stopped", "interrupted"],
  completed: [],
  failed: [],
  stopped: [],
  interrupted: [],
};

const TERMINAL: ReadonlySet<TurnMainStatus> = new Set([
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);

/** 仍占用「一轮任务」的状态：发送应入队，停止按钮按文档在 waiting 时也可用。 */
const ACTIVE: ReadonlySet<TurnMainStatus> = new Set([
  "preparing",
  "thinking",
  "working",
  "waiting_for_user",
  "waiting_for_subagent",
  "stopping",
]);

/**
 * 状态栏默认文案。
 *
 * 三条约定，改文案时请一并遵守：
 * 1. 进行中的状态以「…」（单个省略号字符）收尾，终态不带。
 * 2. 终态都是「已 X」或「X 失败」的完整短语，不用「失败」这种光秃秃的名词——
 *    状态栏只有一行，用户读到的就是这一句。
 * 3. waiting_for_user 的默认值是兜底；三种等待（授权 / 批计划 / 回答提问）
 *    由调用方用 WAITING_LABEL 覆盖，因为要用户做的事完全不同。
 */
export const TURN_STATUS_LABEL: Record<TurnMainStatus, string> = {
  idle: "",
  preparing: "正在连接 Agent…",
  thinking: "正在思考…",
  working: "正在执行…",
  waiting_for_user: "等待你的确认",
  waiting_for_subagent: "等待子 Agent…",
  stopping: "正在停止…",
  completed: "已完成",
  failed: "执行失败",
  stopped: "已停止",
  interrupted: "连接已中断",
};

/** 等待用户时的具体文案。默认那句「等待你的确认」说不清到底要做什么。 */
export const WAITING_LABEL = {
  permission: "等待你授权这次操作",
  plan: "等待你审阅计划",
  question: "等待你回答",
} as const;

export interface TurnStatusSnapshot {
  status: TurnMainStatus;
  /** 展示用文案；working 时可被 Timeline group 覆盖。 */
  label: string;
  /** 累计活动毫秒（waiting 期间不计）。 */
  activeElapsedMs: number;
  /** 是否显示秒数（waiting / 终态文案类不显示「处理中 xx 秒」）。 */
  showElapsed: boolean;
  /** 状态栏是否可见。 */
  visible: boolean;
  canStop: boolean;
  /** 终态之后丢弃后续 delta / 普通 timeline。 */
  discardStream: boolean;
  /** 连接类中断：状态栏给重连入口。 */
  connectionActions: boolean;
}

export interface TurnStatusMachineOptions {
  /**
   * 非法转换时的处理。默认：开发态（NODE_ENV=development）抛错，
   * 生产记日志并忽略。测试可注入。
   */
  onIllegal?(from: TurnMainStatus, to: TurnMainStatus): void;
  now?(): number;
  isDev?: boolean;
  log?(line: string): void;
}

function defaultIllegal(
  from: TurnMainStatus,
  to: TurnMainStatus,
  options: TurnStatusMachineOptions,
): void {
  const message = `[turn-status] 非法转换 ${from} → ${to}`;
  const isDev = options.isDev
    ?? (typeof process !== "undefined" && process.env.NODE_ENV === "development");
  if (isDev) throw new Error(message);
  options.log?.(message);
}

export class TurnStatusMachine {
  private status: TurnMainStatus = "idle";
  private labelOverride: string | undefined;
  private activeElapsedMs = 0;
  private segmentStartedAt: number | undefined;
  private waiting = false;

  private readonly now: () => number;
  private readonly onIllegal: (from: TurnMainStatus, to: TurnMainStatus) => void;

  constructor(private readonly options: TurnStatusMachineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onIllegal = options.onIllegal
      ?? ((from, to) => defaultIllegal(from, to, options));
  }

  get current(): TurnMainStatus {
    return this.status;
  }

  get isTerminal(): boolean {
    return TERMINAL.has(this.status);
  }

  get isActive(): boolean {
    return ACTIVE.has(this.status);
  }

  /** 进入 stopped/completed/failed/interrupted 后为 true。 */
  get discardStream(): boolean {
    return this.status === "stopped"
      || this.status === "completed"
      || this.status === "failed"
      || this.status === "interrupted";
  }

  canTransition(next: TurnMainStatus): boolean {
    if (this.status === next) return true;
    return TRANSITIONS[this.status].includes(next);
  }

  /**
   * 尝试转换。非法则走 onIllegal 并返回 false，不改状态。
   * 同态重复调用视为成功（用于幂等推 working）。
   */
  transition(next: TurnMainStatus, label?: string): boolean {
    if (this.status === next) {
      if (label !== undefined) this.labelOverride = label;
      return true;
    }
    if (!TRANSITIONS[this.status].includes(next)) {
      this.onIllegal(this.status, next);
      return false;
    }
    this.apply(next, label);
    return true;
  }

  /** 新一轮开始：从任意态重置到 preparing（含上轮终态）。 */
  beginTurn(label = TURN_STATUS_LABEL.preparing): void {
    this.flushSegment();
    this.status = "preparing";
    this.labelOverride = label;
    this.activeElapsedMs = 0;
    this.waiting = false;
    this.segmentStartedAt = this.now();
  }

  /** 会话切换 / 清空：回到 idle，不计时。 */
  reset(): void {
    this.status = "idle";
    this.labelOverride = undefined;
    this.activeElapsedMs = 0;
    this.waiting = false;
    this.segmentStartedAt = undefined;
  }

  /**
   * working 时用 Timeline / 具体文件文案覆盖默认「正在执行…」。
   * @returns 文案是否真的变了（参数流里同路径会刷上万次，调用方据此决定要不要推 UI）。
   */
  setWorkingLabel(label: string): boolean {
    if (this.status !== "working") return false;
    if (this.labelOverride === label) return false;
    this.labelOverride = label;
    return true;
  }

  snapshot(): TurnStatusSnapshot {
    const activeElapsedMs = this.currentActiveElapsed();
    const status = this.status;
    const label = this.labelOverride?.trim() || TURN_STATUS_LABEL[status];
    const showElapsed = status === "preparing"
      || status === "thinking"
      || status === "working"
      || status === "waiting_for_subagent"
      || status === "stopping";
    return {
      status,
      label,
      activeElapsedMs,
      showElapsed,
      visible: status !== "idle",
      canStop: status === "preparing"
        || status === "thinking"
        || status === "working"
        || status === "waiting_for_user"
        || status === "waiting_for_subagent",
      discardStream: this.discardStream,
      connectionActions: status === "interrupted",
    };
  }

  private apply(next: TurnMainStatus, label?: string): void {
    // waiting 进出时暂停/恢复累计。
    if (this.status === "waiting_for_user" && next !== "waiting_for_user") {
      this.waiting = false;
      this.segmentStartedAt = this.now();
    } else if (next === "waiting_for_user") {
      this.flushSegment();
      this.waiting = true;
      this.segmentStartedAt = undefined;
    } else if (TERMINAL.has(next)) {
      this.flushSegment();
      this.segmentStartedAt = undefined;
      this.waiting = false;
    } else if (!this.waiting && this.segmentStartedAt === undefined) {
      this.segmentStartedAt = this.now();
    }

    this.status = next;
    this.labelOverride = label ?? TURN_STATUS_LABEL[next];
  }

  private flushSegment(): void {
    if (this.segmentStartedAt === undefined || this.waiting) return;
    this.activeElapsedMs += Math.max(0, this.now() - this.segmentStartedAt);
    this.segmentStartedAt = undefined;
  }

  private currentActiveElapsed(): number {
    if (this.waiting || this.segmentStartedAt === undefined) return this.activeElapsedMs;
    return this.activeElapsedMs + Math.max(0, this.now() - this.segmentStartedAt);
  }
}

/** preparing 阶段失败分流：连接类 → interrupted，请求类 → failed。 */
export function classifyPreparingFailure(message: string): "interrupted" | "failed" {
  const text = message.toLowerCase();
  // Provider / 模型 / 凭据类：只进聊天区错误卡。
  if (
    /401|403|404|429|invalid.?api|api.?key|unauthorized|model.?not|余额|quota|billing|4\d\d|原来使用|凭据|provider|服务商|未配置|重新配置|deepseek|选择模型/.test(text)
  ) {
    return "failed";
  }
  if (
    /econn|enotfound|etimedout|socket|handshake|acp|grok|process|spawn|executable|断网|连接|timeout|econnreset|econnrefused/.test(text)
  ) {
    return "interrupted";
  }
  // 默认按连接类：preparing 阶段多数是拉起/握手失败。
  return "interrupted";
}
