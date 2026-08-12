import assert from "node:assert/strict";
import test from "node:test";
import { parseWebviewMessage } from "../src/messages";
import { toModelDescriptors } from "../src/model-registry";
import { renderGrokConfig, type ResolvedModelEntry } from "../src/models/providers/grok-config-writer";
import {
  apiModelIdOf,
  deepseekProvider,
  envKeyName,
  isModelVerified,
  localModelId,
  type ProviderModelConfig,
} from "../src/models/providers/provider-types";

function entry(overrides: Partial<ResolvedModelEntry> = {}): ResolvedModelEntry {
  return {
    modelId: "poe:Claude-Sonnet-4.6",
    apiModelId: "Claude-Sonnet-4.6",
    baseUrl: "https://api.poe.com/v1",
    displayName: "Claude Sonnet 4.6",
    envKeyName: envKeyName("poe"),
    apiBackend: "chat_completions",
    ...overrides,
  };
}

test("本地键与远端模型名分离：表键用本地 id，model 用远端名", () => {
  const config = renderGrokConfig({ models: [entry()], defaultModelId: "poe:Claude-Sonnet-4.6" });

  // 含冒号与点的键必须整段加引号，否则 TOML 会解析成嵌套表。
  assert.ok(config.includes('[model."poe:Claude-Sonnet-4.6"]'));
  assert.ok(config.includes('model = "Claude-Sonnet-4.6"'));
  assert.ok(config.includes('default = "poe:Claude-Sonnet-4.6"'));
  // 发给服务商的名字里不能带命名空间前缀，否则对端根本不认识这个模型。
  assert.equal(config.includes('model = "poe:Claude-Sonnet-4.6"'), false);
});

test("同名模型来自两个服务商时互不冲突", () => {
  const config = renderGrokConfig({
    models: [
      entry({ modelId: "poe:DeepSeek-R1", apiModelId: "DeepSeek-R1" }),
      entry({
        modelId: "gateway:DeepSeek-R1",
        apiModelId: "DeepSeek-R1",
        baseUrl: "https://api.example.com/v1",
        envKeyName: envKeyName("gateway"),
      }),
    ],
    defaultModelId: "gateway:DeepSeek-R1",
  });

  assert.ok(config.includes('[model."poe:DeepSeek-R1"]'));
  assert.ok(config.includes('[model."gateway:DeepSeek-R1"]'));
  // 两张表各自指向自己的凭据变量，不会串。
  assert.ok(config.includes('env_key = "LINGDONG_KEY_POE"'));
  assert.ok(config.includes('env_key = "LINGDONG_KEY_GATEWAY"'));
});

test("既有 DeepSeek 条目一个字都没改，也不需要迁移", () => {
  const provider = deepseekProvider();
  const model = provider.models[0]!;

  assert.equal(model.id, "deepseek-v4-flash");
  assert.equal(model.remoteModelId, undefined, "旧条目不写 remoteModelId");
  // 缺省时 apiModelId 回落到本地 id，行为与 G-R7a 完全一致。
  assert.equal(apiModelIdOf(model), "deepseek-v4-flash");
  assert.equal(isModelVerified(model), true, "缺省视为已验证，否则老用户的模型会突然消失");

  const config = renderGrokConfig({
    models: [entry({
      modelId: model.id,
      apiModelId: apiModelIdOf(model),
      baseUrl: provider.baseUrl,
      displayName: model.displayName,
      envKeyName: envKeyName(provider.id),
    })],
    defaultModelId: model.id,
  });
  // 纯字母数字连字符的键不加引号，跟改动前生成的文件逐字一致。
  assert.ok(config.includes("[model.deepseek-v4-flash]"));
  assert.ok(config.includes('model = "deepseek-v4-flash"'));
});

test("localModelId 拼出命名空间键，apiModelIdOf 取回远端名", () => {
  assert.equal(localModelId("poe", "Claude-Sonnet-4.6"), "poe:Claude-Sonnet-4.6");

  const namespaced: ProviderModelConfig = {
    id: localModelId("poe", "GPT-5"),
    remoteModelId: "GPT-5",
    displayName: "GPT-5",
    enabled: true,
    protocol: "chat_completions",
    capabilities: {
      streaming: true,
      toolCalling: true,
      reasoning: false,
      vision: false,
      agentCompatible: true,
    },
  };
  assert.equal(apiModelIdOf(namespaced), "GPT-5");
});

test("selectModel 放宽到允许冒号与 128 字符，但仍拒绝路径与空白", () => {
  assert.deepEqual(
    parseWebviewMessage({ type: "selectModel", modelId: "poe:Claude-Sonnet-4.6" }),
    { type: "selectModel", modelId: "poe:Claude-Sonnet-4.6" },
  );
  // 旧的短 id 照旧接受。
  assert.deepEqual(
    parseWebviewMessage({ type: "selectModel", modelId: "deepseek-v4-flash" }),
    { type: "selectModel", modelId: "deepseek-v4-flash" },
  );

  const longId = `poe:${"a".repeat(124)}`;
  assert.equal(longId.length, 128);
  assert.equal(parseWebviewMessage({ type: "selectModel", modelId: longId })?.type, "selectModel");
  assert.equal(parseWebviewMessage({ type: "selectModel", modelId: `${longId}a` }), undefined);

  // 首尾空白会被 trim 掉再校验，所以换行要放在中间才算真的非法。
  for (const bad of ["", "   ", "../../etc/passwd", "poe/Claude", "poe Claude", "poe:Cla\nude"]) {
    assert.equal(
      parseWebviewMessage({ type: "selectModel", modelId: bad }),
      undefined,
      `应当拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test("未通过连接测试的模型不进 Composer，缺省字段的老条目照旧可见", () => {
  const descriptors = toModelDescriptors([{
    id: "gateway",
    displayName: "自定义网关",
    enabled: true,
    models: [
      {
        id: "gateway:verified",
        displayName: "已验证",
        enabled: true,
        capabilities: { toolCalling: true, vision: false, reasoning: false, agentCompatible: true },
      },
      {
        id: "gateway:unverified",
        displayName: "未验证",
        enabled: true,
        verified: false,
        capabilities: { toolCalling: false, vision: false, reasoning: false, agentCompatible: false },
      },
    ],
  }]);

  const ids = descriptors.map((model) => model.id);
  assert.deepEqual(ids, ["gateway:verified"]);
  assert.equal(descriptors[0]?.providerId, "gateway");
  assert.equal(descriptors[0]?.provider, "自定义网关");
});

test("Provider 未启用或未配置凭据时，它的模型一个都不展示", () => {
  const providers = [{
    id: "gateway",
    displayName: "自定义网关",
    enabled: true,
    models: [{
      id: "gateway:qwen",
      displayName: "Qwen",
      enabled: true,
      capabilities: { toolCalling: true, vision: false, reasoning: false, agentCompatible: true },
    }],
  }];

  assert.equal(toModelDescriptors(providers, { hasKey: () => true }).length, 1);
  // 没配 Key 的模型摆在选择器里只会在发送时失败，不如一开始就不显示。
  assert.equal(toModelDescriptors(providers, { hasKey: () => false }).length, 0);
  assert.equal(
    toModelDescriptors([{ ...providers[0]!, enabled: false }], { hasKey: () => true }).length,
    0,
  );
});
