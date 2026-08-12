import {
  type ActivityGroup,
  type ActivityGroupKind,
  type ActivityGroupStatus,
} from "./activity-group";
import { type ActivityAction, type ActivityItem, type ActivityStatus } from "./activity-item";
import type { LineDiffStat } from "./line-diff";
import { type TurnPresentation, type TurnStatus } from "./turn-presentation";
import type { TurnSummary, VerificationOutcome } from "./turn-summary";

/**
 * 时间线的落盘与恢复。
 *
 * 落盘前必须过一遍脱敏与截断：不写 API Key、不写环境变量、不写未截断的终端全文、
 * 不写工作区外的绝对路径，也不写任何模型私有推理。
 * redact 由调用方注入，保持本层不依赖 Runtime。
 */

/** 单条活动细节的落盘上限，避免把整份命令输出塞进会话文件。 */
export const MAX_DETAIL_CHARS = 400;

const ACTIONS: ReadonlySet<string> = new Set<ActivityAction>([
  "list", "read", "search", "diagnostics",
  "edit", "create", "delete", "rename",
  "run", "test", "typecheck", "lint", "build",
]);
const ACTIVITY_STATUS: ReadonlySet<string> = new Set<ActivityStatus>([
  "running", "completed", "failed", "stopped",
]);
const GROUP_KINDS: ReadonlySet<string> = new Set<ActivityGroupKind>([
  "exploration", "editing", "command", "verification", "warning", "failure",
]);
const TURN_STATUS: ReadonlySet<string> = new Set<TurnStatus>([
  "running", "completed", "failed", "stopped", "interrupted",
]);
const VERIFICATION: ReadonlySet<string> = new Set<VerificationOutcome>([
  "passed", "failed", "partial", "unavailable",
]);

