/**
 * 诊断展示纯函数：不依赖 VS Code API，便于单测。
 */

export interface DiagnosticItem {
  uri: string;
  relativePath: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  line: number;
  character: number;
}

export function formatDiagnosticsBlock(items: readonly DiagnosticItem[]): string {
  if (items.length === 0) return "当前工作区问题面板没有可读诊断。";
  const lines = items.map(
    (item) =>
      `- [${item.severity}] ${item.relativePath}:${item.line}:${item.character} ${item.message}`
      + (item.source ? ` (${item.source})` : ""),
  );
  return ["## 工作区问题面板", ...lines].join("\n");
}
