import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ChangeListView } from "../src/change-view";
import { MessageRouter, type RouterDeps } from "../src/webview/message-router";
import type { AppElements, AppState } from "../src/webview/app-context";
import { createAppState } from "../src/webview/app-context";

function view(): ChangeListView {
  return {
    turnId: "turn-1",
    turnIndex: 1,
    title: "本轮修改了 1 个文件",
    status: "completed",
    statusLabel: "已完成",
    rows: [{
      changeId: "chg-1",
      relativePath: "a.md",
      kind: "modify",
      letter: "M",
      kindLabel: "修改",
      status: "pending",
      statusLabel: "待处理",
      restorable: true,
    }],
    pending: 1,
    accepted: 0,
    restored: 0,
    conflicts: 0,
    canAcceptAll: true,
    canRejectAll: true,
    canUndo: true,
  };
}

function harness(opts: { streaming?: boolean; busy?: boolean; turnActive?: boolean }) {
  const dom = new JSDOM(`<!DOCTYPE html><div id="messages-inner"></div>`);
  const { document } = dom.window;
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const state = createAppState() as AppState;
  state.busy = opts.busy ?? false;
  state.turnActive = opts.turnActive ?? false;
  state.canApplyChanges = true;
  state.canRestoreChanges = true;

  const messagesInner = document.getElementById("messages-inner")!;
  const appended: HTMLElement[] = [];

  const conversation = {
    isStreaming: opts.streaming ?? false,
    sealStreaming() { /* no-op */ },
    finishThinking() { /* no-op */ },
    noteStopRequested() { /* no-op */ },
    appendNode(node: HTMLElement) {
      messagesInner.appendChild(node);
      appended.push(node);
      return node;
    },
  };

  const el = {
    messagesInner,
  } as unknown as AppElements;

  const deps = {
    el,
    state,
    post: () => undefined,
    conversation,
    composer: { updateChrome() { /* */ } },
    plan: {},
    workbench: {},
    refreshTool() { /* */ },
    turnStatus: { apply() { /* */ }, status: "idle" },
    todo: {},
    requestFiles() { /* */ },
    onSuggestResults() { /* */ },
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), state, messagesInner, appended, conversation };
}

test("流式中收到 changes：不插卡，只记 pending", () => {
  const { router, messagesInner } = harness({ streaming: true, busy: true, turnActive: true });
  router.apply({ type: "changes", view: view() });
  assert.equal(messagesInner.querySelectorAll("[data-change-summary]").length, 0);
});

test("空列表不落卡：纯问答那一轮不该出现「0 个文件已修改」", () => {
  const { router, messagesInner } = harness({});
  router.apply({ type: "changes", view: { ...view(), rows: [], pending: 0 } });
  assert.equal(messagesInner.querySelectorAll("[data-change-summary]").length, 0);
  assert.equal(messagesInner.textContent?.includes("0 个文件已修改"), false);
});

test("回合结束后 flush：变更卡挂在会话末尾", () => {
  const h = harness({ streaming: true, busy: true, turnActive: true });
  h.router.apply({ type: "changes", view: view() });
  assert.equal(h.messagesInner.querySelectorAll("[data-change-summary]").length, 0);

  h.conversation.isStreaming = false;
  h.state.busy = false;
  h.state.turnActive = false;
  h.router.apply({ type: "busy", busy: false });

  const cards = h.messagesInner.querySelectorAll("[data-change-summary]");
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.textContent?.includes("a.md"), true);
});
