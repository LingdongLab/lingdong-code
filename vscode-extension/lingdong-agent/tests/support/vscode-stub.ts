/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 测试用的 vscode 模块替身。
 * 只覆盖扩展实际调用到的 API，并把所有交互式入口做成可预置队列，
 * 让 AgentController 能在 Node 下被完整驱动。
 *
 * 由 tests/support/vscode-resolver.mjs 把裸说明符 "vscode" 指到这里。
 */

import * as nodePath from "node:path";

type Answer = unknown;

interface HarnessState {
  workspaceRoot: string | undefined;
  workspaceName: string | undefined;
  /** 多根工作区里第一个之外的那些根。 */
  extraFolders: string[];
  config: Map<string, unknown>;
  files: string[];
  diagnostics: unknown[];
  clipboard: string;
  quickPick: Answer[];
  inputBox: Answer[];
  warning: Answer[];
  information: Answer[];
  error: Answer[];
  openDialog: Answer[];
  executed: Array<{ command: string; args: unknown[] }>;
  shown: string[];
  messages: Array<{ level: string; text: string }>;
  opened: string[];
  /** SecretStorage 替身；断言时可以直接检查里面有没有明文。 */
  secrets: Map<string, string>;
  globalState: Map<string, unknown>;
  contentProviders: Map<string, unknown>;
  progress: unknown[];
  progressReports: Array<{ message?: string; increment?: number }>;
  panels: TestWebviewPanel[];
}

const state: HarnessState = createState();

function createState(): HarnessState {
  return {
    workspaceRoot: undefined,
    workspaceName: undefined,
    extraFolders: [],
    config: new Map(),
    files: [],
    diagnostics: [],
    clipboard: "",
    quickPick: [],
    inputBox: [],
    warning: [],
    information: [],
    error: [],
    openDialog: [],
    executed: [],
    shown: [],
    messages: [],
    opened: [],
    secrets: new Map(),
    globalState: new Map(),
    contentProviders: new Map(),
    progress: [],
    progressReports: [],
    panels: [],
  };
}

function take(queue: Answer[]): Answer {
  return queue.length > 0 ? queue.shift() : undefined;
}

export const __test = {
  get state(): HarnessState {
    return state;
  },
  reset(): void {
    Object.assign(state, createState());
  },
  setWorkspace(root: string | undefined, name?: string): void {
    state.workspaceRoot = root;
    state.workspaceName = name ?? (root ? nodePath.basename(root) : undefined);
    state.extraFolders = [];
  },
  /** 预置一个多根工作区：第一个根仍然是 setWorkspace 给的那个。 */
  setExtraFolders(...paths: string[]): void {
    state.extraFolders = [...paths];
  },
  workspaceFolderPaths(): string[] {
    return (workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  },
  setConfig(key: string, value: unknown): void {
    state.config.set(key, value);
  },
  setFiles(relativePaths: string[]): void {
    state.files = [...relativePaths];
  },
  queueQuickPick(...answers: Answer[]): void {
    state.quickPick.push(...answers);
  },
  queueInputBox(...answers: Answer[]): void {
    state.inputBox.push(...answers);
  },
  queueWarning(...answers: Answer[]): void {
    state.warning.push(...answers);
  },
  queueOpenDialog(...answers: Answer[]): void {
    state.openDialog.push(...answers);
  },
  queueInformation(...answers: Answer[]): void {
    state.information.push(...answers);
  },
  queueError(...answers: Answer[]): void {
    state.error.push(...answers);
  },
  executedCommands(): string[] {
    return state.executed.map((entry) => entry.command);
  },
  /** ExtensionContext.secrets 替身；与 globalState 一起构成凭据存储。 */
  createSecretStorage() {
    return {
      get(key: string): Promise<string | undefined> {
        return Promise.resolve(state.secrets.get(key));
      },
      store(key: string, value: string): Promise<void> {
        state.secrets.set(key, value);
        return Promise.resolve();
      },
      delete(key: string): Promise<void> {
        state.secrets.delete(key);
        return Promise.resolve();
      },
      onDidChange: (_listener: (event: unknown) => void) => new Disposable(),
    };
  },
  createMemento() {
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const value = state.globalState.get(key);
        return (value === undefined ? fallback : value) as T | undefined;
      },
      update(key: string, value: unknown): Promise<void> {
        if (value === undefined) state.globalState.delete(key);
        else state.globalState.set(key, value);
        return Promise.resolve();
      },
      keys(): readonly string[] {
        return [...state.globalState.keys()];
      },
      setKeysForSync(_keys: readonly string[]): void {
        // 测试里不需要同步语义。
      },
    };
  },
  contentProvider(scheme: string): unknown {
    return state.contentProviders.get(scheme);
  },
  /** 最近一个由 createWebviewPanel 造出来的面板。 */
  lastPanel(): TestWebviewPanel | undefined {
    return state.panels[state.panels.length - 1];
  },
};

