import type { GrokVersionInfo } from "@lingdong/agent-runtime";

export interface VersionNotice {
  level: "info" | "warn";
  message: string;
}

/**
 * 生成版本兼容性提示。灵动 Code 不会自动升级 Grok Build，
 * 未测试版本只提示，由用户决定是否继续尝试。
 */
export function buildVersionNotice(info: GrokVersionInfo, testedVersion: string): VersionNotice {
  if (!info.exists) {
    return { level: "warn", message: info.error ?? `未找到 Grok 可执行文件：${info.executable}` };
  }
  if (!info.version) {
    return {
      level: "warn",
      message: `无法解析 Grok Build 版本号。已测试版本：${testedVersion}${info.error ? `（${info.error}）` : ""}`,
    };
  }
  if (info.version === testedVersion) {
    return { level: "info", message: `Grok Build ${info.version}（已通过兼容性测试）` };
  }
  return {
    level: "warn",
    message: `当前 Grok Build 版本尚未经过兼容性测试。已测试版本：${testedVersion}；当前版本：${info.version}。`,
  };
}
