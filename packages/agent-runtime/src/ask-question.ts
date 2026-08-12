import { isRecord } from "./protocol.js";

/**
 * Grok 内置 ask_user_question 工具的反向请求（`_x.ai/ask_user_question`）。
 *
 * 模型调用该工具后，Grok 会向客户端发一条带 id 的反向 JSON-RPC 请求并阻塞等待；
 * 客户端应答后，答案作为工具结果注入模型上下文，这一轮继续执行。
 * 0.2.118 之前这里被当作未知方法拒收（-32601），模型侧只能收到
 * "Failed to reach the client for user question"。
 *
 * 字段名以 0.2.118 二进制中的 serde 结构为准（并经真实会话逐步验证）：
 * - 请求：questions[].{question, options, multiSelect}，options[].{label, preview}
 * - 应答：内部标签枚举 AskUserQuestionExtResponse，标签字段是 outcome——
 *   回答：{ "outcome": "accepted", "answers": { "<问题原文>": "答案" } }
 *     （answers 是映射不是数组，值为 StringOrVec，多选可给字符串数组；
 *     变体还有 partial_answers，可缺省。）
 *   跳过：{ "outcome": "skip_interview" }（另有 chat_about_this 变体，客户端用不到）
 *   踩过的坑：漏 outcome 报 missing field `outcome`；answers 发数组报
 *   invalid type: sequence, expected a map。两个报错都会以工具失败的形式打到模型。
 */

export interface AskUserOption {
  label: string;
  /** 选项的补充说明；Grok 会在工具结果里以 "selected preview:" 回显。 */
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  options: AskUserOption[];
  /** true 时允许多选；上游可能给 null，归一为布尔。 */
  multiSelect: boolean;
}

export interface AskUserRequest {
  sessionId?: string;
  toolCallId?: string;
  questions: AskUserQuestion[];
  /** 提问发生时的 Grok 模式（如 plan），仅用于展示。 */
  mode?: string;
}

/**
 * 客户端应答。answers 按问题原文键入；多选由客户端把所选项合成一条文本。
 * skip_interview 用于取消/清场：让 Grok 走「不带答案继续」而不是把工具打成失败。
 */
export type AskUserAnswerResult =
  | { outcome: "accepted"; answers: Record<string, string | string[]> }
  | { outcome: "skip_interview" };

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 选项既可能是对象也可能是裸字符串，两种都收；坏条目静默丢弃。 */
function parseOption(value: unknown): AskUserOption | undefined {
  if (typeof value === "string") {
    const label = value.trim();
    return label ? { label } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const label = stringValue(value.label)?.trim();
  if (!label) return undefined;
  const preview = stringValue(value.preview)?.trim();
  return { label, ...(preview ? { preview } : {}) };
}

function parseQuestion(value: unknown): AskUserQuestion | undefined {
  if (!isRecord(value)) return undefined;
  const question = stringValue(value.question)?.trim();
  if (!question) return undefined;
  const options = Array.isArray(value.options)
    ? value.options.map(parseOption).filter((option): option is AskUserOption => option !== undefined)
    : [];
  return { question, options, multiSelect: value.multiSelect === true };
}

/** 宽容解析：陌生字段忽略，没有一条有效问题时返回 undefined，由调用方决定如何回执。 */
export function parseAskUserRequest(params: unknown): AskUserRequest | undefined {
  if (!isRecord(params)) return undefined;
  const raw = Array.isArray(params.questions) ? params.questions : [];
  const questions = raw
    .map(parseQuestion)
    .filter((question): question is AskUserQuestion => question !== undefined);
  if (questions.length === 0) return undefined;
  const sessionId = stringValue(params.sessionId);
  const toolCallId = stringValue(params.toolCallId);
  const mode = stringValue(params.mode);
  return {
    questions,
    ...(sessionId ? { sessionId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(mode ? { mode } : {}),
  };
}
