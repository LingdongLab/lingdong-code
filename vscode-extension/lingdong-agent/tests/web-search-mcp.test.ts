import assert from "node:assert/strict";
import test from "node:test";
import { handleMcpMessage } from "../src/web-search/mcp-stdio";
import { handleWebSearchMcp } from "../src/web-search/web-search-mcp";

test("MCP initialize / tools/list 暴露 WebSearch 与 WebFetch", async () => {
  const init = await handleMcpMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    handleWebSearchMcp,
  );
  assert.equal(init?.result && (init.result as { serverInfo: { name: string } }).serverInfo.name, "lingdong-web");

  const list = await handleMcpMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    handleWebSearchMcp,
  );
  const tools = (list?.result as { tools: Array<{ name: string; description: string }> }).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["WebSearch", "WebFetch"]);
  // 描述里必须写明别用 shell 读网页，否则模型还是会去开 curl。
  const fetchTool = tools.find((tool) => tool.name === "WebFetch");
  assert.match(fetchTool?.description ?? "", /Do NOT use curl/);
});

test("MCP tools/call WebFetch 返回正文文本", async () => {
  const page = "<!DOCTYPE html><html><head><title>油油</title></head>"
    + "<body><nav>导航</nav><p>这是正文段落。</p><script>x()</script></body></html>";

  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(page, {
    status: 200,
    headers: { "content-type": "text/html" },
  })) as typeof fetch;
  try {
    const response = await handleMcpMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "WebFetch", arguments: { url: "https://www.oiloil.org/" } },
      }),
      handleWebSearchMcp,
    );
    const body = response?.result as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(body.isError, false);
    assert.match(body.content[0]?.text ?? "", /标题：油油/);
    assert.match(body.content[0]?.text ?? "", /这是正文段落。/);
    assert.equal((body.content[0]?.text ?? "").includes("x()"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("MCP tools/call WebFetch 拒绝内网地址且不发请求", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("secret", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await handleMcpMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "WebFetch", arguments: { url: "http://169.254.169.254/latest/meta-data/" } },
      }),
      handleWebSearchMcp,
    );
    const body = response?.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(body.isError, true);
    assert.match(body.content[0]?.text ?? "", /内网或本机/);
    assert.equal(called, false, "校验必须在发请求之前");
  } finally {
    globalThis.fetch = original;
  }
});

test("MCP tools/call WebSearch 用 mock fetch 返回结果文本", async () => {
  const fixture = `
    <div class="result results_links web-result">
      <a class="result__a" href="https://example.com/a">标题 A</a>
      <a class="result__snippet" href="https://example.com/a">摘要 A</a>
    </div>`;

  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(fixture, { status: 200 })) as typeof fetch;
  try {
    const response = await handleMcpMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "WebSearch", arguments: { query: "即梦", limit: 3 } },
      }),
      handleWebSearchMcp,
    );
    const body = response?.result as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(body.isError, false);
    assert.match(body.content[0]?.text ?? "", /标题 A/);
    assert.match(body.content[0]?.text ?? "", /https:\/\/example\.com\/a/);
  } finally {
    globalThis.fetch = original;
  }
});

test("MCP tools/call 空 query 返回 isError", async () => {
  const response = await handleMcpMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "WebSearch", arguments: { query: "" } },
    }),
    handleWebSearchMcp,
  );
  const body = response?.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(body.isError, true);
  assert.match(body.content[0]?.text ?? "", /不能为空|搜索/);
});
