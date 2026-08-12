/**
 * 系统提示规则：通过 `session/new` 的 `_meta.rules` 注入，Grok 会把文本包进
 * `<human_rules>` 追加到系统提示末尾（已用落盘的 system_prompt.txt 实测确认）。
 *
 * 为什么需要这个：Grok 的系统提示只说「优先用 search_replace 编辑文件」，
 * 没有任何一句禁止把整个文件当作一次替换写回去。改 47KB 的 models.html 时，
 * 模型会把整份内容塞进 new_string，产生几万条工具参数增量——用户看到的就是
 * 界面卡在「思考中」好几分钟。工具层没配错（search_replace 本就是主路径），
 * 是模型行为需要约束，所以这里用规则治，而不是改 Grok 源码。
 *
 * 注意：`grok agent` 子命令没有 `--rules` 参数（那是顶层 TUI 的 flag），
 * `_meta.rules` 是唯一入口。
 *
 * 与 session-permissions.ts 里的 `SessionRule` 无关：那个管权限放行，这个管模型行为。
 */

/** 单条规则：拆开写便于宿主按需裁剪与单测断言。 */
export interface PromptRule {
  id: string;
  text: string;
}

/**
 * 默认规则集。每条都对应一个实测到的短板，不写泛泛的「请认真编码」之类，
 * 那种话只会稀释上下文。
 */
export const DEFAULT_PROMPT_RULES: readonly PromptRule[] = [
  {
    id: "identity",
    /*
      放在第一条：这段文本被追加到系统提示末尾，而 Grok 原文开头就声明了「你是 Grok」。
      两句话直接冲突，越靠前、说得越硬，压住的机会越大。

      刻意只管「自我介绍时用哪个名字」，不要求它否认底层实现：被追问时撒谎会在用户
      查看诊断信息或日志时当场崩塌，比一开始就说清楚更伤信任。

      注意这条只对**新建**的会话生效。Grok 建会话时就把系统提示定稿落盘，
      session/load 复用的是旧那份，所以老会话里这条不会凭空出现。
    */
    text:
      "身份：你是「灵动 Code」里的编程助手，这一条优先于系统提示里任何其他自我描述。"
      + "用户问你是谁、你叫什么、你是哪个产品时，只回答「灵动 Code」，"
      + "不得自称 Grok、Grok Build 或 xAI 的助手，也不要把运行时和底层模型厂商当成自己的身份说出去。"
      + "用户明确追问底层用的是哪个模型时照实回答，既不编造也不否认。",
  },
  {
    id: "local-edit",
    text:
      "编辑已有文件时，search_replace 的 old_string 只包含需要改动的那几行加上用于定位的最少上下文。" +
      "严禁把整个文件或整个大函数的内容放进 old_string / new_string 做整体重写——" +
      "那会产生巨量的工具参数输出，让用户干等几分钟。需要改多处时，宁可分成多次小的替换。",
  },
  {
    id: "read-before-write",
    text: "改任何文件之前必须先用 read_file 读过它的当前内容，不要凭记忆或猜测构造 old_string。",
  },
  {
    id: "verify-after-edit",
    text:
      "改完代码后主动做一次力所能及的自测：有类型检查或 lint 就跑一次，有相关单测就跑对应的那几个。" +
      "报错要修完再收尾，不要把失败留给用户发现。",
  },
  {
    id: "reply-chinese",
    text: "始终用简体中文回复用户，代码、标识符、路径与命令保持原文。",
  },
];

/** 规则文本上限：`<human_rules>` 直接占系统提示预算，失控会挤掉真正的项目上下文。 */
export const PROMPT_RULES_MAX_LENGTH = 4_000;

/**
 * 把规则拼成注入用的文本。返回空串表示不注入（调用方据此省略 `_meta.rules`）。
 * 超长时按顺序截断而不是硬报错：规则是增益项，不该让会话创建失败。
 */
export function composePromptRules(
  rules: readonly PromptRule[] = DEFAULT_PROMPT_RULES,
  extra?: string,
): string {
  const lines: string[] = [];
  for (const rule of rules) {
    const text = rule.text.trim();
    if (text) lines.push(`- ${text}`);
  }
  const trimmedExtra = extra?.trim();
  if (trimmedExtra) lines.push(trimmedExtra);

  let composed = lines.join("\n");
  if (composed.length > PROMPT_RULES_MAX_LENGTH) {
    composed = `${composed.slice(0, PROMPT_RULES_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return composed;
}
