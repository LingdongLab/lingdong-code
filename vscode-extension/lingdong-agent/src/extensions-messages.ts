/**
 * 「扩展能力」面板消息协议（Skills + MCP）。
 * 与聊天面板、模型设置面板分离，避免交叉发错消息。
 */

import { isValidMcpName, type McpTransport } from "./mcp/mcp-types";
import type { SkillScope } from "./skills/skill-types";

export interface SkillView {
  name: string;
  description: string;
  scope: SkillScope;
  directory: string;
  disabled: boolean;
  slash: string;
}

export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  argsText?: string;
  url?: string;
  envKeys: string[];
  secretEnvKeys: string[];
  headerKeys: string[];
  secretHeaderKeys: string[];
}

/** 一个 Grok 真的会加载的规则文件。 */
export interface RuleFileEntryView {
  path: string;
  label: string;
  scope: "project" | "user";
  vendor: "grok" | "claude" | "cursor";
  kind: "agents" | "rule";
  approxTokens: number;
}

export interface LspServerEntryView {
  id: string;
  label: string;
  hint: string;
  install: string;
  command?: string;
  source?: "workspace" | "path";
  found: boolean;
  enabled: boolean;
  extensions: string[];
}

export interface MemoryStateView {
  enabled: boolean;
  /** 记忆文件落盘目录，界面上如实展示。 */
  directory: string;
}

export type ExtensionsHostMessage =
  | {
      type: "snapshot";
      skills: SkillView[];
      mcpServers: McpServerView[];
      workspaceAvailable: boolean;
      rules: RuleFileEntryView[];
      lspServers: LspServerEntryView[];
      memory: MemoryStateView;
    }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { type: "error"; message: string };

export type ExtensionsWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "installSkillFromFolder"; scope: SkillScope }
  | { type: "installSkillFromZip"; scope: SkillScope }
  | { type: "removeSkill"; name: string; scope: SkillScope }
  | { type: "setSkillEnabled"; name: string; enabled: boolean }
  | { type: "openSkillFolder"; directory: string }
  | { type: "upsertMcp"; draft: McpServerDraft }
  | { type: "setMcpEnabled"; id: string; enabled: boolean }
  | { type: "removeMcp"; id: string }
  | { type: "openRuleFile"; path: string }
  | { type: "createProjectAgents" }
  | { type: "createRule"; scope: "project" | "user"; title: string }
  | { type: "setLspEnabled"; id: string; enabled: boolean }
  | { type: "setMemoryEnabled"; enabled: boolean }
  | { type: "backToAgent" };

export interface McpServerDraft {
  id?: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  argsText?: string;
  url?: string;
  /** 非敏感 env：key=value 每行一个。 */
  envText?: string;
  /** 敏感 env：key=value；空值表示清除该密钥。 */
  secretEnvText?: string;
  headersText?: string;
  secretHeadersText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scopeOf(value: unknown): SkillScope | undefined {
  return value === "user" || value === "workspace" ? value : undefined;
}

function parseKvText(text: unknown): Record<string, string> | undefined {
  if (typeof text !== "string") return undefined;
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function parseDraft(raw: unknown): McpServerDraft | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.name !== "string" || !isValidMcpName(raw.name.trim())) return undefined;
  if (raw.transport !== "stdio" && raw.transport !== "http") return undefined;
  if (typeof raw.enabled !== "boolean") return undefined;
  const draft: McpServerDraft = {
    name: raw.name.trim(),
    transport: raw.transport,
    enabled: raw.enabled,
  };
  if (typeof raw.id === "string" && raw.id.trim()) draft.id = raw.id.trim();
  if (typeof raw.command === "string") draft.command = raw.command;
  if (typeof raw.argsText === "string") draft.argsText = raw.argsText;
  if (typeof raw.url === "string") draft.url = raw.url;
  if (typeof raw.envText === "string") draft.envText = raw.envText;
  if (typeof raw.secretEnvText === "string") draft.secretEnvText = raw.secretEnvText;
  if (typeof raw.headersText === "string") draft.headersText = raw.headersText;
  if (typeof raw.secretHeadersText === "string") draft.secretHeadersText = raw.secretHeadersText;
  return draft;
}

