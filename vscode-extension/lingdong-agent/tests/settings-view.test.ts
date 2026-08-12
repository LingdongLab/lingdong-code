import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type {
  SettingsCatalogEntryView,
  SettingsProviderView,
} from "../src/model-settings-messages";
import type { SettingsWebviewMessage } from "../src/settings-messages";
import { createPageState, type PageState } from "../src/webview/settings/state";
import { renderSettings } from "../src/webview/settings/view";

/**
 * 统一设置页根视图。
 *
 * 这一批断言接管了原来分散在 model-settings-view / provider-editor-view /
 * poe-catalog-view 三个测试里的不变量——页面合并了，保证不能跟着一起丢：
 * Key 不回显、内置服务商不可删、目录要能搜要能分页、能力位如实标注。
 * 另外加上合并之后才有的东西：分类导航、搜索、权限规则列表。
 */

function installDom(): Document {
  const dom = new JSDOM(`<!DOCTYPE html><div id="root"></div>`);
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    KeyboardEvent: window.KeyboardEvent,
    Event: window.Event,
    Node: window.Node,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  return window.document;
}

interface Harness {
  root: HTMLElement;
  state: PageState;
  posts: SettingsWebviewMessage[];
  paint(): void;
}

function createHarness(patch: Partial<PageState> = {}): Harness {
  const document = installDom();
  const root = document.getElementById("root") as HTMLElement;
  const state = Object.assign(createPageState(), patch);
  const posts: SettingsWebviewMessage[] = [];
  const paint = (): void => {
    renderSettings(root, state, {
      post: (message) => posts.push(message),
      repaint: paint,
      navigate: (category) => {
        state.category = category;
        state.search = "";
        paint();
      },
      search: (query) => {
        state.search = query;
        paint();
      },
    }, 1_700_000_000_000);
  };
  paint();
  return { root, state, posts, paint };
}

function click(node: Element | null | undefined): void {
  assert.ok(node, "要点的元素不存在");
  (node as HTMLElement).click();
}

function findButton(root: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

function provider(patch: Partial<SettingsProviderView> = {}): SettingsProviderView {
  return {
    id: "poe",
    type: "builtin",
    displayName: "Poe",
    host: "api.poe.com",
    baseUrl: "https://api.poe.com/v1",
    protocol: "chat_completions",
    enabled: true,
    keyConfigured: true,
    modelCount: 1,
    builtin: true,
    models: [],
    ...patch,
  } as SettingsProviderView;
}

function catalogEntry(patch: Partial<SettingsCatalogEntryView> = {}): SettingsCatalogEntryView {
  return {
    remoteModelId: "gpt-4o",
    displayName: "GPT-4o",
    vendor: "OpenAI",
    protocols: ["chat_completions"],
    features: [],
    added: false,
    ...patch,
  };
}

// --- 外壳与导航 -------------------------------------------------------------

test("六个分类都在左栏，点击即切换且高亮跟上", () => {
  const { root, state } = createHarness();
  const labels = [...root.querySelectorAll(".st-nav-item")].map((n) => n.textContent);
  assert.deepEqual(labels, ["通用", "模型", "Agent 行为", "能力扩展", "规则与记忆", "隐私与安全"]);

  click(findButton(root, "能力扩展"));
  assert.equal(state.category, "capabilities");
  const active = root.querySelector(".st-nav-item.active");
  assert.equal(active?.textContent, "能力扩展");
  assert.equal(root.querySelector(".st-page-title")?.textContent, "能力扩展");
});

test("所有设置都在同一页里，模型与 Skills 不再各占一个面板", () => {
  // 合并之前这两样分别在两个 WebviewPanel 里；现在必须都能从同一个外壳到达。
  const { root, state, paint } = createHarness();
  state.category = "models";
  paint();
  assert.ok(root.textContent?.includes("服务商"));
  state.category = "capabilities";
  paint();
  assert.ok(root.textContent?.includes("Skills"));
  assert.ok(root.textContent?.includes("MCP 服务器"));
});

test("搜索跨分类命中设置项，并说明搜不到的东西在哪找", () => {
  const { root, state, paint } = createHarness();
  state.search = "快照";
  paint();
  assert.equal(root.querySelector(".st-page-title")?.textContent, "搜索结果");
  assert.ok(root.textContent?.includes("快照保留天数"));
  assert.ok(root.textContent?.includes("快照总量上限"));

  state.search = "没有这个东西";
  paint();
  assert.ok(
    root.textContent?.includes("搜索只覆盖开关与取值"),
    "搜不到时要说清楚搜索的边界，否则用户会以为功能不存在",
  );
});

test("搜索期间点分类会清掉搜索词，否则点了看起来没反应", () => {
  const { root, state } = createHarness({ search: "快照" });
  click(findButton(root, "通用"));
  assert.equal(state.search, "");
  assert.equal(state.category, "general");
});

// --- 设置行控件 -------------------------------------------------------------

test("布尔设置渲染成开关，切换后按键名上报", () => {
  const { root, posts, state } = createHarness({ category: "agent" });
  state.config = { verifyAfterEdit: true };
  const toggles = [...root.querySelectorAll<HTMLInputElement>(".st-toggle input")];
  const target = toggles.find((input) => input.getAttribute("aria-label") === "改完自动校验");
  assert.ok(target);
  assert.equal(target.checked, true);
  target.checked = false;
  target.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("change"));
  assert.deepEqual(posts.at(-1), {
    type: "updateSetting",
    key: "verifyAfterEdit",
    value: false,
  });
});

