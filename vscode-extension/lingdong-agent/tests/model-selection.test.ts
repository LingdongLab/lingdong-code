import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeHandle } from "@lingdong/agent-runtime";
import { ModelFacade, type ModelFacadeDeps } from "../src/services/model-facade";
import { ModelRegistry } from "../src/model-registry";
import { memorySelection, workspaceStateSelection, type ModelSelection } from "../src/model-selection";
import type { HostToWebviewMessage } from "../src/messages";
import type { ProviderConfig } from "../src/models/providers/provider-types";
import { POE_PROVIDER_ID, poeProvider } from "../src/models/providers/provider-types";
import { AgentWorkspaceStore } from "../src/workspace-store";
import { createControllerHarness, flush } from "./support/controller-harness";
import { __test as vscodeHarness } from "./support/vscode-stub";

/**
 * 「选了模型却用不上」的回归。
 * 之前模型选择只写内存状态和会话记录，没有会话记录时（首次使用、上一个会话被删）
 * 选择无处存放，启动解析只能退回设置项 lingdongAgent.model 的默认值。
 */

/**
 * 等控制器把 Provider 注册表投影成模型清单。
 * 这一步要读配置文件，用固定的 flush 轮数在负载高的时候会抢不到，只能等到为止。
 */
async function waitForModels(harness: { messagesOfType: (type: "models") => unknown[] }): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (harness.messagesOfType("models").length > 0) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error("控制器始终没有推出模型清单");
}

function fakeMemento(initial: Record<string, unknown> = {}) {
  const table = new Map(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined { return table.get(key) as T | undefined; },
    update(key: string, value: unknown): Thenable<void> {
      table.set(key, value);
      return Promise.resolve();
    },
  };
}

const POE_MODEL = "poe:claude-opus-4.8";

function poeWithModel(): ProviderConfig {
  return {
    ...poeProvider(),
    enabled: true,
    models: [
      {
        id: POE_MODEL,
        remoteModelId: "claude-opus-4.8",
        displayName: "claude-opus-4.8",
        enabled: true,
        protocol: "responses",
        verified: true,
        capabilities: {
          streaming: true,
          toolCalling: true,
          reasoning: false,
          vision: true,
          agentCompatible: true,
        },
      },
    ],
  };
}

function facadeWith(overrides: Partial<ModelFacadeDeps>): {
  facade: ModelFacade;
  posted: HostToWebviewMessage[];
  written: string[];
} {
  const posted: HostToWebviewMessage[] = [];
  const written: string[] = [];
  const models = new ModelRegistry([
    {
      id: POE_MODEL,
      displayName: "claude-opus-4.8",
      provider: "Poe",
      providerId: POE_PROVIDER_ID,
      contextWindow: 200_000,
      supportsTools: true,
      supportsVision: true,
      agentCompatible: true,
      enabled: true,
      speedProfile: "balanced",
      reasoningProfile: "light",
    },
  ]);
  const facade = new ModelFacade({
    post: (message) => posted.push(message),
    store: new AgentWorkspaceStore(),
    models,
    providers: {
      writeConfig: (modelId: string) => { written.push(modelId); return Promise.resolve(); },
    } as unknown as ModelFacadeDeps["providers"],
    runtime: () => undefined,
    persistence: () => undefined,
    currentSession: () => undefined,
    setCurrentSession: () => undefined,
    lastSelection: () => undefined,
    rememberSelection: () => Promise.resolve(),
    mode: () => "agent",
    pushComposerStatus: () => undefined,
    setMode: () => Promise.resolve(),
    busy: () => false,
    enforceAskOnly: () => Promise.resolve(),
    restartRuntime: () => Promise.resolve(),
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
    ...overrides,
  });
  return { facade, posted, written };
}

test("选择存的是 Provider 与模型这一对", async () => {
  const state = fakeMemento();
  const port = workspaceStateSelection(state);
  assert.equal(port.get(), undefined);

  await port.set({ providerId: POE_PROVIDER_ID, modelId: POE_MODEL });
  assert.deepEqual(port.get(), { providerId: POE_PROVIDER_ID, modelId: POE_MODEL });
});

test("残缺或异型的存量数据当作没有选过", () => {
  const cases: unknown[] = [
    null,
    "poe:claude-opus-4.8",
    { modelId: POE_MODEL },
    { providerId: POE_PROVIDER_ID },
    { providerId: "", modelId: POE_MODEL },
    { providerId: POE_PROVIDER_ID, modelId: 42 },
  ];
  for (const raw of cases) {
    const port = workspaceStateSelection(fakeMemento({ "lingdongAgent.lastModelSelection": raw }));
    assert.equal(port.get(), undefined, `不该接受 ${JSON.stringify(raw)}`);
  }
});

test("没有会话记录时，选中的模型仍然被记住", async () => {
  const selection = memorySelection();
  const { facade } = facadeWith({
    currentSession: () => undefined,
    lastSelection: () => selection.get(),
    rememberSelection: async (value) => { await selection.set(value); },
  });

  await facade.select(POE_MODEL);

  assert.deepEqual(selection.get(), { providerId: POE_PROVIDER_ID, modelId: POE_MODEL });
});

test("没有会话记录时，当前模型读的是上一次的选择而不是注册表首项", () => {
  const { facade } = facadeWith({
    currentSession: () => undefined,
    lastSelection: (): ModelSelection => ({ providerId: POE_PROVIDER_ID, modelId: POE_MODEL }),
  });
  assert.equal(facade.currentModelId(), POE_MODEL);
});

