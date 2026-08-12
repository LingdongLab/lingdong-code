import { execFile } from "node:child_process";

/**
 * 跑一次 `grok inspect --json`。
 *
 * 单独成文件是为了让解析与渲染保持纯函数：诊断报告的单测不需要真的拉起子进程。
 */

export interface InspectRunOptions {
  executable: string;
  cwd: string;
  grokHome?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface InspectRunResult {
  json?: string;
  error?: string;
}

export async function runGrokInspect(options: InspectRunOptions): Promise<InspectRunResult> {
  const env: NodeJS.ProcessEnv = options.grokHome
    ? { ...(options.env ?? process.env), GROK_HOME: options.grokHome }
    : { ...(options.env ?? process.env) };

  return new Promise<InspectRunResult>((resolve) => {
    execFile(
      options.executable,
      ["--no-auto-update", "inspect", "--json"],
      {
        cwd: options.cwd,
        env,
        timeout: options.timeoutMs ?? 15_000,
        // inspect 的输出会随规则文件数量增长，给足缓冲避免被截断。
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          resolve({ error: detail });
          return;
        }
        resolve({ json: stdout });
      },
    );
  });
}
