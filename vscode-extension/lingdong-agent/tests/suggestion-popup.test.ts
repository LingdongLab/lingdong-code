import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { CandidateGroup } from "../src/composer/context-candidate";
import type { ContextItemView, WebviewToHostMessage } from "../src/messages";
import type { AppElements, AppState } from "../src/webview/app-context";
import { createAppState } from "../src/webview/app-context";
import { ComposerView } from "../src/webview/composer";
import { ContextSuggestions } from "../src/webview/composer/context-suggestions";

interface Harness {
  document: Document;
  input: HTMLTextAreaElement;
  root: HTMLElement;
  chips: HTMLElement;
  suggestions: ContextSuggestions;
  composer: ComposerView;
  state: AppState;
  sent: WebviewToHostMessage[];
  type(value: string): Promise<void>;
  key(key: string, init?: KeyboardEventInit): boolean;
  items(): HTMLButtonElement[];
  active(): string | undefined;
}

const WORKSPACE_GROUP: CandidateGroup = {
  id: "workspace",
  title: "工作区文件",
  candidates: [
    { id: "c1", source: "file", label: "router.ts", detail: "src/auth/router.ts", group: "workspace" },
    { id: "c2", source: "file", label: "router.test.ts", detail: "tests/router.test.ts", group: "workspace" },
  ],
};

const QUICK_GROUP: CandidateGroup = {
  id: "quick",
  title: "快捷上下文",
  candidates: [
    { id: "q-current-file", source: "current-file", label: "当前文件", detail: "src/app.ts", group: "quick" },
    {
      id: "q-selection",
      source: "selection",
      label: "选中代码",
      group: "quick",
      disabledReason: "当前没有选中内容",
    },
  ],
};

function createHarness(): Harness {
  const dom = new JSDOM(`<!DOCTYPE html>
    <div id="composer-shell">
      <div id="context-suggest" hidden></div>
      <div class="chips chips-empty" id="context-items" hidden></div>
      <textarea id="input"></textarea>
    </div>`);
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Node: window.Node,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }

  const document = window.document;
  const input = document.getElementById("input") as HTMLTextAreaElement;
  const root = document.getElementById("context-suggest") as HTMLElement;
  const chips = document.getElementById("context-items") as HTMLElement;
  const sent: WebviewToHostMessage[] = [];
  const state = createAppState();
  const suggestions = new ContextSuggestions({
    input,
    root,
    post: (message) => sent.push(message),
    debounceMs: 0,
  });
  const composer = new ComposerView({
    el: { contextItems: chips, input } as unknown as AppElements,
    state,
    post: (message) => sent.push(message),
    notice: () => undefined,
    openWorkbenchTool: () => undefined,
    onSend: () => undefined,
  });

  return {
    document,
    input,
    root,
    chips,
    suggestions,
    composer,
    state,
    sent,
    async type(value: string) {
      input.value = value;
      input.selectionStart = value.length;
      input.selectionEnd = value.length;
      suggestions.handleInput();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    key(key: string, init: KeyboardEventInit = {}) {
      const event = new window.KeyboardEvent("keydown", { key, cancelable: true, ...init });
      return suggestions.handleKeydown(event);
    },
    items: () => Array.from(root.querySelectorAll<HTMLButtonElement>(".suggest-item")),
    active: () => root.querySelector<HTMLButtonElement>(".suggest-item.active")?.dataset.id,
  };
}

test("输入 @ 后向宿主发出候选查询", async () => {
  const harness = createHarness();
  await harness.type("@");
  assert.deepEqual(harness.sent, [{ type: "contextSuggestQuery", query: "" }]);
});

test("宿主回包后打开浮层，禁用项灰显并说明原因", async () => {
  const harness = createHarness();
  await harness.type("@");
  harness.suggestions.applyResults("", [QUICK_GROUP, WORKSPACE_GROUP], false);

  assert.equal(harness.root.hidden, false);
  assert.equal(harness.items().length, 4);
  const disabled = harness.items().find((item) => item.dataset.id === "q-selection");
  assert.equal(disabled?.disabled, true);
  assert.match(disabled?.textContent ?? "", /当前没有选中内容/);
  assert.equal(harness.active(), "q-current-file", "默认选中第一个可用项");
});

test("逐字过滤：查询串与当前 token 不一致的回包被丢弃", async () => {
  const harness = createHarness();
  await harness.type("@router");
  assert.deepEqual(harness.sent.at(-1), { type: "contextSuggestQuery", query: "router" });

  harness.suggestions.applyResults("rou", [WORKSPACE_GROUP], false);
  assert.equal(harness.root.hidden, true, "过期结果不应打开浮层");

  harness.suggestions.applyResults("router", [WORKSPACE_GROUP], false);
  assert.equal(harness.items().length, 2);
});

