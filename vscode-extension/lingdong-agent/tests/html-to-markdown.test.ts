import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractMarkdownTitle, htmlToMarkdown } from "../src/webview/plan/html-to-markdown";

function rootFrom(html: string): HTMLElement {
  const dom = new JSDOM(`<!DOCTYPE html><div id="root">${html}</div>`);
  return dom.window.document.getElementById("root")!;
}

test("标题段落与加粗", () => {
  const md = htmlToMarkdown(rootFrom("<h2>目标</h2><p>拆分<strong>会话</strong>服务</p>"));
  assert.match(md, /^## 目标$/m);
  assert.match(md, /拆分\*\*会话\*\*服务/);
});

test("表格与代码块", () => {
  const md = htmlToMarkdown(rootFrom(`
    <div class="table-scroll"><table>
      <tr><th>项</th><th>现状</th></tr>
      <tr><td>字号</td><td>13px</td></tr>
    </table></div>
    <div class="code-block">
      <div class="code-block-bar"><span class="code-lang">ts</span><button class="code-copy">复制</button></div>
      <pre>const a = 1;</pre>
    </div>
  `));
  assert.match(md, /\| 项 \| 现状 \|/);
  assert.match(md, /\| ---- \| ---- \|/);
  assert.match(md, /\| 字号 \| 13px \|/);
  assert.match(md, /```ts\nconst a = 1;\n```/);
  assert.doesNotMatch(md, /复制/);
});

test("extractMarkdownTitle", () => {
  assert.equal(extractMarkdownTitle("# 登录系统改造\n\n正文"), "登录系统改造");
});
