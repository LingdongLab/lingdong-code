/**
 * 模型注册表：只展示真实可用模型，不伪造 Claude/GPT 等未接入条目。
 */

export interface ModelDescriptor {
  id: string;
  displayName: string;
  provider: string;
  /** 所属 Provider 的标识；选择器按它分组，也决定注入哪一个凭据。 */
  providerId: string;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
  /**
   * 是否通过了工具调用检测。false 时只允许 Ask 模式——
   * 没验证过就放进 Agent，等于让模型在无法调用工具的前提下假装能干活。
   */
  agentCompatible: boolean;
  enabled: boolean;
  speedProfile: "fast" | "balanced" | "slow";
  reasoningProfile: "light" | "standard" | "deep";
}

const BUILTIN: ModelDescriptor[] = [
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    provider: "deepseek",
    providerId: "deepseek",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: false,
    agentCompatible: true,
    enabled: true,
    speedProfile: "fast",
    reasoningProfile: "standard",
  },
];

export class ModelRegistry {
  private models = new Map<string, ModelDescriptor>();

  constructor(initial: readonly ModelDescriptor[] = BUILTIN) {
    this.replace(initial);
  }

  /**
   * 用 Provider 注册表的内容整体替换。
   * 模型清单的权威来源是 ProviderRegistry，这里只是给 UI 用的投影。
   */
  replace(models: readonly ModelDescriptor[]): void {
    const next = new Map<string, ModelDescriptor>();
    for (const model of models) {
      if (model.enabled) next.set(model.id, { ...model });
    }
    this.models = next;
  }

  list(): ModelDescriptor[] {
    return [...this.models.values()];
  }

  get(id: string): ModelDescriptor | undefined {
    return this.models.get(id);
  }

  /** 本地过滤，不访问网络。 */
  search(query: string): ModelDescriptor[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") return this.list();
    return this.list().filter(
      (model) =>
        model.id.toLowerCase().includes(needle)
        || model.displayName.toLowerCase().includes(needle)
        || model.provider.toLowerCase().includes(needle),
    );
  }

  /** 当前是否支持「自动选择」：至少两个已启用模型。 */
  canAutoSelect(): boolean {
    return this.models.size >= 2;
  }

  hasVisionModel(): boolean {
    return this.list().some((model) => model.supportsVision);
  }
}

export interface ModelProjectionOptions {
  /**
   * 该 Provider 是否已配置凭据。没配凭据的模型摆在选择器里只会在发送时失败，
   * 不如一开始就不显示。缺省时不做这项过滤（纯投影场景用）。
   */
  hasKey?: (providerId: string) => boolean;
}

/**
 * 把 Provider 配置投影成 UI 用的模型清单。
 *
 * 展示门槛：Provider 已启用、凭据已配置、模型已启用、且通过过基础连接测试。
 * `verified` 缺省视为通过，所以 G-R7a 播种的 DeepSeek 条目照旧可见。
 */
export function toModelDescriptors(
  providers: readonly {
    id: string;
    displayName: string;
    enabled: boolean;
    models: readonly {
      id: string;
      displayName: string;
      enabled: boolean;
      verified?: boolean;
      contextWindow?: number;
      capabilities: { toolCalling: boolean; vision: boolean; reasoning: boolean; agentCompatible: boolean };
    }[];
  }[],
  options: ModelProjectionOptions = {},
): ModelDescriptor[] {
  const result: ModelDescriptor[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    if (options.hasKey && !options.hasKey(provider.id)) continue;
    for (const model of provider.models) {
      if (!model.enabled) continue;
      if (model.verified === false) continue;
      result.push({
        id: model.id,
        displayName: model.displayName,
        provider: provider.displayName,
        providerId: provider.id,
        contextWindow: model.contextWindow ?? 0,
        supportsTools: model.capabilities.toolCalling,
        supportsVision: model.capabilities.vision,
        agentCompatible: model.capabilities.agentCompatible,
        enabled: true,
        speedProfile: "balanced",
        reasoningProfile: model.capabilities.reasoning ? "standard" : "light",
      });
    }
  }
  return result;
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}K`;
  return String(tokens);
}
