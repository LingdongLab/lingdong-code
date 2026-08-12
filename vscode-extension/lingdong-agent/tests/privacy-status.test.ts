import assert from "node:assert/strict";
import test from "node:test";
import { MANAGED_CHANNELS, type RuntimeModelProfile } from "../src/models/providers/runtime-model-profile";
import { renderPrivacyStatus } from "../src/privacy/privacy-status";
import { PRIVACY_ENV } from "../src/privacy/runtime-env";

function profile(overrides: Partial<RuntimeModelProfile> = {}): RuntimeModelProfile {
  return {
    providerId: "deepseek",
    providerName: "DeepSeek",
    modelId: "deepseek-v4-flash",
    modelName: "DeepSeek V4 Flash",
    baseUrlHost: "api.deepseek.com",
    protocol: "responses",
    envKeyName: "LINGDONG_KEY_DEEPSEEK",
    channels: { ...MANAGED_CHANNELS },
    configFile: "C:/store/grok-home/config.toml",
    grokHome: "C:/store/grok-home",
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("状态来自 Profile 而不是写死：换一个 Provider 文案跟着变", () => {
  const deepseek = renderPrivacyStatus({
    profile: profile(),
    keyConfigured: true,
    managedHome: true,
    privacyEnv: PRIVACY_ENV,
    strippedCredentials: ["XAI_API_KEY"],
  });
  assert.ok(deepseek.includes("DeepSeek"));
  assert.ok(deepseek.includes("api.deepseek.com"));

  const poe = renderPrivacyStatus({
    profile: profile({ providerId: "poe", providerName: "Poe", baseUrlHost: "api.poe.com" }),
    keyConfigured: true,
    managedHome: true,
    privacyEnv: PRIVACY_ENV,
    strippedCredentials: [],
  });
  assert.ok(poe.includes("api.poe.com"));
  assert.equal(poe.includes("api.deepseek.com"), false);
});

test("各通道按 Profile 逐条如实展示：遥测类关闭，联网能力开启", () => {
  const text = renderPrivacyStatus({
    profile: profile(),
    keyConfigured: true,
    managedHome: true,
    privacyEnv: PRIVACY_ENV,
    strippedCredentials: [],
  });
  for (const line of [
    "遥测：已关闭",
    "Trace 上传：已关闭",
    "Mixpanel：已关闭",
    "外部 OTEL：已关闭",
    "Feedback：已关闭",
    "自动更新：已关闭",
    "远程目录抓取：已关闭",
    "Grok 自带 web_fetch：已开启",
    "内置 backend Web Search：已关闭",
    "宿主侧 Web Search：已开启（MCP lingdong_web → DuckDuckGo",
    // 宿主自带 WebFetch 必须单独列一行：否则用户看到「Grok 自带 web_fetch 已关闭」
    // 会以为读网页的能力整个没了，进而去开那个其实多余的开关。
    "宿主侧 Web Fetch：已开启（MCP lingdong_web",
  ]) {
    assert.ok(text.includes(line), `缺少「${line}」`);
  }
});

test("通道开着就如实显示已开启，不粉饰", () => {
  const text = renderPrivacyStatus({
    profile: profile({ channels: { ...MANAGED_CHANNELS, telemetry: true, remoteFetch: true } }),
    keyConfigured: true,
    managedHome: false,
    privacyEnv: PRIVACY_ENV,
    strippedCredentials: [],
  });
  assert.ok(text.includes("遥测：已开启"));
  assert.ok(text.includes("远程目录抓取：已开启"));
  assert.ok(text.includes("无法保证"), "托管关闭时必须说明开关无法保证");
});

test("只显示是否已配置，绝不出现真实 Key 或它的片段", () => {
  const text = renderPrivacyStatus({
    profile: profile(),
    keyConfigured: true,
    managedHome: true,
    privacyEnv: PRIVACY_ENV,
    strippedCredentials: [],
  });
  assert.ok(text.includes("API Key：已配置"));
  // 变量名可以出现，值不行。
  assert.ok(text.includes("LINGDONG_KEY_DEEPSEEK"));
  assert.equal(text.includes("sk-"), false);
});

test("未配置凭据时如实显示未配置", () => {
  const text = renderPrivacyStatus({
    profile: profile(),
    keyConfigured: false,
    managedHome: true,
    privacyEnv: PRIVACY_ENV,
    strippedCredentials: [],
  });
  assert.ok(text.includes("API Key：未配置"));
});

test("尚未连接时不把设置里的期望值当成运行状态", () => {
  const text = renderPrivacyStatus({
    profile: undefined,
    keyConfigured: false,
    managedHome: true,
    privacyEnv: PRIVACY_ENV,
    strippedCredentials: [],
  });
  assert.ok(text.includes("尚未连接"));
  assert.equal(text.includes("遥测：已关闭"), false);
});

test("明确标注网络行为仍待抓包验收", () => {
  const text = renderPrivacyStatus({
    profile: profile(),
    keyConfigured: true,
    managedHome: true,
    privacyEnv: PRIVACY_ENV,
    strippedCredentials: [],
  });
  assert.ok(text.includes("待抓包"));
  // 不允许出现「不会向其他服务器上传」这类无法验证的断言。
  assert.equal(text.includes("不会向其他服务器"), false);
});
