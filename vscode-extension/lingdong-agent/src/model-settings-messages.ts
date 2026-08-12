/**
 * 模型设置面板的消息协议。
 *
 * 刻意**不复用**聊天面板的 WebviewToHostMessage：分成两套联合类型之后，
 * 设置页在类型层面发不出 `sendPrompt`，聊天页也发不出 `saveProviderKey`。
 * 边界靠类型维持，而不是靠「记得别这么写」。
 *
 * 出站方向永远不含真实 Key。能表达凭据状态的字段只有 `keyConfigured: boolean`，
 * 保存成功也只回 `{ configured: true }`，所以「界面拿不到 Key」是协议本身的性质。
 */

import {
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  isProviderProtocol,
  isRemoteModelId,
  type ProviderProtocol,
  type ProviderType,
} from "./models/providers/provider-types";
import type { TestConclusion, TestableProtocol } from "./models/providers/provider-test-service";

// ---------------------------------------------------------------------------
// 出站视图
// ---------------------------------------------------------------------------

export interface SettingsModelView {
  id: string;
  displayName: string;
  /** 真正发给服务商的模型名，展示用。 */
  remoteModelId: string;
  enabled: boolean;
  protocol: ProviderProtocol;
  protocolLabel: string;
  verified: boolean;
  agentCompatible: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow?: number;
  testedAt?: number;
}

export interface SettingsProviderView {
  id: string;
  type: ProviderType;
  displayName: string;
  /** 只给域名，不给完整地址里的路径与查询串。 */
  host: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  /** 只表达「有没有配」，不表达 Key 的任何内容。 */
  keyConfigured: boolean;
  modelCount: number;
  lastTestedAt?: number;
  /** 内置 Provider 不允许改地址，也不允许删除。 */
  builtin: boolean;
  models: SettingsModelView[];
}

export interface SettingsTestStepView {
  name: "connection" | "streaming" | "capability";
  status: "ok" | "failed" | "skipped";
  detail: string;
}

export interface SettingsTestResultView {
  providerId: string;
  modelId?: string;
  conclusion: TestConclusion;
  conclusionLabel: string;
  protocol: TestableProtocol;
  protocolLabel: string;
  steps: SettingsTestStepView[];
  agentCompatible: boolean;
  canTryFallback: boolean;
  savable: boolean;
}

/** 尚未添加的内置服务商，首页给一张一键添加的卡片。 */
export interface SettingsBuiltinTemplateView {
  id: string;
  displayName: string;
  host: string;
  description: string;
}

/**
 * 目录里的一条模型。
 *
 * `features` 只是服务商自己声明的标签，用来提示与筛选；
 * **能不能进 Agent 一律以本地能力检测为准**，视图里刻意不带 agentCompatible。
 */
export interface SettingsCatalogEntryView {
  remoteModelId: string;
  displayName: string;
  vendor: string;
  description?: string;
  protocols: TestableProtocol[];
  features: string[];
  contextWindow?: number;
  /** 已经添加到该 Provider 下；界面显示徽标而不是按钮。 */
  added: boolean;
}

export interface SettingsCatalogView {
  providerId: string;
  entries: SettingsCatalogEntryView[];
  syncedAt?: number;
  /** 本次内容来自本地缓存而不是刚拉的网络响应。 */
  fromCache: boolean;
  /** 解析时跳过的异常条目数；有值时界面如实说明。 */
  skipped: number;
}

export interface SettingsBalanceView {
  providerId: string;
  /** 已经组装好的展示文案；宿主不把原始响应交给界面。 */
  label: string;
  checkedAt: number;
}

export type ModelSettingsHostMessage =
  | {
    type: "providers";
    providers: SettingsProviderView[];
    activeModelId?: string;
    availableBuiltins: SettingsBuiltinTemplateView[];
  }
  | { type: "catalog"; catalog: SettingsCatalogView }
  | { type: "balance"; balance: SettingsBalanceView }
  | { type: "busy"; busy: boolean; label?: string }
  | { type: "keySaved"; providerId: string; configured: true }
  | { type: "testResult"; result: SettingsTestResultView }
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// 入站消息
// ---------------------------------------------------------------------------

