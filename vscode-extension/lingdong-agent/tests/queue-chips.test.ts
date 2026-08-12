import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { WebviewToHostMessage } from "../src/messages";
import { createAppState, type AppElements, type AppState } from "../src/webview/app-context";
import { ComposerView } from "../src/webview/composer";

/**
 * 忙时发送队列（阶段 C，webview 侧）：
 * - busy 时 submit 不再静默丢弃，照常上抛 sendPrompt（宿主负责入队）；
 * - 队列 chips 渲染：删除常在，空闲时出现「立即发送」。
 */

function installDom(): Document {
  const dom = new JSDOM(`<!DOCTYPE html><div id="host"></div>`);
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    KeyboardEvent: window.KeyboardEvent,
    Node: window.Node,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  return window.document;
}

interface Harness {
  composer: ComposerView;
  state: AppState;
  posts: WebviewToHostMessage[];
  sent: string[];
  input: HTMLTextAreaElement;
  queueChips: HTMLElement;
}

/** ComposerView 只需要 input 与 queueChips 两个元素即可覆盖提交与队列 chips 路径。 */
function createHarness(): Harness {
  const document = installDom();
  const input = document.createElement("textarea");
  const queueChips = document.createElement("div");
  document.body.append(input, queueChips);
  const state = createAppState();
  const posts: WebviewToHostMessage[] = [];
  const sent: string[] = [];
  const composer = new ComposerView({
    el: { input, queueChips } as unknown as AppElements,
    state,
    post: (message) => posts.push(message),
    notice: () => undefined,
    openWorkbenchTool: () => undefined,
    onSend: (text) => sent.push(text),
  });
  return { composer, state, posts, sent, input, queueChips };
}

test("busy 时 submit 照常上抛并清空输入框，不再静默丢弃", () => {
  const harness = createHarness();
  harness.state.busy = true;
  harness.state.canSend = false;
  harness.input.value = "  排队的消息  ";
  harness.composer.submit();
  assert.deepEqual(harness.sent, ["排队的消息"]);
  assert.equal(harness.input.value, "");
});

test("既不可发送也不忙（如初始化中）时仍然拦截", () => {
  const harness = createHarness();
  harness.state.busy = false;
  harness.state.canSend = false;
  harness.input.value = "还没连上";
  harness.composer.submit();
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.input.value, "还没连上");
});

test("队列 chips：忙时只有删除，空闲时出现「立即发送」", () => {
  const harness = createHarness();
  harness.state.sendQueue = [
    { id: "q1", text: "第一条排队消息" },
    { id: "q2", text: "第二条" },
  ];

  harness.state.busy = true;
  harness.composer.renderQueueChips();
  assert.equal(harness.queueChips.hidden, false);
  assert.equal(harness.queueChips.querySelectorAll(".queue-chip").length, 2);
  assert.equal(harness.queueChips.querySelectorAll(".queue-chip-send").length, 0);

  harness.state.busy = false;
  harness.composer.renderQueueChips();
  assert.equal(harness.queueChips.querySelectorAll(".queue-chip-send").length, 2);

  // 删除与立即发送分别上抛 queueRemove / queueFlush。
  (harness.queueChips.querySelector(".queue-chip-remove") as HTMLButtonElement).click();
  (harness.queueChips.querySelectorAll(".queue-chip-send")[1] as HTMLButtonElement).click();
  assert.deepEqual(harness.posts, [
    { type: "queueRemove", id: "q1" },
    { type: "queueFlush", id: "q2" },
  ]);
});

test("点文本进入编辑态，回车上抛 queueEdit", () => {
  const harness = createHarness();
  harness.state.sendQueue = [{ id: "q1", text: "原始文案" }];
  harness.state.busy = true;
  harness.composer.renderQueueChips();

  (harness.queueChips.querySelector(".queue-chip-text") as HTMLButtonElement).click();
  const editor = harness.queueChips.querySelector(".queue-chip-edit") as HTMLInputElement;
  assert.ok(editor, "点文本后应出现输入框");
  editor.value = "改好的文案";
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  assert.deepEqual(harness.posts, [{ type: "queueEdit", id: "q1", text: "改好的文案" }]);
});

test("文本未变或清空不发编辑消息", () => {
  const harness = createHarness();
  harness.state.sendQueue = [{ id: "q1", text: "不变" }];
  harness.state.busy = true;
  harness.composer.renderQueueChips();
  (harness.queueChips.querySelector(".queue-chip-text") as HTMLButtonElement).click();
  const editor = harness.queueChips.querySelector(".queue-chip-edit") as HTMLInputElement;
  editor.value = "   不变  ";
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  assert.deepEqual(harness.posts, []);
});

test("↑/↓ 重排上抛 queueReorder，端点按钮禁用", () => {
  const harness = createHarness();
  harness.state.sendQueue = [
    { id: "q1", text: "一" },
    { id: "q2", text: "二" },
    { id: "q3", text: "三" },
  ];
  harness.state.busy = true;
  harness.composer.renderQueueChips();

  const moves = Array.from(harness.queueChips.querySelectorAll<HTMLButtonElement>(".queue-chip-move"));
  // 第一条的 ↑ 与最后一条的 ↓ 应禁用。
  assert.equal(moves[0]?.disabled, true, "首条不能上移");
  assert.equal(moves.at(-1)?.disabled, true, "末条不能下移");

  // 把第二条下移：它的 ↓ 是第二个 chip 的第二个 move 按钮。
  const secondDown = harness.queueChips.querySelectorAll(".queue-chip")[1]!
    .querySelectorAll<HTMLButtonElement>(".queue-chip-move")[1]!;
  secondDown.click();
  assert.deepEqual(harness.posts, [{ type: "queueReorder", orderedIds: ["q1", "q3", "q2"] }]);
});

test("编辑态不显示「立即发送」，其余条目不受影响", () => {
  const harness = createHarness();
  harness.state.sendQueue = [
    { id: "q1", text: "一" },
    { id: "q2", text: "二" },
  ];
  harness.state.busy = false;
  harness.composer.renderQueueChips();
  (harness.queueChips.querySelectorAll(".queue-chip-text")[0] as HTMLButtonElement).click();
  const chips = harness.queueChips.querySelectorAll(".queue-chip");
  assert.equal(chips[0]!.querySelector(".queue-chip-send"), null, "编辑中的条目不给立即发送");
  assert.ok(chips[1]!.querySelector(".queue-chip-send"), "其它条目照常");
});

test("队列清空后 chips 隐藏", () => {
  const harness = createHarness();
  harness.state.sendQueue = [{ id: "q1", text: "一条" }];
  harness.composer.renderQueueChips();
  assert.equal(harness.queueChips.hidden, false);
  harness.state.sendQueue = [];
  harness.composer.renderQueueChips();
  assert.equal(harness.queueChips.hidden, true);
});
