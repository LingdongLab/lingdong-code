import { randomBytes } from "node:crypto";
import path from "node:path";
import type { FileSystemPort } from "../file-system-port";
import { JsonStore } from "../storage/json-store";
import {
  isValidMcpName,
  mcpEnvVarName,
  RESERVED_MCP_NAMES,
  type McpServerRecord,
  type McpServersDocument,
  type McpTransport,
} from "./mcp-types";
import {
  mcpEnvSlot,
  mcpHeaderSlot,
  McpSecretStore,
} from "./mcp-secret-store";

export interface McpServerUpsertInput {
  id?: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  /** 明文 env；值为空字符串表示清除该键。 */
  env?: Record<string, string>;
  /** 敏感 env：有值则写入 SecretStorage；空字符串表示清除。 */
  secretEnv?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string>;
}

/** 注入子进程与写 config.toml 用的已解析条目（含占位符与真实值）。 */
export interface ResolvedUserMcpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** TOML 里写的 env：敏感值已换成 `${LINGDONG_MCP_...}`。 */
  env: Record<string, string>;
  headers: Record<string, string>;
  /** 需注入进程的真实凭据。 */
  credentials: { name: string; value: string }[];
}

export interface McpServerRegistryDeps {
  fs: FileSystemPort;
  storageRoot: string;
  secrets: McpSecretStore;
  onChanged?: () => void;
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class McpServerRegistry {
  private readonly store: JsonStore;
  private doc: McpServersDocument = { servers: [] };
  private loaded = false;

  constructor(private readonly deps: McpServerRegistryDeps) {
    this.store = new JsonStore(deps.fs);
  }

  private file(): string {
    return path.join(this.deps.storageRoot, "agent-mcp", "mcp-servers.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const result = await this.store.read<McpServersDocument>(this.file(), {
      kind: "mcp-servers",
      fallback: () => ({ servers: [] }),
      validate: (data) => {
        if (typeof data !== "object" || data === null) return undefined;
        const servers = (data as { servers?: unknown }).servers;
        if (!Array.isArray(servers)) return undefined;
        return { servers: servers.filter(isMcpServerRecord) };
      },
    });
    this.doc = result.data;
    this.loaded = true;
  }

  async list(): Promise<McpServerRecord[]> {
    await this.load();
    return this.doc.servers.map((item) => ({ ...item }));
  }

  async hasEnabledUserServer(): Promise<boolean> {
    const servers = await this.list();
    return servers.some((item) => item.enabled);
  }

  /** 所有敏感槽位，供脱敏拉取字面量。 */
  async secretSlots(): Promise<Map<string, string[]>> {
    await this.load();
    const map = new Map<string, string[]>();
    for (const server of this.doc.servers) {
      const slots = [
        ...(server.secretEnvKeys ?? []).map(mcpEnvSlot),
        ...(server.secretHeaderKeys ?? []).map(mcpHeaderSlot),
      ];
      if (slots.length > 0) map.set(server.id, slots);
    }
    return map;
  }

  async secretLiterals(): Promise<string[]> {
    const slots = await this.secretSlots();
    return this.deps.secrets.secretLiterals(slots);
  }

