import {
  apiModelIdOf,
  toApiBackend,
  type ProviderConfig,
  type ProviderModelConfig,
} from "./provider-types";

/**
 * 生成 Grok 的 config.toml。
 *
 * 键名全部来自本机 Grok 0.2.118 随包文档（data/docs/user-guide/05-configuration.md 与
 * 11-custom-models.md），没有臆造的字段。因为托管目录里这份文件整份由我们重写，
 * 不需要 TOML 解析器，只需要一个最小 emitter。
 *
 * 两条硬规则：
 * 1. 只写 `env_key`，永不写 `api_key`。Grok 的凭据解析顺序是
 *    api_key → env_key → 会话 token → XAI_API_KEY，写 env_key 就能让真实凭据
 *    完全不落盘。函数入参类型里根本没有 key 字段。
 * 2. 隐私开关每次都显式写 false，不依赖 Grok 的默认值——telemetry、feedback、
 *    remote_fetch 的文档默认值分别是 false/true/true，其中后两个默认是开的。
 */

/** 本轮强制关闭的通道；字段名与 Grok 文档一致。 */
export interface PrivacyFlags {
  telemetry: false;
  feedback: false;
  remoteFetch: false;
  mixpanel: false;
  traceUpload: false;
  externalOtel: false;
  autoUpdate: false;
}

export const FORCED_PRIVACY: PrivacyFlags = {
  telemetry: false,
  feedback: false,
  remoteFetch: false,
  mixpanel: false,
  traceUpload: false,
  externalOtel: false,
  autoUpdate: false,
};

/**
 * Agent 能力与稳定性调参。键名与默认值均来自 05-configuration.md 与 11-custom-models.md。
 *
 * 之所以把默认值也显式写出来：这份 config.toml 由我们整份重写，显式写出的键
 * 才能保证换 Grok 版本时行为不跟着上游默认值漂移。
 */
export interface GrokTuningConfig {
  /** 暴露 `lsp` 工具（文档默认 false）。要真正可用还需要 `.grok/lsp.json` 里有 language server。 */
  lspTools: boolean;
  /** 代码图索引（文档默认 true）。 */
  codebaseIndexing: boolean;
  /** 两遍压缩（文档默认 false，opt-in）。开启会在压缩时多花一次模型调用。 */
  twoPassCompaction: boolean;
  /** 上下文用到多少百分比时自动压缩（文档默认 85）。 */
  autoCompactThresholdPercent: number;
  /** 单次推理的重试次数（文档示例 8）。第三方服务商偶发 5xx 时救命。 */
  maxRetries: number;
  /** 推理静默超时秒数（文档示例 600）。长轮次别被提前掐断。 */
  inferenceIdleTimeoutSecs: number;
  /** 前台 shell 命令超时秒数（文档默认 120）。构建与测试经常超过两分钟。 */
  bashTimeoutSecs: number;
  /**
   * 是否让所有工具跳过被 gitignore 的文件（文档默认 false）。
   * 保持 false：开了之后连用户明确要求改的产物文件或本地配置都会被工具拒绝，
   * 代价大于「少翻几次 node_modules」的收益。
   */
  respectGitignore: boolean;
}

export const DEFAULT_TUNING: GrokTuningConfig = {
  lspTools: true,
  codebaseIndexing: true,
  twoPassCompaction: false,
  autoCompactThresholdPercent: 85,
  maxRetries: 8,
  inferenceIdleTimeoutSecs: 600,
  bashTimeoutSecs: 600,
  respectGitignore: false,
};

/** 一个待写入 config.toml 的模型；已把 Provider 的地址与环境变量名展开。 */
export interface ResolvedModelEntry {
  /** 本地键：TOML 表名与 `[models] default` 都用它。 */
  modelId: string;
  /**
   * 发给服务商的模型名，写进 `model =`。与 `modelId` 分开是必需的：
   * 本地键带 Provider 前缀以避免跨 Provider 撞名，但服务商只认它自己的名字。
   */
  apiModelId: string;
  displayName: string;
  baseUrl: string;
  envKeyName: string;
  apiBackend: "responses" | "chat_completions" | "messages";
  contextWindow?: number;
  description?: string;
}

/** 宿主侧联网搜索 MCP（对标 Cursor：搜索不经对话模型供应商）。 */
export interface WebSearchMcpConfig {
  command: string;
  args: readonly string[];
  /** 例如 ELECTRON_RUN_AS_NODE=1（command 为 Code.exe 时必需）。 */
  env?: Readonly<Record<string, string>>;
}

