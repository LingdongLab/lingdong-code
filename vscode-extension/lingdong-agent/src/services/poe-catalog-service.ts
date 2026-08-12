/**
 * 模型目录同步与积分余额。
 *
 * 单独成一层而不是塞进 ModelSettingsService：目录与余额是「读服务商的公开信息」，
 * 与 Provider 增删、凭据保存、连接测试这些写操作没有共享状态，混在一起只会让
 * 那个已经很长的编排类更难读。
 *
 * 两条硬规则写在这里：
 * - 拉取失败一律保留旧缓存。宁可显示一份标注过期的目录，也好过把用户刚看过的列表清空。
 * - 余额只在用户点击时查，且短时缓存；不轮询、不写会话、不写 Timeline、不落盘。
 */

import type {
  SettingsBalanceView,
  SettingsCatalogEntryView,
  SettingsCatalogView,
} from "../model-settings-messages";
import type { CatalogCache, CatalogSnapshot } from "../models/providers/catalog-cache";
import { parsePoeBalance } from "../models/providers/poe-balance";
import {
  isCatalogFresh,
  parsePoeCatalog,
  preferredProtocol,
  type PoeCatalogEntry,
} from "../models/providers/poe-catalog";
import { describeProviderError, mapProviderError } from "../models/providers/provider-error-mapper";
import { MAX_CATALOG_BYTES, type ProviderHttpClient } from "../models/providers/provider-http-client";
import type { TestableProtocol } from "../models/providers/provider-test-service";
import type { ProviderConfig } from "../models/providers/provider-types";

/** 余额的短时缓存：用户连点几次不该变成几次请求。 */
export const BALANCE_TTL_MS = 5 * 60 * 1000;

export interface PoeCatalogServiceDeps {
  http: ProviderHttpClient;
  cache: CatalogCache;
  log(line: string): void;
  now?: () => number;
}

/** 失败时 `view` 仍可能有值——那是旧缓存，界面继续显示并标注过期。 */
export type CatalogSyncOutcome =
  | { ok: true; view: SettingsCatalogView }
  | { ok: false; message: string; view: SettingsCatalogView | undefined };

export type BalanceOutcome =
  | { ok: true; view: SettingsBalanceView }
  | { ok: false; message: string };

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

export class PoeCatalogService {
  private readonly now: () => number;
  /** 只在内存里，随窗口关闭消失。 */
  private readonly balances = new Map<string, SettingsBalanceView>();

