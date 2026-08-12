import * as path from "node:path";
import type { FileSystemPort } from "../../file-system-port";
import { JsonStore } from "../../storage/json-store";
import {
  builtinProviderTemplate,
  deepseekProvider,
  envKeyName,
  isProviderProtocol,
  secretIdFor,
  type ProviderConfig,
  type ProviderModelConfig,
  type ProviderType,
} from "./provider-types";

/**
 * Provider 与模型的注册表。
 *
 * 只存非敏感配置：Provider 带 `secretId` 而不带凭据，类型层面就没有 key 字段。
 * 刻意不提供「找不到就换一个」的能力——自动回退会让用户以为数据发给了 A，
 * 实际发给了 B，这是本阶段明确禁止的行为。
 */

export interface ProviderState {
  providers: ProviderConfig[];
}

function emptyState(): ProviderState {
  return { providers: [] };
}

function validateState(data: unknown): ProviderState | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.providers)) return undefined;
  const providers: ProviderConfig[] = [];
  for (const raw of record.providers) {
    const provider = validateProvider(raw);
    if (provider) providers.push(provider);
  }
  return { providers };
}

function validateProvider(raw: unknown): ProviderConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id === "") return undefined;
  const type = record.type;
  if (type !== "deepseek" && type !== "poe" && type !== "custom-openai-compatible") return undefined;
  if (typeof record.baseUrl !== "string") return undefined;
  if (!isProviderProtocol(record.protocol)) return undefined;

  const models: ProviderModelConfig[] = [];
  if (Array.isArray(record.models)) {
    for (const rawModel of record.models) {
      const model = validateModel(rawModel);
      if (model) models.push(model);
    }
  }

  // 内置模板的地址与协议由模板固定，界面上没有改它们的入口。
  // 这里按模板重新取一次，模板修正之后已经装好的用户也能跟上。
  const template = builtinProviderTemplate(id);

  return {
    id,
    type: type as ProviderType,
    displayName: typeof record.displayName === "string" && record.displayName.trim() !== ""
      ? record.displayName
      : id,
    baseUrl: template?.baseUrl ?? record.baseUrl,
    protocol: template?.protocol ?? record.protocol,
    enabled: record.enabled !== false,
    // 忽略文件里写的 secretId，始终按 providerId 重新派生，避免被改成别的 Provider 的槽位。
    secretId: secretIdFor(id),
    models,
  };
}

function validateModel(raw: unknown): ProviderModelConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id === "") return undefined;
  if (!isProviderProtocol(record.protocol)) return undefined;
  const capabilities = record.capabilities;
  const caps = typeof capabilities === "object" && capabilities !== null
    ? capabilities as Record<string, unknown>
    : {};
  const remote = typeof record.remoteModelId === "string" ? record.remoteModelId.trim() : "";
  return {
    id,
    // 只在与本地键不同时保留，避免给旧条目凭空写上冗余字段。
    ...(remote !== "" && remote !== id ? { remoteModelId: remote } : {}),
    displayName: typeof record.displayName === "string" && record.displayName.trim() !== ""
      ? record.displayName
      : id,
    enabled: record.enabled !== false,
    protocol: record.protocol,
    capabilities: {
      streaming: caps.streaming !== false,
      toolCalling: caps.toolCalling === true,
      reasoning: caps.reasoning === true,
      vision: caps.vision === true,
      // 缺省不可用于 Agent：没有检测过就不该默认放行工具调用。
      agentCompatible: caps.agentCompatible === true,
    },
    // 只有显式写了 false 才算未验证；缺字段的旧条目照旧可用。
    ...(record.verified === false ? { verified: false as const } : {}),
    ...(typeof record.testedAt === "number" ? { testedAt: record.testedAt } : {}),
    ...(typeof record.contextWindow === "number" ? { contextWindow: record.contextWindow } : {}),
    ...(record.visionManual === true ? { visionManual: true as const } : {}),
  };
}

export interface ProviderRegistryDeps {
  fs: FileSystemPort;
  /** 扩展存储根目录。 */
  storageRoot: string;
  log?: (line: string) => void;
}

export class ProviderRegistry {
  private readonly store: JsonStore;
  private state: ProviderState = emptyState();
  private loaded = false;

