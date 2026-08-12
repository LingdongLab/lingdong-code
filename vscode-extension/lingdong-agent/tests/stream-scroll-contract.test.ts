import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ActivityGroupHeader } from "../src/presentation/activity-group";
import type { ActivityItem } from "../src/presentation/activity-item";
import type { TurnPresentationHeader } from "../src/presentation/turn-presentation";
import {
  createStreamingAssistant,
  fallbackSanitize,
  mountAssistantMessage,
  setSanitizeFn,
} from "../src/webview/message-renderer";
import { TimelineView } from "../src/webview/timeline/timeline-view";

setSanitizeFn(fallbackSanitize);

function installDom(html = "<!DOCTYPE html><div id=\"root\"></div><div id=\"conv\"></div>") {
  const dom = new JSDOM(html);
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    MutationObserver: window.MutationObserver,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  return window.document;
}

test("流式期间历史 message DOM 节点 identity 不变", async () => {
  const document = installDom();
  const root = document.getElementById("root")!;
  const hist = mountAssistantMessage(root, "历史段落");
  const histBody = hist.querySelector(".md-body")!;
  const stream = createStreamingAssistant(root, { paintIntervalMs: 40 });
  for (let i = 0; i < 8; i += 1) {
    stream.append(`delta${i} `);
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hist.querySelector(".md-body"), histBody, "历史容器必须是同一节点");
  stream.finalize();
  stream.dispose();
});

test("单窗口注入 20 个 delta，DOM 更新次数 ≤ 2", async () => {
  const document = installDom();
  const root = document.getElementById("root")!;
  let paints = 0;
  const stream = createStreamingAssistant(root, {
    paintIntervalMs: 80,
    onPaint: (final) => { if (!final) paints += 1; },
  });

  for (let i = 0; i < 20; i += 1) stream.append("字");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(paints <= 2, `50–100ms 窗口内应合帧，实际 ${paints} 次`);
  stream.dispose();
});

test("Timeline item 更新不触发 conversation 容器 mutation", () => {
  const document = installDom("<!DOCTYPE html><div id=\"conv\"></div><div id=\"tl-host\"></div>");
  const conv = document.getElementById("conv")!;
  const host = document.getElementById("tl-host")!;
  conv.appendChild(document.createElement("article")).textContent = "对话";

  let convMutations = 0;
  const observer = new MutationObserver(() => { convMutations += 1; });
  observer.observe(conv, { childList: true, subtree: true, characterData: true });

  const view = new TimelineView({
    mount: (node) => { host.appendChild(node); },
    onShowLog: () => undefined,
  });
  const turn: TurnPresentationHeader = {
    sessionId: "s1",
    turnId: "t1",
    status: "running",
    startedAt: 1,
  };
  const group: ActivityGroupHeader = {
    id: "g1",
    kind: "exploration",
    title: "探索代码库",
    status: "running",
    startedAt: 1,
  };
  const item: ActivityItem = {
    id: "i1",
    toolCallId: "c1",
    action: "read",
    target: "a.ts",
    status: "running",
    startedAt: 1,
  };
  view.applyTurn(turn);
  view.applyGroup("t1", group);
  view.applyItem("t1", "g1", item);
  view.applyItem("t1", "g1", { ...item, status: "completed", completedAt: 2 });

  observer.disconnect();
  assert.equal(convMutations, 0, "Timeline 更新不得改写 conversation 容器");
});
