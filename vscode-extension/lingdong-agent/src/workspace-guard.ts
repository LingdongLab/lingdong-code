import path from "node:path";

/**
 * Extension Host 侧的第二道路径校验。
 * Webview 传来的任何路径都必须重新解析，不能相信 UI 给出的结论。
 */
export function isInsideWorkspace(workspace: string, candidate: string): boolean {
  const root = path.resolve(workspace);
  const target = path.resolve(root, candidate);
  const relative = path.relative(root, target);
  if (relative === "") return true;
  if (relative.startsWith("..")) return false;
  return !path.isAbsolute(relative);
}

export function resolveInsideWorkspace(workspace: string, candidate: string): string | undefined {
  if (!isInsideWorkspace(workspace, candidate)) return undefined;
  return path.resolve(path.resolve(workspace), candidate);
}