test("带说明的枚举渲染成单选卡，当前项高亮且点它不重复上报", () => {
  const { root, posts } = createHarness({ category: "agent", config: { approvalPolicy: "balanced" } });
  const cards = [...root.querySelectorAll(".st-choice")];
  const labels = cards.map((c) => c.querySelector(".st-choice-label")?.textContent);
  assert.deepEqual(labels, ["均衡", "严格", "放行"]);
  assert.equal(cards[0]?.className.includes("active"), true);

  click(cards[0]);
  assert.equal(posts.length, 0, "点当前项不该产生一次写入");

  click(cards[1]);
  assert.deepEqual(posts.at(-1), { type: "updateSetting", key: "approvalPolicy", value: "strict" });
});

test("毫秒按秒显示，写回时换算成毫秒", () => {
  const { root, posts } = createHarness({ category: "agent", config: { permissionTimeoutMs: 300_000 } });
  const input = root.querySelector<HTMLInputElement>(".st-stepper-input");
  assert.ok(input);
  assert.equal(input.value, "300", "300000 毫秒直接摆出来没法读");
  assert.ok(root.textContent?.includes("秒"));

  input.value = "120";
  input.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("blur"));
  assert.deepEqual(posts.at(-1), {
    type: "updateSetting",
    key: "permissionTimeoutMs",
    value: 120_000,
  });
});

test("步进器把越界值收回边界内再提交", () => {
  const { root, posts } = createHarness({ category: "privacy", config: { snapshotRetentionDays: 30 } });
  const input = [...root.querySelectorAll<HTMLInputElement>(".st-stepper-input")][0];
  assert.ok(input);
  input.value = "99999";
  input.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("blur"));
  const last = posts.at(-1);
  assert.equal(last?.type, "updateSetting");
  assert.equal((last as { value: number }).value, 365);
});

test("字符串列表逐条可删，回车新增且不收重复项", () => {
  const { root, posts } = createHarness({
    category: "agent",
    config: { webFetchDomains: ["x.ai", "docs.rs"] },
  });
  const chips = [...root.querySelectorAll(".st-chip-text")].map((n) => n.textContent);
  assert.deepEqual(chips, ["x.ai", "docs.rs"]);

  click(root.querySelector(".st-chip-remove"));
  assert.deepEqual(posts.at(-1), {
    type: "updateSetting",
    key: "webFetchDomains",
    value: ["docs.rs"],
  });

  const input = root.querySelector<HTMLInputElement>(".st-list-input");
  assert.ok(input);
  input.value = "x.ai";
  input.dispatchEvent(new (globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent })
    .KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(posts.length, 1, "重复域名不该产生一次写入");
});

test("长背景说明折叠起来，默认不占版面", () => {
  const { root } = createHarness({ category: "agent" });
  const fold = root.querySelector<HTMLDetailsElement>(".st-row-detail");
  assert.ok(fold);
  assert.equal(fold.open, false);
  assert.equal(fold.querySelector("summary")?.textContent, "详细说明");
});

