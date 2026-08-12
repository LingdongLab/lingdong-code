import { Buffer } from "node:buffer";
import type { AskUserRequest } from "./ask-question.js";
import { parsePlan, type AgentPlan, type AgentPlanStep } from "./plan-parser.js";
import { isRecord, type PermissionRequestParams, type SessionUpdateParams } from "./protocol.js";
import type { SafetyDecision } from "./safety-policy.js";
import type { SessionRule } from "./session-permissions.js";

export type ToolDisplayKind = "read" | "edit" | "execute" | "search" | "plan" | "subagent" | "other";

/**
 * 后台任务的各阶段。
 *
 * started 单独一帧是因为 task_id 要等命令返回才拿到，而卡片必须立刻出现；
 * 拿到 id 后再补一帧 registered。exited / killed 只可能在拿到 id 之后。
 */
export type BackgroundTaskFrame =
  | { phase: "started"; toolCallId: string; command: string; kind: "command" | "monitor" }
  | { phase: "registered"; toolCallId: string; taskId: string }
  | { phase: "output"; taskId: string; text: string }
  | { phase: "exited"; taskId: string; success: boolean; exitCode?: number }
  | { phase: "killed"; taskId: string };

export type PermissionResolution =
  | "allow_once"
  | "allow_session"
  | "allow_always"
  | "reject"
  | "expired"
  | "cancelled";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "status"; message: string }
  | {
      type: "tool_started";
      toolCallId: string;
      name: string;
      kind: ToolDisplayKind;
      label: string;
      readOnly: boolean;
      target?: string;
    }
  /**
   * 工具参数还在流式生成（Grok 的 tool_call_delta_chunk）。
   * 正式 tool_call 往往要等整段参数写完才到；这段时间必须让 UI 知道
   * 「在干活」而不是「在思考」，否则会误报长时间无输出。
   */
  | { type: "tool_progress"; toolCallId: string; name?: string; target?: string }
  | { type: "tool_completed"; toolCallId: string; name: string; success: boolean; exitCode?: number }
  /**
   * 模型派了一个子 Agent（Grok 的 spawn_subagent）。
   * 单独成事件是因为它和普通工具调用的生命周期不一样：background 的会跨轮活着，
   * 阻塞的那种则意味着父 Agent 正在干等——两者在 UI 上都得有自己的位置。
   */
  | {
      type: "subagent_started";
      toolCallId: string;
      description: string;
      subagentType?: string;
      background: boolean;
    }
  | { type: "subagent_completed"; toolCallId: string; success: boolean; summary?: string }
  /**
   * 后台派发的子 Agent 交回的报告。
   *
   * 派发那次调用是立刻返回 task_id 的，真正的结果要等模型用
   * get_command_or_subagent_output 去取；取回来的那一段就是这里的 text。
   * 与 subagent_completed 分开是因为可以取多次，而结束只有一次。
   */
  | { type: "subagent_output"; toolCallId: string; text: string }
  /**
   * 后台任务（background 的 shell、monitor）的生命周期。
   *
   * 五个阶段合成一个事件而不是五个 AgentEvent 变体：消费方只有任务台账一个，
   * 而每多一个变体，宿主那些穷尽 switch 就都得多一处表态。
   */
  | { type: "background_task"; frame: BackgroundTaskFrame }
  | {
      type: "permission_requested";
      requestId: string;
      request: PermissionRequestParams;
      decision: SafetyDecision;
      label: string;
      reason: string;
    }
  | {
      type: "permission_resolved";
      requestId: string;
      resolution: PermissionResolution;
      automatic: boolean;
      reason: string;
      rule?: SessionRule;
    }
  | { type: "plan_review_requested"; requestId: string; plan: AgentPlan }
  | { type: "plan_review_closed"; requestId: string; outcome: "approved" | "abandoned" | "cancelled" | "dropped" }
  | { type: "plan_updated"; plan: AgentPlan }
  /** 模型通过 ask_user_question 工具提问，Grok 阻塞等待客户端回执。 */
  | { type: "question_requested"; requestId: string; request: AskUserRequest }
  | { type: "question_resolved"; requestId: string; outcome: "answered" | "cancelled"; answers?: string[] }
  | { type: "mode_changed"; mode: string; source: "server" | "client" }
  | { type: "file_changed"; path: string; change: "create" | "modify" | "delete" }
  /**
   * 一次编辑的前后全文（Grok 在 tool_call / tool_call_update 的 `diff` content 项里给出）。
   *
   * 与 file_changed 分开是因为两者的用途完全不同：file_changed 只是「这个文件动了，
   * 去重新读一遍磁盘」，而这里带着 oldText / newText，宿主可以在磁盘落笔之前就把
   * diff 摆到编辑器里——这是对标 Cursor 边写边看的唯一信息来源。
   * pending 为 true 表示工具还没结束，磁盘上大概率还是旧内容。
   */
  | {
      type: "file_diff";
      toolCallId: string;
      path: string;
      change: "create" | "modify" | "delete";
      oldText: string;
      newText: string;
      pending: boolean;
    }
  | { type: "command_output"; toolCallId: string; text: string }
  | { type: "error"; message: string }
  /** Grok 子进程非预期退出或传输层失败；宿主必须据此作废 Runtime 缓存。 */
  | { type: "disconnected"; reason: string; code?: number | null; signal?: string | null }
  | { type: "completed"; stopReason: string; modelId?: string }
  | {
      type: "token_usage";
      source: "exact" | "stream";
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedReadTokens?: number;
      reasoningTokens?: number;
      modelCalls?: number;
    }
  | { type: "context_compacted"; trigger: "auto" | "manual"; detail?: string };

