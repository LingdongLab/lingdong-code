import assert from "node:assert/strict";
import test from "node:test";

import { ModelProxy } from "../src/models/providers/model-proxy";
import {
  mayNeedOutboundSanitizing,
  sanitizeOutboundRequest,
} from "../src/models/providers/request-sanitizer";
import { ImageStore, imageMarker } from "../src/services/image-store";
import {
  mayNeedSanitizing,
  sanitizeJsonText,
  sanitizeSseEvent,
  sanitizeUsage,
} from "../src/models/providers/usage-sanitizer";

/**
 * 这个分片是从 api.poe.com 实测抓下来的原文（只删了 id）。
 * kimi-k3 就是栽在它上面：Grok 报 `invalid type: null, expected u32 at line 1 column 334`，
 * 而第 334 列正好落在 completion_tokens_details 里的 audio_tokens。
 */
const REAL_KIMI_TAIL = '{"id": "chatcmpl-x", "object": "chat.completion.chunk", "created": 1785962324,'
  + ' "model": "kimi-k3", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],'
  + ' "usage": {"completion_tokens": 427, "prompt_tokens": 136, "total_tokens": 563,'
  + ' "completion_tokens_details": {"accepted_prediction_tokens": null, "audio_tokens": null,'
  + ' "reasoning_tokens": 301, "rejected_prediction_tokens": null},'
  + ' "prompt_tokens_details": {"audio_tokens": null, "cached_tokens": 136}}}';

test("实测的 kimi-k3 收尾分片：usage 里的 null 全部归零", () => {
  const fixed = JSON.parse(sanitizeJsonText(REAL_KIMI_TAIL)) as {
    usage: {
      completion_tokens: number;
      completion_tokens_details: Record<string, number>;
      prompt_tokens_details: Record<string, number>;
    };
    choices: { finish_reason: string }[];
  };

  assert.equal(fixed.usage.completion_tokens_details.accepted_prediction_tokens, 0);
  assert.equal(fixed.usage.completion_tokens_details.audio_tokens, 0);
  assert.equal(fixed.usage.prompt_tokens_details.audio_tokens, 0);
  assert.equal(fixed.usage.completion_tokens_details.rejected_prediction_tokens, 0);
  // 非 null 的计数不能被改动。
  assert.equal(fixed.usage.completion_tokens, 427);
  assert.equal(fixed.usage.completion_tokens_details.reasoning_tokens, 301);
  assert.equal(fixed.usage.prompt_tokens_details.cached_tokens, 136);
  assert.equal(fixed.choices[0]?.finish_reason, "stop");
  assert.equal(/null/.test(sanitizeJsonText(REAL_KIMI_TAIL)), false, "改完不该再有 null 残留");
});

test("usage 之外的 null 一律不动：finish_reason 为 null 表示还没结束", () => {
  const raw = '{"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}],"usage":null}';
  const fixed = JSON.parse(sanitizeJsonText(raw)) as {
    choices: { finish_reason: unknown }[];
    usage: unknown;
  };
  assert.equal(fixed.choices[0]?.finish_reason, null, "finish_reason 是有意义的 null，不能归零");
  assert.equal(fixed.usage, null, "usage 整个为 null 是 Grok 能接受的形态，别造一个空对象出来");
});

test("整个 *_details 为 null 时保持 null：Grok 期望的是结构体，归零成整数会炸", () => {
  // claude-opus-4.8 实测的收尾分片形态：completion_tokens_details 整个是 null，
  // 里面的 audio_tokens 又是内层 null，两种形态要区别对待。
  const raw = '{"usage": {"completion_tokens": 134, "prompt_tokens": 13544, "total_tokens": 13678,'
    + ' "completion_tokens_details": null, "prompt_tokens_details": {"audio_tokens": null, "cached_tokens": 13542}}}';
  const fixed = JSON.parse(sanitizeJsonText(raw)) as {
    usage: {
      completion_tokens_details: unknown;
      prompt_tokens_details: { audio_tokens: number; cached_tokens: number };
    };
  };
  assert.equal(fixed.usage.completion_tokens_details, null, "整个对象为 null 必须原样保留");
  assert.equal(fixed.usage.prompt_tokens_details.audio_tokens, 0, "对象内部的 null 照旧归零");
  assert.equal(fixed.usage.prompt_tokens_details.cached_tokens, 13542);
});

