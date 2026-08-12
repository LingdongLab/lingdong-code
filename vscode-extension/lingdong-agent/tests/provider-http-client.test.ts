import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderHttpClient,
  TransportError,
  buildProviderUrl,
  fetchTransport,
  type HttpRequest,
  type HttpResponse,
} from "../src/models/providers/provider-http-client";
import { registerSecretLiterals } from "../src/privacy/secret-redactor";

const provider = {
  id: "custom",
  displayName: "自定义网关",
  baseUrl: "https://gateway.example.com/v1",
};

function transportReturning(response: Partial<HttpResponse>): {
  transport: (request: HttpRequest) => Promise<HttpResponse>;
  seen: HttpRequest[];
} {
  const seen: HttpRequest[] = [];
  return {
    seen,
    transport: (request) => {
      seen.push(request);
      return Promise.resolve({ status: 200, headers: {}, body: "{}", ...response });
    },
  };
}

test("URL 只能由 ProviderConfig 的 baseUrl 与固定 path 拼出", async () => {
  const { transport, seen } = transportReturning({});
  const client = new ProviderHttpClient({ transport });
  await client.send({ provider, path: "/chat/completions", method: "POST", payload: {} });
  assert.equal(seen[0]?.url, "https://gateway.example.com/v1/chat/completions");

  // 尾斜杠不会拼出双斜杠：Grok 与宿主必须解析出同一个地址。
  assert.equal(
    buildProviderUrl("https://gateway.example.com/v1/", "/models"),
    "https://gateway.example.com/v1/models",
  );
});

test("超时与取消分别映射为 timeout 与 cancelled", async () => {
  const timeoutClient = new ProviderHttpClient({
    transport: () => Promise.reject(new TransportError("timeout", "请求超时。")),
  });
  await assert.rejects(
    timeoutClient.send({ provider, path: "/models", method: "GET" }),
    (error: unknown) => error instanceof TransportError && error.kind === "timeout",
  );

  const cancelClient = new ProviderHttpClient({
    transport: () => Promise.reject(new TransportError("cancelled", "请求已取消。")),
  });
  await assert.rejects(
    cancelClient.send({ provider, path: "/models", method: "GET" }),
    (error: unknown) => error instanceof TransportError && error.kind === "cancelled",
  );
});

test("超时时长与体积上限按调用方要求下传给传输层", async () => {
  const { transport, seen } = transportReturning({});
  const client = new ProviderHttpClient({ transport });
  await client.send({
    provider,
    path: "/models",
    method: "GET",
    timeoutMs: 1_234,
    maxBytes: 4_096,
  });
  assert.equal(seen[0]?.timeoutMs, 1_234);
  assert.equal(seen[0]?.maxBytes, 4_096);
});

test("默认传输拒绝跨域重定向，同源跳转才跟随", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.net/v1/models" },
      }))) as typeof fetch;

    await assert.rejects(
      fetchTransport({
        url: "https://gateway.example.com/v1/models",
        method: "GET",
        headers: {},
        timeoutMs: 1_000,
        maxBytes: 1_024,
      }),
      (error: unknown) => error instanceof TransportError && error.kind === "cross-origin-redirect",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("默认传输在超过体积上限时中止并报 too-large", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("x".repeat(4_096), { status: 200 }))) as typeof fetch;

    await assert.rejects(
      fetchTransport({
        url: "https://gateway.example.com/v1/models",
        method: "GET",
        headers: {},
        timeoutMs: 1_000,
        maxBytes: 128,
      }),
      (error: unknown) => error instanceof TransportError && error.kind === "too-large",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("日志只记方法、主机、路径、状态与耗时，不含 Authorization 与请求正文", async () => {
  const secret = "sk-must-not-appear-1234567890";
  registerSecretLiterals([secret]);
  const lines: string[] = [];
  const { transport } = transportReturning({ status: 401 });
  const client = new ProviderHttpClient({ transport, log: (line) => lines.push(line) });

  await client.send({
    provider,
    path: "/chat/completions",
    method: "POST",
    credential: secret,
    payload: { messages: [{ role: "user", content: "绝密业务代码 topSecretPayload" }] },
  });

  const joined = lines.join("\n");
  assert.ok(joined.includes("POST"));
  assert.ok(joined.includes("gateway.example.com/chat/completions"));
  assert.ok(joined.includes("401"));
  assert.equal(joined.includes(secret), false);
  assert.equal(joined.includes("Authorization"), false);
  assert.equal(joined.includes("Bearer"), false);
  assert.equal(joined.includes("topSecretPayload"), false);
  registerSecretLiterals([]);
});

test("凭据只出现在 Authorization 头里，不进 URL 也不进 body", async () => {
  const { transport, seen } = transportReturning({});
  const client = new ProviderHttpClient({ transport });
  await client.send({
    provider,
    path: "/responses",
    method: "POST",
    credential: "sk-abc",
    payload: { model: "m" },
  });
  const request = seen[0]!;
  assert.equal(request.headers.Authorization, "Bearer sk-abc");
  assert.equal(request.url.includes("sk-abc"), false);
  assert.equal(request.body?.includes("sk-abc"), false);
});