export interface CustomProviderDraft {
  displayName: string;
  baseUrl: string;
  protocol: TestableProtocol;
  remoteModelId: string;
  modelDisplayName?: string;
  contextWindow?: number;
}

export type ModelSettingsWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "saveKey"; providerId: string; key: string }
  | { type: "deleteKey"; providerId: string }
  | { type: "setProviderEnabled"; providerId: string; enabled: boolean }
  | { type: "deleteProvider"; providerId: string }
  | { type: "addBuiltinProvider"; providerId: string }
  | { type: "addCustomProvider"; draft: CustomProviderDraft }
  | { type: "syncCatalog"; providerId: string; force: boolean }
  | { type: "checkBalance"; providerId: string }
  | { type: "addModel"; providerId: string; remoteModelId: string; displayName?: string; protocol: TestableProtocol }
  | { type: "testModel"; providerId: string; modelId: string; protocol?: TestableProtocol }
  | { type: "setModelEnabled"; providerId: string; modelId: string; enabled: boolean }
  | { type: "setModelVision"; providerId: string; modelId: string; vision: boolean }
  | { type: "renameModel"; providerId: string; modelId: string; displayName: string }
  | { type: "deleteModel"; providerId: string; modelId: string }
  | { type: "openPrivacyStatus" }
  | { type: "backToAgent" };

const MAX_ID = 128;
const MAX_DISPLAY_NAME = 64;
const MAX_BASE_URL = 2_048;
const MAX_KEY = 512;
const MAX_CONTEXT_WINDOW = 100_000_000;

/** Provider 与模型标识：不许斜杠、空格与路径形态。 */
const ID_PATTERN = /^[A-Za-z0-9._:+-]{1,128}$/;


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ID && ID_PATTERN.test(trimmed)
    ? trimmed
    : undefined;
}

function remoteId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // 判定放在 provider-types，目录解析用的是同一个函数。
  return trimmed.length > 0 && trimmed.length <= MAX_ID && isRemoteModelId(trimmed)
    ? trimmed
    : undefined;
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // 控制字符会破坏 TOML 与界面渲染，直接剔掉而不是拒绝整条消息。
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/[\u0000-\u001f]/g, "").trim();
  return trimmed.length > 0 && trimmed.length <= MAX_DISPLAY_NAME ? trimmed : undefined;
}

function testableProtocol(value: unknown): TestableProtocol | undefined {
  if (value === "responses" || value === "chat_completions") return value;
  return undefined;
}

/**
 * 校验来自设置面板的消息。
 *
 * 与聊天面板同样的态度：Webview 不受信任，结构、类型、长度全部显式检查，
 * 失败一律丢弃，绝不透传未知字段。这里额外注意两点：
 * - `baseUrl` 只做长度与类型校验，真正的安全判定交给 validateBaseUrl（宿主侧统一入口）。
 * - 没有任何消息类型可以要求读取已保存的 Key。
 */
