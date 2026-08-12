/**
 * 生成 Grok 的 hooks JSON。
 *
 * 落点是托管 GROK_HOME 下的 `hooks/`，按文档属于「Global，Always trusted」，
 * 因此不需要 `/hooks-trust`；写在项目的 `.grok/hooks/` 里则要用户先信任目录，
 * 那对开箱即用是致命的。
 *
 * 事件与字段名来自 0.2.118 的 10-hooks.md。
 */

export interface VerifyHooksInput {
  /** 交给 shell 的完整命令行，已按需加好引号。 */
  commandLine: string;
  /** 例如 ELECTRON_RUN_AS_NODE=1（用 Code.exe 当 Node 时必需）。 */
  env?: Readonly<Record<string, string>>;
  /** Stop 门控超时秒数；默认给足，构建与类型检查经常要几分钟。 */
  timeoutSecs?: number;
}

/** 编辑类工具的 matcher。Grok 把 Claude 的 Edit/Write/MultiEdit 映射到 search_replace，
 *  但 matcher 同时保留原名，所以两边都写上最稳。 */
export const EDIT_TOOL_MATCHER = "search_replace|apply_patch|Edit|Write|MultiEdit";

export function renderVerifyHooks(input: VerifyHooksInput): string {
  const handler = (extra: Record<string, unknown> = {}) => ({
    type: "command",
    command: input.commandLine,
    ...(input.env && Object.keys(input.env).length > 0 ? { env: { ...input.env } } : {}),
    ...extra,
  });

  const document = {
    // 这份文件由扩展整份重写，注释只能靠一个约定字段承载。
    _lingdong: "由灵动 Code 生成，请勿手工编辑。改动会在下次启动时被覆盖。",
    hooks: {
      // 新一轮开始就清空上一轮的脏标记与拦截计数。
      UserPromptSubmit: [{ hooks: [handler()] }],
      // 只关心编辑类工具：没改文件就不该跑校验。
      PostToolUse: [{ matcher: EDIT_TOOL_MATCHER, hooks: [handler()] }],
      // 真正的门：改完没过校验就把错误回灌，让模型在同一轮里继续修。
      Stop: [{ hooks: [handler({ timeout: input.timeoutSecs ?? 900 })] }],
    },
  };

  return `${JSON.stringify(document, undefined, 2)}\n`;
}

/** 给 shell 用的引号包裹；Windows 上路径带空格是常态。 */
export function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** 把运行时与脚本路径拼成 hooks 用的命令行。 */
export function composeHookCommandLine(runtime: string, scriptPath: string): string {
  return `${quoteArg(runtime)} ${quoteArg(scriptPath)}`;
}
