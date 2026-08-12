import { EventEmitter } from "node:events";
import {
  AcpClient,
  DEFAULT_MODEL_ID,
  type AcpClientInfo,
  type PermissionChoice,
  type WatchdogConfig,
  type WriteGuard,
} from "./acp-client.js";
import type { AgentEvent } from "./event-normalizer.js";
import { GrokBuildAdapter, type CompactCapability } from "./grok-build-adapter.js";
import { HunkTrackerClient } from "./hunk-tracker.js";
import { SafeLogger, registerRuntimeSecrets } from "./logger.js";
import { ProcessManager, type ProcessExit } from "./process-manager.js";
import type { InitializeResult } from "./protocol.js";
import type { ApprovalPolicy, ClientMode } from "./safety-policy.js";
import { composePromptRules } from "./prompt-rules.js";
import type { DurablePermissionRules } from "./session-permissions.js";
import { detectGrokVersion, type GrokVersionInfo } from "./version.js";

export type AgentMode = ClientMode;

export interface RuntimeInitializeOptions {
  /** Grok Build 可执行文件绝对路径。 */
  executable: string;
  /** 工作区根目录，同时作为子进程 cwd 与安全边界。 */
  workspace: string;
  /** 日志目录，写入 app.log 与 acp-raw.log。 */
  logDirectory: string;
  modelId?: string;
  /** 显式传入 GROK_HOME，避免宿主进程未继承用户级环境变量。 */
  grokHome?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo?: AcpClientInfo;
  args?: string[];
  versionCheckTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** 写入类操作放行前的钩子，用于宿主保存修改前快照；返回 ok:false 会把该操作改判为拒绝。 */
  beforeWrite?: WriteGuard;
  /**
   * 需要在日志里整串替换的凭据字面量。
   * 凭据由宿主的 SecretStorage 管理后不再出现在 process.env 里，
   * 日志脱敏拿不到字面量，必须由调用方显式登记。
   */
  redactValues?: readonly string[];
  /** 静默看门狗阈值（prompt/load 无响应检测与 cancel 兜底）；主要供测试注入更小的值。 */
  watchdog?: WatchdogConfig;
  /** Agent 模式的审批力度；默认 balanced（工作区内改动与常规命令自动放行）。 */
  approvalPolicy?: ApprovalPolicy;
  /** 「以后都允许」的落盘存储；不传则该选项退化为「本次会话允许」。 */
  durableRules?: DurablePermissionRules;
  /**
   * 注入系统提示的规则文本。不传用 {@link DEFAULT_PROMPT_RULES}；
   * 传空串则完全不注入。
   */
  promptRules?: string;
  /** 追加在默认规则之后的项目自定义规则。promptRules 显式给了就忽略这项。 */
  extraPromptRules?: string;
}

export interface RuntimeInfo {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: Record<string, unknown>;
  authMethods?: unknown[];
  grok: GrokVersionInfo;
  modelId: string;
  workspace: string;
  appLogPath: string;
  rawLogPath: string;
}

export interface CreateSessionOptions {
  cwd?: string;
  mode?: AgentMode;
}

export interface SendMessageRequest {
  text: string;
}

export interface AgentRuntimeEvents {
  event: [AgentEvent];
}

export declare interface AgentRuntime {
  on<K extends keyof AgentRuntimeEvents>(event: K, listener: (...args: AgentRuntimeEvents[K]) => void): this;
  off<K extends keyof AgentRuntimeEvents>(event: K, listener: (...args: AgentRuntimeEvents[K]) => void): this;
  emit<K extends keyof AgentRuntimeEvents>(event: K, ...args: AgentRuntimeEvents[K]): boolean;
}

/**
 * Agent Runtime 门面：封装 Grok Build 子进程、ACP 协议、安全策略与日志脱敏。
 * 不依赖 VS Code API、DOM、Webview 或终端交互。
 *
 * 事件路由：一轮提示词执行期间，事件只流向 sendMessage 返回的异步迭代器；
 * 轮次之外（例如模式切换、异常退出）的事件通过 "event" 发出。
 */
export class AgentRuntime extends EventEmitter {
  private readonly options: RuntimeInitializeOptions;
  private readonly logger: SafeLogger;
  private readonly process: ProcessManager;
  private readonly client: AcpClient;
  private readonly compactAdapter: GrokBuildAdapter;
  /** 逐 hunk 审阅通道；能力探测按需惰性发生，方法不存在时自动降级。 */
  readonly hunks: HunkTrackerClient;
  private modelId: string;
  private readonly shutdownTimeoutMs: number;
  private turnSink: ((event: AgentEvent) => void) | undefined;
  private runtimeInfo: RuntimeInfo | undefined;
  private disposed = false;

