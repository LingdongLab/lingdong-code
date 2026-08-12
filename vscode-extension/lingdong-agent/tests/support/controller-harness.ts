import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  AgentEvent,
  AgentRuntimeHandle,
  RuntimeInfo,
  RuntimeInitializeOptions,
} from "@lingdong/agent-runtime";
import { AgentController } from "../../src/agent-controller";
import type { HostToWebviewMessage } from "../../src/messages";
import type { ProviderConfig } from "../../src/models/providers/provider-types";
import { SCHEMA_VERSION } from "../../src/storage/storage-migration";
import { __test as vscodeHarness } from "./vscode-stub";

/**
 * AgentController 集成测试脚手架。
 * 真实跑通「Webview 消息 → 控制器 → 会话落盘」这条链路，
 * 只把 Grok 子进程换成可脚本化的假 Runtime。
 */

/** 一轮任务的脚本：按顺序把事件喂给控制器。 */
export type TurnScript = (prompt: string) => AgentEvent[];

/** Agent 正文引导只给模型看；假 Runtime / 断言仍用用户原文。Plan 引导保留。 */
export function stripAgentReplyGuidance(text: string): string {
  if (!text.includes("【回复风格】")) return text;
  const marker = "【用户任务】\n";
  const idx = text.lastIndexOf(marker);
  return idx >= 0 ? text.slice(idx + marker.length) : text;
}

export class FakeRuntime implements AgentRuntimeHandle {
  readonly options: RuntimeInitializeOptions;
  readonly prompts: string[] = [];
  readonly calls: string[] = [];

  sessionId: string | undefined;
  mode = "ask" as AgentRuntimeHandle["mode"];
  serverMode: string | undefined;
  pendingPermissionIds: string[] = [];
  pendingPlanId: string | undefined;
  pendingQuestionId: string | undefined;
  model: string;
  processRunning = true;
  appLogPath = "app.log";
  rawLogPath = "raw.log";
  compactCapability = "unavailable" as AgentRuntimeHandle["compactCapability"];
  info: RuntimeInfo | undefined;

  /** 每一轮返回的事件；默认只回一段文本再完成。 */
  script: TurnScript = (prompt) => [
    { type: "text_delta", text: `收到：${prompt}` },
    { type: "completed", stopReason: "end_turn" },
  ];
  /** 置为真时 initialize 抛错，用于测试连接失败与重连。 */
  failInitialize: Error | undefined;
  /** 置为真时 sendMessage 中途抛错。 */
  failTurn: Error | undefined;
  loadSessionError: Error | undefined;

  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private nextSessionSeq = 0;

  constructor(options: RuntimeInitializeOptions) {
    this.options = options;
    this.model = options.modelId ?? "deepseek-v4-flash";
  }

  on(_event: "event", listener: (event: AgentEvent) => void): unknown {
    this.listeners.add(listener);
    return this;
  }

  off(_event: "event", listener: (event: AgentEvent) => void): unknown {
    this.listeners.delete(listener);
    return this;
  }

