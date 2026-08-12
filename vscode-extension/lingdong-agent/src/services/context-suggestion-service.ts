import {
  type CandidateSource,
  type ContextCandidate,
  SUGGEST_QUERY_MAX,
  buildSuggestions,
} from "../composer/context-candidate";
import { isExcludedPath, normalizeRelativePath } from "../context-model";
import type { HostToWebviewMessage } from "../messages";

/**
 * 内联 @ 候选的宿主侧解析。
 *
 * 安全边界：Webview 只回传宿主先前下发的 opaque candidateId 与它声称的来源类型。
 * 路径永远不出现在入站协议里，因此 Webview 无法伪造任意文件；
 * id 查不到、或来源类型与注册表不一致，一律拒绝。
 *
 * 真实的读取、边界校验、二进制探测、限额与脱敏仍然全部由 ContextService 完成，
 * 这里不重写任何一条安全规则。
 */

/** 候选注册表上限：足够覆盖用户连续输入产生的多轮候选，又不无限增长。 */
const REGISTRY_LIMIT = 200;
/** 最近使用队列上限；展示时再由纯数据层截到 5 项。 */
const RECENT_LIMIT = 20;
/** 目录候选只在用户输入了关键词后才出现，否则浮层会被目录淹没。 */
const FOLDER_MIN_QUERY = 1;
/** 工作区文件列表的缓存时长：连续按键只扫一次工作区。 */
const FILE_CACHE_TTL_MS = 5_000;

export type ResolvedCandidate =
  | { source: "current-file" }
  | { source: "selection" }
  | { source: "problems" }
  | { source: "terminal" }
  | { source: "file"; relativePath: string }
  | { source: "folder"; relativePath: string };

export interface ActiveFileInfo {
  relativePath: string;
  hasSelection: boolean;
}

export interface ContextSuggestionDeps {
  post(message: HostToWebviewMessage): void;
  workspaceRoot(): string | undefined;
  /** 工作区文件相对路径；调用方负责套用既有的排除 glob。 */
  listFiles(): Promise<string[]>;
  activeFile(): ActiveFileInfo | undefined;
  diagnosticsCount(): number;
  /** 可用的终端输出行数；0 表示暂无。 */
  terminalLines(): number;
  /** 已加入上下文的 `type:relativePath` 键，用于标记「已添加」。 */
  addedKeys(): string[];
  /** 本会话 Agent 改动过的文件，作为最近使用来源之一。 */
  changedFiles(): string[];
  /** 真正执行添加；由 ContextFacade 复用既有入口。 */
  add(target: ResolvedCandidate): Promise<void>;
}

/** 快捷上下文的 id 固定：它们不含路径信息，稳定 id 不会泄漏任何东西。 */
const QUICK_IDS: Record<"current-file" | "selection" | "problems" | "terminal", string> = {
  "current-file": "q-current-file",
  selection: "q-selection",
  problems: "q-problems",
  terminal: "q-terminal",
};

export class ContextSuggestionService {
  private readonly registry = new Map<string, ResolvedCandidate>();
  private readonly recent: string[] = [];
  private seq = 0;
  private cache: { at: number; files: string[] } | undefined;

  constructor(private readonly deps: ContextSuggestionDeps, private readonly now = () => Date.now()) {}

  /** 切换会话时清空：旧候选 id 不应在新会话里继续可用。 */
  reset(): void {
    this.registry.clear();
    this.recent.length = 0;
    this.cache = undefined;
  }

