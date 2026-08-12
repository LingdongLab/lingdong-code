import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  collapseDuplicatePlanMarkdown,
  createStreamingAssistant,
  fallbackSanitize,
  friendlyRecoveryMessage,
  isDisplayNoise,
  looksLikePlanOutline,
  mountAssistantMessage,
  productizeToolLabel,
  renderMarkdownToHtml,
  setSanitizeFn,
} from "../src/webview/message-renderer";

setSanitizeFn(fallbackSanitize);

test("标题 Markdown 渲染", () => {
  const html = renderMarkdownToHtml("## 现状摘要\n\n正文");
  assert.match(html, /<h2>/);
  assert.match(html, /现状摘要/);
  assert.equal(html.includes("##"), false);
});

test("粗体和行内代码", () => {
  const html = renderMarkdownToHtml("这是 **粗体** 与 `code`");
  assert.match(html, /<strong>/);
  assert.match(html, /<code>/);
  assert.equal(html.includes("**"), false);
});

test("代码块", () => {
  const html = renderMarkdownToHtml("```ts\nconst a = 1;\n```");
  assert.match(html, /<pre/);
  assert.match(html, /const a = 1/);
  assert.match(html, /data-language="ts"/);
});

test("表格", () => {
  const html = renderMarkdownToHtml("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>/);
});

test("列表与任务列表", () => {
  const list = renderMarkdownToHtml("- 一项\n- 二项");
  assert.match(list, /<ul>/);
  const tasks = renderMarkdownToHtml("- [x] 完成\n- [ ] 待办");
  assert.match(tasks, /checkbox/);
  assert.match(tasks, /checked/);
});

test("HTML 注入拦截", () => {
  const html = renderMarkdownToHtml('你好 <script>alert(1)</script> **世界**');
  assert.equal(html.toLowerCase().includes("<script"), false);
  assert.match(html, /世界/);
});

test("javascript URL 拦截", () => {
  const dirty = '<a href="javascript:alert(1)">x</a>';
  const clean = fallbackSanitize(dirty);
  assert.equal(/javascript:/i.test(clean), false);
});

test("流式 Markdown 更新只改当前消息", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  (globalThis as { document?: Document; window?: Window; navigator?: Navigator }).document = dom.window.document;
  (globalThis as { window?: Window }).window = dom.window as unknown as Window;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

  const root = dom.window.document.getElementById("root")!;
  const stream = createStreamingAssistant(root, { paintIntervalMs: 20 });
  stream.append("## A\n");
  stream.append("hello");
  assert.equal(root.querySelectorAll(".assistant-msg").length, 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.match(stream.body.innerHTML, /<h2>/);
  const hist = mountAssistantMessage(root, "历史 **消息**");
  assert.equal(root.querySelectorAll(".assistant-msg").length, 2);
  stream.append(" more");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(hist.querySelector(".md-body")?.innerHTML.includes("历史"), true);
  stream.finalize();
  stream.dispose();
});

/**
 * 上游成串下发时的出字节奏。
 * 之前这里是防抖：每个分片都把已排好的重绘取消重排，分片一直来就一直不画，
 * 非要等一个够长的空档才整段吐出来——界面上就是一卡一卡。
 */
test("分片连续到达时按节奏出字，不会整串攒着不画", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  (globalThis as { document?: Document; window?: Window; navigator?: Navigator }).document = dom.window.document;
  (globalThis as { window?: Window }).window = dom.window as unknown as Window;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

  const root = dom.window.document.getElementById("root")!;
  const stream = createStreamingAssistant(root, { paintIntervalMs: 20 });

  // 每 5ms 来一个分片，持续 120ms：间隔远小于重绘间隔，正是防抖会饿死的情形。
  for (let index = 0; index < 24; index += 1) {
    stream.append("字");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Markdown 渲染会带一个块末换行，这里只看正文。
  const painted = (stream.body.textContent ?? "").trim();
  assert.ok(painted.length > 0, "整串期间必须已经出过字");
  assert.ok(
    painted.length >= 12,
    `按 20ms 一次的节奏，120ms 内该画出大部分内容，实际只有 ${painted.length} 个字`,
  );
  assert.ok(painted.length <= 24, "也不该超过已经收到的量");

  stream.finalize();
  assert.equal(stream.body.textContent?.trim(), "字".repeat(24), "收尾必须补齐全部内容");
  stream.dispose();
});

test("第一个分片立即出字，不用先等一个间隔", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  (globalThis as { document?: Document; window?: Window; navigator?: Navigator }).document = dom.window.document;
  (globalThis as { window?: Window }).window = dom.window as unknown as Window;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

  const root = dom.window.document.getElementById("root")!;
  const stream = createStreamingAssistant(root, { paintIntervalMs: 500 });
  stream.append("开");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(stream.body.textContent?.includes("开"), true, "首字不该被节流挡住");
  stream.dispose();
});

