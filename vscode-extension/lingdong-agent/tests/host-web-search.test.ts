import assert from "node:assert/strict";
import test from "node:test";
import { parseBingHtml, searchWeb, WebSearchError } from "../src/web-search/host-web-search";

const BING_FIXTURE = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://news.example.com/jimeng">即梦2.5 上线</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">官方发布即梦 2.5。</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://example.org/b">第二条</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">摘要二</p></div>
  </li>
</ol>
`;

test("parseBingHtml 解析结果块", () => {
  const hits = parseBingHtml(BING_FIXTURE, 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.url, "https://news.example.com/jimeng");
  assert.match(hits[0]?.snippet ?? "", /官方发布/);
});

test("searchWeb：DDG 失败时回退 Bing", async () => {
  let calls = 0;
  const hits = await searchWeb({
    query: "即梦2.5",
    limit: 2,
    fetch: async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes("duckduckgo.com/html")) {
        return new Response("blocked", { status: 403 });
      }
      if (url.includes("bing.com")) {
        return new Response(BING_FIXTURE, { status: 200 });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.ok(calls >= 2);
  assert.equal(hits[0]?.title, "即梦2.5 上线");
});

test("searchWeb：全部失败时文案禁止再去终端爬", async () => {
  await assert.rejects(
    () => searchWeb({
      query: "x",
      fetch: async () => new Response("nope", { status: 503 }),
    }),
    (error: unknown) =>
      error instanceof WebSearchError
      && /请勿改用终端爬虫/.test(error.message),
  );
});
