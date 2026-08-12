/**
 * 模型中心的宿主侧编排。
 *
 * 所有 Provider 变更与 HTTP 测试都从这里走：设置面板只发消息、不碰存储，
 * 底层一律复用 G-R7a 的 ProviderService / ProviderRegistry / ProviderSecretStore，
 * 不在这里另建第二套注册表或凭据系统。
 */

import * as vscode from "vscode";
import {
  protocolDisplayName,
  type CustomProviderDraft,
  type ModelSettingsHostMessage,
  type ModelSettingsWebviewMessage,
  type SettingsBalanceView,
  type SettingsBuiltinTemplateView,
  type SettingsCatalogView,
  type SettingsModelView,
  type SettingsProviderView,
  type SettingsTestResultView,
  type SettingsTestStepView,
} from "../model-settings-messages";
import type { CatalogCache } from "../models/providers/catalog-cache";
import { describeProviderError } from "../models/providers/provider-error-mapper";
import { ProviderHttpClient, type HttpTransport } from "../models/providers/provider-http-client";
import {
  CONCLUSION_TEXT,
  ProviderTestService,
  protocolLabel,
  runFullTest,
  toTestableProtocol,
  type FullTestOutcome,
  type TestableProtocol,
} from "../models/providers/provider-test-service";
import {
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  apiModelIdOf,
  builtinProviderTemplate,
  isModelVerified,
  localModelId,
  secretIdFor,
  type ProviderConfig,
  type ProviderModelConfig,
} from "../models/providers/provider-types";
import { preferredProtocol, supportsImageInput } from "../models/providers/poe-catalog";
import { describeDataDestination, validateBaseUrl } from "../models/providers/provider-validator";
import type { SessionRecord } from "../storage/session-repository";
import { PoeCatalogService } from "./poe-catalog-service";
import { hostOf, type ProviderService } from "./provider-service";

export interface ModelSettingsServiceDeps {
  providers: ProviderService;
  log(line: string): void;
  /** 模型清单变化后需要重投影，让 Composer 与 config.toml 跟上。 */
  onProvidersChanged(): Promise<void>;
  /**
   * 某个 Provider 的密钥变了（保存或删除）。
   *
   * 子进程环境变量在启动时一次性注入，SecretStorage 改了它不会跟着变。
   * 若这个 Provider 的密钥已经装进当前连接，必须重启子进程，
   * 否则后续请求还会带着旧 Key 去撞 401——用户刚填好新 Key，却一直用不了。
   */
  onCredentialChanged(providerId: string): Promise<void>;
  /** 当前会话正在使用的模型，用于界面标注。 */
  activeModelId(): string | undefined;
  /** 查询哪些会话在用某个模型，用于删除确认。 */
  sessionsUsingModel(modelId: string): Promise<SessionRecord[]>;
  /** 模型目录的本地缓存；只存公开目录，不存凭据。 */
  catalog: CatalogCache;
  transport?: HttpTransport;
  now?: () => number;
}

const BUILTIN_PROVIDER_IDS: readonly string[] = ["deepseek"];

/** 一键添加的内置模板在首页的说明文案。 */
const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  poe: "一个 Key 访问 Poe 上的多家模型。添加后填写 API Key 即可同步模型目录。",
};

export class ModelSettingsService {
  private readonly http: ProviderHttpClient;
  private readonly tests: ProviderTestService;
  private readonly now: () => number;
  private readonly poe: PoeCatalogService;
  private poster: ((message: ModelSettingsHostMessage) => void) | undefined;

  constructor(private readonly deps: ModelSettingsServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.http = new ProviderHttpClient({
      ...(deps.transport ? { transport: deps.transport } : {}),
      log: deps.log,
      now: this.now,
    });
    this.tests = new ProviderTestService({ http: this.http });
    this.poe = new PoeCatalogService({
      http: this.http,
      cache: deps.catalog,
      log: deps.log,
      now: this.now,
    });
  }

  /** 面板打开时接上，关闭时断开；服务本身不持有面板生命周期。 */
  setPoster(poster: ((message: ModelSettingsHostMessage) => void) | undefined): void {
    this.poster = poster;
  }

