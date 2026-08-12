/**
 * Composer 上方唯一的 Turn Status Bar。
 * 只渲染宿主推来的 turnStatus，不根据 busy/activity 自行猜测。
 */

import { statusStack } from "./status-stack";

export interface TurnStatusBarElements {
  root: HTMLElement;
  label: HTMLElement;
  elapsed: HTMLElement;
  summary: HTMLElement;
  actions: HTMLElement;
}

export interface TurnStatusPayload {
  status: string;
  label: string;
  activeElapsedMs: number;
  showElapsed: boolean;
  visible: boolean;
  canStop: boolean;
  connectionActions: boolean;
  /** 距上一次有新输出过去了多久；缺省表示不适用。 */
  silentMs?: number;
  summary?: { filesChanged?: number; testsPassed?: number };
}

export interface TurnStatusBarDeps {
  el: TurnStatusBarElements;
  onReconnect(): void;
  onRetry(): void;
  onViewChanges(): void;
  now?: () => number;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * 多久不出新内容才值得提一句。
 *
 * 太小会一直闪：首个 token 之前静上十几秒是常态，尤其是推理型模型。
 * 30 秒往上就属于「用户已经开始犯嘀咕」的区间了。
 */
const SILENCE_HINT_MS = 30_000;

/** 只有这几个状态里「没有新输出」才说明问题；等人和收尾阶段静默都是正常的。 */
const SILENCE_STATUSES = new Set(["preparing", "thinking", "working"]);

/** 静默提示文案；不到阈值返回 undefined 表示这一行不显示。 */
export function describeSilence(message: TurnStatusPayload): string | undefined {
  if (!SILENCE_STATUSES.has(message.status)) return undefined;
  const silent = message.silentMs;
  if (silent === undefined || silent < SILENCE_HINT_MS) return undefined;
  const seconds = Math.floor(silent / 1000);
  if (seconds < 60) return `已 ${seconds} 秒没有新输出`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? `已 ${minutes} 分钟没有新输出`
    : `已 ${minutes} 分 ${rest} 秒没有新输出`;
}

export class TurnStatusBar {
  private baseElapsed = 0;
  private tickStartedAt: number | undefined;
  private handle: unknown;
  private showElapsed = false;
  private lastStatus = "idle";

  private readonly now: () => number;
  private readonly start: (handler: () => void, ms: number) => unknown;
  private readonly stop: (handle: unknown) => void;

  constructor(private readonly deps: TurnStatusBarDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.start = deps.setInterval ?? ((handler, ms) => setInterval(handler, ms));
    this.stop = deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  apply(message: TurnStatusPayload): void {
    this.lastStatus = message.status;
    const { el } = this.deps;
    if (!message.visible || message.status === "idle") {
      this.hide();
      return;
    }

    // 普通完成：会话流变更卡已说明改动，状态栏不再挂「已完成 / 查看文件」造成错位感。
    // 仅在有测试通过摘要时短暂保留一行结果。
    if (
      message.status === "completed"
      && message.summary?.testsPassed === undefined
    ) {
      this.hide();
      return;
    }

    statusStack.register("turn", el.root);
    statusStack.want("turn", true);
    el.root.dataset.status = message.status;
    el.label.textContent = message.label || "";

    this.showElapsed = message.showElapsed;
    this.baseElapsed = message.activeElapsedMs;
    if (message.showElapsed) {
      this.tickStartedAt = this.now();
      this.ensureTick();
      this.paintElapsed();
    } else {
      this.clearTick();
      el.elapsed.textContent = "";
    }

    this.paintSummary(message);
    this.paintActions(message);
  }

  hide(): void {
    this.clearTick();
    statusStack.register("turn", this.deps.el.root);
    statusStack.want("turn", false);
    this.deps.el.label.textContent = "";
    this.deps.el.elapsed.textContent = "";
    this.deps.el.summary.replaceChildren();
    this.deps.el.actions.replaceChildren();
    delete this.deps.el.root.dataset.status;
  }

  get status(): string {
    return this.lastStatus;
  }

  private paintSummary(message: TurnStatusPayload): void {
    const { summary } = this.deps.el;
    summary.replaceChildren();

    // 跑着的时候，这一行回答的是「它还在动吗」。总耗时看不出这一点：
    // 模型在认真想和模型已经不动了，秒数涨得一模一样。
    const silence = describeSilence(message);
    if (silence !== undefined) {
      const row = document.createElement("div");
      row.className = "turn-status-summary-line";
      row.textContent = silence;
      summary.appendChild(row);
      return;
    }

    if (message.status !== "completed" || !message.summary) return;

    // 文件改动由会话流里的变更卡承接，这里不再重复「修改 N 个文件 / 查看文件」。
    const lines: string[] = [];
    if (message.summary.testsPassed !== undefined) {
      lines.push(`${message.summary.testsPassed} 项测试通过`);
    }
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "turn-status-summary-line";
      row.textContent = line;
      summary.appendChild(row);
    }
  }

  private paintActions(message: TurnStatusPayload): void {
    const { actions } = this.deps.el;
    actions.replaceChildren();

    if (message.connectionActions) {
      actions.appendChild(this.actionButton("重新连接", () => this.deps.onReconnect()));
      actions.appendChild(this.actionButton("重试本轮", () => this.deps.onRetry()));
    }
  }

  private actionButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "turn-status-action";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private ensureTick(): void {
    if (this.handle !== undefined) return;
    this.handle = this.start(() => this.paintElapsed(), 1000);
  }

  private clearTick(): void {
    this.tickStartedAt = undefined;
    this.showElapsed = false;
    if (this.handle !== undefined) {
      this.stop(this.handle);
      this.handle = undefined;
    }
  }

  private paintElapsed(): void {
    if (!this.showElapsed || this.tickStartedAt === undefined) {
      this.deps.el.elapsed.textContent = "";
      return;
    }
    const ms = this.baseElapsed + Math.max(0, this.now() - this.tickStartedAt);
    const seconds = Math.floor(ms / 1000);
    this.deps.el.elapsed.textContent = seconds > 0 ? `${seconds}s` : "";
  }
}
