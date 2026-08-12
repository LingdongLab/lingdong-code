import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  isSetupActionId,
  parseWebviewMessage,
  SETUP_ACTION_IDS,
} from "../src/messages";
import { ConversationView } from "../src/webview/conversation";

test("SETUP_ACTION_IDS 覆盖配置密钥 / 选 Grok / 导入凭据", () => {
  assert.ok(SETUP_ACTION_IDS.includes("configureProviderKey"));
  assert.ok(SETUP_ACTION_IDS.includes("locateGrok"));
  assert.ok(SETUP_ACTION_IDS.includes("importLegacyKey"));
  assert.equal(isSetupActionId("configureProviderKey"), true);
  assert.equal(isSetupActionId("not-a-real-action"), false);
});

test("setupAction 消息只接受白名单 id", () => {
  assert.deepEqual(parseWebviewMessage({ type: "setupAction", action: "locateGrok" }), {
    type: "setupAction",
    action: "locateGrok",
  });
  assert.equal(parseWebviewMessage({ type: "setupAction", action: "rm -rf /" }), undefined);
  assert.equal(parseWebviewMessage({ type: "setupAction" }), undefined);
});

test("对话 notice 带内联按钮，点击后发 setupAction 并收拢", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"messages\"><div id=\"messages-inner\"><div id=\"empty\"></div></div></div>");
  const { window } = dom;
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  Object.defineProperty(globalThis, "window", { value: window.document.defaultView, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Event", { value: window.Event, configurable: true });

  const posted: unknown[] = [];
  const messages = window.document.getElementById("messages")!;
  const messagesInner = window.document.getElementById("messages-inner")!;
  const empty = window.document.getElementById("empty")!;
  const view = new ConversationView({
    el: { messages: messages as HTMLElement, messagesInner: messagesInner as HTMLElement, empty: empty as HTMLElement },
    post: (message) => { posted.push(message); },
    canSend: () => true,
    onOpenLink: () => undefined,
    onOpenFile: () => undefined,
    onViewPlan: () => undefined,
  });

  view.appendRow("notice error", "未找到 Grok Build 可执行文件。", [
    { id: "locateGrok", label: "选择可执行文件…" },
    { id: "dismiss", label: "稍后" },
  ]);

  const buttons = [...messagesInner.querySelectorAll("button")];
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0]?.textContent, "选择可执行文件…");
  buttons[0]?.click();
  assert.deepEqual(posted, [{ type: "setupAction", action: "locateGrok" }]);
  assert.ok(messagesInner.querySelector(".card-collapsed"));
});