  private post(message: ModelSettingsHostMessage): void {
    this.poster?.(message);
  }

  async handle(message: ModelSettingsWebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
      case "refresh":
        await this.publish();
        return;
      case "saveKey":
        await this.saveKey(message.providerId, message.key);
        return;
      case "deleteKey":
        await this.deleteKey(message.providerId);
        return;
      case "setProviderEnabled":
        await this.setProviderEnabled(message.providerId, message.enabled);
        return;
      case "deleteProvider":
        await this.deleteProvider(message.providerId);
        return;
      case "addBuiltinProvider":
        await this.addBuiltinProvider(message.providerId);
        return;
      case "addCustomProvider":
        await this.addCustomProvider(message.draft);
        return;
      case "syncCatalog":
        await this.syncCatalog(message.providerId, message.force);
        return;
      case "checkBalance":
        await this.checkBalance(message.providerId);
        return;
      case "addModel":
        await this.addModel(message.providerId, message.remoteModelId, message.protocol, message.displayName);
        return;
      case "testModel":
        await this.testModel(message.providerId, message.modelId, message.protocol);
        return;
      case "setModelEnabled":
        await this.setModelEnabled(message.providerId, message.modelId, message.enabled);
        return;
      case "setModelVision":
        await this.setModelVision(message.providerId, message.modelId, message.vision);
        return;
      case "renameModel":
        await this.renameModel(message.providerId, message.modelId, message.displayName);
        return;
      case "deleteModel":
        await this.deleteModel(message.providerId, message.modelId);
        return;
      case "openPrivacyStatus":
        await vscode.commands.executeCommand("lingdongAgent.showPrivacyStatus");
        return;
      case "backToAgent":
        // 面板层已拦截；这里兜底一次，避免协议漏网。
        await vscode.commands.executeCommand("lingdongAgent.backToAgent");
        return;
    }
  }

  /** 推送 Provider 列表；视图里只有状态，没有 Key 的任何内容。 */
  async publish(): Promise<void> {
    await this.deps.providers.load();
    const providers = this.deps.providers.registry.list().map((provider) => this.toView(provider));
    const active = this.deps.activeModelId();
    this.post({
      type: "providers",
      providers,
      ...(active ? { activeModelId: active } : {}),
      availableBuiltins: this.availableBuiltins(),
    });
  }

  private toView(provider: ProviderConfig): SettingsProviderView {
    const models = provider.models.map((model) => this.toModelView(model));
    const tested = models
      .map((model) => model.testedAt)
      .filter((value): value is number => typeof value === "number");
    return {
      id: provider.id,
      type: provider.type,
      displayName: provider.displayName,
      host: hostOf(provider.baseUrl),
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      enabled: provider.enabled,
      keyConfigured: this.deps.providers.secretStore.hasKey(provider.id),
      modelCount: provider.models.length,
      ...(tested.length > 0 ? { lastTestedAt: Math.max(...tested) } : {}),
      builtin: BUILTIN_PROVIDER_IDS.includes(provider.id),
      models,
    };
  }

  private toModelView(model: ProviderModelConfig): SettingsModelView {
    return {
      id: model.id,
      displayName: model.displayName,
      remoteModelId: apiModelIdOf(model),
      enabled: model.enabled,
      protocol: model.protocol,
      protocolLabel: protocolDisplayName(model.protocol),
      verified: isModelVerified(model),
      agentCompatible: model.capabilities.agentCompatible,
      supportsStreaming: model.capabilities.streaming,
      supportsTools: model.capabilities.toolCalling,
      supportsVision: model.capabilities.vision,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.testedAt !== undefined ? { testedAt: model.testedAt } : {}),
    };
  }


  /**
   * 还没添加的内置服务商。
   *
   * 刻意不在注册表里播种：播种会让每个既有安装凭空多出一个没配凭据的条目。
   * 用户在首页点一下才写入固定配置，语义是「我要用它」，而不是「它一直都在」。
   */
  private availableBuiltins(): SettingsBuiltinTemplateView[] {
    const existing = new Set(this.deps.providers.registry.list().map((provider) => provider.id));
    const result: SettingsBuiltinTemplateView[] = [];
    for (const id of BUILTIN_PROVIDER_TEMPLATE_IDS) {
      if (existing.has(id)) continue;
      const template = builtinProviderTemplate(id);
      if (!template) continue;
      result.push({
        id: template.id,
        displayName: template.displayName,
        host: hostOf(template.baseUrl),
        description: TEMPLATE_DESCRIPTIONS[id] ?? "",
      });
    }
    return result;
  }

  /**
   * 一键添加内置服务商。
   *
   * 地址与协议来自代码里的固定模板，不接受界面传入，所以不需要 validateBaseUrl
   * 那一套确认流程。与自定义服务商同样先不启用：首个模型测通之后才由 applyOutcome 启用。
   */
  private async addBuiltinProvider(providerId: string): Promise<void> {
    await this.deps.providers.load();
    const template = builtinProviderTemplate(providerId);
    if (!template) {
      this.post({ type: "error", message: "这不是一个可添加的内置服务商。" });
      return;
    }
    if (this.deps.providers.registry.get(providerId)) {
      this.post({ type: "notice", level: "warn", message: `${template.displayName} 已经添加过了。` });
      return;
    }

    await this.deps.providers.registry.upsertProvider(template);
    this.deps.log(`[model-settings] 已添加内置服务商 ${template.displayName}（${hostOf(template.baseUrl)}）`);
    this.post({
      type: "notice",
      level: "info",
      message: `已添加 ${template.displayName}，请填写 API Key 后同步模型目录。`,
    });
    await this.afterChange();
  }

  /** 同步模型目录；命中未过期缓存时一个请求都不发。 */
  private async syncCatalog(providerId: string, force: boolean): Promise<void> {
    await this.deps.providers.load();
    const provider = this.deps.providers.registry.get(providerId);
    if (!provider) {
      this.post({ type: "error", message: "找不到该服务商，可能已被删除。" });
      return;
    }

    const credential = await this.deps.providers.secretStore.getKey(providerId);
    this.post({ type: "busy", busy: true, label: `正在同步 ${provider.displayName} 的模型目录` });
    try {
      const outcome = await this.poe.sync({ provider, credential, force });
      // 失败时若还有旧缓存就照常渲染，只是配一条错误说明；不把用户刚看过的列表清空。
      if (outcome.view) this.post({ type: "catalog", catalog: outcome.view });
      if (!outcome.ok) this.post({ type: "error", message: outcome.message });
      if (outcome.ok) await this.calibrateVision(providerId);
    } finally {
      this.post({ type: "busy", busy: false });
    }
  }

  /**
   * 用目录缓存校准所有已添加模型的 `vision`，不发任何请求。
   *
   * 启动时调一次。能力位是「添加模型那一刻」写死的，而「这个模型收不收图」是服务商的
   * 声明，会随目录变；不校准的话，早于目录数据添加的模型会永远停在 `vision: false`，
   * 用户明明挂着能看图的模型，粘贴图片却被告知不支持。
   */
  async calibrateVisionFromCatalog(): Promise<void> {
    await this.deps.providers.load();
    for (const provider of this.deps.providers.registry.list()) {
      await this.calibrateVision(provider.id);
    }
  }

  /** 只动 vision：其余能力是本地实测出来的，目录说了不算。 */
  private async calibrateVision(providerId: string): Promise<void> {
    const provider = this.deps.providers.registry.get(providerId);
    if (!provider || provider.models.length === 0) return;
    const entries = await this.poe.cachedEntries(providerId);
    if (entries.length === 0) return;

    const changed: string[] = [];
    for (const model of provider.models) {
      // 用户手动声明过的不碰：目录没声明模态不等于模型不收图，
      // 覆盖回去会表现成「开关自己关了」。
      if (model.visionManual) continue;
      const remoteId = model.remoteModelId ?? model.id;
      const entry = entries.find((candidate) => candidate.id === remoteId);
      if (!entry) continue;
      const vision = supportsImageInput(entry);
      if (vision === model.capabilities.vision) continue;
      await this.deps.providers.registry.upsertModel(providerId, {
        ...model,
        capabilities: { ...model.capabilities, vision },
      });
      changed.push(`${model.displayName} 图片输入${vision ? "已开启" : "已关闭"}`);
    }
    if (changed.length === 0) return;

    this.deps.log(`[model-settings] 按目录校准能力：${changed.join("、")}`);
    await this.afterChange();
  }

  /** 查询积分余额；只在用户点击时发起，短时缓存由 PoeCatalogService 负责。 */
  private async checkBalance(providerId: string): Promise<void> {
    await this.deps.providers.load();
    const provider = this.deps.providers.registry.get(providerId);
    if (!provider) {
      this.post({ type: "error", message: "找不到该服务商，可能已被删除。" });
      return;
    }

    const credential = await this.deps.providers.secretStore.getKey(providerId);
    this.post({ type: "busy", busy: true, label: "正在查询余额" });
    try {
      const outcome = await this.poe.balance({ provider, credential });
      if (outcome.ok) this.post({ type: "balance", balance: outcome.view });
      else this.post({ type: "error", message: outcome.message });
    } finally {
      this.post({ type: "busy", busy: false });
    }
  }

  // -------------------------------------------------------------------------
  // 凭据
  // -------------------------------------------------------------------------

  private async saveKey(providerId: string, key: string): Promise<void> {
    await this.deps.providers.load();
    const provider = this.deps.providers.registry.get(providerId);
    if (!provider) {
      this.post({ type: "error", message: "找不到该服务商，可能已被删除。" });
      return;
    }
    await this.deps.providers.secretStore.saveKey(providerId, key);
    await this.deps.providers.refreshRedaction();
    this.deps.log(`[model-settings] 已更新 ${provider.displayName} 的凭据`);
    // 只回状态，不回内容：设置页拿不到、也无从索取 Key 本身。
    this.post({ type: "keySaved", providerId, configured: true });
    await this.afterChange();
    // 密钥变了必须单独通知：afterChange 故意不重启子进程（改别家配置不该打断当前任务），
    // 但当前连接里装的就是这份密钥时，不重启等于继续拿旧 Key 去撞 401。
    await this.deps.onCredentialChanged(providerId);
  }

  private async deleteKey(providerId: string): Promise<void> {
    await this.deps.providers.deleteKey(providerId);
    this.deps.log(`[model-settings] 已删除 ${providerId} 的凭据`);
    await this.afterChange();
    await this.deps.onCredentialChanged(providerId);
  }

  // -------------------------------------------------------------------------
  // Provider
  // -------------------------------------------------------------------------

  private async setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
    await this.deps.providers.load();
    if (!await this.deps.providers.registry.setProviderEnabled(providerId, enabled)) {
      this.post({ type: "error", message: "找不到该服务商，可能已被删除。" });
      return;
    }
    await this.afterChange();
  }

  /**
   * 删除 Provider：连同凭据一起删，但不动会话。
   * 会话恢复时由 ProviderService.resolveLaunch 给出明确的不可用提示。
   */
  private async deleteProvider(providerId: string): Promise<void> {
    await this.deps.providers.load();
    const provider = this.deps.providers.registry.get(providerId);
    if (!provider) return;
    if (BUILTIN_PROVIDER_IDS.includes(providerId)) {
      this.post({
        type: "error",
        message: `${provider.displayName} 是内置服务商，不能删除；如需停用请改用禁用。`,
      });
      return;
    }

    const affected = await this.collectAffectedSessions(provider.models.map((model) => model.id));
    const confirm = await vscode.window.showWarningMessage(
      affected > 0
        ? `即将删除「${provider.displayName}」，连同它的 ${provider.models.length} 个模型与已保存的 API Key。`
          + `有 ${affected} 个会话正在使用这些模型，删除后需要重新选择模型。`
        : `即将删除「${provider.displayName}」，连同已保存的 API Key。`,
      { modal: true },
      "确认删除",
    );
    if (confirm !== "确认删除") return;

    await this.deps.providers.registry.removeProvider(providerId);
    await this.deps.providers.deleteKey(providerId);
    await this.deleteCatalogCache(providerId);
    this.deps.log(`[model-settings] 已删除服务商 ${provider.displayName} 与其凭据`);
    this.post({
      type: "notice",
      level: "info",
      message: `已删除 ${provider.displayName}，会话记录保持不变。`,
    });
    await this.afterChange();
    await this.deps.onCredentialChanged(providerId);
  }

  /** 删除 Provider 时连带清掉目录缓存与内存里的余额。 */
  private async deleteCatalogCache(providerId: string): Promise<void> {
    await this.poe.forget(providerId);
  }

  private async addCustomProvider(draft: CustomProviderDraft): Promise<void> {
    await this.deps.providers.load();

    const url = validateBaseUrl(draft.baseUrl);
    if (!url.ok) {
      this.post({ type: "error", message: url.message });
      return;
    }

    // 保存之前必须让用户看清数据会发往哪个域名。
    const confirm = await vscode.window.showWarningMessage(
      describeDataDestination(url.host),
      { modal: true },
      "确认添加",
    );
    if (confirm !== "确认添加") return;

    const providerId = this.uniqueProviderId(draft.displayName);
    const modelId = localModelId(providerId, draft.remoteModelId);
    const provider: ProviderConfig = {
      id: providerId,
      type: "custom-openai-compatible",
      displayName: draft.displayName,
      baseUrl: url.normalized,
      protocol: draft.protocol,
      // 没通过测试之前不启用，避免未验证的地址直接出现在 Composer 里。
      enabled: false,
      secretId: secretIdFor(providerId),
      models: [{
        id: modelId,
        remoteModelId: draft.remoteModelId,
        displayName: draft.modelDisplayName ?? draft.remoteModelId,
        enabled: true,
        protocol: draft.protocol,
        verified: false,
        capabilities: {
          streaming: true,
          toolCalling: false,
          reasoning: false,
          vision: false,
          agentCompatible: false,
        },
        ...(draft.contextWindow !== undefined ? { contextWindow: draft.contextWindow } : {}),
      }],
    };

    await this.deps.providers.registry.upsertProvider(provider);
    this.deps.log(`[model-settings] 已添加自定义服务商 ${draft.displayName}（${url.host}）`);
    this.post({
      type: "notice",
      level: "info",
      message: `已添加 ${draft.displayName}，请填写 API Key 并完成连接测试后再启用。`,
    });
    await this.afterChange();
  }

  private uniqueProviderId(displayName: string): string {
    const base = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "custom";
    const taken = new Set(this.deps.providers.registry.list().map((provider) => provider.id));
    if (!taken.has(base)) return base;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base}-${index}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${this.now()}`;
  }

  // -------------------------------------------------------------------------
  // 模型
  // -------------------------------------------------------------------------

  private async addModel(
    providerId: string,
    remoteModelId: string,
    protocol: TestableProtocol,
    displayName?: string,
  ): Promise<void> {
    await this.deps.providers.load();
    const provider = this.deps.providers.registry.get(providerId);
    if (!provider) {
      this.post({ type: "error", message: "找不到该服务商，可能已被删除。" });
      return;
    }
    const entry = await this.poe.entryFor(providerId, remoteModelId);
    // 目录声明了协议就以目录为准，界面选择只在服务商没声明时兜底。
    const initialProtocol = (entry ? preferredProtocol(entry) : undefined) ?? protocol;
    const modelId = localModelId(providerId, remoteModelId);
    if (provider.models.some((model) => model.id === modelId)) {
      this.post({ type: "notice", level: "warn", message: `${remoteModelId} 已经添加过了。` });
      return;
    }

    await this.deps.providers.registry.upsertModel(providerId, {
      id: modelId,
      remoteModelId,
      displayName: displayName ?? remoteModelId,
      enabled: true,
      protocol: initialProtocol,
      // 能力一律默认关闭：没检测过就不该声称支持 Agent，
      // 更不能因为名字里有 Claude / GPT / Gemini 就自动放行。
      verified: false,
      capabilities: {
        streaming: true,
        toolCalling: false,
        reasoning: false,
        // vision 是唯一例外：它不影响能不能跑 Agent，只决定粘贴图片放不放行，
        // 而服务商的 input_modalities 本来就是用来声明「我收什么」的，判错也只是发出去被拒。
        vision: entry ? supportsImageInput(entry) : false,
        agentCompatible: false,
      },
    });
    this.deps.log(`[model-settings] 已添加模型 ${modelId}，开始连接测试`);
    await this.afterChange();
    // 新模型立刻测一次，用户不用再点一下才知道能不能用。
    await this.testModel(providerId, modelId, initialProtocol);
  }

  /**
   * 单个模型的三步测试。
   *
   * 协议候选刻意不自动串联：Responses 失败时界面显示「尝试兼容协议」，
   * 用户点了才带着 chat_completions 再进来一次。
   */
  private async testModel(
    providerId: string,
    modelId: string,
    protocolOverride?: TestableProtocol,
  ): Promise<void> {
    await this.deps.providers.load();
    const provider = this.deps.providers.registry.get(providerId);
    const model = provider?.models.find((candidate) => candidate.id === modelId);
    if (!provider || !model) {
      this.post({ type: "error", message: "找不到该模型，可能已被删除。" });
      return;
    }

    const credential = await this.deps.providers.secretStore.getKey(providerId);
    if (!credential) {
      this.post({
        type: "error",
        message: `${provider.displayName} 还没有配置 API Key，请先填写后再测试。`,
      });
      return;
    }

    const protocol = protocolOverride ?? toTestableProtocol(model.protocol);
    this.post({ type: "busy", busy: true, label: `正在测试 ${model.displayName}` });
    try {
      const outcome = await runFullTest(this.tests, {
        provider,
        apiModelId: apiModelIdOf(model),
        protocol,
        credential,
      });
      await this.applyOutcome(provider, model, outcome);
      this.post({ type: "testResult", result: this.toResultView(provider, model, outcome) });
    } finally {
      this.post({ type: "busy", busy: false });
    }
  }

  /**
   * 把测试结论写回模型配置。
   *
   * 只有连接测试通过才置 verified；agentCompatible 完全取决于能力检测，
   * 不做任何推断。没通过的模型仍留在列表里，只是 Composer 不展示。
   */
  private async applyOutcome(
    provider: ProviderConfig,
    model: ProviderModelConfig,
    outcome: FullTestOutcome,
  ): Promise<void> {
    const agentCompatible = outcome.probe?.verdict.agentCompatible === true;
    const next: ProviderModelConfig = {
      ...model,
      protocol: outcome.protocol,
      verified: outcome.savable,
      capabilities: {
        ...model.capabilities,
        streaming: outcome.streaming?.ok ?? model.capabilities.streaming,
        toolCalling: agentCompatible,
        agentCompatible,
      },
      ...(outcome.savable ? { testedAt: this.now() } : {}),
    };
    await this.deps.providers.registry.upsertModel(provider.id, next);

    // 首个模型验证通过后再启用 Provider，让「已启用」始终代表真的能用。
    if (outcome.savable && !provider.enabled) {
      await this.deps.providers.registry.setProviderEnabled(provider.id, true);
    }
    await this.afterChange();
  }

  private toResultView(
    provider: ProviderConfig,
    model: ProviderModelConfig,
    outcome: FullTestOutcome,
  ): SettingsTestResultView {
    const steps: SettingsTestStepView[] = [];
    steps.push({
      name: "connection",
      status: outcome.connection.ok ? "ok" : "failed",
      detail: outcome.connection.ok
        ? `通过${outcome.connection.sample ? `，回复：${outcome.connection.sample}` : ""}`
        : describeProviderError(outcome.connection.error, {
          providerName: provider.displayName,
          modelName: model.displayName,
        }),
    });
    steps.push({
      name: "streaming",
      status: outcome.streaming === undefined ? "skipped" : outcome.streaming.ok ? "ok" : "failed",
      detail: outcome.streaming === undefined
        ? "连接失败，未执行。"
        : outcome.streaming.ok
          ? "收到流式事件。"
          : outcome.streaming.error.reason,
    });
    steps.push({
      name: "capability",
      status: outcome.probe === undefined ? "skipped" : outcome.probe.ok ? "ok" : "failed",
      detail: outcome.probe === undefined
        ? "连接失败，未执行。"
        : outcome.probe.verdict.agentCompatible
          ? "工具调用与参数校验均通过。"
          : outcome.probe.verdict.detail,
    });

    return {
      providerId: provider.id,
      modelId: model.id,
      conclusion: outcome.conclusion,
      conclusionLabel: CONCLUSION_TEXT[outcome.conclusion],
      protocol: outcome.protocol,
      protocolLabel: protocolLabel(outcome.protocol),
      steps,
      agentCompatible: outcome.probe?.verdict.agentCompatible === true,
      canTryFallback: outcome.canTryFallback,
      savable: outcome.savable,
    };
  }

  private async setModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<void> {
    await this.deps.providers.load();
    if (!await this.deps.providers.registry.setModelEnabled(providerId, modelId, enabled)) {
      this.post({ type: "error", message: "找不到该模型，可能已被删除。" });
      return;
    }
    await this.afterChange();
  }

  /**
   * 手动声明这个模型收不收图片。
   *
   * 之所以要留这个开关：`vision` 的自动来源只有目录里的 `architecture.input_modalities`，
   * 那是 OpenRouter / Poe 那一系的扩展字段。走标准 OpenAI 兼容接口接进来的服务商，
   * `/models` 只返回 id 那几样，能力位就永远停在 false —— 模型明明能看图，
   * 粘贴却被输入框挡下来，而用户没有任何办法纠正。
   *
   * 只开放 vision 一项：它判错的代价仅仅是请求被服务商拒掉，
   * 而 agentCompatible 之类是本地实测出来的结论，不能由用户口头声明覆盖。
   */
  private async setModelVision(providerId: string, modelId: string, vision: boolean): Promise<void> {
    await this.deps.providers.load();
    const model = this.deps.providers.registry.get(providerId)?.models
      .find((candidate) => candidate.id === modelId);
    if (!model) {
      this.post({ type: "error", message: "找不到该模型，可能已被删除。" });
      return;
    }
    if (model.capabilities.vision === vision && model.visionManual === true) return;
    await this.deps.providers.registry.upsertModel(providerId, {
      ...model,
      capabilities: { ...model.capabilities, vision },
      visionManual: true,
    });
    this.deps.log(`[model-settings] ${model.displayName} 图片输入${vision ? "已开启" : "已关闭"}（手动）`);
    await this.afterChange();
  }

  private async renameModel(providerId: string, modelId: string, displayName: string): Promise<void> {
    await this.deps.providers.load();
    const model = this.deps.providers.registry.get(providerId)?.models
      .find((candidate) => candidate.id === modelId);
    if (!model) {
      this.post({ type: "error", message: "找不到该模型，可能已被删除。" });
      return;
    }
    await this.deps.providers.registry.upsertModel(providerId, { ...model, displayName });
    await this.afterChange();
  }

  /** 删除模型前先查会话引用，让用户知道影响范围再决定。 */
  private async deleteModel(providerId: string, modelId: string): Promise<void> {
    await this.deps.providers.load();
    const provider = this.deps.providers.registry.get(providerId);
    const model = provider?.models.find((candidate) => candidate.id === modelId);
    if (!provider || !model) return;

    const affected = await this.deps.sessionsUsingModel(modelId);
    if (affected.length > 0) {
      const confirm = await vscode.window.showWarningMessage(
        `有 ${affected.length} 个会话正在使用此模型。删除后，这些会话需要重新选择模型。`,
        { modal: true },
        "仍然删除",
      );
      if (confirm !== "仍然删除") return;
    }

    await this.deps.providers.registry.removeModel(providerId, modelId);
    this.deps.log(`[model-settings] 已删除模型 ${modelId}，会话记录保持不变`);
    await this.afterChange();
  }

  private async collectAffectedSessions(modelIds: readonly string[]): Promise<number> {
    const seen = new Set<string>();
    for (const modelId of modelIds) {
      for (const record of await this.deps.sessionsUsingModel(modelId)) seen.add(record.id);
    }
    return seen.size;
  }

  /** 每次 Provider 变更都重写 config.toml 并刷新界面，避免两边不一致。 */
  private async afterChange(): Promise<void> {
    await this.deps.onProvidersChanged();
    await this.publish();
  }
}
