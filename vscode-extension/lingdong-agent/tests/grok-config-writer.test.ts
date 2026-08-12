import assert from "node:assert/strict";
import test from "node:test";
import {
  renderGrokConfig,
  resolveModelEntries,
  type ResolvedModelEntry,
} from "../src/models/providers/grok-config-writer";
import {
  deepseekProvider,
  envKeyName,
  secretIdFor,
  type ProviderConfig,
} from "../src/models/providers/provider-types";

function entry(overrides: Partial<ResolvedModelEntry> = {}): ResolvedModelEntry {
  return {
    modelId: "deepseek-v4-flash",
    apiModelId: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    baseUrl: "https://api.deepseek.com",
    envKeyName: "LINGDONG_KEY_DEEPSEEK",
    apiBackend: "responses",
    contextWindow: 1_000_000,
    ...overrides,
  };
}

test("遥测类开关全部显式写成 false，不依赖 Grok 默认值", () => {
  const config = renderGrokConfig({ models: [entry()], defaultModelId: "deepseek-v4-flash" });
  for (const line of [
    "telemetry = false",
    "feedback = false",
    "remote_fetch = false",
    "mixpanel_enabled = false",
    "trace_upload = false",
    "otel_enabled = false",
    "auto_update = false",
  ]) {
    assert.ok(config.includes(line), `缺少 ${line}`);
  }
  // 文档里 feedback 与 remote_fetch 的默认值是 true，漏写就等于开着。
  assert.equal(config.includes("= true"), true, "marketplace 那一项仍应为 true");
  assert.equal(/remote_fetch = true/.test(config), false);
});

test("身份标签写入 [agent]，Agent 自称灵动而不是 Grok", () => {
  const config = renderGrokConfig({ models: [entry()] });
  assert.ok(config.includes("[agent]"));
  assert.ok(config.includes('system_prompt_label = "灵动 Agent"'));
});

test("只写 env_key，产物里不出现 api_key 也不出现凭据", () => {
  const config = renderGrokConfig({ models: [entry()] });
  assert.ok(config.includes('env_key = "LINGDONG_KEY_DEEPSEEK"'));
  assert.equal(/\bapi_key\b/.test(config), false);
  assert.equal(config.includes("sk-"), false);
});

test("不写 models.web_search：内置 backend 搜索交给宿主 MCP", () => {
  const config = renderGrokConfig({ models: [entry()], defaultModelId: "deepseek-v4-flash" });
  assert.equal(config.includes("web_search ="), false);
  assert.equal(config.includes("supports_backend_search"), false);
});

test("传入 webSearchMcp 时写入 lingdong_web 并 deny 内置 WebSearch", () => {
  const config = renderGrokConfig({
    models: [entry()],
    defaultModelId: "deepseek-v4-flash",
    webSearchMcp: {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["E:\\ext\\dist\\web-search-mcp.js"],
    },
  });
  assert.ok(config.includes("[mcp_servers.lingdong_web]"));
  assert.ok(config.includes('args = ["E:\\\\ext\\\\dist\\\\web-search-mcp.js"]'));
  assert.ok(config.includes("startup_timeout_sec = 60"));
  assert.ok(config.includes('deny = ["WebSearch"]'));
  assert.ok(config.includes('tool = "websearch"'));
  assert.equal(config.includes("web_search ="), false);
  assert.equal(config.includes("ELECTRON_RUN_AS_NODE"), false);
});

test("用户 MCP 与 lingdong_web 并存，密钥只写占位符", () => {
  const config = renderGrokConfig({
    models: [entry()],
    webSearchMcp: {
      command: "node",
      args: ["web-search-mcp.js"],
    },
    userMcpServers: [
      {
        name: "my_tools",
        transport: "stdio",
        command: "npx",
        args: ["-y", "demo-mcp"],
        env: { API_TOKEN: "${LINGDONG_MCP_MY_TOOLS_API_TOKEN}" },
      },
      {
        name: "remote_docs",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "${LINGDONG_MCP_REMOTE_DOCS_HDR_AUTHORIZATION}" },
      },
    ],
    skills: {
      disabled: ["old-skill"],
      paths: ["C:\\Users\\demo\\.grok\\skills"],
    },
  });
  assert.ok(config.includes("[mcp_servers.lingdong_web]"));
  assert.ok(config.includes("[mcp_servers.my_tools]"));
  assert.ok(config.includes("[mcp_servers.remote_docs]"));
  assert.ok(config.includes('disabled = ["old-skill"]'));
  assert.ok(config.includes('paths = ["C:\\\\Users\\\\demo\\\\.grok\\\\skills"]'));
  assert.ok(config.includes("${LINGDONG_MCP_MY_TOOLS_API_TOKEN}"));
  assert.ok(config.includes('MCPTool(my_tools__*)'));
  assert.ok(config.includes('pattern = "remote_docs*"'));
  assert.ok(config.includes('deny = ["WebSearch"]'));
  assert.equal(config.includes("sk-secret"), false);
  assert.equal(config.includes("Bearer real"), false);
});

