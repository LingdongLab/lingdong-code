import type { ProviderProtocol } from "./provider-types";

/**
 * 一次 Runtime 启动的真实画像。
 *
 * 隐私状态界面只读这里，不读设置也不写死文案——否则「已关闭」四个字就成了
 * 一句无法验证的承诺。这份对象在子进程启动成功时记录，字段全部来自
 * 实际生成的 config.toml 与实际构造出的子进程环境。
 */

export interface PrivacyChannelState {
  telemetry: boolean;
  traceUpload: boolean;
  mixpanel: boolean;
  externalOtel: boolean;
  feedback: boolean;
  autoUpdate: boolean;
  remoteFetch: boolean;
  webFetch: boolean;
}

export interface RuntimeModelProfile {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 只记域名，不记完整地址，避免把 path 里的信息带进日志。 */
  baseUrlHost: string;
  protocol: ProviderProtocol;
  /** 注入的环境变量名；值永远不进这份画像。 */
  envKeyName: string;
  /** 各通道的开关状态，true 表示开启。 */
  channels: PrivacyChannelState;
  /** config.toml 的实际路径，便于用户自行核对。 */
  configFile: string;
  grokHome: string;
  startedAt: number;
}

/**
 * 托管启动的通道画像：遥测类全部强制关闭（config.toml + 环境变量双通道）；
 * webFetch 刻意开启——联网搜索/抓取是功能需求，抓取受 Grok 的 SSRF 防护
 * 与本扩展权限矩阵约束。
 */
export const MANAGED_CHANNELS: PrivacyChannelState = {
  telemetry: false,
  traceUpload: false,
  mixpanel: false,
  externalOtel: false,
  feedback: false,
  autoUpdate: false,
  remoteFetch: false,
  webFetch: true,
};
