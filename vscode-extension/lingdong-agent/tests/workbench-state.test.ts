import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_META,
  clampWorkbenchWidth,
  closeTool,
  closeWorkbench,
  defaultWorkbenchState,
  openTool,
  readWorkbenchState,
  suggestOpenTool,
  WORKBENCH_MIN_WIDTH,
} from "../src/webview/workbench-state";

test("默认工作台收起且无打开工具", () => {
  const state = defaultWorkbenchState();
  assert.equal(state.collapsed, true);
  assert.deepEqual(state.openTools, []);
  assert.equal(state.activeTool, null);
  assert.equal(state.suppressAutoOpen, false);
  assert.equal(TOOL_META.preview.enabled, false);
  assert.equal(TOOL_META.changes.enabled, true);
});

test("openTool 展开并加入 openTools，禁用工具无效", () => {
  let state = defaultWorkbenchState();
  state = openTool(state, "changes");
  assert.equal(state.collapsed, false);
  assert.equal(state.activeTool, "changes");
  assert.deepEqual(state.openTools, ["changes"]);
  assert.equal(state.userPinned, true);

  const blocked = openTool(state, "preview");
  assert.deepEqual(blocked.openTools, ["changes"]);
  assert.equal(blocked.activeTool, "changes");
});

test("关闭最后一个工具后 suppressAutoOpen，建议展开被抑制", () => {
  let state = openTool(defaultWorkbenchState(), "files");
  state = closeWorkbench(state);
  assert.equal(state.collapsed, true);
  assert.equal(state.suppressAutoOpen, true);
  assert.equal(state.userPinned, false);

  const suggested = suggestOpenTool(state, "changes");
  assert.equal(suggested, state);
});

test("closeTool 切到剩余工具，清空后收起", () => {
  let state = openTool(defaultWorkbenchState(), "changes");
  state = openTool(state, "tasks");
  state = closeTool(state, "tasks");
  assert.equal(state.activeTool, "changes");
  assert.deepEqual(state.openTools, ["changes"]);

  state = closeTool(state, "changes");
  assert.equal(state.collapsed, true);
  assert.equal(state.suppressAutoOpen, true);
  assert.deepEqual(state.openTools, []);
});

test("宽度钳制在 280 与窗口 50% 之间", () => {
  assert.equal(clampWorkbenchWidth(100, 2000), WORKBENCH_MIN_WIDTH);
  assert.equal(clampWorkbenchWidth(900, 1200), 600);
  assert.equal(clampWorkbenchWidth(400, 1200), 400);
});

test("readWorkbenchState 只从 UI 状态恢复，不依赖业务 Store", () => {
  const parsed = readWorkbenchState({
    workbench: {
      collapsed: false,
      width: 320,
      activeTool: "context",
      openTools: ["context", "files", "preview"],
      userPinned: true,
      lastActiveTool: "context",
      suppressAutoOpen: false,
    },
  });
  assert.equal(parsed.collapsed, false);
  assert.equal(parsed.width, 320);
  assert.equal(parsed.activeTool, "context");
  assert.deepEqual(parsed.openTools, ["context", "files"]);
  assert.equal(parsed.userPinned, true);

  const empty = readWorkbenchState(null);
  assert.equal(empty.collapsed, true);
});