test("仅用户 MCP 时不写 WebSearch deny，但仍放行用户工具", () => {
  const config = renderGrokConfig({
    models: [entry()],
    userMcpServers: [
      { name: "only_user", transport: "stdio", command: "echo", args: [] },
    ],
  });
  assert.ok(config.includes("[mcp_servers.only_user]"));
  assert.equal(config.includes("lingdong_web"), false);
  assert.equal(config.includes("WebSearch"), false);
  assert.ok(config.includes('MCPTool(only_user__*)'));
});

test("webSearchMcp 可写入 ELECTRON_RUN_AS_NODE（Code.exe 路径）", () => {
  const config = renderGrokConfig({
    models: [entry()],
    webSearchMcp: {
      command: "C:\\VS Code\\Code.exe",
      args: ["E:\\ext\\dist\\web-search-mcp.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
  });
  assert.ok(config.includes('env = { ELECTRON_RUN_AS_NODE = "1" }'));
});

test("未传 webSearchMcp 时不写 MCP 段", () => {
  const config = renderGrokConfig({ models: [entry()] });
  assert.equal(config.includes("mcp_servers"), false);
  assert.equal(config.includes("[permission]"), false);
});

test("web_fetch 关闭时不写 toolset/permission 段", () => {
  const config = renderGrokConfig({ models: [entry()], webFetch: { enabled: false, allowedDomains: ["docs.rs"] } });
  assert.equal(config.includes("[toolset.web_fetch]"), false);
  assert.equal(config.includes("WebFetch(domain:"), false);
});

test("web_fetch 启用且给域名：写出白名单与免确认规则，本地回环显式关闭", () => {
  const config = renderGrokConfig({
    models: [entry()],
    webFetch: { enabled: true, allowedDomains: ["docs.rs", "x.ai"] },
  });
  assert.ok(config.includes("[toolset.web_fetch]"), "应写出 toolset 段");
  assert.ok(config.includes('allowed_domains = ["docs.rs", "x.ai"]'));
  assert.ok(config.includes("allow_local = false"), "SSRF 兜底显式关闭本地回环");
  assert.ok(config.includes("[permission]"));
  assert.ok(config.includes('WebFetch(domain:docs.rs)'));
  assert.ok(config.includes('WebFetch(domain:x.ai)'));
});

test("web_fetch 启用但域名为空：不写白名单段，沿用内置默认", () => {
  const config = renderGrokConfig({ models: [entry()], webFetch: { enabled: true, allowedDomains: [] } });
  assert.equal(config.includes("[toolset.web_fetch]"), false);
  assert.equal(config.includes("WebFetch(domain:"), false);
});

test("问答工具关闭超时：等用户作答，不让 Grok 替用户跳过", () => {
  const config = renderGrokConfig({ models: [entry()] });
  assert.ok(config.includes("[toolset.ask_user_question]"));
  assert.ok(config.includes("timeout_enabled = false"));
});

test("补齐 Agent 能力键：LSP 工具与代码图索引显式打开", () => {
  const config = renderGrokConfig({ models: [entry()] });
  assert.ok(config.includes("lsp_tools = true"), "lsp_tools 没打开就没有代码智能");
  assert.ok(config.includes("codebase_indexing = true"));
  // 两遍压缩是 opt-in，会在压缩时多花一次模型调用，保持关闭但显式写出。
  assert.ok(config.includes("two_pass_compaction = false"));
});

test("自动压缩阈值与 gitignore 策略显式写出，不跟上游默认值漂移", () => {
  const config = renderGrokConfig({ models: [entry()] });
  assert.ok(config.includes("[session]"));
  assert.ok(config.includes("auto_compact_threshold_percent = 85"));
  assert.ok(config.includes("[tools]"));
  // 开成 true 会连用户明确要求改的产物文件都被工具拒绝，代价大于收益。
  assert.ok(config.includes("respect_gitignore = false"));
});

test("跨会话记忆两种状态都显式写出，默认关闭", () => {
  const off = renderGrokConfig({ models: [entry()] });
  assert.ok(off.includes("[memory]"));
  assert.ok(off.includes("enabled = false"));

  const on = renderGrokConfig({ models: [entry()], memory: { enabled: true } });
  const memorySection = on.slice(on.indexOf("[memory]"));
  assert.ok(memorySection.startsWith("[memory]\nenabled = true"));
});

test("重试与推理静默超时写进 [models]，但绝不写 stream_tool_calls", () => {
  const config = renderGrokConfig({ models: [entry()] });
  assert.ok(config.includes("max_retries = 8"));
  assert.ok(config.includes("inference_idle_timeout_secs = 600"));
  // 文档明确它改变请求形状，部分 BYOK 端点要求保持不设；我们的服务商正属这类。
  assert.equal(config.includes("stream_tool_calls"), false);
});

test("shell 超时抬到 600s：默认 120s 砍掉的正是全量构建与 E2E", () => {
  const config = renderGrokConfig({ models: [entry()] });
  assert.ok(config.includes("[toolset.bash]"));
  assert.ok(config.includes("timeout_secs = 600"));
});

test("tuning 可整体覆盖，数值一律取整避免写出小数键", () => {
  const config = renderGrokConfig({
    models: [entry()],
    tuning: {
      lspTools: false,
      codebaseIndexing: false,
      twoPassCompaction: true,
      autoCompactThresholdPercent: 70.6,
      maxRetries: 3.2,
      inferenceIdleTimeoutSecs: 120.9,
      bashTimeoutSecs: 90.4,
      respectGitignore: true,
    },
  });
  assert.ok(config.includes("lsp_tools = false"));
  assert.ok(config.includes("two_pass_compaction = true"));
  assert.ok(config.includes("auto_compact_threshold_percent = 70"));
  assert.ok(config.includes("max_retries = 3"));
  assert.ok(config.includes("inference_idle_timeout_secs = 120"));
  assert.ok(config.includes("timeout_secs = 90"));
  assert.ok(config.includes("respect_gitignore = true"));
  assert.equal(/= \d+\.\d/.test(config), false, "不应写出小数");
});

test("默认模型写进 [models] default，缺省时不写这一项", () => {
  assert.ok(renderGrokConfig({ models: [entry()], defaultModelId: "m1" }).includes('default = "m1"'));
  assert.equal(renderGrokConfig({ models: [entry()] }).includes("default ="), false);
});

test("env_key 按 Provider 派生，多 Provider 的模型各用自己的槽位", () => {
  const providers: ProviderConfig[] = [
    deepseekProvider(),
    {
      id: "poe",
      type: "poe",
      displayName: "Poe",
      baseUrl: "https://api.poe.com/v1",
      protocol: "responses",
      enabled: true,
      secretId: secretIdFor("poe"),
      models: [{
        id: "some-bot",
        displayName: "Some Bot",
        enabled: true,
        protocol: "chat_completions",
        capabilities: {
          streaming: true,
          toolCalling: true,
          reasoning: false,
          vision: false,
          agentCompatible: true,
        },
      }],
    },
  ];
  const entries = resolveModelEntries(providers, envKeyName);
  assert.equal(entries.length, 2);
  const config = renderGrokConfig({ models: entries });
  assert.ok(config.includes('env_key = "LINGDONG_KEY_DEEPSEEK"'));
  assert.ok(config.includes('env_key = "LINGDONG_KEY_POE"'));
  // openai_compatible / chat_completions 都落到 chat_completions。
  assert.ok(config.includes('api_backend = "chat_completions"'));
});

test("禁用的 Provider 与模型不进 config", () => {
  const disabled: ProviderConfig = { ...deepseekProvider(), enabled: false };
  assert.equal(resolveModelEntries([disabled], envKeyName).length, 0);

  const provider = deepseekProvider();
  provider.models[0] = { ...provider.models[0]!, enabled: false };
  assert.equal(resolveModelEntries([provider], envKeyName).length, 0);
});

test("含点的模型 id 会被加引号，不会被当成嵌套表", () => {
  const config = renderGrokConfig({ models: [entry({ modelId: "vendor.model-1" })] });
  assert.ok(config.includes('[model."vendor.model-1"]'));
});