  constructor(options: RuntimeInitializeOptions) {
    super();
    this.options = options;
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    if (options.redactValues) registerRuntimeSecrets(options.redactValues);
    this.logger = new SafeLogger(options.logDirectory);

    const baseEnv = options.env ?? process.env;
    const env: NodeJS.ProcessEnv = options.grokHome
      ? { ...baseEnv, GROK_HOME: options.grokHome }
      : { ...baseEnv };

    this.process = new ProcessManager({
      executable: options.executable,
      // --no-auto-update 是比 config.toml auto_update=false 更硬的保证：
      // 子进程启动即跳过更新检查，连接更快也不产生额外网络请求。
      args: options.args ?? ["--no-auto-update", "agent", "-m", this.modelId, "stdio"],
      cwd: options.workspace,
      env,
    });

    this.client = new AcpClient(this.process, this.logger, options.workspace, {
      modelId: this.modelId,
      ...(options.clientInfo ? { clientInfo: options.clientInfo } : {}),
      ...(options.beforeWrite ? { beforeWrite: options.beforeWrite } : {}),
      ...(options.watchdog ? { watchdog: options.watchdog } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.durableRules ? { durableRules: options.durableRules } : {}),
      promptRules: options.promptRules ?? composePromptRules(undefined, options.extraPromptRules),
    });
    this.compactAdapter = new GrokBuildAdapter(
      {
        request: (method, params) => this.client.extensionRequest(method, params),
      },
      { sessionId: () => this.client.sessionId },
    );
    this.hunks = new HunkTrackerClient(
      {
        request: (method, params) => this.client.extensionRequest(method, params),
      },
      { sessionId: () => this.client.sessionId },
    );

    this.client.on("event", (event) => this.routeEvent(event));
  }

  get info(): RuntimeInfo | undefined { return this.runtimeInfo; }
  get sessionId(): string | undefined { return this.client.sessionId; }
  get mode(): AgentMode { return this.client.mode; }
  get serverMode(): string | undefined { return this.client.serverMode; }
  get pendingPermissionIds(): string[] { return this.client.pendingPermissionIds; }
  get pendingPlanId(): string | undefined { return this.client.pendingPlanId; }
  get pendingQuestionId(): string | undefined { return this.client.pendingQuestionId; }
  get model(): string { return this.modelId; }
  get processRunning(): boolean { return this.process.running; }
  get appLogPath(): string { return this.logger.appLogPath; }
  get rawLogPath(): string { return this.logger.rawLogPath; }
  get compactCapability(): CompactCapability { return this.compactAdapter.compactCapability; }
  /** 实际注入 `<human_rules>` 的文本，供「规则诊断」展示。 */
  get injectedRules(): string { return this.client.injectedRules; }

  /** 检测 Grok 版本、启动子进程并完成 ACP initialize。 */
  async initialize(): Promise<RuntimeInfo> {
    const grok = await detectGrokVersion(
      this.options.executable,
      this.options.grokHome
        ? { ...(this.options.env ?? process.env), GROK_HOME: this.options.grokHome }
        : this.options.env ?? process.env,
      this.options.versionCheckTimeoutMs ?? 10_000,
    );
    if (!grok.exists) throw new Error(grok.error ?? `未找到 Grok 可执行文件：${this.options.executable}`);

    await this.logger.app("INFO", "启动 Grok ACP 子进程", {
      executable: this.options.executable,
      workspace: this.options.workspace,
      modelId: this.modelId,
      grokVersion: grok.version ?? "unknown",
    });

    const result: InitializeResult = await this.client.start();
    this.compactAdapter.discoverCapabilities(result.agentCapabilities);
    this.runtimeInfo = {
      protocolVersion: result.protocolVersion,
      ...(result.agentCapabilities ? { agentCapabilities: result.agentCapabilities } : {}),
      ...(result.agentInfo ? { agentInfo: result.agentInfo } : {}),
      ...(result.authMethods ? { authMethods: result.authMethods } : {}),
      grok,
      modelId: this.modelId,
      workspace: this.options.workspace,
      appLogPath: this.logger.appLogPath,
      rawLogPath: this.logger.rawLogPath,
    };
    return this.runtimeInfo;
  }

  /** 实测 Grok 是否支持手动 compact；结果记在 compactCapability。 */
  async probeCompact(): Promise<CompactCapability> {
    return this.compactAdapter.probeCompact();
  }

