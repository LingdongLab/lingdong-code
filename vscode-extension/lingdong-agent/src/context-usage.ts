/**
 * 上下文用量数据层。
 * 只有 Grok 通过 ACP 明确回报 usage 时才算精确值；其余情况一律标为估算，
 * 绝不把字符数直接当成精确 Token 展示。界面留到阶段 G，本阶段只产出数据与事件。
 */

export type ContextUsageSource = "exact" | "estimated" | "unavailable";
export type ContextUsageLevel = "normal" | "warning" | "critical" | "full";

export interface ContextUsageRecord {
  usedTokens: number;
  contextLimit?: number;
  /** 0-100，保留一位小数；没有 contextLimit 时为 undefined。 */
  percentage?: number;
  source: ContextUsageSource;
  updatedAt: number;
  inputTokens?: number;
  outputTokens?: number;
  compactedAt?: number;
}

/** 估算时分项记录，方便报告里说明「约」是怎么算出来的。 */
export interface UsageBreakdown {
  systemRules: number;
  history: number;
  fileContext: number;
  toolOutput: number;
  plan: number;
  currentTask: number;
}

export type CompactionCapability = "available" | "unavailable" | "unknown";

export type ContextUsageEvent =
  | { type: "context_usage_updated"; usage: ContextUsageRecord; level: ContextUsageLevel }
  | { type: "context_compaction_started"; trigger: "auto" | "manual" }
  | { type: "context_compaction_completed"; trigger: "auto" | "manual"; usage: ContextUsageRecord }
  | { type: "context_compaction_failed"; trigger: "auto" | "manual"; reason: string };

export const USAGE_THRESHOLDS = { warning: 70, critical: 85, full: 95 } as const;

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** 粗略估算：中日韩字符按 1 Token，其余按 4 字符 1 Token。只用于 estimated 分支。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (CJK.test(character)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function usageLevel(percentage: number | undefined): ContextUsageLevel {
  if (percentage === undefined) return "normal";
  if (percentage >= USAGE_THRESHOLDS.full) return "full";
  if (percentage >= USAGE_THRESHOLDS.critical) return "critical";
  if (percentage >= USAGE_THRESHOLDS.warning) return "warning";
  return "normal";
}

function percentageOf(usedTokens: number, contextLimit: number | undefined): number | undefined {
  if (contextLimit === undefined || contextLimit <= 0) return undefined;
  return Math.round((usedTokens / contextLimit) * 1000) / 10;
}

export interface ExactUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
}

export interface ContextUsageOptions {
  contextLimit?: number;
  now?: () => number;
  emit?: (event: ContextUsageEvent) => void;
}

export class ContextUsageService {
  private readonly now: () => number;
  private readonly emit: (event: ContextUsageEvent) => void;
  private contextLimitValue: number | undefined;
  private usage: ContextUsageRecord;
  private breakdown: UsageBreakdown | undefined;
  private capability: CompactionCapability = "unknown";

  constructor(options: ContextUsageOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.emit = options.emit ?? (() => undefined);
    this.contextLimitValue = options.contextLimit;
    this.usage = {
      usedTokens: 0,
      source: "unavailable",
      updatedAt: this.now(),
      ...(this.contextLimitValue === undefined ? {} : { contextLimit: this.contextLimitValue }),
    };
  }

  get current(): ContextUsageRecord {
    return { ...this.usage };
  }

  get level(): ContextUsageLevel {
    return usageLevel(this.usage.percentage);
  }

  get lastBreakdown(): UsageBreakdown | undefined {
    return this.breakdown ? { ...this.breakdown } : undefined;
  }

  get compactionCapability(): CompactionCapability {
    return this.capability;
  }

  setCompactionCapability(capability: CompactionCapability): void {
    this.capability = capability;
  }