interface ToolState {
  name: string;
  commandOutput: string;
  /**
   * 这次调用已经走上增量通道（rawOutput.output_delta）。
   * 一旦见过增量就不再吃全量兜底：收尾那条 update 往往还带着
   * output_for_prompt（ANSI 剥离 + 软换行后的全量），前缀比对多半失败，
   * 混着用会把整段输出再追加一遍。
   */
  sawOutputDelta?: boolean;
  /** 派发子 Agent 的调用要在收尾时额外补一条 subagent_completed。 */
  spawnsSubagent?: boolean;
  /** 后台派发时返回的 task_id；之后取输出要靠它找回这张卡。只填一次。 */
  subagentTaskId?: string;
  /** 有值即「这一次调用起了个后台任务」，命令原文用来做卡片标题。 */
  background?: { command: string; kind: "command" | "monitor" };
  /** 从返回里解析出的 task_id，只填一次。 */
  backgroundTaskId?: string;
  /** get_command_or_subagent_output 的目标任务：它的输出要接回对应卡片。 */
  probeTaskIds?: string[];
  /** kill_command_or_subagent 的目标任务。 */
  killTaskId?: string;
  /**
   * 已经发过 diff 的文件 → 那次的 newText。
   * Grok 会在同一次调用的多条 update 里重复带上同一份 diff（每条 update 都是全量 content），
   * 不去重的话宿主会反复重开预览编辑器。
   */
  emittedDiffs?: Map<string, string>;
}

/** 后台任务的命令原文；返回 undefined 表示这次调用不是后台任务。 */
function backgroundFromRawInput(
  name: string,
  raw: unknown,
): { command: string; kind: "command" | "monitor" } | undefined {
  const record = isRecord(raw) ? raw : {};
  const isMonitor = MONITOR_TOOL_PATTERN.test(name);
  // monitor 天生就是常驻的，不需要 background 标记；普通 shell 必须显式声明。
  if (!isMonitor && !(BACKGROUND_TOOL_PATTERN.test(name) && record.background === true)) {
    return undefined;
  }
  const command = stringValue(record.command)
    ?? stringValue(record.description)
    ?? name;
  return { command: oneLineLabel(command) ?? command, kind: isMonitor ? "monitor" : "command" };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 工具是否已收尾。状态缺失时按「还在跑」处理：宁可把预览标成未落盘。 */
function isSettledStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed";
}

function xaiTool(update: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(update._meta) ? update._meta : {};
  return isRecord(meta["x.ai/tool"]) ? meta["x.ai/tool"] : {};
}

function toolName(update: Record<string, unknown>): string {
  const xai = xaiTool(update);
  return stringValue(xai.name) ?? stringValue(update.title) ?? stringValue(update.kind) ?? "tool";
}

/**
 * 子 Agent 相关工具：派发、取输出、等待、终止。
 * Task 是 Grok 为兼容 Claude 留的 spawn_subagent 别名。
 */
const SUBAGENT_TOOL_PATTERN = /subagent|^task$/i;

/** 只有派发这一个动作会新开一个子 Agent，取输出/等待/终止都是对已有子 Agent 的操作。 */
const SPAWN_SUBAGENT_PATTERN = /^(spawn_subagent|task)$/i;

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_PATTERN.test(name);
}

export function isSpawnSubagentTool(name: string): boolean {
  return SPAWN_SUBAGENT_PATTERN.test(name);
}