test("可执行文件那行额外给一个浏览按钮", () => {
  const { root, posts } = createHarness({ category: "general" });
  click(findButton(root, "浏览…"));
  assert.deepEqual(posts.at(-1), { type: "pickGrokExecutable" });
});

// --- 模型页（接管原 model-settings-view 的不变量）---------------------------

test("Provider 列表只显示凭据状态，不渲染 Key 的任何部分", () => {
  const { root } = createHarness({
    category: "models",
    providers: [provider({ keyConfigured: true })],
  });
  assert.ok(root.textContent?.includes("已配置密钥"));
  assert.equal(root.textContent?.includes("sk-"), false);
});

test("Key 输入框是密码框、不预填，提交后立刻清空", () => {
  const { root, posts } = createHarness({
    category: "models",
    providers: [provider({ keyConfigured: false })],
    expandedProviderId: "poe",
  });
  const input = root.querySelector<HTMLInputElement>("input[type=password]");
  assert.ok(input);
  assert.equal(input.value, "");

  input.value = "sk-secret";
  click(findButton(root, "保存"));
  assert.deepEqual(posts.at(-1), { type: "saveKey", providerId: "poe", key: "sk-secret" });
  assert.equal(input.value, "", "提交后界面不该留副本");
});

test("内置服务商不给删除按钮，自定义服务商才给", () => {
  const builtin = createHarness({ category: "models", providers: [provider({ builtin: true })] });
  assert.equal(findButton(builtin.root, "删除"), undefined);

  const custom = createHarness({
    category: "models",
    providers: [provider({ id: "mine", builtin: false, displayName: "我的中转" })],
  });
  assert.ok(findButton(custom.root, "删除"));
});

test("模型能力位如实标注：未检测与仅 Ask 不混为一谈", () => {
  const { root } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider({
      models: [
        {
          id: "a",
          displayName: "未测过的",
          remoteModelId: "a",
          enabled: true,
          protocol: "chat_completions",
          protocolLabel: "Chat Completions",
          verified: false,
          agentCompatible: false,
          supportsStreaming: false,
          supportsTools: false,
          supportsVision: false,
        },
        {
          id: "b",
          displayName: "测过但没工具",
          remoteModelId: "b",
          enabled: true,
          protocol: "chat_completions",
          protocolLabel: "Chat Completions",
          verified: true,
          agentCompatible: false,
          supportsStreaming: true,
          supportsTools: false,
          supportsVision: false,
        },
      ],
    })],
  });
  assert.ok(root.textContent?.includes("未检测"));
  assert.ok(root.textContent?.includes("仅 Ask"));
});

test("图片输入开关反映当前能力位，勾选后发出手动声明", () => {
  const { root, posts } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider({
      models: [{
        id: "a",
        displayName: "某模型",
        remoteModelId: "a",
        enabled: true,
        protocol: "chat_completions",
        protocolLabel: "Chat Completions",
        verified: true,
        agentCompatible: true,
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
      }],
    })],
  });
  const vision = [...root.querySelectorAll<HTMLInputElement>(".st-toggle input")]
    .find((input) => input.getAttribute("aria-label") === "某模型 视觉");
  assert.ok(vision);
  assert.equal(vision.checked, false);
  vision.checked = true;
  vision.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("change"));
  assert.deepEqual(posts.at(-1), {
    type: "setModelVision",
    providerId: "poe",
    modelId: "a",
    vision: true,
  });
});

// --- 模型目录（接管原 poe-catalog-view 的不变量）----------------------------

test("目录首屏只渲染 50 条，「加载更多」按批追加", () => {
  const entries = Array.from({ length: 120 }, (_, index) =>
    catalogEntry({ remoteModelId: `m-${index}`, displayName: `模型 ${index}` }));
  const { root, paint, state } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider()],
    catalogs: { poe: { providerId: "poe", entries, fromCache: false, skipped: 0 } },
  });
  const count = (): number => [...root.querySelectorAll(".st-item-title")]
    .filter((n) => n.textContent?.startsWith("模型 ")).length;
  assert.equal(count(), 50);

  click(findButton(root, "加载更多（还有 70 条）"));
  assert.equal(state.catalogLimit, 100);
  paint();
  assert.equal(count(), 100);
});

