import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  IncrementalMarkdownBody,
  isOpenFence,
  splitMarkdownBlocks,
} from "../src/webview/incremental-markdown";

function installDom(): Document {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"body\"></div>");
  const { window } = dom;
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, configurable: true });
  return window.document;
}

/** 用可识别的假渲染，断言「哪些块被重新渲染过」。 */
function createView(): {
  body: HTMLElement;
  view: IncrementalMarkdownBody;
  renders: string[];
} {
  const document = installDom();
  const body = document.getElementById("body") as HTMLElement;
  const renders: string[] = [];
  const view = new IncrementalMarkdownBody(body, {
    renderHtml: (source) => {
      renders.push(source);
      return `<p>${source}</p>`;
    },
  });
  return { body, view, renders };
}

test("按空行切分顶层块", () => {
  const blocks = splitMarkdownBlocks("第一段\n\n第二段\n\n第三段");
  assert.deepEqual(blocks, ["第一段", "第二段", "第三段"]);
});

test("围栏代码块内部的空行不切分", () => {
  const raw = "说明\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n结尾";
  const blocks = splitMarkdownBlocks(raw);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1]?.includes("const b = 2;"), "代码块应整体保留");
});

test("未闭合的围栏在流式中间也算一个块", () => {
  const blocks = splitMarkdownBlocks("开头\n\n```ts\nconst a = 1;");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1], "```ts\nconst a = 1;");
});

test("松散列表与表格不会被拆成多个块", () => {
  const list = splitMarkdownBlocks("- 一\n\n- 二\n\n结尾");
  assert.equal(list.length, 2);
  assert.equal(list[0], "- 一\n\n- 二");

  const table = splitMarkdownBlocks("| a | b |\n| - | - |\n\n| 1 | 2 |");
  assert.equal(table.length, 1);
});

test("流式追加只重绘最后一个块", () => {
  const { view, renders } = createView();
  view.update("第一段\n\n第二段");
  assert.deepEqual(renders, ["第一段", "第二段"]);

  renders.length = 0;
  view.update("第一段\n\n第二段继续");
  assert.deepEqual(renders, ["第二段继续"], "前面的稳定块不应重新渲染");
});

test("已渲染的块 DOM 节点在追加时保持同一个实例", () => {
  const { body, view } = createView();
  view.update("第一段\n\n第二");
  const first = body.children[0];
  view.update("第一段\n\n第二段\n\n第三段");
  assert.equal(body.children[0], first, "首块 DOM 不应被重建");
  assert.equal(body.children.length, 3);
});

test("内容未变化时不产生任何渲染", () => {
  const { view, renders } = createView();
  view.update("稳定内容");
  renders.length = 0;
  view.update("稳定内容");
  assert.deepEqual(renders, []);
});

test("块变少时移除多余节点", () => {
  const { body, view } = createView();
  view.update("一\n\n二\n\n三");
  assert.equal(body.children.length, 3);
  view.update("一");
  assert.equal(body.children.length, 1);
  assert.deepEqual([...view.blocks], ["一"]);
});

test("isOpenFence 识别未闭合围栏", () => {
  assert.equal(isOpenFence("```ts\nconst a = 1;"), true);
  assert.equal(isOpenFence("```ts\nconst a = 1;\n```"), false);
  assert.equal(isOpenFence("普通段落"), false);
  assert.equal(isOpenFence("~~~\ntext"), true);
});

/** 围栏专用的假渲染：围栏块渲染成 pre>code，其余渲染成段落。 */
function createFenceView(): {
  body: HTMLElement;
  view: IncrementalMarkdownBody;
  renders: string[];
} {
  const document = installDom();
  const body = document.getElementById("body") as HTMLElement;
  const renders: string[] = [];
  const view = new IncrementalMarkdownBody(body, {
    renderHtml: (source) => {
      renders.push(source);
      if (source.startsWith("```")) {
        const code = source.split("\n").slice(1).join("\n");
        return `<pre><code>${code}</code></pre>`;
      }
      return `<p>${source}</p>`;
    },
  });
  return { body, view, renders };
}

test("流式围栏尾块只更新 code 文本，不整块重建", () => {
  const { body, view, renders } = createFenceView();
  view.update("说明\n\n```ts\nconst a = 1;");
  const pre = body.querySelector("pre");
  const code = body.querySelector("pre > code");
  assert.ok(pre && code);

  renders.length = 0;
  view.update("说明\n\n```ts\nconst a = 1;\nconst b = 2;");
  assert.deepEqual(renders, [], "围栏增长期间不应重新渲染任何块");
  assert.equal(body.querySelector("pre"), pre, "pre 节点必须保持同一个实例");
  assert.equal(code?.textContent, "const a = 1;\nconst b = 2;\n");
});

test("围栏闭合那一帧整块重绘，拿到完整终稿渲染", () => {
  const { body, view, renders } = createFenceView();
  view.update("```ts\nconst a = 1;");
  renders.length = 0;
  view.update("```ts\nconst a = 1;\n```");
  assert.deepEqual(renders, ["```ts\nconst a = 1;\n```"]);
  assert.equal(body.querySelectorAll("pre").length, 1);
});

test("开栏行（语言标注）变化时重建以刷新语言标签", () => {
  const { view, renders } = createFenceView();
  view.update("```py");
  renders.length = 0;
  view.update("```python\nimport os");
  assert.deepEqual(renders, ["```python\nimport os"], "语言标注变化必须走整块重绘");
});
