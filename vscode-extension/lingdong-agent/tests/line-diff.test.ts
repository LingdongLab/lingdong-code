import assert from "node:assert/strict";
import test from "node:test";
import { countLineDiff, describeLineDiff } from "../src/presentation/line-diff";
import { describeActivityItem, type ActivityItem } from "../src/presentation/activity-item";
import { buildTurnSummary } from "../src/presentation/summary-builder";
import { describeTurnSummary } from "../src/presentation/turn-summary";

test("改一行算 +1 -1", () => {
  const stat = countLineDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(stat, { added: 1, deleted: 1 });
});

test("纯插入不算删除", () => {
  assert.deepEqual(countLineDiff("a\nb\n", "a\nx\ny\nb\n"), { added: 2, deleted: 0 });
});

test("纯删除不算新增", () => {
  assert.deepEqual(countLineDiff("a\nx\ny\nb\n", "a\nb\n"), { added: 0, deleted: 2 });
});

test("内容没变就是 0 0", () => {
  assert.deepEqual(countLineDiff("a\nb\n", "a\nb\n"), { added: 0, deleted: 0 });
});

test("新建文件：全部算新增", () => {
  assert.deepEqual(countLineDiff("", "a\nb\nc\n"), { added: 3, deleted: 0 });
});

test("删除文件：全部算删除", () => {
  assert.deepEqual(countLineDiff("a\nb\nc\n", ""), { added: 0, deleted: 3 });
});

test("末尾换行不凭空多算一行", () => {
  assert.deepEqual(countLineDiff("a\nb", "a\nb\n"), { added: 0, deleted: 0 });
});

test("CRLF 与 LF 的差异不算改动", () => {
  assert.deepEqual(countLineDiff("a\r\nb\r\n", "a\nb\n"), { added: 0, deleted: 0 });
});

test("中间插入不会被算成整块重写", () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 100", "line 100\nline 100.5");
  assert.deepEqual(countLineDiff(before, after), { added: 1, deleted: 0 });
});

test("整块替换：新旧各算一遍", () => {
  assert.deepEqual(countLineDiff("a\nb\nc\n", "x\ny\n"), { added: 2, deleted: 3 });
});

test("超大改动不硬算，返回 undefined 让调用方别显示", () => {
  // 首尾无共同行、中段各两千余行且互不相同 → 格子数超上限。
  const before = Array.from({ length: 2500 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 2500 }, (_, i) => `new ${i}`).join("\n");
  assert.equal(countLineDiff(before, after), undefined);
});

test("describeLineDiff 在无改动时不产出角标", () => {
  assert.equal(describeLineDiff({ added: 0, deleted: 0 }), undefined);
  assert.equal(describeLineDiff(undefined), undefined);
  assert.equal(describeLineDiff({ added: 12, deleted: 3 }), "+12 -3");
});

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "ai-1",
    toolCallId: "call-1",
    action: "edit",
    target: "src/app.ts",
    status: "completed",
    startedAt: 0,
    ...overrides,
  };
}

test("时间线条目把行数跟在路径后面", () => {
  const text = describeActivityItem(item({ lines: { added: 12, deleted: 3 } }));
  assert.equal(text, "已修改 src/app.ts +12 -3");
});

test("没有行数的条目文案保持原样", () => {
  assert.equal(describeActivityItem(item()), "已修改 src/app.ts");
});

test("失败标注仍跟在行数之后", () => {
  const text = describeActivityItem(item({
    status: "failed",
    exitCode: 1,
    lines: { added: 1, deleted: 0 },
  }));
  assert.equal(text, "已修改 src/app.ts +1 -0（失败，退出码 1）");
});

test("轮次摘要在有可靠行数时显示 +N/-N", () => {
  const summary = buildTurnSummary({
    groups: [],
    changes: { modified: 2, created: 0, deleted: 0 },
    lines: { added: 20, deleted: 4 },
  });
  assert.equal(summary.addedLines, 20);
  assert.equal(summary.deletedLines, 4);
  assert.equal(describeTurnSummary(summary).join(" · "), "修改 2 个文件 · +20 -4");
});

test("行数全为 0 时不写进摘要", () => {
  const summary = buildTurnSummary({
    groups: [],
    changes: { modified: 1, created: 0, deleted: 0 },
    lines: { added: 0, deleted: 0 },
  });
  assert.equal(summary.addedLines, undefined);
  assert.equal(describeTurnSummary(summary).join(" · "), "修改 1 个文件");
});

test("拿不到行数时摘要仍然只报文件数", () => {
  const summary = buildTurnSummary({ groups: [], changes: { modified: 3, created: 0, deleted: 0 } });
  assert.equal(summary.addedLines, undefined);
  assert.equal(summary.deletedLines, undefined);
  assert.equal(describeTurnSummary(summary).join(" · "), "修改 3 个文件");
});