test("目录搜索同时匹配模型 ID 与厂商，换条件后回到第一批", () => {
  const entries = [
    ...Array.from({ length: 60 }, (_, i) => catalogEntry({ remoteModelId: `openai-${i}`, vendor: "OpenAI" })),
    catalogEntry({ remoteModelId: "claude-3", displayName: "Claude 3", vendor: "Anthropic" }),
  ];
  const { root, state, paint } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider()],
    catalogs: { poe: { providerId: "poe", entries, fromCache: false, skipped: 0 } },
    catalogLimit: 100,
  });

  const search = root.querySelector<HTMLInputElement>("input[type=search].st-input");
  assert.ok(search);
  search.value = "anthropic";
  search.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("change"));
  assert.equal(state.catalogQuery, "anthropic");
  assert.equal(state.catalogLimit, 50, "换筛选条件要回到第一批");
  paint();
  assert.ok(root.textContent?.includes("Claude 3"));
  assert.equal(root.textContent?.includes("openai-0"), false);
});

test("目录厂商下拉按 vendor 去重生成", () => {
  const { root } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider()],
    catalogs: {
      poe: {
        providerId: "poe",
        entries: [
          catalogEntry({ vendor: "OpenAI" }),
          catalogEntry({ remoteModelId: "b", vendor: "OpenAI" }),
          catalogEntry({ remoteModelId: "c", vendor: "Anthropic" }),
        ],
        fromCache: false,
        skipped: 0,
      },
    },
  });
  const vendorSelect = [...root.querySelectorAll<HTMLSelectElement>("select")]
    .find((s) => s.textContent?.includes("全部厂商"));
  assert.ok(vendorSelect);
  assert.deepEqual([...vendorSelect.options].map((o) => o.value), ["", "Anthropic", "OpenAI"]);
});

test("已添加的条目显示徽标而不是添加按钮", () => {
  const { root } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider()],
    catalogs: {
      poe: {
        providerId: "poe",
        entries: [catalogEntry({ added: true })],
        fromCache: false,
        skipped: 0,
      },
    },
  });
  assert.ok(root.textContent?.includes("已添加"));
  assert.equal(findButton(root, "添加"), undefined);
});

test("点击添加时把远端 ID 与目录声明的协议交给宿主", () => {
  const { root, posts } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider()],
    catalogs: {
      poe: {
        providerId: "poe",
        entries: [catalogEntry({ remoteModelId: "gpt-4o", protocols: ["responses"] })],
        fromCache: false,
        skipped: 0,
      },
    },
  });
  click(findButton(root, "添加"));
  assert.deepEqual(posts.at(-1), {
    type: "addModel",
    providerId: "poe",
    remoteModelId: "gpt-4o",
    protocol: "responses",
  });
});

test("没配 Key 时同步与添加都不可用", () => {
  const { root } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider({ keyConfigured: false })],
    catalogs: {
      poe: { providerId: "poe", entries: [catalogEntry()], fromCache: false, skipped: 0 },
    },
  });
  assert.equal(findButton(root, "同步目录")?.disabled, true);
  assert.equal(findButton(root, "添加")?.disabled, true);
});

test("尚未同步时给出说明，解析跳过的条目如实交代", () => {
  const empty = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider()],
  });
  assert.ok(empty.root.textContent?.includes("还没有同步过目录"));

  const skipped = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider()],
    catalogs: {
      poe: { providerId: "poe", entries: [catalogEntry()], fromCache: true, skipped: 3 },
    },
  });
  assert.ok(skipped.root.textContent?.includes("跳过 3 条无法解析的条目"));
  assert.ok(skipped.root.textContent?.includes("来自本地缓存"));
});

test("Poe 详情页固定显示中转隐私说明", () => {
  const { root } = createHarness({
    category: "models",
    expandedProviderId: "poe",
    providers: [provider()],
  });
  assert.ok(root.textContent?.includes("并可能由 Poe 转交给所选模型的上游服务商"));
});