test("嵌套数组里的 usage 也能修到", () => {
  const value = sanitizeUsage({ items: [{ usage: { a: null } }] }) as {
    items: { usage: { a: number } }[];
  };
  assert.equal(value.items[0]?.usage.a, 0);
});

test("预检：正常分片直接放行，不进 JSON 解析", () => {
  assert.equal(mayNeedSanitizing('{"choices":[{"index":0,"delta":{"content":"字"}}]}'), false);
  assert.equal(mayNeedSanitizing('{"choices":[{"index":0,"finish_reason":null}]}'), false, "没有 usage 就不用管");
  assert.equal(mayNeedSanitizing(REAL_KIMI_TAIL), true);
  assert.equal(mayNeedSanitizing('{"choices": [{"delta": {}, "finish_reason": "stop"}]}'), true, "缺 index 的分片要进修补");
});

/**
 * 从 api.poe.com 实测抓下来的工具调用分片（claude-opus-4.8 调 ask_user_question，只删了 id）：
 * choices[0] 里没有 index，Grok 报 `serialization error: missing field index at line 1 column 308`。
 */
const REAL_TOOLCALL_CHUNK = '{"id": "chatcmpl-x", "object": "chat.completion.chunk", "created": 1785982092,'
  + ' "model": "claude-opus-4.8", "choices": [{"delta": {"tool_calls": [{"index": 0,'
  + ' "id": "toolu_1", "type": "function", "function": {"name": "ask_user_question", "arguments": ""}}]},'
  + ' "finish_reason": null}]}';

test("实测的工具调用分片：choices 条目缺 index 时按位置补上", () => {
  assert.equal(mayNeedSanitizing(REAL_TOOLCALL_CHUNK), true);
  const fixed = JSON.parse(sanitizeJsonText(REAL_TOOLCALL_CHUNK)) as {
    choices: { index: number; delta: { tool_calls: { index: number }[] }; finish_reason: unknown }[];
  };
  assert.equal(fixed.choices[0]?.index, 0, "缺 index 的 choice 按数组位置补");
  assert.equal(fixed.choices[0]?.delta.tool_calls[0]?.index, 0, "已有 index 的 tool_call 原样保留");
  assert.equal(fixed.choices[0]?.finish_reason, null, "顺路不能动别的字段");
});

test("tool_calls 条目缺 index 时同样按位置补上", () => {
  const raw = '{"choices":[{"index":0,"delta":{"tool_calls":['
    + '{"id":"call_1","type":"function","function":{"name":"ask_user_question","arguments":""}},'
    + '{"index":5,"id":"call_2","type":"function","function":{"name":"other","arguments":""}}'
    + ']},"finish_reason":null}]}';
  assert.equal(mayNeedSanitizing(raw), true, "缺 index 的 tool_calls 要进修补");
  const fixed = JSON.parse(sanitizeJsonText(raw)) as {
    choices: { delta: { tool_calls: { index: number; id: string }[] } }[];
  };
  const calls = fixed.choices[0]?.delta.tool_calls;
  assert.equal(calls?.[0]?.index, 0, "缺 index 的条目按数组位置补");
  assert.equal(calls?.[1]?.index, 5, "已有 index 的条目不能被改写");
});

test("非流式响应的 message.tool_calls 同样补 index", () => {
  const raw = '{"choices":[{"index":0,"message":{"role":"assistant","tool_calls":['
    + '{"id":"a","type":"function","function":{"name":"f","arguments":"{}"}}'
    + ']},"finish_reason":"tool_calls"}]}';
  const fixed = JSON.parse(sanitizeJsonText(raw)) as {
    choices: { message: { tool_calls: { index: number }[] } }[];
  };
  assert.equal(fixed.choices[0]?.message.tool_calls[0]?.index, 0);
});

test("解析不了的载荷原样退回，不把畸形内容改得更难查", () => {
  const broken = '{"usage": {"a": null';
  assert.equal(sanitizeJsonText(broken), broken);
});

