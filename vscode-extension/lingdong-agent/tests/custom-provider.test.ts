import assert from "node:assert/strict";
import test from "node:test";
import { isModelVerified } from "../src/models/providers/provider-types";
import { validateBaseUrl } from "../src/models/providers/provider-validator";
import {
  CHAT_OK,
  PROBE_OK,
  STREAM_OK,
  createSettingsHarness,
  threeStepTransport,
} from "./support/model-settings-harness";
import { __test as vscodeHarness } from "./support/vscode-stub";

const draft = {
  displayName: "My Gateway",
  baseUrl: "https://api.example.com/v1",
  protocol: "chat_completions" as const,
  remoteModelId: "qwen2.5-coder",
};

const PROVIDER_ID = "my-gateway";
const MODEL_ID = "my-gateway:qwen2.5-coder";

test("远程地址必须 HTTPS，明文 HTTP 一律拒绝", () => {
  assert.equal(validateBaseUrl("https://api.example.com/v1").ok, true);

  const plain = validateBaseUrl("http://api.example.com/v1");
  assert.equal(plain.ok, false);
  assert.equal(plain.ok === false && plain.message.length > 0, true);
});

test("本机地址允许 HTTP，这是本地推理服务的常态", () => {
  for (const url of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8000/v1",
    "http://[::1]:8080/v1",
    "http://ollama.localhost/v1",
  ]) {
    assert.equal(validateBaseUrl(url).ok, true, `${url} 应当放行`);
  }
});

test("URL 内嵌凭据与 Query 里的密钥都被拒绝", () => {
  assert.equal(validateBaseUrl("https://user:pass@api.example.com/v1").ok, false);
  assert.equal(validateBaseUrl("https://api.example.com/v1?api_key=sk-abc").ok, false);
  assert.equal(validateBaseUrl("https://api.example.com/v1?token=abc").ok, false);
  assert.equal(validateBaseUrl("https://api.example.com/v1?secret=abc").ok, false);
});

test("尾斜杠被规范化，宿主与 Grok 解析出同一个地址", () => {
  const result = validateBaseUrl("https://api.example.com/v1/");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.normalized, "https://api.example.com/v1");
  assert.equal(result.ok && result.host, "api.example.com");
});

test("添加自定义服务商前必须确认数据发送域名，取消则不落盘", async () => {
  const harness = await createSettingsHarness();
  // 不排队答复 = 用户关掉了确认框。
  await harness.send({ type: "addCustomProvider", draft });
  assert.equal(harness.providers.registry.get(PROVIDER_ID), undefined);

  const warned = vscodeHarness.state.messages.filter((entry) => entry.level === "warn");
  assert.equal(warned.length, 1);
  assert.ok(warned[0]!.text.includes("api.example.com"));
});

test("非法 Base URL 直接报错，连确认框都不弹", async () => {
  const harness = await createSettingsHarness();
  await harness.send({
    type: "addCustomProvider",
    draft: { ...draft, baseUrl: "http://api.example.com/v1" },
  });
  assert.equal(harness.messagesOfType("error").length, 1);
  assert.equal(vscodeHarness.state.messages.length, 0);
  assert.equal(harness.providers.registry.list().length, 1, "只应有内置的 DeepSeek");
});

test("确认后落盘，但在测通之前既不启用 Provider 也不标记模型已验证", async () => {
  const harness = await createSettingsHarness();
  vscodeHarness.queueWarning("确认添加");
  await harness.send({ type: "addCustomProvider", draft });

  const provider = harness.providers.registry.get(PROVIDER_ID);
  assert.ok(provider);
  assert.equal(provider.baseUrl, "https://api.example.com/v1");
  assert.equal(provider.type, "custom-openai-compatible");
  // 没测过就不启用：Composer 里不该出现来路不明的地址。
  assert.equal(provider.enabled, false);
  assert.equal(isModelVerified(provider.models[0]!), false);
  assert.equal(provider.models[0]!.id, MODEL_ID);
  assert.equal(provider.models[0]!.remoteModelId, "qwen2.5-coder");
});

