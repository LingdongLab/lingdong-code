import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { ProviderRegistry } from "../src/models/providers/provider-registry";
import {
  DEEPSEEK_PROVIDER_ID,
  POE_PROVIDER_ID,
  envKeyName,
  poeProvider,
  secretIdFor,
  type ProviderConfig,
} from "../src/models/providers/provider-types";

async function createRegistry(): Promise<{ registry: ProviderRegistry; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "lingdong-providers-"));
  const registry = new ProviderRegistry({ fs: createNodeFileSystem(), storageRoot: root });
  await registry.load();
  return { registry, root };
}

function customProvider(id = "my-gateway"): ProviderConfig {
  return {
    id,
    type: "custom-openai-compatible",
    displayName: "我的网关",
    baseUrl: "https://api.example.com/v1",
    protocol: "chat_completions",
    enabled: true,
    secretId: secretIdFor(id),
    models: [
      {
        id: "gateway-model",
        displayName: "网关模型",
        enabled: true,
        protocol: "chat_completions",
        capabilities: {
          streaming: true,
          toolCalling: false,
          reasoning: false,
          vision: false,
          agentCompatible: false,
        },
      },
    ],
  };
}

test("首次加载会按现有 DeepSeek 配置播种，并且不预置 xAI", async () => {
  const { registry } = await createRegistry();
  const providers = registry.list();
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, DEEPSEEK_PROVIDER_ID);
  assert.equal(providers[0]?.baseUrl, "https://api.deepseek.com");
  // 未经用户选择的 xAI 回退是本阶段明确禁止的。
  assert.equal(providers.some((provider) => /xai|grok/i.test(provider.id)), false);
});

test("Provider 与模型支持增删改查与启用禁用", async () => {
  const { registry } = await createRegistry();
  await registry.upsertProvider(customProvider());
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get("my-gateway")?.displayName, "我的网关");
  assert.equal(registry.models("my-gateway").length, 1);

  await registry.upsertModel("my-gateway", {
    id: "second-model",
    displayName: "第二个模型",
    enabled: true,
    protocol: "responses",
    capabilities: {
      streaming: true,
      toolCalling: true,
      reasoning: false,
      vision: false,
      agentCompatible: true,
    },
  });
  assert.equal(registry.models("my-gateway").length, 2);

  await registry.setModelEnabled("my-gateway", "second-model", false);
  assert.equal(registry.enabledModels().some((entry) => entry.model.id === "second-model"), false);

  await registry.setProviderEnabled("my-gateway", false);
  assert.equal(registry.enabledModels().some((entry) => entry.provider.id === "my-gateway"), false);

  assert.equal(await registry.removeModel("my-gateway", "second-model"), true);
  assert.equal(await registry.removeProvider("my-gateway"), true);
  assert.equal(registry.get("my-gateway"), undefined);
});

test("落盘文件里不出现任何凭据字段，只有 secretId", async () => {
  const { registry, root } = await createRegistry();
  await registry.upsertProvider(customProvider());
  const raw = await readFile(path.join(root, "agent-providers", "providers.json"), "utf8");
  assert.equal(raw.includes("secretId"), true);
  // 类型里就没有 key 字段，这里再确认一遍序列化结果。
  assert.equal(/"api[_-]?key"/i.test(raw), false);
  assert.equal(/"key"\s*:/i.test(raw), false);
});

test("找不到模型时返回 undefined，不给替代品", async () => {
  const { registry } = await createRegistry();
  assert.equal(registry.findModel("不存在的模型"), undefined);
  assert.equal(registry.models("不存在的服务商").length, 0);
  // 有 DeepSeek 在也不会被当作兜底返回。
  assert.notEqual(registry.list().length, 0);
});

test("环境变量名按 Provider 派生，不同 Provider 不共用一个槽位", async () => {
  const { registry } = await createRegistry();
  assert.equal(registry.envKeyFor("deepseek"), "LINGDONG_KEY_DEEPSEEK");
  assert.equal(envKeyName("custom-openai-compatible"), "LINGDONG_KEY_CUSTOM_OPENAI_COMPATIBLE");
  assert.notEqual(envKeyName("poe"), envKeyName("deepseek"));
});

test("内置模板的地址与协议按模板纠正，存量安装不用删掉重加", async () => {
  const { registry, root } = await createRegistry();
  // 模拟一份旧配置：模板后来改了协议，磁盘上存的还是老值。
  await registry.upsertProvider({
    ...poeProvider(),
    baseUrl: "https://api.poe.com",
    protocol: "responses",
    enabled: true,
  });

  const reopened = new ProviderRegistry({ fs: createNodeFileSystem(), storageRoot: root });
  await reopened.load();
  const poe = reopened.get(POE_PROVIDER_ID);
  assert.equal(poe?.protocol, "chat_completions");
  assert.equal(poe?.baseUrl, "https://api.poe.com/v1");
  // 用户自己的开关不受影响。
  assert.equal(poe?.enabled, true);
});

test("自定义 Provider 的地址与协议原样保留", async () => {
  const { registry, root } = await createRegistry();
  await registry.upsertProvider({ ...customProvider(), protocol: "responses" });

  const reopened = new ProviderRegistry({ fs: createNodeFileSystem(), storageRoot: root });
  await reopened.load();
  assert.equal(reopened.get("my-gateway")?.protocol, "responses");
  assert.equal(reopened.get("my-gateway")?.baseUrl, "https://api.example.com/v1");
});

test("重新加载能读回已保存的 Provider", async () => {
  const { registry, root } = await createRegistry();
  await registry.upsertProvider(customProvider());

  const reopened = new ProviderRegistry({ fs: createNodeFileSystem(), storageRoot: root });
  await reopened.load();
  assert.equal(reopened.get("my-gateway")?.baseUrl, "https://api.example.com/v1");
  // 未检测过的模型不能默认放行 Agent。
  assert.equal(reopened.models("my-gateway")[0]?.capabilities.agentCompatible, false);
});
