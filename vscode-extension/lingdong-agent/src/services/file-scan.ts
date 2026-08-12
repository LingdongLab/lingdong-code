import * as path from "node:path";
import type { DirectoryEntry } from "../file-system-port";

/**
 * 列举一个目录下的文件，只返回相对路径。
 *
 * 为什么不用 `vscode.workspace.findFiles`：那个 API 只看 VS Code 自己的工作区。
 * 活动仓库跟工作区解耦之后，agent 操作的目录可能根本不在 workspaceFolders 里，
 * findFiles 会一个文件都不返回——界面上表现为 Files 面板和 @ 候选突然空了，
 * 而且不报错。
 *
 * 广度优先，不是深度优先。带上限的遍历里这一点决定了结果有不有用：
 * 深度优先会先把某一条深路径走到底，1000 条配额可能全花在一个子目录里；
 * 广度优先先给浅层，截断时留下的正是用户最可能要的那些。
 */

/** 与原先那条 exclude glob 保持一致，改这里等于改全部三个调用点。 */
export const EXCLUDED_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".lingdong",
];

/** 只依赖列目录这一件事，`FileSystemPort` 天然满足。 */
export interface ScanPort {
  listEntries(absolutePath: string): Promise<DirectoryEntry[]>;
}

export interface ScanResult {
  /** 相对根的 POSIX 路径，已排序。 */
  readonly files: readonly string[];
  /** 是否因为撞上上限而没走完。 */
  readonly truncated: boolean;
}

function excluded(name: string): boolean {
  return EXCLUDED_DIRECTORIES.includes(name);
}

export async function scanFiles(
  root: string,
  options: { readonly limit: number; readonly fs: ScanPort },
): Promise<ScanResult> {
  if (options.limit <= 0) return { files: [], truncated: false };

  const files: string[] = [];
  // 队列里存的是相对路径，"" 代表根本身。
  let frontier: string[] = [""];
  let truncated = false;

  while (frontier.length > 0 && files.length < options.limit) {
    const next: string[] = [];
    for (const relativeDir of frontier) {
      if (files.length >= options.limit) {
        truncated = true;
        break;
      }
      const absolute = relativeDir ? path.join(root, relativeDir) : root;
      // listEntries 读不动时返回空数组，权限不足的子目录只是被跳过。
      for (const entry of await options.fs.listEntries(absolute)) {
        const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          if (!excluded(entry.name)) next.push(relative);
          continue;
        }
        if (files.length >= options.limit) {
          truncated = true;
          break;
        }
        files.push(relative);
      }
    }
    frontier = next;
  }
  // 还有没走完的目录也算截断，否则界面会把不完整的结果当成全部。
  if (frontier.length > 0) truncated = true;

  files.sort((left, right) => left.localeCompare(right, "zh"));
  return { files, truncated };
}
