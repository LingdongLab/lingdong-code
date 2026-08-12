import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentRuntimeHandle } from "@lingdong/agent-runtime";
import type { HostToWebviewMessage } from "../src/messages";
import { ModelRegistry } from "../src/model-registry";
import { secretIdFor, type ProviderConfig } from "../src/models/providers/provider-types";
import { ModelFacade, type ModelFacadeDeps } from "../src/services/model-facade";
import type { SessionRecord } from "../src/storage/session-repository";
import { SCHEMA_VERSION } from "../src/storage/storage-migration";
import { AgentWorkspaceStore } from "../src/workspace-store";
import {
  DEFAULT_TEST_KEY,
  createControllerHarness,
  flush,
  type FakeRuntime,
} from "./support/controller-harness";
import { __test as vscodeHarness } from "./support/vscode-stub";

const GATEWAY_KEY = "sk-gateway-only-for-gateway-0123456789";

function gateway(overrides: Partial<ProviderConfig["models"][number]> = {}): ProviderConfig {
  return {
    id: "gateway",
    type: "custom-openai-compatible",
    displayName: "自定义网关",
    baseUrl: "https://api.example.com/v1",
    protocol: "chat_completions",
    enabled: true,
    secretId: secretIdFor("gateway"),
    models: [{
      id: "gateway:qwen2.5",
      remoteModelId: "qwen2.5",
      displayName: "Qwen 2.5",
      enabled: true,
      protocol: "chat_completions",
      capabilities: {
        streaming: true,
        toolCalling: true,
        reasoning: false,
        vision: false,
        agentCompatible: true,
      },
      ...overrides,
    }],
  };
}

/**
 * 预置一个 providers.json，让控制器启动时就看到两个 Provider。
 * 直接写文件而不是走设置页，是为了把这组测试聚焦在「切换」本身。
 */
async function seedStorage(providers: ProviderConfig[]): Promise<string> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "lingdong-switch-"));
  await mkdir(path.join(storageRoot, "agent-providers"), { recursive: true });
  await writeFile(
    path.join(storageRoot, "agent-providers", "providers.json"),
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "providers", updatedAt: 1, data: { providers } }),
    "utf8",
  );
  return storageRoot;
}

/**
 * 从落盘目录里翻出会话记录。
 * 控制器没有暴露「当前会话」的公开访问器，而这组断言关心的恰恰是**存下来的东西**，
 * 读盘反而比读内存更贴近「重开扩展后还认得这个模型」的真实场景。
 */
async function readSessionRecords(root: string): Promise<Array<Record<string, unknown>>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "session.json") {
        const parsed = JSON.parse(await readFile(full, "utf8")) as { data?: Record<string, unknown> };
        if (parsed.data) found.push(parsed.data);
      }
    }
  };
  await walk(root);
  return found;
}

/** DeepSeek 的既有条目，保持 G-R7a 播种时的样子。 */
function deepseek(): ProviderConfig {
  return {
    id: "deepseek",
    type: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    protocol: "chat_completions",
    enabled: true,
    secretId: secretIdFor("deepseek"),
    models: [{
      id: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      enabled: true,
      protocol: "chat_completions",
      contextWindow: 128_000,
      capabilities: {
        streaming: true,
        toolCalling: true,
        reasoning: true,
        vision: false,
        agentCompatible: true,
      },
    }],
  };
}

async function twoProviderHarness(
  gatewayProvider = gateway(),
  onCreateRuntime?: (runtime: FakeRuntime) => void,
) {
  const storageRoot = await seedStorage([deepseek(), gatewayProvider]);
  const harness = createControllerHarness({
    storageRoot,
    ...(onCreateRuntime ? { onCreateRuntime } : {}),
  });
  vscodeHarness.state.secrets.set(secretIdFor("gateway"), GATEWAY_KEY);
  vscodeHarness.state.globalState.set("lingdongAgent.providerKeyIndex", ["deepseek", "gateway"]);
  return harness;
}

