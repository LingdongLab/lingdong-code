/**
 * Provider 与模型的非敏感配置。
 *
 * 这一层**永远不含 API Key**：`ProviderConfig` 只带 `secretId`，真实凭据在
 * VS Code SecretStorage 里，由 ProviderSecretStore 单独管理。
 * 类型上就没有 key 字段，所以「Key 不进普通配置」不是靠纪律维持的。
 */

/** Grok 支持的三种 API 后端，取自其 11-custom-models.md 的 api_backend。 */
export type ProviderProtocol =
  | "responses"
  | "chat_completions"
  | "messages"
  | "openai_compatible";

export type ProviderType = "deepseek" | "poe" | "custom-openai-compatible";

export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  reasoning: boolean;
  vision: boolean;
  /** 通过工具调用检测才为 true；false 时只允许 Ask 模式。 */
  agentCompatible: boolean;
}

export interface ProviderModelConfig {
  /**
   * 注册表内唯一的本地键，同时也是 Grok config.toml 的 `[model.<id>]` 表名与
   * `[models] default` 的取值。新增模型一律按 `<providerId>:<远端模型名>` 派生，
   * 因为两个 Provider 完全可能提供同名模型（例如都有 DeepSeek-R1），
   * 而 findModel 与 default 共用这一个键空间。
   */
  id: string;
  /**
   * 真正发给服务商的模型名。缺省时等于 `id`——既有的 deepseek-v4-flash 就是这种情况，
   * 保持原样，不做迁移。
   */
  remoteModelId?: string;
  displayName: string;
  enabled: boolean;
  protocol: ProviderProtocol;
  capabilities: ModelCapabilities;
  /**
   * 是否通过过基础连接测试。缺省视为通过，所以 G-R7a 播种的条目照旧可用；
   * 新加的模型在测通之前是 false，不进 Composer。
   */
  verified?: boolean;
  /** 上次连接或能力检测的时间；未测过则不存在。 */
  testedAt?: number;
  contextWindow?: number;
  /**
   * `vision` 是用户手动声明的，启动时的目录校准不要覆盖它。
   *
   * 没有这一位的话，用户在标准 OpenAI 兼容服务商上手动打开图片输入，
   * 只要该服务商的目录能拉到（哪怕没声明模态），下次启动就会被校准成 false，
   * 表现为「开关自己关了」，而用户无从得知是谁改的。
   */
  visionManual?: boolean;
}

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  displayName: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  /** SecretStorage 里的凭据标识；不是凭据本身。 */
  secretId: string;
  models: ProviderModelConfig[];
}

/** 传给 Grok config.toml 的 api_backend 值；openai_compatible 落到 chat_completions。 */
export function toApiBackend(protocol: ProviderProtocol): "responses" | "chat_completions" | "messages" {
  if (protocol === "responses") return "responses";
  if (protocol === "messages") return "messages";
  return "chat_completions";
}

export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = [
  "responses",
  "chat_completions",
  "messages",
  "openai_compatible",
];

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * Provider 凭据对应的环境变量名。
 *
 * 按 Provider 派生而不是共用一个固定名字：config.toml 里可以同时留着多个 Provider 的模型
 * 供选择器展示，但只有当前会话 Provider 的这一个变量会被注入子进程，
 * 其余模型拿不到凭据，也不会退到 XAI_API_KEY（它在子进程环境里已被剥离）。
 */
export function envKeyName(providerId: string): string {
  const normalized = providerId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return `LINGDONG_KEY_${normalized}`;
}

/** SecretStorage 的命名空间；与 providerId 一一对应。 */
export function secretIdFor(providerId: string): string {
  return `lingdongAgent.providerKey.${providerId}`;
}

/**
 * 新增模型的本地键。用 `:` 分隔，Grok 侧 `[model."poe:Claude-Sonnet-4.6"]` 会被
 * 整段加引号，TOML 合法；`[models] default` 也写同一个值，两边一致。
 */
export function localModelId(providerId: string, remoteModelId: string): string {
  return `${providerId}:${remoteModelId}`;
}

/**
 * 远端模型名允许的字符。
 *
 * 比本地 id 宽一点（Poe 的 Bot 名会用 `@` 与 `.`），但同样禁止路径、空白与控制字符。
 * 设置页入站校验与模型目录解析共用这一个判定：两边若各写一份，
 * 目录里就会出现「看得见、加不进」的条目。
 */
const REMOTE_MODEL_ID_PATTERN = /^[A-Za-z0-9._@+-]{1,128}$/;

export function isRemoteModelId(value: string): boolean {
  return REMOTE_MODEL_ID_PATTERN.test(value);
}

/** 发给服务商的模型名。 */
export function apiModelIdOf(model: ProviderModelConfig): string {
  return model.remoteModelId ?? model.id;
}

/** 模型是否可以出现在 Composer 里；缺省视为已验证。 */
export function isModelVerified(model: ProviderModelConfig): boolean {
  return model.verified !== false;
}

export const DEEPSEEK_PROVIDER_ID = "deepseek";

export const POE_PROVIDER_ID = "poe";

/**
 * Poe 的固定配置。
 *
 * 不参与播种：注册表只在首次为空时播种 DeepSeek，Poe 由用户在模型中心点一下才写入。
 * 这样既有安装不会凭空多出一个没配凭据的服务商，也不必为它改动任何既有断言。
 *
 * `enabled: false` 与 `models: []` 都是刻意的：与自定义 Provider 同一套规矩，
 * 首个模型通过连接测试后才由 applyOutcome 启用，绝不预置任何模型。
 */
export function poeProvider(): ProviderConfig {
  return {
    id: POE_PROVIDER_ID,
    type: "poe",
    displayName: "Poe",
    // 带 /v1 是 Grok 自定义模型文档的约定，测试请求与运行时用同一个地址。
    baseUrl: "https://api.poe.com/v1",
    // Chat Completions 是 Poe 上通用性最好的端点：实测 329 个模型里只有 47 个
    // 声明支持 Responses，其余对 /responses 直接返回 400。这里只是新模型的初值，
    // 目录里明确声明 Responses 的模型仍然按目录走。
    protocol: "chat_completions",
    enabled: false,
    secretId: secretIdFor(POE_PROVIDER_ID),
    models: [],
  };
}

/** 可一键添加的内置服务商；同时是设置页入站校验的白名单，避免两处各写一份。 */
export const BUILTIN_PROVIDER_TEMPLATE_IDS: readonly string[] = [POE_PROVIDER_ID];

export function builtinProviderTemplate(providerId: string): ProviderConfig | undefined {
  return providerId === POE_PROVIDER_ID ? poeProvider() : undefined;
}

/**
 * DeepSeek 的既有事实：base_url、api_backend 与上下文长度都来自本机
 * 已经在跑的 grok config.toml，不是猜的。迁移时用它播种，保证原有会话继续可用。
 */
export function deepseekProvider(): ProviderConfig {
  return {
    id: DEEPSEEK_PROVIDER_ID,
    type: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    protocol: "responses",
    enabled: true,
    secretId: secretIdFor(DEEPSEEK_PROVIDER_ID),
    models: [
      {
        id: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        enabled: true,
        protocol: "responses",
        contextWindow: 1_000_000,
        capabilities: {
          streaming: true,
          toolCalling: true,
          reasoning: true,
          vision: false,
          // 现有 Agent / Plan / Timeline 链路一直跑在这个模型上，是既成事实而不是推测。
          agentCompatible: true,
        },
      },
    ],
  };
}
