/**
 * 宿主侧 DuckDuckGo HTML 搜索（对标 Cursor：搜索不经对话模型供应商）。
 *
 * 只请求固定公网入口 `html.duckduckgo.com`，不接受任意 URL，避免 SSRF。
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  query: string;
  /** 默认 5，上限 10。 */
  limit?: number;
  /** 毫秒，默认 12s。 */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchError";
  }
}

const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 12_000;
const USER_AGENT =
  "LingdongAgent/0.1 (+https://github.com/RongleCat; host-side web search; DuckDuckGo HTML)";

export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** 解析 DDG HTML 结果页；可单测注入 fixture。 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  // 每个结果块：<div class="result ...">...</div>
  const blocks = html.match(/<div[^>]*class="[^"]*result\b[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*result\b|<\/form>|$)/gi) ?? [];
  for (const block of blocks) {
    if (hits.length >= limit) break;
    if (/result--ad|result--more/i.test(block)) continue;
    const link = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const href = decodeHtml(link[1] ?? "").trim();
    const title = stripTags(decodeHtml(link[2] ?? "")).trim();
    if (!href || !title) continue;
    const url = unwrapDuckDuckGoUrl(href);
    if (!isHttpUrl(url)) continue;
    const snipMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<td[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const snippet = stripTags(decodeHtml(snipMatch?.[1] ?? "")).replace(/\s+/g, " ").trim();
    hits.push({ title, url, snippet });
  }

  // 宽松回退：部分页面结构变化时仍尽量捞到 result__a。
  if (hits.length === 0) {
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null && hits.length < limit) {
      const url = unwrapDuckDuckGoUrl(decodeHtml(match[1] ?? "").trim());
      const title = stripTags(decodeHtml(match[2] ?? "")).trim();
      if (!title || !isHttpUrl(url)) continue;
      hits.push({ title, url, snippet: "" });
    }
  }
  return hits.slice(0, limit);
}

export async function searchDuckDuckGo(options: SearchOptions): Promise<SearchHit[]> {
  const query = options.query.trim();
  if (!query) throw new WebSearchError("搜索词不能为空。");
  const limit = clampSearchLimit(options.limit);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  // kl=wt-wt：地区无关；避免个性化干扰可复现性。
  url.searchParams.set("kl", "wt-wt");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WebSearchError(`搜索服务返回 HTTP ${response.status}。`);
    }
    const html = await response.text();
    return parseDuckDuckGoHtml(html, limit);
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new WebSearchError(`搜索超时（>${timeoutMs}ms）。`);
    }
    throw new WebSearchError(`搜索失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function formatSearchHits(query: string, hits: readonly SearchHit[]): string {
  if (hits.length === 0) {
    return `未找到与「${query}」相关的网页结果。`;
  }
  const lines = [`搜索「${query}」共 ${hits.length} 条结果：`, ""];
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title}`);
    lines.push(`   ${hit.url}`);
    if (hit.snippet) lines.push(`   ${hit.snippet}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const parsed = new URL(href, SEARCH_ENDPOINT);
    // 常见跳转：/l/?uddg=<encoded>
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname === "/l/") {
      const u = parsed.searchParams.get("u");
      if (u) return decodeURIComponent(u);
    }
    return parsed.toString();
  } catch {
    return href;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}
