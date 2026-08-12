import assert from "node:assert/strict";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_TEST_KEY,
  createControllerHarness,
  flush,
} from "./support/controller-harness";

test("子进程环境只带当前 Provider 的凭据，其它模型 Key 全部剥离", async () => {
  process.env.XAI_API_KEY = "xai-should-be-stripped";
  process.env.OPENAI_API_KEY = "openai-should-be-stripped";
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("你好");
    await flush();

    const env = harness.runtime().options.env ?? {};
    assert.equal(env.LINGDONG_KEY_DEEPSEEK, DEFAULT_TEST_KEY);
    assert.equal(env.XAI_API_KEY, undefined, "XAI_API_KEY 必须剥离，否则凭据链会悄悄回退");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.DEEPSEEK_API_KEY, undefined, "旧的环境变量不再继承");
  } finally {
    delete process.env.XAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await harness.dispose();
  }
});

test("子进程环境强制关闭遥测类通道", async () => {
  process.env.GROK_TELEMETRY_ENABLED = "1";
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("你好");
    await flush();
    const env = harness.runtime().options.env ?? {};
    assert.equal(env.GROK_TELEMETRY_ENABLED, "0");
    assert.equal(env.GROK_TELEMETRY_TRACE_UPLOAD, "0");
    assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
    // web_fetch 默认关：显式写 0，交给 lingdongAgent.webFetch 设置项开。
    assert.equal(env.GROK_WEB_FETCH, "0");
  } finally {
    delete process.env.GROK_TELEMETRY_ENABLED;
    await harness.dispose();
  }
});

test("GROK_HOME 指向托管目录，config.toml 由扩展生成且不含凭据", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("你好");
    await flush();

    const managed = path.join(harness.storageRoot, "grok-home");
    assert.equal(harness.runtime().options.grokHome, managed);

    const config = await readFile(path.join(managed, "config.toml"), "utf8");
    assert.ok(config.includes("telemetry = false"));
    assert.ok(config.includes("remote_fetch = false"));
    assert.ok(config.includes('env_key = "LINGDONG_KEY_DEEPSEEK"'));
    assert.equal(config.includes(DEFAULT_TEST_KEY), false, "config.toml 里绝不能出现凭据");
    assert.equal(/\bapi_key\b/.test(config), false);
  } finally {
    await harness.dispose();
  }
});

test("凭据缺失时明确失败，不静默换成别的 Provider", async () => {
  const harness = createControllerHarness({ providerKey: null });
  try {
    await harness.controller.sendPrompt("你好");
    await flush();

    assert.equal(harness.runtimes.length, 0, "没有凭据不该拉起子进程");
    // 提示走对话面板，不是 VS Code toast：装机首次打开就会撞上，弹窗太重。
    const surfaced = [...harness.messagesOfType("notice"), ...harness.messagesOfType("error")];
    const blocking = surfaced.find((message) => message.message.includes("凭据"));
    assert.ok(blocking, `应给出凭据相关的提示，实际：${surfaced.map((m) => m.message).join(" / ")}`);
    assert.ok(
      blocking.actions?.some((action) => action.id === "configureProviderKey"),
      "提示必须带一个能直接去填 Key 的按钮",
    );
    // 同一句话只说一遍：编排层发过带按钮的卡后，上层不该再补一张。
    assert.equal(
      surfaced.filter((message) => message.message === blocking.message).length,
      1,
      "缺凭据的提示不该重复出现两张卡",
    );
  } finally {
    await harness.dispose();
  }
});

