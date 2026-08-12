/**
 * Turn 完成摘要：文件数来自 ChangeTracker；测试行只用单一 regex。
 * 解析失败则整行不显示，不报错、不显示「未知」。
 */

const TESTS_PASSED_RE = /(\d+)\s+passed/i;

export function parseTestsPassedHint(output: string): number | undefined {
  const match = TESTS_PASSED_RE.exec(output);
  if (!match?.[1]) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

export function buildCompletedSummary(input: {
  filesChanged: number;
  commandOutput?: string;
}): { filesChanged?: number; testsPassed?: number } | undefined {
  const filesChanged = input.filesChanged > 0 ? input.filesChanged : undefined;
  const testsPassed = input.commandOutput
    ? parseTestsPassedHint(input.commandOutput)
    : undefined;
  if (filesChanged === undefined && testsPassed === undefined) return undefined;
  return {
    ...(filesChanged === undefined ? {} : { filesChanged }),
    ...(testsPassed === undefined ? {} : { testsPassed }),
  };
}
