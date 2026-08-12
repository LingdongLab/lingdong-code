import * as vscode from "vscode";
import { existsSync } from "node:fs";
import type { FileSystemPort } from "../file-system-port";
import type { HostToWebviewMessage } from "../messages";
import {
  FORCED_PRIVACY,
  renderGrokConfig,
  resolveModelEntries,
  type SkillsTomlConfig,
  type UserMcpServerConfig,
} from "../models/providers/grok-config-writer";
import { ModelProxy } from "../models/providers/model-proxy";
import type { ImageStore } from "./image-store";
import { ProviderRegistry } from "../models/providers/provider-registry";
import {
  ProviderSecretStore,
  type SecretIndexPort,
  type SecretStoragePort,
} from "../models/providers/provider-secret-store";
import {
  DEEPSEEK_PROVIDER_ID,
  envKeyName,
  type ProviderConfig,
  type ProviderModelConfig,
} from "../models/providers/provider-types";
import {
  MANAGED_CHANNELS,
  type RuntimeModelProfile,
} from "../models/providers/runtime-model-profile";
import type { EditPreviewMode } from "../preview/edit-preview-model";
import { ManagedGrokHome } from "../privacy/managed-grok-home";
import { composeHookCommandLine, renderVerifyHooks } from "../verify-gate/hooks-json";
import { buildChildEnv } from "../privacy/runtime-env";
import { registerSecretLiterals } from "../privacy/secret-redactor";
import { resolveMcpRuntime, type McpRuntime } from "../web-search/resolve-mcp-runtime";

/**
 * Provider 编排层。
 *
 * 把注册表、SecretStorage、托管 GROK_HOME、config.toml 生成与 Runtime 画像串起来，
 * 对外只暴露两个关键动作：启动前解析出「一个 Provider + 一个模型 + 一个凭据」，
 * 以及记录本次启动的真实画像供隐私状态界面读取。
 *
 * 明确不做的事：找不到 Provider、缺凭据、模型不兼容时一律返回失败原因，
 * 绝不换一个能用的顶上。静默回退会让用户以为数据发给了 A，实际发给了 B。
 */

const KEY_INDEX_STATE = "lingdongAgent.providerKeyIndex";

export type LaunchFailure =
  | { reason: "provider-missing"; providerId: string; modelId: string }
  | { reason: "model-missing"; providerId: string; modelId: string; providerName: string }
  | { reason: "provider-disabled"; providerId: string; providerName: string }
  /**
   * neverConfigured 区分两种长得一样、说法该完全不同的情况：
   * 用户配过凭据后来没了（该说「原来使用的凭据不存在了」），
   * 还是压根没配过（装机后第一次打开就是这种，该直接引导去填 Key）。
   */
  | { reason: "key-missing"; providerId: string; providerName: string; modelName: string; neverConfigured: boolean };

export interface LaunchTarget {
  provider: ProviderConfig;
  model: ProviderModelConfig;
  envKey: string;
  credential: string;
}

export type LaunchResolution =
  | { ok: true; target: LaunchTarget }
  | { ok: false; failure: LaunchFailure };

/** 子进程环境的构造结果：环境本体 + 注入清单（供快照与脱敏使用）。 */
export interface LaunchEnvBuild {
  env: NodeJS.ProcessEnv;
  /** 实际注入了凭据的 Provider id。 */
  injectedProviderIds: string[];
  /** 全部注入的凭据字面量，交给 Runtime 做日志脱敏。 */
  credentialValues: string[];
}

/**
 * 本次启动的能力快照：子进程环境里有哪些 Provider 的密钥、
 * config.toml 里写了哪些模型。切模型时命中快照 → `session/set_model` 免重连；
 * 未命中（会话中途新加的 Provider/模型）→ 兜底重连。
 */
export interface LaunchSnapshot {
  providerIds: readonly string[];
  modelIds: readonly string[];
}