  /** 模拟轮次之外的事件，例如子进程异常退出。 */
  emitOutOfTurn(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async initialize(): Promise<RuntimeInfo> {
    this.calls.push("initialize");
    if (this.failInitialize) throw this.failInitialize;
    const info: RuntimeInfo = {
      protocolVersion: 1,
      grok: {
        executable: this.options.executable,
        exists: true,
        version: "0.2.118",
        tested: true,
      },
      modelId: this.model,
      workspace: this.options.workspace,
      appLogPath: this.appLogPath,
      rawLogPath: this.rawLogPath,
    };
    this.info = info;
    return info;
  }

  async probeCompact(): Promise<AgentRuntimeHandle["compactCapability"]> {
    this.calls.push("probeCompact");
    return this.compactCapability;
  }

  async compactConversation(_context?: string): Promise<void> {
    this.calls.push("compactConversation");
  }

  async createSession(_options: { cwd?: string; mode?: string } = {}): Promise<string> {
    this.calls.push("createSession");
    this.nextSessionSeq += 1;
    this.sessionId = `grok-session-${this.nextSessionSeq}`;
    return this.sessionId;
  }

  // cwd / mode 这里用不上，但签名要跟 AgentRuntimeHandle 一致，
  // 否则测试里包一层 loadSession 时参数对不上。
  async loadSession(sessionId: string, _cwd?: string, _mode?: string): Promise<void> {
    this.calls.push(`loadSession:${sessionId}`);
    if (this.loadSessionError) throw this.loadSessionError;
    this.sessionId = sessionId;
  }

  async setMode(mode: string): Promise<void> {
    this.calls.push(`setMode:${mode}`);
    this.mode = mode as AgentRuntimeHandle["mode"];
  }

  async setModel(modelId: string): Promise<void> {
    this.calls.push(`setModel:${modelId}`);
    this.model = modelId;
  }

  async *sendMessage(request: { text: string }): AsyncIterable<AgentEvent> {
    // Agent 引导语只服务模型；测试断言与脚本回显仍用用户原文。Plan 引导保留。
    const text = stripAgentReplyGuidance(request.text);
    this.prompts.push(text);
    if (this.failTurn) throw this.failTurn;
    for (const event of this.script(text)) {
      // 让出事件循环，贴近真实的流式节奏。
      await Promise.resolve();
      yield event;
    }
  }

  async respondPermission(requestId: string, decision: string): Promise<void> {
    this.calls.push(`respondPermission:${requestId}:${decision}`);
  }

  async approvePlan(): Promise<void> {
    this.calls.push("approvePlan");
  }

  async approvePlanStepwise(): Promise<void> {
    this.calls.push("approvePlanStepwise");
  }

  async rejectPlan(): Promise<void> {
    this.calls.push("rejectPlan");
  }

  async revisePlan(feedback: string): Promise<void> {
    this.calls.push(`revisePlan:${feedback}`);
  }

  async respondQuestion(requestId: string, answers: string[]): Promise<void> {
    this.calls.push(`respondQuestion:${requestId}:${answers.join("|")}`);
    this.pendingQuestionId = undefined;
  }

  clearPending(_reason: string): void {
    this.calls.push("clearPending");
  }

  clearSessionRules(): void {
    this.calls.push("clearSessionRules");
  }

  async cancel(): Promise<void> {
    this.calls.push("cancel");
  }

  async dispose(): Promise<undefined> {
    this.calls.push("dispose");
    this.processRunning = false;
    this.listeners.clear();
    return undefined;
  }
}

export interface ControllerHarness {
  controller: AgentController;
  /** 控制器推给 Webview 的全部消息，按时间顺序。 */
  messages: HostToWebviewMessage[];
  /** 已创建的假 Runtime，按创建顺序。 */
  runtimes: FakeRuntime[];
  /** 最近一个假 Runtime。 */
  runtime(): FakeRuntime;
  workspaceRoot: string;
  storageRoot: string;
  logLines: string[];
  /** 设定 workspace.findFiles 返回的相对路径列表。 */
  setWorkspaceFiles(relativePaths: string[]): void;
  messagesOfType<T extends HostToWebviewMessage["type"]>(
    type: T,
  ): Array<Extract<HostToWebviewMessage, { type: T }>>;
  /** 清空已记录消息，便于断言某个动作之后新产生的消息。 */
  clearMessages(): void;
  dispose(): Promise<void>;
}

/** 集成测试默认的 DeepSeek 凭据；足够长，能被脱敏器整串替换。 */
export const DEFAULT_TEST_KEY = "sk-test-deepseek-key-0123456789";

export interface HarnessOptions {
  /** 复用已有的存储目录，用来验证「重开扩展后恢复会话」。 */
  storageRoot?: string;
  workspaceRoot?: string;
  onCreateRuntime?: (runtime: FakeRuntime) => void;
  /** 预置的 Provider 凭据；传 null 表示刻意不配置，用于验证凭据缺失路径。 */
  providerKey?: string | null;
  /**
   * 写进 settings 的 `lingdongAgent.model`。
   *
   * 传 null 表示用户从没写过这一项——这是真实安装后的常态，
   * 读到的是 package.json 里的默认值。启动解析对「用户写的」和「我们的默认值」
   * 处理不同，两者必须能分开表达。
   */
  modelSetting?: string | null;
  /** 额外预置的 Provider（连同凭据），在控制器加载配置之前写进存储目录。 */
  extraProviders?: Array<{ provider: ProviderConfig; key: string }>;
}

/** 直接写 providers.json，绕开需要联网测试的添加流程。 */
function seedProviders(storageRoot: string, entries: Array<{ provider: ProviderConfig; key: string }>): void {
  if (entries.length === 0) return;
  const dir = path.join(storageRoot, "agent-providers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "providers.json"),
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      kind: "providers",
      updatedAt: Date.now(),
      data: { providers: entries.map((entry) => entry.provider) },
    }),
    "utf8",
  );
  const index = new Set(
    (vscodeHarness.state.globalState.get("lingdongAgent.providerKeyIndex") as string[] | undefined) ?? [],
  );
  for (const entry of entries) {
    vscodeHarness.state.secrets.set(`lingdongAgent.providerKey.${entry.provider.id}`, entry.key);
    index.add(entry.provider.id);
  }
  vscodeHarness.state.globalState.set("lingdongAgent.providerKeyIndex", [...index]);
}

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 建一个可用的控制器实例：真实工作区目录、真实落盘、假 Runtime。
 * 调用方负责 await harness.dispose()。
 */
