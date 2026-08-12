import {
  type ActivityGroup,
  type ActivityGroupHeader,
  type ActivityGroupKind,
  GROUP_TITLE,
  groupKindForAction,
  resolveGroupStatus,
} from "./activity-group";
import type { ActivityItem } from "./activity-item";
import type { NormalizedActivity } from "./event-classifier";
import type { LineDiffStat } from "./line-diff";
import {
  type TurnPresentation,
  type TurnPresentationHeader,
  type TurnStatus,
} from "./turn-presentation";
import type { TurnSummary } from "./turn-summary";

/**
 * 时间线增量构建器。
 *
 * 两条硬规则：
 * 1. 同一 toolCallId 的 started / output / completed 只对应一个 ActivityItem，
 *    不同 toolCallId、不同文件、不同命令永不合并（这里没有任何按时间去重的逻辑）。
 * 2. 分组只做语义相邻归并，kind 一变就封组，read → edit → read 必然产生三组。
 */

export type TimelinePatch =
  | { kind: "turn"; turn: TurnPresentationHeader }
  | { kind: "group"; group: ActivityGroupHeader }
  | { kind: "item"; groupId: string; item: ActivityItem };

export interface TimelineBuilderInput {
  sessionId: string;
  turnId: string;
  startedAt: number;
}

export interface CompleteToolInput {
  success: boolean;
  at: number;
  exitCode?: number;
  detail?: string;
}

function headerOf(group: ActivityGroup): ActivityGroupHeader {
  const { items: _items, ...header } = group;
  return { ...header };
}

export class TimelineBuilder {
  private readonly turn: TurnPresentation;
  /** 新的同类活动会继续追加到这一组；kind 改变时才换组。 */
  private active: ActivityGroup | undefined;
  private readonly byTool = new Map<string, { group: ActivityGroup; item: ActivityItem }>();
  private groupSeq = 0;
  private itemSeq = 0;
  private subtitle: string | undefined;

