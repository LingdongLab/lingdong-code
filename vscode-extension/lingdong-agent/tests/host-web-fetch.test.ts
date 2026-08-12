/**
 * 宿主侧网页抓取。
 *
 * 这个工具是为了替掉模型自己去跑 `curl ... | Select-Object` —— 那条路每次都要过审批弹窗。
 * 但它把一个任意出网入口交到了模型手上，所以地址校验和截断行为都要有用例守着。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  clampMaxChars,
  decodeEntities,
  extractTitle,
  fetchPage,
  formatFetchedPage,
  htmlToText,
  normalizeFetchUrl,
  WebFetchError,
} from "../src/web-search/host-web-fetch";

function html(body: string, title = "示例页面"): string {
  return `<!DOCTYPE html><html><head><title>${title}</title>`
    + `<style>.a{color:red}</style></head><body>${body}</body></html>`;
}

function respond(text: string, contentType = "text/html; charset=utf-8"): Response {
  return new Response(text, { status: 200, headers: { "content-type": contentType } });
}

test("内网、回环与云元数据地址一律拒绝", () => {
  const blocked = [
    "http://localhost:8080/admin",
    "http://127.0.0.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.5/",
    "http://172.31.255.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://box.local/",
    "http://svc.internal/",
    "http://[::1]/",
    "http://[fd00::1]/",
  ];
  for (const url of blocked) {
    assert.throws(() => normalizeFetchUrl(url), WebFetchError, `应拒绝 ${url}`);
  }
});

test("公网地址与合法协议放行，其余协议拒绝", () => {
  assert.equal(normalizeFetchUrl("https://www.oiloil.org/").hostname, "www.oiloil.org");
  assert.equal(normalizeFetchUrl(" http://example.com/a?b=1 ").protocol, "http:");
  // 172.32 已经出了 172.16/12 的范围，属于公网。
  assert.equal(normalizeFetchUrl("http://172.32.0.1/").hostname, "172.32.0.1");

  assert.throws(() => normalizeFetchUrl("file:///C:/Windows/win.ini"), WebFetchError);
  assert.throws(() => normalizeFetchUrl("ftp://example.com/x"), WebFetchError);
  assert.throws(() => normalizeFetchUrl("javascript:alert(1)"), WebFetchError);
  assert.throws(() => normalizeFetchUrl(""), WebFetchError);
  assert.throws(() => normalizeFetchUrl("不是网址"), WebFetchError);
});

test("HTML 转文本：丢掉脚本样式导航，保留段落结构", () => {
  const text = htmlToText(html(
    "<nav>首页 关于</nav><h1>大标题</h1><p>第一段。</p>"
    + "<script>var a=1;</script><ul><li>要点一</li><li>要点二</li></ul>"
    + "<footer>版权所有</footer>",
  ));

  assert.match(text, /大标题/);
  assert.match(text, /第一段。/);
  assert.match(text, /- 要点一/);
  assert.equal(text.includes("var a=1"), false, "脚本内容必须丢掉");
  assert.equal(text.includes("color:red"), false, "样式内容必须丢掉");
  assert.equal(text.includes("版权所有"), false, "页脚不是正文");
  assert.equal(/\n{3,}/.test(text), false, "空行要收敛");
});

test("实体解码覆盖命名与数字两种写法", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot;"), 'a & b <c> "d"');
  assert.equal(decodeEntities("&#20013;&#x6587;"), "中文");
  assert.equal(decodeEntities("&nbsp;x"), " x");
  // 认不出的实体原样留着，不要吞掉内容。
  assert.equal(decodeEntities("&notarealentity;"), "&notarealentity;");
});

test("标题从 <title> 取，缺失时为空", () => {
  assert.equal(extractTitle(html("<p>x</p>", "灵动  Agent")), "灵动 Agent");
  assert.equal(extractTitle("<html><body>没有标题</body></html>"), "");
});

test("maxChars 有上下限，超长正文截断并说明", async () => {
  assert.equal(clampMaxChars(undefined), 20_000);
  assert.equal(clampMaxChars(10), 500);
  assert.equal(clampMaxChars(999_999), 50_000);

  const long = "内容".repeat(2_000);
  const page = await fetchPage({
    url: "https://example.com/",
    maxChars: 500,
    fetch: (async () => respond(html(`<p>${long}</p>`))) as typeof fetch,
  });

  assert.equal(page.truncated, true);
  assert.equal(page.text.length, 500);
  assert.match(formatFetchedPage(page), /正文已截断/);
  assert.match(formatFetchedPage(page), /来源：https:\/\/example\.com/);
});

test("非 HTML 的纯文本与 JSON 原样返回", async () => {
  const page = await fetchPage({
    url: "https://example.com/api",
    fetch: (async () => respond('{"ok":true}', "application/json")) as typeof fetch,
  });
  assert.equal(page.text, '{"ok":true}');
  assert.equal(page.title, "");
  assert.equal(page.truncated, false);
});

test("二进制内容、HTTP 错误与超时都给出能看懂的原因", async () => {
  await assert.rejects(
    fetchPage({
      url: "https://example.com/x.png",
      fetch: (async () => respond("\u0089PNG", "image/png")) as typeof fetch,
    }),
    (error: unknown) => error instanceof WebFetchError && /二进制/.test(error.message),
  );

  await assert.rejects(
    fetchPage({
      url: "https://example.com/missing",
      fetch: (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as typeof fetch,
    }),
    (error: unknown) => error instanceof WebFetchError && /404/.test(error.message),
  );

  await assert.rejects(
    fetchPage({
      url: "https://example.com/slow",
      timeoutMs: 10,
      fetch: ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as unknown as typeof fetch,
    }),
    (error: unknown) => error instanceof WebFetchError && /超时/.test(error.message),
  );
});

test("整页没有文字时说明原因，而不是回一段空白", async () => {
  const page = await fetchPage({
    url: "https://example.com/spa",
    fetch: (async () => respond(html("<div id=\"root\"></div>"))) as typeof fetch,
  });
  assert.equal(page.text, "");
  assert.match(formatFetchedPage(page), /没有可提取的文字/);
});
