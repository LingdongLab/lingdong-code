import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

/**
 * 完成真实联调的 Grok Build 版本（开源默认对接官方预编译通道）。
 *
 * `scripts/fetch-grok.ps1` 拉取的是 xAI 官方安装产物；换大版本时请同步改这里，
 * 否则启动会提示「未测试版本」。若你改用自建 grok-build，把常量改成自建版本号即可。
 */
export const TESTED_GROK_VERSION = "0.2.118";

export interface GrokVersionInfo {
  executable: string;
  exists: boolean;
  raw?: string;
  version?: string;
  tested: boolean;
  error?: string;
}

function parseVersion(raw: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(raw)?.[1];
}

async function runVersionCommand(executable: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      { env, timeout: timeoutMs, windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(`${stdout}${stderr}`.trim());
      },
    );
  });
}

/**
 * 检查 Grok 可执行文件是否存在，并读取版本号。
 * 不会自动升级，也不会修改任何 Grok 配置。
 */
export async function detectGrokVersion(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
): Promise<GrokVersionInfo> {
  try {
    await access(executable, constants.X_OK);
  } catch {
    return { executable, exists: false, tested: false, error: `未找到 Grok 可执行文件：${executable}` };
  }

  try {
    const raw = await runVersionCommand(executable, env, timeoutMs);
    const version = parseVersion(raw);
    return {
      executable,
      exists: true,
      raw,
      ...(version ? { version } : {}),
      tested: version === TESTED_GROK_VERSION,
    };
  } catch (error) {
    return {
      executable,
      exists: true,
      tested: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
