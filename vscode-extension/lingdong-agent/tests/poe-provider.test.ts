/**
 * Poe Provider 的端到端行为。
 *
 * 走的是真实的 ProviderRegistry / SecretStore / 落盘，只替换 HTTP 传输，
 * 因为这一轮要证明的恰恰是「设置页的动作最终写成了什么」。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { isModelVerified, poeProvider, secretIdFor } from "../src/models/providers/provider-types";
import {
  CHAT_OK,
  PROBE_OK,
  STREAM_OK,
  createSettingsHarness,
  threeStepTransport,
  type SettingsHarness,
} from "./support/model-settings-harness";
import { __test as vscodeHarness } from "./support/vscode-stub";

/** 一个形状真实的 Key，用来确认它不会出现在任何日志或落盘文件里。 */
const KEY = "poe-live-Ab12Cd34Ef56Gh78Ij90";
const REMOTE_ID = "Claude-Sonnet-4.5";
const MODEL_ID = "poe:Claude-Sonnet-4.5";

/** Responses 形态的能力检测回复；Poe 模板默认走 Responses。 */
const PROBE_RESPONSES_OK = {
  status: 200,
  body: JSON.stringify({
    output: [{
      type: "function_call",
      name: "lingdong_capability_probe",
      arguments: "{\"value\":\"ok\"}",
    }],
  }),
};

const CATALOG_BODY = JSON.stringify({
  data: [
    {
      id: REMOTE_ID,
      owned_by: "anthropic",
      supported_endpoints: ["/v1/responses"],
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    },
    {
      id: "GPT-4o-mini",
      owned_by: "openai",
      supported_endpoints: ["/v1/chat/completions"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
    { id: "Grok-4", owned_by: "xai" },
    {
      id: "FLUX-pro",
      owned_by: "bfl",
      supported_endpoints: ["/v1/chat/completions"],
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    },
  ],
});

async function poeWithKey(
  options: Parameters<typeof createSettingsHarness>[0] = {},
): Promise<SettingsHarness> {
  const harness = await createSettingsHarness(options);
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });
  await harness.send({ type: "saveKey", providerId: "poe", key: KEY });
  return harness;
}

// ---------------------------------------------------------------------------
// 模板与凭据
// ---------------------------------------------------------------------------

test("Poe 不参与播种，首页把它列成可添加的模板", async () => {
  const harness = await createSettingsHarness();
  await harness.send({ type: "ready" });

  assert.equal(harness.providers.registry.list().length, 1, "只应有内置的 DeepSeek");
  const builtins = harness.latestProviders()?.availableBuiltins ?? [];
  assert.deepEqual(builtins.map((template) => template.id), ["poe"]);
  assert.equal(builtins[0]!.host, "api.poe.com");
});

test("一键添加写入固定配置：Base URL、协议与凭据键都不由界面决定", async () => {
  const harness = await createSettingsHarness();
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });

  const provider = harness.providers.registry.get("poe");
  assert.ok(provider);
  assert.equal(provider.baseUrl, "https://api.poe.com/v1");
  // 新模型的协议初值走通用端点；声明了 Responses 的模型由目录覆盖。
  assert.equal(provider.protocol, "chat_completions");
  assert.equal(provider.secretId, secretIdFor("poe"));
  assert.equal(provider.secretId, "lingdongAgent.providerKey.poe");
  assert.deepEqual(provider, poeProvider());
  // 添加动作本身不预置任何模型，也不启用。
  assert.deepEqual(provider.models, []);
  assert.equal(provider.enabled, false);
  // 模板已经用掉，就不该再出现在首页卡片里。
  assert.deepEqual(harness.latestProviders()?.availableBuiltins, []);
});

test("重复添加不会覆盖已有配置", async () => {
  const harness = await poeWithKey();
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });

  assert.ok(harness.messagesOfType("notice").at(-1)?.message.includes("已经添加过"));
  assert.equal(harness.providers.registry.list().filter((p) => p.id === "poe").length, 1);
});