test("SSE 事件块：只改 data 行，[DONE] 与其他行保持原样", () => {
  const block = `event: chunk\ndata: ${REAL_KIMI_TAIL}`;
  const fixed = sanitizeSseEvent(block);
  assert.match(fixed, /^event: chunk\n/, "非 data 行必须原样保留");
  assert.equal(/null/.test(fixed), false);

  assert.equal(sanitizeSseEvent("data: [DONE]"), "data: [DONE]");
  assert.equal(sanitizeSseEvent("data: "), "data: ");
});

/** 起一个假上游，按脚本吐 SSE，用来端到端验转发层。 */
function fakeUpstream(chunks: readonly string[], options: { contentType?: string } = {}) {
  const calls: { url: string; auth: string | undefined; method: string; body: string }[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url,
      auth: headers.authorization ?? headers.Authorization,
      method: init.method ?? "GET",
      body: await bodyText(init.body),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": options.contentType ?? "text/event-stream" },
    });
  };
  return { calls, fetchImpl };
}

async function readAll(response: Response): Promise<string> {
  return await response.text();
}

/** 请求体可能是流（直传）也可能是 Buffer（注入过），两种都要读得出来。 */
async function bodyText(body: RequestInit["body"]): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return await new Response(body as BodyInit).text();
}

test("端到端：转发到上游并修好 usage，Authorization 原样带上", async () => {
  const upstream = fakeUpstream([
    `data: {"choices":[{"delta":{"content":"你"}}]}\n\n`,
    `data: ${REAL_KIMI_TAIL}\n\n`,
    "data: [DONE]\n\n",
  ]);
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    const response = await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-test", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", stream: true }),
    });
    const body = await readAll(response);

    assert.equal(response.status, 200);
    assert.equal(/null/.test(body), false, "转出去的流里不该还有 usage null");
    assert.match(body, /"content":"你"/, "正文分片必须原样送达");
    assert.match(body, /data: \[DONE\]/);

    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]?.url, "https://api.poe.com/v1/chat/completions");
    assert.equal(upstream.calls[0]?.auth, "Bearer sk-test", "凭据必须原样透传，不改不存");
    assert.equal(upstream.calls[0]?.method, "POST");
  } finally {
    await proxy.stop();
  }
});

/**
 * 转发层绝不能把流攒起来一次性放出去，否则刚修好的出字节奏又会被它毁掉。
 * 这里让上游慢慢吐，检查每一帧都是「上游给了就立刻能读到」。
 */
test("流式透传不缓冲：上游边吐，下游边收", async () => {
  const encoder = new TextEncoder();
  let release: (() => void) | undefined;
  const secondChunkSent = new Promise<void>((resolve) => { release = resolve; });

  const fetchImpl = async (): Promise<Response> => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: {"n":1}\n\n`));
        await secondChunkSent;
        controller.enqueue(encoder.encode(`data: {"n":2}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const proxy = new ModelProxy({ fetch: fetchImpl });
  await proxy.start();
  try {
    const local = proxy.register("https://example.invalid/v1");
    const response = await fetch(`${local}/chat/completions`, { method: "POST", body: "{}" });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // 上游第二帧还没发，这里就该拿到第一帧。攒着不放的话这一步会挂死。
    const first = await reader.read();
    assert.match(decoder.decode(first.value), /"n":1/, "第一帧必须在上游结束之前就到达");

    release?.();
    const second = await reader.read();
    assert.match(decoder.decode(second.value), /"n":2/);
    await reader.cancel();
  } finally {
    await proxy.stop();
  }
});

test("非流式 JSON 响应同样会修，并重算长度", async () => {
  const upstream = fakeUpstream([REAL_KIMI_TAIL], { contentType: "application/json" });
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    const response = await fetch(`${local}/chat/completions`, { method: "POST", body: "{}" });
    const text = await response.text();
    assert.equal(/null/.test(text), false);
    assert.equal(
      Number(response.headers.get("content-length")),
      Buffer.byteLength(text, "utf8"),
      "改过内容之后长度必须重算，否则连接会挂住",
    );
  } finally {
    await proxy.stop();
  }
});