  constructor(input: TimelineBuilderInput) {
    this.turn = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      status: "running",
      startedAt: input.startedAt,
      groups: [],
    };
  }

  get presentation(): TurnPresentation {
    return {
      ...this.turn,
      groups: this.turn.groups.map((group) => ({ ...group, items: group.items.map((item) => ({ ...item })) })),
    };
  }

  get turnId(): string {
    return this.turn.turnId;
  }

  get status(): TurnStatus {
    return this.turn.status;
  }

  header(): TurnPresentationHeader {
    const { groups: _groups, ...header } = this.turn;
    return { ...header };
  }

  /**
   * 计划步骤副标题。只作用于之后新建的组与当前组，且永不替换主标题。
   */
  setSubtitle(subtitle: string | undefined): TimelinePatch[] {
    const next = subtitle?.trim() || undefined;
    if (next === this.subtitle) return [];
    this.subtitle = next;
    const active = this.active;
    if (!active) return [];
    if (next) active.subtitle = next;
    else delete active.subtitle;
    return [{ kind: "group", group: headerOf(active) }];
  }

  startTool(activity: NormalizedActivity, at: number): TimelinePatch[] {
    const patches: TimelinePatch[] = [];
    const kind = groupKindForAction(activity.action);
    const group = this.ensureGroup(kind, at, patches);

    const existing = this.byTool.get(activity.toolCallId);
    if (existing) {
      // 同一 toolCallId 重复上报 started：更新原条目，绝不新建。
      existing.item.action = activity.action;
      if (activity.target) existing.item.target = activity.target;
      patches.push({ kind: "item", groupId: existing.group.id, item: { ...existing.item } });
      return patches;
    }

    this.itemSeq += 1;
    const item: ActivityItem = {
      id: `ai-${this.itemSeq}`,
      toolCallId: activity.toolCallId,
      action: activity.action,
      ...(activity.target ? { target: activity.target } : {}),
      status: "running",
      startedAt: at,
    };
    group.items.push(item);
    this.byTool.set(activity.toolCallId, { group, item });
    this.refreshGroup(group);
    patches.push({ kind: "item", groupId: group.id, item: { ...item } });
    patches.push({ kind: "group", group: headerOf(group) });
    return patches;
  }

  completeTool(toolCallId: string, input: CompleteToolInput): TimelinePatch[] {
    const found = this.byTool.get(toolCallId);
    if (!found) return [];
    const { group, item } = found;
    item.status = input.success ? "completed" : "failed";
    item.completedAt = input.at;
    // 实时尾巴只服务于「跑到哪了」；收尾后留着就是一段掐头去尾的假日志。
    delete item.outputTail;
    if (input.exitCode !== undefined) item.exitCode = input.exitCode;
    if (input.detail) item.detail = input.detail;
    this.refreshGroup(group);
    return [
      { kind: "item", groupId: group.id, item: { ...item } },
      { kind: "group", group: headerOf(group) },
    ];
  }

  /**
   * 给条目补行级增删。编辑事件先于 tool_completed 到达，所以这里不碰状态，
   * 也不要求条目已经收尾。
   */
  noteLineDiff(toolCallId: string, lines: LineDiffStat): TimelinePatch[] {
    const found = this.byTool.get(toolCallId);
    if (!found) return [];
    const current = found.item.lines;
    if (current && current.added === lines.added && current.deleted === lines.deleted) return [];
    found.item.lines = lines;
    return [{ kind: "item", groupId: found.group.id, item: { ...found.item } }];
  }

  /**
   * 运行中命令的实时输出尾巴。只作用于 running 条目；
   * 尾巴没变就不发补丁，别让高频输出把 Webview 刷成筛子。
   */
  noteOutputTail(toolCallId: string, tail: string): TimelinePatch[] {
    const found = this.byTool.get(toolCallId);
    if (!found || found.item.status !== "running") return [];
    if (found.item.outputTail === tail) return [];
    if (tail) found.item.outputTail = tail;
    else delete found.item.outputTail;
    return [{ kind: "item", groupId: found.group.id, item: { ...found.item } }];
  }

  /** 给条目补细节（例如失败输出摘要），不改变状态。 */
  annotateTool(toolCallId: string, detail: string): TimelinePatch[] {
    const found = this.byTool.get(toolCallId);
    if (!found || !detail.trim()) return [];
    found.item.detail = detail;
    return [{ kind: "item", groupId: found.group.id, item: { ...found.item } }];
  }

  /**
   * 没有对应工具调用的失败：Runtime 断线、快照失败、可恢复错误。
   * 单独成组，不伪造 ActivityItem。
   */
  noteFailure(input: { title: string; detail?: string; at: number; kind?: "warning" | "failure" }): TimelinePatch[] {
    const patches: TimelinePatch[] = [];
    this.closeActive(input.at, patches);
    this.groupSeq += 1;
    const group: ActivityGroup = {
      id: `ag-${this.groupSeq}`,
      kind: input.kind ?? "failure",
      title: input.title,
      status: input.kind === "warning" ? "completed" : "failed",
      startedAt: input.at,
      completedAt: input.at,
      items: [],
      ...(input.detail ? { subtitle: input.detail } : {}),
    };
    this.turn.groups.push(group);
    patches.push({ kind: "group", group: headerOf(group) });
    return patches;
  }

  /** 用户停止：运行中的条目与组一并置为已停止。 */
  stop(at: number): TimelinePatch[] {
    const patches: TimelinePatch[] = [];
    for (const group of this.turn.groups) {
      let touched = false;
      for (const item of group.items) {
        if (item.status !== "running") continue;
        item.status = "stopped";
        item.completedAt = at;
        touched = true;
        patches.push({ kind: "item", groupId: group.id, item: { ...item } });
      }
      if (!touched) continue;
      this.refreshGroup(group);
      patches.push({ kind: "group", group: headerOf(group) });
    }
    return patches;
  }

  finish(input: { status: TurnStatus; at: number; summary?: TurnSummary }): TimelinePatch[] {
    const patches: TimelinePatch[] = [];
    if (input.status === "stopped") patches.push(...this.stop(input.at));
    this.closeActive(input.at, patches);

    // 轮次结束后仍在 running 的条目只能是异常收尾，按失败处理而不是假装完成。
    for (const group of this.turn.groups) {
      let touched = false;
      for (const item of group.items) {
        if (item.status !== "running") continue;
        item.status = input.status === "completed" ? "completed" : "failed";
        item.completedAt = input.at;
        touched = true;
        patches.push({ kind: "item", groupId: group.id, item: { ...item } });
      }
      if (touched) {
        this.refreshGroup(group);
        patches.push({ kind: "group", group: headerOf(group) });
      }
    }

    this.turn.status = input.status;
    this.turn.completedAt = input.at;
    this.turn.durationMs = Math.max(0, input.at - this.turn.startedAt);
    if (input.summary) this.turn.summary = input.summary;
    patches.push({ kind: "turn", turn: this.header() });
    return patches;
  }

  private ensureGroup(kind: ActivityGroupKind, at: number, patches: TimelinePatch[]): ActivityGroup {
    const active = this.active;
    if (active && active.kind === kind) return active;
    this.closeActive(at, patches);
    this.groupSeq += 1;
    const group: ActivityGroup = {
      id: `ag-${this.groupSeq}`,
      kind,
      title: GROUP_TITLE[kind],
      status: "running",
      startedAt: at,
      items: [],
      ...(this.subtitle ? { subtitle: this.subtitle } : {}),
    };
    this.turn.groups.push(group);
    this.active = group;
    patches.push({ kind: "group", group: headerOf(group) });
    return group;
  }

  private closeActive(at: number, patches: TimelinePatch[]): void {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    this.refreshGroup(active);
    if (active.completedAt === undefined && active.status !== "running") active.completedAt = at;
    patches.push({ kind: "group", group: headerOf(active) });
  }

  private refreshGroup(group: ActivityGroup): void {
    group.status = resolveGroupStatus(group.items);
    if (group.status === "running") {
      delete group.completedAt;
      return;
    }
    const last = group.items.reduce((max, item) => Math.max(max, item.completedAt ?? 0), 0);
    if (last > 0) group.completedAt = last;
  }
}