  constructor(private readonly deps: ProviderRegistryDeps) {
    this.store = new JsonStore(deps.fs);
  }

  private get file(): string {
    return path.join(this.deps.storageRoot, "agent-providers", "providers.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const result = await this.store.read<ProviderState>(this.file, {
      kind: "providers",
      fallback: emptyState,
      validate: validateState,
    });
    this.state = result.data;
    this.loaded = true;
    if (result.status === "corrupt" || result.status === "recovered") {
      this.deps.log?.(`[providers] ${result.detail ?? "配置读取异常"}`);
    }
    // 首次使用：用当前已经在跑的 DeepSeek 播种，保证原有会话继续可用。
    if (this.state.providers.length === 0) {
      this.state.providers.push(deepseekProvider());
      await this.save();
      this.deps.log?.("[providers] 已按现有配置播种 DeepSeek Provider。");
    }
  }

  async save(): Promise<void> {
    await this.store.write(this.file, "providers", this.state);
  }

  list(): ProviderConfig[] {
    return this.state.providers.map((provider) => cloneProvider(provider));
  }

  get(providerId: string): ProviderConfig | undefined {
    const found = this.state.providers.find((provider) => provider.id === providerId);
    return found ? cloneProvider(found) : undefined;
  }

  /** 某个 Provider 下的模型；Provider 不存在时返回空数组，不做任何替代。 */
  models(providerId: string): ProviderModelConfig[] {
    return this.get(providerId)?.models ?? [];
  }

  /** 全部启用 Provider 的启用模型，带上所属 providerId。 */
  enabledModels(): Array<{ provider: ProviderConfig; model: ProviderModelConfig }> {
    const result: Array<{ provider: ProviderConfig; model: ProviderModelConfig }> = [];
    for (const provider of this.state.providers) {
      if (!provider.enabled) continue;
      for (const model of provider.models) {
        if (model.enabled) result.push({ provider: cloneProvider(provider), model: { ...model } });
      }
    }
    return result;
  }

  /** 按模型 id 反查所属 Provider；找不到就是找不到，不返回替代品。 */
  findModel(modelId: string): { provider: ProviderConfig; model: ProviderModelConfig } | undefined {
    for (const provider of this.state.providers) {
      const model = provider.models.find((candidate) => candidate.id === modelId);
      if (model) return { provider: cloneProvider(provider), model: { ...model } };
    }
    return undefined;
  }

  async upsertProvider(provider: ProviderConfig): Promise<void> {
    const next: ProviderConfig = { ...cloneProvider(provider), secretId: secretIdFor(provider.id) };
    const index = this.state.providers.findIndex((candidate) => candidate.id === provider.id);
    if (index >= 0) this.state.providers[index] = next;
    else this.state.providers.push(next);
    await this.save();
  }

  async removeProvider(providerId: string): Promise<boolean> {
    const index = this.state.providers.findIndex((provider) => provider.id === providerId);
    if (index < 0) return false;
    this.state.providers.splice(index, 1);
    await this.save();
    return true;
  }

  async setProviderEnabled(providerId: string, enabled: boolean): Promise<boolean> {
    const provider = this.state.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return false;
    provider.enabled = enabled;
    await this.save();
    return true;
  }

  async upsertModel(providerId: string, model: ProviderModelConfig): Promise<boolean> {
    const provider = this.state.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return false;
    const index = provider.models.findIndex((candidate) => candidate.id === model.id);
    if (index >= 0) provider.models[index] = { ...model };
    else provider.models.push({ ...model });
    await this.save();
    return true;
  }

  async removeModel(providerId: string, modelId: string): Promise<boolean> {
    const provider = this.state.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return false;
    const index = provider.models.findIndex((candidate) => candidate.id === modelId);
    if (index < 0) return false;
    provider.models.splice(index, 1);
    await this.save();
    return true;
  }

  async setModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<boolean> {
    const provider = this.state.providers.find((candidate) => candidate.id === providerId);
    const model = provider?.models.find((candidate) => candidate.id === modelId);
    if (!model) return false;
    model.enabled = enabled;
    await this.save();
    return true;
  }

  /** 当前 Provider 对应的凭据环境变量名。 */
  envKeyFor(providerId: string): string {
    return envKeyName(providerId);
  }
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model, capabilities: { ...model.capabilities } })),
  };
}
