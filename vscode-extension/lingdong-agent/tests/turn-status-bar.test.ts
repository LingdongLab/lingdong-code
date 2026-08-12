import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { TurnStatusBar } from "../src/webview/turn-status-bar";

function harness() {
  const dom = new JSDOM(`<!DOCTYPE html>
    <div id="root" hidden>
      <span id="label"></span>
      <span id="elapsed"></span>
      <div id="summary"></div>
      <div id="actions"></div>
    </div>`);
  const { document } = dom.window;
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  const actions: string[] = [];
  const bar = new TurnStatusBar({
    el: {
      root: document.getElementById("root")!,
      label: document.getElementById("label")!,
      elapsed: document.getElementById("elapsed")!,
      summary: document.getElementById("summary")!,
      actions: document.getElementById("actions")!,
    },
    onReconnect: () => actions.push("reconnect"),
    onRetry: () => actions.push("retry"),
    onViewChanges: () => actions.push("changes"),
    now: () => 0,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  return { bar, document, actions };
}

test("全局状态只显示一份：Status Bar 渲染主状态文案", () => {
  const { bar, document } = harness();
  bar.apply({
    status: "working",
    label: "正在探索代码库…",
    activeElapsedMs: 26_000,
    showElapsed: true,
    visible: true,
    canStop: true,
    connectionActions: false,
  });
  assert.equal(document.getElementById("root")!.hidden, false);
  assert.equal(document.getElementById("label")!.textContent, "正在探索代码库…");
  assert.equal(document.getElementById("elapsed")!.textContent, "26s");
});

test("interrupted 只在状态栏给连接动作", () => {
  const { bar, document, actions } = harness();
  bar.apply({
    status: "interrupted",
    label: "连接中断",
    activeElapsedMs: 0,
    showElapsed: false,
    visible: true,
    canStop: false,
    connectionActions: true,
  });
  const buttons = Array.from(document.querySelectorAll(".turn-status-action")).map((b) => b.textContent);
  assert.deepEqual(buttons, ["重新连接", "重试本轮"]);
  (document.querySelector(".turn-status-action") as HTMLButtonElement).click();
  assert.deepEqual(actions, ["reconnect"]);
});

test("静默够久才提示，且不掩盖总耗时", () => {
  const { bar, document } = harness();
  const base = {
    status: "thinking",
    label: "思考中…",
    activeElapsedMs: 90_000,
    showElapsed: true,
    visible: true,
    canStop: true,
    connectionActions: false,
  };

  bar.apply({ ...base, silentMs: 5_000 });
  assert.equal(
    document.querySelectorAll(".turn-status-summary-line").length,
    0,
    "刚静几秒不该提示：首个 token 之前静一会儿是常态",
  );

  bar.apply({ ...base, silentMs: 45_000 });
  assert.equal(
    document.querySelector(".turn-status-summary-line")?.textContent,
    "已 45 秒没有新输出",
  );

  bar.apply({ ...base, silentMs: 130_000 });
  assert.equal(
    document.querySelector(".turn-status-summary-line")?.textContent,
    "已 2 分 10 秒没有新输出",
  );
});

test("等用户回卡片时不提示静默：那时候等的是人", () => {
  const { bar, document } = harness();
  bar.apply({
    status: "waiting_for_user",
    label: "等待你的确认",
    activeElapsedMs: 30_000,
    showElapsed: false,
    visible: true,
    canStop: true,
    connectionActions: false,
    // 卡片挂了十分钟没人理，这不是模型的问题，别拿它吓唬用户。
    silentMs: 600_000,
  });
  assert.equal(document.querySelectorAll(".turn-status-summary-line").length, 0);
});

test("completed 摘要：只保留测试通过，不重复文件行与查看文件", () => {
  const { bar, document } = harness();
  bar.apply({
    status: "completed",
    label: "已完成",
    activeElapsedMs: 10_000,
    showElapsed: false,
    visible: true,
    canStop: false,
    connectionActions: false,
    summary: { filesChanged: 2, testsPassed: 12 },
  });
  const lines = Array.from(document.querySelectorAll(".turn-status-summary-line")).map((n) => n.textContent);
  assert.deepEqual(lines, ["12 项测试通过"]);
  assert.equal(document.querySelectorAll(".turn-status-action").length, 0);
});

test("completed 仅有文件改动时隐藏状态栏（交给会话流变更卡）", () => {
  const { bar, document } = harness();
  bar.apply({
    status: "completed",
    label: "已完成",
    activeElapsedMs: 10_000,
    showElapsed: false,
    visible: true,
    canStop: false,
    connectionActions: false,
    summary: { filesChanged: 1 },
  });
  assert.equal(document.getElementById("root")!.hidden, true);
  assert.equal(document.querySelectorAll(".turn-status-action").length, 0);
});