test("上下方向键在可用项之间循环", async () => {
  const harness = createHarness();
  await harness.type("@");
  harness.suggestions.applyResults("", [QUICK_GROUP, WORKSPACE_GROUP], false);

  assert.equal(harness.key("ArrowDown"), true);
  assert.equal(harness.active(), "c1", "跳过禁用的选中代码");
  harness.key("ArrowDown");
  assert.equal(harness.active(), "c2");
  harness.key("ArrowDown");
  assert.equal(harness.active(), "q-current-file", "到底后回到第一项");
  harness.key("ArrowUp");
  assert.equal(harness.active(), "c2");
});

test("Enter 确认后回传 candidateId 并摘掉 @token", async () => {
  const harness = createHarness();
  harness.input.value = "看下 @router";
  harness.input.selectionStart = harness.input.value.length;
  harness.input.selectionEnd = harness.input.value.length;
  harness.suggestions.handleInput();
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.suggestions.applyResults("router", [WORKSPACE_GROUP], false);

  assert.equal(harness.key("Enter"), true);
  assert.deepEqual(harness.sent.at(-1), {
    type: "contextSuggestSelect",
    candidateId: "c1",
    sourceType: "file",
  });
  assert.equal(harness.input.value, "看下 ", "确认后输入框里不再留 @token");
  assert.equal(harness.root.hidden, true);
});

test("Tab 与 Enter 等效", async () => {
  const harness = createHarness();
  await harness.type("@router");
  harness.suggestions.applyResults("router", [WORKSPACE_GROUP], false);

  assert.equal(harness.key("Tab"), true);
  assert.equal((harness.sent.at(-1) as { type: string }).type, "contextSuggestSelect");
});

test("Escape 关闭浮层并把焦点交回输入框", async () => {
  const harness = createHarness();
  await harness.type("@");
  harness.suggestions.applyResults("", [WORKSPACE_GROUP], false);

  assert.equal(harness.key("Escape"), true);
  assert.equal(harness.root.hidden, true);
  assert.equal(harness.document.activeElement, harness.input);
  // 关闭后按键不再被吃掉，Enter 恢复为发送。
  assert.equal(harness.key("Enter"), false);
});

test("截断时在浮层底部提示，而不是刷聊天通知", async () => {
  const harness = createHarness();
  await harness.type("@r");
  harness.suggestions.applyResults("r", [WORKSPACE_GROUP], true);

  const footer = harness.root.querySelector(".suggest-footer");
  assert.match(footer?.textContent ?? "", /仅显示前 2 项/);
  // 截断提示留在浮层里；打字过程中不应额外向宿主发消息刷聊天提示。
  assert.deepEqual(
    new Set(harness.sent.map((message) => message.type)),
    new Set(["contextSuggestQuery"]),
  );
});

test("浮层只显示相对路径", async () => {
  const harness = createHarness();
  await harness.type("@");
  harness.suggestions.applyResults("", [WORKSPACE_GROUP], false);

  for (const item of harness.items()) {
    const text = item.textContent ?? "";
    assert.equal(/[A-Za-z]:[\\/]/.test(text), false, `不应出现绝对路径：${text}`);
  }
  assert.match(harness.root.textContent ?? "", /src\/auth\/router\.ts/);
});

test("离开 @token 后浮层自动关闭", async () => {
  const harness = createHarness();
  await harness.type("@rou");
  harness.suggestions.applyResults("rou", [WORKSPACE_GROUP], false);
  assert.equal(harness.root.hidden, false);

  await harness.type("@rou 之后继续写");
  assert.equal(harness.root.hidden, true);
});

test("没有上下文时不渲染空 chip 容器", () => {
  const harness = createHarness();
  harness.state.contextItems = [];
  harness.composer.renderContextChips();

  assert.equal(harness.chips.hidden, true);
  assert.equal(harness.chips.childElementCount, 0);
  assert.ok(harness.chips.classList.contains("chips-empty"));
});

test("选择后生成正确的上下文 chip", () => {
  const harness = createHarness();
  const item: ContextItemView = {
    id: "ctx-1",
    type: "file",
    label: "src/auth/router.ts",
    detail: "",
    size: 120,
    truncated: false,
  } as unknown as ContextItemView;
  harness.state.contextItems = [item];
  harness.composer.renderContextChips();

  assert.equal(harness.chips.hidden, false);
  assert.equal(harness.chips.childElementCount, 1);
  // 「@」换成了文件类型图标，路径本身仍要完整可读。
  assert.equal(harness.chips.querySelector(".context-chip-text")?.textContent, "src/auth/router.ts");
  assert.ok((harness.chips.querySelector(".context-chip-icon")?.textContent ?? "").length > 0);
  assert.equal(harness.chips.classList.contains("chips-empty"), false);
});
