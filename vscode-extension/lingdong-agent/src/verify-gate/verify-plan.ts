/**
 * 校验闭环的纯逻辑：跑什么命令、什么时候拦住 Agent。
 *
 * 存在的理由：此前 Agent 改完代码就收尾，类型错误留给用户自己发现——
 * `verification-parser` 只是把模型自己声称的自测结果展示出来，没有任何强制力。
 * Grok 的 `Stop` 钩子是可阻断事件（agentCapabilities 里明确声明
 * `blockingEvents: ["pre_tool_use","stop","subagent_stop"]`），钩子返回
 * `{"decision":"block","reason":...}` 就能把错误回灌给模型让它在同一轮里继续修。
 *
 * IO 全部留在 verify-gate.ts，这里只做判断，才能不起子进程地单测。
 */

export interface VerifyCommand {
  /** 供展示与日志的人类可读名字。 */
  label: string;
  /** 交给 shell 执行的完整命令行。 */
  commandLine: string;
}

/**
 * 选校验命令。只跑项目自己声明过的脚本，绝不自作聪明地发明命令：
 * 在别人的仓库里跑一条它从没跑过的命令，失败几乎必然，回灌的还是假错误。
 *
 * 优先级：typecheck > lint > 有 tsconfig 时的 tsc --noEmit。
 */
export function chooseVerifyCommand(
  packageJsonText: string | undefined,
  hasTsconfig: boolean,
): VerifyCommand | undefined {
  const scripts = readScripts(packageJsonText);

  if (scripts.has("typecheck")) return { label: "npm run typecheck", commandLine: "npm run typecheck" };
  if (scripts.has("type-check")) return { label: "npm run type-check", commandLine: "npm run type-check" };
  if (scripts.has("tsc")) return { label: "npm run tsc", commandLine: "npm run tsc" };
  if (scripts.has("lint")) return { label: "npm run lint", commandLine: "npm run lint" };
  // 没有任何脚本但有 tsconfig：tsc --noEmit 是唯一足够通用、不会有副作用的兜底。
  if (hasTsconfig) return { label: "tsc --noEmit", commandLine: "npx --no-install tsc --noEmit" };
  return undefined;
}

function readScripts(packageJsonText: string | undefined): Set<string> {
  if (!packageJsonText) return new Set();
  try {
    const parsed: unknown = JSON.parse(packageJsonText);
    if (typeof parsed !== "object" || parsed === null) return new Set();
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return new Set();
    return new Set(Object.keys(scripts as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

/** 一轮里最多拦几次。Grok 自己在 8 次续跑后强制结束，我们收得更紧。 */
export const MAX_BLOCKS_PER_TURN = 2;

export interface GateInput {
  /** Stop 事件的 reason；只有 `end_turn` 是真正的轮次结束。 */
  reason?: string;
  /** Grok 告知本轮是否已经因为钩子而续跑过。 */
  stopHookActive?: boolean;
  /** 本轮是否发生过文件编辑。没改文件就没有校验的必要。 */
  dirty: boolean;
  /** 本轮已经拦下多少次。 */
  blockCount: number;
  /** 是否有可用的校验命令。 */
  hasCommand: boolean;
  /** 是否还有后台任务在跑；有的话这次 stop 不是真的收尾。 */
  backgroundTaskCount?: number;
}

export type GateAction =
  | { kind: "allow"; why: string }
  | { kind: "verify" };

/**
 * 决定这次 Stop 要不要跑校验。
 *
 * 每一条放行都对应一个真实的坑：会话结束时也会补发一次 Stop（reason 不是
 * end_turn），拦它没有意义；没改过文件就跑 typecheck 纯属浪费用户几十秒；
 * 拦到上限还不放行会把用户困在一轮里出不来。
 */
export function decideStopGate(input: GateInput): GateAction {
  if (input.reason !== undefined && input.reason !== "end_turn") {
    return { kind: "allow", why: `不是真正的轮次结束（reason=${input.reason}）` };
  }
  if ((input.backgroundTaskCount ?? 0) > 0) {
    return { kind: "allow", why: "仍有后台任务在跑，本轮不算收尾" };
  }
  if (!input.dirty) return { kind: "allow", why: "本轮没有改动文件" };
  if (!input.hasCommand) return { kind: "allow", why: "项目未声明可用的校验命令" };
  if (input.blockCount >= MAX_BLOCKS_PER_TURN) {
    return { kind: "allow", why: `已连续拦下 ${input.blockCount} 次，交回给用户判断` };
  }
  return { kind: "verify" };
}

/**
 * 「工具本身跑不起来」的特征。
 *
 * 这条判断不是锦上添花，是这个功能能不能上线的前提：如果项目声明了 typecheck
 * 但机器上没装 tsc（没跑过 npm install 就是这样），失败输出与真正的类型错误
 * 长得完全不同，却会被同样地回灌给模型。模型看到「'tsc' 不是内部或外部命令」
 * 只会一脸茫然地乱改代码，而且每一轮都会被拦一次。这种情况必须放行。
 */
const TOOLING_FAILURE_PATTERNS: readonly RegExp[] = [
  // Windows cmd 的中英文两种说法。
  /不是内部或外部命令/,
  /is not recognized as an internal or external command/i,
  /无法将[\s\S]*?识别为/,
  // POSIX shell。
  /command not found/i,
  /: not found\b/,
  // Node / npm 侧。
  /\bENOENT\b/,
  /npm ERR! Missing script/i,
  /npm ERR! could not determine executable/i,
  /Cannot find module/i,
];

/**
 * 判断是否「工具跑不起来」。
 *
 * 传入多个解码变体是必要的：中文 Windows 的 shell 用 OEM 代码页（GBK）报这条错，
 * 按 UTF-8 解出来是乱码，正则一个都匹配不上——这个坑实测踩过。
 * 而 tsc / eslint 这些工具的输出本来就是 UTF-8，所以「UTF-8 解不出来」本身
 * 就是「这不是编译器诊断」的强信号。
 */
export function isToolingFailure(...variants: readonly string[]): boolean {
  return variants.some((output) => TOOLING_FAILURE_PATTERNS.some((pattern) => pattern.test(output)));
}

/** 回灌给模型的失败反馈上限；整段编译错误糊过去只会挤爆上下文。 */
export const FEEDBACK_MAX_LENGTH = 4_000;

/**
 * 拼回灌文本。要点是把「这是自动校验、请修完再收尾」说清楚，
 * 否则模型可能把它当成新需求，或者反过来只回一句「好的我会注意」。
 */
export function composeBlockReason(command: VerifyCommand, output: string): string {
  const trimmed = output.trim();
  // 编译器习惯把最有用的摘要放在末尾（错误计数、失败清单），截断要保尾部。
  const body = trimmed.length > FEEDBACK_MAX_LENGTH
    ? `…（已省略前面 ${trimmed.length - FEEDBACK_MAX_LENGTH} 字）\n${trimmed.slice(-FEEDBACK_MAX_LENGTH)}`
    : trimmed;
  return [
    `自动校验未通过：\`${command.label}\` 报错了。`,
    "这是灵动 Code 在你结束本轮前自动跑的检查，不是新需求。",
    "请根据下面的输出把问题修完，再结束本轮；如果确认是既有问题与本次改动无关，请明确说明原因。",
    "",
    body,
  ].join("\n");
}
