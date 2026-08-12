/**
 * 单轮任务的真实统计。
 *
 * 注意与 src/turn-summary.ts 区分：那个负责 stopReason 的收尾文案，
 * 这里是时间线底部的数量统计。所有字段都可缺省——拿不到可靠数据时宁可不显示。
 */

export type VerificationOutcome = "passed" | "failed" | "partial" | "unavailable";

export interface TurnSummary {
  filesRead?: number;
  searches?: number;
  commandsRun?: number;
  filesModified?: number;
  filesCreated?: number;
  filesDeleted?: number;
  /**
   * 行级增删。来源是编辑工具事件里的前后全文，算不出来时保持为空、不显示 +N/-N。
   * 命令行改的文件没有这个数据，所以它可能小于文件变更数暗示的规模。
   */
  addedLines?: number;
  deletedLines?: number;
  testsPassed?: number;
  testsFailed?: number;
  verificationStatus?: VerificationOutcome;
}

function fileChangeText(summary: TurnSummary): string | undefined {
  const parts: string[] = [];
  if (summary.filesModified) parts.push(`修改 ${summary.filesModified} 个文件`);
  if (summary.filesCreated) parts.push(`新建 ${summary.filesCreated} 个文件`);
  if (summary.filesDeleted) parts.push(`删除 ${summary.filesDeleted} 个文件`);
  if (parts.length === 0) return undefined;
  // 只有存在可靠 Diff 数据时才追加行数；否则绝不猜测 +N/-N。
  if (summary.addedLines !== undefined && summary.deletedLines !== undefined) {
    parts.push(`+${summary.addedLines} -${summary.deletedLines}`);
  }
  return parts.join(" · ");
}

function verificationText(summary: TurnSummary): string | undefined {
  const status = summary.verificationStatus;
  if (!status || status === "unavailable") return undefined;
  const counts: string[] = [];
  if (summary.testsPassed !== undefined) counts.push(`${summary.testsPassed} 项通过`);
  if (summary.testsFailed) counts.push(`${summary.testsFailed} 项失败`);
  if (counts.length > 0) return counts.join(" · ");
  if (status === "passed") return "验证通过";
  if (status === "failed") return "验证失败";
  return "部分通过";
}

/** 时间线底部的统计行；没有任何可靠数据时返回空数组，界面就不显示这一行。 */
export function describeTurnSummary(summary: TurnSummary | undefined): string[] {
  if (!summary) return [];
  const parts: string[] = [];
  if (summary.filesRead) parts.push(`查看 ${summary.filesRead} 个文件`);
  if (summary.searches) parts.push(`搜索 ${summary.searches} 次`);
  if (summary.commandsRun) parts.push(`执行 ${summary.commandsRun} 条命令`);
  const changes = fileChangeText(summary);
  if (changes) parts.push(changes);
  const verification = verificationText(summary);
  if (verification) parts.push(verification);
  return parts;
}
