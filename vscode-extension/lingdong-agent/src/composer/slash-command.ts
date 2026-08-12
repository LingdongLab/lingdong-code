import type { WebviewToHostMessage } from "../messages";

/**
 * Slash 快捷命令表。这张表同时就是允许列表：
 * 表外的任何 id 都不会被执行，命令也永远不会作为普通消息发给模型。
 *
 * 每条命令只映射到「已有且已过校验的宿主消息」或「纯 Webview 动作」，
 * 因此宿主侧不需要新开一个「字符串 → 能力」的转发口。
 */

export type SlashClientAction = "retry" | "openChanges" | "openFiles" | "help";

export type SlashTarget =
  | { kind: "host"; message: WebviewToHostMessage }
  | { kind: "client"; action: SlashClientAction };

/** 命令依赖的运行时能力；缺失时候选禁用并说明原因。 */
export type SlashRequirement = "switchMode" | "cancel" | "send";

export interface SlashCommand {
  id: string;
  /** 展示与匹配用的触发词，含前导斜杠。 */
  trigger: string;
  title: string;
  target: SlashTarget;
  requires?: SlashRequirement;
  /** 同义触发词（不含斜杠）。对齐 Grok 原生命令的别名，例如 /clear 等于 /new。 */
  aliases?: readonly string[];
  /**
   * 命令后面能不能跟一段文字。
   *
   * `prompt` 表示「先执行命令，再把余下的文字当提问发出去」——这是 Grok
   * `/plan <描述>` 的语义。不声明就表示不吃参数，带了参数会被明确拒绝，
   * 而不是把整行悄悄当成普通消息发给模型。
   */
  rest?: "prompt";
  /** 参数提示，出现在候选列表与 /help 里。 */
  restHint?: string;
}

export interface SlashState {
  canSwitchMode: boolean;
  canCancel: boolean;
  canSend: boolean;
}

export interface SlashCandidate {
  command: SlashCommand;
  disabledReason?: string;
}

function mode(id: string, label: string): SlashCommand {
  return {
    id,
    trigger: `/${id}`,
    title: `切换到 ${label} 模式`,
    target: { kind: "host", message: { type: "setMode", mode: id as "ask" } },
    requires: "switchMode",
    // 对齐 Grok 的 `/plan [description]`：切完模式顺手把这句话发出去，
    // 省掉「切模式 → 再打一遍需求」这两步。
    rest: "prompt",
    restHint: "要做的事（可留空）",
  };
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  mode("ask", "Ask"),
  mode("plan", "Plan"),
  mode("agent", "Agent"),
  mode("auto", "Auto"),
  mode("debug", "Debug"),
  {
    id: "new",
    trigger: "/new",
    title: "新建会话",
    target: { kind: "host", message: { type: "newSession" } },
    aliases: ["clear"],
  },
  {
    id: "stop",
    trigger: "/stop",
    title: "停止当前任务",
    target: { kind: "host", message: { type: "stop" } },
    requires: "cancel",
  },
  {
    id: "retry",
    trigger: "/retry",
    title: "重试上一轮",
    target: { kind: "client", action: "retry" },
    requires: "send",
  },
  {
    id: "compact",
    trigger: "/compact",
    title: "压缩上下文",
    target: { kind: "host", message: { type: "compactContext" } },
  },
  {
    id: "context",
    trigger: "/context",
    title: "查看上下文占用明细",
    target: { kind: "host", message: { type: "requestUsageDetail" } },
    aliases: ["usage", "cost"],
  },
  {
    id: "clear-context",
    trigger: "/clear-context",
    title: "清除待发送上下文",
    target: { kind: "host", message: { type: "clearContext" } },
  },
  { id: "changes", trigger: "/changes", title: "打开 Changes 工作台", target: { kind: "client", action: "openChanges" } },
  { id: "files", trigger: "/files", title: "打开 Files 工作台", target: { kind: "client", action: "openFiles" } },
  {
    id: "terminal",
    trigger: "/terminal",
    title: "打开 VS Code 原生终端",
    target: { kind: "host", message: { type: "openNativeTerminal" } },
  },
  {
    id: "browser",
    trigger: "/browser",
    title: "打开 VS Code Simple Browser",
    target: { kind: "host", message: { type: "openSimpleBrowser" } },
  },
  {
    id: "history",
    trigger: "/history",
    title: "打开历史会话",
    target: { kind: "host", message: { type: "openHistory" } },
    aliases: ["resume", "sessions"],
  },
  {
    id: "rules",
    trigger: "/rules",
    title: "打开设置 · 能力扩展（技能 / MCP）",
    target: { kind: "host", message: { type: "openExtensions" } },
    aliases: ["skills", "mcp", "mcps", "memory", "hooks"],
  },
  {
    id: "model",
    trigger: "/model",
    title: "打开设置 · 模型与服务商",
    target: { kind: "host", message: { type: "openModelSettings" } },
    aliases: ["m", "models"],
  },
  {
    id: "settings",
    trigger: "/settings",
    title: "打开设置",
    target: { kind: "host", message: { type: "openSettings" } },
    aliases: ["config", "preferences", "prefs"],
  },
  {
    id: "logs",
    trigger: "/logs",
    title: "查看运行日志",
    target: { kind: "host", message: { type: "showLogs" } },
    aliases: ["doctor"],
  },
  {
    id: "reconnect",
    trigger: "/reconnect",
    title: "重连 Agent",
    target: { kind: "host", message: { type: "reconnect" } },
  },
  { id: "help", trigger: "/help", title: "显示当前可用命令", target: { kind: "client", action: "help" } },
];

