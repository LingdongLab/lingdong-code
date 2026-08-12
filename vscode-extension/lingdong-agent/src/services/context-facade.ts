import * as vscode from "vscode";
import type { AgentRuntimeHandle } from "@lingdong/agent-runtime";
import type { AgentContextItem } from "../context-model";
import { ContextService } from "../context-service";
import { ContextUsageService } from "../context-usage";
import type { ScanPort } from "./file-scan";
import type { ImageStore } from "./image-store";
import { collectWorkspaceDiagnostics, formatDiagnosticsBlock } from "../diagnostics-context";
import type { ContextItemView, HostToWebviewMessage, UiAgentMode, UsageView } from "../messages";
import { composerStatusLine, formatUsageLabel } from "../usage-format";
import type { AgentWorkspaceStore } from "../workspace-store";

/**
 * 上下文与用量编排：@ 引用条目、token 用量、手动压缩与 Composer 状态行。
 * 终端回放缓冲也放在这里，只回放灵动 Code 自己执行过的命令输出。
 */

/** @终端输出 保留最近这么多字符。 */
const TERMINAL_BUFFER_CHARS = 20_000;
const COMPACT_COOLDOWN_MS = 1_500;

export interface ContextFacadeDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  readonly store: AgentWorkspaceStore;
  runtime(): AgentRuntimeHandle | undefined;
  mode(): UiAgentMode;
  modelId(): string;
  /** 当前模型上下文窗口；用于圆环分母（对标 Cursor 的 30.3K / 256K）。 */
  modelContextWindow(): number | undefined;
  workspaceRoot(): string | undefined;
  readonly fs: ScanPort;
  /** 当前模型收不收图；决定粘贴的图片是进上下文还是被拒。 */
  supportsVision(): boolean;
  /** 图片字节的暂存，与转发层共用同一个实例。 */
  readonly images: ImageStore;
  /** 压缩完成后把提示写进当前会话记录。 */
  appendTranscriptNotice(message: string): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toContextView(item: AgentContextItem): ContextItemView {
  return {
    id: item.id,
    type: item.type,
    label: item.label,
    size: item.size,
    truncated: item.truncated,
    ...(item.lineRange ? { lineRange: item.lineRange } : {}),
  };
}

export class ContextFacade {
  readonly usage: ContextUsageService;
  private readonly service: ContextService;
  private terminalBuffer = "";
  private compactBusy = false;
  private lastCompactAt = 0;

  constructor(private readonly deps: ContextFacadeDeps) {
    this.service = new ContextService(
      (level, message) => this.deps.post({ type: "notice", level, message }),
      () => this.recentTerminalOutput(),
      // 边界校验的根必须与这里一致：以前 ContextService 自己去读
      // workspaceFolders[0]，两处不一致时仓库内的文件会被判成越界。
      () => this.deps.workspaceRoot(),
      this.deps.fs,
      this.deps.images,
    );
    this.usage = new ContextUsageService({
      contextLimit: 1_000_000,
      emit: (event) => {
        if (event.type === "context_usage_updated") {
          this.deps.log(
            `[usage] ${event.usage.source} ${event.usage.usedTokens}`
            + (event.usage.percentage === undefined ? "" : `（约 ${event.usage.percentage}%）`)
            + ` · ${event.level}`,
          );
          this.pushUsage();
        } else if (event.type === "context_compaction_started") {
          this.deps.store.patchRuntime({ compactBusy: true });
          this.deps.post({ type: "compactState", capability: this.usage.compactionCapability, busy: true });
        } else if (event.type === "context_compaction_completed") {
          this.deps.store.patchRuntime({ compactBusy: false });
          this.pushUsage();
          this.deps.post({
            type: "compactState",
            capability: this.usage.compactionCapability,
            busy: false,
            message: "上下文已压缩",
          });
        } else if (event.type === "context_compaction_failed") {
          this.deps.store.patchRuntime({ compactBusy: false });
          this.deps.post({
            type: "compactState",
            capability: this.usage.compactionCapability,
            busy: false,
            message: `压缩失败：${event.reason}`,
          });
        }
      },
    });
  }