test("未添加的内置服务商渲染成模板条目，点击只发添加消息", () => {
  const { root, posts } = createHarness({
    category: "models",
    availableBuiltins: [{
      id: "poe",
      displayName: "Poe",
      host: "api.poe.com",
      description: "一个 Key 用多家模型",
    }],
  });
  assert.ok(root.textContent?.includes("未添加"));
  click(findButton(root, "添加"));
  assert.deepEqual(posts.at(-1), { type: "addBuiltinProvider", providerId: "poe" });
});

// --- 自定义服务商表单（接管原 provider-editor-view 的不变量）---------------

test("自定义服务商填完必填项即可提交，上下文长度只在填了正整数时带上", () => {
  const { root, posts, state, paint } = createHarness({ category: "models" });
  click(findButton(root, "添加自定义服务商"));
  assert.equal(state.addingProvider, true);

  state.providerDraft = {
    displayName: "我的中转",
    baseUrl: " https://example.com/v1 ",
    protocol: "responses",
    remoteModelId: " gpt-4o ",
    contextWindow: "abc",
  };
  paint();
  click(findButton(root, "保存"));
  assert.deepEqual(posts.at(-1), {
    type: "addCustomProvider",
    draft: {
      displayName: "我的中转",
      baseUrl: "https://example.com/v1",
      protocol: "responses",
      remoteModelId: "gpt-4o",
    },
  });

  state.providerDraft.contextWindow = "128000";
  paint();
  click(findButton(root, "保存"));
  assert.equal((posts.at(-1) as { draft: { contextWindow?: number } }).draft.contextWindow, 128_000);
});

// --- 隐私页：权限规则（改造前完全没有界面）---------------------------------

test("权限规则逐条列出，可单独删除也可整体清空", () => {
  const { root, posts } = createHarness({
    category: "privacy",
    permissionRules: [
      {
        id: "command-prefix\u0000npm test",
        kind: "command-prefix",
        kindLabel: "执行命令",
        value: "npm test",
        label: "运行 npm test",
      },
    ],
  });
  assert.ok(root.textContent?.includes("运行 npm test"));
  assert.ok(root.textContent?.includes("执行命令"));

  click(findButton(root, "删除"));
  assert.deepEqual(posts.at(-1), {
    type: "removePermissionRule",
    id: "command-prefix\u0000npm test",
  });

  click(findButton(root, "全部清空（1 条）"));
  assert.deepEqual(posts.at(-1), { type: "clearPermissionRules" });
});

test("没有规则时说清楚这意味着什么，而不是留一片空白", () => {
  const { root } = createHarness({ category: "privacy" });
  assert.ok(root.textContent?.includes("每一次越权操作都会先问过你"));
  assert.equal(findButton(root, "全部清空（0 条）"), undefined);
});

test("隐私画像按分组渲染，通道开着标 warn 关着标 ok", () => {
  const { root } = createHarness({
    category: "privacy",
    privacy: [{
      title: "网络通道",
      rows: [
        { label: "遥测", value: "已关闭", tone: "ok" },
        { label: "自动更新", value: "已开启", tone: "warn" },
      ],
      note: "以上来自实际构造的子进程环境。",
    }],
  });
  const values = [...root.querySelectorAll(".st-kv-value")];
  assert.equal(values[0]?.className, "st-kv-value ok");
  assert.equal(values[1]?.className, "st-kv-value warn");
  assert.ok(root.textContent?.includes("以上来自实际构造的子进程环境。"));
});

// --- 能力扩展页 -------------------------------------------------------------

test("技能开关与删除按钮按 scope 上报", () => {
  const { root, posts } = createHarness({
    category: "capabilities",
    skills: [{
      name: "demo",
      description: "示例",
      scope: "user",
      directory: "C:/skills/demo",
      disabled: false,
      slash: "/demo",
    }],
  });
  const toggleInput = root.querySelector<HTMLInputElement>(".st-toggle input");
  assert.ok(toggleInput);
  assert.equal(toggleInput.checked, true);
  toggleInput.checked = false;
  toggleInput.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("change"));
  assert.deepEqual(posts.at(-1), { type: "setSkillEnabled", name: "demo", enabled: false });

  click(findButton(root, "删除"));
  assert.deepEqual(posts.at(-1), { type: "removeSkill", name: "demo", scope: "user" });
});