  async upsert(input: McpServerUpsertInput): Promise<McpServerRecord> {
    await this.load();
    const name = input.name.trim();
    if (!isValidMcpName(name)) {
      throw new Error("名称只能包含字母、数字、下划线与连字符。");
    }
    if (RESERVED_MCP_NAMES.has(name)) {
      throw new Error(`「${name}」为系统保留名，不可使用。`);
    }

    const existing = input.id
      ? this.doc.servers.find((item) => item.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("找不到要编辑的 MCP 服务器。");

    const clash = this.doc.servers.find(
      (item) => item.name === name && item.id !== existing?.id,
    );
    if (clash) throw new Error(`名称「${name}」已被占用。`);

    const id = existing?.id ?? newId();
    const next = await this.buildRecord(id, input, existing);
    if (existing) {
      this.doc = {
        servers: this.doc.servers.map((item) => (item.id === id ? next : item)),
      };
    } else {
      this.doc = { servers: [...this.doc.servers, next] };
    }
    await this.persist();
    this.deps.onChanged?.();
    return { ...next };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.load();
    const target = this.doc.servers.find((item) => item.id === id);
    if (!target) throw new Error("找不到 MCP 服务器。");
    if (target.enabled === enabled) return;
    this.doc = {
      servers: this.doc.servers.map((item) =>
        item.id === id ? { ...item, enabled } : item),
    };
    await this.persist();
    this.deps.onChanged?.();
  }

  async remove(id: string): Promise<void> {
    await this.load();
    const target = this.doc.servers.find((item) => item.id === id);
    if (!target) throw new Error("找不到 MCP 服务器。");
    const slots = [
      ...(target.secretEnvKeys ?? []).map(mcpEnvSlot),
      ...(target.secretHeaderKeys ?? []).map(mcpHeaderSlot),
    ];
    await this.deps.secrets.deleteAll(id, slots);
    this.doc = { servers: this.doc.servers.filter((item) => item.id !== id) };
    await this.persist();
    this.deps.onChanged?.();
  }

  /** 解析启用中的用户 MCP，供 config.toml 与子进程 env。 */
  async resolveEnabled(): Promise<ResolvedUserMcpServer[]> {
    await this.load();
    const out: ResolvedUserMcpServer[] = [];
    for (const server of this.doc.servers) {
      if (!server.enabled) continue;
      try {
        out.push(await this.resolveOne(server));
      } catch (error) {
        throw new Error(`MCP「${server.name}」：${errorText(error)}`);
      }
    }
    return out;
  }

  private async resolveOne(server: McpServerRecord): Promise<ResolvedUserMcpServer> {
    const env: Record<string, string> = { ...(server.env ?? {}) };
    const headers: Record<string, string> = { ...(server.headers ?? {}) };
    const credentials: { name: string; value: string }[] = [];

    for (const key of server.secretEnvKeys ?? []) {
      const value = await this.deps.secrets.get(server.id, mcpEnvSlot(key));
      if (!value) continue;
      const varName = mcpEnvVarName(server.name, key);
      env[key] = `\${${varName}}`;
      credentials.push({ name: varName, value });
    }
    for (const key of server.secretHeaderKeys ?? []) {
      const value = await this.deps.secrets.get(server.id, mcpHeaderSlot(key));
      if (!value) continue;
      const varName = mcpEnvVarName(server.name, `HDR_${key}`);
      headers[key] = `\${${varName}}`;
      credentials.push({ name: varName, value });
    }

    if (server.transport === "stdio") {
      if (!server.command?.trim()) throw new Error("stdio 服务器缺少 command。");
      return {
        name: server.name,
        transport: "stdio",
        command: server.command.trim(),
        args: server.args ?? [],
        env,
        headers: {},
        credentials,
      };
    }
    if (!server.url?.trim()) throw new Error("HTTP 服务器缺少 URL。");
    return {
      name: server.name,
      transport: "http",
      url: server.url.trim(),
      env: {},
      headers,
      credentials,
    };
  }

  private async buildRecord(
    id: string,
    input: McpServerUpsertInput,
    previous: McpServerRecord | undefined,
  ): Promise<McpServerRecord> {
    const env = sanitizeStringMap(input.env);
    const headers = sanitizeStringMap(input.headers);
    let secretEnvKeys = [...(previous?.secretEnvKeys ?? [])];
    let secretHeaderKeys = [...(previous?.secretHeaderKeys ?? [])];

    if (input.secretEnv) {
      for (const [key, value] of Object.entries(input.secretEnv)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) continue;
        if (value.trim() === "") {
          await this.deps.secrets.delete(id, mcpEnvSlot(trimmedKey));
          secretEnvKeys = secretEnvKeys.filter((item) => item !== trimmedKey);
        } else {
          await this.deps.secrets.save(id, mcpEnvSlot(trimmedKey), value);
          if (!secretEnvKeys.includes(trimmedKey)) secretEnvKeys.push(trimmedKey);
        }
      }
    }
    if (input.secretHeaders) {
      for (const [key, value] of Object.entries(input.secretHeaders)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) continue;
        if (value.trim() === "") {
          await this.deps.secrets.delete(id, mcpHeaderSlot(trimmedKey));
          secretHeaderKeys = secretHeaderKeys.filter((item) => item !== trimmedKey);
        } else {
          await this.deps.secrets.save(id, mcpHeaderSlot(trimmedKey), value);
          if (!secretHeaderKeys.includes(trimmedKey)) secretHeaderKeys.push(trimmedKey);
        }
      }
    }

    // 改名时旧密钥仍挂在同一 id 上，无需搬迁。
    if (input.transport === "stdio") {
      const command = (input.command ?? previous?.command ?? "").trim();
      if (!command) throw new Error("请填写启动命令。");
      return {
        id,
        name: input.name.trim(),
        transport: "stdio",
        enabled: input.enabled,
        command,
        args: normalizeArgs(input.args ?? previous?.args),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(secretEnvKeys.length > 0 ? { secretEnvKeys } : {}),
      };
    }

    const url = (input.url ?? previous?.url ?? "").trim();
    if (!url) throw new Error("请填写服务器 URL。");
    return {
      id,
      name: input.name.trim(),
      transport: "http",
      enabled: input.enabled,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(secretHeaderKeys.length > 0 ? { secretHeaderKeys } : {}),
    };
  }

  private async persist(): Promise<void> {
    await this.store.write(this.file(), "mcp-servers", this.doc);
  }
}

function sanitizeStringMap(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    const k = key.trim();
    if (!k) continue;
    const v = value.trim();
    if (v === "") continue;
    out[k] = v;
  }
  return out;
}

function normalizeArgs(args: string[] | undefined): string[] {
  if (!args) return [];
  return args.map((item) => item.trim()).filter(Boolean);
}

function isMcpServerRecord(value: unknown): value is McpServerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && (record.transport === "stdio" || record.transport === "http")
    && typeof record.enabled === "boolean";
}