export interface ProviderServiceDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  fs: FileSystemPort;
  storageRoot(): string;
  secrets: SecretStoragePort;
  /** 非敏感索引；生产用 globalState，测试可替换。 */
  index: SecretIndexPort;
  now?: () => number;
  /**
   * 宿主侧联网搜索 MCP 脚本绝对路径（`dist/web-search-mcp.js`）。
   * 文件存在时才写入 config.toml，避免测试/未打包环境挂空进程。
   */
  webSearchMcpScript?: () => string | undefined;
  /**
   * 校验闭环钩子脚本绝对路径（`dist/verify-gate.js`）。
   * 同样只在文件存在时写入 hooks，否则 Grok 每轮都会拉起一个失败的进程。
   */
  verifyGateScript?: () => string | undefined;
  /** 写入 `[skills] disabled`；缺省不写该段。 */
  skillsToml?: () => PromiseLike<SkillsTomlConfig | undefined>;
  /**
   * 用户级 lsp.json 内容；返回 undefined 时删除该文件。
   * 与 config.toml 同一时机写：Grok 只在会话建立时读一次这两份。
   */
  lspConfig?: () => PromiseLike<string | undefined>;
  /** 用户自定义 MCP（已换成 env 占位符）；缺省不写。 */
  userMcpServers?: () => PromiseLike<readonly UserMcpServerConfig[]>;
  /** 注入子进程的 MCP 凭据（LINGDONG_MCP_*）。 */
  mcpCredentials?: () => PromiseLike<readonly { name: string; value: string }[]>;
  /** 额外脱敏字面量（MCP 密钥等）。 */
  extraSecretLiterals?: () => PromiseLike<readonly string[]>;
  /**
   * 粘贴图片的暂存。转发层要用它把提示词里的标记换成真正的图片块——
   * 图片走不了 Grok 的 prompt 通道，只能在出站前补进去。
   */
  images?: () => ImageStore | undefined;
}

