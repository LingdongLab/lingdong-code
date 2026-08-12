import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ContextItemView, WebviewToHostMessage } from "../src/messages";
import { createAppState, type AppElements, type AppState } from "../src/webview/app-context";
import { COMPACT_BAR_WIDTH, ComposerView } from "../src/webview/composer";

/**
 * Composer 外围：上下文 chips、用量圆环数字、窄面板紧凑态、空输入 ↑ 召回、粘贴图片。
 * 这些都是「面板一窄就出洋相」的地方，所以断言集中在收缩与降级路径上。
 */

function installDom(): Document {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Node: window.Node,
    File: window.File,
    FileReader: window.FileReader,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  return window.document;
}

interface Harness {
  composer: ComposerView;
  state: AppState;
  posts: WebviewToHostMessage[];
  notices: string[];
  el: AppElements;
  contextItems: HTMLElement;
}

function createHarness(): Harness {
  const document = installDom();
  const input = document.createElement("textarea");
  const contextItems = document.createElement("div");
  const usageLabel = document.createElement("button");
  const usagePct = document.createElement("span");
  const composerBar = document.createElement("div");
  const plusMenu = document.createElement("div");
  usageLabel.innerHTML = "<svg><circle class=\"usage-ring-value\" r=\"7\"></circle></svg>";
  document.body.append(input, contextItems, usageLabel, usagePct, composerBar, plusMenu);

  const state = createAppState();
  const posts: WebviewToHostMessage[] = [];
  const notices: string[] = [];
  const el = { input, contextItems, usageLabel, usagePct, composerBar, plusMenu } as unknown as AppElements;
  const composer = new ComposerView({
    el,
    state,
    post: (message) => posts.push(message),
    notice: (text) => notices.push(text),
    openWorkbenchTool: () => undefined,
    onSend: () => undefined,
  });
  return { composer, state, posts, notices, el, contextItems };
}

