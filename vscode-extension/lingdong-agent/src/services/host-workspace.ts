import * as vscode from "vscode";

/**
 * 宿主（VS Code）工作区的本地根。
 *
 * 单独收口是为了把「宿主打开了哪些文件夹」和「agent 在操作哪个目录」这两件事
 * 分开——后者是活动仓库，见 services/active-repo.ts。以前全代码都直接读
 * `workspaceFolders[0]`，等于把两者钉死成一个，于是换仓库只能去动宿主工作区，
 * 而那必然重载窗口。
 *
 * 只要本地路径：远程与虚拟文件系统的根拿不到 fsPath 语义，Grok 也起不动。
 */
export function hostRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
}
