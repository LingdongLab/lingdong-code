import type { RuntimeModelProfile } from "../models/providers/runtime-model-profile";

/**
 * 隐私状态文档。
 *
 * 每一行都来自实际生成的配置与实际构造出的子进程环境，没有写死的「已关闭」。
 * 未连接时如实说未连接，而不是把设置里的期望值当成运行状态展示——
 * 那样这份文档就退化成一句无法验证的承诺。
 */

export interface PrivacyStatusInput {
  profile: RuntimeModelProfile | undefined;
  /** 当前 Provider 是否已配置凭据；只有布尔值，不含 Key 本身。 */
  keyConfigured: boolean;
  /** 托管 GROK_HOME 是否启用。 */
  managedHome: boolean;
  /** 强制写入子进程的隐私环境变量，用于逐条列出。 */
  privacyEnv: Readonly<Record<string, string>>;
  /** 从子进程环境里剥离的凭据变量名。 */
  strippedCredentials: readonly string[];
}

function onOff(enabled: boolean): string {
  return enabled ? "已开启" : "已关闭";
}

export function renderPrivacyStatus(input: PrivacyStatusInput): string {
  const lines: string[] = ["# 灵动 Code 隐私状态", ""];
  const profile = input.profile;

  lines.push("## 当前模型");
  lines.push("");
  if (!profile) {
    lines.push("尚未连接 Grok，本次会话还没有产生真实的运行画像。");
    lines.push("下面的通道状态在连接建立后才会反映实际配置。");
  } else {
    lines.push(`- 当前 Provider：${profile.providerName}`);
    lines.push(`- 当前模型：${profile.modelName}（${profile.modelId}）`);
    lines.push(`- 模型请求域名：${profile.baseUrlHost}`);
    lines.push(`- 请求协议：${profile.protocol}`);
    lines.push(`- 凭据环境变量：${profile.envKeyName}（值不显示）`);
    lines.push(`- 连接时间：${new Date(profile.startedAt).toLocaleString()}`);
  }
  lines.push("");

  lines.push("## 网络通道");
  lines.push("");
  if (profile) {
    const channels = profile.channels;
    lines.push(`- 遥测：${onOff(channels.telemetry)}`);
    lines.push(`- Trace 上传：${onOff(channels.traceUpload)}`);
    lines.push(`- Mixpanel：${onOff(channels.mixpanel)}`);
    lines.push(`- 外部 OTEL：${onOff(channels.externalOtel)}`);
    lines.push(`- Feedback：${onOff(channels.feedback)}`);
    lines.push(`- 自动更新：${onOff(channels.autoUpdate)}`);
    lines.push(`- 远程目录抓取：${onOff(channels.remoteFetch)}`);
    lines.push(`- Grok 自带 web_fetch：${onOff(channels.webFetch)}`);
  } else {
    lines.push("未连接，无法读取实际通道状态。");
  }
  if (input.managedHome) {
    lines.push("- 内置 backend Web Search：已关闭（deny WebSearch；第三方模型不支持）");
    lines.push("- 宿主侧 Web Search：已开启（MCP lingdong_web → DuckDuckGo；查询不经对话模型供应商）");
    lines.push("- 宿主侧 Web Fetch：已开启（MCP lingdong_web；读网页正文走宿主，不经对话模型供应商）");
  } else {
    lines.push("- Web Search：状态未知（托管目录已关闭，config.toml 不由扩展生成）");
  }
  lines.push("");

  lines.push("## 凭据");
  lines.push("");
  lines.push(`- API Key：${input.keyConfigured ? "已配置" : "未配置"}`);
  lines.push("- 保存位置：VS Code SecretStorage（系统凭据库）");
  lines.push("- 不写入：settings.json、config.toml、会话记录、时间线、日志与报告");
  if (input.strippedCredentials.length > 0) {
    lines.push(`- 已从子进程环境剥离：${input.strippedCredentials.join("、")}`);
  }
  lines.push("");

  lines.push("## 配置来源");
  lines.push("");
  lines.push(`- 托管 GROK_HOME：${input.managedHome ? "已启用" : "已关闭"}`);
  if (profile?.grokHome) lines.push(`- GROK_HOME：${profile.grokHome}`);
  if (profile?.configFile) lines.push(`- config.toml：${profile.configFile}`);
  if (!input.managedHome) {
    lines.push("");
    lines.push("托管目录已关闭，config.toml 不由扩展生成，");
    lines.push("上面的 remote_fetch、telemetry、auto_update 等开关无法保证。");
  }
  lines.push("");

  lines.push("## 强制写入的环境变量");
  lines.push("");
  for (const [name, value] of Object.entries(input.privacyEnv)) {
    lines.push(`- ${name}=${value}`);
  }
  lines.push("");

  lines.push("## 说明");
  lines.push("");
  lines.push("以上状态来自本次启动实际生成的配置与实际构造的子进程环境，不是固定文案。");
  lines.push("配置层面的关闭动作已完成，但网络行为仍待抓包验收：");
  lines.push("请用 TCPView、资源监视器或代理观察 grok.exe 的实际连接目标。");

  return `${lines.join("\n")}\n`;
}
