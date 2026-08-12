import type { PlanCardView, PlanStepView } from "../plan-view-model";
import { element } from "./dom-utils";
import { statusStack } from "./status-stack";

/**
 * 会话流里的任务清单卡片。
 *
 * 数据来自 Grok 每轮实时推送的 todo 列表（status 为 executing 的 plan 卡片），
 * 与需要审批的计划文档是两条线：这张卡不承担批准/驳回，只做进度呈现——
 * 完成一项就打勾划掉一项，正在做的一项高亮。
 *
 * 整个会话只保留一张卡，重复下发时就地更新：Grok 的 todo 是「当前任务的清单」，
 * 追加多张卡片只会让同一份清单的历史快照铺满会话流。
 * 会话回放会把历次更新依序走一遍，最终停在终态，正好是想要的效果。
 */

export interface TodoCardDeps {
  /** 挂进会话流；调用方负责先给助手气泡封口。 */
  mount(node: HTMLElement): void;
  /** composer 上方的常驻进度条；没有传就只更新会话流里的卡片。 */
  progress?: HTMLElement;
}

export type TodoStepStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/** 旧版会话记录没有结构化状态，只能从 detail 的「状态：X」文案倒推。 */
const DETAIL_LABEL_TO_STATUS: Record<string, TodoStepStatus> = {
  待处理: "pending",
  进行中: "in_progress",
  已完成: "completed",
  未成功: "failed",
  已取消: "cancelled",
};

export function stepUiStatus(step: PlanStepView): TodoStepStatus {
  if (step.status) return step.status;
  const match = /^状态：(.+)$/.exec(step.detail?.trim() ?? "");
  if (match?.[1]) return DETAIL_LABEL_TO_STATUS[match[1].trim()] ?? "pending";
  return "pending";
}

const STEP_MARK: Record<TodoStepStatus, string> = {
  pending: "○",
  in_progress: "●",
  completed: "✓",
  failed: "!",
  cancelled: "–",
};

export class TodoCardView {
  private root: HTMLElement | undefined;
  private titleNode: HTMLElement | undefined;
  private progressNode: HTMLElement | undefined;
  private listNode: HTMLElement | undefined;
  /** 最近应用的更新序号：「加载更早消息」重放旧快照时凭它忽略回滚。 */
  private lastSeq = 0;

  constructor(private readonly deps: TodoCardDeps) {
    deps.progress?.addEventListener("click", () => {
      this.root?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  get mounted(): boolean {
    return this.root !== undefined;
  }

  /**
   * 应用一次 todo 更新。seq 是消息的会话内时序号：
   * 比已应用的更旧（分页回放旧条目）就忽略，防止清单被回写成历史快照。
   */
  apply(card: PlanCardView, seq?: number): void {
    if (card.steps.length === 0) return;
    if (seq !== undefined) {
      if (seq <= this.lastSeq) return;
      this.lastSeq = seq;
    }
    this.ensureCard();
    if (this.titleNode) this.titleNode.textContent = card.title || "任务进度";

    const done = card.steps.filter((step) => stepUiStatus(step) === "completed").length;
    if (this.progressNode) this.progressNode.textContent = `${done}/${card.steps.length}`;

    // 清单不长且只在步骤状态切换时到达，整列表重建比逐项 diff 更省心也更不容易错位。
    const rows = card.steps.map((step) => {
      const status = stepUiStatus(step);
      const row = element("li", `todo-step todo-${status}`);
      row.appendChild(element("span", "todo-mark", STEP_MARK[status]));
      row.appendChild(element("span", "todo-title", step.title));
      return row;
    });
    this.listNode?.replaceChildren(...rows);
    this.paintProgressBar(card, done);
  }

  /** 新会话或清屏时丢掉卡片引用；DOM 由会话流的 clear 一并移除。 */
  reset(): void {
    this.root = undefined;
    this.titleNode = undefined;
    this.progressNode = undefined;
    this.listNode = undefined;
    this.lastSeq = 0;
    statusStack.register("task", this.deps.progress);
    statusStack.want("task", false);
  }

  /** composer 上方的常驻进度条：`任务进度 3/5 · 正在：修改 login.html`。 */
  private paintProgressBar(card: PlanCardView, done: number): void {
    const bar = this.deps.progress;
    if (!bar) return;
    const current = card.steps.find((step) => stepUiStatus(step) === "in_progress");
    const suffix = current ? ` · 正在：${current.title}` : done >= card.steps.length ? " · 已完成" : "";
    bar.textContent = `任务进度 ${done}/${card.steps.length}${suffix}`;
    statusStack.register("task", bar);
    statusStack.want("task", true);
  }

  private ensureCard(): void {
    if (this.root) return;
    const card = element("section", "card todo-card");

    const header = element("div", "card-header");
    this.titleNode = element("span", "card-title", "任务进度");
    header.appendChild(this.titleNode);
    this.progressNode = element("span", "todo-progress");
    header.appendChild(this.progressNode);
    card.appendChild(header);

    this.listNode = element("ul", "todo-list");
    card.appendChild(this.listNode);

    this.root = card;
    this.deps.mount(card);
  }
}