  get current(): AgentContextItem[] {
    return this.service.current;
  }

  /** 取走已添加的上下文，交给本轮提示词。 */
  take(): AgentContextItem[] {
    return this.service.take();
  }

  /** 把问题面板诊断作为一条上下文加入；无诊断时也加入空结果说明。 */
  addDiagnostics(): void {
    // 不再退回 workspaceFolders[0]：活动仓库拿不到时那是个错的根，
    // 会把别的目录的诊断当成本仓库的送进上下文。
    const root = this.deps.workspaceRoot();
    if (!root) {
      this.deps.post({ type: "notice", level: "warn", message: "请先选择一个本地仓库。" });
      return;
    }
    const items = collectWorkspaceDiagnostics(root);
    this.service.addDiagnostics(`@问题面板（${items.length}）`, formatDiagnosticsBlock(items));
    this.publishItems();
    this.deps.post({
      type: "notice",
      level: "info",
      message: items.length > 0
        ? `已添加问题面板诊断 ${items.length} 条。`
        : "问题面板暂无诊断，已添加空结果说明。",
    });
  }

  /** 上下文摘要用只读虚拟文档展示，不改动工作区文件。 */
  async show(id: string): Promise<void> {
    const item = this.find(id);
    if (!item) {
      this.deps.post({ type: "notice", level: "warn", message: "该上下文已被移除。" });
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument({
        content: `# ${item.label}\n\n${item.content}`,
        language: item.type === "folder" || item.type === "terminal" ? "plaintext" : item.languageId,
      });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.deps.log(`[context] ${errorText(error)}`);
    }
  }

  async addCurrentFile(): Promise<void> {
    await this.service.addCurrentFile();
    this.publishItems();
  }

  async addSelection(): Promise<void> {
    await this.service.addSelection();
    this.publishItems();
  }

  async pickFiles(): Promise<void> {
    await this.service.pickFiles();
    this.publishItems();
  }

  async pickFolder(): Promise<void> {
    await this.service.pickFolder();
    this.publishItems();
  }

  /** 内联 @ 选中文件：路径来自宿主候选注册表，读取与脱敏仍走 ContextService。 */
  async addFileAtPath(relativePath: string): Promise<void> {
    await this.service.addFileAtPath(relativePath);
    this.publishItems();
  }

  async addFolderAtPath(relativePath: string): Promise<void> {
    await this.service.addFolderAtPath(relativePath);
    this.publishItems();
  }

  /** 拖入的应用内 uri-list（编辑器标签 / 资源管理器）。 */
  async addDroppedUris(uris: readonly string[]): Promise<void> {
    await this.service.addDroppedUris(uris);
    this.publishItems();
  }

  /** 从系统资源管理器拖入的文件：按名字在仓库里还原路径。 */
  async addDroppedNamedFile(name: string, content: string): Promise<void> {
    await this.service.addDroppedNamedFile(name, content);
    this.publishItems();
  }

  /** 已添加上下文的去重键，供 @ 候选标记「已添加」。 */
  addedKeys(): string[] {
    return this.service.current.map((item) => `${item.type}:${item.workspaceRelativePath}`);
  }

  addTerminalOutput(): void {
    this.service.addTerminalOutput();
    this.publishItems();
  }

  /**
   * 粘贴 / 拖入的图片。
   *
   * 当前模型不收图就在这里拦下：Webview 那边也拦一次，但它拿的是上一次下发的能力快照，
   * 而模型可能刚被切走。宿主这一道才是准的。
   */
  addImage(name: string, dataUrl: string): void {
    if (!this.deps.supportsVision()) {
      this.deps.post({
        type: "notice",
        level: "warn",
        message: "当前模型不支持图片输入，换一个支持看图的模型再试。",
      });
      return;
    }
    this.service.addImage(name, dataUrl);
    this.publishItems();
  }

