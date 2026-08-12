import assert from "node:assert/strict";
import test from "node:test";
import { mergeVerification, parseVerification } from "../src/presentation/verification-parser";

test("解析 node:test 的 TAP 摘要", () => {
  const output = ["1..296", "# tests 296", "# pass 296", "# fail 0"].join("\n");
  const result = parseVerification({ command: "npm test", output, exitCode: 0 });
  assert.equal(result.status, "passed");
  assert.equal(result.testsPassed, 296);
  assert.equal(result.testsFailed, 0);
  assert.equal(result.tool, "node-test");
});

test("解析 node:test 的失败摘要", () => {
  const output = ["# pass 293", "# fail 3"].join("\n");
  const result = parseVerification({ command: "npm test", output, exitCode: 1 });
  assert.equal(result.status, "failed");
  assert.equal(result.testsFailed, 3);
});

test("解析 vitest 摘要", () => {
  const output = " Test Files  2 failed | 10 passed (12)\n      Tests  2 failed | 294 passed (296)";
  const result = parseVerification({ command: "npx vitest run", output, exitCode: 1 });
  assert.equal(result.tool, "vitest");
  assert.equal(result.testsPassed, 294);
  assert.equal(result.testsFailed, 2);
  assert.equal(result.status, "failed");
});

test("解析 jest 摘要", () => {
  const output = "Tests:       1 failed, 295 passed, 296 total";
  const result = parseVerification({ command: "npx jest", output, exitCode: 1 });
  assert.equal(result.tool, "jest");
  assert.equal(result.testsPassed, 295);
  assert.equal(result.testsFailed, 1);
});

test("解析 mocha 摘要", () => {
  const result = parseVerification({ command: "npx mocha", output: "  296 passing (2s)\n  2 failing", exitCode: 1 });
  assert.equal(result.tool, "mocha");
  assert.equal(result.testsPassed, 296);
  assert.equal(result.testsFailed, 2);
});

test("解析 pytest 摘要", () => {
  const result = parseVerification({
    command: "pytest",
    output: "==================== 2 failed, 294 passed in 1.20s ====================",
    exitCode: 1,
  });
  assert.equal(result.tool, "pytest");
  assert.equal(result.testsPassed, 294);
  assert.equal(result.testsFailed, 2);
});

test("TypeScript 类型检查按错误标记与退出码判定", () => {
  const ok = parseVerification({ command: "npm run typecheck", output: "", exitCode: 0 });
  assert.equal(ok.status, "passed");
  assert.equal(ok.tool, "typescript");
  assert.equal(ok.testsPassed, undefined);

  const bad = parseVerification({
    command: "tsc --noEmit",
    output: "src/a.ts(3,5): error TS2345: Argument of type 'string'…",
    exitCode: 2,
  });
  assert.equal(bad.status, "failed");
});

test("构建与 Lint 只看退出码，不编造数量", () => {
  const build = parseVerification({ command: "npm run build", output: "done", exitCode: 0 });
  assert.equal(build.status, "passed");
  assert.equal(build.testsPassed, undefined);

  const lint = parseVerification({ command: "npm run lint", output: "3 problems", exitCode: 1 });
  assert.equal(lint.status, "failed");
  assert.equal(lint.tool, "lint");
});

test("认得出是测试命令但数不出数量时只报通过与否", () => {
  const result = parseVerification({ command: "npm test", output: "一切正常", exitCode: 0 });
  assert.equal(result.status, "passed");
  assert.equal(result.testsPassed, undefined);
  assert.equal(result.testsFailed, undefined);
});

test("结构不明确且没有退出码时判定为不可用", () => {
  assert.equal(parseVerification({ command: "npm test", output: "一切正常" }).status, "unavailable");
  assert.equal(parseVerification({ command: "git status", output: "clean", exitCode: 0 }).status, "unavailable");
});

test("不从自然语言里数测试数量", () => {
  const result = parseVerification({
    command: "git status",
    output: "我已经运行了测试，296 项全部通过，另外修复了 3 个问题。",
    exitCode: 0,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.testsPassed, undefined);
});

test("数字与退出码矛盾时降级为部分通过", () => {
  const result = parseVerification({ command: "npm test", output: "# pass 10\n# fail 0", exitCode: 1 });
  assert.equal(result.status, "partial");
  assert.equal(result.testsPassed, 10);
});

test("多条验证命令合并成一个结论", () => {
  assert.deepEqual(
    mergeVerification([
      { status: "passed", tool: "typescript" },
      { status: "passed", testsPassed: 296, testsFailed: 0, tool: "node-test" },
    ]),
    { status: "passed", testsPassed: 296, testsFailed: 0 },
  );

  assert.equal(mergeVerification([{ status: "unavailable" }]).status, "unavailable");
  assert.equal(
    mergeVerification([{ status: "passed" }, { status: "failed" }]).status,
    "failed",
  );
});
