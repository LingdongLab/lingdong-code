import * as vscode from "vscode";
import type { ChangedFile } from "./change-tracker";
import { SNAPSHOT_SCHEME, buildSnapshotUri, parseSnapshotUri, planDiff, type DiffSide } from "./diff-model";

export type SnapshotReader = (turnId: string, relativePath: string) => Promise<string>;

function toUri(side: DiffSide): vscode.Uri {
  if (side.kind === "file") return vscode.Uri.file(side.absolutePath);
  const parts = buildSnapshotUri(side.turnId, side.relativePath, side.empty);
  return vscode.Uri.from({ scheme: parts.scheme, path: parts.path, query: parts.query });
}

/**
 * 修改前内容的只读虚拟文档。Diff 左侧永远来自这里，
 * 不使用 Grok 工具事件里的 diff 片段，那些片段只是被替换的一小段文本。
 */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = SNAPSHOT_SCHEME;

  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly read: SnapshotReader) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parseSnapshotUri({ query: uri.query });
    if (!target) return "";
    if (target.empty) return "";
    return this.read(target.turnId, target.relativePath);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/**
 * 打开变更预览：
 * - 新建 / 删除 / 无快照：单栏（避免一侧全空的斜纹废栏）
 * - 修改 / 重命名且快照可读：原生左右 Diff
 */
export async function openChangeDiff(
  change: ChangedFile,
  turnIndex: number,
  readSnapshot?: SnapshotReader,
): Promise<void> {
  let plan = planDiff(change, turnIndex);

  // 二次校验：元数据说可恢复，但快照正文读不到时，仍不要开空左侧。
  if (plan.mode === "diff" && plan.left.kind === "snapshot" && readSnapshot) {
    const before = await readSnapshot(plan.left.turnId, plan.left.relativePath);
    if (!before) {
      plan = {
        mode: "single",
        side: plan.right,
        title: `${change.relativePath}（第 ${turnIndex} 轮：当前文件）`,
      };
    }
  }

  if (plan.mode === "single") {
    const uri = toUri(plan.side);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    void vscode.commands.executeCommand("lingdongAgent.markReviewOpen");
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.diff",
    toUri(plan.left),
    toUri(plan.right),
    `灵动 Code 变更：${plan.title}`,
    { preview: true } satisfies vscode.TextDocumentShowOptions,
  );
  void vscode.commands.executeCommand("lingdongAgent.markReviewOpen");
}