export interface SerializeOptions {
  /** 通常传入 Runtime 的 redactText。 */
  redact?: (text: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 绝对路径与盘符不允许落盘，只保留尾部片段。 */
function safeTarget(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  if (!/^[A-Za-z]:\//.test(normalized) && !normalized.startsWith("/")) return normalized;
  const parts = normalized.replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function clean(text: string, redact: (value: string) => string, limit: number): string {
  const redacted = redact(text);
  return redacted.length > limit ? `${redacted.slice(0, limit)}……` : redacted;
}

function serializeItem(item: ActivityItem, redact: (value: string) => string): ActivityItem {
  return {
    id: item.id,
    toolCallId: item.toolCallId,
    action: item.action,
    ...(item.target ? { target: clean(safeTarget(item.target), redact, MAX_DETAIL_CHARS) } : {}),
    status: item.status,
    startedAt: item.startedAt,
    ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
    ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    ...(item.detail ? { detail: clean(item.detail, redact, MAX_DETAIL_CHARS) } : {}),
    // 行数是纯数字，没有脱敏可言，但要落盘——否则历史会话重开后 +N/-N 全没了。
    ...(item.lines ? { lines: { added: item.lines.added, deleted: item.lines.deleted } } : {}),
  };
}

function serializeGroup(group: ActivityGroup, redact: (value: string) => string): ActivityGroup {
  return {
    id: group.id,
    kind: group.kind,
    title: redact(group.title),
    ...(group.subtitle ? { subtitle: clean(group.subtitle, redact, MAX_DETAIL_CHARS) } : {}),
    status: group.status,
    startedAt: group.startedAt,
    ...(group.completedAt === undefined ? {} : { completedAt: group.completedAt }),
    items: group.items.map((item) => serializeItem(item, redact)),
  };
}

export function serializeTurnPresentation(
  presentation: TurnPresentation,
  options: SerializeOptions = {},
): TurnPresentation {
  const redact = options.redact ?? ((value: string) => value);
  return {
    sessionId: presentation.sessionId,
    turnId: presentation.turnId,
    status: presentation.status,
    startedAt: presentation.startedAt,
    ...(presentation.completedAt === undefined ? {} : { completedAt: presentation.completedAt }),
    ...(presentation.durationMs === undefined ? {} : { durationMs: presentation.durationMs }),
    groups: presentation.groups.map((group) => serializeGroup(group, redact)),
    ...(presentation.summary ? { summary: { ...presentation.summary } } : {}),
    ...(presentation.retried ? { retried: true } : {}),
  };
}

function parseItem(raw: unknown): ActivityItem | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  const toolCallId = str(raw.toolCallId);
  const action = str(raw.action);
  const status = str(raw.status);
  const startedAt = num(raw.startedAt);
  if (!id || !toolCallId || !action || !status || startedAt === undefined) return undefined;
  if (!ACTIONS.has(action) || !ACTIVITY_STATUS.has(status)) return undefined;
  const target = str(raw.target);
  const detail = str(raw.detail);
  const completedAt = num(raw.completedAt);
  const exitCode = num(raw.exitCode);
  const lines = parseLineDiff(raw.lines);
  return {
    id,
    toolCallId,
    action: action as ActivityAction,
    ...(target ? { target: safeTarget(target) } : {}),
    status: status as ActivityStatus,
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(detail ? { detail } : {}),
    ...(lines ? { lines } : {}),
  };
}

/** 行数必须两边都是有限非负数才认；缺一半就整个丢掉，不补零。 */
function parseLineDiff(raw: unknown): LineDiffStat | undefined {
  if (!isRecord(raw)) return undefined;
  const added = num(raw.added);
  const deleted = num(raw.deleted);
  if (added === undefined || deleted === undefined) return undefined;
  if (added < 0 || deleted < 0) return undefined;
  return { added, deleted };
}

function parseGroup(raw: unknown): ActivityGroup | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  const kind = str(raw.kind);
  const title = str(raw.title);
  const status = str(raw.status);
  const startedAt = num(raw.startedAt);
  if (!id || !kind || !title || !status || startedAt === undefined) return undefined;
  if (!GROUP_KINDS.has(kind) || !ACTIVITY_STATUS.has(status)) return undefined;
  const items = Array.isArray(raw.items)
    ? raw.items.map(parseItem).filter((item): item is ActivityItem => item !== undefined)
    : [];
  const subtitle = str(raw.subtitle);
  const completedAt = num(raw.completedAt);
  return {
    id,
    kind: kind as ActivityGroupKind,
    title,
    ...(subtitle ? { subtitle } : {}),
    status: status as ActivityGroupStatus,
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    items,
  };
}

function parseSummary(raw: unknown): TurnSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const summary: TurnSummary = {};
  const numeric: Array<keyof TurnSummary> = [
    "filesRead", "searches", "commandsRun",
    "filesModified", "filesCreated", "filesDeleted",
    "addedLines", "deletedLines", "testsPassed", "testsFailed",
  ];
  for (const key of numeric) {
    const value = num(raw[key]);
    if (value !== undefined) (summary[key] as number) = value;
  }
  const verification = str(raw.verificationStatus);
  if (verification && VERIFICATION.has(verification)) {
    summary.verificationStatus = verification as VerificationOutcome;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

export function parseTurnPresentation(raw: unknown): TurnPresentation | undefined {
  if (!isRecord(raw)) return undefined;
  const sessionId = str(raw.sessionId);
  const turnId = str(raw.turnId);
  const status = str(raw.status);
  const startedAt = num(raw.startedAt);
  if (!sessionId || !turnId || !status || startedAt === undefined) return undefined;
  if (!TURN_STATUS.has(status)) return undefined;
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map(parseGroup).filter((group): group is ActivityGroup => group !== undefined)
    : [];
  const completedAt = num(raw.completedAt);
  const durationMs = num(raw.durationMs);
  const summary = parseSummary(raw.summary);
  return {
    sessionId,
    turnId,
    status: status as TurnStatus,
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    groups,
    ...(summary ? { summary } : {}),
    ...(raw.retried === true ? { retried: true } : {}),
  };
}

/**
 * 扩展重启修复：重启前仍在运行的轮次不能装成已完成。
 * 返回 undefined 表示无需改写。
 */
export function interruptPresentation(presentation: TurnPresentation): TurnPresentation | undefined {
  if (presentation.status !== "running") return undefined;
  const at = presentation.completedAt ?? lastActivityAt(presentation) ?? presentation.startedAt;
  return {
    ...presentation,
    status: "interrupted",
    completedAt: at,
    durationMs: Math.max(0, at - presentation.startedAt),
    groups: presentation.groups.map((group) => ({
      ...group,
      status: group.status === "running" ? "stopped" : group.status,
      items: group.items.map((item) => (
        item.status === "running" ? { ...item, status: "stopped" as const, completedAt: at } : item
      )),
    })),
  };
}

function lastActivityAt(presentation: TurnPresentation): number | undefined {
  let latest = 0;
  for (const group of presentation.groups) {
    for (const item of group.items) {
      latest = Math.max(latest, item.completedAt ?? item.startedAt);
    }
  }
  return latest > 0 ? latest : undefined;
}
