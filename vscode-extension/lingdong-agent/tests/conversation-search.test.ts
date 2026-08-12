import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/messages";
import type { TurnPresentation } from "../src/presentation/turn-presentation";
import { extractSearchable, findMatches, type SearchableRecord } from "../src/search/search-result";
import { ConversationSearch, createSearchBar } from "../src/webview/conversation-search";
import { ConversationView, type RenderUnit } from "../src/webview/conversation";
import { element } from "../src/webview/dom-utils";

function installDom(): Window & typeof globalThis {
  const dom = new JSDOM(`<!DOCTYPE html>
    <div id="messages"><div id="search-bar" hidden></div><div id="messages-inner"><div id="empty">空</div></div></div>`);
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLDetailsElement: window.HTMLDetailsElement,
    Node: window.Node,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  return window as unknown as Window & typeof globalThis;
}

interface Harness {
  window: Window & typeof globalThis;
  view: ConversationView;
  search: ConversationSearch;
  bar: HTMLElement;
  input: HTMLInputElement;
  count: HTMLElement;
  next: HTMLButtonElement;
  previous: HTMLButtonElement;
  inner: HTMLElement;
  messages: HTMLElement;
  query(value: string): void;
}

function createHarness(): Harness {
  const window = installDom();
  const document = window.document;
  const sent: WebviewToHostMessage[] = [];
  void sent;
  const messages = document.getElementById("messages") as HTMLElement;
  const inner = document.getElementById("messages-inner") as HTMLElement;
  const view = new ConversationView({
    el: {
      messages,
      messagesInner: inner,
      empty: document.getElementById("empty") as HTMLElement,
    },
    post: (message) => sent.push(message),
    canSend: () => true,
    onOpenLink: () => undefined,
    onOpenFile: () => undefined,
    onViewPlan: () => undefined,
  });

  const bar = document.getElementById("search-bar") as HTMLElement;
  const parts = createSearchBar(bar);
  const search = new ConversationSearch({
    root: bar,
    ...parts,
    records: () => view.searchableRecords(),
    reveal: (record) => view.revealRecord(record),
    onClose: () => undefined,
    scrollTop: () => messages.scrollTop,
    restoreScroll: (top) => { messages.scrollTop = top; },
  });

  return {
    window,
    view,
    search,
    bar,
    input: parts.input,
    count: parts.count,
    next: parts.next,
    previous: parts.previous,
    inner,
    messages,
    query(value: string) {
      search.show();
      parts.input.value = value;
      parts.input.dispatchEvent(new window.Event("input"));
    },
  };
}

function presentation(): TurnPresentation {
  return {
    sessionId: "ses-1",
    turnId: "turn-1",
    status: "completed",
    startedAt: 1_000,
    completedAt: 9_000,
    durationMs: 8_000,
    groups: [
      {
        id: "g1",
        kind: "exploration",
        title: "探索代码库",
        status: "completed",
        startedAt: 1_000,
        completedAt: 5_000,
        items: [
          {
            id: "i1",
            toolCallId: "t1",
            action: "read",
            target: "src/auth/router.ts",
            status: "completed",
            startedAt: 1_000,
            completedAt: 2_000,
          },
        ],
      },
    ],
  };
}

// —— 纯数据层 ——

test("用户消息与提示进入搜索源", () => {
  assert.deepEqual(extractSearchable({ type: "userMessage", text: "看下 router" }), [
    { field: "user", text: "看下 router" },
  ]);
  assert.deepEqual(extractSearchable({ type: "notice", level: "info", message: "已压缩" }), [
    { field: "notice", text: "已压缩" },
  ]);
});

test("时间线标题与文件路径进入搜索源", () => {
  const drafts = extractSearchable({ type: "timelineRestore", presentation: presentation() });
  assert.deepEqual(drafts.map((draft) => draft.text), ["探索代码库", "src/auth/router.ts"]);
  assert.deepEqual(drafts[1]?.anchor, { turnId: "turn-1", groupId: "g1" });
});