test("没有工作区时安装到仓库与新建 AGENTS.md 都禁用", () => {
  const capabilities = createHarness({ category: "capabilities", workspaceAvailable: false });
  assert.equal(findButton(capabilities.root, "安装到当前仓库")?.disabled, true);

  const rules = createHarness({ category: "rules", workspaceAvailable: false });
  assert.equal(findButton(rules.root, "新建项目 AGENTS.md")?.disabled, true);
});

test("MCP 表单按传输类型换字段，密钥槽不回填", () => {
  const { root, state, paint } = createHarness({
    category: "capabilities",
    mcpServers: [{
      id: "s1",
      name: "my-server",
      transport: "stdio",
      enabled: true,
      command: "node",
      argsText: "server.js",
      envKeys: [],
      secretEnvKeys: ["TOKEN"],
      headerKeys: [],
      secretHeaderKeys: [],
    }],
  });
  assert.ok(root.textContent?.includes("已保存密钥槽：env:TOKEN"));

  click(findButton(root, "编辑"));
  assert.equal(state.mcpDraft?.secretEnvText, "", "已保存的密钥不回显到界面");
  assert.ok(root.textContent?.includes("敏感环境变量"));

  state.mcpDraft = { ...state.mcpDraft!, transport: "http" };
  paint();
  assert.ok(root.textContent?.includes("敏感 Headers"));
  assert.equal(root.textContent?.includes("敏感环境变量"), false);
});

// --- 规则与记忆页 -----------------------------------------------------------

test("规则文件列出来源与体量，编辑按路径打开", () => {
  const { root, posts } = createHarness({
    category: "rules",
    rules: [{
      path: "E:/repo/AGENTS.md",
      label: "AGENTS.md",
      scope: "project",
      vendor: "grok",
      kind: "agents",
      approxTokens: 320,
    }],
  });
  assert.ok(root.textContent?.includes("约 320 tokens"));
  assert.ok(root.textContent?.includes("项目"));
  click(findButton(root, "编辑"));
  assert.deepEqual(posts.at(-1), { type: "openRuleFile", path: "E:/repo/AGENTS.md" });
});

test("记忆开关走通用配置通道，目录只读展示", () => {
  const { root, posts } = createHarness({
    category: "rules",
    config: { memory: false },
    memoryDirectory: "C:/store/memory",
  });
  assert.ok(root.textContent?.includes("记忆目录：C:/store/memory"));
  const input = [...root.querySelectorAll<HTMLInputElement>(".st-toggle input")]
    .find((node) => node.getAttribute("aria-label") === "跨会话记忆");
  assert.ok(input);
  input.checked = true;
  input.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("change"));
  assert.deepEqual(posts.at(-1), { type: "updateSetting", key: "memory", value: true });
});

test("未安装的 language server 开关禁用，并给出安装方式", () => {
  const { root } = createHarness({
    category: "rules",
    lspServers: [{
      id: "rust",
      label: "rust-analyzer",
      hint: "Rust 诊断与跳转",
      install: "rustup component add rust-analyzer",
      found: false,
      enabled: false,
      extensions: [".rs"],
    }],
  });
  assert.ok(root.textContent?.includes("未安装"));
  assert.ok(root.textContent?.includes("安装：rustup component add rust-analyzer"));
  const input = [...root.querySelectorAll<HTMLInputElement>(".st-toggle input")]
    .find((node) => node.getAttribute("aria-label") === "rust-analyzer");
  assert.equal(input?.disabled, true);
});

// --- 通用状态 ---------------------------------------------------------------

test("忙与提示条渲染在内容区顶部", () => {
  const { root } = createHarness({
    busy: true,
    busyLabel: "正在同步目录…",
    notice: { level: "warn", message: "目录里有条目解析失败。" },
  });
  assert.equal(root.querySelector(".st-busy")?.textContent, "正在同步目录…");
  assert.equal(root.querySelector(".st-notice.warn")?.textContent, "目录里有条目解析失败。");
});

test("返回 Agent 常驻左栏顶部", () => {
  const { root, posts } = createHarness();
  click(root.querySelector(".st-nav-back"));
  assert.deepEqual(posts.at(-1), { type: "backToAgent" });
});