test("Composer 的模型列表按 Provider 分组，并带上所属服务商", async () => {
  const harness = await twoProviderHarness();
  try {
    await harness.controller.sendPrompt("预热");
    await flush();

    const models = harness.messagesOfType("models").at(-1);
    const ids = models?.models.map((model) => model.id) ?? [];
    assert.ok(ids.includes("deepseek-v4-flash"));
    assert.ok(ids.includes("gateway:qwen2.5"));

    const providers = new Set(models?.models.map((model) => model.provider));
    assert.equal(providers.size, 2, "两个服务商必须各自成组");
  } finally {
    await harness.dispose();
  }
});

test("切换模型后会话同时记下 providerId 与 modelId", async () => {
  const harness = await twoProviderHarness();
  try {
    await harness.controller.sendPrompt("预热");
    await flush();

    await harness.controller.selectModel("gateway:qwen2.5");
    await flush();
    await harness.controller.dispose();

    const sessions = await readSessionRecords(harness.storageRoot);
    const active = sessions.find((record) => record.id === harness.controller.activeSessionId)
      ?? sessions.at(-1);
    assert.equal(active?.modelId, "gateway:qwen2.5");
    assert.equal(active?.providerId, "gateway", "只记 modelId 的话，恢复会话时无从知道该注入哪把 Key");
  } finally {
    await harness.dispose();
  }
});

test("启动即注入全部已启用 Provider 的凭据，跨 Provider 切换零重启", async () => {
  const harness = await twoProviderHarness();
  try {
    await harness.controller.sendPrompt("预热");
    await flush();

    // 全量注入：两个已启用且有密钥的 Provider 都在子进程环境里。
    const env = harness.runtime().options.env ?? {};
    const injected = Object.keys(env).filter((name) => name.startsWith("LINGDONG_KEY_")).sort();
    assert.equal(env.LINGDONG_KEY_DEEPSEEK, DEFAULT_TEST_KEY);
    assert.equal(env.LINGDONG_KEY_GATEWAY, GATEWAY_KEY);
    assert.deepEqual(injected, ["LINGDONG_KEY_DEEPSEEK", "LINGDONG_KEY_GATEWAY"]);

    // 跨 Provider 切换命中启动快照：session/set_model 秒切，不重启子进程。
    const before = harness.runtimes.length;
    await harness.controller.selectModel("gateway:qwen2.5");
    await flush();
    await harness.controller.sendPrompt("换完再发一条");
    await flush();

    const errors = harness.messagesOfType("error").map((message) => message.message);
    assert.deepEqual(errors, [], "换 Provider 不应报错");
    assert.equal(harness.runtimes.length, before, "命中快照就不该有新的子进程");
    assert.ok(
      harness.runtime().calls.includes("setModel:gateway:qwen2.5"),
      `应通过 session/set_model 热切，实际调用：${harness.runtime().calls.join(", ")}`,
    );
    const notices = harness.messagesOfType("notice").map((message) => message.message);
    assert.ok(
      notices.some((text) => text.includes("模型已切换为")),
      `应提示切换成功，实际提示：${notices.join(" | ")}`,
    );
  } finally {
    await harness.dispose();
  }
});

