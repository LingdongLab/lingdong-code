/**
 * Agent 能力检测：判断一个模型是否真的会调用工具。
 *
 * 这个模块刻意保持纯粹——只有常量、请求体构造与响应解析。它**不 import**
 * `node:fs`、`node:child_process` 或 `vscode`，因此检测在结构上不可能读文件、
 * 执行命令或碰工作区。有一条测试直接断言 import 清单，防止以后被顺手加回来。
 *
 * 判定不依赖服务商对 strict Schema 的任何承诺：参数一律由宿主再校验一遍。
 * Poe 的文档明确写着 `response_format` 会被忽略、参数是 best-effort 传递，
 * 把安全性寄托在对端的严格模式上是不成立的。
 */

/** 无副作用的探测工具：只要求把传入值回显，不接触任何真实资源。 */
export const PROBE_TOOL_NAME = "lingdong_capability_probe";

export const PROBE_EXPECTED_VALUE = "ok";

export const PROBE_PROMPT = `Call ${PROBE_TOOL_NAME} with value "${PROBE_EXPECTED_VALUE}".`;

export const PROBE_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: PROBE_TOOL_NAME,
    description: "Return the supplied value.",
    parameters: {
      type: "object",
      properties: {
        value: {
          type: "string",
        },
      },
      required: ["value"],
    },
  },
} as const;

export type ProbeArgumentsReason =
  | "not-json"
  | "not-object"
  | "missing-value"
  | "wrong-type"
  | "unexpected-key"
  | "wrong-value";

export type ProbeArgumentsResult =
  | { ok: true; value: string }
  | { ok: false; reason: ProbeArgumentsReason };

/**
 * 宿主侧的参数二次校验。
 *
 * 比「能 JSON.parse 就算过」严格得多：拒绝多余键、拒绝非字符串、拒绝错误取值。
 * 这条路径同时也是后续真实工具调用的参照——工具参数永远要在宿主再验一遍。
 */
export function validateProbeArguments(raw: string): ProbeArgumentsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object" };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.includes("value")) return { ok: false, reason: "missing-value" };
  if (keys.some((key) => key !== "value")) return { ok: false, reason: "unexpected-key" };
  const value = record.value;
  if (typeof value !== "string") return { ok: false, reason: "wrong-type" };
  if (value !== PROBE_EXPECTED_VALUE) return { ok: false, reason: "wrong-value" };
  return { ok: true, value };
}

/** 从响应里提取出的工具调用。 */
export interface ExtractedToolCall {
  name: string;
  arguments: string;
}

export type ProbeFailureReason =
  | "no-tool-call"
  | "wrong-tool-name"
  | ProbeArgumentsReason;

export type ProbeVerdict =
  | { agentCompatible: true }
  | { agentCompatible: false; reason: ProbeFailureReason; detail: string };

const FAILURE_TEXT: Record<ProbeFailureReason, string> = {
  "no-tool-call": "模型没有发起工具调用，只返回了文本。",
  "wrong-tool-name": "模型调用了别的工具名称。",
  "not-json": "工具参数不是有效 JSON。",
  "not-object": "工具参数不是 JSON 对象。",
  "missing-value": "工具参数缺少 value 字段。",
  "wrong-type": "工具参数 value 不是字符串。",
  "unexpected-key": "工具参数包含未声明的字段。",
  "wrong-value": "工具参数 value 与要求的取值不一致。",
};

/**
 * 五条同时成立才算通过：有工具调用、名称正确、参数是有效 JSON、
 * 通过宿主 Schema 校验、value === "ok"。
 */
export function judgeProbe(calls: readonly ExtractedToolCall[]): ProbeVerdict {
  if (calls.length === 0) {
    return { agentCompatible: false, reason: "no-tool-call", detail: FAILURE_TEXT["no-tool-call"] };
  }
  const call = calls.find((candidate) => candidate.name === PROBE_TOOL_NAME);
  if (!call) {
    return { agentCompatible: false, reason: "wrong-tool-name", detail: FAILURE_TEXT["wrong-tool-name"] };
  }
  const args = validateProbeArguments(call.arguments);
  if (!args.ok) {
    return { agentCompatible: false, reason: args.reason, detail: FAILURE_TEXT[args.reason] };
  }
  return { agentCompatible: true };
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

/**
 * Chat Completions 形态的探测请求。
 *
 * 内容全部是上面的固定常量：没有项目代码、会话、文件、选区、Context、
 * Plan、Timeline 或终端输出的入口。函数不接受除模型名以外的任何参数，
 * 所以「不携带上下文」是签名保证的，不是约定。
 */
export function probeChatPayload(apiModelId: string): Record<string, unknown> {
  return {
    model: apiModelId,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    tools: [PROBE_TOOL_DEFINITION],
    tool_choice: "auto",
    max_tokens: 128,
    stream: false,
  };
}

/** Responses 形态的探测请求；工具定义在这个协议里是平铺的。 */
export function probeResponsesPayload(apiModelId: string): Record<string, unknown> {
  return {
    model: apiModelId,
    input: PROBE_PROMPT,
    tools: [{
      type: "function",
      name: PROBE_TOOL_NAME,
      description: PROBE_TOOL_DEFINITION.function.description,
      parameters: PROBE_TOOL_DEFINITION.function.parameters,
    }],
    tool_choice: "auto",
    max_output_tokens: 128,
    stream: false,
  };
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

/** 从 Chat Completions 响应里取工具调用。 */
export function extractChatToolCalls(body: unknown): ExtractedToolCall[] {
  const choices = readArray(body, "choices");
  const calls: ExtractedToolCall[] = [];
  for (const choice of choices) {
    const message = readRecord(choice, "message");
    for (const raw of readArray(message, "tool_calls")) {
      const fn = readRecord(raw, "function");
      const name = readString(fn, "name");
      if (name === undefined) continue;
      calls.push({ name, arguments: readString(fn, "arguments") ?? "" });
    }
  }
  return calls;
}

/** 从 Responses 响应里取工具调用；输出项是扁平数组。 */
export function extractResponsesToolCalls(body: unknown): ExtractedToolCall[] {
  const calls: ExtractedToolCall[] = [];
  for (const item of readArray(body, "output")) {
    const record = asRecord(item);
    if (!record) continue;
    if (record.type !== "function_call") continue;
    const name = readString(record, "name");
    if (name === undefined) continue;
    calls.push({ name, arguments: readString(record, "arguments") ?? "" });
  }
  return calls;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record ? asRecord(record[key]) : undefined;
}

function readArray(value: unknown, key: string): unknown[] {
  const record = asRecord(value);
  const found = record?.[key];
  return Array.isArray(found) ? found : [];
}

function readString(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const found = record?.[key];
  return typeof found === "string" ? found : undefined;
}
