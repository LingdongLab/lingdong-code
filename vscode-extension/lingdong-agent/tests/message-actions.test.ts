import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  attachMessageActions,
  createUserMessage,
  markStopped,
} from "../src/webview/message-actions";

function installDom(): Document {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  const { window } = dom;
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Event", { value: window.Event, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  return window.document;
}

function actionLabels(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".msg-action")].map((node) => node.textContent ?? "");
}

test("用户消息带复制与重新发送，正文与操作条分开存放", () => {
  installDom();
  const row = createUserMessage("请分析登录流程", { onResend: () => undefined });

  assert.equal(row.querySelector(".msg-text")?.textContent, "请分析登录流程");
  assert.deepEqual(actionLabels(row), ["复制", "重新发送"]);
  // 操作条不能污染正文，否则复制会带上按钮文字。
  assert.equal(row.querySelector(".msg-text")?.textContent?.includes("复制"), false);
});

test("点击重新发送把原文回传给宿主", () => {
  installDom();
  const sent: string[] = [];
  const row = createUserMessage("重跑一次", { onResend: (text) => sent.push(text) });
  row.querySelector<HTMLButtonElement>("[data-action=\"retry\"]")?.click();
  assert.deepEqual(sent, ["重跑一次"]);
});

test("复制取的是原始 Markdown，而不是渲染后的文本", async () => {
  installDom();
  const copied: string[] = [];
  const root = document.createElement("article");
  root.className = "message assistant-msg";
  root.dataset.rawMarkdown = "# 标题\n\n- 一\n- 二";
  root.innerHTML += "<div class=\"md-body\"><h1>标题</h1></div>";

  attachMessageActions(root, {
    getText: () => root.dataset.rawMarkdown ?? "",
    copy: (text) => {
      copied.push(text);
      return Promise.resolve(true);
    },
  });
  root.querySelector<HTMLButtonElement>("[data-action=\"copy\"]")?.click();
  await Promise.resolve();

  assert.deepEqual(copied, ["# 标题\n\n- 一\n- 二"]);
});

test("复制成功后按钮给出反馈并复位", async () => {
  installDom();
  const root = document.createElement("div");
  attachMessageActions(root, {
    getText: () => "x",
    copy: () => Promise.resolve(true),
    resetDelayMs: 5,
  });
  const button = root.querySelector<HTMLButtonElement>("[data-action=\"copy\"]");
  button?.click();
  await Promise.resolve();
  assert.equal(button?.textContent, "已复制");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(button?.textContent, "复制");
});

test("复制失败时给出失败反馈而不是假装成功", async () => {
  installDom();
  const root = document.createElement("div");
  attachMessageActions(root, {
    getText: () => "x",
    copy: () => Promise.resolve(false),
    resetDelayMs: 5,
  });
  const button = root.querySelector<HTMLButtonElement>("[data-action=\"copy\"]");
  button?.click();
  await Promise.resolve();
  assert.equal(button?.textContent, "复制失败");
});

test("没有 onRetry 时只渲染复制按钮", () => {
  installDom();
  const root = document.createElement("div");
  attachMessageActions(root, { getText: () => "x" });
  assert.deepEqual(actionLabels(root), ["复制"]);
});

test("重复挂载不会叠加出第二条操作条", () => {
  installDom();
  const root = document.createElement("div");
  attachMessageActions(root, { getText: () => "x" });
  attachMessageActions(root, { getText: () => "x" });
  assert.equal(root.querySelectorAll(".msg-actions").length, 1);
});

test("停止标记幂等，且带 stopped 类名", () => {
  installDom();
  const root = document.createElement("div");
  markStopped(root);
  markStopped(root);
  assert.equal(root.querySelectorAll(".msg-stopped").length, 1);
  assert.equal(root.querySelector(".msg-stopped")?.textContent, "已停止生成");
  assert.ok(root.classList.contains("stopped"));
});
