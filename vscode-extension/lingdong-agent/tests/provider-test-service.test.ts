import assert from "node:assert/strict";
import test from "node:test";
import { PROBE_TOOL_NAME } from "../src/models/providers/capability-probe";
import {
  ProviderHttpClient,
  type HttpRequest,
  type HttpResponse,
} from "../src/models/providers/provider-http-client";
import {
  CONNECTION_PROMPT,
  ProviderTestService,
  connectionPayload,
  runFullTest,
  type TestTarget,
} from "../src/models/providers/provider-test-service";

const provider = {
  id: "gateway",
  displayName: "自定义网关",
  baseUrl: "https://api.example.com/v1",
};

function target(overrides: Partial<TestTarget> = {}): TestTarget {
  return {
    provider,
    apiModelId: "test-model",
    protocol: "chat_completions",
    credential: "sk-test",
    ...overrides,
  };
}

/** 按路径给不同响应；未登记的路径视为 404，便于断言「压根没发过这个请求」。 */
function scriptedTransport(routes: Record<string, Partial<HttpResponse>>): {
  transport: (request: HttpRequest) => Promise<HttpResponse>;
  seen: HttpRequest[];
} {
  const seen: HttpRequest[] = [];
  return {
    seen,
    transport: (request) => {
      seen.push(request);
      const path = new URL(request.url).pathname;
      const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
      return Promise.resolve({
        status: 404,
        headers: {},
        body: "{}",
        ...(hit ? hit[1] : {}),
      });
    },
  };
}

function serviceWith(routes: Record<string, Partial<HttpResponse>>) {
  const { transport, seen } = scriptedTransport(routes);
  const http = new ProviderHttpClient({ transport });
  // sleep 走同步 resolve：退避逻辑本身在 error-mapper 的测试里验证，这里不必真等。
  return { service: new ProviderTestService({ http, sleep: () => Promise.resolve() }), seen };
}

const chatOk = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
const streamOk = { status: 200, body: "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n" };
const probeOk = {
  status: 200,
  body: JSON.stringify({
    choices: [{
      message: {
        tool_calls: [{ function: { name: PROBE_TOOL_NAME, arguments: "{\"value\":\"ok\"}" } }],
      },
    }],
  }),
};

test("基础连接测试只发固定最小请求，不携带任何项目上下文", () => {
  const payload = connectionPayload("test-model", "chat_completions", false) as {
    messages: Array<{ content: string }>;
    max_tokens: number;
    stream: boolean;
  };
  assert.deepEqual(payload.messages, [{ role: "user", content: CONNECTION_PROMPT }]);
  assert.equal(payload.max_tokens, 16);
  assert.equal(payload.stream, false);
  // 传 n 会被 Poe 判成非法请求，且这里也没有任何理由要多条候选。
  assert.equal("n" in payload, false);

  // 整个请求体序列化后只有固定常量，没有留给上下文的字段。
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("workspace"), false);
  assert.equal(serialized.includes("plan"), false);
  assert.equal(serialized.includes("timeline"), false);
  assert.equal(Object.keys(payload).sort().join(","), "max_tokens,messages,model,stream");
});

test("Responses 协议用 /responses 与 input 字段", async () => {
  const payload = connectionPayload("test-model", "responses", false);
  assert.deepEqual(Object.keys(payload).sort(), ["input", "max_output_tokens", "model", "stream"]);

  const { service, seen } = serviceWith({
    "/responses": { status: 200, body: JSON.stringify({ output_text: "OK" }) },
  });
  const result = await service.testConnection(target({ protocol: "responses" }));
  assert.equal(result.ok, true);
  assert.equal(new URL(seen[0]!.url).pathname, "/v1/responses");
});

test("Chat Completions 协议用 /chat/completions 并读回一小段回复", async () => {
  const { service, seen } = serviceWith({ "/chat/completions": chatOk });
  const result = await service.testConnection(target());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.sample, "OK");
  assert.equal(new URL(seen[0]!.url).pathname, "/v1/chat/completions");
});

test("流式测试要求至少收到一个 data 事件", async () => {
  const { service, seen } = serviceWith({ "/chat/completions": streamOk });
  const ok = await service.testStreaming(target());
  assert.equal(ok.ok, true);
  assert.equal(JSON.parse(seen[0]!.body!).stream, true);
  assert.equal(seen[0]!.headers.Accept, "text/event-stream");

  const silent = serviceWith({ "/chat/completions": { status: 200, body: "{}" } });
  const failed = await silent.service.testStreaming(target());
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.error.code, "invalid-response");
});

test("连接失败就停下，不再浪费额度跑流式与能力检测", async () => {
  const { service, seen } = serviceWith({
    "/chat/completions": { status: 401, body: JSON.stringify({ error: { message: "bad key" } }) },
  });
  const outcome = await runFullTest(service, target());
  assert.equal(outcome.conclusion, "invalid-key");
  assert.equal(outcome.savable, false);
  assert.equal(outcome.streaming, undefined);
  assert.equal(outcome.probe, undefined);
  assert.equal(seen.length, 1);
});

test("三步都通过时结论是完全支持 Agent，并带回本次使用的协议", async () => {
  let call = 0;
  const http = new ProviderHttpClient({
    transport: (request) => {
      call += 1;
      const body = call === 1 ? chatOk : call === 2 ? streamOk : probeOk;
      void request;
      return Promise.resolve({ headers: {}, ...body });
    },
  });
  const service = new ProviderTestService({ http, sleep: () => Promise.resolve() });
  const outcome = await runFullTest(service, target());
  assert.equal(outcome.conclusion, "agent-ready");
  assert.equal(outcome.protocol, "chat_completions");
  assert.equal(outcome.savable, true);
  assert.equal(outcome.probe?.verdict.agentCompatible, true);
  assert.equal(outcome.canTryFallback, false);
});

test("能力检测没过仍可保存，只是降级为仅 Ask", async () => {
  let call = 0;
  const http = new ProviderHttpClient({
    transport: () => {
      call += 1;
      const body = call === 1
        ? chatOk
        : call === 2
          ? streamOk
          : { status: 200, body: JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
      return Promise.resolve({ headers: {}, ...body });
    },
  });
  const service = new ProviderTestService({ http, sleep: () => Promise.resolve() });
  const outcome = await runFullTest(service, target());
  assert.equal(outcome.conclusion, "ask-only");
  // 连接通了就允许保存；能力不足是使用限制，不是拒绝入库的理由。
  assert.equal(outcome.savable, true);
  assert.equal(outcome.probe?.verdict.agentCompatible, false);
});

test("Responses 失败只是提议兼容协议，不自动改用 Chat Completions", async () => {
  const { service, seen } = serviceWith({
    "/responses": { status: 404, body: JSON.stringify({ error: { message: "no such model" } }) },
  });
  const outcome = await runFullTest(service, target({ protocol: "responses" }));
  assert.equal(outcome.canTryFallback, true);
  // 关键点：没有第二个请求，协议切换必须由用户点按触发。
  assert.equal(seen.length, 1);
  assert.equal(seen.every((request) => request.url.endsWith("/responses")), true);
});
