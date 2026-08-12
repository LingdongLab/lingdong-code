/**
 * 宿主侧联网搜索入口：多引擎回退（DDG → Bing → DDG Instant Answer）。
 * 国内网络常会 403 DDG HTML；回退可避免模型再去跑 PowerShell 爬虫。
 */

import {
  clampSearchLimit,
  formatSearchHits,
  searchDuckDuckGo,
  WebSearchError,
  type SearchHit,
  type SearchOptions,
} from "./duckduckgo-search";

const BING_ENDPOINT = "https://www.bing.com/search";
const DDG_IA_ENDPOINT = "https://api.duckduckgo.com/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export { formatSearchHits, WebSearchError, type SearchHit };

export async function searchWeb(options: SearchOptions): Promise<SearchHit[]> {
  const query = options.query.trim();
  if (!query) throw new WebSearchError("搜索词不能为空。");
  const limit = clampSearchLimit(options.limit);
  const timeoutMs = options.timeoutMs ?? 12_000;
  const fetchImpl = options.fetch ?? fetch;
  const errors: string[] = [];

  try {
    const hits = await searchDuckDuckGo({ query, limit, timeoutMs, fetch: fetchImpl });
    if (hits.length > 0) return hits;
    errors.push("DuckDuckGo HTML：无结果");
  } catch (error) {
    errors.push(`DuckDuckGo HTML：${errorText(error)}`);
  }

  try {
    const hits = await searchBingHtml({ query, limit, timeoutMs, fetch: fetchImpl });
    if (hits.length > 0) return hits;
    errors.push("Bing：无结果");
  } catch (error) {
    errors.push(`Bing：${errorText(error)}`);
  }

  try {
    const hits = await searchDuckDuckGoInstantAnswer({ query, limit, timeoutMs, fetch: fetchImpl });
    if (hits.length > 0) return hits;
    errors.push("DuckDuckGo API：无结果");
  } catch (error) {
    errors.push(`DuckDuckGo API：${errorText(error)}`);
  }

  throw new WebSearchError(
    `联网搜索失败（已尝试 DuckDuckGo / Bing）。${errors.join("；")}。`
    + "请勿改用终端爬虫；可稍后重试或换关键词。",
  );
}

export function parseBingHtml(html: string, limit: number): SearchHit[] {
  if (/captcha|challenge|机器人|验证码/i.test(html) && !/<li[^>]*class="[^"]*b_algo/i.test(html)) {
    throw new WebSearchError("Bing 返回了验证页，暂时无法抓取。");
  }
  const hits: SearchHit[] = [];
  const blocks = html.match(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    if (hits.length >= limit) break;
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeHtml(link[1] ?? "").trim();
    const title = stripTags(decodeHtml(link[2] ?? "")).trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const snip = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      ?? block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = stripTags(decodeHtml(snip?.[1] ?? "")).replace(/\s+/g, " ").trim();
    hits.push({ title, url, snippet });
  }
  return hits.slice(0, limit);
}

async function searchBingHtml(options: {
  query: string;
  limit: number;
  timeoutMs: number;
  fetch: typeof fetch;
}): Promise<SearchHit[]> {
  const url = new URL(BING_ENDPOINT);
  url.searchParams.set("q", options.query);
  url.searchParams.set("setlang", "zh-CN");
  const html = await fetchText(url.toString(), options.timeoutMs, options.fetch);
  return parseBingHtml(html, options.limit);
}

async function searchDuckDuckGoInstantAnswer(options: {
  query: string;
  limit: number;
  timeoutMs: number;
  fetch: typeof fetch;
}): Promise<SearchHit[]> {
  const url = new URL(DDG_IA_ENDPOINT);
  url.searchParams.set("q", options.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");
  const text = await fetchText(url.toString(), options.timeoutMs, options.fetch, "application/json");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WebSearchError("DuckDuckGo API 返回了无法解析的 JSON。");
  }
  if (!data || typeof data !== "object") return [];
  const hits: SearchHit[] = [];
  const record = data as Record<string, unknown>;
  if (typeof record.AbstractURL === "string" && record.AbstractURL && typeof record.Heading === "string") {
    hits.push({
      title: record.Heading,
      url: record.AbstractURL,
      snippet: typeof record.AbstractText === "string" ? record.AbstractText : "",
    });
  }
  collectRelated(record.RelatedTopics, hits, options.limit);
  return hits.slice(0, options.limit);
}

function collectRelated(value: unknown, hits: SearchHit[], limit: number): void {
  if (!Array.isArray(value) || hits.length >= limit) return;
  for (const item of value) {
    if (hits.length >= limit) return;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (Array.isArray(row.Topics)) {
      collectRelated(row.Topics, hits, limit);
      continue;
    }
    const text = typeof row.Text === "string" ? row.Text : "";
    const url = typeof row.FirstURL === "string" ? row.FirstURL : "";
    if (!text || !/^https?:\/\//i.test(url)) continue;
    hits.push({ title: text.split(" - ")[0] || text, url, snippet: text });
  }
}

async function fetchText(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  accept = "text/html,application/xhtml+xml",
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new WebSearchError(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new WebSearchError(`超时（>${timeoutMs}ms）`);
    }
    throw new WebSearchError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}