/** 用户自定义 MCP；敏感值必须已换成 `${LINGDONG_MCP_...}` 占位。 */
export interface UserMcpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: readonly string[];
  url?: string;
  env?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
}

export interface SkillsTomlConfig {
  disabled: readonly string[];
  /** 额外技能扫描目录（例如本机 ~/.grok/skills，与托管 GROK_HOME 不同时）。 */
  paths?: readonly string[];
}

/**
 * `web_fetch`（抓取网页正文）配置。默认关：抓取任意 URL 属于要用户显式点头的能力。
 *
 * 启停走环境变量 `GROK_WEB_FETCH`（见 runtime-env.ts）——文档确认它跨 0.2.118/1.0.0
 * 都生效；这里只在启用时补两件 config 侧的事：
 * - `[toolset.web_fetch] allowed_domains`：抓取出口白名单（文档记的键，也是自建 1.0.0 的读法）；
 * - `[permission] allow = ["WebFetch(domain:X)"]`：让白名单域名免二次确认（权限层跨版本都认）。
 * 域名为空表示「启用但不限定」，沿用 Grok 内置默认白名单。
 */
export interface WebFetchTomlConfig {
  enabled: boolean;
  allowedDomains: readonly string[];
}

export interface GrokConfigInput {
  models: readonly ResolvedModelEntry[];
  /** `[models] default`；留空则不写这一项，交给 Grok 自己的默认。 */
  defaultModelId?: string;
  privacy?: PrivacyFlags;
  /**
   * 写入 `[mcp_servers.lingdong_web]` 与关闭内置 backend WebSearch 的权限规则。
   * 缺省时不写系统 MCP 段（单测 / 无产物路径时友好）。
   */
  webSearchMcp?: WebSearchMcpConfig;
  /** 用户自定义 MCP（不含保留名 lingdong_web）。 */
  userMcpServers?: readonly UserMcpServerConfig[];
  /** 写入 `[skills] disabled`；空数组也写，便于清空禁用列表。 */
  skills?: SkillsTomlConfig;
  /** web_fetch 域名白名单与免确认规则；缺省 = 关闭（不写 toolset/permission）。 */
  webFetch?: WebFetchTomlConfig;
  /** Agent 能力与稳定性调参；缺省用 {@link DEFAULT_TUNING}。 */
  tuning?: GrokTuningConfig;
  /**
   * 跨会话记忆。涉及把对话内容长期写到磁盘，必须由用户显式开启，
   * 所以这一段两种状态都显式写出，不依赖 Grok 的默认值。
   */
  memory?: MemoryConfig;
}

/** `[memory]`：键名来自 13-memory.md 的配置参考表。 */
export interface MemoryConfig {
  enabled: boolean;
}

function quote(value: string): string {
  // TOML 基本字符串：反斜杠与双引号需要转义，控制字符直接丢掉。
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "");
  return `"${escaped}"`;
}

/** `[model."a.b"]` 这类含点的键必须整段加引号，否则 TOML 会当成嵌套表。 */
function tableKey(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : quote(id);
}

function inlineTable(entries: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!entries) return undefined;
  const keys = Object.keys(entries);
  if (keys.length === 0) return undefined;
  const pairs = keys
    .map((key) => `${key} = ${quote(entries[key] ?? "")}`)
    .join(", ");
  return `{ ${pairs} }`;
}

function emitUserMcp(lines: string[], server: UserMcpServerConfig): void {
  lines.push(`[mcp_servers.${tableKey(server.name)}]`);
  lines.push("enabled = true");
  if (server.transport === "stdio") {
    lines.push(`command = ${quote(server.command ?? "")}`);
    lines.push(`args = [${(server.args ?? []).map((arg) => quote(arg)).join(", ")}]`);
    const env = inlineTable(server.env);
    if (env) lines.push(`env = ${env}`);
  } else {
    lines.push(`url = ${quote(server.url ?? "")}`);
    const headers = inlineTable(server.headers);
    if (headers) lines.push(`headers = ${headers}`);
  }
  lines.push("");
}