  /** 用户打开文件时记入最近使用；排除工作区外与被排除的路径。 */
  noteOpened(relativePath: string | undefined): void {
    if (!relativePath) return;
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || normalized.startsWith("..")) return;
    if (isExcludedPath(normalized).excluded) return;
    this.pushRecent(normalized);
  }

  async suggest(rawQuery: string): Promise<void> {
    const query = rawQuery.slice(0, SUGGEST_QUERY_MAX);
    if (!this.deps.workspaceRoot()) {
      this.deps.post({ type: "contextSuggestResults", query, groups: [], truncated: false, matched: 0 });
      return;
    }

    const added = new Set(this.deps.addedKeys());
    const quick = this.quickCandidates(added);
    const allowed = await this.workspaceFiles();

    const recentPaths = this.recentPaths(allowed);
    const recent = recentPaths.map((relativePath) => this.fileCandidate(relativePath, "recent", added));

    const workspace: ContextCandidate[] = allowed
      .filter((relativePath) => !recentPaths.includes(relativePath))
      .map((relativePath) => this.fileCandidate(relativePath, "workspace", added));
    if (query.trim().length >= FOLDER_MIN_QUERY) {
      workspace.push(...this.folderCandidates(allowed, added));
    }

    const result = buildSuggestions({ query, quick, recent, workspace });
    this.deps.post({
      type: "contextSuggestResults",
      query,
      groups: result.groups,
      truncated: result.truncated,
      matched: result.matched,
    });
  }

  /**
   * 落实一次选择。返回 false 表示候选无效，调用方已收到提示。
   */
  async select(candidateId: string, sourceType: CandidateSource): Promise<boolean> {
    const resolved = this.registry.get(candidateId);
    if (!resolved) {
      this.warn("这条上下文候选已失效，请重新输入 @ 选择。");
      return false;
    }
    if (resolved.source !== sourceType) {
      // 来源类型与注册表不符，说明请求被改写过，直接拒绝。
      this.warn("上下文候选校验失败，已忽略。");
      return false;
    }
    await this.deps.add(resolved);
    if (resolved.source === "file") this.pushRecent(resolved.relativePath);
    return true;
  }

  /** 带 TTL 缓存的工作区文件列表；敏感与二进制文件在这一步就被排除。 */
  private async workspaceFiles(): Promise<string[]> {
    const at = this.now();
    const cached = this.cache;
    if (cached && at - cached.at < FILE_CACHE_TTL_MS) return cached.files;
    const files = (await this.deps.listFiles())
      .map((file) => normalizeRelativePath(file))
      .filter((file) => file !== "" && !isExcludedPath(file).excluded);
    this.cache = { at, files };
    return files;
  }

  private quickCandidates(added: ReadonlySet<string>): ContextCandidate[] {
    const active = this.deps.activeFile();
    const problems = this.deps.diagnosticsCount();
    const terminalLines = this.deps.terminalLines();

    const currentFile: ContextCandidate = {
      id: this.register(QUICK_IDS["current-file"], { source: "current-file" }),
      source: "current-file",
      label: "当前文件",
      group: "quick",
      ...(active ? { detail: active.relativePath } : { disabledReason: "当前没有打开的文件" }),
      ...(active && added.has(`file:${active.relativePath}`) ? { alreadyAdded: true } : {}),
    };

    const selection: ContextCandidate = {
      id: this.register(QUICK_IDS.selection, { source: "selection" }),
      source: "selection",
      label: "选中代码",
      group: "quick",
      ...(active?.hasSelection
        ? { detail: active.relativePath }
        : { disabledReason: "当前没有选中内容" }),
    };

    const problemsCandidate: ContextCandidate = {
      id: this.register(QUICK_IDS.problems, { source: "problems" }),
      source: "problems",
      label: problems > 0 ? `问题面板 (${problems})` : "问题面板",
      group: "quick",
      ...(problems > 0 ? {} : { disabledReason: "当前没有诊断信息" }),
      ...(added.has("diagnostics:") ? { alreadyAdded: true } : {}),
    };

    const terminal: ContextCandidate = {
      id: this.register(QUICK_IDS.terminal, { source: "terminal" }),
      source: "terminal",
      label: "终端输出",
      group: "quick",
      ...(terminalLines > 0
        ? { detail: `${terminalLines} 行` }
        : { disabledReason: "还没有可用的终端输出" }),
      ...(added.has("terminal:") ? { alreadyAdded: true } : {}),
    };

    return [currentFile, selection, problemsCandidate, terminal];
  }

  private fileCandidate(
    relativePath: string,
    group: "recent" | "workspace",
    added: ReadonlySet<string>,
  ): ContextCandidate {
    const name = relativePath.split("/").filter(Boolean).pop() ?? relativePath;
    return {
      id: this.register(this.nextId(), { source: "file", relativePath }),
      source: "file",
      label: name,
      detail: relativePath,
      group,
      ...(added.has(`file:${relativePath}`) ? { alreadyAdded: true } : {}),
    };
  }

  /**
   * 目录候选从命中文件的路径前缀派生。
   * 工作区列举本身不返回目录节点，这里不额外遍历文件系统。
   */
  private folderCandidates(files: readonly string[], added: ReadonlySet<string>): ContextCandidate[] {
    const directories = new Set<string>();
    for (const file of files) {
      const parts = file.split("/").filter(Boolean);
      for (let depth = 1; depth < parts.length; depth += 1) {
        directories.add(parts.slice(0, depth).join("/"));
      }
    }
    return [...directories].map((relativePath) => ({
      id: this.register(this.nextId(), { source: "folder", relativePath }),
      source: "folder" as const,
      label: relativePath.split("/").filter(Boolean).pop() ?? relativePath,
      detail: relativePath,
      group: "workspace" as const,
      ...(added.has(`folder:${relativePath}`) ? { alreadyAdded: true } : {}),
    }));
  }

  private recentPaths(allowed: readonly string[]): string[] {
    const known = new Set(allowed);
    const merged: string[] = [];
    for (const relativePath of [...this.recent, ...this.deps.changedFiles().map(normalizeRelativePath)]) {
      if (!known.has(relativePath) || merged.includes(relativePath)) continue;
      merged.push(relativePath);
    }
    return merged;
  }

  private pushRecent(relativePath: string): void {
    const index = this.recent.indexOf(relativePath);
    if (index >= 0) this.recent.splice(index, 1);
    this.recent.unshift(relativePath);
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
  }

  private nextId(): string {
    this.seq += 1;
    return `c${this.seq}`;
  }

  private register(id: string, resolved: ResolvedCandidate): string {
    this.registry.set(id, resolved);
    // 超出上限时丢最早的条目；快捷 id 会在每轮 suggest 里重新登记，不会被永久淘汰。
    while (this.registry.size > REGISTRY_LIMIT) {
      const oldest = this.registry.keys().next();
      if (oldest.done) break;
      this.registry.delete(oldest.value);
    }
    return id;
  }

  private warn(message: string): void {
    this.deps.post({ type: "notice", level: "warn", message });
  }
}
