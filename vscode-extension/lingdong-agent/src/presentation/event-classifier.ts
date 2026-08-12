import type { ActivityAction } from "./activity-item";

/**
 * 原始工具事件 → 归一化活动。
 *
 * 这是「不把 Read / List Files / Run Command 直接甩给用户」的第一道关口：
 * 原始工具名只在这里被消费，之后的层只认识 ActivityAction。
 *
 * thought_delta 一类的模型私有推理永远不会进入这里——调用方只喂工具事件，
 * 且 classifyTool 也不接受自由文本作为分类依据。
 */

export interface ToolStartedLike {
  toolCallId: string;
  /** Runtime 的 ToolDisplayKind：read / edit / execute / search / plan / subagent / other。 */
  kind: string;
  name: string;
  label: string;
  target?: string;
  readOnly: boolean;
}

export interface NormalizedActivity {
  toolCallId: string;
  action: ActivityAction;
  target?: string;
}

const DIAGNOSTICS = /diagnostic|problems?[_ ]panel|get_?diagnostics|问题面板|诊断/i;
const LIST = /list[_ ]?files|list[_ ]?dir|listdir|read[_ ]?dir|glob|列出文件|查看项目/i;
const SEARCH = /search|grep|ripgrep|\brg\b|find[_ ]?in|查找|搜索/i;
const READ = /^read\b|read[_ ]?file|view[_ ]?file|open[_ ]?file|读取/i;
const CREATE = /create[_ ]?file|new[_ ]?file|write[_ ]?new|touch|新建|创建/i;
const DELETE = /delete[_ ]?file|remove[_ ]?file|unlink|\brm\b|删除/i;
const RENAME = /rename|move[_ ]?file|\bmv\b|重命名|移动文件/i;
const EDIT = /edit|write[_ ]?file|apply[_ ]?patch|str[_ ]?replace|patch|修改|写入/i;
const EXECUTE = /run[_ ]?command|execute|terminal|bash|shell|\bcmd\b|powershell|命令/i;

/**
 * 命令细分。顺序要紧：
 * typecheck 必须早于 build（`tsc -b` 两边都命中），lint 必须早于 test（`test:lint` 之类）。
 */
const COMMAND_RULES: ReadonlyArray<{ pattern: RegExp; action: ActivityAction }> = [
  { pattern: /type-?check|\btsc\b|tsc\s+--noemit/i, action: "typecheck" },
  { pattern: /\blint\b|eslint|biome|ruff|flake8|clippy/i, action: "lint" },
  { pattern: /\btest\b|vitest|jest|mocha|pytest|--test\b|go\s+test|cargo\s+test/i, action: "test" },
  { pattern: /\bbuild\b|esbuild|webpack|rollup|vite\s+build|compile/i, action: "build" },
];

function classifyCommand(text: string): ActivityAction {
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(text)) return rule.action;
  }
  return "run";
}

/**
 * 把可能是绝对路径的目标压成工作区相对路径。
 * 纯字符串处理，不碰文件系统，因此 Webview 也能安全引用本模块。
 */
export function toRelativeTarget(target: string | undefined, workspaceRoot?: string): string | undefined {
  const raw = target?.trim();
  if (!raw) return undefined;
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return undefined;

  const root = workspaceRoot?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (root) {
    const lower = normalized.toLowerCase();
    const lowerRoot = root.toLowerCase();
    if (lower === lowerRoot) return ".";
    if (lower.startsWith(`${lowerRoot}/`)) return normalized.slice(root.length + 1);
  }

  // 工作区外或无法判定的绝对路径：只留尾部片段，绝对路径不进 UI。
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) {
    const parts = normalized.replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "").split("/").filter(Boolean);
    return parts.slice(-2).join("/") || undefined;
  }
  return normalized;
}

/**
 * 返回 undefined 表示这条工具事件不进时间线。
 * plan 类工具属于计划文档的职责，时间线不重复呈现。
 */
export function classifyTool(
  input: ToolStartedLike,
  options: { workspaceRoot?: string } = {},
): NormalizedActivity | undefined {
  if (input.kind === "plan") return undefined;
  // 提问工具由会话流里的问答卡片呈现；进时间线只会被兜底成一条莫名其妙的「正在读取」。
  if (/ask[_ ]?user/i.test(input.name) || /askuserquestion/i.test(input.name)) return undefined;

  const text = `${input.name} ${input.label}`.trim();
  const target = toRelativeTarget(input.target, options.workspaceRoot);
  const action = detectAction(input, text);
  if (!action) return undefined;

  // 命令类活动不带文件目标，改用命令文本本身作为可读目标。
  if (action === "run" || action === "test" || action === "typecheck" || action === "lint" || action === "build") {
    const command = commandText(input);
    return { toolCallId: input.toolCallId, action, ...(command ? { target: command } : {}) };
  }
  return { toolCallId: input.toolCallId, action, ...(target ? { target } : {}) };
}

function detectAction(input: ToolStartedLike, text: string): ActivityAction | undefined {
  // 派发/等待/终止子 Agent 都靠 kind 认，工具名里的 command、output 之类词不能参与判断。
  if (input.kind === "subagent") return "subagent";
  if (DIAGNOSTICS.test(text)) return "diagnostics";
  if (LIST.test(text)) return "list";
  if (input.kind === "execute" || EXECUTE.test(text)) return classifyCommand(commandText(input) || text);
  if (input.kind === "search" || SEARCH.test(text)) return "search";
  if (RENAME.test(text)) return "rename";
  if (DELETE.test(text)) return "delete";
  if (CREATE.test(text)) return "create";
  if (input.kind === "read" || READ.test(text)) return "read";
  if (input.kind === "edit" || EDIT.test(text)) return "edit";
  // 兜底也要给出确定动作，否则真实活动会静默消失。
  return input.readOnly ? "read" : "run";
}

/** 命令文本优先取 label；label 退化成工具名时不展示。 */
function commandText(input: ToolStartedLike): string | undefined {
  const label = input.label.trim();
  if (!label) return undefined;
  if (label.toLowerCase() === input.name.trim().toLowerCase()) return undefined;
  if (/^(run[_ ]?command|execute|terminal|bash|shell)$/i.test(label)) return undefined;
  return label.length > 120 ? `${label.slice(0, 120)}…` : label;
}