test("Key 只进 SecretStorage：配置文件与出站消息里都没有它", async () => {
  const harness = await poeWithKey();

  assert.equal(vscodeHarness.state.secrets.get("lingdongAgent.providerKey.poe"), KEY);
  const providersFile = await readFile(
    path.join(harness.storageRoot, "agent-providers", "providers.json"),
    "utf8",
  );
  assert.equal(providersFile.includes(KEY), false);
  assert.equal(JSON.stringify(harness.posted).includes(KEY), false);
  // 界面只知道「配了没有」。
  assert.equal(harness.latestProviders()?.providers.find((p) => p.id === "poe")?.keyConfigured, true);
});

test("同一个 Key 支撑多个 Poe 模型，只保存一次", async () => {
  const harness = await poeWithKey({
    transport: () => Promise.resolve({ status: 200, headers: {}, body: CHAT_OK.body }),
  });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "responses" });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: "GPT-4o-mini", protocol: "chat_completions" });

  assert.equal(harness.providers.registry.get("poe")!.models.length, 2);
  const index = vscodeHarness.state.globalState.get("lingdongAgent.providerKeyIndex") as string[];
  assert.deepEqual(index.filter((id) => id === "poe").length, 1);
});

// ---------------------------------------------------------------------------
// 目录与模型添加
// ---------------------------------------------------------------------------

test("同步目录不会自动添加任何模型", async () => {
  const harness = await poeWithKey({ routes: { "/models": { status: 200, body: CATALOG_BODY } } });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  assert.equal(harness.messagesOfType("catalog").at(-1)?.catalog.entries.length, 4);
  assert.deepEqual(harness.providers.registry.get("poe")!.models, []);
});

test("vision 取自目录的输入模态：能看图的为真，文生图与未声明的为假", async () => {
  const harness = await poeWithKey({
    transport: (request) => Promise.resolve(
      request.url.endsWith("/models")
        ? { status: 200, headers: {}, body: CATALOG_BODY }
        : { status: 200, headers: {}, body: CHAT_OK.body },
    ),
  });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  for (const remoteModelId of [REMOTE_ID, "FLUX-pro", "Grok-4"]) {
    await harness.send({ type: "addModel", providerId: "poe", remoteModelId, protocol: "chat_completions" });
  }

  const vision = new Map(
    harness.providers.registry.get("poe")!.models.map((model) => [model.remoteModelId, model.capabilities.vision]),
  );
  assert.equal(vision.get(REMOTE_ID), true);
  // 输出侧的 image 是「能画图」，不是「能读图」，放行了只会把请求发出去挨拒。
  assert.equal(vision.get("FLUX-pro"), false);
  // 目录没声明模态的一律按不支持处理。
  assert.equal(vision.get("Grok-4"), false);
});

test("目录同步会校准已添加模型的 vision，不用删掉重加", async () => {
  // 模型可能是在目录还没有模态数据时加进来的，那时 vision 只能是 false。
  // 如果只在添加那一刻取值，这些模型会永远停在「不支持图片」。
  let catalogBody = JSON.stringify({
    data: [{ id: REMOTE_ID, owned_by: "anthropic", supported_endpoints: ["/v1/chat/completions"] }],
  });
  const harness = await poeWithKey({
    transport: (request) => Promise.resolve(
      request.url.endsWith("/models")
        ? { status: 200, headers: {}, body: catalogBody }
        : { status: 200, headers: {}, body: CHAT_OK.body },
    ),
  });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "chat_completions" });
  assert.equal(harness.providers.registry.get("poe")!.models[0]!.capabilities.vision, false);

  catalogBody = CATALOG_BODY;
  await harness.send({ type: "syncCatalog", providerId: "poe", force: true });

  assert.equal(harness.providers.registry.get("poe")!.models[0]!.capabilities.vision, true);
});

test("手动声明过图片输入后，目录校准不再把它关回去", async () => {
  // 标准 OpenAI 兼容接口的 /models 不返回 architecture.input_modalities，
  // 自动判定永远是 false。用户手动打开后如果还被校准覆盖，表现就是「开关自己关了」。
  const catalogBody = JSON.stringify({
    data: [{ id: REMOTE_ID, owned_by: "anthropic", supported_endpoints: ["/v1/chat/completions"] }],
  });
  const harness = await poeWithKey({
    transport: (request) => Promise.resolve(
      request.url.endsWith("/models")
        ? { status: 200, headers: {}, body: catalogBody }
        : { status: 200, headers: {}, body: CHAT_OK.body },
    ),
  });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "chat_completions" });
  const vision = (): boolean => harness.providers.registry.get("poe")!.models[0]!.capabilities.vision;
  assert.equal(vision(), false);

  await harness.send({ type: "setModelVision", providerId: "poe", modelId: MODEL_ID, vision: true });
  assert.equal(vision(), true);

  await harness.send({ type: "syncCatalog", providerId: "poe", force: true });
  assert.equal(vision(), true, "手动声明应当盖过目录里的沉默");
});

