import * as path from "node:path";
import type { LspPreset } from "./lsp-presets";

/**
 * 找出预置 language server 在本机的真实路径（可测的纯逻辑，文件存在性由外部注入）。
 *
 * 为什么不直接把命令名写进 lsp.json：Grok 用 `Command::new` 直接拉起进程，
 * Windows 上既不会走 PATHEXT 补全，也不会用 shell 解析 `.cmd` 垫片。写裸名字的结果是
 * server 起不来，而失败只落在 Grok 自己的日志里——界面上表现为「LSP 配了但从来没生效」。
 * 所以这里必须解析出带扩展名的绝对路径，写不出来就干脆不写这一条。
 */

export interface DetectDeps {
  /** 探测路径是否存在（文件）。 */
  exists(absolutePath: string): Promise<boolean>;
  /** PATH 的原始值。 */
  pathEnv: string | undefined;
  /** Windows 的 PATHEXT；非 Windows 传 undefined。 */
  pathExt?: string | undefined;
  /** path.delimiter，Windows 是 `;`。测试里可覆盖。 */
  delimiter?: string;
  /** 当前活动仓库根；优先用仓库自己的 node_modules/.bin。 */
  workspaceRoot?: string | undefined;
}

export type LspSource = "workspace" | "path";

export interface LspDetection {
  id: string;
  /** 解析到的绝对路径；找不到时为 undefined。 */
  command?: string;
  source?: LspSource;
}

function candidateNames(binary: string, pathExt: string | undefined): string[] {
  if (!pathExt) return [binary];
  // PATHEXT 惯例是大写（`.COM;.EXE;.BAT;.CMD`），而磁盘上的文件名是小写。
  // Windows 文件系统不区分大小写，但写进 lsp.json 的路径要跟真实文件一致，
  // 免得用户对着一个大小写不符的路径怀疑我们探测错了。
  const exts = pathExt
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  // 带后缀的候选优先：node_modules/.bin 下同时存在无后缀的 shell 脚本与 .cmd 垫片，
  // 前者在 Windows 上根本跑不起来。
  return [...exts.map((ext) => `${binary}${ext}`), binary];
}

async function firstExisting(
  dir: string,
  names: readonly string[],
  exists: DetectDeps["exists"],
): Promise<string | undefined> {
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export async function detectLspServer(preset: LspPreset, deps: DetectDeps): Promise<LspDetection> {
  const delimiter = deps.delimiter ?? (deps.pathExt ? ";" : ":");
  const pathDirs = (deps.pathEnv ?? "")
    .split(delimiter)
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const binDir = deps.workspaceRoot
    ? path.join(deps.workspaceRoot, "node_modules", ".bin")
    : undefined;

  for (const binary of preset.binaryNames) {
    const names = candidateNames(binary, deps.pathExt);
    if (binDir) {
      const local = await firstExisting(binDir, names, deps.exists);
      if (local) return { id: preset.id, command: local, source: "workspace" };
    }
    for (const dir of pathDirs) {
      const found = await firstExisting(dir, names, deps.exists);
      if (found) return { id: preset.id, command: found, source: "path" };
    }
  }
  return { id: preset.id };
}

export async function detectLspServers(
  presets: readonly LspPreset[],
  deps: DetectDeps,
): Promise<LspDetection[]> {
  const out: LspDetection[] = [];
  for (const preset of presets) out.push(await detectLspServer(preset, deps));
  return out;
}
