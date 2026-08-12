import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ChangeListView } from "../src/change-view";
import type { WebviewToHostMessage } from "../src/messages";
import type { PlanRecord } from "../src/storage/plan-repository";
import { renderChangesPanel } from "../src/webview/workbench/changes-panel";
import { renderContextPanel } from "../src/webview/workbench/context-panel";
import { renderFilesPanel, truncationNotice } from "../src/webview/workbench/files-panel";
import { renderTasksPanel } from "../src/webview/workbench/tasks-panel";

function installDom(): HTMLElement {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"panel\"></div>");
  const { window } = dom;
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Event", { value: window.Event, configurable: true });
  return window.document.getElementById("panel") as HTMLElement;
}

function changeView(overrides: Partial<ChangeListView> = {}): ChangeListView {
  return {
    turnId: "turn-1",
    title: "本轮变更",
    statusLabel: "待处理",
    pending: 1,
    canAcceptAll: true,
    canRejectAll: true,
    canUndo: true,
    rows: [
      {
        changeId: "chg-1",
        relativePath: "src/app.ts",
        kind: "modify",
        letter: "M",
        status: "pending",
        statusLabel: "待处理",
      },
    ],
    ...overrides,
  } as ChangeListView;
}

test("工作台靠 hidden 收起，样式表必须有全局兜底否则它会占掉一整行", () => {
  const root = path.resolve(__dirname, "..");
  const panel = readFileSync(path.join(root, "src/agent-panel.ts"), "utf8");
  const css = readFileSync(path.join(root, "src/webview/main.css"), "utf8");

  // 收起靠的是 hidden 属性，不是某个 class。
  assert.match(panel, /class="right workbench"[^>]*\bhidden\b/);

  // 而 .right.workbench 声明了 display:flex，会盖掉 hidden 的浏览器默认规则。
  // 没有这条全局兜底，收起的 aside 仍会渲染，在两列网格里掉进第二行。
  assert.match(css, /^\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/m);
});

test("Files 面板在结果截断时给出明确提示", () => {
  const panel = installDom();
  const sent: WebviewToHostMessage[] = [];
  renderFilesPanel(
    panel,
    {
      items: [{ relativePath: "src/a.ts", directory: false }],
      query: "ts",
      truncated: true,
      matched: 320,
      scanLimit: undefined,
    },
    (message) => sent.push(message),
    () => undefined,
  );
  const banner = panel.querySelector(".panel-banner");
  assert.ok(banner, "截断时必须显示提示条");
  assert.match(banner!.textContent ?? "", /匹配到 320 个文件/);
  assert.match(banner!.textContent ?? "", /只显示前 1 个/);
});

test("扫描上限截断的提示与列表截断区分开", () => {
  const notice = truncationNotice(
    { items: [], query: "", truncated: true, matched: 400, scanLimit: 400 },
    400,
  );
  assert.match(notice ?? "", /仅扫描了前 400 个/);
});

test("结果未截断时不显示提示条", () => {
  const panel = installDom();
  renderFilesPanel(
    panel,
    { items: [], query: "", truncated: false, matched: 0, scanLimit: undefined },
    () => undefined,
    () => undefined,
  );
  assert.equal(panel.querySelector(".panel-banner"), null);
});

test("Files 面板点击条目只发相对路径", () => {
  const panel = installDom();
  const sent: WebviewToHostMessage[] = [];
  renderFilesPanel(
    panel,
    {
      items: [{ relativePath: "src/auth/session.ts", directory: false }],
      query: "",
      truncated: false,
      matched: 1,
      scanLimit: undefined,
    },
    (message) => sent.push(message),
    () => undefined,
  );
  panel.querySelector<HTMLButtonElement>(".session-item")?.click();
  assert.deepEqual(sent, [{ type: "openWorkspaceFile", relativePath: "src/auth/session.ts" }]);
});

test("Changes 面板在不可应用时禁用接受与拒绝", () => {
  const panel = installDom();
  renderChangesPanel(panel, changeView(), {
    options: { canApply: false, canRestore: true },
    selection: { selectedId: "chg-1", loading: true },
    onSelect: () => undefined,
    post: () => undefined,
  });
  const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>(".change-actions button"));
  const accept = buttons.find((button) => button.textContent === "接受");
  assert.equal(accept?.disabled, true);
});

