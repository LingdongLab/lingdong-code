export type McpTransport = "stdio" | "http";

/** 落盘的非敏感 MCP 配置；密钥只存 SecretStorage。 */
export interface McpServerRecord {
  id: string;
  /** TOML 段名：字母数字与 _- */
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  /** 非敏感 env 明文；敏感键名列在 secretEnvKeys。 */
  env?: Record<string, string>;
  secretEnvKeys?: string[];
  url?: string;
  /** 非敏感 header 明文；敏感键名列在 secretHeaderKeys。 */
  headers?: Record<string, string>;
  secretHeaderKeys?: string[];
}

export interface McpServersDocument {
  servers: McpServerRecord[];
}

export const RESERVED_MCP_NAMES = new Set(["lingdong_web"]);

export function isValidMcpName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 64;
}

export function mcpEnvVarName(serverName: string, key: string): string {
  const safeServer = serverName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const safeKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `LINGDONG_MCP_${safeServer}_${safeKey}`;
}
