/**
 * 宿主侧统一脱敏。
 *
 * 刻意不只认 `sk-` 前缀：DeepSeek、Poe 与自建网关的 Key 形态各不相同，
 * 靠前缀识别等于漏掉大多数。这里走两条路：一是按字段名与常见头部结构匹配，
 * 二是把当前已配置的凭据字面量整串替换——后者才是最可靠的一条。
 *
 * Runtime 包里的 `logger.ts` 负责 ACP 原始日志，`context-model.ts` 负责发给模型的
 * 上下文正文，各管一段。这里只管宿主侧的 Output Channel、错误文案、
 * Timeline 明细与会话落盘。
 */

export const REDACTED = "***";

/**
 * `key: value` / `key=value` / `"key":"value"` 形式的敏感字段。
 * 字段名后允许一个收尾引号，JSON 里 `"api_key":"…"` 才认得出来。
 */
const SECRET_FIELD_PATTERNS: readonly RegExp[] = [
  /\b(api[_-]?key|apikey)["']?\s*[:=]\s*("?)([^\s",;}]+)\2/gi,
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token)["']?\s*[:=]\s*("?)([^\s",;}]+)\2/gi,
  /\b(secret|client[_-]?secret|password|passwd|credential)["']?\s*[:=]\s*("?)([^\s",;}]+)\2/gi,
  // 单独的 token= 放在后面，避免先把 access_token 里的 token 割开。
  /\btoken["']?\s*[:=]\s*("?)([^\s",;}]+)\1/gi,
];

/**
 * 对象键名匹配到就整值替换。
 * 结构化数据里凭据常常单独作为一个值出现（`{ authorization: "Bearer …" }`），
 * 这时字符串本身没有任何字段前缀，只能靠键名判断。
 */
const SECRET_KEY_NAME =
  /^(?:authorization|proxy-authorization|api[_-]?key|apikey|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|credential|cookie|set-cookie)$/i;

/** HTTP 头部形态。 */
const HEADER_PATTERNS: readonly RegExp[] = [
  /\b(authorization)\s*:\s*(bearer|basic|token)\s+[^\s,;]+/gi,
  /\b(x-api-key|api-key|x-auth-token|proxy-authorization)\s*:\s*[^\s,;]+/gi,
  /\b(set-cookie|cookie)\s*:\s*[^\n\r]+/gi,
];

/** URL 查询串里的凭据。 */
const QUERY_PATTERN = /([?&])(api[_-]?key|apikey|key|token|access_token|secret|password)=([^&\s"']+)/gi;

/** 少量高置信度的令牌形态；作为字面量注册之外的兜底。 */
const TOKEN_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bxai-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** 已配置凭据的字面量；由 SecretStore 注册，Key 变更时刷新。 */
const literals = new Set<string>();

/** 太短的字符串整串替换会把正常文本打成马赛克。 */
const MIN_LITERAL_LENGTH = 8;

export function registerSecretLiterals(values: readonly string[]): void {
  literals.clear();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length >= MIN_LITERAL_LENGTH) literals.add(trimmed);
  }
}

export function clearSecretLiterals(): void {
  literals.clear();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(text: string): string {
  if (text === "") return text;
  let output = text;

  // 字面量优先：最可靠，且能兜住任何我们没预料到的输出格式。
  for (const literal of literals) {
    output = output.replace(new RegExp(escapeRegExp(literal), "g"), REDACTED);
  }

  for (const pattern of HEADER_PATTERNS) {
    output = output.replace(pattern, (match) => {
      const colon = match.indexOf(":");
      return colon < 0 ? REDACTED : `${match.slice(0, colon + 1)} ${REDACTED}`;
    });
  }

  output = output.replace(QUERY_PATTERN, (_match, prefix: string, name: string) =>
    `${prefix}${name}=${REDACTED}`);

  for (const pattern of SECRET_FIELD_PATTERNS) {
    output = output.replace(pattern, (match) => {
      const separator = match.search(/[:=]/);
      if (separator < 0) return REDACTED;
      return `${match.slice(0, separator + 1)}${REDACTED}`;
    });
  }

  for (const pattern of TOKEN_SHAPE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }

  return output;
}

/** 未知类型的值：结构保持不变，敏感键名整值替换，字符串逐条脱敏。 */
export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY_NAME.test(key) ? REDACTED : redactUnknown(item);
    }
    return output;
  }
  return value;
}

/** 包裹一个日志函数，保证写出去的每一行都过脱敏。 */
export function redactingLogger(write: (line: string) => void): (line: string) => void {
  return (line) => write(redact(line));
}