function emitPermissions(
  lines: string[],
  input: {
    hasWebSearchMcp: boolean;
    userNames: readonly string[];
    webFetchDomains: readonly string[];
  },
): void {
  if (
    !input.hasWebSearchMcp
    && input.userNames.length === 0
    && input.webFetchDomains.length === 0
  ) return;

  const deny: string[] = [];
  const allow: string[] = [];
  const rules: string[] = [];

  if (input.hasWebSearchMcp) {
    deny.push("WebSearch");
    allow.push('MCPTool(lingdong_web__*)', 'MCPTool(lingdong_web:*)');
    rules.push('{ action = "deny", tool = "websearch" }');
    rules.push('{ action = "allow", tool = "mcp", pattern = "lingdong_web*" }');
  }
  for (const name of input.userNames) {
    allow.push(`MCPTool(${name}__*)`, `MCPTool(${name}:*)`);
    rules.push(`{ action = "allow", tool = "mcp", pattern = "${name}*" }`);
  }
  // 白名单域名免二次确认：域名匹配含子域、大小写不敏感（见 Grok 权限文档 WebFetch Rules）。
  for (const domain of input.webFetchDomains) {
    allow.push(`WebFetch(domain:${domain})`);
  }

  lines.push("[permission]");
  if (deny.length > 0) {
    lines.push(`deny = [${deny.map((item) => quote(item)).join(", ")}]`);
  }
  if (allow.length > 0) {
    lines.push(`allow = [${allow.map((item) => quote(item)).join(", ")}]`);
  }
  if (rules.length > 0) {
    lines.push("rules = [");
    for (const rule of rules) lines.push(`  ${rule},`);
    lines.push("]");
  }
  lines.push("");
}

