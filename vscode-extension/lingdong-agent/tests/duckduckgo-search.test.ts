import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSearchLimit,
  formatSearchHits,
  parseDuckDuckGoHtml,
  searchDuckDuckGo,
  WebSearchError,
} from "../src/web-search/duckduckgo-search";

const FIXTURE = `
<html><body><form>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjimeng">即梦 2.5 发布</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjimeng">官方宣布即梦 2.5 上线。</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://news.example.org/a">第二条新闻</a>
    </h2>
    <a class="result__snippet" href="https://news.example.org/a">摘要二</a>
  </div>
</div>
</form></body></html>
`;

test("clampSearchLimit 默认 5、上限 10", () => {
  assert.equal(clampSearchLimit(undefined), 5);
  assert.equal(clampSearchLimit(0), 1);
  assert.equal(clampSearchLimit(99), 10);
  assert.equal(clampSearchLimit(3.7), 3);
});

test("parseDuckDuckGoHtml 解析标题、展开 uddg、截断 limit", () => {
  const hits = parseDuckDuckGoHtml(FIXTURE, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.title, "即梦 2.5 发布");
  assert.equal(hits[0]?.url, "https://example.com/jimeng");
  assert.match(hits[0]?.snippet ?? "", /官方宣布/);

  const both = parseDuckDuckGoHtml(FIXTURE, 5);
  assert.equal(both.length, 2);
  assert.equal(both[1]?.url, "https://news.example.org/a");
});

test("formatSearchHits 空结果给出明确文案", () => {
  assert.match(formatSearchHits("foo", []), /未找到/);
  const text = formatSearchHits("即梦", parseDuckDuckGoHtml(FIXTURE, 2));
  assert.match(text, /共 2 条/);
  assert.match(text, /https:\/\/example\.com\/jimeng/);
});

test("searchDuckDuckGo 走注入的 fetch，空 query 抛错", async () => {
  await assert.rejects(
    () => searchDuckDuckGo({ query: "  " }),
    (error: unknown) => error instanceof WebSearchError,
  );

  const hits = await searchDuckDuckGo({
    query: "即梦2.5",
    limit: 2,
    fetch: async () => new Response(FIXTURE, { status: 200 }),
  });
  assert.equal(hits.length, 2);
});

test("searchDuckDuckGo 非 2xx 与超时有明确错误", async () => {
  await assert.rejects(
    () => searchDuckDuckGo({
      query: "x",
      fetch: async () => new Response("nope", { status: 503 }),
    }),
    /HTTP 503/,
  );

  await assert.rejects(
    () => searchDuckDuckGo({
      query: "x",
      timeoutMs: 20,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    }),
    /超时/,
  );
});
