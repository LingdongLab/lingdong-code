import assert from "node:assert/strict";
import test from "node:test";
import { formatDiagnosticsBlock, type DiagnosticItem } from "../src/diagnostics-format";

test("诊断块格式化；空列表给出明确说明", () => {
  assert.match(formatDiagnosticsBlock([]), /没有可读诊断/);
  const items: DiagnosticItem[] = [
    {
      uri: "file:///a.ts",
      relativePath: "src/a.ts",
      severity: "error",
      message: "类型不匹配",
      line: 3,
      character: 1,
      source: "ts",
    },
  ];
  const text = formatDiagnosticsBlock(items);
  assert.match(text, /工作区问题面板/);
  assert.match(text, /src\/a\.ts:3:1/);
  assert.match(text, /类型不匹配/);
});