/** 快照未命中兜底重连的决策逻辑直接在 ModelFacade 上验（新增 Provider 的完整链路太重）。 */
test("目标模型不在启动快照内时兜底重连；命中快照走热切", async () => {
  const models = new ModelRegistry();
  models.replace([
    {
      id: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      provider: "DeepSeek",
      providerId: "deepseek",
      contextWindow: 128_000,
      supportsTools: true,
      supportsVision: false,
      agentCompatible: true,
      enabled: true,
      speedProfile: "fast",
      reasoningProfile: "standard",
    },
    {
      id: "gateway:qwen2.5",
      displayName: "Qwen 2.5",
      provider: "自定义网关",
      providerId: "gateway",
      contextWindow: 32_768,
      supportsTools: true,
      supportsVision: false,
      agentCompatible: true,
      enabled: true,
      speedProfile: "balanced",
      reasoningProfile: "light",
    },
    {
      id: "late:new-model",
      displayName: "会话中途新增的模型",
      provider: "新网关",
      providerId: "late",
      contextWindow: 32_768,
      supportsTools: true,
      supportsVision: false,
      agentCompatible: true,
      enabled: true,
      speedProfile: "balanced",
      reasoningProfile: "light",
    },
  ]);

  let restarts = 0;
  const setModelCalls: string[] = [];
  const facade = new ModelFacade({
    post: () => undefined,
    store: new AgentWorkspaceStore(),
    models,
    providers: {
      writeConfig: () => Promise.resolve(),
      launchSnapshot: {
        providerIds: ["deepseek", "gateway"],
        modelIds: ["deepseek-v4-flash", "gateway:qwen2.5"],
      },
    } as unknown as ModelFacadeDeps["providers"],
    runtime: () => ({
      model: "deepseek-v4-flash",
      sessionId: "grok-1",
      setModel: (modelId: string) => { setModelCalls.push(modelId); return Promise.resolve(); },
    } as unknown as AgentRuntimeHandle),
    persistence: () => undefined,
    currentSession: () => ({ id: "ses-1", modelId: "deepseek-v4-flash", providerId: "deepseek" } as SessionRecord),
    setCurrentSession: () => undefined,
    lastSelection: () => undefined,
    rememberSelection: () => Promise.resolve(),
    mode: () => "agent",
    pushComposerStatus: () => undefined,
    setMode: () => Promise.resolve(),
    busy: () => false,
    enforceAskOnly: () => Promise.resolve(),
    restartRuntime: () => { restarts += 1; return Promise.resolve(); },
    contextActions: {
      addCurrentFile: () => Promise.resolve(),
      addSelection: () => Promise.resolve(),
      pickFiles: () => Promise.resolve(),
      pickFolder: () => Promise.resolve(),
      addTerminalOutput: () => undefined,
      addDiagnostics: () => Promise.resolve(),
    },
    skillsConfigured: () => false,
    mcpConfigured: () => false,
    openExtensions: () => undefined,
  });

  // 跨 Provider 但命中快照：热切，不重启。
  await facade.select("gateway:qwen2.5");
  assert.deepEqual(setModelCalls, ["gateway:qwen2.5"]);
  assert.equal(restarts, 0);

  // 会话中途新增的 Provider/模型不在快照里：兜底重连。
  await facade.select("late:new-model");
  assert.equal(restarts, 1);
  assert.deepEqual(setModelCalls, ["gateway:qwen2.5"], "未命中快照不应走 set_model");
});

test("仅 Ask 的模型进不了 Agent 模式，并说明原因", async () => {
  const askOnly = gateway({ capabilities: {
    streaming: true,
    toolCalling: false,
    reasoning: false,
    vision: false,
    agentCompatible: false,
  } });
  const harness = await twoProviderHarness(askOnly);
  try {
    await harness.controller.sendPrompt("预热");
    await flush();
    await harness.controller.selectModel("gateway:qwen2.5");
    await flush();
    harness.clearMessages();

    await harness.controller.setMode("agent");
    await flush();

    const notices = harness.messagesOfType("notice").map((message) => message.message);
    assert.ok(notices.some((text) => text.includes("仅支持 Ask")));
    assert.equal(harness.messagesOfType("modeState").at(-1)?.mode, "ask");
  } finally {
    await harness.dispose();
  }
});

test("选中仅 Ask 模型时主动降级，而不是等用户撞上 Agent 才拒绝", async () => {
  const askOnly = gateway({ capabilities: {
    streaming: true,
    toolCalling: false,
    reasoning: false,
    vision: false,
    agentCompatible: false,
  } });
  const harness = await twoProviderHarness(askOnly);
  try {
    await harness.controller.sendPrompt("预热");
    await flush();
    await harness.controller.setMode("agent");
    await flush();
    harness.clearMessages();

    await harness.controller.selectModel("gateway:qwen2.5");
    await flush();

    const state = harness.messagesOfType("modeState").at(-1);
    assert.equal(state?.mode, "ask", "选中的一刻就该降级");
    assert.equal(state?.askOnly, true);
    assert.ok(state?.askOnlyReason?.includes("仅支持 Ask"));
  } finally {
    await harness.dispose();
  }
});

/**
 * 执行中的门禁直接在 ModelFacade 上验。
 * 走完整控制器的话，得先把一轮任务稳定地「挂在中间」，而那取决于意图拦截、
 * 状态机迁移与假 Runtime 的产出节奏——测的就变成时序而不是规则本身了。
 */
