import * as path from "node:path";
import * as vscode from "vscode";
import { normalizeRelativePath } from "./context-model";
import { formatDiagnosticsBlock, type DiagnosticItem } from "./diagnostics-format";
import { isInsideWorkspace } from "./workspace-guard";

export type { DiagnosticItem } from "./diagnostics-format";
export { formatDiagnosticsBlock } from "./diagnostics-format";

/**
 * 从 VS Code 问题面板收集诊断，严格限制在工作区边界内。
 * 用于 Debug 模式的「@问题面板」上下文，不伪造条目。
 */

function mapSeverity(severity: vscode.DiagnosticSeverity): DiagnosticItem["severity"] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}

export function collectWorkspaceDiagnostics(
  workspaceRoot: string,
  maxItems = 80,
): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") continue;
    if (!isInsideWorkspace(workspaceRoot, uri.fsPath)) continue;
    // 相对路径按传进来的根算，不用 asRelativePath：后者相对的是 VS Code 的工作区，
    // 活动仓库不在 workspaceFolders 里时它会原样返回绝对路径。
    const relativePath = normalizeRelativePath(path.relative(workspaceRoot, uri.fsPath));
    for (const diagnostic of diagnostics) {
      items.push({
        uri: uri.toString(),
        relativePath,
        severity: mapSeverity(diagnostic.severity),
        message: diagnostic.message,
        ...(diagnostic.source ? { source: diagnostic.source } : {}),
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
      });
      if (items.length >= maxItems) return items;
    }
  }
  return items;
}

export function diagnosticsAsText(workspaceRoot: string): string {
  return formatDiagnosticsBlock(collectWorkspaceDiagnostics(workspaceRoot));
}
