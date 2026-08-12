/**
 * 首次运行卡在哪一步。
 *
 * 装机版第一次打开时，用户手上什么都没有：没有工作区，也没填过 API Key。
 * 这两件事都会让第一条消息直接失败——前者在 RuntimeBootstrap.start 就抛，
 * 后者要等消息发出去才报错。与其让人撞上去，不如在侧栏里先说清楚下一步做什么。
 *
 * 这里只做判断，不碰 vscode，方便直接测。判断结果由调用方写进 context key，
 * package.json 的 viewsWelcome 按它分支。
 */

/** viewsWelcome 的 `when` 里比对的 context key。 */
export const FIRST_RUN_CONTEXT_KEY = "lingdongAgent.firstRun";

/**
 * 取值刻意不用连字符。when 子句是表达式语法，`firstRun == no-workspace` 里的
 * 那个短横会被当成减号，整条表达式失配——结果是三个分支一个都不显示，
 * 视图空成一片，而且不报任何错。
 */
export type FirstRunGate = "noWorkspace" | "noApiKey" | "ready";

/**
 * 顺序是有讲究的：先看工作区。没有工作区时连 Grok 都不会启动，
 * 这时候引导用户去填 Key 是让他白跑一趟。
 */
export function firstRunGate(input: { hasWorkspace: boolean; hasApiKey: boolean }): FirstRunGate {
  if (!input.hasWorkspace) return "noWorkspace";
  if (!input.hasApiKey) return "noApiKey";
  return "ready";
}
