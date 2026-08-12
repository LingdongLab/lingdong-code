import {
  type ActivityGroup,
  type ActivityGroupHeader,
  GROUP_STATUS_LABEL,
  describeGroup,
  groupTitle,
} from "../../presentation/activity-group";
import { type ActivityItem, describeActivityItem } from "../../presentation/activity-item";
import { element } from "../dom-utils";
import { createItemRow, paintItemRow, type ItemRowDeps } from "./activity-item-view";
import { paintDuration, type DurationClock, type Unsubscribe } from "./duration-view";

/**
 * 一个活动分组。
 *
 * 默认折叠成一行摘要（标题 + 统计 + 当前动作）；底层工具名不直接露。
 * 组从运行中进入终态时若已展开则收拢。折叠时不保留条目 DOM，展开才创建。
 * 所有更新按稳定 Key（groupId / itemId）定位，不做整块重绘。
 */

export interface GroupNodeDeps extends ItemRowDeps {
  readonly clock: DurationClock;
}

export class ActivityGroupNode {
  readonly root: HTMLDetailsElement;

  private readonly titleNode: HTMLElement;
  private readonly subtitleNode: HTMLElement;
  private readonly currentNode: HTMLElement;
  private readonly outputNode: HTMLElement;
  private readonly statusNode: HTMLElement;
  private readonly statsNode: HTMLElement;
  private readonly durationNode: HTMLElement;
  private readonly itemsNode: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();
  private readonly items: ActivityItem[] = [];
  private readonly index = new Map<string, ActivityItem>();
  private header: ActivityGroupHeader;
  private unsubscribe: Unsubscribe | undefined;

  constructor(header: ActivityGroupHeader, private readonly deps: GroupNodeDeps) {
    this.header = header;
    this.root = element("details", "tl-group");
    this.root.dataset.groupId = header.id;
    // 默认折叠：摘要行已够用；失败/高风险条目再由用户展开看底层工具名。
    this.root.open = false;

    const summary = element("summary", "tl-group-head");
    const headline = element("div", "tl-group-headline");
    const main = element("div", "tl-group-main");
    this.titleNode = element("span", "tl-group-title");
    this.subtitleNode = element("span", "tl-group-subtitle");
    this.subtitleNode.hidden = true;
    this.currentNode = element("span", "tl-group-current");
    this.currentNode.hidden = true;
    main.append(this.titleNode, this.subtitleNode, this.currentNode);

    const meta = element("div", "tl-group-meta");
    this.statsNode = element("span", "tl-group-stats");
    this.durationNode = element("span", "tl-group-duration");
    this.statusNode = element("span", "tl-group-status");
    meta.append(this.statsNode, this.durationNode, this.statusNode);

    headline.append(main, meta);

    // 实时输出尾巴：折叠状态下也能看到正在跑的命令吐了什么（对标 Cursor）。
    // 必须挂在 summary *内部*——details 折叠时会隐藏 summary 之外的一切子节点，
    // 放在 summary 之后就等于「展开才可见」，那正是这段输出要解决的问题本身。
    this.outputNode = element("pre", "tl-group-output");
    this.outputNode.hidden = true;
    summary.append(headline, this.outputNode);
    this.root.appendChild(summary);

    this.itemsNode = element("div", "tl-group-items");
    this.root.appendChild(this.itemsNode);

    this.root.addEventListener("toggle", () => {
      if (this.root.open) this.buildItems();
      else this.releaseItems();
    });

    this.paintHeader();
    this.syncClock();
  }

  get groupId(): string { return this.header.id; }
  get open(): boolean { return this.root.open; }
  /** 折叠状态下不应残留任何条目 DOM。 */
  get renderedItemCount(): number { return this.rows.size; }

  applyHeader(header: ActivityGroupHeader): void {
    const wasRunning = this.header.status === "running";
    this.header = header;
    this.paintHeader();
    this.syncClock();
    // 只在「运行中 → 终态」这一次转换时收拢：用户手动展开已完成的组后，
    // 后续的头部更新不该把它再合上。
    if (wasRunning && header.status !== "running") this.collapse();
  }

  /** 已存在的条目原地更新，新条目才追加，避免整组重绘。 */
  applyItem(item: ActivityItem): void {
    const existing = this.index.get(item.id);
    if (existing) {
      Object.assign(existing, item);
      const row = this.rows.get(item.id);
      if (row) paintItemRow(row, existing, this.deps);
    } else {
      this.items.push(item);
      this.index.set(item.id, item);
      if (this.root.open) this.appendRow(item);
    }
    this.paintStats();
    this.paintCurrent();
  }