test("语法高亮只在终稿跑：流式中间帧不高亮，finalize 后高亮", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  (globalThis as { document?: Document; window?: Window; navigator?: Navigator }).document = dom.window.document;
  (globalThis as { window?: Window }).window = dom.window as unknown as Window;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

  const root = dom.window.document.getElementById("root")!;
  const stream = createStreamingAssistant(root, { paintIntervalMs: 10 });
  stream.append("```ts\nconst a = 1;\n```\n");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(stream.body.querySelector("pre code"), "代码块已渲染");
  assert.equal(stream.body.querySelector("code.hljs"), null, "流式中间帧不应高亮");

  stream.finalize();
  const code = stream.body.querySelector("pre code") as HTMLElement;
  assert.equal(code.dataset.hljs, "1", "终稿必须高亮");
  assert.ok(code.querySelector("span") !== null, "高亮应产生 token span");
  stream.dispose();
});

test("mount 的历史消息直接带高亮", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  (globalThis as { document?: Document }).document = dom.window.document;
  const root = mountAssistantMessage(
    dom.window.document.getElementById("root")!,
    "```python\ndef hello():\n    return 1\n```",
  );
  const code = root.querySelector("pre code") as HTMLElement;
  assert.equal(code.dataset.hljs, "1");
});

test("历史消息不重复渲染：mount 一次即可", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  const root = dom.window.document.getElementById("root")!;
  mountAssistantMessage(root, "# 一次");
  mountAssistantMessage(root, "# 二次");
  assert.equal(root.querySelectorAll(".assistant-msg").length, 2);
  assert.equal(root.querySelectorAll("h1").length, 2);
});

/**
 * 「灵动 Code」署名的出现规则。
 * 一轮里可能有十几条正文夹着工具卡，每条都顶一个表头就成了噪音；但下一轮开始时
 * 又必须重新署名，否则分不清哪句是回答哪一次提问。
 */
test("助手表头只在轮次首条出现，下一轮重新出现", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  (globalThis as { document?: Document }).document = dom.window.document;
  const root = dom.window.document.getElementById("root")!;

  const userMessage = (): void => {
    const row = dom.window.document.createElement("div");
    row.className = "message user";
    root.appendChild(row);
  };
  const toolCard = (): void => {
    const card = dom.window.document.createElement("div");
    card.className = "card tool-card";
    root.appendChild(card);
  };
  const headers = (): number => root.querySelectorAll(".assistant-header").length;

  userMessage();
  const first = mountAssistantMessage(root, "第一段");
  assert.equal(headers(), 1, "轮次首条要署名");

  // 中间插工具卡不算新轮次：署名不该因为一次读文件就重来。
  toolCard();
  const second = mountAssistantMessage(root, "第二段");
  assert.equal(headers(), 1);
  assert.equal(second.classList.contains("assistant-continued"), true);
  assert.equal(first.classList.contains("assistant-continued"), false);

  userMessage();
  const nextTurn = mountAssistantMessage(root, "下一轮");
  assert.equal(headers(), 2, "新一轮要重新署名");
  assert.equal(nextTurn.classList.contains("assistant-continued"), false);
});

test("流式消息接在同轮正文之后时不再署名", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  (globalThis as { document?: Document; window?: Window }).document = dom.window.document;
  (globalThis as { window?: Window }).window = dom.window as unknown as Window;
  const root = dom.window.document.getElementById("root")!;

  mountAssistantMessage(root, "已有正文");
  const stream = createStreamingAssistant(root, { paintIntervalMs: 20 });

  assert.equal(root.querySelectorAll(".assistant-header").length, 1);
  assert.equal(stream.root.classList.contains("assistant-continued"), true);
  stream.dispose();
});