test("纯中文名称也能生成合法标识，且第二个不会撞名", async () => {
  const harness = await createSettingsHarness();
  vscodeHarness.queueWarning("确认添加", "确认添加");
  await harness.send({ type: "addCustomProvider", draft: { ...draft, displayName: "我的网关" } });
  await harness.send({ type: "addCustomProvider", draft: { ...draft, displayName: "另一个网关" } });

  // 标识只由 ASCII 拼出，全中文名退回 custom；重名时按序号错开。
  const ids = harness.providers.registry.list().map((provider) => provider.id);
  assert.ok(ids.includes("custom"));
  assert.ok(ids.includes("custom-2"));
  assert.equal(new Set(ids).size, ids.length, "标识必须唯一，否则 config.toml 会出现重复表键");
});

async function addProviderWithKey(routes: Parameters<typeof createSettingsHarness>[0]) {
  const harness = await createSettingsHarness(routes);
  vscodeHarness.queueWarning("确认添加");
  await harness.send({ type: "addCustomProvider", draft });
  await harness.send({ type: "saveKey", providerId: PROVIDER_ID, key: "sk-gateway-0123456789" });
  return harness;
}

test("三步全通过：模型标记为支持 Agent，Provider 自动启用", async () => {
  const harness = await addProviderWithKey({
    transport: threeStepTransport({ connection: CHAT_OK, streaming: STREAM_OK, probe: PROBE_OK }),
  });
  await harness.send({
    type: "testModel",
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
  });

  const result = harness.messagesOfType("testResult").at(-1)?.result;
  assert.equal(result?.conclusion, "agent-ready");
  assert.equal(result?.conclusionLabel, "完全支持 Agent");

  const model = harness.providers.registry.get(PROVIDER_ID)!.models[0]!;
  assert.equal(isModelVerified(model), true);
  assert.equal(model.capabilities.agentCompatible, true);
  assert.equal(harness.providers.registry.get(PROVIDER_ID)!.enabled, true);
});

test("能力检测没过：仍可保存并启用，但只标记为仅 Ask", async () => {
  const harness = await addProviderWithKey({
    transport: threeStepTransport({ connection: CHAT_OK, streaming: STREAM_OK, probe: CHAT_OK }),
  });
  await harness.send({
    type: "testModel",
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
  });

  const result = harness.messagesOfType("testResult").at(-1)?.result;
  assert.equal(result?.conclusion, "ask-only");
  assert.equal(result?.savable, true);

  const model = harness.providers.registry.get(PROVIDER_ID)!.models[0]!;
  assert.equal(isModelVerified(model), true, "连接通过就允许保存");
  assert.equal(model.capabilities.agentCompatible, false, "能力不足只限制模式，不阻止保存");
});

test("测试完全失败：模型不得保存为已启用，Provider 也不会被启用", async () => {
  const harness = await addProviderWithKey({
    routes: {
      "/chat/completions": { status: 401, body: JSON.stringify({ error: { message: "bad key" } }) },
    },
  });
  await harness.send({
    type: "testModel",
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
  });

  const result = harness.messagesOfType("testResult").at(-1)?.result;
  assert.equal(result?.conclusion, "invalid-key");
  assert.equal(result?.savable, false);

  const provider = harness.providers.registry.get(PROVIDER_ID)!;
  assert.equal(isModelVerified(provider.models[0]!), false);
  assert.equal(provider.enabled, false);
  assert.equal(provider.models[0]!.testedAt, undefined);
});

test("没配 Key 就测试时直接说明原因，不发任何请求", async () => {
  const harness = await createSettingsHarness();
  vscodeHarness.queueWarning("确认添加");
  await harness.send({ type: "addCustomProvider", draft });
  harness.posted.length = 0;

  await harness.send({
    type: "testModel",
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
  });
  const error = harness.messagesOfType("error").at(-1);
  assert.ok(error?.message.includes("API Key"));
  assert.equal(harness.requests.length, 0);
});
