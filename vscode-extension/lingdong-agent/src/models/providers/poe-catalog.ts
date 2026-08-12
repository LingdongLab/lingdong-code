/**
 * Poe 模型目录的解析与新鲜度判定。
 *
 * 这个模块只有纯函数：给一段已经拿到的响应体，给一批条目。它**不 import**
 * `node:fs`、`node:child_process` 或 `vscode`，落盘交给 catalog-cache，
 * 发请求交给 ProviderHttpClient。有一条测试直接断言 import 清单。
 *
 * 解析的态度是「逐条容错」：服务商随时可能加字段、改字段，或者某一条数据本身有问题。
 * 整份目录因为一条坏数据而失败，对用户来说就是「模型中心打不开了」，
 * 所以除了 id 之外一切都可选，坏条目只计数跳过。
 *
 * 还有一条界线：`supported_features` 只是服务商自己的声明，
 * 这里把它原样带出去供提示与筛选，**绝不据此判定模型支持 Agent**——
 * 那个结论只能来自本地的 lingdong_capability_probe 检测。
 */

import { isRemoteModelId } from "./provider-types";
import type { TestableProtocol } from "./provider-test-service";

export interface PoeCatalogEntry {
  /** 远端模型名，直接用作 remoteModelId。 */
  id: string;
  /** owned_by；缺失时留空字符串，由界面决定怎么显示。 */
  vendor: string;
  description?: string;
  /** 由 supported_endpoints 推出的协议；服务商没声明时为空数组。 */
  protocols: TestableProtocol[];
  /** supported_features 原样保留，只作提示与筛选。 */
  features: string[];
  contextWindow?: number;
  /**
   * architecture 里的**输入**模态。
   *
   * 必须与 outputModalities 分开：合并之后文生图模型（image 在 output）与能看图的模型
   * （image 在 input）长得一模一样，据此判 vision 会把一堆图片生成模型误判成能读图。
   */
  inputModalities: string[];
  /** architecture 里的输出模态。目前只用于展示。 */
  outputModalities: string[];
  /** pricing 的紧凑摘要；解析不出可用信息时不存在。 */
  pricingNote?: string;
}

export interface PoeCatalogParseResult {
  entries: PoeCatalogEntry[];
  /** 跳过的条目数：结构不对、缺 id，或 id 含无法用于请求的字符。 */
  skipped: number;
}

/** 目录缓存有效期。超过就在下次打开时重新拉，用户也可以随时手动刷新。 */
export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

