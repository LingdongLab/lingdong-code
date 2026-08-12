import * as path from "node:path";
import * as vscode from "vscode";
import type { HostToWebviewMessage } from "../messages";
import { formatWorkspaceOverview } from "../plan-research";
import { scanFiles, type ScanPort } from "./file-scan";

/**
 * 宿主能力入口：文件列举、打开文件、终端、浏览器与设置。
 * Webview 只能通过这些受控入口触达工作区，永远拿不到绝对路径。
 *
 * 列文件走自己的目录遍历而不是 `vscode.workspace.findFiles`：活动仓库跟宿主
 * 工作区解耦之后，目标目录可能根本不在 workspaceFolders 里，findFiles 会一个
 * 文件都不返回而且不报错——界面上就是 Files 面板和 @ 候选忽然空了。
 */

/** 右侧 Files 工具一次最多列出的条目，以及底层检索上限。 */
const FILE_LIST_LIMIT = 200;
const FILE_SCAN_LIMIT = 400;
/** Plan 研究用的文件概览上限，比 Files 工具更克制。 */
const PLAN_OVERVIEW_SCAN_LIMIT = 120;
const PLAN_OVERVIEW_SHOW_LIMIT = 80;
/** 内联 @ 候选的扫描上限；结果在建议服务里带 TTL 缓存，不会每次按键都重扫。 */
const SUGGEST_SCAN_LIMIT = 1_000;

export interface WorkspaceToolsDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  readonly fs: ScanPort;
  /** agent 正在操作的目录，可能不是宿主工作区的任何一个根。 */
  activeRoot(): string | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkspaceTools {
  constructor(private readonly deps: WorkspaceToolsDeps) {}

  /**
   * 打开设置。
   *
   * 走自己的设置页而不是 VS Code 原生 editor：`lingdongAgent.*` 的取值只是
   * 设置的一部分，模型、Skills、MCP、权限规则都不在 settings.json 里。
   * 把用户送去原生页，他会以为自己看到了全部。
   */
  async openSettings(): Promise<void> {
    await vscode.commands.executeCommand("lingdongAgent.openSettings");
  }

  /** 外链由宿主安全打开，禁止 Webview 直接跳转。 */
  async openExternalUrl(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** 列出仓库文件（仅相对路径），供右侧 Files 工具使用。 */
  async listFiles(query?: string): Promise<void> {
    const root = this.deps.activeRoot();
    if (!root) {
      this.deps.post({
        type: "workspaceFiles",
        files: [],
        query: query ?? "",
        truncated: false,
        matched: 0,
      });
      return;
    }
    const needle = (query ?? "").trim().toLowerCase();
    const scan = await scanFiles(root, { limit: FILE_SCAN_LIMIT, fs: this.deps.fs });
    const files: Array<{ relativePath: string; directory: boolean }> = [];
    let matched = 0;
    for (const relativePath of scan.files) {
      if (needle && !relativePath.toLowerCase().includes(needle)) continue;
      matched += 1;
      if (files.length < FILE_LIST_LIMIT) files.push({ relativePath, directory: false });
    }

    const scanTruncated = scan.truncated;
    const listTruncated = matched > files.length;
    this.deps.post({
      type: "workspaceFiles",
      files,
      query: query ?? "",
      truncated: scanTruncated || listTruncated,
      matched,
      ...(scanTruncated ? { scanLimit: FILE_SCAN_LIMIT } : {}),
    });
    if (!scanTruncated && !listTruncated) return;
    // 截断必须说清楚，否则用户会以为工作区里就只有这些文件。
    this.deps.post({
      type: "notice",
      level: "warn",
      message: listTruncated
        ? `匹配到 ${matched} 个文件，仅显示前 ${files.length} 个；请用更精确的关键词缩小范围。`
        : `仓库文件较多，仅扫描了前 ${FILE_SCAN_LIMIT} 个，结果可能不完整；建议用关键词过滤。`,
    });
  }

  /**
   * 供内联 @ 候选使用的相对路径列表，与 Files 工具共用同一套排除规则。
   * 只返回路径，不返回绝对路径，也不读文件内容。
   */
  async collectFiles(limit = SUGGEST_SCAN_LIMIT): Promise<string[]> {
    const root = this.deps.activeRoot();
    if (!root) return [];
    try {
      const scan = await scanFiles(root, { limit, fs: this.deps.fs });
      return [...scan.files];
    } catch (error) {
      this.deps.log(`[context-suggest] 列出仓库失败：${errorText(error)}`);
      return [];
    }
  }

  /** 由宿主打开仓库内相对路径文件。 */
  async openFile(relativePath: string, line?: number): Promise<void> {
    const root = this.deps.activeRoot();
    if (!root) {
      this.deps.post({ type: "notice", level: "warn", message: "请先选择一个本地仓库。" });
      return;
    }
    const normalized = relativePath.replace(/\\/g, "/");
    if (
      !normalized
      || normalized.includes("..")
      || normalized.startsWith("/")
      || /^[A-Za-z]:/.test(normalized)
    ) {
      this.deps.post({ type: "notice", level: "warn", message: "非法文件路径，已忽略。" });
      return;
    }
    const uri = vscode.Uri.file(path.join(root, ...normalized.split("/")));
    const bound = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const target = uri.fsPath.replace(/\\/g, "/").toLowerCase();
    if (!target.startsWith(`${bound}/`) && target !== bound) {
      this.deps.post({ type: "notice", level: "warn", message: "只能打开当前仓库内的文件。" });
      return;
    }
    // 正文里的 `path:line` 引用要落到那一行，否则点开只是打开文件，还得自己去找。
    const at = line !== undefined && line > 0
      ? new vscode.Range(line - 1, 0, line - 1, 0)
      : undefined;
    await vscode.window.showTextDocument(uri, {
      preview: true,
      preserveFocus: false,
      ...(at ? { selection: at } : {}),
    });
  }

  /** 打开 VS Code 原生命令终端，不在 Webview 内模拟。 */
  async openTerminal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.terminal.new");
  }

  /** 打开 Simple Browser 或系统浏览器；不在 Webview 内伪造浏览器。 */
  async openBrowser(url?: string): Promise<void> {
    const target = (url ?? "https://").trim();
    try {
      await vscode.commands.executeCommand(
        "simpleBrowser.show",
        target.startsWith("http") ? target : "https://",
      );
    } catch {
      if (/^https?:\/\//i.test(target)) {
        await vscode.env.openExternal(vscode.Uri.parse(target));
        return;
      }
      this.deps.post({
        type: "notice",
        level: "info",
        message: "当前环境未提供 Simple Browser，已跳过。",
      });
    }
  }

  /** Plan 模式的仓库概览：宿主安全列出，只给相对路径。 */
  async planOverview(): Promise<string> {
    const root = this.deps.activeRoot();
    if (!root) return formatWorkspaceOverview([]);
    try {
      const scan = await scanFiles(root, {
        limit: PLAN_OVERVIEW_SCAN_LIMIT,
        fs: this.deps.fs,
      });
      const files = scan.files.map((relativePath) => ({ relativePath }));
      return formatWorkspaceOverview(files, PLAN_OVERVIEW_SHOW_LIMIT);
    } catch (error) {
      this.deps.log(`[plan-research] 列出仓库失败：${errorText(error)}`);
      return formatWorkspaceOverview([]);
    }
  }
}
