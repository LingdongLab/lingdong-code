/**
 * 自定义 Provider 的地址校验（纯函数，便于单测）。
 *
 * 目标是让「数据会发到哪里」这件事在保存之前就确定且可展示：
 * 远程一律 HTTPS，HTTP 只放行明确的本地地址，URL 里不许夹带凭据。
 */

export interface BaseUrlOk {
  ok: true;
  /** 规范化后的地址：去掉尾部斜杠，只保留 origin + path。 */
  normalized: string;
  /** 展示给用户看的域名，用于保存前的确认提示。 */
  host: string;
  local: boolean;
}

export type BaseUrlReason =
  | "empty"
  | "invalid-url"
  | "unsupported-scheme"
  | "insecure-remote"
  | "embedded-credentials"
  | "secret-in-query";

export interface BaseUrlError {
  ok: false;
  reason: BaseUrlReason;
  message: string;
}

export type BaseUrlResult = BaseUrlOk | BaseUrlError;

/** 明确的本地地址；只有这些才允许走 HTTP。 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** Query 里出现这些参数名一律拒绝：Query 会被记进会话，不能放凭据。 */
const SECRET_QUERY_KEYS = ["key", "api_key", "apikey", "api-key", "token", "access_token", "secret", "password"];

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  // 整个 127.0.0.0/8 都是回环。
  return /^127\./.test(host);
}

export function validateBaseUrl(raw: string): BaseUrlResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty", message: "请填写服务地址。" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid-url", message: "地址格式不正确，请填写完整 URL，例如 https://api.example.com/v1。" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "unsupported-scheme", message: `不支持的协议 ${url.protocol}，请使用 https。` };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "embedded-credentials",
      message: "地址里不能包含用户名或密码，请把凭据填到 API Key 一栏。",
    };
  }

  for (const [name] of url.searchParams) {
    if (SECRET_QUERY_KEYS.includes(name.toLowerCase())) {
      return {
        ok: false,
        reason: "secret-in-query",
        message: `地址的查询参数里不能放 ${name}，请把凭据填到 API Key 一栏。`,
      };
    }
  }

  const local = isLocalHost(url.hostname);
  if (url.protocol === "http:" && !local) {
    return {
      ok: false,
      reason: "insecure-remote",
      message: "远程地址必须使用 https。http 只允许 localhost 等明确的本地地址。",
    };
  }

  // 尾斜杠统一去掉：Grok 拼接 `{base_url}/models` 时重复斜杠会变成不同的路径。
  const path = url.pathname.replace(/\/+$/, "");
  const normalized = `${url.origin}${path}${url.search}`;
  return { ok: true, normalized, host: url.host, local };
}

/** 保存前给用户看的数据流向提示。 */
export function describeDataDestination(host: string): string {
  return `使用该模型时，任务中的消息、代码片段和工具结果将发送至：\n${host}`;
}