  async addTerminalSelection(): Promise<void> {
    await this.service.addTerminalSelection();
    this.publishItems();
  }

  remove(id: string): boolean {
    if (!this.service.remove(id)) return false;
    this.publishItems();
    return true;
  }

  clear(): void {
    this.service.clear();
    this.publishItems();
  }

  /** 会话切换：连历史轮次里的图片字节一起丢。 */
  clearImages(): void {
    this.service.clearImages();
  }

  find(id: string): AgentContextItem | undefined {
    return this.service.current.find((candidate) => candidate.id === id);
  }

  publishItems(): void {
    const items = this.service.current.map(toContextView);
    this.deps.store.setContextItems(items);
    this.deps.post({ type: "contextItems", items });
  }

  toUsageView(): UsageView {
    const usage = this.usage.current;
    return {
      label: formatUsageLabel(usage),
      level: this.usage.level,
      source: usage.source,
      usedTokens: usage.usedTokens,
      ...(usage.contextLimit === undefined ? {} : { contextLimit: usage.contextLimit }),
      ...(usage.percentage === undefined ? {} : { percentage: usage.percentage }),
      compactCapability: this.usage.compactionCapability,
      compactBusy: this.compactBusy,
      ...(this.usage.lastBreakdown ? { breakdown: this.usage.lastBreakdown } : {}),
    };
  }

  pushUsage(): void {
    const window = this.deps.modelContextWindow();
    if (window !== undefined && window > 0) this.usage.setContextLimit(window);
    const view = this.toUsageView();
    this.deps.store.setUsage(this.usage.current, this.usage.level, this.usage.lastBreakdown);
    this.deps.store.patchRuntime({
      compactCapability: view.compactCapability,
      compactBusy: view.compactBusy,
    });
    this.deps.post({ type: "usage", usage: view });
    this.pushComposerStatus();
  }

  pushComposerStatus(): void {
    const line = composerStatusLine({
      mode: this.deps.mode(),
      model: this.deps.modelId(),
      usage: this.usage.current,
    });
    this.deps.post({ type: "composerStatus", line });
  }

  async compactConversation(): Promise<void> {
    if (this.usage.compactionCapability !== "available") {
      this.deps.post({ type: "notice", level: "info", message: "当前 Runtime 不支持手动压缩。" });
      return;
    }
    const now = Date.now();
    if (this.compactBusy || now - this.lastCompactAt < COMPACT_COOLDOWN_MS) {
      this.deps.post({ type: "notice", level: "info", message: "压缩请求过于频繁，请稍候。" });
      return;
    }
    const runtime = this.deps.runtime();
    if (!runtime?.sessionId) {
      this.deps.post({ type: "notice", level: "warn", message: "尚未连接会话，无法压缩。" });
      return;
    }
    this.compactBusy = true;
    this.lastCompactAt = now;
    this.usage.compactionStarted("manual");
    try {
      await runtime.compactConversation();
      this.usage.compactionCompleted("manual");
      this.deps.appendTranscriptNotice("已手动压缩上下文");
      this.deps.post({ type: "notice", level: "info", message: "上下文压缩完成。" });
    } catch (error) {
      this.usage.compactionFailed("manual", errorText(error));
      this.deps.post({ type: "error", message: `压缩失败：${errorText(error)}`, recoverable: true });
    } finally {
      this.compactBusy = false;
      this.deps.store.patchRuntime({ compactBusy: false });
      this.pushUsage();
    }
  }

  appendTerminalBuffer(text: string): void {
    const merged = `${this.terminalBuffer}${text}`;
    this.terminalBuffer = merged.length > TERMINAL_BUFFER_CHARS
      ? merged.slice(merged.length - TERMINAL_BUFFER_CHARS)
      : merged;
  }

  recentTerminalOutput(): { text: string; lines: number } | undefined {
    if (this.terminalBuffer.trim() === "") return undefined;
    return { text: this.terminalBuffer, lines: this.terminalBuffer.split("\n").length };
  }
}