test("校准只动 vision，实测出来的其他能力不受目录影响", async () => {
  const harness = await poeWithKey({
    transport: (request) => Promise.resolve(
      request.url.endsWith("/models")
        ? { status: 200, headers: {}, body: CATALOG_BODY }
        : { status: 200, headers: {}, body: CHAT_OK.body },
    ),
  });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "chat_completions" });
  const before = { ...harness.providers.registry.get("poe")!.models[0]!.capabilities };

  await harness.send({ type: "syncCatalog", providerId: "poe", force: true });

  const after = harness.providers.registry.get("poe")!.models[0]!.capabilities;
  assert.deepEqual(after, before, "目录不该改写 toolCalling / agentCompatible 这些实测结论");
});

test("手动填的服务商没有目录可查，vision 保持关闭", async () => {
  const harness = await createSettingsHarness({
    transport: () => Promise.resolve({ status: 200, headers: {}, body: CHAT_OK.body }),
  });
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });
  await harness.send({ type: "saveKey", providerId: "poe", key: KEY });

  // 没同步过目录就直接添加：entryFor 拿不到条目。
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "chat_completions" });

  assert.equal(harness.providers.registry.get("poe")!.models[0]!.capabilities.vision, false);
});

test("本地 id 带前缀，发给 Poe 的 model 用远端名", async () => {
  const harness = await poeWithKey({
    transport: threeStepTransport({ connection: CHAT_OK, streaming: STREAM_OK, probe: PROBE_OK }),
  });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "responses" });

  const model = harness.providers.registry.get("poe")!.models[0]!;
  assert.equal(model.id, MODEL_ID);
  assert.equal(model.remoteModelId, REMOTE_ID);

  const payloads = harness.requests
    .filter((request) => request.body)
    .map((request) => JSON.parse(request.body!) as { model: string });
  assert.ok(payloads.length >= 3);
  for (const payload of payloads) {
    assert.equal(payload.model, REMOTE_ID, "请求体里不能带 poe: 前缀");
  }
});

test("目录声明了协议时以目录为准，界面选的协议不生效", async () => {
  const harness = await poeWithKey({
    transport: (request) => Promise.resolve(
      request.url.endsWith("/models")
        ? { status: 200, headers: {}, body: CATALOG_BODY }
        : { status: 200, headers: {}, body: CHAT_OK.body },
    ),
  });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  // 界面传 chat_completions，但目录里这个模型只声明了 responses。
  await harness.send({
    type: "addModel",
    providerId: "poe",
    remoteModelId: REMOTE_ID,
    protocol: "chat_completions",
  });

  assert.equal(harness.providers.registry.get("poe")!.models[0]!.protocol, "responses");
  assert.ok(harness.requests.some((request) => request.url.endsWith("/responses")));
});

test("目录没声明协议的模型默认走 Chat Completions，不先撞一次 /responses", async () => {
  // 真实目录里 329 个模型有 263 个不声明 supported_endpoints。
  // 这些模型如果按 Poe 模板的协议先试 Responses，每一个都会先吃一个 400。
  const harness = await poeWithKey({
    transport: (request) => Promise.resolve(
      request.url.endsWith("/models")
        ? { status: 200, headers: {}, body: CATALOG_BODY }
        : { status: 200, headers: {}, body: CHAT_OK.body },
    ),
  });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  const view = harness.messagesOfType("catalog").at(-1)!.catalog;
  const undeclared = view.entries.find((entry) => entry.remoteModelId === "Grok-4")!;
  assert.deepEqual(undeclared.protocols, [], "这一条确实没声明协议");

  // 界面对未声明的条目会退回 Provider 的协议初值。
  await harness.send({
    type: "addModel",
    providerId: "poe",
    remoteModelId: "Grok-4",
    protocol: harness.providers.registry.get("poe")!.protocol as "responses" | "chat_completions",
  });

  assert.equal(harness.providers.registry.get("poe")!.models[0]!.protocol, "chat_completions");
  assert.equal(
    harness.requests.some((request) => request.url.endsWith("/responses")),
    false,
    "未声明协议的模型不该被打到 /responses",
  );
});