  constructor(private readonly deps: PoeCatalogServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * 同步目录。
   *
   * 缓存未过期且没点强制刷新时直接返回缓存，一个请求都不发。
   */
  async sync(input: {
    provider: ProviderConfig;
    credential: string | undefined;
    force: boolean;
  }): Promise<CatalogSyncOutcome> {
    const { provider, credential, force } = input;
    const cached = await this.deps.cache.read(provider.id);
    if (!force && cached && isCatalogFresh(cached.syncedAt, this.now())) {
      return { ok: true, view: this.toView(provider, cached, true, 0) };
    }

    if (!credential) {
      return {
        ok: false,
        message: `${provider.displayName} 还没有配置 API Key，无法同步模型目录。`,
        view: cached ? this.toView(provider, cached, true, 0) : undefined,
      };
    }

    const stale = cached ? this.toView(provider, cached, true, 0) : undefined;
    let body: string;
    let status: number;
    let headers: Record<string, string>;
    try {
      const response = await this.deps.http.send({
        provider,
        path: "/models",
        method: "GET",
        credential,
        // 目录可能有几百条，比测试类响应宽得多，但仍然有上限。
        maxBytes: MAX_CATALOG_BYTES,
      });
      ({ body, status, headers } = response);
    } catch (error) {
      const mapped = mapProviderError({ error });
      return {
        ok: false,
        message: describeProviderError(mapped, { providerName: provider.displayName }),
        view: stale,
      };
    }

    if (status >= 400) {
      const mapped = mapProviderError({ status, headers, body });
      return {
        ok: false,
        message: describeProviderError(mapped, { providerName: provider.displayName }),
        view: stale,
      };
    }

    const parsed = parsePoeCatalog(safeJson(body));
    // 一条都解析不出来（连坏条目都没有）说明整体结构不对，按失败处理并保留旧缓存。
    if (parsed.entries.length === 0 && parsed.skipped === 0) {
      return {
        ok: false,
        message: `${provider.displayName} 的模型目录无法解析，可能是接口结构有变。`,
        view: stale,
      };
    }

    const snapshot: CatalogSnapshot = { entries: parsed.entries, syncedAt: this.now() };
    await this.deps.cache.write(provider.id, snapshot);
    this.deps.log(
      `[catalog] ${provider.displayName} 目录已同步：${parsed.entries.length} 个模型`
      + `${parsed.skipped > 0 ? `，跳过 ${parsed.skipped} 条异常数据` : ""}`,
    );
    return { ok: true, view: this.toView(provider, snapshot, false, parsed.skipped) };
  }

  /** 读缓存里的全部目录条目；没缓存就是空数组。要查多个模型时用这个，别逐个读文件。 */
  async cachedEntries(providerId: string): Promise<readonly PoeCatalogEntry[]> {
    return (await this.deps.cache.read(providerId))?.entries ?? [];
  }

  /** 读缓存里这个模型的目录条目；没缓存就返回 undefined。 */
  async entryFor(providerId: string, remoteModelId: string): Promise<PoeCatalogEntry | undefined> {
    const entries = await this.cachedEntries(providerId);
    return entries.find((candidate) => candidate.id === remoteModelId);
  }

  /** 读缓存里这个模型声明的首选协议；没缓存或没声明就返回 undefined。 */
  async protocolFor(providerId: string, remoteModelId: string): Promise<TestableProtocol | undefined> {
    const entry = await this.entryFor(providerId, remoteModelId);
    return entry ? preferredProtocol(entry) : undefined;
  }

  async balance(input: { provider: ProviderConfig; credential: string | undefined }): Promise<BalanceOutcome> {
    const { provider, credential } = input;
    const cached = this.balances.get(provider.id);
    if (cached && this.now() - cached.checkedAt < BALANCE_TTL_MS) {
      return { ok: true, view: cached };
    }
    if (!credential) {
      return { ok: false, message: `${provider.displayName} 还没有配置 API Key，无法查询余额。` };
    }

    try {
      const response = await this.deps.http.send({
        provider,
        // 余额端点在 base_url 的 /v1 之外，只能从 origin 拼。
        base: "origin",
        path: "/usage/current_balance",
        method: "GET",
        credential,
      });
      if (response.status >= 400) {
        const mapped = mapProviderError({
          status: response.status,
          headers: response.headers,
          body: response.body,
        });
        return { ok: false, message: describeProviderError(mapped, { providerName: provider.displayName }) };
      }
      const parsed = parsePoeBalance(response.body);
      if (!parsed.ok) return { ok: false, message: `${provider.displayName}：${parsed.reason}` };

      const view: SettingsBalanceView = {
        providerId: provider.id,
        label: parsed.label,
        checkedAt: this.now(),
      };
      this.balances.set(provider.id, view);
      return { ok: true, view };
    } catch (error) {
      const mapped = mapProviderError({ error });
      return { ok: false, message: describeProviderError(mapped, { providerName: provider.displayName }) };
    }
  }

  /** 删除 Provider 时连带清掉目录缓存与余额缓存。 */
  async forget(providerId: string): Promise<void> {
    this.balances.delete(providerId);
    await this.deps.cache.remove(providerId);
  }

  private toView(
    provider: ProviderConfig,
    snapshot: CatalogSnapshot,
    fromCache: boolean,
    skipped: number,
  ): SettingsCatalogView {
    const added = new Set(provider.models.map((model) => model.remoteModelId ?? model.id));
    return {
      providerId: provider.id,
      entries: snapshot.entries.map((entry) => toEntryView(entry, added)),
      syncedAt: snapshot.syncedAt,
      fromCache,
      skipped,
    };
  }
}

function toEntryView(entry: PoeCatalogEntry, added: ReadonlySet<string>): SettingsCatalogEntryView {
  const description = entry.description ?? describeModalities(entry);
  return {
    remoteModelId: entry.id,
    displayName: entry.id,
    vendor: entry.vendor === "" ? "未标注厂商" : entry.vendor,
    ...(description ? { description } : {}),
    protocols: [...entry.protocols],
    // 服务商声明的能力标签原样带出，只用于提示与筛选。
    features: [...entry.features],
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    added: added.has(entry.id),
  };
}

function describeModalities(entry: PoeCatalogEntry): string | undefined {
  const parts: string[] = [];
  // 输入输出分开写：「输入 text / image」和「输出 image」对用户是完全不同的信息，
  // 合成一句「模态：text / image」反而看不出这个模型是能读图还是能画图。
  if (entry.inputModalities.length > 0) parts.push(`输入：${entry.inputModalities.join(" / ")}`);
  if (entry.outputModalities.length > 0) parts.push(`输出：${entry.outputModalities.join(" / ")}`);
  if (entry.pricingNote) parts.push(entry.pricingNote);
  return parts.length > 0 ? parts.join("；") : undefined;
}
