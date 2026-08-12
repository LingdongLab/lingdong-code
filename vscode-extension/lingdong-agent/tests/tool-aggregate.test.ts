import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_VERB, ToolTurnAggregator } from "../src/webview/tool-aggregate";
import { productizeToolLabel } from "../src/webview/message-renderer";

test("工具动词中文化", () => {
  assert.equal(TOOL_VERB.read, "已读取");
  assert.equal(TOOL_VERB.edit, "已修改");
  assert.equal(TOOL_VERB.search, "已搜索");
  assert.equal(TOOL_VERB.execute, "已执行命令");
  assert.equal(TOOL_VERB.create, "已创建");
  assert.equal(TOOL_VERB.delete, "已删除");
  assert.equal(productizeToolLabel("List Files").title, "查看项目文件");
});

test("连续工具事件聚合到同一组", () => {
  const agg = new ToolTurnAggregator();
  const a = agg.start({
    toolCallId: "t1",
    kind: "read",
    label: "分析项目结构",
    target: "src/a.ts",
    readOnly: true,
    at: 1_000,
  });
  const b = agg.start({
    toolCallId: "t2",
    kind: "search",
    label: "分析项目结构",
    target: "login",
    readOnly: true,
    at: 1_500,
  });
  assert.equal(a.group.id, b.group.id);
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, false);
  assert.equal(a.group.items.length, 2);
  assert.match(a.group.items[0]!.productDetail, /已读取/);
  assert.match(a.group.items[1]!.productDetail, /已搜索/);
});

test("相同 identity 3 秒内去重", () => {
  const agg = new ToolTurnAggregator();
  const first = agg.start({
    toolCallId: "t1",
    kind: "read",
    label: "Read",
    target: "same.ts",
    readOnly: true,
    at: 5_000,
  });
  const second = agg.start({
    toolCallId: "t1",
    kind: "read",
    label: "Read",
    target: "same.ts",
    readOnly: true,
    at: 6_000,
  });
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(first.group.items.length, 1);
});

test("不同文件读取不会被误去重", () => {
  const agg = new ToolTurnAggregator();
  const a = agg.start({
    toolCallId: "t1",
    kind: "read",
    label: "Read",
    target: "src/auth/router.ts",
    readOnly: true,
    at: 10_000,
  });
  const b = agg.start({
    toolCallId: "t2",
    kind: "read",
    label: "Read",
    target: "src/auth/session.ts",
    readOnly: true,
    at: 10_500,
  });
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, false);
  assert.equal(a.group.items.length, 2);
  assert.match(a.group.items[0]!.productDetail, /router\.ts/);
  assert.match(a.group.items[1]!.productDetail, /session\.ts/);
});

test("全部完成后组状态变为已完成，摘要含耗时", () => {
  const agg = new ToolTurnAggregator();
  const { group } = agg.start({
    toolCallId: "t1",
    kind: "read",
    label: "分析",
    target: "a.ts",
    readOnly: true,
    at: 10_000,
  });
  agg.status("t1", "completed", 22_000);
  const updated = agg.list().find((g) => g.id === group.id);
  assert.equal(updated?.status, "completed");
  assert.equal(agg.statusLabel(updated!.status), "已完成");
  const lines = agg.summaryLines(updated!);
  assert.ok(lines.some((line) => line.includes("已读取")));
  assert.ok(lines.some((line) => /耗时 \d+ 秒/.test(line)));
});