/**
 * Grok 有、但在灵动 Code 里输入不会被执行的命令。
 *
 * 这张表混着两类，别当成同一回事：
 *
 * 1. **真的只属于终端界面**：`/theme`、`/vim`、`/fullscreen`、`/minimal`、
 *    `/multiline`、`/timestamps` 之类，说的是 TUI 自己的渲染与输入方式，
 *    搬到这里没有意义。
 * 2. **Agent 侧支持，只是我们还没接**：`/goal`、`/workflow`、`/deep-research`
 *    这几个属于这一类。
 *
 * 第二类此前被记成「协议上做不到」，那是错的，已由 scripts/probe-slash-over-acp.mjs
 * 实测推翻：`agent stdio` 的 initialize._meta.availableCommands 里就列着
 * goal / workflow / deep-research / session-info…，`available_commands_update`
 * 还会推更新；把 `/session-info` 用 session/prompt 发过去，Agent 侧自己解析并回了
 * end_turn，全程没产生模型调用。所以拦住它们的是缺 UI 与编排，不是 ACP。
 * 接的时候按功能从这张表挪到 SLASH_COMMANDS，别只改文案。
 *
 * 两类共同的底线是一样的：别让这些词被当成普通消息发给模型。那样模型会一本正经地
 * 「执行」一个它根本没有的命令，用户还以为真做了。
 */
export const NATIVE_ONLY_COMMANDS: Readonly<Record<string, string>> = {
  imagine: "生成图片暂未接入，可以直接用一句话描述让 Agent 帮你处理。",
  "imagine-video": "生成视频暂未接入。",
  loop: "定时重复执行暂未接入。",
  goal: "自主目标模式暂未接入。",
  "deep-research": "深度研究工作流暂未接入。",
  workflow: "工作流暂未接入。",
  workflows: "工作流暂未接入。",
  dream: "记忆整理是 Grok 终端界面的命令，这里请用 /rules 管理记忆。",
  flush: "记忆落盘是 Grok 终端界面的命令，这里请用 /rules 管理记忆。",
  remember: "手动记一条记忆暂未接入，可以写进项目规则（/rules）。",
  fork: "会话分叉暂未接入，可以用 /new 开一个新会话。",
  rewind: "回退轮次暂未接入，可以在「变更」里撤销这一轮的改动。",
  undo: "回退轮次暂未接入，可以在「变更」里撤销这一轮的改动。",
  theme: "主题跟随编辑器，请在设置里改。",
  vim: "vim 模式是 Grok 终端界面的选项，这里不适用。",
  "vim-mode": "vim 模式是 Grok 终端界面的选项，这里不适用。",
  multiline: "输入框本来就是多行的，直接按 Shift+Enter 换行。",
  fullscreen: "全屏是 Grok 终端界面的选项，这里不适用。",
  minimal: "精简渲染是 Grok 终端界面的选项，这里不适用。",
  timestamps: "消息时间戳暂未接入。",
  tutorial: "新手引导暂未接入。",
  feedback: "反馈入口暂未接入。",
  login: "登录请在「模型与服务商设置」里配置密钥（/model）。",
  logout: "退出登录请在「模型与服务商设置」里清除密钥（/model）。",
  privacy: "隐私设置请在设置里查看（/settings）。",
  export: "导出会话暂未接入。",
  copy: "复制回复请用消息上的复制按钮。",
  btw: "插话直接发一条普通消息即可，不需要命令。",
};

/** 命令词的形状：字母开头、只含字母数字与连字符。 */
const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;