test("改完当前 Provider 的密钥后会重启子进程，新环境带上新 Key", async () => {
  // 用户反馈：设置页重新填了 DeepSeek Key，对话仍然 401。
  // 根因是密钥进了 SecretStorage，但已启动的子进程环境变量不会跟着变。
  const harness = createControllerHarness();
  const freshKey = "sk-fresh-deepseek-key-abcdef0123456789";
  try {
    await harness.controller.sendPrompt("预热");
    await flush();
    assert.equal(harness.runtime().options.env?.LINGDONG_KEY_DEEPSEEK, DEFAULT_TEST_KEY);
    assert.equal(harness.runtimes.length, 1);

    await harness.controller.modelSettings.handle({
      type: "saveKey",
      providerId: "deepseek",
      key: freshKey,
    });
    await flush();

    assert.equal(harness.runtimes.length, 2, "密钥变了必须拉起新的子进程");
    assert.equal(
      harness.runtime().options.env?.LINGDONG_KEY_DEEPSEEK,
      freshKey,
      "新子进程必须带上刚保存的 Key，否则会继续用旧 Key 撞 401",
    );
    assert.ok(
      harness.messagesOfType("notice").some((message) => message.message.includes("重新连接")),
      "应明确告诉用户正在为新凭据重连",
    );
  } finally {
    await harness.dispose();
  }
});

test("一个凭据都没配过时，提示是去填 Key，而不是说这个会话原来用过什么", async () => {
  // 装机后第一次打开撞的就是这一条：模型来自设置项默认值，用户从没选过，
  // 说「原来使用」是句假话，而且把唯一该做的那一步藏起来了。
  const harness = createControllerHarness({ providerKey: null });
  try {
    await harness.controller.sendPrompt("你好");
    await flush();

    const notices = harness.messagesOfType("notice");
    const onboarding = notices.find((entry) => entry.message.includes("还没有配置任何模型凭据"));
    assert.ok(onboarding, `实际文案：${notices.map((entry) => entry.message).join(" / ")}`);
    assert.equal(onboarding.message.includes("原来使用"), false);
    // 还没开始不是出错了。红色的卡会让人以为装坏了。
    assert.equal(onboarding.level, "info");
    assert.equal(
      harness.messagesOfType("error").some((entry) => entry.message.includes("还没有配置任何模型凭据")),
      false,
      "首启这条已经降成灰色提示，不该同时再来一张红卡",
    );
  } finally {
    await harness.dispose();
  }
});

test("会话记录写下 providerId，Key 不进任何会话文件", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("你好");
    await flush();

    const sessionId = harness.controller.activeSessionId;
    assert.ok(sessionId);
    // 会话目录名用的是工作区哈希，直接扫整棵存储树更可靠。
    const files = await collectJson(harness.storageRoot);
    const providerRecorded = files.some((content) => content.includes('"providerId": "deepseek"'));
    assert.equal(providerRecorded, true, "会话应记录 providerId");
    for (const content of files) {
      assert.equal(content.includes(DEFAULT_TEST_KEY), false, "任何落盘文件都不能含凭据");
    }
  } finally {
    await harness.dispose();
  }
});

test("Output Channel 日志经过脱敏", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("你好");
    await flush();
    const joined = harness.logLines.join("\n");
    assert.equal(joined.includes(DEFAULT_TEST_KEY), false);
  } finally {
    await harness.dispose();
  }
});

test("隐私状态反映真实运行画像", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("你好");
    await flush();

    const text = await harness.controller.privacyStatusText();
    assert.ok(text.includes("DeepSeek"));
    assert.ok(text.includes("api.deepseek.com"));
    assert.ok(text.includes("遥测：已关闭"));
    assert.ok(text.includes("API Key：已配置"));
    assert.equal(text.includes(DEFAULT_TEST_KEY), false);
  } finally {
    await harness.dispose();
  }
});

test("未连接时隐私状态不谎报通道已关闭", async () => {
  const harness = createControllerHarness();
  try {
    const text = await harness.controller.privacyStatusText();
    assert.ok(text.includes("尚未连接"));
  } finally {
    await harness.dispose();
  }
});

/** 递归读出目录下所有 json 文件内容。 */
async function collectJson(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const results: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith(".json")) {
        results.push(await readFile(target, "utf8").catch(() => ""));
      }
    }
  };
  await walk(root);
  return results;
}