test("Changes 面板无变更时给出空态", () => {
  const panel = installDom();
  renderChangesPanel(panel, undefined, {
    options: { canApply: true, canRestore: true },
    selection: undefined,
    onSelect: () => undefined,
    post: () => undefined,
  });
  assert.ok(panel.querySelector(".empty-state"));
});

test("Changes 面板没有选中时自动选第一个文件", () => {
  const panel = installDom();
  const selected: string[] = [];
  renderChangesPanel(panel, changeView(), {
    options: { canApply: true, canRestore: true },
    selection: undefined,
    onSelect: (changeId) => selected.push(changeId),
    post: () => undefined,
  });
  assert.deepEqual(selected, ["chg-1"]);
});

test("Changes 面板就地渲染选中文件的 diff，并保留编辑器入口", () => {
  const panel = installDom();
  const sent: WebviewToHostMessage[] = [];
  renderChangesPanel(panel, changeView(), {
    options: { canApply: true, canRestore: true },
    selection: {
      selectedId: "chg-1",
      loading: false,
      diff: {
        added: 1,
        removed: 0,
        degraded: false,
        omittedHunks: 0,
        hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "add", text: "new", newLine: 1 }] }],
      },
    },
    onSelect: () => undefined,
    post: (message) => sent.push(message),
  });
  assert.ok(panel.querySelector(".change-rail-list .change-row.selected"), "选中行要有高亮");
  assert.equal(panel.querySelector(".change-diff-line.diff-add .change-diff-text")?.textContent, "new");
  const open = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent === "在编辑器中打开");
  assert.ok(open);
  open.click();
  assert.deepEqual(sent, [{ type: "openDiff", changeId: "chg-1" }]);
});

test("Changes 面板拿到 hunk 明细时逐块渲染，每块可单独接受/拒绝", () => {
  const panel = installDom();
  const sent: WebviewToHostMessage[] = [];
  renderChangesPanel(panel, changeView(), {
    options: { canApply: true, canRestore: true },
    selection: {
      selectedId: "chg-1",
      loading: false,
      diff: { added: 1, removed: 0, degraded: false, omittedHunks: 0, hunks: [] },
      hunks: [
        {
          id: "hunk-a",
          oldStart: 3,
          oldCount: 1,
          newStart: 3,
          newCount: 1,
          oldText: "old line\n",
          newText: "new line\n",
          external: false,
        },
        {
          id: "hunk-b",
          oldStart: 8,
          oldCount: 0,
          newStart: 9,
          newCount: 1,
          oldText: "",
          newText: "appended\n",
          external: true,
        },
      ],
    },
    onSelect: () => undefined,
    post: (message) => sent.push(message),
  });
  const blocks = panel.querySelectorAll(".change-diff-hunk");
  assert.equal(blocks.length, 2, "两个 hunk 各渲染一块");
  assert.match(blocks[0]?.querySelector(".hunk-range")?.textContent ?? "", /@@ -3,1 \+3,1 @@/);
  // 外部改动要有来源标注，Agent 自己的没有。
  assert.equal(blocks[0]?.querySelector(".hunk-source"), null);
  assert.equal(blocks[1]?.querySelector(".hunk-source")?.textContent, "手动改动");
  // 每块的接受/拒绝走 hunkAction，而不是整文件的 acceptChange。
  const buttons = Array.from(blocks[0]!.querySelectorAll<HTMLButtonElement>(".hunk-actions button"));
  buttons.find((button) => button.textContent === "接受")?.click();
  buttons.find((button) => button.textContent === "拒绝")?.click();
  assert.deepEqual(sent, [
    { type: "hunkAction", changeId: "chg-1", hunkId: "hunk-a", action: "accept" },
    { type: "hunkAction", changeId: "chg-1", hunkId: "hunk-a", action: "reject" },
  ]);
});