export function parseExtensionsMessage(raw: unknown): ExtensionsWebviewMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  switch (raw.type) {
    case "ready":
    case "refresh":
    case "backToAgent":
      return { type: raw.type };
    case "installSkillFromFolder":
    case "installSkillFromZip": {
      const scope = scopeOf(raw.scope);
      if (!scope) return undefined;
      return { type: raw.type, scope };
    }
    case "removeSkill": {
      const scope = scopeOf(raw.scope);
      if (!scope || typeof raw.name !== "string" || !raw.name.trim()) return undefined;
      return { type: "removeSkill", name: raw.name.trim(), scope };
    }
    case "setSkillEnabled": {
      if (typeof raw.name !== "string" || !raw.name.trim() || typeof raw.enabled !== "boolean") {
        return undefined;
      }
      return { type: "setSkillEnabled", name: raw.name.trim(), enabled: raw.enabled };
    }
    case "openSkillFolder": {
      if (typeof raw.directory !== "string" || !raw.directory.trim()) return undefined;
      return { type: "openSkillFolder", directory: raw.directory.trim() };
    }
    case "upsertMcp": {
      const draft = parseDraft(raw.draft);
      if (!draft) return undefined;
      return { type: "upsertMcp", draft };
    }
    case "setMcpEnabled": {
      if (typeof raw.id !== "string" || !raw.id.trim() || typeof raw.enabled !== "boolean") {
        return undefined;
      }
      return { type: "setMcpEnabled", id: raw.id.trim(), enabled: raw.enabled };
    }
    case "removeMcp": {
      if (typeof raw.id !== "string" || !raw.id.trim()) return undefined;
      return { type: "removeMcp", id: raw.id.trim() };
    }
    case "openRuleFile": {
      if (typeof raw.path !== "string" || !raw.path.trim()) return undefined;
      return { type: "openRuleFile", path: raw.path.trim() };
    }
    case "createProjectAgents":
      return { type: "createProjectAgents" };
    case "createRule": {
      const scope = raw.scope === "project" || raw.scope === "user" ? raw.scope : undefined;
      if (!scope || typeof raw.title !== "string" || !raw.title.trim()) return undefined;
      return { type: "createRule", scope, title: raw.title.trim() };
    }
    case "setLspEnabled": {
      if (typeof raw.id !== "string" || !raw.id.trim() || typeof raw.enabled !== "boolean") {
        return undefined;
      }
      return { type: "setLspEnabled", id: raw.id.trim(), enabled: raw.enabled };
    }
    case "setMemoryEnabled": {
      if (typeof raw.enabled !== "boolean") return undefined;
      return { type: "setMemoryEnabled", enabled: raw.enabled };
    }
    default:
      return undefined;
  }
}

/** 供 ExtensionsService 把 draft 转成 registry 入参。 */
export function draftToUpsertInput(draft: McpServerDraft): {
  id?: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  secretEnv?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string>;
} {
  const args = (draft.argsText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name,
    transport: draft.transport,
    enabled: draft.enabled,
    ...(draft.command !== undefined ? { command: draft.command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(draft.url !== undefined ? { url: draft.url } : {}),
    ...(draft.envText !== undefined ? { env: parseKvText(draft.envText) ?? {} } : {}),
    ...(draft.secretEnvText !== undefined
      ? { secretEnv: parseKvText(draft.secretEnvText) ?? {} }
      : {}),
    ...(draft.headersText !== undefined
      ? { headers: parseKvText(draft.headersText) ?? {} }
      : {}),
    ...(draft.secretHeadersText !== undefined
      ? { secretHeaders: parseKvText(draft.secretHeadersText) ?? {} }
      : {}),
  };
}