export function createControllerHarness(options: HarnessOptions = {}): ControllerHarness {
  const workspaceRoot = options.workspaceRoot ?? makeTempRoot("lingdong-ws-");
  const storageRoot = options.storageRoot ?? makeTempRoot("lingdong-store-");
  const logRoot = path.join(storageRoot, "logs");
  fs.mkdirSync(logRoot, { recursive: true });

  // resolveGrokExecutable 会做 statSync 存在性校验，这里放一个占位文件。
  const executable = path.join(storageRoot, process.platform === "win32" ? "grok.exe" : "grok");
  if (!fs.existsSync(executable)) fs.writeFileSync(executable, "");

  vscodeHarness.reset();
  vscodeHarness.setWorkspace(workspaceRoot, path.basename(workspaceRoot));
  vscodeHarness.setConfig("lingdongAgent.grokExecutable", executable);
  if (options.modelSetting !== null) {
    vscodeHarness.setConfig("lingdongAgent.model", options.modelSetting ?? "deepseek-v4-flash");
  }

  const logLines: string[] = [];
  const output = {
    name: "lingdong-agent-test",
    appendLine: (line: string) => logLines.push(line),
    append: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  } as unknown as vscode.OutputChannel;

  const context = {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    globalStorageUri: vscode.Uri.file(storageRoot),
    logUri: vscode.Uri.file(logRoot),
    extensionUri: vscode.Uri.file(storageRoot),
    extensionPath: storageRoot,
    // 宿主侧 WebSearch MCP 路径解析依赖此方法；测试目录通常没有产物，existsSync 为 false。
    asAbsolutePath: (relativePath: string) => path.join(storageRoot, relativePath),
    secrets: vscodeHarness.createSecretStorage(),
    globalState: vscodeHarness.createMemento(),
    // 模型选择存在 workspaceState 里；桩里两个 Memento 共用一张表，互不冲突。
    workspaceState: vscodeHarness.createMemento(),
  } as unknown as vscode.ExtensionContext;

  // 凭据缺失会让 Runtime 拒绝启动，这是本轮刻意加的门禁；
  // 集成测试关心的是启动之后的链路，所以先把 DeepSeek 的 Key 备好。
  if (options.providerKey !== null) {
    vscodeHarness.state.secrets.set(
      "lingdongAgent.providerKey.deepseek",
      options.providerKey ?? DEFAULT_TEST_KEY,
    );
    vscodeHarness.state.globalState.set("lingdongAgent.providerKeyIndex", ["deepseek"]);
  }
  seedProviders(storageRoot, options.extraProviders ?? []);

  const runtimes: FakeRuntime[] = [];
  const controller = new AgentController(context, output, {
    createRuntime: (runtimeOptions) => {
      const runtime = new FakeRuntime(runtimeOptions);
      runtimes.push(runtime);
      options.onCreateRuntime?.(runtime);
      return runtime;
    },
  });

  const messages: HostToWebviewMessage[] = [];
  controller.addPoster((message) => messages.push(message));

  return {
    controller,
    messages,
    runtimes,
    workspaceRoot,
    storageRoot,
    logLines,
    runtime(): FakeRuntime {
      const last = runtimes.at(-1);
      if (!last) throw new Error("尚未创建 Runtime");
      return last;
    },
    setWorkspaceFiles(relativePaths: string[]): void {
      vscodeHarness.setFiles(relativePaths);
    },
    messagesOfType<T extends HostToWebviewMessage["type"]>(type: T) {
      return messages.filter(
        (message): message is Extract<HostToWebviewMessage, { type: T }> => message.type === type,
      );
    },
    clearMessages(): void {
      messages.length = 0;
    },
    async dispose(): Promise<void> {
      await controller.dispose();
    },
  };
}

/** 等待所有已排队的微任务与计时器回调跑完。 */
export function flush(times = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  return chain;
}
