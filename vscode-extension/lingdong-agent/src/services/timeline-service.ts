import type { AgentEvent } from "@lingdong/agent-runtime";
import type { HostToWebviewMessage } from "../messages";
import { classifyTool } from "../presentation/event-classifier";
import type { ActivityAction } from "../presentation/activity-item";
import { countLineDiff, type LineDiffStat } from "../presentation/line-diff";
import { buildTurnSummary, type ChangeCounts } from "../presentation/summary-builder";
import { TimelineBuilder, type TimelinePatch } from "../presentation/timeline-builder";
import type { TurnPresentation, TurnStatus } from "../presentation/turn-presentation";
import { redact } from "../privacy/secret-redactor";
import {
  mergeVerification,
  parseVerification,
  type VerificationResult,
} from "../presentation/verification-parser";

/**
 * 任务时间线的宿主驱动器。
 *
 * Presentation 层保持纯净，所有与 Runtime 事件、ChangeTracker、计划状态的接线都在这里。
 * 一轮只有一个 TimelineBuilder，turnId 即时间线的稳定 Key。
 */

/** 每个工具调用为验证解析保留的输出长度；只留尾部，测试摘要都在末尾。 */
const MAX_OUTPUT_TAIL = 16_000;
/** 失败详情展示上限。 */
const MAX_FAILURE_DETAIL = 400;
/** 时间线实时输出尾巴：最多几行、多少字符。够看清「跑到哪了」，又不至于霸屏。 */
const LIVE_TAIL_LINES = 3;
const LIVE_TAIL_CHARS = 360;

/** 只有命令类活动才有滚动输出可看；读文件/搜索的返回刷出来只是噪音。 */
const LIVE_TAIL_ACTIONS: ReadonlySet<ActivityAction> = new Set<ActivityAction>([
  "run", "test", "typecheck", "lint", "build",
]);

const VERIFICATION_ACTIONS: ReadonlySet<ActivityAction> = new Set<ActivityAction>([
  "test", "typecheck", "lint", "build",
]);

export interface TimelineServiceDeps {
  post(message: HostToWebviewMessage): void;
  workspaceRoot(): string | undefined;
  /** 本轮真实文件变更数量，来自 ChangeTracker。 */
  changeCounts(turnId: string): ChangeCounts | undefined;
  /** 已批准计划的当前步骤标题；无法明确映射时返回 undefined。 */
  planStepTitle(): string | undefined;
  /** 轮次结束后落盘最终时间线。 */
  persist(presentation: TurnPresentation): void;
}

interface TrackedCall {
  action: ActivityAction;
  command: string;
  output: string;
}

export class TimelineService {
  private builder: TimelineBuilder | undefined;
  private readonly calls = new Map<string, TrackedCall>();
  private readonly verifications: VerificationResult[] = [];
  /** 本轮各文件的行级增删，按路径存最新值。 */
  private readonly lineDiffs = new Map<string, LineDiffStat>();
  /** lineDiffs 属于哪一轮。轮次结束后不清，摘要卡在结算之后还要拿它画 +N/-N。 */
  private lineDiffTurnId: string | undefined;

  constructor(private readonly deps: TimelineServiceDeps) {}

  get activeTurnId(): string | undefined {
    return this.builder?.turnId;
  }

  /**
   * 查某个文件在指定轮次的行级增删。
   *
   * 变更摘要卡走的是 ChangeTracker 那条线，它只有路径和哈希、没有行数；
   * 行数在这里已经算过一遍了，直接借给它用，免得为了一个角标再算一次 diff。
   * 必须带 turnId：恢复历史会话时也会重画摘要卡，不核对轮次会把这一轮的行数
   * 贴到上一轮的同名文件上。
   */
  linesFor(turnId: string, path: string): LineDiffStat | undefined {
    if (turnId !== this.lineDiffTurnId) return undefined;
    return this.lineDiffs.get(path);
  }

  /** 轮次开始。turnId 由 ChangeTracker 分配，与变更、快照共用同一个标识。 */
  begin(input: { sessionId: string; turnId: string; at?: number }): void {
    const at = input.at ?? Date.now();
    this.calls.clear();
    this.verifications.length = 0;
    this.lineDiffs.clear();
    this.lineDiffTurnId = input.turnId;
    this.builder = new TimelineBuilder({ sessionId: input.sessionId, turnId: input.turnId, startedAt: at });
    this.deps.post({ type: "timelineTurn", turn: this.builder.header() });
  }