test("Plan 大纲识别与折叠", () => {
  const outline = [
    "## 实施计划",
    "",
    "1. 补充测试",
    "2. 抽出服务",
    "3. 调整路由",
    "4. 回归路径",
    "",
    "涉及文件：",
    "- a.ts",
  ].join("\n");
  assert.equal(looksLikePlanOutline(outline), true);
  assert.equal(looksLikePlanOutline("只是普通建议，没有步骤列表。"), false);

  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  const root = mountAssistantMessage(dom.window.document.getElementById("root")!, outline);
  let clicked = false;
  collapseDuplicatePlanMarkdown(root, () => {
    clicked = true;
  });
  assert.equal(root.classList.contains("plan-collapsed"), true);
  assert.match(root.textContent ?? "", /查看计划/);
  root.querySelector("button")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(clicked, true);
});

test("Read / List Files 中文化", () => {
  assert.equal(productizeToolLabel("Read", "read").title, "已读取");
  assert.equal(productizeToolLabel("List Files", "other").title, "查看项目文件");
  assert.equal(productizeToolLabel("Run Command", "execute").title, "已执行命令");
  assert.equal(productizeToolLabel("Ask User").title, "需要确认");
  assert.equal(productizeToolLabel("read_file", "read").raw, "read_file");
});

test("展示噪声与恢复文案", () => {
  assert.equal(isDisplayNoise("会话已就绪：ses-abcdef123456"), true);
  assert.equal(isDisplayNoise("已完成 · deepseek-v4-flash"), true);
  assert.equal(isDisplayNoise("这是用户可读提示"), false);
  assert.equal(friendlyRecoveryMessage("transcript restore failed"), "历史记录恢复失败，已使用最近备份。");
});

/**
 * 收窄正文的 CSS 只认两种形状：`.md-body > p` 和 `.md-body > .md-block > p`。
 * 只断言变量值不够——上一版就是变量都对、选择器却一个都没命中，正文照样铺满整栏。
 * 这里拿真实渲染出来的 DOM 去比对选择器。
 */
const PROSE_SELECTOR = [
  ".md-body > :is(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6)",
  ".md-body > .md-block > :is(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6)",
].join(",");

const PROSE_SAMPLE = [
  "第一段正文，需要被收窄到 --prose-max。",
  "",
  "- 列表项一",
  "- 列表项二",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "## 小标题",
  "",
  "结尾一段正文。",
].join("\n");

function installRendererDom(): Document {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  for (const [key, value] of Object.entries({
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  return dom.window.document;
}

/** 渲染结果里没被选择器覆盖的正文块。 */
function unmatchedProse(root: HTMLElement): string[] {
  const body = root.querySelector(".md-body");
  if (!body) return ["缺少 .md-body"];
  const blocks = [...body.querySelectorAll("p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6")];
  return blocks
    .filter((node) => !node.matches(PROSE_SELECTOR))
    .map((node) => `${node.tagName.toLowerCase()}（父链：${parentChain(node)}）`);
}

function parentChain(node: Element): string {
  const names: string[] = [];
  for (let cursor = node.parentElement; cursor; cursor = cursor.parentElement) {
    names.push(cursor.className || cursor.tagName.toLowerCase());
    if (cursor.classList.contains("md-body")) break;
  }
  return names.reverse().join(" > ");
}

test("历史回放的正文块都能被 --prose-max 选择器命中", () => {
  const document = installRendererDom();
  const parent = document.getElementById("root") as HTMLElement;
  const root = mountAssistantMessage(parent, PROSE_SAMPLE);
  assert.deepEqual(unmatchedProse(root), []);
});

test("流式渲染的正文块都能被 --prose-max 选择器命中", () => {
  const document = installRendererDom();
  const parent = document.getElementById("root") as HTMLElement;
  const handle = createStreamingAssistant(parent, {});
  handle.rawMarkdown = PROSE_SAMPLE;
  handle.finalize();
  assert.deepEqual(unmatchedProse(handle.root), []);
});

test("阅读宽度只有 CSS 一份真相：正文与卡片共用同一档", async () => {
  // 以前 message-renderer 里还有个 ASSISTANT_MAX_WIDTH_PX 常量，跟 CSS 变量是两份值，
  // 谁改了另一边都不会报错。现在只认样式表。
  const css = await readFile(
    new URL("../src/webview/main.css", import.meta.url),
    "utf8",
  );
  const read = Number(/--read-max:\s*(\d+)px/.exec(css)?.[1]);
  assert.ok(read >= 700 && read <= 860, `--read-max 超出预期：${read}`);
  // 正文曾经单独窄一档，滚动时左右边缘忽宽忽窄比每行长几个字更伤眼；现在锁死到同一个值。
  assert.match(
    css,
    /--prose-max:\s*var\(--read-max\)/,
    "--prose-max 必须跟随 --read-max，不得再独立取一个 px 值",
  );
});
