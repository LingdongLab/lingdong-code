import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RETRIES,
  backoffDelayMs,
  codeForStatus,
  describeProviderError,
  isRetryable,
  mapProviderError,
  withLimitedRetry,
  type ProviderError,
} from "../src/models/providers/provider-error-mapper";
import { TransportError } from "../src/models/providers/provider-http-client";

test("状态码映射覆盖服务商文档里的全部错误类型", () => {
  assert.equal(codeForStatus(400), "protocol-incompatible");
  assert.equal(codeForStatus(401), "invalid-key");
  assert.equal(codeForStatus(402), "insufficient-balance");
  assert.equal(codeForStatus(403), "forbidden");
  assert.equal(codeForStatus(404), "model-not-found");
  assert.equal(codeForStatus(408), "timeout");
  assert.equal(codeForStatus(413), "context-too-large");
  assert.equal(codeForStatus(429), "rate-limited");
  assert.equal(codeForStatus(500), "provider-unavailable");
  assert.equal(codeForStatus(502), "provider-unavailable");
  assert.equal(codeForStatus(529), "provider-unavailable");
});

test("402 的文案说明是额度问题并给出可恢复操作", () => {
  const error = mapProviderError({ status: 402 });
  assert.equal(error.code, "insufficient-balance");
  assert.match(error.reason, /余额|积分/);
  assert.notEqual(error.recovery, "");
});

test("传输层故障映射为网络类错误，且不返回状态码", () => {
  const timeout = mapProviderError({ error: new TransportError("timeout", "请求超时。") });
  assert.equal(timeout.code, "timeout");
  assert.equal(timeout.status, undefined);

  assert.equal(mapProviderError({ error: new TransportError("tls", "证书无效") }).code, "tls-error");
  assert.equal(
    mapProviderError({ error: new TransportError("cross-origin-redirect", "跨域") }).code,
    "network-unreachable",
  );
});

test("服务端说明会被截断后附上，不原样吐出整个响应", () => {
  const long = "x".repeat(500);
  const error = mapProviderError({ status: 400, body: JSON.stringify({ error: { message: long } }) });
  assert.ok(error.reason.length < 300);
  assert.ok(error.reason.includes("服务返回"));
});

test("非 JSON 响应不会让映射抛错", () => {
  const error = mapProviderError({ status: 500, body: "<html>502 Bad Gateway</html>" });
  assert.equal(error.code, "provider-unavailable");
  assert.equal(error.reason.includes("html"), false);
});

test("只有限流与服务不可用才重试", () => {
  const retryable: ProviderError = { code: "rate-limited", reason: "", recovery: "" };
  const unavailable: ProviderError = { code: "provider-unavailable", reason: "", recovery: "" };
  assert.equal(isRetryable(retryable), true);
  assert.equal(isRetryable(unavailable), true);
  for (const code of ["invalid-key", "insufficient-balance", "model-not-found", "context-too-large"] as const) {
    assert.equal(isRetryable({ code, reason: "", recovery: "" }), false, code);
  }
});

test("退避两档为 250ms 与 1000ms 起步，并尊重 Retry-After", () => {
  const error: ProviderError = { code: "rate-limited", reason: "", recovery: "" };
  assert.equal(backoffDelayMs(0, error, () => 0), 250);
  assert.equal(backoffDelayMs(1, error, () => 0), 1_000);

  const withHeader: ProviderError = { ...error, retryAfterSeconds: 3 };
  assert.equal(backoffDelayMs(0, withHeader, () => 0), 3_000);

  // 服务端要求等很久也不会真的等下去，上限夹住。
  const absurd: ProviderError = { ...error, retryAfterSeconds: 600 };
  assert.equal(backoffDelayMs(0, absurd, () => 0), 10_000);
});

test("429 最多重试两次后放弃，一共发三次请求", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const result = await withLimitedRetry<string>(
    () => {
      attempts += 1;
      return Promise.resolve({
        ok: false as const,
        error: mapProviderError({ status: 429, headers: {} }),
      });
    },
    { sleep: (ms) => { delays.push(ms); return Promise.resolve(); }, random: () => 0 },
  );

  assert.equal(result.ok, false);
  assert.equal(attempts, MAX_RETRIES + 1);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 1_000]);
});

test("401 不重试：无效凭据重发只会浪费一次调用", async () => {
  let attempts = 0;
  const result = await withLimitedRetry<string>(
    () => {
      attempts += 1;
      return Promise.resolve({ ok: false as const, error: mapProviderError({ status: 401 }) });
    },
    { sleep: () => Promise.resolve() },
  );
  assert.equal(attempts, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid-key");
});

test("重试成功后立即返回，不再继续退避", async () => {
  let attempts = 0;
  const result = await withLimitedRetry<string>(
    () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({ ok: false as const, error: mapProviderError({ status: 502 }) });
      }
      return Promise.resolve({ ok: true as const, value: "done" });
    },
    { sleep: () => Promise.resolve(), random: () => 0 },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(result, { ok: true, value: "done" });
});

test("展示文案含服务商与模型名，且不含凭据或请求细节", () => {
  const text = describeProviderError(mapProviderError({ status: 401 }), {
    providerName: "Poe",
    modelName: "Claude-Sonnet-4.6",
  });
  assert.ok(text.includes("Poe"));
  assert.ok(text.includes("Claude-Sonnet-4.6"));
  assert.ok(text.includes("重新录入"));
  assert.equal(/Bearer|Authorization|sk-/.test(text), false);
});
