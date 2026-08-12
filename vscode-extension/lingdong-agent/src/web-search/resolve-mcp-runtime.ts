/**
 * 解析适合拉起 MCP stdio 脚本的 Node 运行时。
 *
 * 扩展宿主里 `process.execPath` 是 Code.exe / Cursor.exe，不是 node：
 * 直接拿它跑 .js 会弹窗或挂死，表现为「lingdong_web 连接超时」。
 * 优先 PATH 上的 node；找不到则用 Electron 的 ELECTRON_RUN_AS_NODE=1。
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface McpRuntime {
  command: string;
  /** 写进 config.toml [mcp_servers.*.env]；空对象表示不需要额外环境变量。 */
  env: Readonly<Record<string, string>>;
}

export function resolveMcpRuntime(
  options: {
    execPath?: string;
    platform?: NodeJS.Platform;
    /** 注入时可覆盖 PATH 探测（测试用）；传入则不再调用系统 which/where。 */
    whichNode?: () => string | undefined;
  } = {},
): McpRuntime {
  const fromPath = options.whichNode
    ? options.whichNode()
    : findNodeOnPath(options.platform ?? process.platform);
  if (fromPath) return { command: fromPath, env: {} };

  const execPath = options.execPath ?? process.execPath;
  // VS Code / Cursor / Electron：以 Node 模式执行脚本，避免再开一个编辑器窗口。
  return {
    command: execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function findNodeOnPath(platform: NodeJS.Platform): string | undefined {
  try {
    const cmd = platform === "win32" ? "where" : "which";
    const output = execFileSync(cmd, ["node"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first && existsSync(first)) return first;
  } catch {
    // PATH 里没有 node
  }
  return undefined;
}
