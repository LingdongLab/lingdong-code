import type { SecretStoragePort } from "../models/providers/provider-secret-store";

/**
 * MCP 敏感值存储。
 *
 * 键形如 `lingdongAgent.mcpSecret.<serverId>.<slot>`，slot 为 `env.<KEY>`
 * 或 `header.<NAME>`。不提供批量导出接口给 UI，只给注入与脱敏用。
 */

export function mcpSecretKey(serverId: string, slot: string): string {
  return `lingdongAgent.mcpSecret.${serverId}.${slot}`;
}

export function mcpEnvSlot(key: string): string {
  return `env.${key}`;
}

export function mcpHeaderSlot(name: string): string {
  return `header.${name}`;
}

export class McpSecretStore {
  constructor(private readonly secrets: SecretStoragePort) {}

  async save(serverId: string, slot: string, value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === "") {
      await this.delete(serverId, slot);
      return;
    }
    await this.secrets.store(mcpSecretKey(serverId, slot), trimmed);
  }

  async get(serverId: string, slot: string): Promise<string | undefined> {
    const value = await this.secrets.get(mcpSecretKey(serverId, slot));
    const trimmed = value?.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  async delete(serverId: string, slot: string): Promise<void> {
    await this.secrets.delete(mcpSecretKey(serverId, slot));
  }

  async deleteAll(serverId: string, slots: readonly string[]): Promise<void> {
    for (const slot of slots) {
      await this.delete(serverId, slot);
    }
  }

  /** 供脱敏注册表使用；不得写日志。 */
  async secretLiterals(slotsByServer: ReadonlyMap<string, readonly string[]>): Promise<string[]> {
    const values: string[] = [];
    for (const [serverId, slots] of slotsByServer) {
      for (const slot of slots) {
        const value = await this.get(serverId, slot);
        if (value) values.push(value);
      }
    }
    return values;
  }
}
