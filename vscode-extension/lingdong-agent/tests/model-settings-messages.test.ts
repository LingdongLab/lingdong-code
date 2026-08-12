import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  parseModelSettingsMessage,
  protocolDisplayName,
  type ModelSettingsHostMessage,
} from "../src/model-settings-messages";

const SOURCE = readFileSync(
  path.join(__dirname, "..", "src", "model-settings-messages.ts"),
  "utf8",
);

test("设置页协议里没有任何可以取回 API Key 的消息", () => {
  // 入站联合类型只允许写入 Key，没有 getKey / revealKey / requestKey 之类的入口。
  assert.equal(/getKey|revealKey|requestKey|fetchKey/i.test(SOURCE), false);

  // 随便造一条「求 Key」的消息，一定被丢弃。
  for (const type of ["getKey", "revealKey", "requestKey", "readKey"]) {
    assert.equal(parseModelSettingsMessage({ type, providerId: "deepseek" }), undefined);
  }
});

test("出站消息只表达凭据状态，不含 Key 本身", () => {
  const saved: ModelSettingsHostMessage = { type: "keySaved", providerId: "deepseek", configured: true };
  assert.deepEqual(Object.keys(saved).sort(), ["configured", "providerId", "type"]);

  // 视图类型里能表达凭据的字段只有布尔的 keyConfigured。
  assert.ok(SOURCE.includes("keyConfigured: boolean"));
  assert.equal(/apiKey\s*:/i.test(SOURCE), false);
  assert.equal(/keyPreview|keySuffix|maskedKey|keyPrefix/i.test(SOURCE), false);
});

test("保存 Key 校验非空与长度上限，超长直接丢弃", () => {
  assert.deepEqual(
    parseModelSettingsMessage({ type: "saveKey", providerId: "deepseek", key: "  sk-abc  " }),
    { type: "saveKey", providerId: "deepseek", key: "sk-abc" },
  );
  assert.equal(parseModelSettingsMessage({ type: "saveKey", providerId: "deepseek", key: "   " }), undefined);
  assert.equal(
    parseModelSettingsMessage({ type: "saveKey", providerId: "deepseek", key: "x".repeat(513) }),
    undefined,
  );
  assert.equal(parseModelSettingsMessage({ type: "saveKey", providerId: "deepseek", key: 42 }), undefined);
});

test("标识允许命名空间冒号，但拒绝路径与空格", () => {
  const ok = parseModelSettingsMessage({
    type: "testModel",
    providerId: "poe",
    modelId: "poe:Claude-Sonnet-4.6",
  });
  assert.deepEqual(ok, { type: "testModel", providerId: "poe", modelId: "poe:Claude-Sonnet-4.6" });

  for (const bad of ["../etc/passwd", "poe/models", "poe model", "", "x".repeat(129)]) {
    assert.equal(
      parseModelSettingsMessage({ type: "testModel", providerId: "poe", modelId: bad }),
      undefined,
      `应当拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test("协议必须落在固定集合内", () => {
  assert.equal(
    parseModelSettingsMessage({
      type: "addModel",
      providerId: "poe",
      remoteModelId: "GPT-5",
      protocol: "responses",
    })?.type,
    "addModel",
  );
  for (const bad of ["messages", "grpc", "", 1, null]) {
    assert.equal(
      parseModelSettingsMessage({
        type: "addModel",
        providerId: "poe",
        remoteModelId: "GPT-5",
        protocol: bad,
      }),
      undefined,
    );
  }
});

test("自定义服务商草稿校验名称、地址长度与模型名", () => {
  const draft = {
    displayName: "我的网关",
    baseUrl: "https://api.example.com/v1",
    protocol: "chat_completions",
    remoteModelId: "qwen2.5-coder",
    contextWindow: 32768,
  };
  const parsed = parseModelSettingsMessage({ type: "addCustomProvider", draft });
  assert.equal(parsed?.type, "addCustomProvider");
  assert.equal(parsed?.type === "addCustomProvider" && parsed.draft.contextWindow, 32768);

  // 超长 baseUrl、空名称、缺模型名都不成立。
  assert.equal(
    parseModelSettingsMessage({
      type: "addCustomProvider",
      draft: { ...draft, baseUrl: `https://a.com/${"x".repeat(2_048)}` },
    }),
    undefined,
  );
  assert.equal(
    parseModelSettingsMessage({ type: "addCustomProvider", draft: { ...draft, displayName: "   " } }),
    undefined,
  );
  assert.equal(
    parseModelSettingsMessage({ type: "addCustomProvider", draft: { ...draft, remoteModelId: "" } }),
    undefined,
  );
  // 负数或离谱的上下文长度当作没填，而不是整条丢弃。
  const noWindow = parseModelSettingsMessage({
    type: "addCustomProvider",
    draft: { ...draft, contextWindow: -1 },
  });
  assert.equal(noWindow?.type === "addCustomProvider" && noWindow.draft.contextWindow, undefined);
});

test("显示名剔除控制字符并限制长度", () => {
  const parsed = parseModelSettingsMessage({
    type: "renameModel",
    providerId: "poe",
    modelId: "poe:GPT-5",
    displayName: "GPT\u0000-5\u001b 旗舰",
  });
  assert.equal(parsed?.type === "renameModel" && parsed.displayName, "GPT-5 旗舰");

  assert.equal(
    parseModelSettingsMessage({
      type: "renameModel",
      providerId: "poe",
      modelId: "poe:GPT-5",
      displayName: "名".repeat(65),
    }),
    undefined,
  );
});

test("结构非法与未知类型一律丢弃，不透传未知字段", () => {
  for (const bad of [undefined, null, 1, "ready", [], { type: 1 }, { type: "unknown" }]) {
    assert.equal(parseModelSettingsMessage(bad), undefined);
  }
  // 白名单式重建：额外字段不会跟着进来。
  const parsed = parseModelSettingsMessage({
    type: "setProviderEnabled",
    providerId: "deepseek",
    enabled: true,
    evil: "drop me",
  });
  assert.deepEqual(parsed, { type: "setProviderEnabled", providerId: "deepseek", enabled: true });
});

test("协议展示名两侧共用一份文案", () => {
  assert.equal(protocolDisplayName("responses"), "Responses");
  assert.equal(protocolDisplayName("chat_completions"), "Chat Completions");
  assert.equal(protocolDisplayName("messages"), "Messages");
});