// —— Uri ——

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}

  get fsPath(): string {
    if (this.scheme !== "file") return this.path;
    const trimmed = this.path.replace(/^\/(?=[A-Za-z]:)/, "");
    return nodePath.normalize(trimmed);
  }

  with(change: { scheme?: string; path?: string; query?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      this.fragment,
    );
  }

  toString(): string {
    const query = this.query ? `?${this.query}` : "";
    return `${this.scheme}://${this.authority}${this.path}${query}`;
  }

  static file(fsPath: string): Uri {
    const normalized = fsPath.replace(/\\/g, "/");
    return new Uri("file", "", normalized.startsWith("/") ? normalized : `/${normalized}`, "", "");
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(value);
    if (!match) return Uri.file(value);
    return new Uri(match[1] ?? "file", match[2] ?? "", match[3] ?? "", match[4] ?? "", "");
  }

  static from(parts: { scheme: string; authority?: string; path?: string; query?: string }): Uri {
    return new Uri(parts.scheme, parts.authority ?? "", parts.path ?? "", parts.query ?? "", "");
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments].join("/").replace(/\/{2,}/g, "/");
    return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
  }
}

// —— 基础类型 ——

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void = () => undefined) {}
  dispose(): void {
    this.callOnDispose();
  }
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class RelativePattern {
  constructor(readonly base: unknown, readonly pattern: string) {}
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  constructor(readonly start: Position, readonly end: Position) {}
}

export class Selection extends Range {}

