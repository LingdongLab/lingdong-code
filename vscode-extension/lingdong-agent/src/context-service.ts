import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import {
  CONTEXT_LIMITS,
  buildFolderContent,
  formatSize,
  isExcludedPath,
  languageFromPath,
  looksBinary,
  looksTextual,
  normalizeRelativePath,
  planFolderContext,
  prepareContent,
  selectionLabel,
  type AgentContextItem,
  type ContextItemType,
  type FolderCandidate,
} from "./context-model";
import { matchDroppedName, normalizeDropText } from "./dropped-file";
import { scanFiles, type ScanPort } from "./services/file-scan";
import { imageMarker, imageMarkerPattern, type ImageStore, type StoredImage } from "./services/image-store";
import { isInsideWorkspace } from "./workspace-guard";

export type ContextNotice = (level: "info" | "warn", message: string) => void;

/** @文件 选择器的遍历上限；比 Files 面板宽松，因为这是用户主动来找文件。 */
const PICK_SCAN_LIMIT = 3_000;
/** @目录 一次最多纳入的文件数。 */
const FOLDER_SCAN_LIMIT = 1_000;

/** 由 AgentController 提供的最近命令输出，用于 @终端输出。 */
export interface TerminalOutputSource {
  (): { text: string; lines: number } | undefined;
}

const decoder = new TextDecoder("utf8", { fatal: false });

function createId(): string {
  return `ctx-${randomBytes(6).toString("hex")}`;
}

/**
 * 上下文服务：Webview 只发语义请求，真实的文件读取、边界校验、脱敏与限额
 * 全部在 Extension Host 完成，Webview 永远拿不到也不能构造 content。
 */
export class ContextService {
  private items: AgentContextItem[] = [];

  constructor(
    private readonly notice: ContextNotice,
    private readonly terminalOutput: TerminalOutputSource,
    /**
     * agent 正在操作的目录。以前这里自己去读 `workspaceFolders[0]`，
     * 而外层的 ContextFacade 用的是会话的根——两处一旦不一致，
     * @文件 的边界校验就会按错的根算，表现是明明在仓库里的文件被判成越界。
     */
    private readonly activeRoot: () => string | undefined,
    private readonly scanPort: ScanPort,
    /** 图片字节的暂存；与转发层共用同一个实例，否则出站时查不到图。 */
    private readonly images: ImageStore,
  ) {}

  get current(): AgentContextItem[] {
    return [...this.items];
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * 取走当前上下文并清空：一轮任务只带一次临时上下文。
   *
   * 图片字节不跟着清。Grok 每轮都会把完整对话重发一遍，老标记会在后续请求里反复出现，
   * 这时候还得能查到图；真正的清理点是会话结束（clearImages）。
   */
  take(): AgentContextItem[] {
    const taken = this.items;
    this.items = [];
    return taken;
  }

  clear(): void {
    for (const item of this.items) {
      if (item.type === "image") this.dropImage(item);
    }
    this.items = [];
  }

  /** 会话切换 / 结束：这时候历史轮次也不会再重发了，字节可以真的丢掉。 */
  clearImages(): void {
    this.images.clear();
  }

  remove(id: string): boolean {
    const target = this.items.find((item) => item.id === id);
    if (!target) return false;
    if (target.type === "image") this.dropImage(target);
    this.items = this.items.filter((item) => item.id !== id);
    return true;
  }

  /** 上下文条目被移除时连带回收字节，避免 store 里留下再也引用不到的图。 */
  private dropImage(item: AgentContextItem): void {
    const id = imageMarkerPattern().exec(item.content)?.[1];
    if (id) this.images.remove(id);
  }

  async addCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.notice("warn", "当前没有打开的编辑文件。");
      return;
    }
    const relative = this.relativeOf(editor.document.uri);
    if (!relative) return;