test("目录没声明协议时沿用界面选择", async () => {
  const harness = await poeWithKey({
    transport: (request) => Promise.resolve(
      request.url.endsWith("/models")
        ? { status: 200, headers: {}, body: CATALOG_BODY }
        : { status: 200, headers: {}, body: CHAT_OK.body },
    ),
  });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });
  await harness.send({
    type: "addModel",
    providerId: "poe",
    remoteModelId: "Grok-4",
    protocol: "chat_completions",
  });

  assert.equal(harness.providers.registry.get("poe")!.models[0]!.protocol, "chat_completions");
});

// ---------------------------------------------------------------------------
// 三步测试与错误
// ---------------------------------------------------------------------------

test("三步全通过：标记为支持 Agent 并启用 Provider", async () => {
  const harness = await poeWithKey({
    transport: threeStepTransport({
      connection: CHAT_OK,
      streaming: STREAM_OK,
      probe: PROBE_RESPONSES_OK,
    }),
  });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "responses" });

  const result = harness.messagesOfType("testResult").at(-1)?.result;
  assert.equal(result?.conclusion, "agent-ready");

  const model = harness.providers.registry.get("poe")!.models[0]!;
  assert.equal(isModelVerified(model), true);
  assert.equal(model.capabilities.agentCompatible, true);
  assert.equal(harness.providers.registry.get("poe")!.enabled, true);
});

test("能力检测没过只降到仅 Ask，不是拒绝保存", async () => {
  const harness = await poeWithKey({
    transport: threeStepTransport({ connection: CHAT_OK, streaming: STREAM_OK, probe: CHAT_OK }),
  });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "responses" });

  const result = harness.messagesOfType("testResult").at(-1)?.result;
  assert.equal(result?.conclusion, "ask-only");
  assert.equal(result?.savable, true);
  assert.equal(harness.providers.registry.get("poe")!.models[0]!.capabilities.agentCompatible, false);
});

test("Poe 的错误码各自给出可执行的说明，且都不保存模型", async () => {
  // 402 在六种结论里归入「服务不可访问」，但文案必须点明是积分问题，
  // 否则用户会去查网络而不是去充值。
  const cases: Array<[number, string]> = [
    [401, "重新录入"],
    [402, "积分"],
    [404, "拼写"],
    [403, "权限"],
  ];

  for (const [status, hint] of cases) {
    const harness = await poeWithKey({
      transport: () => Promise.resolve({ status, headers: {}, body: "{}" }),
    });
    await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "responses" });

    const result = harness.messagesOfType("testResult").at(-1)?.result;
    assert.ok(result, `${status} 应当产出结论`);
    assert.equal(result.savable, false, `${status} 不该保存为可用模型`);
    assert.ok(JSON.stringify(result).includes(hint), `${status} 的提示应当包含「${hint}」`);
  }
});

test("429 退避两次后放弃，且不换 Provider、模型或协议", async () => {
  const seen: Array<{ url: string; model: string }> = [];
  const harness = await poeWithKey({
    transport: (request) => {
      seen.push({ url: request.url, model: JSON.parse(request.body ?? "{}").model as string });
      return Promise.resolve({ status: 429, headers: {}, body: "{}" });
    },
  });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "responses" });

  // 首发 + 两次退避重试 = 3 次，之后停手。
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.map((entry) => entry.url)).size, 1, "重试必须打同一个端点");
  assert.equal(new Set(seen.map((entry) => entry.model)).size, 1, "重试不得换模型");
  assert.ok(seen[0]!.url.endsWith("/responses"), "退避过程中不得换协议");

  const result = harness.messagesOfType("testResult").at(-1)?.result;
  assert.equal(result?.savable, false);
  assert.ok(JSON.stringify(result).includes("频率"));
});

// ---------------------------------------------------------------------------
// 积分余额
// ---------------------------------------------------------------------------

