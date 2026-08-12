/**
 * 构造 Grok 子进程的环境变量。
 *
 * 之前的做法是把 `process.env` 整包 spread 进子进程，于是有两个后果：
 * 一是宿主环境里任何模型凭据都会被交给 Grok，二是 Grok 的凭据解析链最后会退到
 * `XAI_API_KEY`，「不自动回退 xAI」只是纸面承诺。这里把两件事都堵住：
 * 剥掉全部已知的模型凭据，只注入扩展自己管理的 `LINGDONG_KEY_*` 凭据。
 *
 * 注入范围是**所有已启用且配置了密钥的 Provider**（对标 Cursor 的免重连切模：
 * 密钥都在，`session/set_model` 就能跨 Provider 秒切）。宿主环境里的其他
 * 凭据仍然全部剥离，凭据只会发给用户自己启用过的服务商。
 *
 * 隐私变量每次都显式写入，因此父进程里已经开启的值会被覆盖。
 * 变量名全部取自本机 Grok 0.2.118 随包文档，没有猜的。
 */

/**
 * 需要从继承环境里剥离的模型凭据。
 *
 * 用具名列表而不是 `/_KEY$/` 之类的正则：Grok 的 bash 工具会跑用户的脚本，
 * 一刀切地抹掉所有形似凭据的变量会连带弄坏跟模型无关的工具链。
 */
export const CREDENTIAL_DENY_LIST = [
  // xAI 自身与其向后兼容别名；不剥掉它，Grok 的凭据链最后一步就会悄悄回退。
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "POE_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "PERPLEXITY_API_KEY",
  "FIREWORKS_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  // Grok 的企业管理密钥与遥测上报凭据。
  "GROK_DEPLOYMENT_KEY",
] as const;

/**
 * 强制写入的隐私变量。
 *
 * 注意这只是双通道里的一条：文档明确写着部分键 TOML 优先于 env
 * （`[toolset.web_fetch] allow_local` 就是「TOML > env」），而 `remote_fetch`
 * 根本没有对应的环境变量。所以必须同时托管 config.toml。
 */
export const PRIVACY_ENV: Readonly<Record<string, string>> = {
  GROK_TELEMETRY_ENABLED: "0",
  GROK_TELEMETRY_TRACE_UPLOAD: "0",
  GROK_TELEMETRY_MIXPANEL_ENABLED: "0",
  GROK_EXTERNAL_OTEL: "0",
  GROK_FEEDBACK_ENABLED: "0",
  GROK_DISABLE_AUTOUPDATER: "1",
};

/** 单个待注入的 Provider 凭据。 */
export interface InjectedCredential {
  name: string;
  value: string;
}

export interface ChildEnvInput {
  parent: NodeJS.ProcessEnv;
  grokHome?: string;
  /** 待注入的凭据；只接受扩展自己管理的 LINGDONG_KEY_* 槽位。 */
  credentials?: readonly InjectedCredential[];
  /**
   * 跨会话记忆开关。两种状态都显式写 GROK_MEMORY：
   * 它的优先级高于 config.toml，父进程里若已有 `GROK_MEMORY=1`，
   * 只写 config 关不掉，用户以为关了其实还在往磁盘写。
   */
  memoryEnabled?: boolean;
  /**
   * Grok 自带 web_fetch（抓取网页正文）开关。默认关：宿主已经内置了
   * lingdong_web MCP 的 WebFetch，两者功能重叠，开着只会让模型在同类工具间摇摆。
   *
   * 两种状态都显式写 GROK_WEB_FETCH——它是跨 0.2.118/1.0.0 都生效的启停开关。
   * Grok 侧默认虽然也是关的，但父进程环境里若已有 GROK_WEB_FETCH=1 就会被继承进来，
   * 所以「关」这一侧同样得显式写 0，不能靠默认值。
   */
  webFetchEnabled?: boolean;
}

export function buildChildEnv(input: ChildEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.parent };

  for (const name of CREDENTIAL_DENY_LIST) delete env[name];
  // 之前某个 Provider 注入过的槽位也要清掉，否则被禁用的 Provider 凭据还留在环境里。
  for (const name of Object.keys(env)) {
    if (name.startsWith("LINGDONG_KEY_") || name.startsWith("LINGDONG_MCP_")) {
      delete env[name];
    }
  }

  for (const [name, value] of Object.entries(PRIVACY_ENV)) env[name] = value;
  env.GROK_MEMORY = input.memoryEnabled === true ? "1" : "0";
  env.GROK_WEB_FETCH = input.webFetchEnabled === true ? "1" : "0";
  if (input.grokHome) env.GROK_HOME = input.grokHome;

  for (const credential of input.credentials ?? []) {
    if (credential.value.trim() !== "") env[credential.name] = credential.value;
  }

  return env;
}

/** 供隐私状态界面核对：列出当前环境里还留着的凭据变量名（不含值）。 */
export function injectedCredentialNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith("LINGDONG_KEY_"))
    .sort();
}
