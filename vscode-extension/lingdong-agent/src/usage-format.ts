import type { ContextUsageLevel, ContextUsageRecord, ContextUsageSource } from "./context-usage";
import { formatContextWindow } from "./model-registry";

/** 把用量记录格式化为底栏/面板文案；绝不把字符数伪装成精确 Token。 */
export function formatUsageLabel(usage: ContextUsageRecord): string {
  const percent = formatUsagePercentLine(usage);
  if (!percent) return "";
  const tokens = formatUsageTokensLine(usage);
  return tokens ? `${percent} · ${tokens}` : percent;
}

/** Cursor 式第一行：`12% context used` */
export function formatUsagePercentLine(usage: ContextUsageRecord): string {
  if (usage.source === "unavailable") return "";
  if (usage.usedTokens <= 0 && usage.source !== "exact") return "";
  const pct = resolvePercentage(usage);
  if (pct === undefined) return "";
  return `${Math.round(pct)}% context used`;
}

/** Cursor 式第二行：`30.3K / 256K tokens` */
export function formatUsageTokensLine(usage: ContextUsageRecord): string {
  if (usage.source === "unavailable") return "";
  if (usage.usedTokens <= 0 && usage.source !== "exact") return "";
  const used = formatContextWindow(usage.usedTokens);
  if (usage.contextLimit !== undefined && usage.contextLimit > 0) {
    return `${used} / ${formatContextWindow(usage.contextLimit)} tokens`;
  }
  return `${used} tokens`;
}

function resolvePercentage(usage: ContextUsageRecord): number | undefined {
  if (typeof usage.percentage === "number" && Number.isFinite(usage.percentage)) {
    return usage.percentage;
  }
  if (usage.contextLimit && usage.contextLimit > 0 && usage.usedTokens > 0) {
    return (usage.usedTokens / usage.contextLimit) * 100;
  }
  return undefined;
}

export function formatUsageSource(source: ContextUsageSource): string {
  switch (source) {
    case "exact":
      return "精确";
    case "estimated":
      return "估算";
    default:
      return "暂不可用";
  }
}

export function usageLevelLabel(level: ContextUsageLevel): string {
  switch (level) {
    case "warning":
      return "提醒";
    case "critical":
      return "即将压缩";
    case "full":
      return "严重";
    default:
      return "正常";
  }
}

export function composerStatusLine(input: {
  mode: string;
  model: string;
  usage: ContextUsageRecord;
}): string {
  const pct = formatUsagePercentLine(input.usage);
  return pct
    ? `${input.mode} · ${input.model} · ${pct}`
    : `${input.mode} · ${input.model}`;
}