/**
 * 命令 + 参数 → 要发给宿主的消息序列。
 *
 * 切模式类命令带参数时会被合成成一条 sendPrompt：模式与提问必须原子地一起过去，
 * 否则提问可能赶在 `session/set_mode` 回来之前发出，在旧模式里执行。
 */
export function slashHostMessages(command: SlashCommand, rest: string): WebviewToHostMessage[] {
  if (command.target.kind !== "host") return [];
  const text = rest.trim();
  const target = command.target.message;
  if (!text || command.rest !== "prompt") return [target];
  if (target.type === "setMode") return [{ type: "sendPrompt", text, mode: target.mode }];
  return [target, { type: "sendPrompt", text }];
}

/** 只从允许列表取命令；未注册的 id 与别名一律返回 undefined。 */
export function findSlashCommand(id: string): SlashCommand | undefined {
  const needle = id.trim().toLowerCase();
  if (!needle) return undefined;
  return SLASH_COMMANDS.find(
    (command) => command.id === needle || command.aliases?.includes(needle),
  );
}

function disabledReason(command: SlashCommand, state: SlashState): string | undefined {
  if (command.requires === "switchMode" && !state.canSwitchMode) {
    return "当前任务执行中，暂时不能切换模式";
  }
  if (command.requires === "cancel" && !state.canCancel) return "当前没有正在执行的任务";
  if (command.requires === "send" && !state.canSend) return "当前任务执行中，暂时不能重试";
  return undefined;
}

/** 按前缀过滤命令；不可用的命令保留但禁用，让用户知道原因而不是凭空消失。 */
export function filterSlashCommands(query: string, state: SlashState): SlashCandidate[] {
  const needle = query.trim().toLowerCase();
  return SLASH_COMMANDS
    .filter((command) => matches(command, needle))
    .map((command) => {
      const reason = disabledReason(command, state);
      return { command, ...(reason ? { disabledReason: reason } : {}) };
    });
}

function matches(command: SlashCommand, needle: string): boolean {
  if (command.id.startsWith(needle) || command.id.includes(needle)) return true;
  // 别名也参与匹配：输入 /mcp 要能找到「Agent 能力」这一条。
  return command.aliases?.some((alias) => alias.startsWith(needle)) === true;
}

/** parseSlashInput 的判定结果。 */
export type SlashParse =
  /** 命中本地命令。rest 是命令词之后的文字，已去掉首尾空白。 */
  | { kind: "command"; command: SlashCommand; rest: string }
  /** Grok 终端界面才有的命令：要明确拒绝，绝不能当普通消息发出去。 */
  | { kind: "unsupported"; word: string; reason: string }
  /** 不像命令（例如「/tmp 下的脚本坏了」），按普通提问处理。 */
  | { kind: "prompt" };

/**
 * 判断一次提交到底是命令还是提问。
 *
 * 这里的分界线很关键：只有「命令词形状」且确实在两张表里的输入才算命令，
 * 其余一律当提问。以路径开头的正常提问（`/tmp 下的脚本坏了`、`/usr/bin 里有什么`）
 * 因此不会被误吞。
 */
export function parseSlashInput(text: string): SlashParse {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "prompt" };
  const body = trimmed.slice(1);
  const match = /^(\S+)([\s\S]*)$/.exec(body);
  if (!match) return { kind: "prompt" };
  const word = (match[1] ?? "").toLowerCase();
  const rest = (match[2] ?? "").trim();
  if (!COMMAND_WORD.test(word)) return { kind: "prompt" };

  const command = findSlashCommand(word);
  if (command) return { kind: "command", command, rest };

  const reason = NATIVE_ONLY_COMMANDS[word];
  if (reason) return { kind: "unsupported", word, reason };
  return { kind: "prompt" };
}

export interface SlashQuery {
  /** `/` 在输入串中的下标。 */
  start: number;
  /** 斜杠之后的命令词。 */
  query: string;
  /** 命令词结束位置，用于确认后清理输入框。 */
  end: number;
}

/**
 * 识别开头的 `/command`。
 *
 * 只有首个非空字符是 `/`、且光标仍在这个词内时才算命令，
 * 因此「/tmp 下的脚本坏了」这类正常提问不会被当成命令执行。
 */
export function readSlashQuery(text: string, caret: number): SlashQuery | undefined {
  const start = text.length - text.trimStart().length;
  if (text[start] !== "/") return undefined;
  let end = start + 1;
  while (end < text.length && !/\s/.test(text[end] as string)) end += 1;
  if (caret < start + 1 || caret > end) return undefined;
  return { start, query: text.slice(start + 1, end), end };
}
