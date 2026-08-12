import type { ActivityGroup } from "./activity-group";
import type { LineDiffStat } from "./line-diff";
import type { TurnSummary } from "./turn-summary";
import type { VerificationResult } from "./verification-parser";

/**
 * 真实统计。每个数字都要指得出来源：
 * 读取/搜索/命令来自真实 toolCallId 与去重后的相对路径，
 * 文件增删改只认 ChangeTracker，行数在没有可靠 Diff 前一律不给。
 */

export interface ChangeCounts {
  modified: number;
  created: number;
  deleted: number;
}

export interface SummaryInput {
  groups: ActivityGroup[];
  /** 来自 ChangeTracker 的本轮文件变更；缺省表示无法统计，而不是 0。 */
  changes?: ChangeCounts;
  verification?: VerificationResult;
  /**
   * 本轮行级增删合计，来自编辑事件里的前后全文。
   * 缺省表示这一轮没有可靠 diff（例如全是命令改的文件），此时不显示 +N/-N。
   */
  lines?: LineDiffStat;
}

export function buildTurnSummary(input: SummaryInput): TurnSummary {
  const readTargets = new Set<string>();
  const searchCalls = new Set<string>();
  const commandCalls = new Set<string>();

  for (const group of input.groups) {
    for (const item of group.items) {
      switch (item.action) {
        case "read":
          // 同一文件读多次只算一个已查看文件。
          readTargets.add(item.target ?? item.toolCallId);
          break;
        case "search":
          searchCalls.add(item.toolCallId);
          break;
        case "run":
          commandCalls.add(item.toolCallId);
          break;
        default:
          break;
      }
    }
  }

  const summary: TurnSummary = {};
  if (readTargets.size > 0) summary.filesRead = readTargets.size;
  if (searchCalls.size > 0) summary.searches = searchCalls.size;
  if (commandCalls.size > 0) summary.commandsRun = commandCalls.size;

  const changes = input.changes;
  if (changes) {
    if (changes.modified > 0) summary.filesModified = changes.modified;
    if (changes.created > 0) summary.filesCreated = changes.created;
    if (changes.deleted > 0) summary.filesDeleted = changes.deleted;
  }

  // 行数只在真有文件变更时才有意义；改动数为 0 却写着 +12 -3 只会让人困惑。
  const lines = input.lines;
  if (lines && (lines.added > 0 || lines.deleted > 0)) {
    summary.addedLines = lines.added;
    summary.deletedLines = lines.deleted;
  }

  const verification = input.verification;
  if (verification && verification.status !== "unavailable") {
    summary.verificationStatus = verification.status;
    if (verification.testsPassed !== undefined) summary.testsPassed = verification.testsPassed;
    if (verification.testsFailed !== undefined) summary.testsFailed = verification.testsFailed;
  } else if (verification) {
    summary.verificationStatus = "unavailable";
  }

  return summary;
}