  /**
   * 消费 Runtime 事件。
   * 只接受结构化的工具与生命周期事件；thought_delta 等模型私有推理不会传到这里。
   */
  handleEvent(event: AgentEvent, at = Date.now()): void {
    const builder = this.builder;
    if (!builder) return;
    switch (event.type) {
      case "tool_started":
        this.onToolStarted(builder, event, at);
        return;
      case "tool_progress":
        // 参数流中途解析出路径：补全时间线条目目标，不另开一组。
        if (event.target) this.onToolTarget(builder, event.toolCallId, event.target, event.name, at);
        return;
      case "command_output":
        this.onCommandOutput(event.toolCallId, event.text);
        return;
      case "tool_completed":
        this.onToolCompleted(builder, event, at);
        return;
      case "subagent_started":
        // 与 tool_started 同一个 toolCallId，因此这里是「补全标题」而不是新开条目：
        // 派发子 Agent 时真正有信息量的是 description，不是工具名。
        this.onSubagentStarted(builder, event, at);
        return;
      case "file_diff":
        this.onFileDiff(builder, event);
        return;
      case "error":
        this.emit(builder.noteFailure({ title: "工具调用失败", detail: trim(event.message), at }));
        return;
      default:
        return;
    }
  }

  private onToolStarted(
    builder: TimelineBuilder,
    event: Extract<AgentEvent, { type: "tool_started" }>,
    at: number,
  ): void {
    const workspaceRoot = this.deps.workspaceRoot();
    const activity = classifyTool(
      {
        toolCallId: event.toolCallId,
        kind: event.kind,
        name: event.name,
        label: event.label,
        readOnly: event.readOnly,
        ...(event.target ? { target: event.target } : {}),
      },
      workspaceRoot ? { workspaceRoot } : {},
    );
    if (!activity) return;

    this.calls.set(event.toolCallId, {
      action: activity.action,
      command: activity.target ?? event.label ?? event.name,
      output: "",
    });
    // 副标题只在计划步骤能明确映射时出现，且永不替换主标题。
    this.emit(builder.setSubtitle(this.deps.planStepTitle()));
    this.emit(builder.startTool(activity, at));
  }

  private onToolTarget(
    builder: TimelineBuilder,
    toolCallId: string,
    target: string,
    name: string | undefined,
    at: number,
  ): void {
    const tracked = this.calls.get(toolCallId);
    const workspaceRoot = this.deps.workspaceRoot();
    const activity = classifyTool(
      {
        toolCallId,
        kind: name && /write|edit|create|replace|patch/i.test(name) ? "edit"
          : name && /read|view|cat/i.test(name) ? "read"
            : name && /terminal|bash|shell|command/i.test(name) ? "execute"
              : name && /search|grep|glob|list/i.test(name) ? "search" : "other",
        name: name ?? "tool",
        label: name ?? "tool",
        target,
        readOnly: !!name && /read|list|search|grep|glob/i.test(name),
      },
      workspaceRoot ? { workspaceRoot } : {},
    );
    if (!activity?.target) return;
    // 路径已挂上（含后续上万条 arguments_delta）就别再刷时间线。
    if (tracked?.command === activity.target) return;
    this.calls.set(toolCallId, {
      action: activity.action,
      command: activity.target,
      output: tracked?.output ?? "",
    });
    this.emit(builder.startTool(activity, at));
  }

  /**
   * 编辑带来的行级增删。
   *
   * 按文件记而不是按 toolCallId 累加：同一个文件被同一次工具调用反复上报（pending → 落盘）时
   * 后一次的统计是对整次编辑的完整描述，直接覆盖；轮次合计再把各文件的最新值加起来，
   * 这样反复修同一个文件也不会把行数重复计进去。
   */
  private onFileDiff(
    builder: TimelineBuilder,
    event: Extract<AgentEvent, { type: "file_diff" }>,
  ): void {
    const stat = countLineDiff(event.oldText, event.newText);
    if (!stat) return;
    this.lineDiffs.set(event.path, stat);
    this.emit(builder.noteLineDiff(event.toolCallId, stat));
  }

  /** 本轮各文件行数的合计；没有任何可靠数据时返回 undefined。 */
  private totalLineDiff(): LineDiffStat | undefined {
    if (this.lineDiffs.size === 0) return undefined;
    let added = 0;
    let deleted = 0;
    for (const stat of this.lineDiffs.values()) {
      added += stat.added;
      deleted += stat.deleted;
    }
    return { added, deleted };
  }

  private onSubagentStarted(
    builder: TimelineBuilder,
    event: Extract<AgentEvent, { type: "subagent_started" }>,
    at: number,
  ): void {
    const tracked = this.calls.get(event.toolCallId);
    if (tracked?.command === event.description) return;
    this.calls.set(event.toolCallId, {
      action: "subagent",
      command: event.description,
      output: tracked?.output ?? "",
    });
    this.emit(builder.startTool(
      { toolCallId: event.toolCallId, action: "subagent", target: event.description },
      at,
    ));
  }