export function globalStateSecretIndex(state: vscode.Memento): SecretIndexPort {
  return {
    get: () => state.get<string[]>(KEY_INDEX_STATE, []) ?? [],
    set: async (ids) => { await state.update(KEY_INDEX_STATE, [...ids]); },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProviderService {
  readonly registry: ProviderRegistry;
  readonly secretStore: ProviderSecretStore;
  private readonly home: ManagedGrokHome;
  private readonly proxy: ModelProxy;
  private readonly now: () => number;
  private ready: Promise<void> | undefined;
  private profile: RuntimeModelProfile | undefined;
  private snapshot: LaunchSnapshot | undefined;
  /** 最近一次写入 config.toml 的模型 id 列表；启动时被固化进快照。 */
  private lastWrittenModelIds: string[] = [];

  constructor(private readonly deps: ProviderServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.registry = new ProviderRegistry({
      fs: deps.fs,
      storageRoot: deps.storageRoot(),
      log: deps.log,
    });
    this.secretStore = new ProviderSecretStore(deps.secrets, deps.index);
    this.home = new ManagedGrokHome({
      fs: deps.fs,
      storageRoot: deps.storageRoot(),
      log: deps.log,
      now: this.now,
    });
    this.proxy = new ModelProxy({
      log: deps.log,
      ...(deps.images ? { images: deps.images } : {}),
    });
  }

  get lastProfile(): RuntimeModelProfile | undefined {
    return this.profile;
  }

  get managedHome(): ManagedGrokHome {
    return this.home;
  }

  /** 首次使用时加载注册表、校准凭据索引并登记脱敏字面量。 */
  load(): Promise<void> {
    this.ready ??= this.doLoad();
    return this.ready;
  }

  private async doLoad(): Promise<void> {
    await this.registry.load();
    // 索引可能虚高（外部清空过 SecretStorage），启动时对齐一次，
    // 否则界面显示「已配置」而注入时拿不到凭据。
    await this.secretStore.reconcile(this.registry.list().map((provider) => provider.id));
    await this.refreshRedaction();
  }

  /** 把当前全部凭据字面量交给脱敏器，Key 变更后必须重新调用。 */
  async refreshRedaction(): Promise<string[]> {
    const literals = await this.secretStore.secretLiterals();
    const extra = [...(await this.deps.extraSecretLiterals?.() ?? [])];
    const merged = [...literals, ...extra];
    registerSecretLiterals(merged);
    return merged;
  }

  /**
   * 解析启动目标。
   * providerId 缺失时按 modelId 反查，兼容 v3 之前只记了 modelId 的会话。
   */
  async resolveLaunch(providerId: string | undefined, modelId: string): Promise<LaunchResolution> {
    await this.load();

    const provider = providerId
      ? this.registry.get(providerId)
      : this.registry.findModel(modelId)?.provider;
    if (!provider) {
      return { ok: false, failure: { reason: "provider-missing", providerId: providerId ?? "", modelId } };
    }
    if (!provider.enabled) {
      return { ok: false, failure: { reason: "provider-disabled", providerId: provider.id, providerName: provider.displayName } };
    }

    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      return {
        ok: false,
        failure: { reason: "model-missing", providerId: provider.id, modelId, providerName: provider.displayName },
      };
    }

    const credential = await this.secretStore.getKey(provider.id);
    if (!credential) {
      return {
        ok: false,
        failure: {
          reason: "key-missing",
          providerId: provider.id,
          providerName: provider.displayName,
          modelName: model.displayName,
          neverConfigured: this.secretStore.configuredProviders().length === 0,
        },
      };
    }

    return { ok: true, target: { provider, model, envKey: envKeyName(provider.id), credential } };
  }

  /** 失败原因转成可操作的中文提示；不暗示会自动换一个模型。 */
  describeFailure(failure: LaunchFailure): string {
    switch (failure.reason) {
      case "provider-missing":
        return `此会话原来使用的模型服务商已不存在（模型 ${failure.modelId}），请重新配置后再继续。`;
      case "provider-disabled":
        return `模型服务商「${failure.providerName}」已被禁用，请先启用后再继续。`;
      case "model-missing":
        return `「${failure.providerName}」下已经没有模型 ${failure.modelId}，请重新选择模型。`;
      case "key-missing":
        // 一个凭据都没配过时，「原来使用」是句假话——那个模型是设置项的默认值，
        // 不是用户选的。装机后第一次打开撞上的就是这一条，得直说下一步做什么。
        if (failure.neverConfigured) {
          return `还没有配置任何模型凭据。填一个 API Key 就能开始对话，`
            + `当前默认模型是 ${failure.providerName} · ${failure.modelName}。`;
        }
        return `此会话原来使用 ${failure.providerName} · ${failure.modelName}，`
          + "但对应凭据已不存在，请重新配置。";
    }
  }

  /**
   * 准备托管 GROK_HOME 并写入 config.toml。
   * 返回交给子进程的 GROK_HOME；托管关闭时返回探测到的原目录。
   */
  async prepareHome(input: {
    detectedHome: string | undefined;
    grokVersion?: string;
    defaultModelId: string;
  }): Promise<{ grokHome: string | undefined; configFile: string | undefined; managed: boolean }> {
    if (!managedHomeEnabled()) {
      this.deps.log("[privacy] 托管 GROK_HOME 已关闭，隐私开关无法保证。");
      return { grokHome: input.detectedHome, configFile: undefined, managed: false };
    }

    await this.load();
    const grokHome = await this.home.ensure({
      ...(input.detectedHome ? { source: input.detectedHome } : {}),
      ...(input.grokVersion ? { grokVersion: input.grokVersion } : {}),
    });
    await this.writeConfig(input.defaultModelId);
    return { grokHome, configFile: this.home.configFile, managed: true };
  }

  /** 重新生成 config.toml；切换模型或改动 Provider 后都要调用。 */
  async writeConfig(defaultModelId: string): Promise<void> {
    const rewrite = await this.proxyRewriter();
    const entries = resolveModelEntries(this.registry.list(), (id) => envKeyName(id), rewrite);
    const mcpScript = this.deps.webSearchMcpScript?.();
    // 不能直接用 process.execPath：扩展宿主里它是 Code.exe，会让 MCP「连接超时」。
    const runtime = resolveMcpRuntime();
    const webSearchMcp = mcpScript && existsSync(mcpScript)
      ? {
          command: runtime.command,
          args: [mcpScript] as readonly string[],
          ...(Object.keys(runtime.env).length > 0 ? { env: runtime.env } : {}),
        }
      : undefined;
    const skills = await this.deps.skillsToml?.();
    const userMcpServers = [...(await this.deps.userMcpServers?.() ?? [])];
    const webFetch = webFetchConfig();
    const contents = renderGrokConfig({
      models: entries,
      ...(defaultModelId ? { defaultModelId } : {}),
      privacy: FORCED_PRIVACY,
      memory: { enabled: memoryEnabled() },
      webFetch,
      ...(webSearchMcp ? { webSearchMcp } : {}),
      ...(skills ? { skills } : {}),
      ...(userMcpServers.length > 0 ? { userMcpServers } : {}),
    });
    await this.home.writeConfig(contents);
    await this.writeVerifyHooks(runtime);
    await this.home.writeLspConfig(await this.deps.lspConfig?.() ?? undefined);
    this.lastWrittenModelIds = entries.map((entry) => entry.modelId);
  }

  /**
   * 写入或移除校验闭环钩子。
   *
   * 与 config.toml 同一时机写：两者都在托管 GROK_HOME 里，且 Grok 只在启动时读一次。
   */
  private async writeVerifyHooks(runtime: McpRuntime): Promise<void> {
    if (!verifyAfterEditEnabled()) {
      await this.home.writeVerifyHooks(undefined);
      return;
    }
    const script = this.deps.verifyGateScript?.();
    if (!script || !existsSync(script)) {
      // 未打包环境（单测、源码调试）没有 dist 产物，写了只会每轮拉起失败进程。
      await this.home.writeVerifyHooks(undefined);
      return;
    }
    await this.home.writeVerifyHooks(renderVerifyHooks({
      commandLine: composeHookCommandLine(runtime.command, script),
      ...(Object.keys(runtime.env).length > 0 ? { env: runtime.env } : {}),
    }));
  }

  /**
   * 启动本地转发层，返回把服务商地址换成回环地址的映射函数。
   *
   * 转发层是为了修掉上游 usage 里的 null（Grok 解析不了，整轮报
   * `invalid type: null, expected u32`）。它只是个兜底，不该成为新的单点故障：
   * 起不来就照常写真实地址直连，最多是那几个模型继续报原来的错。
   */
  private async proxyRewriter(): Promise<(provider: ProviderConfig) => string> {
    const direct = (provider: ProviderConfig): string => provider.baseUrl;
    if (!responseSanitizingEnabled()) return direct;

    try {
      await this.proxy.start();
    } catch (error) {
      this.deps.log(`[proxy] 本地转发层启动失败，改为直连服务商：${errorText(error)}`);
      return direct;
    }

    return (provider) => {
      try {
        return this.proxy.register(provider.baseUrl);
      } catch (error) {
        this.deps.log(`[proxy] 「${provider.displayName}」登记失败，改为直连：${errorText(error)}`);
        return provider.baseUrl;
      }
    };
  }

  /** 扩展关闭时收掉本地端口。 */
  async stopProxy(): Promise<void> {
    await this.proxy.stop();
  }

  /**
   * 构造子进程环境：剥掉全部已知模型凭据，注入**所有已启用且配置了密钥**的
   * Provider 凭据（LINGDONG_KEY_* 槽位）。全量注入是免重连切模的前提：
   * config.toml 里所有模型的 env_key 都能解析到，`session/set_model` 才能跨
   * Provider 秒切。凭据仍只发给用户自己启用过的服务商。
   */
  async buildEnv(target: LaunchTarget, grokHome: string | undefined): Promise<LaunchEnvBuild> {
    await this.load();
    const credentials: { name: string; value: string }[] = [];
    const injectedProviderIds: string[] = [];
    for (const provider of this.registry.list()) {
      if (!provider.enabled) continue;
      const value = provider.id === target.provider.id
        ? target.credential
        : await this.secretStore.getKey(provider.id);
      if (!value) continue;
      credentials.push({ name: envKeyName(provider.id), value });
      injectedProviderIds.push(provider.id);
    }
    const mcpCredentials = [...(await this.deps.mcpCredentials?.() ?? [])];
    for (const item of mcpCredentials) {
      if (item.value.trim() !== "") credentials.push(item);
    }
    const env = buildChildEnv({
      parent: process.env,
      ...(grokHome ? { grokHome } : {}),
      credentials,
      memoryEnabled: memoryEnabled(),
      webFetchEnabled: webFetchConfig().enabled,
    });
    return { env, injectedProviderIds, credentialValues: credentials.map((item) => item.value) };
  }

  /** 启动成功后固化本次连接的能力快照；重连或关闭时清掉。 */
  recordLaunchSnapshot(providerIds: readonly string[]): LaunchSnapshot {
    this.snapshot = { providerIds: [...providerIds], modelIds: [...this.lastWrittenModelIds] };
    return this.snapshot;
  }

  get launchSnapshot(): LaunchSnapshot | undefined {
    return this.snapshot;
  }

  clearLaunchSnapshot(): void {
    this.snapshot = undefined;
  }

  /** 启动成功后记录真实画像，隐私状态界面只读这里。 */
  recordProfile(input: {
    target: LaunchTarget;
    grokHome: string;
    configFile: string;
    managed: boolean;
  }): RuntimeModelProfile {
    const host = hostOf(input.target.provider.baseUrl);
    const profile: RuntimeModelProfile = {
      providerId: input.target.provider.id,
      providerName: input.target.provider.displayName,
      modelId: input.target.model.id,
      modelName: input.target.model.displayName,
      baseUrlHost: host,
      protocol: input.target.model.protocol,
      envKeyName: input.target.envKey,
      // 托管关闭时我们无法保证 config.toml 里的开关，画像必须如实反映这一点。
      channels: input.managed ? { ...MANAGED_CHANNELS } : unknownChannels(),
      configFile: input.configFile,
      grokHome: input.grokHome,
      startedAt: this.now(),
    };
    this.profile = profile;
    return profile;
  }

  clearProfile(): void {
    this.profile = undefined;
  }

  /**
   * 录入或更换某个 Provider 的凭据。
   * 用 VS Code 原生 InputBox，不用浏览器 prompt；输入过程按密码处理。
   */
  /**
   * @returns 真正写进 SecretStorage 的 providerId；取消输入或留空保持不变时返回 undefined。
   * 调用方据此决定要不要重启子进程——密钥变了而子进程还活着时，不重启等于继续用旧 Key。
   */
  async configureKey(providerId?: string): Promise<string | undefined> {
    await this.load();
    const providers = this.registry.list();
    if (providers.length === 0) {
      this.deps.post({ type: "notice", level: "warn", message: "还没有可配置的模型服务商。" });
      return undefined;
    }

    const target = providerId
      ? providers.find((provider) => provider.id === providerId)
      : await this.pickProvider(providers);
    if (!target) return undefined;

    const configured = this.secretStore.hasKey(target.id);
    const entered = await vscode.window.showInputBox({
      title: `${target.displayName} API Key`,
      prompt: configured
        ? "已配置。输入新的 Key 将替换现有凭据；留空并确认则保持不变。"
        : `凭据保存在 VS Code SecretStorage，不会写入设置或配置文件。数据将发送至 ${hostOf(target.baseUrl)}。`,
      password: true,
      ignoreFocusOut: true,
    });
    if (entered === undefined) return undefined;
    if (entered.trim() === "") {
      if (!configured) this.deps.post({ type: "notice", level: "warn", message: "未输入内容，凭据未变更。" });
      return undefined;
    }

    await this.secretStore.saveKey(target.id, entered);
    await this.refreshRedaction();
    this.deps.log(`[providers] 已更新 ${target.displayName} 的凭据。`);
    this.deps.post({
      type: "notice",
      level: "info",
      message: `已保存 ${target.displayName} 的 API Key（存于系统凭据库）。`,
    });
    return target.id;
  }

  /** 删除凭据；同时刷新脱敏字面量，避免把已删除的 Key 继续留在内存里。 */
  async deleteKey(providerId: string): Promise<void> {
    await this.secretStore.deleteKey(providerId);
    await this.refreshRedaction();
  }

  /**
   * 从进程环境导入既有的 DeepSeek 凭据。
   *
   * 迁移前它是一个 OS 环境变量，由子进程整包继承。迁移后子进程环境里它会被剥离，
   * 所以必须先搬进 SecretStorage，否则原有会话会直接失去凭据。
   */
  /**
   * 从进程环境导入既有的 DeepSeek 凭据。
   * @param options.force 为 true 时跳过确认（用户已点对话内「导入」按钮）。
   * 默认只发对话内联引导，不弹 VS Code Information toast。
   */
  async importLegacyDeepSeekKey(
    env: NodeJS.ProcessEnv = process.env,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    await this.load();
    if (this.secretStore.hasKey(DEEPSEEK_PROVIDER_ID)) return false;
    const legacy = env.DEEPSEEK_API_KEY?.trim();
    if (!legacy) return false;

    if (!options.force) {
      this.deps.post({
        type: "notice",
        level: "info",
        message: "检测到环境变量 DEEPSEEK_API_KEY。是否导入到系统凭据库，交由灵动 Code 管理？"
          + "导入后子进程不再继承该环境变量。",
        actions: [
          { id: "importLegacyKey", label: "导入" },
          { id: "dismiss", label: "稍后手动配置" },
        ],
      });
      return false;
    }

    await this.secretStore.saveKey(DEEPSEEK_PROVIDER_ID, legacy);
    await this.refreshRedaction();
    this.deps.log("[providers] 已从环境变量导入 DeepSeek 凭据。");
    this.deps.post({
      type: "notice",
      level: "info",
      message: "已导入 DeepSeek 凭据。扩展无权删除系统环境变量，"
        + "你可以自行清理 DEEPSEEK_API_KEY；子进程已不再继承它。",
    });
    return true;
  }

  private async pickProvider(providers: readonly ProviderConfig[]): Promise<ProviderConfig | undefined> {
    const items = providers.map((provider) => ({
      label: provider.displayName,
      description: this.secretStore.hasKey(provider.id) ? "已配置" : "未配置",
      detail: hostOf(provider.baseUrl),
      provider,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: "配置模型服务商密钥",
      placeHolder: "选择要填写或更换 API Key 的服务商",
    });
    return picked?.provider;
  }
}

export function managedHomeEnabled(): boolean {
  return vscode.workspace.getConfiguration("lingdongAgent").get<boolean>("managedGrokHome", true) !== false;
}

/**
 * 改完自动校验的总开关。默认开：Agent 把类型错误留给用户发现是当前最大的短板之一。
 * 校验只跑项目自己声明过的脚本（typecheck / lint），不会发明命令。
 */
export function verifyAfterEditEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("lingdongAgent")
    .get<boolean>("verifyAfterEdit", true) !== false;
}

/**
 * 跨会话记忆开关。默认关：它会把对话里的结论长期写到磁盘，
 * 属于必须用户自己点头的那类能力，Grok 官方也把它标为实验性。
 */
export function memoryEnabled(): boolean {
  return vscode.workspace.getConfiguration("lingdongAgent").get<boolean>("memory", false) === true;
}

/**
 * web_fetch 抓取网页开关。默认关：抓取任意 URL 属于要用户显式点头的能力。
 * 域名白名单为抓取出口边界，留空则启用后沿用 Grok 内置默认白名单。
 */
export function webFetchConfig(): { enabled: boolean; allowedDomains: string[] } {
  const config = vscode.workspace.getConfiguration("lingdongAgent");
  const enabled = config.get<boolean>("webFetch", false) === true;
  const raw = config.get<string[]>("webFetchDomains", []);
  const allowedDomains = Array.isArray(raw)
    ? Array.from(new Set(
        raw
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
          .filter((item) => item.length > 0 && item.length <= 253 && !item.includes(" ")),
      ))
    : [];
  return { enabled, allowedDomains };
}

/**
 * 要不要在思考块里给出模型推理原文。默认开：对标 Cursor 的可展开推理链，
 * 而且模型想几十秒时用户总得看得见它在想什么。原文任何情况下都不落盘。
 */
export function showReasoningEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("lingdongAgent")
    .get<boolean>("showReasoning", true) !== false;
}