export class TreeItem {
  label: string | undefined;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  collapsibleState: number | undefined;
  constructor(label?: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export const QuickPickItemKind = { Separator: -1, Default: 0 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const ViewColumn = { One: 1, Two: 2, Beside: -2 } as const;
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

// —— window ——

export const window = {
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
  terminals: [] as unknown[],
  activeTerminal: undefined as unknown,

  onDidChangeActiveTextEditor(_listener: (editor: unknown) => void) {
    return new Disposable();
  },

  showQuickPick(items: unknown, _options?: unknown): Promise<unknown> {
    void items;
    return Promise.resolve(take(state.quickPick));
  },
  showInputBox(_options?: unknown): Promise<unknown> {
    return Promise.resolve(take(state.inputBox));
  },
  showWarningMessage(message: string, ...rest: unknown[]): Promise<unknown> {
    void rest;
    state.messages.push({ level: "warn", text: message });
    return Promise.resolve(take(state.warning));
  },
  showInformationMessage(message: string, ...rest: unknown[]): Promise<unknown> {
    void rest;
    state.messages.push({ level: "info", text: message });
    return Promise.resolve(take(state.information));
  },
  showErrorMessage(message: string, ...rest: unknown[]): Promise<unknown> {
    void rest;
    state.messages.push({ level: "error", text: message });
    return Promise.resolve(take(state.error));
  },
  showOpenDialog(_options?: unknown): Promise<unknown> {
    return Promise.resolve(take(state.openDialog));
  },
  showTextDocument(target: unknown, _options?: unknown): Promise<unknown> {
    state.shown.push(String((target as { toString(): string })?.toString?.() ?? target));
    return Promise.resolve({});
  },
  createOutputChannel(name: string) {
    return {
      name,
      appendLine: () => undefined,
      append: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    };
  },
  createQuickPick<T>() {
    const emitterless = {
      title: "",
      placeholder: "",
      items: [] as T[],
      selectedItems: [] as T[],
      activeItems: [] as T[],
      onDidAccept: (_listener: () => void) => new Disposable(),
      onDidHide: (listener: () => void) => {
        queueMicrotask(listener);
        return new Disposable();
      },
      onDidTriggerItemButton: (_listener: (event: unknown) => void) => new Disposable(),
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    };
    return emitterless;
  },
  createTreeView(_id: string, _options: unknown) {
    return { dispose: () => undefined, reveal: () => Promise.resolve() };
  },
  registerWebviewViewProvider(_id: string, _provider: unknown, _options?: unknown) {
    return new Disposable();
  },
  /**
   * 长任务进度条。生产代码用它包住连接测试，替身直接执行任务体：
   * 之前完全没有这个 API，一调就抛。
   */
  withProgress<T>(
    options: unknown,
    task: (
      progress: { report(value: { message?: string; increment?: number }): void },
      token: { isCancellationRequested: boolean; onCancellationRequested(listener: () => void): Disposable },
    ) => Promise<T>,
  ): Promise<T> {
    state.progress.push(options);
    return task(
      { report: (value) => { state.progressReports.push(value); } },
      { isCancellationRequested: false, onCancellationRequested: () => new Disposable() },
    );
  },

  /**
   * 可交互的 Webview 面板替身：记录 html 与 postMessage，并把 onDidReceiveMessage
   * 的监听器暴露出来，测试可以模拟界面发消息。原来的静态壳无法验证消息往返。
   */
  createWebviewPanel(type: string, title: string, _column: unknown, _options?: unknown) {
    const panel: TestWebviewPanel = {
      viewType: type,
      title,
      posted: [],
      messageListeners: [],
      disposeListeners: [],
      revealed: 0,
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-test",
        asWebviewUri: (uri: Uri) => uri,
        postMessage: (message: unknown) => {
          panel.posted.push(message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (listener: (raw: unknown) => void) => {
          panel.messageListeners.push(listener);
          return new Disposable();
        },
      },
      reveal: () => { panel.revealed += 1; },
      onDidDispose: (listener: () => void) => {
        panel.disposeListeners.push(listener);
        return new Disposable();
      },
      dispose: () => {
        for (const listener of panel.disposeListeners) listener();
      },
      /** 模拟界面发来一条消息。 */
      send(raw: unknown): void {
        for (const listener of panel.messageListeners) listener(raw);
      },
    };
    state.panels.push(panel);
    return panel;
  },
};

export interface TestWebviewPanel {
  viewType: string;
  title: string;
  posted: unknown[];
  messageListeners: Array<(raw: unknown) => void>;
  disposeListeners: Array<() => void>;
  revealed: number;
  webview: {
    options: unknown;
    html: string;
    cspSource: string;
    asWebviewUri(uri: Uri): Uri;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage(listener: (raw: unknown) => void): Disposable;
  };
  reveal(): void;
  onDidDispose(listener: () => void): Disposable;
  dispose(): void;
  send(raw: unknown): void;
}

// —— workspace ——

function workspaceFolder() {
  if (!state.workspaceRoot) return undefined;
  return {
    uri: Uri.file(state.workspaceRoot),
    name: state.workspaceName ?? nodePath.basename(state.workspaceRoot),
    index: 0,
  };
}

export const workspace = {
  get workspaceFolders() {
    const first = workspaceFolder();
    if (!first) return undefined;
    return [
      first,
      ...state.extraFolders.map((path, offset) => ({
        uri: Uri.file(path),
        name: nodePath.basename(path),
        index: offset + 1,
      })),
    ];
  },
  /**
   * 真实实现只在「首个根变化」和「单根→多根」时重启扩展宿主，替身里不模拟重启，
   * 只按下标改列表，让调用方能断言到底动了哪一段。
   */
  updateWorkspaceFolders(
    start: number,
    deleteCount: number | undefined | null,
    ...adds: Array<{ uri: Uri; name?: string }>
  ): boolean {
    const folders = (workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    if (start < 0 || start > folders.length) return false;
    const previousFirst = folders[0];
    folders.splice(start, deleteCount ?? 0, ...adds.map((add) => add.uri.fsPath));
    const [first, ...rest] = folders;
    state.workspaceRoot = first;
    if (first !== previousFirst) state.workspaceName = first ? nodePath.basename(first) : undefined;
    state.extraFolders = rest;
    return true;
  },
  get name() {
    return state.workspaceName;
  },
  getConfiguration(section?: string) {
    const prefix = section ? `${section}.` : "";
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const value = state.config.get(`${prefix}${key}`);
        return (value === undefined ? fallback : value) as T | undefined;
      },
      update(key: string, value: unknown): Promise<void> {
        state.config.set(`${prefix}${key}`, value);
        return Promise.resolve();
      },
      has(key: string): boolean {
        return state.config.has(`${prefix}${key}`);
      },
      /**
       * state.config 里只有测试显式写进去的值，package.json 的默认值走 get 的 fallback 参数。
       * 所以「map 里有」正好等价于真实 VS Code 的「用户配过」，统一归到 globalValue。
       */
      inspect<T>(key: string) {
        const full = `${prefix}${key}`;
        return {
          key: full,
          ...(state.config.has(full) ? { globalValue: state.config.get(full) as T } : {}),
        };
      },
    };
  },
  findFiles(_include: unknown, _exclude?: unknown, maxResults?: number): Promise<Uri[]> {
    const root = state.workspaceRoot;
    if (!root) return Promise.resolve([]);
    const limited = maxResults === undefined ? state.files : state.files.slice(0, maxResults);
    return Promise.resolve(limited.map((relative) => Uri.file(nodePath.join(root, relative))));
  },
  asRelativePath(target: Uri | string, _includeWorkspaceFolder?: boolean): string {
    const fsPath = typeof target === "string" ? target : target.fsPath;
    const root = state.workspaceRoot;
    if (!root) return fsPath;
    const relative = nodePath.relative(root, fsPath);
    return relative.startsWith("..") ? fsPath : relative;
  },
  openTextDocument(target?: unknown): Promise<unknown> {
    state.opened.push(typeof target === "string" ? target : JSON.stringify(target ?? {}));
    return Promise.resolve({ uri: target, getText: () => "" });
  },
  registerTextDocumentContentProvider(scheme: string, provider: unknown) {
    state.contentProviders.set(scheme, provider);
    return new Disposable(() => state.contentProviders.delete(scheme));
  },
  onDidChangeConfiguration(_listener: (event: unknown) => void) {
    return new Disposable();
  },
  fs: {
    readFile(_uri: Uri): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array());
    },
    stat(_uri: Uri): Promise<{ size: number; type: number }> {
      return Promise.resolve({ size: 0, type: FileType.File });
    },
  },
};

// —— commands / env / languages ——

export const commands = {
  executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    state.executed.push({ command, args });
    return Promise.resolve(undefined);
  },
  registerCommand(_command: string, _callback: unknown) {
    return new Disposable();
  },
};

export const env = {
  /** 装机版里是 `<安装根>/resources/app`；测试给一个不存在的路径，自带 Grok 探测自然落空。 */
  appRoot: "/stub/resources/app",
  openExternal(uri: Uri): Promise<boolean> {
    state.executed.push({ command: "env.openExternal", args: [uri.toString()] });
    return Promise.resolve(true);
  },
  clipboard: {
    readText(): Promise<string> {
      return Promise.resolve(state.clipboard);
    },
    writeText(text: string): Promise<void> {
      state.clipboard = text;
      return Promise.resolve();
    },
  },
};

export const languages = {
  getDiagnostics(): Array<[Uri, unknown[]]> {
    return state.diagnostics as Array<[Uri, unknown[]]>;
  },
  setTextDocumentLanguage(document: unknown, _languageId: string): Promise<unknown> {
    return Promise.resolve(document);
  },
};

export const extensions = {
  getExtension(_id: string): unknown {
    return undefined;
  },
};
