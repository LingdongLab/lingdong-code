/**
 * 宿主侧网页抓取。
 *
 * 存在的理由：搜索工具只给标题、URL 和摘要，用户丢来一个具体网址要求"调研"时，
 * 模型手里没有能读正文的工具，就会退回 shell 去跑 `curl ... | Select-Object`。
 * 那条路每次都要过一遍审批弹窗，而且命令风险判定得靠正则去猜一个本该由宿主完成的动作。
 * 所以把"取一个网页的正文"做成一等工具。
 *
 * 与搜索不同，这里的 URL 完全由模型决定，等于把一个任意出网入口交到模型手上，
 * 所以下面的地址校验是必需的而不是加固：内网地址、回环和云元数据端点一律不放行。
 */

export class WebFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebFetchError";
  }
}

export interface FetchPageOptions {
  url: string;
  /** 正文字符上限，默认 20000，范围 500-50000。 */
  maxChars?: number;
  /** 毫秒，默认 15s。 */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  /** 因超出 maxChars 而截断时为 true。 */
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function clampMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.trunc(value)));
}

/**
 * 明确不允许抓取的主机名。
 *
 * 169.254.169.254 是各家云的实例元数据端点，能读出临时凭据，必须挡住。
 * 这是按主机名做的判断：DNS 指向内网、或解析后重绑定的情况覆盖不到，
 * 真正的隔离要靠出网侧，这里只拦住直接写内网地址这条明路。
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;

  // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10。
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true; // 链路本地，含云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function normalizeFetchUrl(raw: string): URL {
  const text = raw.trim();
  if (!text) throw new WebFetchError("网址不能为空。");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WebFetchError(`不是合法网址：${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError(`只支持 http 与 https，收到 ${url.protocol.replace(":", "")}。`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new WebFetchError(`拒绝抓取内网或本机地址：${url.hostname}。`);
  }
  return url;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return "";
  return decodeEntities(match[1] ?? "").replace(/\s+/g, " ").trim();
}

/**
 * HTML 转可读文本。
 *
 * 不追求还原排版，只求模型能读懂：先把不含正文的整块元素连内容一起丢掉
 * （script/style/nav/footer 里全是噪音），再把块级标签换成换行，最后收敛空白。
 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    // head 整块丢掉：标题由 extractTitle 单独从原始 HTML 取，留在这里会在正文开头重复一遍。
    .replace(/<(head|title|script|style|noscript|template|svg|canvas|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt|figcaption)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(stripped)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isHtml(contentType: string, body: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  if (contentType) return false;
  return /<html|<!doctype html|<body|<div/i.test(body.slice(0, 2_000));
}

export async function fetchPage(options: FetchPageOptions): Promise<FetchedPage> {
  const url = normalizeFetchUrl(options.url);
  const maxChars = clampMaxChars(options.maxChars);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WebFetchError(`抓取失败：HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}。`);
    }
    body = await response.text();
  } catch (error) {
    if (error instanceof WebFetchError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new WebFetchError(`抓取超时（>${timeoutMs}ms）：${url.hostname}。`);
    }
    throw new WebFetchError(`抓取失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const contentType = response.headers?.get?.("content-type") ?? "";
  if (/^(?:image|audio|video|font)\//i.test(contentType) || /application\/(?:octet-stream|pdf|zip)/i.test(contentType)) {
    throw new WebFetchError(`这个地址返回的是二进制内容（${contentType}），读不出文字。`);
  }

  const text = isHtml(contentType, body) ? htmlToText(body) : body.trim();
  const truncated = text.length > maxChars;
  return {
    url: response.url || url.toString(),
    title: isHtml(contentType, body) ? extractTitle(body) : "",
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
  };
}

/** 组装给模型看的文本：来源与截断状态都写明，免得它把半截内容当成全文。 */
export function formatFetchedPage(page: FetchedPage): string {
  const head = [page.title ? `标题：${page.title}` : undefined, `来源：${page.url}`]
    .filter(Boolean)
    .join("\n");
  if (!page.text) {
    return `${head}\n\n（这个页面没有可提取的文字，可能是纯前端渲染。）`;
  }
  const tail = page.truncated
    ? `\n\n（正文已截断到 ${page.text.length} 字；需要后面的内容就提高 maxChars 或换更具体的页面。）`
    : "";
  return `${head}\n\n${page.text}${tail}`;
}