test("Changes 面板不可应用时隐藏逐块按钮，退回整段 diff", () => {
  const panel = installDom();
  renderChangesPanel(panel, changeView(), {
    options: { canApply: false, canRestore: true },
    selection: {
      selectedId: "chg-1",
      loading: false,
      diff: {
        added: 1,
        removed: 0,
        degraded: false,
        omittedHunks: 0,
        hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "add", text: "new", newLine: 1 }] }],
      },
      hunks: [{
        id: "hunk-a",
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: 1,
        oldText: "",
        newText: "new\n",
        external: false,
      }],
    },
    onSelect: () => undefined,
    post: () => undefined,
  });
  assert.equal(panel.querySelector(".change-diff-hunk .hunk-actions"), null, "执行期不该出现逐块按钮");
  assert.equal(panel.querySelector(".change-diff-line.diff-add .change-diff-text")?.textContent, "new");
});

test("Changes 面板 diff 装载中与出错都有明确提示", () => {
  const panel = installDom();
  renderChangesPanel(panel, changeView(), {
    options: { canApply: true, canRestore: true },
    selection: { selectedId: "chg-1", loading: true },
    onSelect: () => undefined,
    post: () => undefined,
  });
  assert.match(panel.querySelector(".change-rail-detail-body")?.textContent ?? "", /正在读取改动/);

  renderChangesPanel(panel, changeView(), {
    options: { canApply: true, canRestore: true },
    selection: { selectedId: "chg-1", loading: false, error: "该变更记录已失效。" },
    onSelect: () => undefined,
    post: () => undefined,
  });
  assert.match(panel.querySelector(".change-rail-detail-body")?.textContent ?? "", /该变更记录已失效/);
});

test("Tasks 面板按步骤状态渲染标记", () => {
  const panel = installDom();
  const plan = {
    steps: [
      { id: "s1", order: 1, title: "第一步", files: [], status: "completed" },
      { id: "s2", order: 2, title: "第二步", files: [], status: "in_progress" },
    ],
  } as unknown as PlanRecord;
  renderTasksPanel(panel, { plan });
  const marks = Array.from(panel.querySelectorAll(".task-mark")).map((node) => node.textContent);
  assert.deepEqual(marks, ["✓", "●"]);
});

test("Tasks 面板把子 Agent 画成并行卡片，标出阻塞与耗时", () => {
  const panel = installDom();
  const startedAt = 1_000_000;
  renderTasksPanel(panel, {
    subagents: [
      {
        id: "call-1",
        description: "梳理构建脚本",
        subagentType: "explore",
        background: false,
        status: "running",
        startedAt,
      },
      {
        id: "call-2",
        description: "跑一遍测试",
        background: true,
        status: "completed",
        summary: "全部通过。",
        startedAt,
        endedAt: startedAt + 95_000,
      },
    ],
  }, () => undefined, startedAt + 12_000);

  const cards = Array.from(panel.querySelectorAll(".subagent-card"));
  assert.equal(cards.length, 2);
  assert.match(panel.textContent ?? "", /子 Agent（1 个进行中）/);
  assert.match(cards[0]?.textContent ?? "", /梳理构建脚本/);
  assert.match(cards[0]?.textContent ?? "", /explore · 阻塞等待 · 12 秒/);
  assert.match(cards[1]?.textContent ?? "", /后台 · 1 分 35 秒/);
  // 汇总常有几百字，必须收进 details 而不是平铺。
  assert.equal(panel.querySelectorAll(".subagent-summary").length, 1);
  assert.equal(panel.querySelector(".empty-state"), null);
});

test("子 Agent 与计划步骤共存时分段显示，不互相顶掉", () => {
  const panel = installDom();
  const plan = {
    steps: [{ id: "s1", order: 1, title: "第一步", files: [], status: "pending" }],
  } as unknown as PlanRecord;
  renderTasksPanel(panel, {
    plan,
    subagents: [{
      id: "call-1",
      description: "查清构建流程",
      background: false,
      status: "running",
      startedAt: 1_000,
    }],
  }, () => undefined, 2_000);

  const sections = Array.from(panel.querySelectorAll(".panel-section")).map((n) => n.textContent);
  assert.deepEqual(sections, ["子 Agent（1 个进行中）", "步骤"]);
  assert.equal(panel.querySelectorAll(".task-row").length, 1);
});

test("既没有步骤、子 Agent 也没有后台任务才算空态", () => {
  const panel = installDom();
  renderTasksPanel(panel, { subagents: [], backgroundTasks: [] });
  assert.ok(panel.querySelector(".empty-state"));
});

