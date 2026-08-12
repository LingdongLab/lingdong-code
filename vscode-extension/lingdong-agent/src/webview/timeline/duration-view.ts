import { describeElapsed } from "../../presentation/turn-presentation";

/**
 * 时间线计时。
 *
 * 全局只有一个 1 秒 interval，所有运行中的节点共用；
 * 没有运行中的节点就停表，已完成的历史时间线永远不订阅。
 * 回调只改文本节点，不重建 DOM。
 */

export type Unsubscribe = () => void;

export class DurationClock {
  private readonly ticks = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly intervalMs = 1_000) {}

  get running(): boolean { return this.timer !== undefined; }
  get subscriberCount(): number { return this.ticks.size; }

  subscribe(tick: () => void): Unsubscribe {
    this.ticks.add(tick);
    this.start();
    return () => {
      this.ticks.delete(tick);
      if (this.ticks.size === 0) this.stop();
    };
  }

  /** 供测试直接推进一格，避免依赖真实定时器。 */
  tick(): void {
    for (const run of [...this.ticks]) run();
  }

  dispose(): void {
    this.ticks.clear();
    this.stop();
  }

  private start(): void {
    if (this.timer !== undefined) return;
    const handle = setInterval(() => this.tick(), this.intervalMs);
    // Node 环境下别让定时器拖住进程；浏览器里没有 unref。
    (handle as unknown as { unref?: () => void }).unref?.();
    this.timer = handle;
  }

  private stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export interface ElapsedInput {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  running: boolean;
}

/** 只写文本，绝不替换节点，避免每秒重排。 */
export function paintDuration(node: HTMLElement, input: ElapsedInput, now = Date.now()): void {
  const elapsed = input.durationMs
    ?? (input.completedAt !== undefined
      ? input.completedAt - input.startedAt
      : now - input.startedAt);
  // 终态却算出 0 秒：多半是缺 completedAt 或起止被写成同一时刻，宁可不写也不展示假「耗时 0 秒」。
  if (!input.running && elapsed < 500) {
    node.textContent = "";
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const text = describeElapsed({ ...input, now });
  if (node.textContent !== text) node.textContent = text;
}
