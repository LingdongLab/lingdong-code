/**
 * 上游响应的兜底修补。目前修两类实测到的具体故障，都源于 Grok 的严格反序列化：
 *
 * 一、usage 里的 null。Poe 上的 kimi-k3 在收尾分片里返回
 *
 *   "usage": { "completion_tokens_details": { "audio_tokens": null, ... } }
 *
 * 而 Grok 把这些计数声明成了整数而不是可空整数，撞上 null 直接整轮解析失败，
 * 报 `invalid type: null, expected u32`，一个字都拿不到。同一个账号下的
 * claude-opus-4.8 却没事——它的 completion_tokens_details 整个是 null，
 * 说明 Grok 那一层对「整个对象为空」是容忍的，只有**对象内部**的 null 会炸。
 *
 * 两条设计取舍：
 *
 * - 只动 `usage` 子树。别处的 null 是有意义的，比如 `finish_reason: null`
 *   表示这一轮还没结束，Grok 本来就正确处理，改了反而会坏事。
 * - null 归零，而不是把字段删掉。删字段只在 Grok 那边是可空或带默认值时才安全；
 *   归零则无论它声明成整数还是可空整数都能通过。usage 里全是 token 计数，
 *   null 语义上本就等于「这项没有」，记 0 不失真。
 *
 * 二、choices / tool_calls 条目缺 `index`。Poe 实测（claude-opus-4.8 调用
 * ask_user_question）：工具调用分片的 `choices[0]` 里没有 `index` 字段——
 *
 *   "choices": [{"delta": {"tool_calls": [...]}, "finish_reason": null}]
 *
 * 纯文字分片却带着 `"index": 0`。Grok 把它声明成必填，报
 * `serialization error: missing field index`，整轮失败：纯聊天没事，一调工具就炸。
 * 修法是按条目在数组里的位置补上，这正是该字段的规范语义；tool_calls 条目
 * 一并覆盖，OpenAI 流式规范同样要求它带 index。
 */

/** 只改 usage 子树，所以先认准这个键名。 */
const USAGE_KEY = "usage";
const INDEXED_KEYS = new Set(["choices", "tool_calls"]);

/**
 * 首元素的第一个键不是 index 的 choices/tool_calls 数组，才可能要补。
 * 正常分片都是 `"choices": [{"index": 0, ...}]`，一眼放行；
 * 误报的代价只是一次多余的 JSON 解析，不失真。
 */
const MISSING_INDEX = /"(?:choices|tool_calls)"\s*:\s*\[\s*\{\s*"(?!index")/;

/**
 * 便宜的预检：绝大多数流式分片既没有 usage/null 也不缺 index，
 * 让它们连 JSON.parse 都不用过。一轮回复上千个分片，这一步省下的是实打实的延迟。
 */
export function mayNeedSanitizing(raw: string): boolean {
  return (raw.includes(USAGE_KEY) && raw.includes("null")) || MISSING_INDEX.test(raw);
}

/**
 * usage 子树里的 null 归零，但对象值的键（`*_details`）除外：
 * `completion_tokens_details: null` 是 Grok 能接受的「整个对象为空」，
 * 归零成整数反而会撞上 `expected struct CompletionTokensDetails`（实测踩中）。
 */
function zeroNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(zeroNulls);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = item === null && key.endsWith("_details") ? null : zeroNulls(item);
    }
    return out;
  }
  return value === null ? 0 : value;
}

/** 数组里缺 index 的条目按位置补上；已有 index 的原样保留。 */
function fillIndexes(items: unknown[]): unknown[] {
  return items.map((item, position) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (typeof record.index === "number") return item;
    return { index: position, ...record };
  });
}

/** 递归找出所有 usage / choices / tool_calls 子树并就地修补，其余分支不碰。 */
export function sanitizeUsage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeUsage);
  if (typeof value !== "object" || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === USAGE_KEY && item !== null) {
      // usage 整个为 null 是 Grok 能接受的形态，保持原样，不要凭空造一个 0 对象出来。
      out[key] = zeroNulls(item);
    } else if (INDEXED_KEYS.has(key) && Array.isArray(item)) {
      out[key] = fillIndexes(item.map(sanitizeUsage));
    } else {
      out[key] = sanitizeUsage(item);
    }
  }
  return out;
}

/**
 * 修补一段 JSON 文本。解析不了就原样退回——转发层的职责是别把事情弄得更糟，
 * 上游返回的畸形内容该由 Grok 按它自己的规则去报错，不该由我们代为改写。
 */
export function sanitizeJsonText(raw: string): string {
  if (!mayNeedSanitizing(raw)) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const fixed = sanitizeUsage(parsed);
  return JSON.stringify(fixed);
}

/**
 * 修补一个 SSE 事件块（`data: {...}` 及其可能带的 event/id 行）。
 *
 * 保留原始的行结构与前缀：转发层不该顺手规整上游的格式，
 * 那会把「我们改了什么」这件事变得难以追查。`[DONE]` 这类非 JSON 载荷原样放行。
 */
export function sanitizeSseEvent(block: string): string {
  if (!mayNeedSanitizing(block)) return block;

  return block
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice("data:".length);
      const trimmed = payload.trim();
      if (trimmed === "" || trimmed === "[DONE]") return line;
      const fixed = sanitizeJsonText(trimmed);
      if (fixed === trimmed) return line;
      // 前导空格按 SSE 惯例保留一个，跟上游发来的形态一致。
      return `data:${payload.startsWith(" ") ? " " : ""}${fixed}`;
    })
    .join("\n");
}