  /** 手动压缩当前会话上下文；不可用时抛错，绝不发送 /compact 文本。 */
  async compactConversation(context?: string): Promise<void> {
    await this.compactAdapter.compactConversation(context);
  }

  /**
   * 终止后台任务或子 Agent。
   *
   * `x.ai/task/kill` 这个方法名取自 grok.exe 里的字符串，本地没有源码可对照，
   * 0.2.118 是否真的接受它无法离线确认。所以这里只负责把请求发出去，
   * 失败就把错误原样抛给宿主——宿主会退回到「让模型自己调 kill 工具」那条路。
   */
  async killTask(taskId: string): Promise<void> {
    await this.client.extensionRequest("x.ai/task/kill", {
      sessionId: this.client.sessionId,
      taskId,
      task_id: taskId,
    });
  }

  async createSession(options: CreateSessionOptions = {}): Promise<string> {
    const sessionId = await this.client.newSession(
      options.cwd ?? this.options.workspace,
      options.mode ?? this.client.mode,
    );
    await this.logger.app("INFO", "已创建 ACP 会话", { sessionId });
    return sessionId;
  }

  async loadSession(sessionId: string, cwd?: string, mode?: AgentMode): Promise<void> {
    if (mode) this.client.setLocalMode(mode);
    await this.client.loadSession(sessionId, cwd ?? this.options.workspace);
    await this.logger.app("INFO", "已恢复 ACP 会话", { sessionId, mode: this.client.mode });
  }

  async setMode(mode: AgentMode): Promise<void> {
    await this.client.setMode(mode);
  }

  /** 切换会话模型；成功后同步 RuntimeInfo.modelId。 */
  async setModel(modelId: string): Promise<void> {
    await this.client.setModel(modelId);
    this.modelId = this.client.model;
    if (this.runtimeInfo) this.runtimeInfo = { ...this.runtimeInfo, modelId: this.modelId };
    await this.logger.app("INFO", "已切换模型", { modelId: this.modelId });
  }

  /** 发送一轮提示词，按标准化事件流式返回，直到 completed 或失败。 */
  async *sendMessage(request: SendMessageRequest): AsyncIterable<AgentEvent> {
    if (this.turnSink) throw new Error("上一轮任务仍在执行");

    const queue: AgentEvent[] = [];
    let notify: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;

    this.turnSink = (event) => {
      queue.push(event);
      if (event.type === "completed") finished = true;
      notify?.();
    };

    const pending = this.client.prompt(request.text).catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
      finished = true;
      notify?.();
    });

    try {
      for (;;) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          notify = () => { notify = undefined; resolve(); };
        });
      }
      await pending;
      if (failure) throw failure;
    } finally {
      this.turnSink = undefined;
      for (const leftover of queue) this.emit("event", leftover);
    }
  }

  /** 回应一次待确认的权限请求；allow_session / allow_always 只写入本地范围规则。 */
  async respondPermission(requestId: string, decision: PermissionChoice): Promise<void> {
    await this.client.respondPermission(requestId, decision);
    await this.logger.app("INFO", "已回应权限请求", { requestId, decision });
  }

  /** 审批力度改动即时生效。 */
  setApprovalPolicy(approval: ApprovalPolicy): void {
    this.client.setApprovalPolicy(approval);
  }

  /** 批准计划：回执 approved 并把本地安全策略切到 Agent，避免 Plan 策略硬拒后续写入。 */
  async approvePlan(): Promise<void> {
    const requestId = this.client.pendingPlanId;
    if (!requestId) throw new Error("当前没有待审批的计划");
    await this.client.respondPlan(requestId, { outcome: "approved" });
    this.client.setLocalMode("agent");
    await this.logger.app("INFO", "计划已批准，本地策略切换为 agent", { requestId });
  }

  /**
   * 批准计划，但不让 Grok 在同一轮里自己一路做完。
   *
   * Grok 的 exit_plan_mode 只有三种回执：approved 会让它在同一轮里把整个计划做穿，
   * cancelled 是打回重做且留在 Plan 模式，abandoned 是退出 Plan 模式并停手。
   * 逐步门控要的正是「退出 Plan 模式 + 停手」——停手换来轮次边界，退出 Plan 模式
   * 换来后续步骤能真的改文件（Plan 模式下除 plan.md 以外的写入一律被拒）。
   * 所以这里回 abandoned：那是 Grok 的用词，对用户来说这一步仍然是批准，
   * 只不过接下来由宿主一步一步下发。
   */
  async approvePlanStepwise(): Promise<void> {
    const requestId = this.client.pendingPlanId;
    if (!requestId) throw new Error("当前没有待审批的计划");
    await this.client.respondPlan(requestId, { outcome: "abandoned" });
    this.client.setLocalMode("agent");
    await this.logger.app("INFO", "计划已批准，改由宿主逐步下发", { requestId });
  }

  /** 放弃计划：Grok 停止本轮并保持在 Plan 模式。 */
  async rejectPlan(): Promise<void> {
    const requestId = this.client.pendingPlanId;
    if (!requestId) throw new Error("当前没有待审批的计划");
    await this.client.respondPlan(requestId, { outcome: "abandoned" });
    await this.logger.app("INFO", "计划已放弃", { requestId });
  }

  /** 要求修改计划：把反馈回传给 Grok，由它重新出计划。 */
  async revisePlan(feedback: string): Promise<void> {
    const requestId = this.client.pendingPlanId;
    if (!requestId) throw new Error("当前没有待审批的计划");
    await this.client.respondPlan(requestId, { outcome: "cancelled", feedback });
    await this.logger.app("INFO", "已要求修改计划", { requestId });
  }

  /** 回答模型的提问；answers 与 questions 一一对应。 */
  async respondQuestion(requestId: string, answers: string[]): Promise<void> {
    await this.client.respondQuestion(requestId, answers);
    await this.logger.app("INFO", "已回答模型提问", { requestId, answerCount: answers.length });
  }

  clearPending(reason: string): void {
    this.client.clearPending(reason);
  }

  clearSessionRules(): void {
    this.client.clearSessionRules();
  }

  async cancel(): Promise<void> {
    await this.client.cancel();
  }

  /** 关闭 stdin、等待 Grok 退出，超时后终止进程。0.2.118 没有 session/close。 */
  async dispose(): Promise<ProcessExit | undefined> {
    if (this.disposed) return undefined;
    this.disposed = true;
    try {
      await this.logger.app("INFO", "关闭 Agent Runtime", { sessionId: this.client.sessionId ?? null });
    } catch {
      // 日志失败不应阻塞退出
    }
    const exit = await this.client.shutdown(this.shutdownTimeoutMs);
    this.client.removeAllListeners();
    this.removeAllListeners();
    return exit;
  }

  private routeEvent(event: AgentEvent): void {
    if (this.turnSink) this.turnSink(event);
    else this.emit("event", event);
  }
}

