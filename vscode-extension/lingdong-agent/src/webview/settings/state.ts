/**
 * 统一设置页的界面状态。
 *
 * 三段数据（配置、模型、能力）平铺在同一个对象里：整页共用一个 paint()，
 * 分成三份状态只会让「切到模型页发现数据是旧的」这类问题重新出现。
 *
 * 与旧的模型页一样，刻意没有存放 API Key 的字段——用户输入后即交给宿主，
 * 界面这边不留副本。
 */

import type {
  LspServerEntryView,
  McpServerDraft,
  McpServerView,
  RuleFileEntryView,
  SkillView,
} from "../../extensions-messages";
import type {
  SettingsBalanceView,
  SettingsBuiltinTemplateView,
  SettingsCatalogView,
  SettingsProviderView,
  SettingsTestResultView,
} from "../../model-settings-messages";
import type {
  PermissionRuleView,
  PrivacySectionView,
  SettingsCategory,
  SettingsConfigView,
} from "../../settings-messages";

export interface ProviderDraft {
  displayName: string;
  baseUrl: string;
  protocol: "responses" | "chat_completions";
  remoteModelId: string;
  contextWindow: string;
}

/** 可变状态，因此可选字段一律显式 `| undefined`（仓库开了 exactOptionalPropertyTypes）。 */
export interface PageState {
  category: SettingsCategory;
  search: string;
  notice: { level: "info" | "warn" | "error"; message: string } | undefined;
  busy: boolean;
  busyLabel: string | undefined;

  config: SettingsConfigView;
  permissionRules: PermissionRuleView[];
  privacy: PrivacySectionView[];
  memoryDirectory: string;

  providers: SettingsProviderView[];
  availableBuiltins: SettingsBuiltinTemplateView[];
  catalogs: Record<string, SettingsCatalogView>;
  balances: Record<string, SettingsBalanceView>;
  results: Record<string, SettingsTestResultView>;
  activeModelId: string | undefined;
  expandedProviderId: string | undefined;
  addingProvider: boolean;
  providerDraft: ProviderDraft;
  /** 目录筛选。Poe 一家就有几百个模型，不筛不分页等于让用户自己滚。 */
  catalogQuery: string;
  catalogVendor: string;
  catalogProtocol: string;
  catalogLimit: number;

  skills: SkillView[];
  mcpServers: McpServerView[];
  workspaceAvailable: boolean;
  rules: RuleFileEntryView[];
  lspServers: LspServerEntryView[];
  mcpDraft: McpServerDraft | undefined;
  newRuleTitle: string;
}

/** 目录每批渲染多少条。一次铺几百个 DOM 节点会让整页卡住。 */
export const CATALOG_PAGE = 50;

export function emptyProviderDraft(): ProviderDraft {
  return {
    displayName: "",
    baseUrl: "",
    protocol: "chat_completions",
    remoteModelId: "",
    contextWindow: "",
  };
}

export function emptyMcpDraft(): McpServerDraft {
  return {
    name: "",
    transport: "stdio",
    enabled: true,
    command: "",
    argsText: "",
    url: "",
    envText: "",
    secretEnvText: "",
    headersText: "",
    secretHeadersText: "",
  };
}

export function mcpDraftFrom(server: McpServerView): McpServerDraft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    command: server.command ?? "",
    argsText: server.argsText ?? "",
    url: server.url ?? "",
    // 密钥槽不回填：宿主从不把已保存的值交给界面，留空表示「不改动」。
    envText: "",
    secretEnvText: "",
    headersText: "",
    secretHeadersText: "",
  };
}

export function createPageState(): PageState {
  return {
    category: "general",
    search: "",
    notice: undefined,
    busy: false,
    busyLabel: undefined,

    config: {},
    permissionRules: [],
    privacy: [],
    memoryDirectory: "",

    providers: [],
    availableBuiltins: [],
    catalogs: {},
    balances: {},
    results: {},
    activeModelId: undefined,
    expandedProviderId: undefined,
    addingProvider: false,
    providerDraft: emptyProviderDraft(),
    catalogQuery: "",
    catalogVendor: "",
    catalogProtocol: "",
    catalogLimit: CATALOG_PAGE,

    skills: [],
    mcpServers: [],
    workspaceAvailable: false,
    rules: [],
    lspServers: [],
    mcpDraft: undefined,
    newRuleTitle: "",
  };
}

/** 相对时间，避免把精确时间戳摊在界面上。 */
export function formatTestedAt(timestamp: number | undefined, now: number = Date.now()): string {
  if (timestamp === undefined) return "尚未测试";
  const elapsed = now - timestamp;
  if (elapsed < 60_000) return "刚刚测试";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前测试`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前测试`;
  return `${Math.floor(elapsed / 86_400_000)} 天前测试`;
}

export function formatContextWindow(tokens: number | undefined): string {
  if (tokens === undefined || tokens <= 0) return "上下文长度未知";
  if (tokens >= 1_000_000) return `上下文 ${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `上下文 ${Math.round(tokens / 100) / 10}K`;
  return `上下文 ${tokens}`;
}