  /** 退订计时但保留内容；轮次结束后调用，确保全局定时器能停下来。 */
  freeze(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** 收拢成一行摘要并释放条目 DOM。 */
  collapse(): void {
    if (!this.root.open) return;
    this.root.open = false;
    this.releaseItems();
  }

  /**
   * 轮次终态兜底：个别组可能没收到自己的收尾消息（例如轮次被打断），
   * 停表之余把仍显示运行中的组一并收拢，避免展开的条目挂着不动。
   */
  settle(): void {
    this.freeze();
    if (this.header.status === "running") this.collapse();
  }

  dispose(): void {
    this.freeze();
    this.releaseItems();
  }

  private snapshot(): ActivityGroup {
    return { ...this.header, items: this.items };
  }

  private paintHeader(): void {
    this.titleNode.textContent = groupTitle(this.header.kind, this.header.status);
    if (this.header.subtitle) {
      this.subtitleNode.textContent = this.header.subtitle;
      this.subtitleNode.hidden = false;
    } else {
      this.subtitleNode.hidden = true;
    }
    this.statusNode.className = `tl-group-status tl-${this.header.status}`;
    this.statusNode.textContent = GROUP_STATUS_LABEL[this.header.status];
    // 状态只说一次（结算行）：组头不再重复「已完成」；运行中标题已是「正在…」。
    // 失败 / 停止是例外——必须在出事的那一组上标出来，展开才知道看哪里。
    this.statusNode.hidden = this.header.status === "completed" || this.header.status === "running";
    this.root.dataset.status = this.header.status;
    this.paintStats();
    this.paintCurrent();
    this.paintDuration();
  }

  /** 标题行上的「当前正在做什么」，只在组运行中且确有运行中的条目时出现。 */
  private paintCurrent(): void {
    const current = this.header.status === "running" ? this.latestRunningItem() : undefined;
    const text = current ? describeActivityItem(current) : "";
    if (this.currentNode.textContent !== text) this.currentNode.textContent = text;
    this.currentNode.hidden = text === "";
    this.paintOutputTail(current);
  }

  /** 运行中命令的最近几行输出，折叠状态也显示；命令收尾后由空 tail 自动隐藏。 */
  private paintOutputTail(current: ActivityItem | undefined): void {
    const tail = current?.outputTail ?? "";
    if (this.outputNode.textContent !== tail) this.outputNode.textContent = tail;
    this.outputNode.hidden = tail === "";
  }

  private latestRunningItem(): ActivityItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]?.status === "running") return this.items[i];
    }
    return undefined;
  }

  private paintStats(): void {
    const stats = describeGroup(this.snapshot()).join(" · ");
    if (this.statsNode.textContent !== stats) this.statsNode.textContent = stats;
    // 终态时标题已说明组类型（如「执行命令」），再写「执行 1 条命令」会和下面结算行撞车。
    // 运行中保留统计/当前动作，方便一眼看到进度。
    this.statsNode.hidden = this.header.status !== "running" || stats === "";
  }

  /** 每组的耗时只在运行中滚动显示；终态后总耗时看结算行，不逐组重复。 */
  private paintDuration(): void {
    if (this.header.status !== "running") {
      this.durationNode.textContent = "";
      this.durationNode.hidden = true;
      return;
    }
    paintDuration(this.durationNode, {
      startedAt: this.header.startedAt,
      running: true,
    });
  }

  /** 只有运行中的组才订阅计时；结束即退订，让全局定时器能停下来。 */
  private syncClock(): void {
    const running = this.header.status === "running";
    if (running && !this.unsubscribe) {
      this.unsubscribe = this.deps.clock.subscribe(() => this.paintDuration());
      return;
    }
    if (!running && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private buildItems(): void {
    if (this.rows.size > 0) return;
    for (const item of this.items) this.appendRow(item);
  }

  private appendRow(item: ActivityItem): void {
    const row = createItemRow(item, this.deps);
    this.rows.set(item.id, row);
    this.itemsNode.appendChild(row);
  }

  private releaseItems(): void {
    if (this.rows.size === 0) return;
    this.rows.clear();
    this.itemsNode.replaceChildren();
  }
}