test("任务执行中拒绝切换模型", async () => {
  const posted: HostToWebviewMessage[] = [];
  const models = new ModelRegistry();
  models.replace([
    {
      id: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      provider: "DeepSeek",
      providerId: "deepseek",
      contextWindow: 128_000,
      supportsTools: true,
      supportsVision: false,
      agentCompatible: true,
      enabled: true,
      speedProfile: "fast",
      reasoningProfile: "standard",
    },
    {
      id: "gateway:qwen2.5",
      displayName: "Qwen 2.5",
      provider: "自定义网关",
      providerId: "gateway",
      contextWindow: 32_768,
      supportsTools: true,
      supportsVision: false,
      agentCompatible: true,
      enabled: true,
      speedProfile: "balanced",
      reasoningProfile: "light",
    },
  ]);

  let busy = true;
  let restarts = 0;
  let patched = 0;
  const facade = new ModelFacade({
    post: (message) => posted.push(message),
    store: new AgentWorkspaceStore(),
    models,
    providers: {
      writeConfig: () => { patched += 1; return Promise.resolve(); },
    } as unknown as ModelFacadeDeps["providers"],
    runtime: () => ({ model: "deepseek-v4-flash", sessionId: "grok-1" } as AgentRuntimeHandle),
    persistence: () => undefined,
    currentSession: () => ({ id: "ses-1", modelId: "deepseek-v4-flash", providerId: "deepseek" } as SessionRecord),
    setCurrentSession: () => undefined,
    lastSelection: () => undefined,
    rememberSelection: () => Promise.resolve(),
    mode: () => "agent",
    pushComposerStatus: () => undefined,
    setMode: () => Promise.resolve(),
    busy: () => busy,
    enforceAskOnly: () => Promise.resolve(),
    restartRuntime: () => { restarts += 1; return Promise.resolve(); },
    contextActions: {
      addCurrentFile: () => Promise.resolve(),
      addSelection: () => Promise.resolve(),
      pickFiles: () => Promise.resolve(),
      pickFolder: () => Promise.resolve(),
      addTerminalOutput: () => undefined,
      addDiagnostics: () => Promise.resolve(),
    },
    skillsConfigured: () => false,
    mcpConfigured: () => false,
    openExtensions: () => undefined,
  });

  await facade.select("gateway:qwen2.5");

  const notices = posted
    .filter((message): message is Extract<HostToWebviewMessage, { type: "notice" }> => message.type === "notice")
    .map((message) => message.message);
  assert.ok(
    notices.some((text) => text.includes("任务执行中不能切换模型")),
    `实际收到的提示：${notices.join(" | ")}`,
  );
  // 半途换服务商会让同一轮的前后半段打到两个地方：既不能重启，也不能改配置。
  assert.equal(restarts, 0);
  assert.equal(patched, 0);
  // 界面仍然回显原模型，避免选择器停在一个并未生效的选项上。
  const models_ = posted.filter((message) => message.type === "models");
  assert.equal((models_.at(-1) as { selected?: string } | undefined)?.selected, "deepseek-v4-flash");

  // 本轮结束后同样的调用就该放行，证明拒绝的原因确实是「忙」。
  busy = false;
  await facade.select("gateway:qwen2.5");
  assert.equal(restarts, 1);
});

test("删除凭据后不静默切换到别的模型", async () => {
  const harness = await twoProviderHarness();
  try {
    await harness.controller.sendPrompt("预热");
    await flush();
    await harness.controller.selectModel("gateway:qwen2.5");
    await flush();

    vscodeHarness.state.secrets.delete(secretIdFor("gateway"));
    vscodeHarness.state.globalState.set("lingdongAgent.providerKeyIndex", ["deepseek"]);

    await harness.controller.reconnect();
    await harness.controller.sendPrompt("凭据没了还发得出去吗");
    await flush();

    // 选择保持在原模型上；宁可明确失败，也不悄悄换一个能用的。
    assert.equal(harness.messagesOfType("models").at(-1)?.selected, "gateway:qwen2.5");
    const complaints = [
      ...harness.messagesOfType("error").map((message) => message.message),
      ...harness.messagesOfType("notice").map((message) => message.message),
    ];
    assert.ok(
      complaints.some((text) => text.includes("Key") || text.includes("凭据")),
      `应当明确提示凭据缺失，实际收到：${complaints.join(" | ")}`,
    );
  } finally {
    await harness.dispose();
  }
});
