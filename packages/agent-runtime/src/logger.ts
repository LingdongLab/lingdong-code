import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const REDACTED = "***REDACTED***";
const SECRET_FIELD = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|credential|cookie)/i;
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:DEEPSEEK_API_KEY|XAI_API_KEY)\s*[=:]\s*[^\s"']+/gi,
];

/**
 * 调用方登记的凭据字面量。
 *
 * 原本只从 `process.env` 里取 DEEPSEEK_API_KEY / XAI_API_KEY 做整串替换。
 * 凭据改由宿主的 SecretStorage 管理后，它不再出现在进程环境里，
 * 那条路径就失效了——不补这个入口，原始 ACP 日志会重新开始泄漏。
 */
const registeredSecrets = new Set<string>();

/** 至少 8 位才登记：过短的字符串整串替换会把正常日志打成马赛克。 */
const MIN_SECRET_LENGTH = 8;

export function registerRuntimeSecrets(values: readonly string[]): void {
  registeredSecrets.clear();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) registeredSecrets.add(trimmed);
  }
}

export function redactText(input: string): string {
  const formatRedacted = SECRET_TEXT_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (match) => {
      const separator = match.match(/^([^=:]+[=:]\s*)/);
      return separator ? `${separator[1]}${REDACTED}` : REDACTED;
    }),
    input,
  );
  const secrets = [
    ...registeredSecrets,
    process.env.DEEPSEEK_API_KEY,
    process.env.XAI_API_KEY,
  ];
  return secrets
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= 4)
    .reduce((text, secret) => text.replaceAll(secret, REDACTED), formatRedacted);
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_FIELD.test(key) ? REDACTED : redactValue(item, seen);
  }
  return result;
}

export class SafeLogger {
  readonly appLogPath: string;
  readonly rawLogPath: string;
  private ready: Promise<void>;
  /**
   * 写入串行队列：并发调用按提交顺序落盘，文件里的顺序即调用顺序。
   * 没有它，同帧到达的多条 ACP 消息各自 appendFile，完成顺序不保证 FIFO。
   */
  private queue: Promise<void>;

  constructor(logDirectory: string) {
    this.appLogPath = path.join(logDirectory, "app.log");
    this.rawLogPath = path.join(logDirectory, "acp-raw.log");
    this.ready = mkdir(logDirectory, { recursive: true })
      .then(() => Promise.all([
        appendFile(this.appLogPath, "", "utf8"),
        appendFile(this.rawLogPath, "", "utf8"),
      ]))
      .then(() => undefined);
    this.queue = this.ready;
  }

  private enqueue(file: string, line: string): Promise<void> {
    const task = this.queue.then(() => appendFile(file, line, "utf8"));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async app(level: "INFO" | "WARN" | "ERROR", message: string, detail?: unknown): Promise<void> {
    const suffix = detail === undefined ? "" : ` ${JSON.stringify(redactValue(detail))}`;
    await this.enqueue(this.appLogPath, `${new Date().toISOString()} ${level} ${redactText(message)}${suffix}\n`);
  }

  async raw(direction: "IN" | "OUT" | "STDERR", payload: unknown): Promise<void> {
    const safe = typeof payload === "string" ? redactText(payload) : JSON.stringify(redactValue(payload));
    await this.enqueue(this.rawLogPath, `${new Date().toISOString()} ${direction} ${safe}\n`);
  }
}