test("后台任务卡给出查看输出与终止，并标出运行中数量", () => {
  const panel = installDom();
  const sent: WebviewToHostMessage[] = [];
  renderTasksPanel(panel, {
    backgroundTasks: [{
      id: "call-1",
      taskId: "t1",
      command: "npm run dev",
      kind: "command",
      status: "running",
      startedAt: 1_000,
      outputLines: 12,
    }],
  }, (message) => sent.push(message), 61_000);

  assert.match(panel.textContent ?? "", /后台任务（1 个运行中）/);
  assert.match(panel.textContent ?? "", /后台命令 · 运行中 · 1 分 0 秒 · 12 行输出/);

  const buttons = Array.from(panel.querySelectorAll(".task-actions button")) as HTMLButtonElement[];
  assert.deepEqual(buttons.map((button) => button.textContent), ["查看输出", "终止"]);
  buttons[0]?.click();
  buttons[1]?.click();
  assert.deepEqual(sent, [
    { type: "showBackgroundTaskOutput", taskId: "call-1" },
    { type: "killBackgroundTask", taskId: "call-1" },
  ]);
});

// 解析不出 task_id 时宿主也终止不了，点了没反应最气人，所以禁用并说明原因。
test("没有 task_id 的后台任务禁用终止按钮并解释为什么", () => {
  const panel = installDom();
  renderTasksPanel(panel, {
    backgroundTasks: [{
      id: "call-1",
      command: "npm run dev",
      kind: "command",
      status: "running",
      startedAt: 1_000,
      outputLines: 0,
    }],
  }, () => undefined, 2_000);

  const buttons = Array.from(panel.querySelectorAll(".task-actions button")) as HTMLButtonElement[];
  const kill = buttons.find((button) => button.textContent === "终止");
  assert.equal(kill?.disabled, true);
  assert.match(kill?.title ?? "", /解析出任务 id/);
  // 没有输出时「查看输出」也没意义。
  assert.equal(buttons.find((button) => button.textContent === "查看输出")?.disabled, true);
});

test("已结束的后台任务不再显示终止，但保留退出码与查看输出", () => {
  const panel = installDom();
  renderTasksPanel(panel, {
    backgroundTasks: [{
      id: "call-1",
      taskId: "t1",
      command: "npm test",
      kind: "command",
      status: "failed",
      exitCode: 1,
      startedAt: 1_000,
      endedAt: 4_000,
      outputLines: 3,
    }],
  }, () => undefined, 90_000);

  const labels = Array.from(panel.querySelectorAll(".task-actions button")).map((n) => n.textContent);
  assert.deepEqual(labels, ["查看输出"]);
  assert.match(panel.textContent ?? "", /失败 · 退出码 1 · 3 秒/);
});

test("后台任务与子 Agent、步骤三段共存", () => {
  const panel = installDom();
  const plan = {
    steps: [{ id: "s1", order: 1, title: "第一步", files: [], status: "pending" }],
  } as unknown as PlanRecord;
  renderTasksPanel(panel, {
    plan,
    subagents: [{ id: "s-1", description: "查资料", background: false, status: "running", startedAt: 1_000 }],
    backgroundTasks: [{
      id: "b-1",
      taskId: "t1",
      command: "npm run dev",
      kind: "command",
      status: "running",
      startedAt: 1_000,
      outputLines: 1,
    }],
  }, () => undefined, 2_000);

  assert.deepEqual(
    Array.from(panel.querySelectorAll(".panel-section")).map((n) => n.textContent),
    ["子 Agent（1 个进行中）", "后台任务（1 个运行中）", "步骤"],
  );
});

test("Context 面板压缩不可用时禁用压缩按钮", () => {
  const panel = installDom();
  renderContextPanel(
    panel,
    [{ id: "ctx-1", label: "src/app.ts", kind: "file", detail: "" } as never],
    {
      label: "已用 12%",
      level: "normal",
      source: "estimated",
      usedTokens: 100,
      compactCapability: "unavailable",
      compactBusy: false,
    },
    () => undefined,
  );
  const compact = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes("压缩上下文"));
  assert.equal(compact?.disabled, true);
});