test("认不出的 token 返回 404，不能当成通用代理使唤", async () => {
  const upstream = fakeUpstream(["data: {}\n\n"]);
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl });
  await proxy.start();
  try {
    const bogus = `http://127.0.0.1:${proxy.port}/${"0".repeat(24)}/chat/completions`;
    const response = await fetch(bogus, { method: "POST", body: "{}" });
    assert.equal(response.status, 404);
    assert.equal(upstream.calls.length, 0, "没登记过的路由不许打到上游");

    const noToken = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`);
    assert.equal(noToken.status, 404);
  } finally {
    await proxy.stop();
  }
});

test("同一个上游重复登记复用同一段地址", async () => {
  const proxy = new ModelProxy({ fetch: fakeUpstream([]).fetchImpl });
  await proxy.start();
  try {
    const first = proxy.register("https://api.poe.com/v1");
    const second = proxy.register("https://api.poe.com/v1");
    const other = proxy.register("https://api.deepseek.com");
    assert.equal(first, second);
    assert.notEqual(first, other);
    assert.match(first, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{24}$/);
  } finally {
    await proxy.stop();
  }
});

test("只监听回环，且停掉之后端口不再服务", async () => {
  const proxy = new ModelProxy({ fetch: fakeUpstream([]).fetchImpl });
  const port = await proxy.start();
  const local = proxy.register("https://api.poe.com/v1");
  assert.match(local, /^http:\/\/127\.0\.0\.1:/);
  await proxy.stop();

  assert.equal(proxy.running, false);
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/x`),
    "停掉之后不该还能连上",
  );
});

// ---------------------------------------------------------------------------
// 图片注入
// ---------------------------------------------------------------------------

/** 一张最小的假 PNG；内容不重要，要验的是它有没有出现在出站请求里。 */
const PNG = "data:image/png;base64,iVBORw0KGgo=";

function storeWithImage(): { store: ImageStore; marker: string } {
  const store = new ImageStore();
  const added = store.add("red.png", PNG);
  assert.ok(added.ok);
  return { store, marker: imageMarker(added.image.id) };
}

test("暂存里有图时，出站请求体里带上真正的图片 base64", async () => {
  const { store, marker } = storeWithImage();
  const upstream = fakeUpstream(["data: [DONE]\n\n"]);
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl, images: () => store, log: () => {} });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: `什么颜色 ${marker}` }] }),
    });

    const sent = JSON.parse(upstream.calls[0]!.body) as {
      messages: { content: Array<Record<string, unknown>> }[];
    };
    assert.deepEqual(sent.messages[0]?.content[1], { type: "image_url", image_url: { url: PNG } });
    // 判据是「图真的在请求体里」，不是「没报错」——Grok 静默丢图那一课就在这儿。
    assert.ok(upstream.calls[0]!.body.includes("iVBORw0KGgo="));
  } finally {
    await proxy.stop();
  }
});

test("暂存为空且无需修补时，出站请求体字节与入站一致", async () => {
  const upstream = fakeUpstream(["data: [DONE]\n\n"]);
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl, images: () => new ImageStore() });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    const payload = JSON.stringify({ messages: [{ role: "user", content: "普通问题" }] });
    await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    assert.equal(upstream.calls[0]?.body, payload);
  } finally {
    await proxy.stop();
  }
});

test("没配图片通道且无需修补时，出站请求体原样转发", async () => {
  const upstream = fakeUpstream(["data: [DONE]\n\n"]);
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    const payload = JSON.stringify({ messages: [{ role: "user", content: "普通问题" }] });
    await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    assert.equal(upstream.calls[0]?.body, payload);
  } finally {
    await proxy.stop();
  }
});

// ---------------------------------------------------------------------------
// 挂起防护
//
// 用户反馈「发了消息一直没回复，也不知道是模型在想还是卡住了」。
// 成因是转发层这一段出站请求没有任何超时：上游握手后不吐字节，这里就一直等，
// 直到 ACP 那 10 分钟的静默看门狗才收场，而那条报错也说不清卡在哪。
// ---------------------------------------------------------------------------

