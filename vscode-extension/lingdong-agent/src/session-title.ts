import { redactText } from "@lingdong/agent-runtime";

/** 标题最多 40 个字符（中文按字符计），超出截断并加省略号。 */
export const MAX_TITLE_CHARS = 40;
export const DEFAULT_TITLE = "新会话";

/** 礼貌用语与人称前缀，出现在开头时直接去掉。 */
const LEADING_NOISE = [
  "请你帮我",
  "麻烦你帮我",
  "麻烦帮我",
  "能不能帮我",
  "可以帮我",
  "帮我一下",
  "请帮我",
  "帮我",
  "帮忙",
  "麻烦",
  "请问",
  "请",
  "我想要",
  "我想",
  "我要",
  "我需要",
  "现在",
  "接下来",
  "给我",
  "为我",
  "你能",
  "能否",
];

/** 动作词本身不携带信息，去掉后剩下的对象更适合当标题。 */
const ACTION_WORDS = [
  "增加",
  "添加",
  "新增",
  "加上",
  "加一个",
  "做一个",
  "写一个",
  "实现一个",
  "实现",
  "创建",
  "生成",
  "补充",
];

/** 只保留第一个语义片段，句末标点一律丢弃。 */
const SENTENCE_BREAK = /[。！？；\n\r]/;
const TRAILING_PUNCTUATION = /[，,。．.！!？?；;：:、～~…\s]+$/u;
const LEADING_PUNCTUATION = /^[，,。．.！!？?；;：:、～~…\s]+/u;

function stripRepeated(text: string, tokens: readonly string[]): string {
  let current = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const token of tokens) {
      if (!current.startsWith(token)) continue;
      // 允许剥空：整句都是礼貌用语时回落到默认标题。
      current = current.slice(token.length).replace(LEADING_PUNCTUATION, "");
      changed = current !== "";
      if (current === "") return "";
    }
  }
  return current;
}

function dropActionWord(text: string): string {
  for (const word of ACTION_WORDS) {
    const index = text.indexOf(word);
    if (index === -1) continue;
    const next = `${text.slice(0, index)}${text.slice(index + word.length)}`.replace(LEADING_PUNCTUATION, "");
    if (next.length >= 2) return next;
  }
  return text;
}

function truncate(text: string): string {
  const characters = [...text];
  if (characters.length <= MAX_TITLE_CHARS) return text;
  return `${characters.slice(0, MAX_TITLE_CHARS - 1).join("")}…`;
}

/**
 * 用本地规则从用户的第一条任务里提取标题，不额外调用模型。
 * 输入先脱敏，避免用户把密钥粘进任务描述后又被写进会话索引。
 */
export function generateSessionTitle(prompt: string): string {
  // 只清掉制表符一类控制字符，换行留给句子切分。
  const flattened = redactText(prompt).replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f]+/g, " ").trim();
  if (flattened === "") return DEFAULT_TITLE;

  const [firstSentence = ""] = flattened.split(SENTENCE_BREAK);
  const collapsed = firstSentence.replace(/\s+/g, " ").trim();
  if (collapsed === "") return DEFAULT_TITLE;

  let title = stripRepeated(collapsed, LEADING_NOISE);
  title = title.replace(/^[给为把对]/u, "").replace(LEADING_PUNCTUATION, "");
  title = dropActionWord(title);
  title = title.replace(TRAILING_PUNCTUATION, "").trim();
  if (title === "") return DEFAULT_TITLE;
  return truncate(title);
}

/** 手动标题永不被自动结果覆盖；占位标题与自动标题可以被新的自动结果替换。 */
export function shouldApplyAutoTitle(source: "auto" | "manual" | "placeholder"): boolean {
  return source !== "manual";
}
