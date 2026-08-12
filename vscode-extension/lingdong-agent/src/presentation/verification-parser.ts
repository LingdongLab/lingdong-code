import type { VerificationOutcome } from "./turn-summary";

/**
 * 验证命令输出解析。
 *
 * 解析必须保守：只有输出结构明确时才给出数字。
 * 一旦拿不准就返回 unavailable，界面退回「测试通过 / 验证失败」这种不含数量的说法。
 * 绝不从 Agent 的自然语言回复里数测试数量。
 */

export type VerificationTool =
  | "node-test"
  | "vitest"
  | "jest"
  | "mocha"
  | "pytest"
  | "typescript"
  | "build"
  | "lint";

export interface VerificationResult {
  status: VerificationOutcome;
  testsPassed?: number;
  testsFailed?: number;
  tool?: VerificationTool;
}

export interface VerificationInput {
  /** 命令原文，用于判断这是测试、类型检查还是构建。 */
  command: string;
  output: string;
  exitCode?: number;
}

interface Counts {
  passed: number;
  failed: number;
  tool: VerificationTool;
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** node:test 的 TAP 摘要：`# pass 296` / `# fail 0`。 */
function parseNodeTest(output: string): Counts | undefined {
  const pass = toInt(/^#\s*pass\s+(\d+)\s*$/m.exec(output)?.[1]);
  const fail = toInt(/^#\s*fail\s+(\d+)\s*$/m.exec(output)?.[1]);
  if (pass === undefined || fail === undefined) return undefined;
  return { passed: pass, failed: fail, tool: "node-test" };
}

/** vitest：`Tests  2 failed | 294 passed (296)`。 */
function parseVitest(output: string): Counts | undefined {
  const line = /^\s*Tests\s+(.+)$/m.exec(output)?.[1];
  if (!line) return undefined;
  const passed = toInt(/(\d+)\s+passed/.exec(line)?.[1]);
  const failed = toInt(/(\d+)\s+failed/.exec(line)?.[1]);
  if (passed === undefined && failed === undefined) return undefined;
  return { passed: passed ?? 0, failed: failed ?? 0, tool: "vitest" };
}

/** jest：`Tests:       1 failed, 295 passed, 296 total`。 */
function parseJest(output: string): Counts | undefined {
  const line = /^\s*Tests:\s+(.+)$/m.exec(output)?.[1];
  if (!line) return undefined;
  const passed = toInt(/(\d+)\s+passed/.exec(line)?.[1]);
  const failed = toInt(/(\d+)\s+failed/.exec(line)?.[1]);
  if (passed === undefined && failed === undefined) return undefined;
  return { passed: passed ?? 0, failed: failed ?? 0, tool: "jest" };
}

/** mocha：`296 passing` / `2 failing`。 */
function parseMocha(output: string): Counts | undefined {
  const passed = toInt(/^\s*(\d+)\s+passing/m.exec(output)?.[1]);
  if (passed === undefined) return undefined;
  const failed = toInt(/^\s*(\d+)\s+failing/m.exec(output)?.[1]) ?? 0;
  return { passed, failed, tool: "mocha" };
}

/** pytest：`===== 2 failed, 294 passed in 1.20s =====`。 */
function parsePytest(output: string): Counts | undefined {
  const line = /^=+\s*(.*?\b(?:passed|failed|error)\b.*?)\s*=+$/m.exec(output)?.[1];
  if (!line) return undefined;
  const passed = toInt(/(\d+)\s+passed/.exec(line)?.[1]);
  const failed = toInt(/(\d+)\s+failed/.exec(line)?.[1]);
  if (passed === undefined && failed === undefined) return undefined;
  return { passed: passed ?? 0, failed: failed ?? 0, tool: "pytest" };
}

const TEST_PARSERS = [parseNodeTest, parseVitest, parseJest, parseMocha, parsePytest] as const;

function commandKind(command: string): "test" | "typecheck" | "lint" | "build" | "unknown" {
  const text = command.toLowerCase();
  if (/type-?check|\btsc\b/.test(text)) return "typecheck";
  if (/\blint\b|eslint|biome|ruff|flake8/.test(text)) return "lint";
  if (/\btest\b|vitest|jest|mocha|pytest|--test\b/.test(text)) return "test";
  if (/\bbuild\b|esbuild|webpack|rollup|compile/.test(text)) return "build";
  return "unknown";
}

function statusFromExitCode(exitCode: number | undefined): VerificationOutcome {
  if (exitCode === undefined) return "unavailable";
  return exitCode === 0 ? "passed" : "failed";
}

export function parseVerification(input: VerificationInput): VerificationResult {
  const output = input.output ?? "";
  const kind = commandKind(input.command);

  for (const parse of TEST_PARSERS) {
    const counts = parse(output);
    if (!counts) continue;
    // 数字明确时以数字为准；退出码只用来在两者矛盾时降级为 partial。
    const byCounts: VerificationOutcome = counts.failed > 0 ? "failed" : "passed";
    const byExit = statusFromExitCode(input.exitCode);
    const status: VerificationOutcome = byExit !== "unavailable" && byExit !== byCounts ? "partial" : byCounts;
    return { status, testsPassed: counts.passed, testsFailed: counts.failed, tool: counts.tool };
  }

  if (kind === "typecheck") {
    if (/error\s+TS\d+/i.test(output)) return { status: "failed", tool: "typescript" };
    const status = statusFromExitCode(input.exitCode);
    return status === "unavailable" ? { status } : { status, tool: "typescript" };
  }

  if (kind === "lint" || kind === "build") {
    const status = statusFromExitCode(input.exitCode);
    return status === "unavailable" ? { status } : { status, tool: kind === "lint" ? "lint" : "build" };
  }

  if (kind === "test") {
    // 认得出是测试命令但数不出数量：只报通过与否，不编造数字。
    return { status: statusFromExitCode(input.exitCode) };
  }

  return { status: "unavailable" };
}

/** 多条验证命令合并成一个结论。 */
export function mergeVerification(results: VerificationResult[]): VerificationResult {
  const usable = results.filter((result) => result.status !== "unavailable");
  if (usable.length === 0) return { status: "unavailable" };

  let testsPassed: number | undefined;
  let testsFailed: number | undefined;
  for (const result of usable) {
    if (result.testsPassed !== undefined) testsPassed = (testsPassed ?? 0) + result.testsPassed;
    if (result.testsFailed !== undefined) testsFailed = (testsFailed ?? 0) + result.testsFailed;
  }

  const hasFailure = usable.some((result) => result.status === "failed");
  const hasPartial = usable.some((result) => result.status === "partial");
  const status: VerificationOutcome = hasFailure ? "failed" : hasPartial ? "partial" : "passed";
  return {
    status,
    ...(testsPassed === undefined ? {} : { testsPassed }),
    ...(testsFailed === undefined ? {} : { testsFailed }),
  };
}