  private onCommandOutput(toolCallId: string, text: string): void {
    const call = this.calls.get(toolCallId);
    if (!call) return;
    const merged = `${call.output}${text}`;
    call.output = merged.length > MAX_OUTPUT_TAIL ? merged.slice(merged.length - MAX_OUTPUT_TAIL) : merged;
    // 命令还在跑的时候，把最近几行直接摆在时间线上（对标 Cursor 的滚动输出）。
    // builder 侧有「没变不发」的闸，这里不用再抖动节流。
    if (this.builder && LIVE_TAIL_ACTIONS.has(call.action)) {
      this.emit(this.builder.noteOutputTail(toolCallId, liveTail(call.output)));
    }
  }

  private onToolCompleted(
    builder: TimelineBuilder,
    event: Extract<AgentEvent, { type: "tool_completed" }>,
    at: number,
  ): void {
    const call = this.calls.get(event.toolCallId);
    if (call && VERIFICATION_ACTIONS.has(call.action)) {
      this.verifications.push(parseVerification({
        command: call.command,
        output: call.output,
        ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      }));
    }
    const detail = !event.success && call?.output ? trim(call.output) : undefined;
    this.emit(builder.completeTool(event.toolCallId, {
      success: event.success,
      at,
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(detail ? { detail } : {}),
    }));
  }

  /** 用户停止：立刻把运行中的活动置为已停止，不等轮次收尾。 */
  stop(at = Date.now()): void {
    if (!this.builder) return;
    this.emit(this.builder.stop(at));
  }

  /** Runtime 断线：单独成组，轮次判失败，时间线立即停表。 */
  noteDisconnected(reason: string, at = Date.now()): void {
    const builder = this.builder;
    if (!builder) return;
    this.emit(builder.noteFailure({ title: "Agent 连接中断", detail: trim(reason), at }));
    this.finish({ status: "failed", at });
  }

  /** 轮次收尾：结算统计、推送终态并落盘。重复调用无副作用。 */
  finish(input: { status: TurnStatus; at?: number }): TurnPresentation | undefined {
    const builder = this.builder;
    if (!builder) return undefined;
    const at = input.at ?? Date.now();
    const total = this.totalLineDiff();
    const summary = buildTurnSummary({
      groups: builder.presentation.groups,
      ...(this.changeCounts(builder.turnId) ? { changes: this.changeCounts(builder.turnId)! } : {}),
      ...(this.verifications.length > 0 ? { verification: mergeVerification(this.verifications) } : {}),
      ...(total ? { lines: total } : {}),
    });
    this.emit(builder.finish({ status: input.status, at, summary }));

    const presentation = builder.presentation;
    this.builder = undefined;
    this.calls.clear();
    this.verifications.length = 0;
    // lineDiffs 刻意不清：结算之后用户还会在摘要卡上接受/拒绝，每次都要重画，
    // 清掉的话那些 +N/-N 会在点第一下的时候集体消失。下一轮 begin() 会清。
    this.deps.persist(presentation);
    return presentation;
  }

  private changeCounts(turnId: string): ChangeCounts | undefined {
    return this.deps.changeCounts(turnId);
  }

  private emit(patches: TimelinePatch[]): void {
    const turnId = this.builder?.turnId;
    if (!turnId) return;
    for (const patch of patches) {
      if (patch.kind === "turn") this.deps.post({ type: "timelineTurn", turn: patch.turn });
      else if (patch.kind === "group") this.deps.post({ type: "timelineGroup", turnId, group: patch.group });
      else this.deps.post({ type: "timelineItem", turnId, groupId: patch.groupId, item: patch.item });
    }
  }
}

/**
 * 失败明细会直接进 UI，命令输出里可能带着请求头或 Key，先脱敏再截断。
 * 落盘时序列化层还会再过一遍，这里管的是推给 Webview 的那一份。
 */
function trim(text: string): string {
  const compact = redact(text.trim());
  if (compact.length <= MAX_FAILURE_DETAIL) return compact;
  // 失败原因通常在输出末尾，保留尾部更有用。
  return `……${compact.slice(compact.length - MAX_FAILURE_DETAIL)}`;
}

/** 取输出的最后几行做实时尾巴；同样要脱敏——这段字直接进 UI。 */
function liveTail(output: string): string {
  const lines = output.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const tail = lines.slice(-LIVE_TAIL_LINES).join("\n");
  const compact = redact(tail);
  if (compact.length <= LIVE_TAIL_CHARS) return compact;
  return `…${compact.slice(compact.length - LIVE_TAIL_CHARS)}`;
}
