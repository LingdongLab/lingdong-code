import { redactText as redactRuntimeText } from "@lingdong/agent-runtime";
import type { AskQuestionItemView, HostToWebviewMessage, UiAgentMode, UiRiskLevel, UiToolKind } from "../messages";
import type { PlanCardView, PlanStatus } from "../plan-view-model";
import { redact as redactHostText } from "../privacy/secret-redactor";
import {
  interruptPresentation,
  parseTurnPresentation,
  serializeTurnPresentation,
} from "../presentation/presentation-serializer";
import type { TurnPresentation } from "../presentation/turn-presentation";
import { JsonStore, type LoadStatus } from "./json-store";

/**
 * 对话记录。只保存重新打开面板后需要还原的内容，并且全部先脱敏再落盘：
 * 不存 API Key、环境变量、凭据、Grok 原始协议帧或 Webview HTML。
 * 变更列表不进这里——重启后要按磁盘哈希重新判定，存下来的旧状态会骗人。
 */

/** 单条工具输出摘要上限。 */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;
/** 单条 Agent 回复上限，超长只留开头。 */
export const MAX_MESSAGE_CHARS = 40_000;
/** 单个会话保留的条目数上限，超出丢最旧的。 */
export const MAX_TRANSCRIPT_ENTRIES = 2_000;

export const TRUNCATED_SUFFIX = "\n……（内容已截断）";
export const EXPIRED_PERMISSION_TEXT = "该权限请求已因扩展重启而失效。";
export const TRIMMED_HISTORY_TEXT = "更早的历史记录已省略。";

/**
 * 落盘前的脱敏。
 *
 * 串两层：Runtime 侧那层认得 ACP 日志里的形态，宿主侧那层还额外整串替换
 * 当前已配置的 Provider 凭据字面量——凭据搬进 SecretStorage 后，
 * 单靠形态匹配已经认不出用户自建网关的 Key。
 */
function redactText(text: string): string {
  return redactHostText(redactRuntimeText(text));
}

export type PersistedPermissionDecision =
  | "pending"
  | "allow_once"
  | "allow_session"
  | "allow_always"
  | "reject"
  | "expired"
  | "cancelled";

