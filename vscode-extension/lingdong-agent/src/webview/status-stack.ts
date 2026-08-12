/**
 * Composer 上方只留一条状态。
 *
 * turn-status / queue-chips / task-progress 由三个互不知情的模块各自控制显隐，
 * 忙起来时会一起冒出来，把输入框往下顶掉三行。这里统一收口成互斥单条：
 * turn-status > queue-chips > task-progress，谁先命中谁显示，其余隐藏。
 */

export type StatusSlot = "turn" | "queue" | "task";

const PRIORITY: readonly StatusSlot[] = ["turn", "queue", "task"];

export class StatusStack {
  private readonly nodes = new Map<StatusSlot, HTMLElement>();
  private readonly wants = new Map<StatusSlot, boolean>();

  /** 元素只有在宿主真的渲染了它时才登记，单测里的精简 DOM 不受影响。 */
  register(slot: StatusSlot, node: HTMLElement | undefined): void {
    if (!node) return;
    this.nodes.set(slot, node);
  }

  want(slot: StatusSlot, visible: boolean): void {
    this.wants.set(slot, visible);
    this.apply();
  }

  /** 当前实际显示的那一条，便于断言与调试。 */
  get visible(): StatusSlot | undefined {
    return PRIORITY.find((slot) => this.wants.get(slot) === true && this.nodes.has(slot));
  }

  private apply(): void {
    const winner = this.visible;
    for (const slot of PRIORITY) {
      const node = this.nodes.get(slot);
      if (node) node.hidden = slot !== winner;
    }
  }
}

export const statusStack = new StatusStack();
