import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildPreviewUri,
  EditPreviewPlanner,
  EDIT_PREVIEW_SCHEME,
  parsePreviewUri,
  type EditPreviewAction,
  type EditPreviewDiff,
  type EditPreviewMode,
} from "../preview/edit-preview-model";

/**
 * 边写边看：把 Grok 报上来的编辑 diff 摆进编辑器。
 *
 * 决策全在 EditPreviewPlanner 里（纯逻辑、可单测），这里只负责与 VS Code 打交道：
 * 注册只读虚拟文档、开 diff、揭示文件。所有编辑器都用 `preview: true` +
 * `preserveFocus: true`——预览标签会互相顶掉，用户的输入焦点也不该被抢走。
 */

export interface EditPreviewServiceDeps {
  log(line: string): void;
  mode(): EditPreviewMode;
  /** 活动仓库根；仓库外的文件不预览。 */
  workspaceRoot(): string | undefined;
}

export class EditPreviewService {
  private readonly planner: EditPreviewPlanner;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  /** 本轮开过的虚拟文档，内容更新时要通知编辑器重取。 */
  private readonly openedUris = new Map<string, vscode.Uri>();

  constructor(private readonly deps: EditPreviewServiceDeps) {
    this.planner = new EditPreviewPlanner({
      mode: () => deps.mode(),
      allow: (file) => this.insideWorkspace(file),
    });
  }

  /** 注册只读虚拟文档提供器；调用方负责把返回的 disposable 挂到扩展生命周期上。 */
  register(): vscode.Disposable {
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: this.changed.event,
      provideTextDocumentContent: (uri) => {
        const parsed = parsePreviewUri(uri.query);
        if (!parsed) return "";
        return this.planner.content(parsed.file, parsed.side) ?? "";
      },
    };
    return vscode.workspace.registerTextDocumentContentProvider(EDIT_PREVIEW_SCHEME, provider);
  }

  /** 参数流阶段只知道目标路径时的处理。 */
  noteEditTarget(toolCallId: string, kind: string, target: string | undefined): void {
    void this.apply(this.planner.onEditTarget(toolCallId, kind, target));
  }

  noteDiff(input: EditPreviewDiff): void {
    void this.apply(this.planner.onDiff(input));
  }

  /** 换轮/换会话时清空，避免下一轮把上一轮的旧文本当预览内容。 */
  reset(): void {
    this.planner.reset();
    this.openedUris.clear();
  }

  private insideWorkspace(file: string): boolean {
    const root = this.deps.workspaceRoot();
    if (!root) return false;
    const absolute = path.isAbsolute(file) ? file : path.join(root, file);
    const relative = path.relative(root, absolute);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  private absolute(file: string): string {
    const root = this.deps.workspaceRoot();
    if (path.isAbsolute(file) || !root) return file;
    return path.join(root, file);
  }

  private async apply(action: EditPreviewAction): Promise<void> {
    try {
      if (action.kind === "none") return;
      if (action.kind === "reveal") {
        await this.reveal(this.absolute(action.file));
        return;
      }
      await this.showDiff(action.file, action.title, action.revision, action.rightIsFile);
    } catch (error) {
      // 预览是锦上添花，任何失败都不能影响这一轮的执行。
      this.deps.log(`[preview] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async reveal(absolutePath: string): Promise<void> {
    const uri = vscode.Uri.file(absolutePath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      // 还没创建出来的新文件不用揭示，等 diff 到了再显示。
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
  }

  private async showDiff(
    file: string,
    title: string,
    revision: number,
    rightIsFile: boolean,
  ): Promise<void> {
    const left = this.previewUri(file, "before", revision);
    const right = rightIsFile
      ? vscode.Uri.file(this.absolute(file))
      : this.previewUri(file, "after", revision);
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `灵动 Code · ${title}`,
      { preview: true, preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
    );
  }

  private previewUri(file: string, side: "before" | "after", revision: number): vscode.Uri {
    const parts = buildPreviewUri(file, side, revision);
    const uri = vscode.Uri.from({ scheme: parts.scheme, path: parts.path, query: parts.query });
    const key = `${side}:${file}:${revision}`;
    const known = this.openedUris.get(key);
    if (known) {
      // 同一 revision 的内容不会再变，但上一次打开的文档可能还缓存着旧文本。
      this.changed.fire(known);
      return known;
    }
    this.openedUris.set(key, uri);
    return uri;
  }
}