    const text = editor.document.getText();
    if (Buffer.byteLength(text, "utf8") > CONTEXT_LIMITS.fileBytes) {
      this.notice("warn", "文件过大，请选择具体代码片段或文件中的部分内容。");
      return;
    }
    this.push({
      type: "file",
      label: relative,
      workspaceRelativePath: relative,
      languageId: editor.document.languageId,
      raw: text,
      limit: CONTEXT_LIMITS.fileBytes,
    });
  }

  async addSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.notice("warn", "请先在编辑器中选择一段代码。");
      return;
    }
    const relative = this.relativeOf(editor.document.uri);
    if (!relative) return;

    const text = editor.document.getText(editor.selection);
    if (text.length > CONTEXT_LIMITS.selectionChars) {
      this.notice("warn", `选中内容 ${formatSize(text.length)}，超出单次 ${CONTEXT_LIMITS.selectionChars} 字符上限，请缩小选择范围。`);
      return;
    }
    const range = { start: editor.selection.start.line + 1, end: editor.selection.end.line + 1 };
    this.push({
      type: "selection",
      label: selectionLabel(relative, range),
      workspaceRelativePath: relative,
      languageId: editor.document.languageId,
      raw: text,
      limit: CONTEXT_LIMITS.selectionChars,
      lineRange: range,
    });
  }

  async pickFiles(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;

    // 走自己的目录遍历而不是 findFiles：后者只看 VS Code 的工作区，
    // 活动仓库不在 workspaceFolders 里时会一个文件都不返回，且不报错。
    const scan = await scanFiles(root, { limit: PICK_SCAN_LIMIT, fs: this.scanPort });
    const choices = scan.files
      .map((relative) => normalizeRelativePath(relative))
      .filter((relative) => relative !== "" && !isExcludedPath(relative).excluded)
      .map((relative) => ({
        label: relative,
        uri: vscode.Uri.file(path.join(root, relative)),
      }));

    if (choices.length === 0) {
      this.notice("warn", "当前仓库没有可添加的文本文件。");
      return;
    }

    const picked = await vscode.window.showQuickPick(choices, {
      canPickMany: true,
      title: "选择要加入上下文的文件",
      placeHolder: "支持搜索文件名，可多选",
      matchOnDetail: true,
    });
    if (!picked || picked.length === 0) return;

    for (const choice of picked) await this.addFile(choice.uri);
  }

  async addFile(uri: vscode.Uri): Promise<void> {
    const relative = this.relativeOf(uri);
    if (!relative) return;
    if (isExcludedPath(relative).excluded) {
      this.notice("warn", `已跳过 ${relative}：属于凭据、二进制或构建产物。`);
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      this.notice("warn", `读取 ${relative} 失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (bytes.byteLength > CONTEXT_LIMITS.fileBytes) {
      this.notice("warn", `${relative} 文件过大，请选择具体代码片段或文件中的部分内容。`);
      return;
    }
    if (looksBinary(bytes)) {
      this.notice("warn", `已跳过 ${relative}：检测为二进制文件。`);
      return;
    }
    this.push({
      type: "file",
      label: relative,
      workspaceRelativePath: relative,
      languageId: languageFromPath(relative),
      raw: decoder.decode(bytes),
      limit: CONTEXT_LIMITS.fileBytes,
    });
  }

  async pickFolder(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;

    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(root),
      openLabel: "加入上下文",
      title: "选择要加入上下文的目录",
    });
    const folder = picked?.[0];
    if (!folder) return;
    await this.addFolder(folder);
  }

  /**
   * 按工作区相对路径加入文件上下文，供内联 @ 候选使用。
   * 路径由宿主的候选注册表提供，仍然要过一遍工作区边界与排除规则。
   */
  async addFileAtPath(relativePath: string): Promise<void> {
    const uri = this.resolveInside(relativePath);
    if (!uri) return;
    await this.addFile(uri);
  }

  /**
   * 拖入的 uri-list（来自编辑器标签页 / 资源管理器等应用内拖拽）。
   * 逐条核对仓库边界；目录走目录入口，文件走文件入口，越界与读不到的只记数，
   * 最后一次性提示，免得拖十个文件弹十条警告。
   */
  async addDroppedUris(uris: readonly string[]): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    let rejected = 0;
    for (const raw of uris) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(raw, true);
      } catch {
        rejected += 1;
        continue;
      }
      if (uri.scheme !== "file" || !isInsideWorkspace(root, uri.fsPath)) {
        rejected += 1;
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) await this.addFolder(uri);
        else await this.addFile(uri);
      } catch {
        rejected += 1;
      }
    }
    if (rejected > 0) {
      this.notice("warn", `有 ${rejected} 项不在当前仓库内或无法读取，已跳过——上下文只能来自当前仓库。`);
    }
  }

  /**
   * 从系统资源管理器拖入的文件：只有文件名和内容，没有路径
   * （Electron 出于安全不给 webview 真实路径）。
   * 用文件名在仓库里找；同名多个再按内容比对，唯一命中才加，
   * 猜错文件比加不上更糟。找不到就拒绝，仓库边界不为拖放开口子。
   */
  async addDroppedNamedFile(name: string, content: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    const base = name.trim();
    if (!base) return;

    const scan = await scanFiles(root, { limit: PICK_SCAN_LIMIT, fs: this.scanPort });
    const matches = matchDroppedName(scan.files.map((file) => normalizeRelativePath(file)), base);
    if (matches.length === 0) {
      this.notice("warn", `「${base}」不在当前仓库内，已拒绝添加。仓库内的文件可以用 @ 引用。`);
      return;
    }
    if (matches.length === 1) {
      await this.addFileAtPath(matches[0] as string);
      return;
    }

    const dropped = normalizeDropText(content);
    const hits: string[] = [];
    for (const relative of matches.slice(0, 8)) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, relative)));
        if (normalizeDropText(new TextDecoder().decode(bytes)) === dropped) hits.push(relative);
      } catch {
        // 读不出来就当不匹配；这里不是报错的地方。
      }
    }
    if (hits.length === 1) {
      await this.addFileAtPath(hits[0] as string);
      return;
    }
    this.notice("warn", `仓库里有 ${matches.length} 个「${base}」，无法确定是哪一个，请用 @ 指定具体路径。`);
  }

  /** 按工作区相对路径加入目录上下文，限额与确认逻辑与 pickFolder 完全一致。 */
  async addFolderAtPath(relativePath: string): Promise<void> {
    const uri = this.resolveInside(relativePath);
    if (!uri) return;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        this.notice("warn", `${normalizeRelativePath(relativePath)} 不是目录。`);
        return;
      }
    } catch {
      this.notice("warn", `找不到目录 ${normalizeRelativePath(relativePath)}。`);
      return;
    }
    await this.addFolder(uri);
  }

  private async addFolder(folder: vscode.Uri): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;

    const relativeFolder = this.relativeOf(folder);
    if (relativeFolder === undefined) return;

    // 同样不用 findFiles + RelativePattern：那个 base 落在工作区之外时返回空。
    const scan = await scanFiles(folder.fsPath, { limit: FOLDER_SCAN_LIMIT, fs: this.scanPort });
    const uris = scan.files.map((relative) =>
      vscode.Uri.file(path.join(folder.fsPath, relative)));
    if (uris.length === 0) {
      this.notice("warn", "该目录下没有可用的文本文件。");
      return;
    }

    const candidates: Array<FolderCandidate & { uri: vscode.Uri }> = [];
    for (const uri of uris) {
      const relative = normalizeRelativePath(path.relative(root, uri.fsPath));
      let size = 0;
      try {
        size = (await vscode.workspace.fs.stat(uri)).size;
      } catch {
        continue;
      }
      candidates.push({ relativePath: relative, size, isText: looksTextual(relative), uri });
    }

    const plan = planFolderContext(candidates);
    const confirmed = await vscode.window.showInformationMessage(
      `将添加目录 ${relativeFolder || "."}：${plan.included.length} 个文件正文，约 ${formatSize(plan.estimatedChars)}${plan.truncated ? "（已按上限截断，其余只列文件名）" : ""}。`,
      { modal: true },
      "添加",
    );
    if (confirmed !== "添加") return;

    const files: Array<{ relativePath: string; content: string }> = [];
    for (const entry of plan.included) {
      const source = candidates.find((candidate) => candidate.relativePath === entry.relativePath);
      if (!source) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(source.uri);
        if (looksBinary(bytes)) continue;
        files.push({ relativePath: entry.relativePath, content: decoder.decode(bytes) });
      } catch {
        continue;
      }
    }

    const tree = candidates
      .map((candidate) => candidate.relativePath)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 200);
    const content = buildFolderContent({
      relativePath: relativeFolder,
      tree,
      files,
      listedOnly: plan.listedOnly,
      truncated: plan.truncated || tree.length >= 200,
    });

    this.push({
      type: "folder",
      label: relativeFolder || "工作区根目录",
      workspaceRelativePath: relativeFolder,
      languageId: "plaintext",
      raw: content,
      limit: CONTEXT_LIMITS.folderChars,
    });
  }

  addTerminalOutput(): void {
    const output = this.terminalOutput();
    if (!output || output.text.trim() === "") {
      this.notice(
        "warn",
        "还没有可用的终端输出。可以先让灵动 Code 执行一条命令，或在终端里选中文本后运行「将选中的终端输出添加到灵动 Code」。",
      );
      return;
    }
    this.push({
      type: "terminal",
      label: `终端输出 ${output.lines} 行`,
      workspaceRelativePath: "",
      languageId: "plaintext",
      raw: output.text,
      limit: CONTEXT_LIMITS.terminalChars,
    });
  }

  /**
   * 粘贴 / 拖入的图片。
   *
   * 字节进内存暂存，上下文里只放一个标记；图片本体由转发层在出站前替换进去。
   * 不落盘是刻意的——往用户仓库里写 `.lingdong/attachments/` 会污染 git status，
   * 而且路径引用救不了看图这件事：模型拿到一行路径仍然什么都没看见。
   */
  addImage(name: string, dataUrl: string): StoredImage | undefined {
    const result = this.images.add(name, dataUrl);
    if (!result.ok) {
      this.notice("warn", result.message);
      return undefined;
    }
    const { image } = result;
    const before = this.items.length;
    this.push({
      type: "image",
      label: image.name,
      workspaceRelativePath: "",
      languageId: "",
      raw: imageMarker(image.id),
      limit: CONTEXT_LIMITS.terminalChars,
    });
    // push 可能因为条目总数超限而拒绝；那样字节留在 store 里就成了永远发不出去的垃圾。
    if (this.items.length === before) {
      this.images.remove(image.id);
      return undefined;
    }
    return image;
  }

  /** @问题面板：调用方已过滤工作区边界。 */
  addDiagnostics(label: string, text: string): void {
    this.push({
      type: "diagnostics",
      label,
      workspaceRelativePath: "",
      languageId: "markdown",
      raw: text,
      limit: CONTEXT_LIMITS.terminalChars,
    });
  }

  /** 剪贴板兜底：仅在用户显式执行命令时使用，读完立刻还原剪贴板。 */
  async addTerminalSelection(): Promise<void> {
    const previous = await vscode.env.clipboard.readText();
    try {
      await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
      const text = await vscode.env.clipboard.readText();
      if (text.trim() === "" || text === previous) {
        this.notice("warn", "没有读取到终端选中内容，请先在终端中选择一段输出。");
        return;
      }
      this.push({
        type: "terminal",
        label: `终端输出 ${text.split("\n").length} 行`,
        workspaceRelativePath: "",
        languageId: "plaintext",
        raw: text,
        limit: CONTEXT_LIMITS.terminalChars,
      });
    } finally {
      await vscode.env.clipboard.writeText(previous);
    }
  }

  /**
   * 把相对路径解析成工作区内的 Uri。
   * 绝对路径、盘符与 `..` 一律拒绝，解析后仍由 relativeOf 再做一次边界校验。
   */
  private resolveInside(relativePath: string): vscode.Uri | undefined {
    const root = this.workspaceRoot();
    if (!root) return undefined;
    const normalized = normalizeRelativePath(relativePath);
    if (
      normalized === ""
      || normalized.includes("..")
      || normalized.startsWith("/")
      || /^[A-Za-z]:/.test(normalized)
    ) {
      this.notice("warn", "非法路径，已忽略。");
      return undefined;
    }
    const uri = vscode.Uri.file(path.resolve(root, normalized));
    if (!isInsideWorkspace(root, uri.fsPath)) {
      this.notice("warn", "该路径不在当前工作区，已拒绝添加。");
      return undefined;
    }
    return uri;
  }

  private workspaceRoot(): string | undefined {
    const root = this.activeRoot();
    if (!root) {
      this.notice("warn", "请先选择一个本地文件夹作为仓库。");
      return undefined;
    }
    return root;
  }

  /** 工作区边界校验：任何越界文件都不允许进入上下文。 */
  private relativeOf(uri: vscode.Uri): string | undefined {
    const root = this.workspaceRoot();
    if (!root) return undefined;
    if (uri.scheme !== "file") {
      this.notice("warn", "只能添加本地文件。");
      return undefined;
    }
    if (!isInsideWorkspace(root, uri.fsPath)) {
      this.notice("warn", "该文件不在当前工作区，已拒绝添加。");
      return undefined;
    }
    return normalizeRelativePath(path.relative(root, uri.fsPath));
  }

  private push(input: {
    type: ContextItemType;
    label: string;
    workspaceRelativePath: string;
    languageId: string;
    raw: string;
    limit: number;
    lineRange?: { start: number; end: number };
  }): void {
    if (this.items.length >= CONTEXT_LIMITS.totalItems) {
      this.notice("warn", `上下文数量已达上限（${CONTEXT_LIMITS.totalItems} 项），请先移除部分内容。`);
      return;
    }
    const prepared = prepareContent(input.raw, input.limit);
    const item: AgentContextItem = {
      id: createId(),
      type: input.type,
      label: input.label,
      workspaceRelativePath: input.workspaceRelativePath,
      languageId: input.languageId,
      content: prepared.content,
      ...(input.lineRange ? { lineRange: input.lineRange } : {}),
      createdAt: Date.now(),
      truncated: prepared.truncated,
      size: prepared.content.length,
    };
    // 同一文件或同一段选区重复添加时替换旧条目，避免上下文里出现两份相同内容。
    const key = `${item.type}:${item.workspaceRelativePath}:${item.lineRange?.start ?? ""}-${item.lineRange?.end ?? ""}`;
    this.items = this.items.filter(
      (existing) =>
        `${existing.type}:${existing.workspaceRelativePath}:${existing.lineRange?.start ?? ""}-${existing.lineRange?.end ?? ""}` !== key,
    );
    this.items.push(item);
  }
}