/** 起一个「接了但不说话」的上游。abort 时按真实 fetch 的行为把流打断。 */
function stallingUpstream(firstChunk?: string) {
  let aborted = false;
  const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
    const signal = init.signal as AbortSignal | null | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (firstChunk) controller.enqueue(new TextEncoder().encode(firstChunk));
        // 之后再也不吐字节，也不 close：这就是「上游静默」。
        signal?.addEventListener("abort", () => {
          aborted = true;
          controller.error(new Error("上游连接已中止"));
        });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { fetchImpl, get aborted() { return aborted; } };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("上游迟迟不回响应头：到点中止并说清楚，而不是一直挂着", async () => {
  const lines: string[] = [];
  const proxy = new ModelProxy({
    // 永远不 resolve，只在被 abort 时才 reject —— 真实的 TLS 挂起就是这个样子。
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      (init.signal as AbortSignal | null | undefined)?.addEventListener("abort", () => {
        reject(new Error("The operation was aborted"));
      });
    }),
    timeouts: { headersMs: 60 },
    log: (line) => lines.push(line),
  });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    const response = await fetch(`${local}/chat/completions`, { method: "POST", body: "{}" });

    assert.equal(response.status, 502);
    const body = JSON.parse(await response.text()) as { error: { message: string } };
    assert.match(body.error.message, /没有返回响应头/);
    assert.ok(
      lines.some((line) => line.includes("headers-timeout")),
      `日志要能定位到是哪一层超时，实际：${lines.join(" / ")}`,
    );
  } finally {
    await proxy.stop();
  }
});

test("流开到一半上游静默：补一个合法的 SSE 错误帧收尾，不留半截流", async () => {
  const upstream = stallingUpstream(`data: {"choices":[{"delta":{"content":"你"}}]}\n\n`);
  const proxy = new ModelProxy({
    fetch: upstream.fetchImpl,
    timeouts: { streamIdleMs: 60 },
    log: () => {},
  });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    const response = await fetch(`${local}/chat/completions`, { method: "POST", body: "{}" });
    const body = await response.text();

    assert.match(body, /"content":"你"/, "静默之前收到的内容要照常送达");
    assert.match(body, /event: error/, "错误要以 SSE 事件的形态送出，裸 JSON 会被解析器丢掉");
    assert.match(body, /中途停止输出/);
    assert.match(body, /data: \[DONE\]/, "缺终止标记的话，按流式约定写的客户端会继续等下去");
  } finally {
    await proxy.stop();
  }
});

test("Grok 掐断连接时，上游那条连接也跟着放掉", async () => {
  const upstream = stallingUpstream(`data: {"n":1}\n\n`);
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl, log: () => {} });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    const response = await fetch(`${local}/chat/completions`, { method: "POST", body: "{}" });
    const reader = response.body!.getReader();
    await reader.read();

    await reader.cancel();

    // 不放掉的话，上游连接会一直悬着，写入和句柄都不释放。
    await waitUntil(() => upstream.aborted);
  } finally {
    await proxy.stop();
  }
});

test("正常往来会记下耗时，出问题时能据此判断卡在哪一层", async () => {
  const lines: string[] = [];
  const upstream = fakeUpstream(["data: [DONE]\n\n"]);
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl, log: (line) => lines.push(line) });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    await readAll(await fetch(`${local}/chat/completions`, { method: "POST", body: "{}" }));

    assert.ok(lines.some((line) => /^\[proxy\] → POST api\.poe\.com$/.test(line)), lines.join(" / "));
    assert.ok(lines.some((line) => /^\[proxy\] ← 200 api\.poe\.com \d+ms$/.test(line)), lines.join(" / "));
    assert.equal(
      lines.some((line) => line.includes("sk-")),
      false,
      "日志里不能出现凭据",
    );
  } finally {
    await proxy.stop();
  }
});