/**
 * 计划步骤由宿主逐步下发。默认开：靠提示词里一句「逐步完成」约束不住模型，
 * 它要么一口气做完十步，要么做完第一步就宣布收工。
 */
export function planStepGatingEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("lingdongAgent")
    .get<boolean>("planStepGating", true) !== false;
}

const EDIT_PREVIEW_MODES: readonly EditPreviewMode[] = ["diff", "reveal", "off"];

/**
 * 边写边看的力度。
 *
 * 默认 off。实测一轮改九个文件，自动开标签把用户正在看的文件反复顶掉，
 * 观感是「它乱开我的文件」而不是「它让我看见改动」。Cursor 也不为每次编辑开标签。
 * 想要的人可以调到 diff / reveal。
 */
export function editPreviewMode(): EditPreviewMode {
  const configured = vscode.workspace
    .getConfiguration("lingdongAgent")
    .get<string>("streamEditPreview", "off");
  return EDIT_PREVIEW_MODES.includes(configured as EditPreviewMode)
    ? (configured as EditPreviewMode)
    : "off";
}

/** 本地转发层的总开关。默认开；出问题时关掉就是原来的直连行为。 */
export function responseSanitizingEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("lingdongAgent")
    .get<boolean>("sanitizeUpstreamResponses", true) !== false;
}

/** 只取域名用于展示与画像；完整地址里的 path 不进日志。 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 托管关闭时各通道状态未知，如实标记为开启而不是假装关闭。 */
function unknownChannels(): RuntimeModelProfile["channels"] {
  return {
    telemetry: true,
    traceUpload: true,
    mixpanel: true,
    externalOtel: true,
    feedback: true,
    autoUpdate: true,
    remoteFetch: true,
    // 托管关闭时不注入 GROK_WEB_FETCH，实际取决于用户自己的环境与 config.toml；
    // 状态未知就从严记为开启。
    webFetch: true,
  };
}