export function isCatalogFresh(syncedAt: number | undefined, now: number): boolean {
  if (syncedAt === undefined) return false;
  // 时间倒流（改过系统时钟）时按过期处理，宁可多拉一次也不要长期用错数据。
  const age = now - syncedAt;
  return age >= 0 && age < CATALOG_TTL_MS;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readStrings(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed !== "" && !result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

function readPositiveInt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

/**
 * 从 supported_endpoints 推协议。
 *
 * 服务商写法不统一（`/v1/chat/completions`、`chat_completions`、`/responses` 都见过），
 * 所以按子串判断而不是精确匹配。顺序固定：Responses 在前，与协议候选顺序一致。
 */
export function protocolsFromEndpoints(endpoints: readonly string[]): TestableProtocol[] {
  let responses = false;
  let chat = false;
  for (const raw of endpoints) {
    const normalized = raw.toLowerCase();
    if (normalized.includes("responses")) responses = true;
    if (normalized.includes("chat/completions") || normalized.includes("chat_completions")) chat = true;
  }
  // 输出顺序固定为 Responses 在前，与协议候选顺序一致：
  // 界面拿 protocols[0] 当初值，顺序跟着响应走会让同一个模型时好时坏。
  const result: TestableProtocol[] = [];
  if (responses) result.push("responses");
  if (chat) result.push("chat_completions");
  return result;
}

/**
 * 添加该模型时的首选协议。
 *
 * 支持 Responses 就用 Responses；只支持 Chat Completions 就用它；
 * 服务商没声明时返回 undefined，由调用方保留界面选择并交给协议测试决定。
 */
export function preferredProtocol(entry: PoeCatalogEntry): TestableProtocol | undefined {
  if (entry.protocols.includes("responses")) return "responses";
  if (entry.protocols.includes("chat_completions")) return "chat_completions";
  return undefined;
}

/**
 * architecture 里的输入模态。
 *
 * 裸 `modalities`（没有 input/output 之分的旧写法）按输入处理：OpenRouter 系的惯例里
 * 它指的就是模型收什么。字段形状不确定，只收字符串数组。
 */
function readInputModalities(record: Record<string, unknown>): string[] {
  const architecture = asRecord(record.architecture);
  if (!architecture) return [];
  const result: string[] = [];
  for (const key of ["input_modalities", "modalities"]) {
    for (const item of readStrings(architecture, key)) {
      if (!result.includes(item)) result.push(item);
    }
  }
  return result;
}

function readOutputModalities(record: Record<string, unknown>): string[] {
  const architecture = asRecord(record.architecture);
  return architecture ? readStrings(architecture, "output_modalities") : [];
}

/**
 * 这个模型收不收图片。
 *
 * 判据只有一处，调用方不要自己去翻 modalities 数组——「image 在 input 还是 output」
 * 这个区分一旦散落到多个地方，迟早有人漏掉，文生图模型就又会被当成能看图的。
 */
export function supportsImageInput(entry: PoeCatalogEntry): boolean {
  return entry.inputModalities.includes("image");
}

/**
 * pricing 摘要。
 *
 * 字段名与层级都可能变，所以不假设具体结构：只收顶层的原始值，
 * 最多带三项，够用户判断「大概多贵」即可。解析不出就干脆不显示，不编造。
 */
function readPricingNote(record: Record<string, unknown>): string | undefined {
  const pricing = asRecord(record.pricing);
  if (!pricing) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(pricing)) {
    if (parts.length >= 3) break;
    if (typeof value === "number" && Number.isFinite(value)) parts.push(`${key} ${value}`);
    else if (typeof value === "string" && value.trim() !== "") parts.push(`${key} ${value.trim()}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function parseEntry(raw: unknown): PoeCatalogEntry | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const id = readString(record, "id");
  // id 是唯一必需字段：没有它这条数据既不能展示也不能添加。
  if (!id) return undefined;
  // 含无法安全放进请求与本地键的字符时同样跳过，
  // 否则目录里会出现「看得见、点了加不进去」的条目。
  if (!isRemoteModelId(id)) return undefined;

  const description = readString(record, "description");
  const contextWindow = readPositiveInt(record, "context_length");
  const pricingNote = readPricingNote(record);
  return {
    id,
    vendor: readString(record, "owned_by") ?? "",
    ...(description ? { description } : {}),
    protocols: protocolsFromEndpoints(readStrings(record, "supported_endpoints")),
    features: readStrings(record, "supported_features"),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    inputModalities: readInputModalities(record),
    outputModalities: readOutputModalities(record),
    ...(pricingNote ? { pricingNote } : {}),
  };
}

/**
 * 解析 `GET {base}/models` 的响应。
 *
 * 同时接受 `{ data: [...] }` 与裸数组两种形态；整体结构不对时返回空目录与
 * skipped = 0，由调用方按「目录为空」提示，而不是抛异常打断界面。
 */
export function parsePoeCatalog(body: unknown): PoeCatalogParseResult {
  const record = asRecord(body);
  const list = Array.isArray(body) ? body : Array.isArray(record?.data) ? record.data : undefined;
  if (!list) return { entries: [], skipped: 0 };

  const entries: PoeCatalogEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of list) {
    const entry = parseEntry(raw);
    if (!entry) {
      skipped += 1;
      continue;
    }
    // 重复 id 只保留第一条：注册表按 id 唯一，重复项加进去也是覆盖。
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return { entries, skipped };
}