test("上游连不上时回 502，不把异常吞掉", async () => {
  const proxy = new ModelProxy({
    fetch: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
    log: () => {},
  });
  await proxy.start();
  try {
    const local = proxy.register("https://api.poe.com/v1");
    const response = await fetch(`${local}/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(response.status, 502);
  } finally {
    await proxy.stop();
  }
});

// ---------------------------------------------------------------------------
// 出站请求修补（切模型后 DeepSeek 空 call_id → 400）
// ---------------------------------------------------------------------------

test("Responses input 里空 call_id：连续 function_call → output 共用补出来的 id", () => {
  const raw = JSON.stringify({
    model: "deepseek-chat",
    input: [
      { type: "message", role: "user", content: "你好" },
      { type: "function_call", call_id: "", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "", output: "ok" },
      { type: "function_call", call_id: null, name: "other", arguments: "{}" },
      { type: "function_call_output", call_id: "", output: "done" },
    ],
  });
  assert.equal(mayNeedOutboundSanitizing(raw), true);
  const result = sanitizeOutboundRequest(raw);
  assert.equal(result.changed, true);
  assert.equal(result.fixedCallIds, 4);
  const body = JSON.parse(result.body) as {
    input: { type: string; call_id?: string }[];
  };
  assert.equal(body.input[1]?.call_id, "call_repair_1");
  assert.equal(body.input[2]?.call_id, "call_repair_1", "output 必须跟紧邻的 call 共用 id");
  assert.equal(body.input[3]?.call_id, "call_repair_2");
  assert.equal(body.input[4]?.call_id, "call_repair_2");
});

test("中间夹了别的条目时，空 function_call_output 不再误用上一条 pending id", () => {
  const raw = JSON.stringify({
    input: [
      { type: "function_call", call_id: "", name: "a", arguments: "{}" },
      { type: "message", role: "assistant", content: "中间话" },
      { type: "function_call_output", call_id: "", output: "orphan" },
    ],
  });
  const body = JSON.parse(sanitizeOutboundRequest(raw).body) as {
    input: { call_id?: string }[];
  };
  assert.equal(body.input[0]?.call_id, "call_repair_1");
  assert.notEqual(body.input[2]?.call_id, "call_repair_1");
  assert.match(body.input[2]?.call_id ?? "", /^call_repair_/);
});

test("Chat Completions：去掉空 tool_calls，并给空 tool_call_id 配对", () => {
  const raw = JSON.stringify({
    messages: [
      { role: "assistant", content: null, tool_calls: [] },
      {
        role: "assistant",
        tool_calls: [{ id: "", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "", content: "result" },
    ],
  });
  const result = sanitizeOutboundRequest(raw);
  assert.equal(result.strippedEmptyToolCalls, 1);
  assert.equal(result.fixedCallIds, 2);
  const body = JSON.parse(result.body) as {
    messages: { tool_calls?: { id: string }[]; tool_call_id?: string }[];
  };
  assert.equal("tool_calls" in body.messages[0]!, false);
  assert.equal(body.messages[1]?.tool_calls?.[0]?.id, "call_repair_1");
  assert.equal(body.messages[2]?.tool_call_id, "call_repair_1");
});

test("干净请求体不 parse、不改写", () => {
  const raw = JSON.stringify({
    model: "x",
    input: [{ type: "message", role: "user", content: "hi", call_id: "call_ok" }],
  });
  assert.equal(mayNeedOutboundSanitizing(raw), false);
  const result = sanitizeOutboundRequest(raw);
  assert.equal(result.changed, false);
  assert.equal(result.body, raw);
});

test("端到端：代理出站前修补空 call_id，并写日志", async () => {
  const lines: string[] = [];
  const upstream = fakeUpstream(["data: [DONE]\n\n"]);
  const proxy = new ModelProxy({ fetch: upstream.fetchImpl, log: (line) => lines.push(line) });
  await proxy.start();
  try {
    const local = proxy.register("https://api.deepseek.com");
    await fetch(`${local}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        input: [
          { type: "function_call", call_id: "", name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: "", output: "x" },
        ],
      }),
    });

    const sent = JSON.parse(upstream.calls[0]!.body) as {
      input: { call_id: string }[];
    };
    assert.equal(sent.input[0]?.call_id, "call_repair_1");
    assert.equal(sent.input[1]?.call_id, "call_repair_1");
    assert.ok(
      lines.some((line) => line.includes("已修补出站工具历史") && line.includes("补 call_id 2 处")),
      lines.join(" / "),
    );
  } finally {
    await proxy.stop();
  }
});