  /** Grok 明确回报的用量，唯一可以标成 exact 的来源。 */
  recordExact(input: ExactUsageInput): ContextUsageRecord {
    const inputTokens = Math.max(0, Math.round(input.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.round(input.outputTokens ?? 0));
    const total = input.totalTokens !== undefined && input.totalTokens > 0
      ? Math.round(input.totalTokens)
      : inputTokens + outputTokens;
    this.breakdown = undefined;
    return this.apply({
      usedTokens: total,
      source: "exact",
      updatedAt: this.now(),
      inputTokens,
      outputTokens,
      ...(this.usage.compactedAt === undefined ? {} : { compactedAt: this.usage.compactedAt }),
    });
  }

  /**
   * 流式 `_meta.totalTokens`（ACP 每条 update 可能都带）。
   * 标为 estimated；数值没变则跳过，避免刷屏。
   * 已有更大的 exact 时不降级。
   */
  recordStream(totalTokens: number): ContextUsageRecord {
    const used = Math.max(0, Math.round(totalTokens));
    if (used <= 0) return this.current;
    if (this.usage.source === "exact" && used <= this.usage.usedTokens) return this.current;
    if (
      (this.usage.source === "estimated" || this.usage.source === "exact")
      && used === this.usage.usedTokens
    ) {
      return this.current;
    }
    this.breakdown = undefined;
    return this.apply({
      usedTokens: used,
      // 流式过程中若已有 exact，数值升高仍保留 exact（会话累计更可信）。
      source: this.usage.source === "exact" ? "exact" : "estimated",
      updatedAt: this.now(),
      ...(this.usage.compactedAt === undefined ? {} : { compactedAt: this.usage.compactedAt }),
    });
  }

  setContextLimit(limit: number | undefined): void {
    const next = limit !== undefined && limit > 0 ? limit : undefined;
    if (next === this.contextLimitValue) {
      // 限额没变时也要在百分比缺席时补算一次（例如 restore 后只改了 used）。
      if (this.usage.contextLimit === next) return;
    }
    this.contextLimitValue = next;
    this.apply({ ...this.usage, source: this.usage.source });
  }

  /** 没有 usage 回报时的估算，percentage 一律按「约」对待。 */
  recordEstimate(parts: Partial<UsageBreakdown>): ContextUsageRecord {
    const breakdown: UsageBreakdown = {
      systemRules: parts.systemRules ?? 0,
      history: parts.history ?? 0,
      fileContext: parts.fileContext ?? 0,
      toolOutput: parts.toolOutput ?? 0,
      plan: parts.plan ?? 0,
      currentTask: parts.currentTask ?? 0,
    };
    this.breakdown = breakdown;
    const usedTokens = Object.values(breakdown).reduce((total, value) => total + Math.max(0, Math.round(value)), 0);
    // 已经拿到过精确值时不要用估算把它盖掉，除非估算明显更大（说明又追加了很多内容）。
    if (this.usage.source === "exact" && usedTokens <= this.usage.usedTokens) return this.current;
    return this.apply({
      usedTokens,
      source: "estimated",
      updatedAt: this.now(),
      ...(this.usage.compactedAt === undefined ? {} : { compactedAt: this.usage.compactedAt }),
    });
  }

  compactionStarted(trigger: "auto" | "manual"): void {
    this.emit({ type: "context_compaction_started", trigger });
  }

  compactionCompleted(trigger: "auto" | "manual", usage?: ExactUsageInput): void {
    const compactedAt = this.now();
    const next = usage ? this.recordExact(usage) : this.current;
    this.usage = { ...next, compactedAt };
    this.emit({ type: "context_compaction_completed", trigger, usage: this.current });
  }

  compactionFailed(trigger: "auto" | "manual", reason: string): void {
    this.emit({ type: "context_compaction_failed", trigger, reason });
  }

  /** 切换会话：清空当前数据，等新会话自己上报。 */
  reset(): void {
    this.breakdown = undefined;
    this.usage = {
      usedTokens: 0,
      source: "unavailable",
      updatedAt: this.now(),
      ...(this.contextLimitValue === undefined ? {} : { contextLimit: this.contextLimitValue }),
    };
  }

  /** 从会话记录恢复上次的用量；恢复的值不改变来源标记。 */
  restore(record: ContextUsageRecord | undefined): void {
    if (!record) {
      this.reset();
      return;
    }
    this.breakdown = undefined;
    if (record.contextLimit !== undefined && record.contextLimit > 0) this.contextLimitValue = record.contextLimit;
    const percentage = percentageOf(record.usedTokens, this.contextLimitValue);
    this.usage = {
      ...record,
      ...(this.contextLimitValue === undefined ? {} : { contextLimit: this.contextLimitValue }),
      ...(percentage === undefined ? {} : { percentage }),
    };
    if (percentage === undefined) delete this.usage.percentage;
  }

  private apply(next: ContextUsageRecord): ContextUsageRecord {
    const percentage = percentageOf(next.usedTokens, this.contextLimitValue);
    this.usage = {
      ...next,
      ...(this.contextLimitValue === undefined ? {} : { contextLimit: this.contextLimitValue }),
      ...(percentage === undefined ? {} : { percentage }),
    };
    if (percentage === undefined) delete this.usage.percentage;
    this.emit({ type: "context_usage_updated", usage: this.current, level: this.level });
    return this.current;
  }
}
