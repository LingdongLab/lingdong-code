/**
 * 模型目录的本地缓存。
 *
 * 落盘到 `<storageRoot>/agent-providers/catalogs/<providerId>.json`，与 providers.json
 * 一样走 JsonStore，因此自带临时文件写入、.bak 回退与损坏归档。
 *
 * 结构里**没有凭据字段**：缓存的是公开的模型目录，Key 只在请求那一刻拼进 Authorization。
 * 拉取失败时调用方保留旧缓存，宁可显示一份过期目录，也好过把用户已经看过的列表清空。
 */

import * as path from "node:path";
import type { FileSystemPort } from "../../file-system-port";
import { JsonStore } from "../../storage/json-store";
import type { PoeCatalogEntry } from "./poe-catalog";

export interface CatalogSnapshot {
  entries: PoeCatalogEntry[];
  syncedAt: number;
}

/**
 * 条目结构的版本号，写盘时自动带上。
 *
 * 改了 PoeCatalogEntry 的形状就 +1：旧缓存会被当成不可用直接重拉，而不是拿一份字段
 * 对不上的数据继续用。第 2 版把合并的 modalities 拆成了 input/output——沿用旧数据的话，
 * 文生图模型会因为「有 image」被当成能看图。
 */
const ENTRY_SHAPE_VERSION = 2;

export interface CatalogCacheDeps {
  fs: FileSystemPort;
  storageRoot: string;
  log?: (line: string) => void;
}

function validateSnapshot(data: unknown): CatalogSnapshot | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return undefined;
  if (typeof record.syncedAt !== "number" || !Number.isFinite(record.syncedAt)) return undefined;
  if (record.shape !== ENTRY_SHAPE_VERSION) return undefined;

  const entries: PoeCatalogEntry[] = [];
  for (const raw of record.entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.trim() === "") continue;
    // 缓存是自己写的，但仍按外部数据对待：字段缺失一律补默认值，不让界面拿到 undefined 数组。
    entries.push({
      id: entry.id,
      vendor: typeof entry.vendor === "string" ? entry.vendor : "",
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      protocols: readProtocols(entry.protocols),
      features: readStringArray(entry.features),
      ...(typeof entry.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
      inputModalities: readStringArray(entry.inputModalities),
      outputModalities: readStringArray(entry.outputModalities),
      ...(typeof entry.pricingNote === "string" ? { pricingNote: entry.pricingNote } : {}),
    });
  }
  return { entries, syncedAt: record.syncedAt };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readProtocols(value: unknown): PoeCatalogEntry["protocols"] {
  return readStringArray(value).filter(
    (item): item is "responses" | "chat_completions" =>
      item === "responses" || item === "chat_completions",
  );
}

export class CatalogCache {
  private readonly store: JsonStore;

  constructor(private readonly deps: CatalogCacheDeps) {
    this.store = new JsonStore(deps.fs);
  }

  file(providerId: string): string {
    return path.join(this.deps.storageRoot, "agent-providers", "catalogs", `${providerId}.json`);
  }

  /** 没有缓存或缓存损坏时返回 undefined，由调用方决定要不要拉网络。 */
  async read(providerId: string): Promise<CatalogSnapshot | undefined> {
    const result = await this.store.read<CatalogSnapshot | undefined>(this.file(providerId), {
      kind: "catalog",
      fallback: () => undefined,
      validate: validateSnapshot,
    });
    if (result.status === "corrupt") {
      // 结构升级后的旧缓存也走这条路：对用户来说结果一样，都是重新拉一次。
      this.deps.log?.(`[catalog] ${providerId} 目录缓存不可用（损坏或结构已升级），将重新拉取。`);
    }
    return result.data;
  }

  async write(providerId: string, snapshot: CatalogSnapshot): Promise<void> {
    await this.store.write(this.file(providerId), "catalog", { ...snapshot, shape: ENTRY_SHAPE_VERSION });
  }

  /** 删除 Provider 时连带清掉；缓存文件与 .bak 都要删。 */
  async remove(providerId: string): Promise<void> {
    const file = this.file(providerId);
    await this.deps.fs.remove(file);
    await this.deps.fs.remove(this.store.backupPath(file));
  }
}
