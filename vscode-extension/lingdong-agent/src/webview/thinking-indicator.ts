/**
 * 思考期间的计时反馈。
 *
 * 实测 DeepSeek 一轮能连想 37 秒，期间 Grok 一直在吐 agent_thought_chunk，
 * 但界面上一个像素都不变——用户没法区分「在想」和「卡死了」。
 *
 * 这里只显示状态文案与秒数，**不显示思考内容**：宿主那边 thought_delta 早就
 * 被映射成了几条固定文案（见 event-presenter 的说明），私有思维过程不外泄这条
 * 约束不因为这个指示器而松动。
 *
 * 秒数由本地定时器驱动，不额外往宿主要消息：一轮几千个思考分片，
 * 每个都推一条过来只会把刚修好的出字节奏又拖垮。
 */

export interface ThinkingElements {
  root: HTMLElement;
  label: HTMLElement;
  elapsed: HTMLElement;
}

export interface ThinkingDeps {
  el: ThinkingElements;
  now?: () => number;
  /** 可注入是为了测试里不用真的等一秒。 */
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const TICK_MS = 1000;

export class ThinkingIndicator {
  private startedAt: number | undefined;
  private handle: unknown;
  private labelText = "";

  private readonly now: () => number;
  private readonly start: (handler: () => void, ms: number) => unknown;
  private readonly stop: (handle: unknown) => void;

  constructor(private readonly deps: ThinkingDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.start = deps.setInterval ?? ((handler, ms) => setInterval(handler, ms));
    this.stop = deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get visible(): boolean {
    return this.startedAt !== undefined;
  }

  /**
   * 收到一条活动文案。换文案只换标题，**不重置秒数**：
   * 用户关心的是「这一轮我一共等了多久」，阶段切换时清零反而看不出总时长。
   * 秒数只在指示器从隐藏变为显示时归零。
   */
  show(label: string): void {
    const text = label.trim() === "" ? "思考中" : label.trim();
    if (this.startedAt !== undefined && text === this.labelText) return;

    this.labelText = text;
    this.startedAt ??= this.now();
    this.deps.el.label.textContent = text;
    this.deps.el.root.hidden = false;
    this.paint();

    if (this.handle === undefined) {
      this.handle = this.start(() => this.paint(), TICK_MS);
    }
  }

  /** 正文开始出字、或这一轮结束，指示器就该让位。 */
  hide(): void {
    this.deps.el.root.hidden = true;
    this.deps.el.elapsed.textContent = "";
    this.finish();
  }

  /**
   * 停表但留在原地。会话流里的「思考 Ns」折叠块要保留这段耗时，
   * 用户回头翻记录时才知道那段空白是在想事情。返回总秒数。
   */
  finish(): number {
    const seconds = this.startedAt === undefined
      ? 0
      : Math.floor((this.now() - this.startedAt) / 1000);
    this.startedAt = undefined;
    this.labelText = "";
    if (this.handle !== undefined) {
      this.stop(this.handle);
      this.handle = undefined;
    }
    return seconds;
  }

  private paint(): void {
    if (this.startedAt === undefined) return;
    const seconds = Math.floor((this.now() - this.startedAt) / 1000);
    // 头一秒不显示数字，避免刚发出去就闪一个「0s」。
    this.deps.el.elapsed.textContent = seconds > 0 ? `${seconds}s` : "";
  }
}