test("隐藏工具输出与内部标签不进搜索源", () => {
  assert.deepEqual(extractSearchable({ type: "toolOutput", toolCallId: "t1", text: "私密 stdout" }), []);
  assert.deepEqual(
    extractSearchable({
      type: "toolStarted",
      toolCallId: "t1",
      kind: "read",
      label: "Read",
      readOnly: true,
    }),
    [],
  );
  assert.deepEqual(extractSearchable({ type: "activity", message: "正在分析……" }), []);
});

test("模型私有推理不在搜索源中：Presentation 层不产出思考内容", () => {
  const drafts = extractSearchable({ type: "timelineRestore", presentation: presentation() });
  for (const draft of drafts) {
    assert.equal(draft.field, "timeline");
    assert.equal(/思考|thought|reasoning/i.test(draft.text), false);
  }
});

test("findMatches 按顺序返回全部命中", () => {
  const records: SearchableRecord[] = [
    { unitIndex: 0, field: "user", text: "router router" },
    { unitIndex: 1, field: "assistant", text: "没有关键字" },
    { unitIndex: 2, field: "timeline", text: "src/auth/router.ts" },
  ];
  const matches = findMatches(records, "ROUTER");
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map((match) => match.record.unitIndex), [0, 0, 2]);
  assert.equal(findMatches(records, "   ").length, 0);
});

// —— 查找条 ——

test("搜索用户消息与 Agent 回复", () => {
  const harness = createHarness();
  harness.view.appendUserMessage("帮我看看 router 的问题");
  harness.view.mountAssistant("router 的注册在 src/auth/router.ts");

  harness.query("router");
  assert.equal(harness.search.matchCount, 3);
  assert.equal(harness.count.textContent, "1 / 3");
});

test("上一个和下一个循环跳转", () => {
  const harness = createHarness();
  harness.view.appendUserMessage("router A");
  harness.view.appendUserMessage("router B");
  harness.query("router");

  assert.equal(harness.search.currentIndex, 0);
  harness.next.dispatchEvent(new harness.window.Event("click"));
  assert.equal(harness.search.currentIndex, 1);
  harness.next.dispatchEvent(new harness.window.Event("click"));
  assert.equal(harness.search.currentIndex, 0, "到底后回到第一个");
  harness.previous.dispatchEvent(new harness.window.Event("click"));
  assert.equal(harness.search.currentIndex, 1, "向前越界时回到最后一个");
});

test("无结果时给出明确提示", () => {
  const harness = createHarness();
  harness.view.appendUserMessage("只有中文内容");
  harness.query("router");

  assert.equal(harness.search.matchCount, 0);
  assert.equal(harness.count.textContent, "未找到匹配内容");
  assert.equal(harness.next.disabled, true);
});

test("关闭查找条后清除高亮并恢复滚动位置", () => {
  const harness = createHarness();
  harness.view.appendUserMessage("router 在这里");
  harness.messages.scrollTop = 120;
  harness.query("router");
  assert.equal(harness.inner.querySelectorAll(".search-hit").length, 1);

  harness.messages.scrollTop = 0;
  harness.search.hide();
  assert.equal(harness.inner.querySelectorAll(".search-hit").length, 0);
  assert.equal(harness.bar.hidden, true);
  assert.equal(harness.messages.scrollTop, 120);
});

test("命中折叠的时间线分组时临时展开", () => {
  const harness = createHarness();
  harness.view.restoreTimeline(presentation());
  const group = harness.inner.querySelector<HTMLDetailsElement>("details.tl-group");
  assert.equal(group?.open, false, "时间线分组默认折叠");

  harness.query("src/auth/router.ts");
  assert.equal(harness.search.matchCount, 1);
  assert.equal(group?.open, true, "命中后应展开对应分组");
});