test("没有会话记录也认得出换了 Provider，会重启子进程换凭据", async () => {
  let restarts = 0;
  const { facade } = facadeWith({
    currentSession: () => undefined,
    lastSelection: (): ModelSelection => ({ providerId: "deepseek", modelId: "deepseek-v4-flash" }),
    runtime: () => ({ model: "deepseek-v4-flash", sessionId: "grok-1" } as AgentRuntimeHandle),
    restartRuntime: () => { restarts += 1; return Promise.resolve(); },
  });

  await facade.select(POE_MODEL);

  assert.equal(restarts, 1, "换 Provider 不重启，请求会继续带上一个 Provider 的凭据");
});

test("用户手写进设置的模型缺凭据时明确失败，不改投别家", async () => {
  // 写进 settings.json 是明确表达过的意图，解析不了就得说清楚，
  // 悄悄换成另一个能用的 Provider 等于替用户改了数据发往哪里。
  const harness = createControllerHarness({
    providerKey: null,
    modelSetting: "deepseek-v4-flash",
    extraProviders: [{ provider: poeWithModel(), key: "poe-test-key-0123456789" }],
  });
  try {
    await waitForModels(harness);
    await harness.controller.sendPrompt("你好");
    await flush();

    const failures = harness.messagesOfType("error").map((message) => message.message);
    assert.ok(
      failures.some((text) => text.includes("DeepSeek") || text.includes("deepseek-v4-flash")),
      `应当明确报设置项里的那个模型，实际：${failures.join(" / ")}`,
    );
    // 配过 Poe 就不是首次运行了，这里该说凭据对不上，而不是引导去填第一个 Key。
    assert.ok(
      failures.some((text) => text.includes("原来使用")),
      `实际：${failures.join(" / ")}`,
    );
    assert.equal(harness.runtimes.length, 0, "解析失败就不该拉起子进程");
  } finally {
    await harness.dispose();
  }
});

test("换到新工作区后没有任何历史选择，直接用配好的 Poe，而不是报 DeepSeek 缺凭据", async () => {
  // 用户实际撞到的那一幕：另开一个文件夹当工作区，点新建对话就报
  // 「此会话原来使用 DeepSeek，但对应凭据已不存在」。
  // 会话记录与「上次选择」都按工作区隔离，新工作区里两者皆空，
  // 当时便掉回设置项默认值（内置 DeepSeek）——那个模型用户从没选过，也没配过 Key。
  const harness = createControllerHarness({
    providerKey: null,
    modelSetting: null,
    extraProviders: [{ provider: poeWithModel(), key: "poe-test-key-0123456789" }],
  });
  try {
    await waitForModels(harness);
    await harness.controller.sendPrompt("你好");
    await flush();

    const failures = harness.messagesOfType("error").map((message) => message.message);
    assert.equal(
      failures.some((text) => text.includes("原来使用")),
      false,
      `新工作区里没有「原来」可言，实际：${failures.join(" / ")}`,
    );
    assert.equal(harness.runtimes.length, 1, `应当直接连上唯一配好的服务商，实际报错：${failures.join(" / ")}`);
    const runtime = harness.runtime();
    assert.equal(runtime.options.modelId, POE_MODEL);
    assert.equal(runtime.options.env?.LINGDONG_KEY_POE, "poe-test-key-0123456789");
  } finally {
    await harness.dispose();
  }
});

test("选过 Poe 模型之后，即使没有会话记录也能连上 Poe", async () => {
  const harness = createControllerHarness({
    providerKey: null,
    extraProviders: [{ provider: poeWithModel(), key: "poe-test-key-0123456789" }],
  });
  try {
    await waitForModels(harness);
    // 还没有任何会话，选择只能存在选择记录里。
    await harness.controller.selectModel(POE_MODEL);
    await flush();

    await harness.controller.sendPrompt("你好");
    await flush();

    assert.equal(harness.runtimes.length, 1, "选过模型之后应当能真的连上");
    const runtime = harness.runtime();
    assert.equal(runtime.options.modelId, POE_MODEL);
    assert.equal(runtime.options.env?.LINGDONG_KEY_POE, "poe-test-key-0123456789");
    assert.equal(runtime.options.env?.LINGDONG_KEY_DEEPSEEK, undefined);
  } finally {
    await harness.dispose();
  }
});

test("重开扩展后仍然记得上次选的模型", async () => {
  const first = createControllerHarness({
    providerKey: null,
    extraProviders: [{ provider: poeWithModel(), key: "poe-test-key-0123456789" }],
  });
  const { storageRoot, workspaceRoot } = first;
  let remembered: unknown;
  try {
    await waitForModels(first);
    await first.controller.selectModel(POE_MODEL);
    await flush();
    remembered = vscodeHarness.state.globalState.get("lingdongAgent.lastModelSelection");
    assert.ok(remembered, "选择必须真的落进 VS Code 状态，否则重开就丢");
  } finally {
    await first.dispose();
  }

  // 复用同一个存储目录与工作区。桩每次建 harness 会清空 VS Code 状态，
  // 这里把上一轮真正写进去的那份原样搬回来，模拟重开窗口。
  const second = createControllerHarness({
    storageRoot,
    workspaceRoot,
    providerKey: null,
    extraProviders: [{ provider: poeWithModel(), key: "poe-test-key-0123456789" }],
  });
  vscodeHarness.state.globalState.set("lingdongAgent.lastModelSelection", remembered);
  try {
    await waitForModels(second);
    await second.controller.sendPrompt("你好");
    await flush();

    assert.equal(second.runtimes.length, 1);
    assert.equal(second.runtime().options.modelId, POE_MODEL);
  } finally {
    await second.dispose();
  }
});
