import { secretIdFor } from "./provider-types";

/**
 * Provider 凭据存储。
 *
 * 全部走 VS Code SecretStorage，绝不落到 settings.json、config.toml、
 * session.json、transcript、Timeline 或任何报告里。
 *
 * 刻意**不提供 getAllKeys**：没有一次性导出全部凭据的入口，泄漏面就小一截。
 * `hasKey` 也不读明文——它查一份只含 providerId 的非敏感索引，
 * 回答「是否已配置」不需要把凭据拉进内存。
 */

/**
 * VS Code SecretStorage 的最小接口；测试里可以替换。
 * 用 PromiseLike 而不是 Promise，才能直接接受 VS Code 的 Thenable。
 */
export interface SecretStoragePort {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** 记录「哪些 Provider 配了 Key」的非敏感索引，通常落在 globalState。 */
export interface SecretIndexPort {
  get(): readonly string[];
  set(ids: readonly string[]): PromiseLike<void>;
}

export class ProviderSecretStore {
  constructor(
    private readonly secrets: SecretStoragePort,
    private readonly index: SecretIndexPort,
  ) {}

  async saveKey(providerId: string, key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed === "") {
      await this.deleteKey(providerId);
      return;
    }
    await this.secrets.store(secretIdFor(providerId), trimmed);
    await this.addToIndex(providerId);
  }

  /** 只在真正需要注入子进程时调用；返回值不得写日志、不得进 UI。 */
  async getKey(providerId: string): Promise<string | undefined> {
    const value = await this.secrets.get(secretIdFor(providerId));
    const trimmed = value?.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  /** 不读明文：只看索引。 */
  hasKey(providerId: string): boolean {
    return this.index.get().includes(providerId);
  }

  configuredProviders(): readonly string[] {
    return this.index.get();
  }

  async deleteKey(providerId: string): Promise<void> {
    await this.secrets.delete(secretIdFor(providerId));
    const next = this.index.get().filter((id) => id !== providerId);
    await this.index.set(next);
  }

  /**
   * 与真实存储对齐一次索引。
   *
   * 外部工具清空过 SecretStorage、或索引落盘失败时，索引可能虚高，
   * 导致界面显示「已配置」但注入时拿不到凭据。启动时校准一次即可。
   */
  async reconcile(providerIds: readonly string[]): Promise<void> {
    const present: string[] = [];
    for (const id of providerIds) {
      if ((await this.getKey(id)) !== undefined) present.push(id);
    }
    await this.index.set(present);
  }

  /** 供脱敏注册表使用：拿到当前全部凭据字面量做整串替换。 */
  async secretLiterals(): Promise<string[]> {
    const values: string[] = [];
    for (const id of this.index.get()) {
      const value = await this.getKey(id);
      if (value) values.push(value);
    }
    return values;
  }

  private async addToIndex(providerId: string): Promise<void> {
    const current = this.index.get();
    if (current.includes(providerId)) return;
    await this.index.set([...current, providerId]);
  }
}
