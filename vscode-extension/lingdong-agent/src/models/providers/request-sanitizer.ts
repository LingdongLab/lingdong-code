/**
 * 出站请求体修补：修 DeepSeek 等严格校验方会直接 400 的历史字段。
 *
 * 实测踩中的是切模型之后：
 *   Invalid 'input[320].call_id': empty string. Expected a string with minimum length 1
 *
 * 会话历史跨协议/跨模型带回时，Grok 会把个别 function_call /
 * function_call_output 的 call_id 落成空串；DeepSeek Responses API 不吃，
 * Chat Completions 侧同类还有空的 tool_calls: [] 与空 tool_call_id。
 *
 * 这里只动不合规的工具字段，正文与其它结构一律不动。配对策略：
 * 连续的空 call_id（function_call → function_call_output）共用同一个补出来的 id，
 * 否则工具结果对不上调用，模型会更糊涂。
 */

/** 便宜预检：绝大多数请求不含这些形态，连 JSON.parse 都不必过。 */
const EMPTY_CALL_ID = /"(?:call_id|tool_call_id)"\s*:\s*(?:""|null)/;
const EMPTY_TOOL_CALLS = /"tool_calls"\s*:\s*\[\s*\]/;
/** tool_calls 条目里的 id 为空（Chat Completions）。 */
const EMPTY_TOOL_CALL_ENTRY_ID = /"tool_calls"\s*:\s*\[[\s\S]{0,400}?"id"\s*:\s*""/;

export function mayNeedOutboundSanitizing(raw: string): boolean {
  return EMPTY_CALL_ID.test(raw) || EMPTY_TOOL_CALLS.test(raw) || EMPTY_TOOL_CALL_ENTRY_ID.test(raw);
}

export interface OutboundSanitizeResult {
  body: string;
  changed: boolean;
  /** 补上的 call_id / tool_call_id 个数，便于日志与测试。 */
  fixedCallIds: number;
  /** 删掉的空 tool_calls: [] 个数。 */
  strippedEmptyToolCalls: number;
}

interface MutableResult {
  changed: boolean;
  fixedCallIds: number;
  strippedEmptyToolCalls: number;
}

export function sanitizeOutboundRequest(raw: string): OutboundSanitizeResult {
  if (!mayNeedOutboundSanitizing(raw)) {
    return { body: raw, changed: false, fixedCallIds: 0, strippedEmptyToolCalls: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { body: raw, changed: false, fixedCallIds: 0, strippedEmptyToolCalls: 0 };
  }
  const stats: MutableResult = { changed: false, fixedCallIds: 0, strippedEmptyToolCalls: 0 };
  const fixed = sanitizeValue(parsed, stats);
  if (!stats.changed) {
    return { body: raw, changed: false, fixedCallIds: 0, strippedEmptyToolCalls: 0 };
  }
  return {
    body: JSON.stringify(fixed),
    changed: true,
    fixedCallIds: stats.fixedCallIds,
    strippedEmptyToolCalls: stats.strippedEmptyToolCalls,
  };
}

function sanitizeValue(value: unknown, stats: MutableResult): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, stats));
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "input" && Array.isArray(item)) {
      out[key] = sanitizeResponsesInput(item, stats);
    } else if (key === "messages" && Array.isArray(item)) {
      out[key] = sanitizeChatMessages(item, stats);
    } else {
      out[key] = sanitizeValue(item, stats);
    }
  }
  return out;
}

function sanitizeResponsesInput(items: unknown[], stats: MutableResult): unknown[] {
  let seq = 0;
  /** 刚补过 id 的 function_call；仅紧邻的下一条空 function_call_output 可复用。 */
  let pendingCallId: string | undefined;
  return items.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      pendingCallId = undefined;
      return item;
    }
    const record = { ...(item as Record<string, unknown>) };
    const type = typeof record.type === "string" ? record.type : "";
    const callId = record.call_id;
    const empty = callId === "" || callId === null || callId === undefined;

    if (type === "function_call") {
      if (empty) {
        const id = `call_repair_${++seq}`;
        record.call_id = id;
        pendingCallId = id;
        stats.changed = true;
        stats.fixedCallIds += 1;
      } else {
        pendingCallId = undefined;
      }
      return record;
    }

    if (type === "function_call_output") {
      if (empty) {
        record.call_id = pendingCallId ?? `call_repair_${++seq}`;
        pendingCallId = undefined;
        stats.changed = true;
        stats.fixedCallIds += 1;
      } else {
        pendingCallId = undefined;
      }
      return record;
    }

    pendingCallId = undefined;
    if ("call_id" in record && empty) {
      record.call_id = `call_repair_${++seq}`;
      stats.changed = true;
      stats.fixedCallIds += 1;
    }
    return record;
  });
}

function sanitizeChatMessages(messages: unknown[], stats: MutableResult): unknown[] {
  let seq = 0;
  const pendingIds: string[] = [];
  return messages.map((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
    const record = { ...(message as Record<string, unknown>) };

    if (Array.isArray(record.tool_calls)) {
      if (record.tool_calls.length === 0) {
        delete record.tool_calls;
        stats.changed = true;
        stats.strippedEmptyToolCalls += 1;
      } else {
        record.tool_calls = record.tool_calls.map((entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
          const tool = { ...(entry as Record<string, unknown>) };
          if (tool.id === "" || tool.id === null || tool.id === undefined) {
            const id = `call_repair_${++seq}`;
            tool.id = id;
            pendingIds.push(id);
            stats.changed = true;
            stats.fixedCallIds += 1;
          }
          return tool;
        });
      }
    }

    if (record.role === "tool") {
      const toolCallId = record.tool_call_id;
      if (toolCallId === "" || toolCallId === null || toolCallId === undefined) {
        record.tool_call_id = pendingIds.shift() ?? `call_repair_${++seq}`;
        stats.changed = true;
        stats.fixedCallIds += 1;
      }
    }
    return record;
  });
}