test("余额查询打 origin 下的端点，而不是 base_url 之下", async () => {
  // 响应结构照抄真实接口的返回。
  const harness = await poeWithKey({
    routes: {
      "/usage/current_balance": {
        status: 200,
        body: JSON.stringify({
          current_point_balance: 654_141,
          plan_points_balance: 654_141,
          addon_point_balance: 0,
          plan_balance_usd: "19.82",
          total_balance_usd: "19.82",
          next_daily_grant_amount: 3000,
        }),
      },
    },
  });
  await harness.send({ type: "checkBalance", providerId: "poe" });

  const request = harness.requests.at(-1);
  assert.equal(request?.url, "https://api.poe.com/usage/current_balance");
  assert.equal(
    harness.messagesOfType("balance").at(-1)?.balance.label,
    "当前剩余 654,141 积分（约 $19.82）",
  );
});

test("接口只给积分不给金额时也能显示", async () => {
  const harness = await poeWithKey({
    routes: {
      "/usage/current_balance": {
        status: 200,
        body: JSON.stringify({ current_point_balance: 1_234_567 }),
      },
    },
  });
  await harness.send({ type: "checkBalance", providerId: "poe" });

  assert.equal(harness.messagesOfType("balance").at(-1)?.balance.label, "当前剩余 1,234,567 积分");
});

test("余额响应字段不认识时明确报错，且不回显原始响应", async () => {
  const harness = await poeWithKey({
    routes: {
      "/usage/current_balance": {
        status: 200,
        body: JSON.stringify({ unexpected: { shape: true }, account_email: "user@example.com" }),
      },
    },
  });
  await harness.send({ type: "checkBalance", providerId: "poe" });

  assert.equal(harness.messagesOfType("balance").length, 0);
  const error = harness.messagesOfType("error").at(-1)?.message ?? "";
  assert.ok(error.includes("积分字段"));
  assert.equal(error.includes("user@example.com"), false);
});

test("余额在 5 分钟内复用缓存，超时后才再查一次", async () => {
  const clock = { value: 5_000_000 };
  const harness = await createSettingsHarness({
    routes: {
      "/usage/current_balance": { status: 200, body: JSON.stringify({ balance: 42 }) },
    },
    now: () => clock.value,
  });
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });
  await harness.send({ type: "saveKey", providerId: "poe", key: KEY });

  const calls = () => harness.requests.filter((r) => r.url.includes("current_balance")).length;
  await harness.send({ type: "checkBalance", providerId: "poe" });
  clock.value += 4 * 60_000;
  await harness.send({ type: "checkBalance", providerId: "poe" });
  assert.equal(calls(), 1, "5 分钟内不该重复请求");

  clock.value += 2 * 60_000;
  await harness.send({ type: "checkBalance", providerId: "poe" });
  assert.equal(calls(), 2);
});

test("没配 Key 时查余额不发请求", async () => {
  const harness = await createSettingsHarness();
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });

  await harness.send({ type: "checkBalance", providerId: "poe" });

  assert.equal(harness.requests.length, 0);
  assert.ok(harness.messagesOfType("error").at(-1)?.message.includes("API Key"));
});

// ---------------------------------------------------------------------------
// 隐私与回归
// ---------------------------------------------------------------------------

test("日志与全部落盘文件中都不含 Key", async () => {
  const harness = await poeWithKey({
    transport: threeStepTransport({ connection: CHAT_OK, streaming: STREAM_OK, probe: PROBE_OK }),
  });
  await harness.send({ type: "addModel", providerId: "poe", remoteModelId: REMOTE_ID, protocol: "responses" });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: true });

  assert.equal(harness.logLines.join("\n").includes(KEY), false);
  const providersFile = await readFile(
    path.join(harness.storageRoot, "agent-providers", "providers.json"),
    "utf8",
  );
  assert.equal(providersFile.includes(KEY), false);
  // Key 只在 Authorization 头里出现，而请求头不进日志。
  assert.ok(harness.requests.some((request) => request.headers.Authorization === `Bearer ${KEY}`));
});

test("添加 Poe 不影响 DeepSeek", async () => {
  const harness = await poeWithKey();
  const deepseek = harness.providers.registry.get("deepseek");

  assert.ok(deepseek);
  assert.notEqual(deepseek.baseUrl, poeProvider().baseUrl);
  assert.ok(deepseek.models.length > 0, "DeepSeek 的内置模型仍在");
  assert.equal(vscodeHarness.state.secrets.get("lingdongAgent.providerKey.deepseek"), undefined);
});