export function toDisplayKind(kind: string | undefined, name: string): ToolDisplayKind {
  const value = (kind ?? "").toLowerCase();
  // 必须排在最前：get_command_or_subagent_output 这类名字里带 command，
  // 会被下面的 execute 规则先抢走，而 ACP 报的 kind 往往也只是笼统的 execute。
  if (isSubagentTool(name)) return "subagent";
  if (value === "edit" || value === "write" || value === "delete") return "edit";
  if (value === "execute") return "execute";
  if (value === "search" || value === "fetch") return "search";
  if (value === "read") return "read";
  if (value === "think" || value === "plan") return "plan";
  if (/plan/i.test(name)) return "plan";
  // WebSearch / web_search / MCP 搜索工具名都归到 search 展示。
  if (/search|grep|glob|find|websearch/i.test(name)) return "search";
  if (/read|view|cat/i.test(name)) return "read";
  if (/terminal|bash|shell|command/i.test(name)) return "execute";
  if (/edit|write|create|replace|patch/i.test(name)) return "edit";
  if (/list[_ ]?dir|listdir|list[_ ]?files/i.test(name)) return "search";
  return "other";
}

const PATH_KEYS = ["path", "target_file", "file_path", "file", "target_directory", "directory"] as const;

/** 从工具 rawInput 里抠文件路径，供状态栏/时间线尽早显示目标。 */
function pathFromRawInput(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  for (const key of PATH_KEYS) {
    const value = stringValue(raw[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * 从尚未闭合的 arguments JSON 片段里抠某个字符串字段。
 * 参数流刚开头就能拿到 path / description，不必等整段几万字符写完。
 */
function stringFromPartialArgs(args: string, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const matched = args.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (matched?.[1]) {
      try {
        return JSON.parse(`"${matched[1]}"`) as string;
      } catch {
        return matched[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    }
  }
  return undefined;
}

function pathFromPartialArgs(args: string): string | undefined {
  return stringFromPartialArgs(args, PATH_KEYS);
}

/** description 是模型自己写的 3~5 词短标签，正是任务卡要显示的东西。 */
const SUBAGENT_LABEL_KEYS = ["description", "prompt"] as const;
const CARD_LABEL_MAX_LENGTH = 60;

/** 任务卡标题：只要首行，且不许长到把面板撑坏。 */
function oneLineLabel(value: string | undefined): string | undefined {
  const firstLine = value?.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.length > CARD_LABEL_MAX_LENGTH
    ? `${firstLine.slice(0, CARD_LABEL_MAX_LENGTH)}…`
    : firstLine;
}

/** 起后台任务的两个工具。文档写 run_terminal_command，受管工具清单里叫 run_terminal_cmd，两个都认。 */
const BACKGROUND_TOOL_PATTERN = /^(run_terminal_cmd|run_terminal_command)$/i;
const MONITOR_TOOL_PATTERN = /^monitor$/i;
/** 取输出与终止：这两个工具的参数里带着 task_id，是把后续输出接回卡片的唯一线索。 */
const TASK_OUTPUT_TOOL_PATTERN = /^(get_command_or_subagent_output|get_task_output)$/i;
const TASK_KILL_TOOL_PATTERN = /^(kill_command_or_subagent|kill_task)$/i;

/** task_id 只用于回填卡片，宽松一点无所谓，但不能宽到把整句话当 id。 */
const TASK_ID_SHAPE = "[A-Za-z0-9][A-Za-z0-9_-]{2,63}";

/**
 * 从后台任务的返回里抠 task_id。
 *
 * 结构化字段优先。文本兜底的几种写法来自 grok.exe 里的模板字符串
 * （`Background task {id} started`、`task_ids=["{id}"]`），本地没有源码可对照，
 * 所以这里只做尽力而为：抠不到就只是终止按钮点不了，不影响别的。
 */
function taskIdFromResult(raw: unknown, text: string): string | undefined {
  if (isRecord(raw)) {
    const direct = stringValue(raw.task_id) ?? stringValue(raw.taskId);
    if (direct) return direct;
  }
  const patterns = [
    new RegExp(`[Bb]ackground task\\s+"?(${TASK_ID_SHAPE})"?\\s+started`),
    new RegExp(`"?task_ids?"?\\s*[:=]\\s*\\[?\\s*"(${TASK_ID_SHAPE})"`),
    new RegExp(`"?task_ids?"?\\s*[:=]\\s*"?(${TASK_ID_SHAPE})"?`),
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched?.[1]) return matched[1];
  }
  return undefined;
}

function taskIdsFromRawInput(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const single = stringValue(raw.task_id) ?? stringValue(raw.taskId);
  if (single) return [single];
  const list = Array.isArray(raw.task_ids) ? raw.task_ids : Array.isArray(raw.taskIds) ? raw.taskIds : [];
  return list.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** 后台任务的退出码：结构化字段优先，否则读 `with exit code: N` 这类文本。 */
function taskExitCode(raw: unknown, text: string): number | undefined {
  const structured = exitCodeFromRaw(raw);
  if (structured !== undefined) return structured;
  // 输出是累积的，最后一次轮询报的那个退出码才是当前的。
  let latest: string | undefined;
  for (const match of text.matchAll(/exit\s*code[:=\s]+(-?\d+)/gi)) latest = match[1];
  if (latest === undefined) return undefined;
  const parsed = Number.parseInt(latest, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 是否已经明确「跑完了」。
 *
 * 不能简单地「出现 still running 就不算跑完」：输出是累积的，
 * 上一次轮询留下的那句 still running 会一直挂在前面，把后面的完成标记否掉。
 * 所以比的是两类标记谁出现得更靠后。
 */
function looksExited(text: string): boolean {
  const exited = Math.max(
    lastIndexOfPattern(text, /exit\s*code/gi),
    lastIndexOfPattern(text, /Task completed/gi),
    lastIndexOfPattern(text, /completed in/gi),
  );
  if (exited < 0) return false;
  return exited > lastIndexOfPattern(text, /still running/gi);
}

function lastIndexOfPattern(text: string, pattern: RegExp): number {
  let last = -1;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined) last = match.index;
  }
  return last;
}

/** 子 Agent 汇总可以很长，任务卡只放得下开头。完整内容仍在时间线的工具输出里。 */
const SUBAGENT_SUMMARY_MAX_LENGTH = 400;

function subagentSummary(output: string): string | undefined {
  const compact = output.trim();
  if (!compact) return undefined;
  return compact.length > SUBAGENT_SUMMARY_MAX_LENGTH
    ? `${compact.slice(0, SUBAGENT_SUMMARY_MAX_LENGTH)}…`
    : compact;
}

interface SubagentSpawn {
  description: string;
  subagentType?: string;
  background: boolean;
}

function spawnFromRawInput(raw: unknown): SubagentSpawn {
  const record = isRecord(raw) ? raw : {};
  const description = oneLineLabel(
    stringValue(record.description) ?? stringValue(record.prompt),
  ) ?? "子任务";
  const subagentType = stringValue(record.subagent_type) ?? stringValue(record.subagentType);
  return {
    description,
    ...(subagentType ? { subagentType } : {}),
    background: record.background === true,
  };
}

interface StreamingTool {
  id: string;
  name: string;
  args: string;
  target?: string;
  /** subagent_started 只发一次；参数流后面还有成千上万条分片。 */
  subagentAnnounced?: boolean;
}

function outputFromRaw(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.output_for_prompt === "string") return raw.output_for_prompt;
  if (Array.isArray(raw.output) && raw.output.every((item) => typeof item === "number")) {
    return Buffer.from(raw.output).toString("utf8");
  }
  return undefined;
}

/**
 * incrementalBashOutput 模式下 rawOutput.output_delta 的三态：
 * undefined = 这帧不是增量帧；null = 空数组，即「清空缓冲重来」的重置信号；
 * string = 新增的这一段（字节数组按 UTF-8 解码）。
 */
function outputDeltaFromRaw(raw: unknown): string | null | undefined {
  if (!isRecord(raw)) return undefined;
  const value = raw.output_delta;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) return undefined;
  if (value.length === 0) return null;
  return Buffer.from(value).toString("utf8");
}

/** 没有增量通道时的兜底：拿全量文本对上次的缓冲做前缀比对，猜出新增段。 */
function cumulativeDelta(prior: ToolState, raw: unknown, content: unknown[]): string {
  const cumulative = outputFromRaw(raw)
    ?? content.filter(isRecord).map((item) => stringValue(item.text) ?? "").join("");
  if (!cumulative) return "";
  const delta = cumulative.startsWith(prior.commandOutput)
    ? cumulative.slice(prior.commandOutput.length)
    : cumulative;
  prior.commandOutput = cumulative;
  return delta;
}

function exitCodeFromRaw(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  for (const key of ["exit_code", "exitCode", "status_code", "code"]) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

const ENTRY_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
  failed: "未成功",
  cancelled: "已取消",
};

function entryStatusLabel(status: string | undefined): string | undefined {
  if (!status) return undefined;
  return ENTRY_STATUS_LABELS[status] ?? status;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 从 Grok usage 对象提取 token_usage 事件字段。 */
function tokenUsageFromRecord(usage: Record<string, unknown>, source: "exact" | "stream"): Extract<AgentEvent, { type: "token_usage" }> {
  const event: Extract<AgentEvent, { type: "token_usage" }> = { type: "token_usage", source };
  const inputTokens = numberField(usage, "inputTokens");
  const outputTokens = numberField(usage, "outputTokens");
  const totalTokens = numberField(usage, "totalTokens");
  const cachedReadTokens = numberField(usage, "cachedReadTokens");
  const reasoningTokens = numberField(usage, "reasoningTokens");
  const modelCalls = numberField(usage, "modelCalls");
  if (inputTokens !== undefined) event.inputTokens = inputTokens;
  if (outputTokens !== undefined) event.outputTokens = outputTokens;
  if (totalTokens !== undefined) event.totalTokens = totalTokens;
  if (cachedReadTokens !== undefined) event.cachedReadTokens = cachedReadTokens;
  if (reasoningTokens !== undefined) event.reasoningTokens = reasoningTokens;
  if (modelCalls !== undefined) event.modelCalls = modelCalls;
  return event;
}

const KNOWN_ENTRY_STATUSES = new Set(["pending", "in_progress", "completed", "failed", "cancelled"]);

/** 只认识声明过的状态值；陌生值宁可不带，也不让 UI 拿到无法归类的枚举。 */
function entryStatus(status: string | undefined): AgentPlanStep["status"] {
  if (status && KNOWN_ENTRY_STATUSES.has(status)) return status as AgentPlanStep["status"];
  return undefined;
}

/** Grok 的 plan 更新是待办条目列表，这里归一为与审批计划相同的结构。 */
function planFromEntries(entries: unknown[]): AgentPlan | undefined {
  const steps = entries
    .filter(isRecord)
    .map((entry, index): AgentPlanStep => {
      const rawStatus = stringValue(entry.status);
      const status = entryStatus(rawStatus);
      const label = entryStatusLabel(rawStatus);
      return {
        index: index + 1,
        title: stringValue(entry.content) ?? "",
        // detail 里的中文状态保留：旧版会话回放与计划文档视图仍靠它显示。
        ...(label ? { detail: `状态：${label}` } : {}),
        files: [],
        // 结构化状态才是勾选的依据，文字 detail 只是展示兜底。
        ...(status ? { status } : {}),
      };
    })
    .filter((step) => step.title.length > 0);
  if (steps.length === 0) return undefined;
  return {
    title: "任务进度",
    steps,
    files: [],
    risks: [],
    raw: steps.map((step) => `${step.index}. ${step.title}`).join("\n"),
    empty: false,
  };
}

export { parsePlan };

export class EventNormalizer {
  private readonly tools = new Map<string, ToolState>();
  /** 按 tool_index 记住正在流式生成参数的工具；后续只有 arguments_delta 的分片靠它找回 id/name。 */
  private readonly streamingByIndex = new Map<number, StreamingTool>();
  /**
   * 后台子 Agent 的 task_id → 当初派发它的 toolCallId。
   *
   * 不随轮次清理：后台子 Agent 会跨轮活着，下一轮才去取它的结果。
   */
  private readonly subagentByTaskId = new Map<string, string>();

  reset(): void {
    this.tools.clear();
    this.streamingByIndex.clear();
    this.subagentByTaskId.clear();
  }

  normalize(params: SessionUpdateParams): AgentEvent[] {
    const update = params.update;
    const kind = stringValue(update.sessionUpdate) ?? "unknown";
    const events: AgentEvent[] = [];

    // 流式 totalTokens 来自 params._meta，由上层去抖；每条 update 都可 emit。
    const meta = isRecord(params._meta) ? params._meta : undefined;
    if (meta) {
      const totalTokens = numberField(meta, "totalTokens");
      if (totalTokens !== undefined) {
        events.push({ type: "token_usage", source: "stream", totalTokens });
      }
    }

    if (kind === "tool_call_delta_chunk") {
      events.push(...this.normalizeToolCallDelta(update));
      return events;
    }

    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
      const content = isRecord(update.content) ? update.content : {};
      const text = stringValue(content.text);
      if (text && kind === "agent_message_chunk") events.push({ type: "text_delta", text });
      if (text && kind === "agent_thought_chunk") events.push({ type: "thought_delta", text });
      return events;
    }

    if (kind === "tool_call") {
      const id = stringValue(update.toolCallId) ?? "unknown-tool";
      const name = toolName(update);
      const xai = xaiTool(update);
      const spawnsSubagent = isSpawnSubagentTool(name);
      const background = backgroundFromRawInput(name, update.rawInput);
      const probeTaskIds = TASK_OUTPUT_TOOL_PATTERN.test(name)
        ? taskIdsFromRawInput(update.rawInput)
        : [];
      const killTaskId = TASK_KILL_TOOL_PATTERN.test(name)
        ? taskIdsFromRawInput(update.rawInput)[0]
        : undefined;
      this.tools.set(id, {
        name,
        commandOutput: "",
        ...(spawnsSubagent ? { spawnsSubagent } : {}),
        ...(background ? { background } : {}),
        ...(probeTaskIds.length > 0 ? { probeTaskIds } : {}),
        ...(killTaskId ? { killTaskId } : {}),
      });
      // 参数流阶段可能已经用同一个 id 发过 tool_started；正式到达时补全 label/target。
      const locations = Array.isArray(update.locations) ? update.locations : [];
      const first = locations.find(isRecord);
      const target = (first ? stringValue(first.path) : undefined) ?? pathFromRawInput(update.rawInput);
      events.push({
        type: "tool_started",
        toolCallId: id,
        name,
        kind: toDisplayKind(stringValue(xai.kind) ?? stringValue(update.kind), name),
        label: stringValue(xai.label) ?? stringValue(update.title) ?? name,
        readOnly: xai.read_only === true,
        ...(target ? { target } : {}),
      });
      if (spawnsSubagent) {
        // 参数流阶段可能已经发过一条（只有 description）；这里带着完整 rawInput 再发一次，
        // 消费方按 toolCallId 覆盖即可拿到 subagent_type 与 background。
        events.push({ type: "subagent_started", toolCallId: id, ...spawnFromRawInput(update.rawInput) });
      }
      if (background) {
        // 卡片先立起来。task_id 得等命令返回，那时再补一帧 registered。
        events.push({ type: "background_task", frame: { phase: "started", toolCallId: id, ...background } });
      }
      // 编辑类调用有时在第一条 tool_call 里就带上了 diff（此时磁盘还没落笔），
      // 这正是把预览摆到用户眼前的最佳时机。
      const state = this.tools.get(id);
      if (state) {
        const content = Array.isArray(update.content) ? update.content : [];
        events.push(...this.diffEvents(id, state, content, !isSettledStatus(stringValue(update.status))));
      }
      return events;
    }

    if (kind === "tool_call_update") {
      const id = stringValue(update.toolCallId) ?? "unknown-tool";
      const prior = this.tools.get(id) ?? { name: toolName(update), commandOutput: "" };
      this.tools.set(id, prior);
      const content = Array.isArray(update.content) ? update.content : [];
      const pending = !isSettledStatus(stringValue(update.status));
      events.push(...this.diffEvents(id, prior, content, pending));
      // 声明了 x.ai/incrementalBashOutput 后，流式帧的 rawOutput.output_delta 直接就是
      // 新增字节（空数组 = 清空缓冲的重置信号），不用再拿全量文本做前缀比对猜增量。
      const incremental = outputDeltaFromRaw(update.rawOutput);
      let delta = "";
      if (incremental !== undefined) {
        prior.sawOutputDelta = true;
        if (incremental === null) {
          prior.commandOutput = "";
        } else {
          prior.commandOutput += incremental;
          delta = incremental;
        }
      } else if (!prior.sawOutputDelta) {
        delta = cumulativeDelta(prior, update.rawOutput, content);
      }
      if (delta) {
        events.push({ type: "command_output", toolCallId: id, text: delta });
        // 取输出工具的返回就是那个后台任务的输出，接回对应卡片。
        // 一次调用可以列多个 task_id，但输出是一整段合在一起的，无法可靠拆分，
        // 所以只接回第一个；其余任务的状态等它们各自被取时再更新。
        const probeTarget = prior.probeTaskIds?.[0];
        if (probeTarget && delta) {
          events.push({ type: "background_task", frame: { phase: "output", taskId: probeTarget, text: delta } });
          // 这个 task_id 属于某个子 Agent 时，同一段输出也是它交回的报告。
          // 不接的话这段文字只在时间线里一闪而过，任务卡上永远是空的——
          // 用户问「最后那个子 Agent 返回了啥」就是因为这里断了。
          // 只在这次调用只盯一个任务时接：多个任务的输出合成一整段，拆不开就不猜。
          const soleTarget = prior.probeTaskIds?.length === 1 ? probeTarget : undefined;
          const owner = soleTarget ? this.subagentByTaskId.get(soleTarget) : undefined;
          if (owner) events.push({ type: "subagent_output", toolCallId: owner, text: delta });
        }
      }
      if (prior.background && !prior.backgroundTaskId) {
        const taskId = taskIdFromResult(update.rawOutput, prior.commandOutput);
        if (taskId) {
          prior.backgroundTaskId = taskId;
          events.push({ type: "background_task", frame: { phase: "registered", toolCallId: id, taskId } });
        }
      }
      // 后台派发的子 Agent 立刻返回一个 task_id，之后靠它取结果。
      // 记下 task_id → 派发调用的对应关系，取到结果时才知道该回填哪张卡。
      if (prior.spawnsSubagent && !prior.subagentTaskId) {
        const taskId = taskIdFromResult(update.rawOutput, prior.commandOutput);
        if (taskId) {
          prior.subagentTaskId = taskId;
          this.subagentByTaskId.set(taskId, id);
        }
      }
      // 后台任务跑完的信号只会出现在「取输出」的返回里：
      // 起任务那次调用是立刻返回 task_id 的，它 completed 不代表任务结束。
      const probeTarget = prior.probeTaskIds?.[0];
      if (probeTarget && looksExited(prior.commandOutput)) {
        const exitCode = taskExitCode(update.rawOutput, prior.commandOutput);
        events.push({
          type: "background_task",
          frame: {
            phase: "exited",
            taskId: probeTarget,
            success: exitCode === undefined ? true : exitCode === 0,
            ...(exitCode === undefined ? {} : { exitCode }),
          },
        });
        // 只报一次，后续同一调用的分片不再重复 settle。
        delete prior.probeTaskIds;
      }
      const status = stringValue(update.status);
      if (status === "completed" || status === "failed") {
        const exitCode = exitCodeFromRaw(update.rawOutput);
        events.push({
          type: "tool_completed",
          toolCallId: id,
          name: prior.name,
          success: status === "completed",
          ...(exitCode === undefined ? {} : { exitCode }),
        });
        if (prior.spawnsSubagent) {
          // 阻塞式派发的返回值就是子 Agent 的汇总，直接回填到任务卡上。
          const summary = subagentSummary(prior.commandOutput);
          events.push({
            type: "subagent_completed",
            toolCallId: id,
            success: status === "completed",
            ...(summary ? { summary } : {}),
          });
        }
        if (prior.killTaskId && status === "completed") {
          events.push({ type: "background_task", frame: { phase: "killed", taskId: prior.killTaskId } });
        }
      }
      return events;
    }

    if (kind === "plan") {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const plan = planFromEntries(entries);
      if (plan) events.push({ type: "plan_updated", plan });
      return events;
    }

    if (kind === "current_mode_update") {
      const mode = stringValue(update.currentModeId) ?? stringValue(update.modeId);
      if (mode) {
        events.push({ type: "status", message: `Grok 模式已切换为 ${mode}` });
        events.push({ type: "mode_changed", mode, source: "server" });
      }
      return events;
    }

    if (kind === "session_info_update") {
      const title = stringValue(update.title);
      if (title) events.push({ type: "status", message: `会话：${title}` });
    }
    return events;
  }

  /**
   * 把 content 里的 `diff` 项转成 file_diff + file_changed。
   *
   * 去重按「文件 → 上一次的 newText」：同一次调用的后续 update 会把同一份 diff 再带一遍，
   * 原样透传会让宿主每条 update 都重开一次预览编辑器。内容真变了才再发一次。
   */
  private diffEvents(
    toolCallId: string,
    state: ToolState,
    content: readonly unknown[],
    pending: boolean,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type !== "diff" || typeof item.path !== "string") continue;
      const oldText = stringValue(item.oldText) ?? "";
      const newText = stringValue(item.newText) ?? "";
      const emitted = state.emittedDiffs ??= new Map<string, string>();
      if (emitted.get(item.path) === newText) continue;
      emitted.set(item.path, newText);
      const change = oldText === "" ? "create" : newText === "" ? "delete" : "modify";
      events.push({
        type: "file_diff",
        toolCallId,
        path: item.path,
        change,
        oldText,
        newText,
        pending,
      });
      events.push({ type: "file_changed", path: item.path, change });
    }
    return events;
  }

  /**
   * 工具参数流：第一条通常带 name + tool_call_id，后续只有 arguments_delta。
   * 在正式 tool_call 到达前就发出 tool_started，时间线才能立刻显示「正在修改代码」。
   * path 一旦能从参数片段里解析出来，就挂到 tool_progress.target，状态栏可显示具体文件。
   */
  private normalizeToolCallDelta(update: Record<string, unknown>): AgentEvent[] {
    const index = typeof update.tool_index === "number" ? update.tool_index
      : typeof update.toolIndex === "number" ? update.toolIndex
        : 0;
    const name = stringValue(update.name);
    const id = stringValue(update.tool_call_id) ?? stringValue(update.toolCallId);
    const delta = stringValue(update.arguments_delta) ?? stringValue(update.argumentsDelta) ?? "";

    if (name) {
      const toolCallId = id ?? `streaming-${index}`;
      const prior = this.streamingByIndex.get(index);
      const args = (prior?.args ?? "") + delta;
      const target = prior?.target ?? pathFromPartialArgs(args);
      this.streamingByIndex.set(index, {
        id: toolCallId,
        name,
        args,
        ...(target ? { target } : {}),
        // 后续分片若又带上 name，别把「已建卡」这件事忘掉，否则会重复建卡。
        ...(prior?.subagentAnnounced ? { subagentAnnounced: true } : {}),
      });
      if (!this.tools.has(toolCallId)) {
        this.tools.set(toolCallId, { name, commandOutput: "" });
      }
      const kind = toDisplayKind(undefined, name);
      const events: AgentEvent[] = [{
        type: "tool_started",
        toolCallId,
        name,
        kind,
        label: name,
        readOnly: kind === "read" || kind === "search",
        ...(target ? { target } : {}),
      }];
      events.push(...this.announceStreamingSpawn(index, name));
      return events;
    }

    const prior = this.streamingByIndex.get(index);
    const toolCallId = id ?? prior?.id ?? `streaming-${index}`;
    if (prior && delta) {
      prior.args += delta;
      if (!prior.target) {
        const target = pathFromPartialArgs(prior.args);
        if (target) prior.target = target;
      }
    } else if (!prior && delta) {
      const target = pathFromPartialArgs(delta);
      this.streamingByIndex.set(index, {
        id: toolCallId,
        name: "tool",
        args: delta,
        ...(target ? { target } : {}),
      });
    }

    const known = this.streamingByIndex.get(index);
    const events: AgentEvent[] = [{
      type: "tool_progress",
      toolCallId,
      ...(known?.name && known.name !== "tool" ? { name: known.name } : prior?.name ? { name: prior.name } : {}),
      ...(known?.target ? { target: known.target } : {}),
    }];
    if (known?.name) events.push(...this.announceStreamingSpawn(index, known.name));
    return events;
  }

  /**
   * 派发子 Agent 时，prompt 往往有好几百字，等参数流写完才建卡片就晚了。
   * 一旦从半截 JSON 里读出 description 就先把卡片立起来，正式 tool_call 到达时再补全。
   */
  private announceStreamingSpawn(index: number, name: string): AgentEvent[] {
    if (!isSpawnSubagentTool(name)) return [];
    const streaming = this.streamingByIndex.get(index);
    if (!streaming || streaming.subagentAnnounced) return [];
    const description = oneLineLabel(stringFromPartialArgs(streaming.args, SUBAGENT_LABEL_KEYS));
    if (!description) return [];
    streaming.subagentAnnounced = true;
    return [{
      type: "subagent_started",
      toolCallId: streaming.id,
      description,
      // background 与 subagent_type 通常排在 prompt 之后，等正式 tool_call 补。
      background: false,
    }];
  }

  /** 处理 `_x.ai/session/update` 的 params（含 turn_completed 与 usage）。 */
  normalizeExtensionUpdate(params: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    const update = isRecord(params.update) ? params.update : {};
    const kind = stringValue(update.sessionUpdate);

    if (kind === "turn_completed") {
      const usage = isRecord(update.usage) ? update.usage : undefined;
      if (usage) events.push(tokenUsageFromRecord(usage, "exact"));
    }

    if (kind === "context_compacted") {
      const trigger = update.trigger === "manual" ? "manual" : "auto";
      const detail = stringValue(update.detail);
      events.push({
        type: "context_compacted",
        trigger,
        ...(detail ? { detail } : {}),
      });
    }

    return events;
  }
}