test("命中未加载的更早分页时按需补渲染", () => {
  const harness = createHarness();
  const texts = Array.from(
    { length: 40 },
    (_, index) => (index === 0 ? "最早的 router 记录" : `普通第 ${index} 条`),
  );
  const units: RenderUnit[] = texts.map((text) => () => harness.view.appendRow("notice info", text));
  // 恢复流程会先按单元写入可搜内容，再分页渲染。
  harness.view.seedSearchable(texts.map((text) => [{ field: "notice", text }]));
  harness.view.renderHistory(units, 10);
  assert.equal(harness.inner.textContent?.includes("最早的 router 记录"), false, "首条应仍未渲染");
  assert.equal(harness.view.searchableRecords().length, 40, "未渲染的历史也要可搜");

  harness.query("最早的 router");
  assert.equal(harness.search.matchCount, 1);
  assert.ok(harness.inner.textContent?.includes("最早的 router 记录"), "命中后应补渲染包含目标的分页");
  assert.ok(harness.inner.querySelector(".history-page"));
});

test("按需补渲染是逐页进行，不是一次铺开全部历史", () => {
  const harness = createHarness();
  const texts = Array.from(
    { length: 40 },
    (_, index) => (index === 25 ? "目标 router 记录" : `普通第 ${index} 条`),
  );
  const units: RenderUnit[] = texts.map((text) => () => harness.view.appendRow("notice info", text));
  harness.view.seedSearchable(texts.map((text) => [{ field: "notice", text }]));
  harness.view.renderHistory(units, 10);

  const record = harness.view.searchableRecords().find((entry) => entry.text === "目标 router 记录");
  harness.view.revealRecord(record!, 10);
  // pending 从 30 降到 20 即可覆盖下标 25，不该继续往前加载。
  assert.equal(harness.inner.querySelectorAll(".history-page").length, 1);
  assert.equal(harness.inner.textContent?.includes("普通第 0 条"), false, "更早的分页仍未加载");
});

test("Enter 与 Shift+Enter 在查找条内前后跳转，Escape 关闭", () => {
  const harness = createHarness();
  harness.view.appendUserMessage("router A");
  harness.view.appendUserMessage("router B");
  harness.query("router");

  harness.input.dispatchEvent(new harness.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  assert.equal(harness.search.currentIndex, 1);
  harness.input.dispatchEvent(
    new harness.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true }),
  );
  assert.equal(harness.search.currentIndex, 0);
  harness.input.dispatchEvent(new harness.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  assert.equal(harness.bar.hidden, true);
});

test("时间线增量事件的搜索锚点回到挂载时的单元", () => {
  const harness = createHarness();
  harness.view.appendUserMessage("先说一句");
  harness.view.applyTimelineTurn({
    sessionId: "ses-1",
    turnId: "turn-9",
    status: "running",
    startedAt: 1_000,
  });
  const mountUnit = Number(
    (harness.inner.querySelector<HTMLElement>(".timeline")?.dataset.unit) ?? "-1",
  );
  harness.view.appendRow("notice info", "后来的提示");
  harness.view.applyTimelineGroup("turn-9", {
    id: "g1",
    kind: "editing",
    title: "修改代码",
    status: "running",
    startedAt: 1_000,
  });

  const record = harness.view.searchableRecords().find((entry) => entry.text === "修改代码");
  assert.ok(record, "分组标题应进入搜索源");
  assert.equal(record!.unitIndex, mountUnit, "锚点必须是时间线挂载时的单元");
});

test("恢复的历史消息带有与分页一致的单元下标", () => {
  const harness = createHarness();
  const units: RenderUnit[] = [
    () => harness.view.appendUserMessage("第一条 router"),
    () => harness.view.mountAssistant("第二条 router"),
  ];
  harness.view.seedSearchable([
    [{ field: "user", text: "第一条 router" }],
    [{ field: "assistant", text: "第二条 router" }],
  ]);
  harness.view.renderHistory(units, 10);

  const records = harness.view.searchableRecords();
  assert.deepEqual(records.map((record) => record.unitIndex), [0, 1]);
  assert.deepEqual(
    Array.from(harness.inner.querySelectorAll<HTMLElement>("[data-unit]")).map((node) => node.dataset.unit),
    ["0", "1"],
  );
});