export function parseModelSettingsMessage(raw: unknown): ModelSettingsWebviewMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;

  switch (raw.type) {
    case "ready":
    case "refresh":
    case "openPrivacyStatus":
    case "backToAgent":
      return { type: raw.type };

    case "saveKey": {
      const providerId = id(raw.providerId);
      if (!providerId || typeof raw.key !== "string") return undefined;
      const key = raw.key.trim();
      if (key.length === 0 || key.length > MAX_KEY) return undefined;
      return { type: "saveKey", providerId, key };
    }

    case "deleteKey":
    case "deleteProvider": {
      const providerId = id(raw.providerId);
      if (!providerId) return undefined;
      return { type: raw.type, providerId };
    }

    case "setProviderEnabled": {
      const providerId = id(raw.providerId);
      if (!providerId || typeof raw.enabled !== "boolean") return undefined;
      return { type: "setProviderEnabled", providerId, enabled: raw.enabled };
    }

    case "addBuiltinProvider": {
      const providerId = id(raw.providerId);
      // 白名单来自 provider-types，界面报一个不在表里的 id 直接丢弃。
      if (!providerId || !BUILTIN_PROVIDER_TEMPLATE_IDS.includes(providerId)) return undefined;
      return { type: "addBuiltinProvider", providerId };
    }

    case "addCustomProvider": {
      const draft = parseDraft(raw.draft);
      if (!draft) return undefined;
      return { type: "addCustomProvider", draft };
    }

    case "syncCatalog": {
      const providerId = id(raw.providerId);
      if (!providerId) return undefined;
      return { type: "syncCatalog", providerId, force: raw.force === true };
    }

    case "checkBalance": {
      const providerId = id(raw.providerId);
      if (!providerId) return undefined;
      return { type: "checkBalance", providerId };
    }

    case "addModel": {
      const providerId = id(raw.providerId);
      const model = remoteId(raw.remoteModelId);
      const protocol = testableProtocol(raw.protocol);
      if (!providerId || !model || !protocol) return undefined;
      const name = displayName(raw.displayName);
      return {
        type: "addModel",
        providerId,
        remoteModelId: model,
        protocol,
        ...(name ? { displayName: name } : {}),
      };
    }

    case "testModel": {
      const providerId = id(raw.providerId);
      const modelId = id(raw.modelId);
      if (!providerId || !modelId) return undefined;
      const protocol = testableProtocol(raw.protocol);
      return { type: "testModel", providerId, modelId, ...(protocol ? { protocol } : {}) };
    }

    case "setModelEnabled": {
      const providerId = id(raw.providerId);
      const modelId = id(raw.modelId);
      if (!providerId || !modelId || typeof raw.enabled !== "boolean") return undefined;
      return { type: "setModelEnabled", providerId, modelId, enabled: raw.enabled };
    }

    case "setModelVision": {
      const providerId = id(raw.providerId);
      const modelId = id(raw.modelId);
      if (!providerId || !modelId || typeof raw.vision !== "boolean") return undefined;
      return { type: "setModelVision", providerId, modelId, vision: raw.vision };
    }

    case "renameModel": {
      const providerId = id(raw.providerId);
      const modelId = id(raw.modelId);
      const name = displayName(raw.displayName);
      if (!providerId || !modelId || !name) return undefined;
      return { type: "renameModel", providerId, modelId, displayName: name };
    }

    case "deleteModel": {
      const providerId = id(raw.providerId);
      const modelId = id(raw.modelId);
      if (!providerId || !modelId) return undefined;
      return { type: "deleteModel", providerId, modelId };
    }

    default:
      return undefined;
  }
}

function parseDraft(raw: unknown): CustomProviderDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const name = displayName(raw.displayName);
  const protocol = testableProtocol(raw.protocol);
  const model = remoteId(raw.remoteModelId);
  if (!name || !protocol || !model) return undefined;
  if (typeof raw.baseUrl !== "string") return undefined;
  const baseUrl = raw.baseUrl.trim();
  if (baseUrl.length === 0 || baseUrl.length > MAX_BASE_URL) return undefined;

  const modelName = displayName(raw.modelDisplayName);
  const contextWindow = typeof raw.contextWindow === "number"
    && Number.isFinite(raw.contextWindow)
    && raw.contextWindow > 0
    && raw.contextWindow <= MAX_CONTEXT_WINDOW
    ? Math.trunc(raw.contextWindow)
    : undefined;

  return {
    displayName: name,
    baseUrl,
    protocol,
    remoteModelId: model,
    ...(modelName ? { modelDisplayName: modelName } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/** 供设置页与宿主共用的协议展示名；避免两边各写一份中文。 */
export function protocolDisplayName(protocol: ProviderProtocol): string {
  if (protocol === "responses") return "Responses";
  if (protocol === "messages") return "Messages";
  return "Chat Completions";
}

export function isSupportedSettingsProtocol(value: unknown): value is ProviderProtocol {
  return isProviderProtocol(value);
}
