import type { ActivityGroupHeader } from "../../presentation/activity-group";
import type { ActivityItem } from "../../presentation/activity-item";
import type { TurnPresentation, TurnPresentationHeader } from "../../presentation/turn-presentation";
import { element } from "../dom-utils";
import { ActivityGroupNode } from "./activity-group-view";
import { DurationClock } from "./duration-view";
import { createSummaryNode, paintSummary, statusHint, type SummaryNodes } from "./turn-summary-view";

/**
 * 任务时间线。
 *
 * 每轮一个节点，turnId 是稳定 Key。增量消息只更新对应的组或条目，
 * 不重建整棵树；恢复历史时一次性挂载完整数据，且不订阅实时更新。
 */

export interface TimelineDeps {
  /** 把节点按真实时间顺序挂进会话流；调用方负责先给助手气泡封口。 */
  mount(node: HTMLElement): void;
  onShowLog(): void;
}

class TurnTimelineNode {
  readonly root: HTMLElement;

  private readonly groupsNode: HTMLElement;
  private readonly hintNode: HTMLElement;
  private readonly summaryNodes: SummaryNodes;
  private readonly groups = new Map<string, ActivityGroupNode>();
  /** 组头先于条目到达是常态，但反过来也要能兜住。 */
  private readonly orphanItems = new Map<string, ActivityItem[]>();

  constructor(
    private turn: TurnPresentationHeader,
    private readonly clock: DurationClock,
    private readonly deps: TimelineDeps,
  ) {
    this.root = element("section", "timeline");
    this.root.dataset.turnId = turn.turnId;
    this.groupsNode = element("div", "tl-groups");
    this.hintNode = element("div", "tl-hint");
    this.hintNode.hidden = true;
    this.summaryNodes = createSummaryNode();
    this.root.append(this.groupsNode, this.hintNode, this.summaryNodes.root);
    this.applyTurn(turn);
  }

  get turnId(): string { return this.turn.turnId; }
  get groupCount(): number { return this.groups.size; }

  groupNode(groupId: string): ActivityGroupNode | undefined {
    return this.groups.get(groupId);
  }

  applyTurn(turn: TurnPresentationHeader): void {
    this.turn = turn;
    this.root.dataset.status = turn.status;
    paintSummary(this.summaryNodes, turn);
    this.syncSummaryVisibility();
    const hint = statusHint(turn);
    this.hintNode.textContent = hint ?? "";
    this.hintNode.hidden = !hint;
    if (turn.status !== "running") this.stopClock();
  }

  applyGroup(header: ActivityGroupHeader): void {
    const existing = this.groups.get(header.id);
    if (existing) {
      existing.applyHeader(header);
      return;
    }
    const node = new ActivityGroupNode(header, {
      clock: this.clock,
      onShowLog: () => this.deps.onShowLog(),
    });
    this.groups.set(header.id, node);
    this.groupsNode.appendChild(node.root);
    const pending = this.orphanItems.get(header.id);
    if (pending) {
      for (const item of pending) node.applyItem(item);
      this.orphanItems.delete(header.id);
    }
    this.syncSummaryVisibility();
  }

  /**
   * 结算行只在轮次终态出现：运行中各组自己在滚动计时，这时再挂一行
   * 汇总耗时就是重复；收尾后组头不再报状态/耗时，结算行成为唯一出处。
   */
  private syncSummaryVisibility(): void {
    this.summaryNodes.root.hidden = this.turn.status === "running";
  }

  applyItem(groupId: string, item: ActivityItem): void {
    const node = this.groups.get(groupId);
    if (!node) {
      const bucket = this.orphanItems.get(groupId) ?? [];
      bucket.push(item);
      this.orphanItems.set(groupId, bucket);
      return;
    }
    node.applyItem(item);
  }

  restore(presentation: TurnPresentation): void {
    for (const group of presentation.groups) {
      const { items, ...header } = group;
      this.applyGroup(header);
      for (const item of items) this.applyItem(group.id, item);
    }
    this.applyTurn(presentation);
  }

  markRetried(): void {
    if (this.turn.retried) return;
    this.applyTurn({ ...this.turn, retried: true });
  }

  dispose(): void {
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
    this.orphanItems.clear();
  }

  /** 轮次进入终态后强制停表并收拢残留的运行中组，避免没收到收尾消息就一直挂着。 */
  private stopClock(): void {
    for (const group of this.groups.values()) group.settle();
  }
}

export class TimelineView {
  private readonly clock: DurationClock;
  private readonly turns = new Map<string, TurnTimelineNode>();
  private lastTurnId: string | undefined;

  constructor(private readonly deps: TimelineDeps, clock?: DurationClock) {
    this.clock = clock ?? new DurationClock();
  }

  get turnCount(): number { return this.turns.size; }
  get clockRunning(): boolean { return this.clock.running; }

  node(turnId: string): HTMLElement | undefined {
    return this.turns.get(turnId)?.root;
  }

  groupNode(turnId: string, groupId: string) {
    return this.turns.get(turnId)?.groupNode(groupId);
  }

  applyTurn(turn: TurnPresentationHeader): void {
    const existing = this.turns.get(turn.turnId);
    if (existing) {
      existing.applyTurn(turn);
      return;
    }
    // 新一轮开始时，把上一轮标成「已重试」的判断交给调用方；这里只负责挂载。
    this.create(turn);
  }

  applyGroup(turnId: string, group: ActivityGroupHeader): void {
    this.ensure(turnId).applyGroup(group);
  }

  applyItem(turnId: string, groupId: string, item: ActivityItem): void {
    this.ensure(turnId).applyItem(groupId, item);
  }

  /** 恢复历史：一次性铺完，状态已是终态，不会订阅计时。 */
  restore(presentation: TurnPresentation): void {
    const node = this.turns.get(presentation.turnId) ?? this.create(presentation);
    node.restore(presentation);
  }

  /** 用户重试后给上一轮时间线加标记，历史不删除。 */
  markPreviousRetried(): void {
    if (!this.lastTurnId) return;
    this.turns.get(this.lastTurnId)?.markRetried();
  }

  clear(): void {
    for (const node of this.turns.values()) node.dispose();
    this.turns.clear();
    this.lastTurnId = undefined;
    this.clock.dispose();
  }

  private ensure(turnId: string): TurnTimelineNode {
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    return this.create({ sessionId: "", turnId, status: "running", startedAt: Date.now() });
  }

  private create(turn: TurnPresentationHeader): TurnTimelineNode {
    const node = new TurnTimelineNode(turn, this.clock, this.deps);
    this.turns.set(turn.turnId, node);
    this.lastTurnId = turn.turnId;
    this.deps.mount(node.root);
    return node;
  }
}