export type TranscriptEntry =
  | { kind: "user"; at: number; text: string; contextLabels?: string[] }
  | { kind: "assistant"; at: number; text: string }
  | { kind: "assistantEnd"; at: number; stopReason: string; modelId?: string }
  | { kind: "activity"; at: number; message: string }
  | { kind: "notice"; at: number; level: "info" | "warn"; message: string }
  | { kind: "error"; at: number; message: string }
  | {
      kind: "tool";
      at: number;
      toolCallId: string;
      toolKind: UiToolKind;
      label: string;
      target?: string;
      readOnly: boolean;
      status: "running" | "completed" | "failed";
      exitCode?: number;
      completedAt?: number;
      output?: string;
    }
  | { kind: "plan"; at: number; plan: PlanCardView; status: PlanStatus; message?: string }
  | {
      kind: "permission";
      at: number;
      requestId: string;
      title: string;
      operation: string;
      target?: string;
      command?: string;
      risk: UiRiskLevel;
      decision: PersistedPermissionDecision;
      message?: string;
    }
  /** 模型提问及其答案。重启后未决提问一律标为失效，旧 requestId 不能再被回答。 */
  | {
      kind: "question";
      at: number;
      requestId: string;
      questions: AskQuestionItemView[];
      outcome: "pending" | "answered" | "cancelled" | "expired";
      answers?: string[];
      message?: string;
    }
  | { kind: "mode"; at: number; mode: UiAgentMode }
  /**
   * 一轮任务的时间线。新会话用它取代逐条 tool 记录，
   * 旧会话里的 tool 条目继续由旧版工具摘要回退渲染。
   */
  | { kind: "timeline"; at: number; turnId: string; presentation: TurnPresentation };

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${TRUNCATED_SUFFIX}`;
}

/** 落盘前统一处理：脱敏 + 长度限制。 */
export function sanitizeEntry(entry: TranscriptEntry): TranscriptEntry {
  switch (entry.kind) {
    case "user":
      return { ...entry, text: truncateText(redactText(entry.text), MAX_MESSAGE_CHARS) };
    case "assistant":
      return { ...entry, text: truncateText(redactText(entry.text), MAX_MESSAGE_CHARS) };
    case "activity":
      return { ...entry, message: redactText(entry.message) };
    case "notice":
      return { ...entry, message: redactText(entry.message) };
    case "error":
      return { ...entry, message: redactText(entry.message) };
    case "tool":
      return {
        ...entry,
        label: redactText(entry.label),
        ...(entry.target ? { target: redactText(entry.target) } : {}),
        ...(entry.output === undefined ? {} : { output: truncateText(redactText(entry.output), MAX_TOOL_OUTPUT_CHARS) }),
      };
    case "permission":
      return {
        ...entry,
        title: redactText(entry.title),
        ...(entry.target ? { target: redactText(entry.target) } : {}),
        ...(entry.command ? { command: redactText(entry.command) } : {}),
        ...(entry.message ? { message: redactText(entry.message) } : {}),
      };
    case "question":
      return {
        ...entry,
        questions: entry.questions.map((item) => ({
          question: redactText(item.question),
          options: item.options.map((option) => ({
            label: redactText(option.label),
            ...(option.preview ? { preview: redactText(option.preview) } : {}),
          })),
          multiSelect: item.multiSelect,
        })),
        ...(entry.answers ? { answers: entry.answers.map((answer) => redactText(answer)) } : {}),
        ...(entry.message ? { message: redactText(entry.message) } : {}),
      };
    case "timeline":
      return {
        ...entry,
        presentation: serializeTurnPresentation(entry.presentation, { redact: redactText }),
      };
    default:
      return entry;
  }
}

const PERMISSION_TEXT: Record<PersistedPermissionDecision, string> = {
  pending: EXPIRED_PERMISSION_TEXT,
  allow_once: "已允许本次",
  allow_session: "已加入本次会话规则",
  allow_always: "已记住，以后不再询问",
  reject: "已拒绝",
  expired: "已超时失效",
  cancelled: "已取消",
};

// pending 只会在同进程内的面板重挂时被回放到（活卡随后会补推）；
// 扩展重启的场景由 expirePendingQuestions 先行改成 expired。
const QUESTION_TEXT: Record<"pending" | "answered" | "cancelled" | "expired", string> = {
  pending: "等待回答",
  answered: "已回答",
  cancelled: "已取消",
  expired: "已因扩展重启而失效",
};

/**
 * 把持久化条目翻译回面板消息。
 * 未决权限一律变成失效提示：旧 requestId 绝不能在重启后继续被允许。
 */
export function toRestoreMessages(entries: readonly TranscriptEntry[]): HostToWebviewMessage[] {
  const messages: HostToWebviewMessage[] = [];
  /** 愈合：ACP 回放曾把同一段助手正文重复落盘，恢复时去重。 */
  let lastAssistantText: string | undefined;
  for (const entry of entries) {
    switch (entry.kind) {
      case "user":
        lastAssistantText = undefined;
        messages.push({ type: "userMessage", text: entry.text });
        if (entry.contextLabels && entry.contextLabels.length > 0) {
          messages.push({
            type: "notice",
            level: "info",
            message: `已附加上下文：${entry.contextLabels.join("、")}`,
          });
        }
        break;
      case "assistant":
        if (entry.text === "") break;
        if (entry.text === lastAssistantText) break;
        lastAssistantText = entry.text;
        messages.push({ type: "assistantDelta", text: entry.text });
        break;
      case "assistantEnd":
        messages.push({
          type: "assistantEnd",
          stopReason: entry.stopReason,
          ...(entry.modelId ? { modelId: entry.modelId } : {}),
        });
        break;
      case "activity":
        messages.push({ type: "activity", message: entry.message });
        break;
      case "notice":
        messages.push({ type: "notice", level: entry.level, message: entry.message });
        break;
      case "error":
        messages.push({ type: "error", message: entry.message });
        break;
      case "tool":
        messages.push({
          type: "toolStarted",
          toolCallId: entry.toolCallId,
          kind: entry.toolKind,
          label: entry.label,
          readOnly: entry.readOnly,
          ...(entry.target ? { target: entry.target } : {}),
        });
        if (entry.output) messages.push({ type: "toolOutput", toolCallId: entry.toolCallId, text: entry.output });
        messages.push({
          type: "toolStatus",
          toolCallId: entry.toolCallId,
          // 重启后不可能还有工具在跑，运行中的一律按失败呈现。
          status: entry.status === "running" ? "failed" : entry.status,
          ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
        });
        break;
      case "plan":
        messages.push({ type: "plan", plan: entry.plan });
        messages.push({
          type: "planStatus",
          status: entry.status,
          ...(entry.message ? { message: entry.message } : {}),
        });
        break;
      case "permission":
        messages.push({
          type: "notice",
          level: entry.decision === "allow_once" || entry.decision === "allow_session" ? "info" : "warn",
          message: `${entry.title}：${entry.message ?? PERMISSION_TEXT[entry.decision]}`,
        });
        break;
      case "question": {
        // 与权限一致：历史提问不还原成可交互卡片，按「问题 → 答案」摘要回放。
        const lines = entry.questions.map((item, index) => {
          const answer = entry.answers?.[index]?.trim();
          return answer ? `${item.question} → ${answer}` : item.question;
        });
        messages.push({
          type: "notice",
          level: "info",
          message: `模型提问（${QUESTION_TEXT[entry.outcome]}）：${lines.join("；")}`,
        });
        break;
      }
      case "mode":
        messages.push({ type: "mode", mode: entry.mode });
        break;
      case "timeline":
        messages.push({ type: "timelineRestore", presentation: entry.presentation });
        break;
    }
  }
  return messages;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENTRY_KINDS = new Set([
  "user",
  "assistant",
  "assistantEnd",
  "activity",
  "notice",
  "error",
  "tool",
  "plan",
  "permission",
  "question",
  "mode",
  "timeline",
]);

function validateEntries(data: unknown): { entries: TranscriptEntry[] } | undefined {
  if (!isRecordObject(data) || !Array.isArray(data.entries)) return undefined;
  const entries: TranscriptEntry[] = [];
  for (const entry of data.entries) {
    if (!isRecordObject(entry) || typeof entry.kind !== "string" || !ENTRY_KINDS.has(entry.kind)) continue;
    if (entry.kind === "timeline") {
      // 时间线结构复杂，逐字段校验；结构不对就整条丢弃，不让坏数据进 UI。
      const presentation = parseTurnPresentation(entry.presentation);
      const turnId = typeof entry.turnId === "string" ? entry.turnId : presentation?.turnId;
      if (!presentation || !turnId || typeof entry.at !== "number") continue;
      entries.push({ kind: "timeline", at: entry.at, turnId, presentation });
      continue;
    }
    entries.push(entry as TranscriptEntry);
  }
  return { entries };
}

export interface TranscriptRepositoryOptions {
  maxEntries?: number;
  onDamage?: (detail: string) => void;
}

export class TranscriptRepository {
  private entriesValue: TranscriptEntry[] = [];
  private readonly maxEntries: number;
  private readonly onDamage: (detail: string) => void;
  private queue: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private file: string,
    private readonly store: JsonStore,
    options: TranscriptRepositoryOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? MAX_TRANSCRIPT_ENTRIES;
    this.onDamage = options.onDamage ?? (() => undefined);
  }

  get entries(): TranscriptEntry[] {
    return [...this.entriesValue];
  }

  get count(): number {
    return this.entriesValue.length;
  }

  /** 切换会话：换文件并读入历史。 */
  async open(file: string): Promise<LoadStatus> {
    await this.flush();
    this.file = file;
    const result = await this.store.read<{ entries: TranscriptEntry[] }>(file, {
      kind: "transcript",
      fallback: () => ({ entries: [] }),
      validate: validateEntries,
    });
    if (result.status !== "ok" && result.status !== "missing") {
      this.onDamage(`对话记录：${result.detail ?? result.status}`);
    }
    this.entriesValue = result.data.entries;
    this.dirty = false;
    return result.status;
  }

  append(entry: TranscriptEntry): TranscriptEntry {
    const sanitized = sanitizeEntry(entry);
    this.entriesValue.push(sanitized);
    if (this.entriesValue.length > this.maxEntries) {
      this.entriesValue = [
        { kind: "notice", at: sanitized.at, level: "info", message: TRIMMED_HISTORY_TEXT },
        ...this.entriesValue.slice(this.entriesValue.length - this.maxEntries + 1),
      ];
    }
    this.dirty = true;
    return sanitized;
  }

  /** 流式回复合并成一条：同一轮的多个 delta 不各存一条。 */
  appendAssistantText(text: string, at: number): void {
    const last = this.entriesValue.at(-1);
    if (last?.kind === "assistant") {
      const merged = truncateText(redactText(`${last.text}${text}`), MAX_MESSAGE_CHARS);
      this.entriesValue[this.entriesValue.length - 1] = { ...last, text: merged };
      this.dirty = true;
      return;
    }
    this.append({ kind: "assistant", at, text });
  }

  updateTool(
    toolCallId: string,
    patch: { status?: "running" | "completed" | "failed"; exitCode?: number; output?: string; completedAt?: number },
  ): void {
    for (let index = this.entriesValue.length - 1; index >= 0; index -= 1) {
      const entry = this.entriesValue[index];
      if (entry?.kind !== "tool" || entry.toolCallId !== toolCallId) continue;
      const output = patch.output === undefined ? entry.output : `${entry.output ?? ""}${patch.output}`;
      this.entriesValue[index] = sanitizeEntry({
        ...entry,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.exitCode === undefined ? {} : { exitCode: patch.exitCode }),
        ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
        ...(output === undefined ? {} : { output }),
      });
      this.dirty = true;
      return;
    }
  }

  updatePermission(requestId: string, decision: PersistedPermissionDecision, message?: string): void {
    for (let index = this.entriesValue.length - 1; index >= 0; index -= 1) {
      const entry = this.entriesValue[index];
      if (entry?.kind !== "permission" || entry.requestId !== requestId) continue;
      this.entriesValue[index] = sanitizeEntry({
        ...entry,
        decision,
        ...(message ? { message } : {}),
      });
      this.dirty = true;
      return;
    }
  }

  updateQuestion(
    requestId: string,
    outcome: "answered" | "cancelled" | "expired",
    answers?: string[],
    message?: string,
  ): void {
    for (let index = this.entriesValue.length - 1; index >= 0; index -= 1) {
      const entry = this.entriesValue[index];
      if (entry?.kind !== "question" || entry.requestId !== requestId) continue;
      this.entriesValue[index] = sanitizeEntry({
        ...entry,
        outcome,
        ...(answers ? { answers } : {}),
        ...(message ? { message } : {}),
      });
      this.dirty = true;
      return;
    }
  }

  /** 重启后把仍是未决状态的权限记录标为失效。 */
  expirePendingPermissions(): number {
    let count = 0;
    this.entriesValue = this.entriesValue.map((entry) => {
      if (entry.kind !== "permission" || entry.decision !== "pending") return entry;
      count += 1;
      return { ...entry, decision: "expired", message: EXPIRED_PERMISSION_TEXT };
    });
    if (count > 0) this.dirty = true;
    return count;
  }

  /** 重启后未决提问同样失效：Grok 侧的 requestId 已随子进程一起消失。 */
  expirePendingQuestions(): number {
    let count = 0;
    this.entriesValue = this.entriesValue.map((entry) => {
      if (entry.kind !== "question" || entry.outcome !== "pending") return entry;
      count += 1;
      return { ...entry, outcome: "expired" as const };
    });
    if (count > 0) this.dirty = true;
    return count;
  }

  /**
   * 扩展重启修复：重启前仍在运行的时间线只能是被打断，不能装成已完成。
   * 与 expirePendingPermissions 并列，在恢复会话时调用一次。
   */
  interruptRunningTimelines(): number {
    let count = 0;
    this.entriesValue = this.entriesValue.map((entry) => {
      if (entry.kind !== "timeline") return entry;
      const interrupted = interruptPresentation(entry.presentation);
      if (!interrupted) return entry;
      count += 1;
      return { ...entry, presentation: interrupted };
    });
    if (count > 0) this.dirty = true;
    return count;
  }

  clear(): void {
    this.entriesValue = [];
    this.dirty = true;
  }

  /** 写入串行执行并合并脏标记，连续追加不会产生一堆并发写。 */
  flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await this.store.write(this.file, "transcript", { entries: this.entriesValue });
    });
    return this.queue;
  }
}