export function renderGrokConfig(input: GrokConfigInput): string {
  const privacy = input.privacy ?? FORCED_PRIVACY;
  const tuning = input.tuning ?? DEFAULT_TUNING;
  const lines: string[] = [
    "# 由灵动 Code 生成，请勿手工编辑。",
    "# 修改模型请使用命令「灵动 Code：配置模型服务商密钥」或模型设置界面。",
    "# API Key 不写入本文件：模型只声明 env_key，真实凭据保存在 VS Code SecretStorage。",
    "",
  ];

  // 身份标签：系统提示词模板是 "You are ${system_prompt_label} ..."，默认 "Grok"。
  // 改这里即可让 Agent 自称灵动，不需要动 Grok 源码（解析链见 grok-src
  // crates/codegen/xai-grok-shell/src/util/config/resolve/system_prompt.rs）。
  lines.push("[agent]");
  lines.push(`system_prompt_label = ${quote("灵动 Agent")}`);
  lines.push("");

  lines.push("[models]");
  if (input.defaultModelId) lines.push(`default = ${quote(input.defaultModelId)}`);
  // 刻意不写 [models] web_search：内置 backend 搜索依赖模型供应商能力，
  // Poe/DeepSeek 不支持，会鉴权失败。联网改由宿主 MCP WebSearch 承担。
  lines.push(`max_retries = ${String(Math.trunc(tuning.maxRetries))}`);
  lines.push(`inference_idle_timeout_secs = ${String(Math.trunc(tuning.inferenceIdleTimeoutSecs))}`);
  // 刻意不写 stream_tool_calls：文档明确它改变请求「形状」，部分 BYOK 端点
  // 要求保持不设。我们的第三方服务商正属于这类，而工具参数增量本来就在正常到达。
  lines.push("");

  lines.push("[features]");
  lines.push(`telemetry = ${String(privacy.telemetry)}`);
  lines.push(`feedback = ${String(privacy.feedback)}`);
  lines.push(`remote_fetch = ${String(privacy.remoteFetch)}`);
  lines.push(`lsp_tools = ${String(tuning.lspTools)}`);
  lines.push(`codebase_indexing = ${String(tuning.codebaseIndexing)}`);
  lines.push(`two_pass_compaction = ${String(tuning.twoPassCompaction)}`);
  lines.push("");

  lines.push("[session]");
  lines.push(`auto_compact_threshold_percent = ${String(Math.trunc(tuning.autoCompactThresholdPercent))}`);
  lines.push("");

  lines.push("[tools]");
  lines.push(`respect_gitignore = ${String(tuning.respectGitignore)}`);
  lines.push("");

  // 关闭时也写出来：这一段管的是「对话内容要不要长期落盘」，
  // 靠默认值等于让上游替用户改主意。env 侧还会再写一次 GROK_MEMORY。
  lines.push("[memory]");
  lines.push(`enabled = ${String(input.memory?.enabled === true)}`);
  lines.push("");

  lines.push("[telemetry]");
  lines.push(`mixpanel_enabled = ${String(privacy.mixpanel)}`);
  lines.push(`trace_upload = ${String(privacy.traceUpload)}`);
  lines.push(`otel_enabled = ${String(privacy.externalOtel)}`);
  lines.push("");

  lines.push("[cli]");
  lines.push(`auto_update = ${String(privacy.autoUpdate)}`);
  lines.push("");

  // 保留原有行为：不再拉取已清理过的默认技能。
  lines.push("[marketplace]");
  lines.push("default_skills_installs_purged = true");
  lines.push("");

  if (input.skills) {
    lines.push("[skills]");
    const disabled = input.skills.disabled.map((name) => quote(name)).join(", ");
    lines.push(`disabled = [${disabled}]`);
    if (input.skills.paths && input.skills.paths.length > 0) {
      const paths = input.skills.paths.map((item) => quote(item)).join(", ");
      lines.push(`paths = [${paths}]`);
    }
    lines.push("");
  }

  // 模型提问（ask_user_question）不设超时：与 Cursor 一致地等用户作答，
  // 用户随时可取消整轮；否则 Grok 侧会在超时后替用户「跳过回答」。
  lines.push("[toolset.ask_user_question]");
  lines.push("timeout_enabled = false");
  lines.push("");

  // 默认 120s 砍掉的正是最需要跑完的那类命令：全量构建、E2E、依赖安装。
  lines.push("[toolset.bash]");
  lines.push(`timeout_secs = ${String(Math.trunc(tuning.bashTimeoutSecs))}`);
  lines.push("");

  // web_fetch 抓取出口白名单：仅在启用且给了域名时写。启停本身走 GROK_WEB_FETCH 环境变量。
  const webFetchDomains = input.webFetch?.enabled ? input.webFetch.allowedDomains : [];
  if (webFetchDomains.length > 0) {
    lines.push("[toolset.web_fetch]");
    lines.push(`allowed_domains = [${webFetchDomains.map((domain) => quote(domain)).join(", ")}]`);
    // SSRF 兜底：始终显式关闭本地回环访问，不让上游默认值漂移。
    lines.push("allow_local = false");
    lines.push("");
  }

  if (input.webSearchMcp) {
    // 宿主侧搜索：Grok 拉起本地 MCP；查询发往搜索引擎，不经对话模型供应商。
    lines.push("[mcp_servers.lingdong_web]");
    lines.push(`command = ${quote(input.webSearchMcp.command)}`);
    lines.push(`args = [${input.webSearchMcp.args.map((arg) => quote(arg)).join(", ")}]`);
    lines.push("enabled = true");
    // Code.exe + Electron 冷启动偶发超过默认 30s；给足余量。
    lines.push("startup_timeout_sec = 60");
    const env = inlineTable(input.webSearchMcp.env);
    if (env) lines.push(`env = ${env}`);
    lines.push("");
  }

  const userServers = input.userMcpServers ?? [];
  for (const server of userServers) {
    if (server.name === "lingdong_web") continue;
    emitUserMcp(lines, server);
  }

  emitPermissions(lines, {
    hasWebSearchMcp: Boolean(input.webSearchMcp),
    userNames: userServers.map((item) => item.name).filter((name) => name !== "lingdong_web"),
    webFetchDomains,
  });

  for (const model of input.models) {
    lines.push(`[model.${tableKey(model.modelId)}]`);
    lines.push(`model = ${quote(model.apiModelId)}`);
    lines.push(`base_url = ${quote(model.baseUrl)}`);
    lines.push(`name = ${quote(model.displayName)}`);
    if (model.description) lines.push(`description = ${quote(model.description)}`);
    lines.push(`env_key = ${quote(model.envKeyName)}`);
    lines.push(`api_backend = ${quote(model.apiBackend)}`);
    if (model.contextWindow !== undefined) {
      lines.push(`context_window = ${String(Math.trunc(model.contextWindow))}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 把 Provider 配置摊平成待写入条目；只取启用的 Provider 与启用的模型。
 *
 * `baseUrlOf` 用来改写写进 config.toml 的地址。默认是服务商的真实地址；
 * 开着本地转发层时换成回环地址，Grok 就会连到转发层而不是直连服务商。
 */
export function resolveModelEntries(
  providers: readonly ProviderConfig[],
  envKeyOf: (providerId: string) => string,
  baseUrlOf: (provider: ProviderConfig) => string = (provider) => provider.baseUrl,
): ResolvedModelEntry[] {
  const entries: ResolvedModelEntry[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      if (!model.enabled) continue;
      entries.push(toEntry(provider, model, envKeyOf(provider.id), baseUrlOf(provider)));
    }
  }
  return entries;
}

function toEntry(
  provider: ProviderConfig,
  model: ProviderModelConfig,
  envKey: string,
  baseUrl: string,
): ResolvedModelEntry {
  return {
    modelId: model.id,
    apiModelId: apiModelIdOf(model),
    displayName: model.displayName,
    baseUrl,
    envKeyName: envKey,
    apiBackend: toApiBackend(model.protocol),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
  };
}