/** jsdom 的 FileReader 慢得不稳定，固定 sleep 会偶发失败，这里改成轮询。 */
async function waitForPost(
  harness: Harness,
  type: WebviewToHostMessage["type"],
): Promise<WebviewToHostMessage | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = harness.posts.find((message) => message.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

function item(patch: Partial<ContextItemView> & { id: string }): ContextItemView {
  return { type: "file", label: patch.id, size: 100, truncated: false, ...patch };
}

test("上下文 chips 带类型图标与行号范围", () => {
  const harness = createHarness();
  harness.state.contextItems = [
    item({ id: "c1", type: "selection", label: "src/a.ts", lineRange: { start: 10, end: 24 } }),
    item({ id: "c2", type: "terminal", label: "终端输出 30 行" }),
  ];
  harness.composer.renderContextChips();

  const chips = [...harness.contextItems.querySelectorAll(".context-chip")];
  assert.equal(chips.length, 2);
  assert.equal(chips[0]?.querySelector(".context-chip-lines")?.textContent, ":10-24");
  assert.equal(chips[1]?.querySelector(".context-chip-lines"), null);
  const icons = chips.map((chip) => chip.querySelector(".context-chip-icon")?.textContent);
  assert.notEqual(icons[0], icons[1]);
});

test("超过四项折成 +N，点开展开、再点收起", () => {
  const harness = createHarness();
  harness.state.contextItems = Array.from({ length: 7 }, (_, index) => item({ id: `c${index}` }));
  harness.composer.renderContextChips();

  assert.equal(harness.contextItems.querySelectorAll(".context-chip").length, 4);
  const more = harness.contextItems.querySelector<HTMLButtonElement>(".context-chip-more");
  assert.equal(more?.textContent, "+3");

  more?.click();
  assert.equal(harness.contextItems.querySelectorAll(".context-chip").length, 7);
  assert.equal(harness.contextItems.querySelector(".context-chip-more")?.textContent, "收起");

  harness.contextItems.querySelector<HTMLButtonElement>(".context-chip-more")?.click();
  assert.equal(harness.contextItems.querySelectorAll(".context-chip").length, 4);
});

test("上下文为空时整块 chips 隐藏", () => {
  const harness = createHarness();
  harness.state.contextItems = [];
  harness.composer.renderContextChips();
  assert.equal(harness.contextItems.hidden, true);
});

test("用量到警戒线才在圆环旁写数字", () => {
  const harness = createHarness();
  const usage = {
    percentage: 82,
    usedTokens: 82_000,
    contextLimit: 100_000,
    source: "exact" as const,
    level: "warning" as const,
    compactCapability: "available" as const,
  };
  harness.state.usage = { ...usage } as AppState["usage"];
  harness.composer.paintUsageChip();
  assert.equal(harness.el.usagePct.hidden, false);
  assert.equal(harness.el.usagePct.textContent, "82%");
  assert.equal(harness.el.usageLabel.classList.contains("with-number"), true);

  harness.state.usage = { ...usage, percentage: 20, level: "normal" } as AppState["usage"];
  harness.composer.paintUsageChip();
  assert.equal(harness.el.usagePct.hidden, true);
  assert.equal(harness.el.usageLabel.classList.contains("with-number"), false);
});

test("底条够窄就进紧凑态，宽回来再恢复", () => {
  const harness = createHarness();
  harness.composer.applyCompact(COMPACT_BAR_WIDTH - 1);
  assert.equal(harness.el.composerBar.classList.contains("compact"), true);
  harness.composer.applyCompact(COMPACT_BAR_WIDTH + 100);
  assert.equal(harness.el.composerBar.classList.contains("compact"), false);
  // 尚未布局（宽度为 0）时不要抢先进紧凑态。
  harness.composer.applyCompact(0);
  assert.equal(harness.el.composerBar.classList.contains("compact"), false);
});

test("空输入按 ↑ 依次召回历史，↓ 走回空", () => {
  const harness = createHarness();
  harness.state.canSend = true;
  harness.el.input.value = "第一条";
  harness.composer.submit();
  harness.el.input.value = "第二条";
  harness.composer.submit();

  assert.equal(harness.composer.recallPrompt("up"), true);
  assert.equal(harness.el.input.value, "第二条");
  assert.equal(harness.composer.recallPrompt("up"), true);
  assert.equal(harness.el.input.value, "第一条");
  // 到头了就停在最早那条，不要空掉用户正在编辑的内容。
  assert.equal(harness.composer.recallPrompt("up"), true);
  assert.equal(harness.el.input.value, "第一条");

  assert.equal(harness.composer.recallPrompt("down"), true);
  assert.equal(harness.el.input.value, "第二条");
  assert.equal(harness.composer.recallPrompt("down"), true);
  assert.equal(harness.el.input.value, "");
});

test("输入框里有内容时 ↑ 不抢光标", () => {
  const harness = createHarness();
  harness.state.canSend = true;
  harness.el.input.value = "已发送";
  harness.composer.submit();
  harness.el.input.value = "正在写的半句";
  assert.equal(harness.composer.recallPrompt("up"), false);
  assert.equal(harness.el.input.value, "正在写的半句");
});

test("模型能看图时把图片字节发给宿主；非图片不拦截", async () => {
  const harness = createHarness();
  harness.state.capabilities.imagesConfigured = true;
  const png = new File(["fake"], "shot.png", { type: "image/png" });
  const text = new File(["hello"], "a.txt", { type: "text/plain" });
  assert.equal(harness.composer.handleImageDrop([text]), false);
  assert.equal(harness.composer.handleImageDrop([png]), true);
  assert.deepEqual(harness.notices, []);

  // FileReader 是异步的，图片要等读完才上抛。
  const posted = await waitForPost(harness, "addImageContext");
  assert.ok(posted && posted.type === "addImageContext");
  assert.equal(posted.name, "shot.png");
  assert.ok(posted.dataUrl.startsWith("data:image/png;base64,"));
});

test("＋菜单「图片…」走本地选文件入口", () => {
  const harness = createHarness();
  harness.state.capabilities.imagesConfigured = true;
  harness.composer.renderPlusMenu();
  const item = harness.el.plusMenu.querySelector<HTMLButtonElement>('button[data-action="pickImage"]');
  assert.ok(item);
  assert.equal(item.textContent, "图片…");
});

test("MIME 为空但扩展名是图片时仍按看图附件处理（Snipaste / Windows 拖拽）", async () => {
  const harness = createHarness();
  harness.state.capabilities.imagesConfigured = true;
  const snip = new File(["fake"], "snipaste20260805_130000.png", { type: "" });
  assert.equal(harness.composer.handleImageDrop([snip]), true);
  const posted = await waitForPost(harness, "addImageContext");
  assert.ok(posted && posted.type === "addImageContext");
  assert.equal(posted.name, "snipaste20260805_130000.png");
  // FileReader 在 type 为空时会写成 octet-stream，必须改回 image/* 才能过宿主校验。
  assert.ok(posted.dataUrl.startsWith("data:image/png;base64,"));
});

test("模型不能看图时明确拒绝，且不把字节发出去", async () => {
  const harness = createHarness();
  harness.state.capabilities.imagesConfigured = false;
  harness.state.capabilities.hasVisionModel = true;

  // 仍然返回 true：不接管的话图片文件名会被当文本插进输入框。
  assert.equal(harness.composer.handleImageDrop([new File(["fake"], "shot.png", { type: "image/png" })]), true);
  assert.equal(harness.notices.length, 1);
  assert.ok(harness.notices[0]?.includes("换一个支持看图的模型"));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.posts.some((message) => message.type === "addImageContext"), false);
});

test("一个能看图的模型都没有时，提示去模型中心加", () => {
  const harness = createHarness();
  harness.state.capabilities.imagesConfigured = false;
  harness.state.capabilities.hasVisionModel = false;

  harness.composer.handleImageDrop([new File(["fake"], "shot.png", { type: "image/png" })]);

  assert.ok(harness.notices[0]?.includes("模型中心"));
});