/**
 * AgentRuntime 的公开操作面。
 * 宿主侧只依赖这个结构化类型，测试才能在不拉起真实 Grok 子进程的前提下替换实现。
 */
export type AgentRuntimeHandle = Pick<
  AgentRuntime,
  | "info"
  | "sessionId"
  | "mode"
  | "serverMode"
  | "pendingPermissionIds"
  | "pendingPlanId"
  | "model"
  | "processRunning"
  | "appLogPath"
  | "rawLogPath"
  | "compactCapability"
  | "initialize"
  | "probeCompact"
  | "compactConversation"
  | "createSession"
  | "loadSession"
  | "setMode"
  | "setModel"
  | "sendMessage"
  | "respondPermission"
  | "approvePlan"
  | "approvePlanStepwise"
  | "rejectPlan"
  | "revisePlan"
  | "pendingQuestionId"
  | "respondQuestion"
  | "clearPending"
  | "clearSessionRules"
  | "cancel"
  | "dispose"
> & {
  // 返回值刻意放宽为 unknown：AgentRuntime 上这两个方法返回 this，
  // 直接 Pick 会把结构化替身钉死成必须继承 AgentRuntime。
  on(event: "event", listener: (event: AgentEvent) => void): unknown;
  off(event: "event", listener: (event: AgentEvent) => void): unknown;
  /** 可选成员：测试替身无需实现，设置项改动时宿主按存在与否调用。 */
  setApprovalPolicy?(approval: ApprovalPolicy): void;
  /** 可选成员：规则诊断用，测试替身无需实现。 */
  readonly injectedRules?: string;
  /** 可选成员：终止后台任务，宿主按存在与否降级。 */
  killTask?(taskId: string): Promise<void>;
  /** 可选成员：逐 hunk 审阅通道；测试替身无需实现，宿主按存在与否降级。 */
  readonly hunks?: HunkTrackerClient;
};

export type AgentRuntimeFactory = (options: RuntimeInitializeOptions) => AgentRuntimeHandle;

export function createAgentRuntime(options: RuntimeInitializeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
