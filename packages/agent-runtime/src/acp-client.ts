import { EventEmitter } from "node:events";
import { parseAskUserRequest, type AskUserAnswerResult, type AskUserRequest } from "./ask-question.js";
import { EventNormalizer, type AgentEvent } from "./event-normalizer.js";
import { parsePlan, type AgentPlan } from "./plan-parser.js";
import { type ProcessExit } from "./process-manager.js";
import {
  buildCancelNotification,
  hasOwn,
  isRecord,
  type ExitPlanModeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcErrorObject,
  type JsonRpcResponse,
  type PermissionRequestParams,
  type SessionNewResult,
  type SessionUpdateParams,
} from "./protocol.js";
import {
  type ApprovalPolicy,
  type ClientMode,
  type SafetyDecision,
  WorkspaceSafetyPolicy,
} from "./safety-policy.js";
import {
  deriveSessionRule,
  SessionPermissionCache,
  type DurablePermissionRules,
} from "./session-permissions.js";
import { SafeLogger } from "./logger.js";

export const DEFAULT_MODEL_ID = "deepseek-v4-flash";

/** JSON-RPC 错误详情的截断长度；够定位问题，又不至于把整段响应糊到界面上。 */
const ERROR_DETAIL_LIMIT = 400;

/** 静默看门狗触发的超时；调用方据此把「模型无响应」与普通 RPC 错误区分开。 */
export class AcpSilenceTimeoutError extends Error {}

/**
 * 静默看门狗阈值。静默 = 一段时间内没有任何入站消息（正文/思考/工具输出/反向请求都算活跃）；
 * 权限、计划、提问等人工门禁打开期间等的是用户不是模型，不计入静默。
 * 各字段填 0 表示关闭对应检测。
 */
export interface WatchdogConfig {
  /** session/prompt 的静默阈值。默认 5 分钟。 */
  promptIdleMs?: number;
  /** session/prompt 的绝对上限，持续输出也不能无限拖。默认 4 小时。 */
  promptMaxMs?: number;
  /** cancel 发出后等待收尾响应的静默阈值，到点合成取消完成。默认 15 秒。 */
  cancelGraceMs?: number;
  /** session/load 的静默阈值（回放期间更新流会不断重置）。默认 30 秒。 */
  loadIdleMs?: number;
  /** session/load 的绝对上限。默认 10 分钟。 */
  loadMaxMs?: number;
}

const WATCHDOG_DEFAULTS: Required<WatchdogConfig> = {
  // 整整十分钟看不到任何东西、也等不到一句解释，用户早就当它死了。
  // 静默指的是一条入站消息都没有，正常干活时工具输出和正文会不断把它推后，
  // 所以这个值卡的是「真的不动了」，不是「想得久」。
  promptIdleMs: 300_000,
  promptMaxMs: 14_400_000,
  cancelGraceMs: 15_000,
  loadIdleMs: 30_000,
  loadMaxMs: 600_000,
};

/**
 * `message` 常常只有一句「Internal error」，真正说得清原因的是 `data`。
 * 丢掉 data 会让上层只能给出「操作未成功，详情见日志」这种没法据以行动的提示。
 */
export function describeRpcError(error: JsonRpcErrorObject): string {
  const base = `ACP ${error.code}: ${error.message}`;
  if (error.data === undefined || error.data === null) return base;
  const detail = typeof error.data === "string" ? error.data : JSON.stringify(error.data);
  if (!detail || detail === base) return base;
  const trimmed = detail.length > ERROR_DETAIL_LIMIT
    ? `${detail.slice(0, ERROR_DETAIL_LIMIT)}…`
    : detail;
  return `${base} — ${trimmed}`;
}

export interface AcpTransport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(timeoutMs?: number): Promise<ProcessExit | undefined>;
  on(event: "message", listener: (message: JsonRpcMessage) => void): this;
  on(event: "invalidJson", listener: (error: Error) => void): this;
  on(event: "stderr", listener: (text: string) => void): this;
  on(event: "exit", listener: (result: ProcessExit) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type PermissionChoice = "allow_once" | "allow_session" | "allow_always" | "reject";
export type PlanChoice =
  | { outcome: "approved" }
  | { outcome: "cancelled"; feedback: string }
  | { outcome: "abandoned" };

export interface AcpClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface WriteGuardInput {
  requestId: string;
  decision: SafetyDecision;
  /** true 表示这次放行来自策略或会话规则，没有经过人工确认。 */
  automatic: boolean;
}

export interface WriteGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * 写入前钩子。Auto 模式与会话规则会在 Runtime 内部直接放行，
 * 宿主没有别的机会在文件被改动之前保存快照，因此放行前统一 await 这个钩子；
 * 返回 ok: false 时该操作改判为拒绝。
 */
export type WriteGuard = (input: WriteGuardInput) => Promise<WriteGuardResult>;

export interface AcpClientConfig {
  modelId?: string;
  clientInfo?: AcpClientInfo;
  beforeWrite?: WriteGuard;
  watchdog?: WatchdogConfig;
  /** Agent 模式的审批力度；默认 balanced。 */
  approvalPolicy?: ApprovalPolicy;
  /** 「以后都允许」的落盘存储；不传则该选项退化为「本次会话允许」。 */
  durableRules?: DurablePermissionRules;
  /**
   * 注入到系统提示的行为规则（`_meta.rules` → `<human_rules>`）。
   * 空串或不传即不注入。`grok agent` 没有 `--rules` 参数，这是唯一入口。
   */
  promptRules?: string;
}

const DEFAULT_CLIENT_INFO: AcpClientInfo = {
  name: "lingdong-agent-runtime",
  title: "灵动 Agent Runtime",
  version: "0.1.0",
};

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** 固定墙钟超时（短 RPC 用）。 */
  timer?: NodeJS.Timeout;
  /** 静默看门狗：每条入站活动重置；到点判定模型无响应。 */
  idleMs?: number;
  idleTimer?: NodeJS.Timeout;
  /** 绝对上限：持续输出也不能无限拖。 */
  maxMs?: number;
  maxTimer?: NodeJS.Timeout;
  /** 静默超时的处置：默认 reject；cancel 兜底改为合成取消完成。 */
  onSilence?: "reject" | "resolve-cancelled";
}

/** request() 的看门狗参数；不传则该请求只受固定墙钟约束。 */
interface RequestWatch {
  idleMs: number;
  maxMs?: number;
}

interface PendingPermission {
  id: JsonRpcId;
  params: PermissionRequestParams;
  decision: SafetyDecision;
}

interface PendingPlan {
  id: JsonRpcId;
  plan: AgentPlan;
}

interface PendingQuestion {
  id: JsonRpcId;
  request: AskUserRequest;
}

export interface AcpClientEvents {
  event: [AgentEvent];
}

export declare interface AcpClient {
  on<K extends keyof AcpClientEvents>(event: K, listener: (...args: AcpClientEvents[K]) => void): this;
  off<K extends keyof AcpClientEvents>(event: K, listener: (...args: AcpClientEvents[K]) => void): this;
  emit<K extends keyof AcpClientEvents>(event: K, ...args: AcpClientEvents[K]): boolean;
}

/**
 * ACP 客户端：只负责协议、安全判定与反向请求的登记，
 * 需要人工确认时通过事件把 requestId 交给宿主，由宿主调用 respondPermission / respondPlan 回执。
 */
export class AcpClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly reversePending = new Set<JsonRpcId>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly sessionRules: SessionPermissionCache;
  private readonly durableRules: DurablePermissionRules | undefined;
  private readonly normalizer = new EventNormalizer();
  private readonly safety: WorkspaceSafetyPolicy;
  private modelId: string;
  private readonly clientInfo: AcpClientInfo;
  private readonly beforeWrite: WriteGuard | undefined;
  private promptRulesText: string;
  private pendingPlanEntry: { requestId: string; entry: PendingPlan } | undefined;
  private pendingQuestionEntry: { requestId: string; entry: PendingQuestion } | undefined;
  private sessionIdValue: string | undefined;
  private modeValue: ClientMode = "ask";
  private serverModeValue: string | undefined;
  private initialized = false;
  private readonly watchdog: Required<WatchdogConfig>;
  /** 入站消息串行链：保证处理顺序等于到达顺序。 */
  private inbound: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: AcpTransport,
    private readonly logger: SafeLogger,
    workspace: string,
    config: AcpClientConfig = {},
  ) {
    super();
    this.safety = new WorkspaceSafetyPolicy(workspace, config.approvalPolicy ?? "balanced");
    this.durableRules = config.durableRules;
    this.sessionRules = new SessionPermissionCache(config.durableRules);
    this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
    this.clientInfo = config.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.beforeWrite = config.beforeWrite;
    this.promptRulesText = config.promptRules?.trim() ?? "";
    this.watchdog = { ...WATCHDOG_DEFAULTS, ...config.watchdog };
    // 严格串行：此前每条消息并发处理且日志 await 在分发之前，
    // 最后一段正文与 prompt 响应同帧到达时「完成」可能抢先处理，把答案尾巴截断在轮次外。
    transport.on("message", (message) => {
      this.inbound = this.inbound
        .then(() => this.handleMessage(message))
        .catch((error: unknown) => {
          void this.logger.app("ERROR", "处理入站 ACP 消息失败", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });
    transport.on("invalidJson", (error) => {
      void this.logger.app("ERROR", "收到无法解析的 ACP JSON", { message: error.message });
      this.emit("event", { type: "error", message: `ACP JSON 解析失败：${error.message}` });
    });
    transport.on("stderr", (text) => void this.logger.raw("STDERR", text));
    transport.on("error", (error) => {
      this.emit("event", { type: "disconnected", reason: error.message });
      this.failAll(error);
    });
    transport.on("exit", (result) => {
      if (result.expected) return;
      const reason = `Grok ACP 异常退出：code=${String(result.code)}, signal=${String(result.signal)}`;
      // 先发断线事件，保证宿主在轮次失败前就能作废缓存。
      this.emit("event", { type: "disconnected", reason, code: result.code, signal: result.signal });
      this.failAll(new Error(reason));
    });
  }

  get sessionId(): string | undefined { return this.sessionIdValue; }
  get mode(): ClientMode { return this.modeValue; }
  get serverMode(): string | undefined { return this.serverModeValue; }
  get model(): string { return this.modelId; }
  get pendingPermissionIds(): string[] { return [...this.pendingPermissions.keys()]; }
  get pendingPlanId(): string | undefined { return this.pendingPlanEntry?.requestId; }
  get pendingQuestionId(): string | undefined { return this.pendingQuestionEntry?.requestId; }
  get sessionRuleCount(): number { return this.sessionRules.size; }
  /** 已注入系统提示的规则文本；空串表示没注入。 */
  get injectedRules(): string { return this.promptRulesText; }

  /** 改规则；因为规则随建会话定稿，只对之后新建的会话生效。 */
  setPromptRules(rules: string): void {
    this.promptRulesText = rules.trim();
  }

  async start(): Promise<InitializeResult> {
    await this.transport.start();
    const result = await this.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        // 能力位放这里而不是 session/new：agent_ops.rs 只读 initialize 的
        // clientCapabilities._meta。探针实测 0.2.118 与自建 1.0.0 都认（.build/probe-caps-*.json）。
        _meta: {
          // 逐 hunk 追踪：all_dirty 连外部（用户手改）的 git 脏文件一起追，
          // Changes 面板才能像 Cursor 一样把「本轮改动之外的手改」也摆出来。
          "x.ai/hunkTracker": { mode: "all_dirty" },
          // bash 流式更新在 rawOutput.output_delta 里只发增量字节，长命令不再每帧重发全量。
          "x.ai/incrementalBashOutput": true,
          // 命令环境注入 NO_COLOR 系变量：我们的时间线/任务卡是纯文本渲染，不吃 ANSI 码。
          "x.ai/bashOutputNoColor": true,
        },
      },
      clientInfo: this.clientInfo,
    });
    if (result.protocolVersion !== 1) throw new Error(`不支持的 ACP 协议版本：${result.protocolVersion}`);
    this.initialized = true;
    return result;
  }

  async newSession(cwd: string, mode: ClientMode = this.modeValue): Promise<string> {
    this.assertInitialized();
    await this.clearPendingAsync("创建新会话");
    const result = await this.request<SessionNewResult>("session/new", {
      cwd,
      mcpServers: [],
      _meta: {
        autoMode: false,
        yoloMode: false,
        // 规则只能在建会话时给：Grok 建完会话就把系统提示定稿落盘了。
        ...(this.promptRulesText ? { rules: this.promptRulesText } : {}),
      },
    });
    this.sessionIdValue = result.sessionId;
    this.sessionRules.clear();
    this.normalizer.reset();
    this.serverModeValue = undefined;
    await this.request("session/set_model", { sessionId: result.sessionId, modelId: this.modelId });
    this.modeValue = "ask";
    await this.setMode(mode);
    return result.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    this.assertInitialized();
    await this.clearPendingAsync("恢复会话");
    // 大会话回放耗时与消息量成正比，固定墙钟会误伤；改用静默检测（回放更新流会不断重置）。
    await this.request("session/load", { sessionId, cwd, mcpServers: [] }, 0, this.watchdog.loadIdleMs > 0
      ? { idleMs: this.watchdog.loadIdleMs, ...(this.watchdog.loadMaxMs > 0 ? { maxMs: this.watchdog.loadMaxMs } : {}) }
      : undefined);
    this.sessionIdValue = sessionId;
    this.sessionRules.clear();
    this.normalizer.reset();
    await this.request("session/set_model", { sessionId, modelId: this.modelId });
    await this.setMode(this.modeValue);
  }

  async setMode(mode: ClientMode): Promise<void> {
    const sessionId = this.requireSession();
    if (mode === "plan" || mode === "agent") {
      await this.request("session/set_mode", { sessionId, modeId: mode });
      this.serverModeValue = mode;
    } else if (this.modeValue === "plan") {
      await this.request("session/set_mode", { sessionId, modeId: "agent" });
      this.serverModeValue = "agent";
    }
    this.modeValue = mode;
    this.emit("event", { type: "status", message: `客户端安全模式：${mode}` });
    this.emit("event", { type: "mode_changed", mode, source: "client" });
  }

  /** 仅调整本地安全策略模式，不发送 session/set_mode（用于 Grok 已自行切换的场景）。 */
  setLocalMode(mode: ClientMode): void {
    if (this.modeValue === mode) return;
    this.modeValue = mode;
    this.emit("event", { type: "mode_changed", mode, source: "client" });
  }

  /** 切换当前会话模型；失败时不改本地 modelId，由调用方回滚 UI。 */
  async setModel(modelId: string): Promise<void> {
    this.assertInitialized();
    const trimmed = modelId.trim();
    if (trimmed === "") throw new Error("模型标识不能为空");
    if (trimmed === this.modelId) return;
    const sessionId = this.requireSession();
    const previous = this.modelId;
    await this.request("session/set_model", { sessionId, modelId: trimmed });
    this.modelId = trimmed;
    this.emit("event", { type: "status", message: `模型已切换：${previous} → ${trimmed}` });
  }

  async prompt(text: string): Promise<Record<string, unknown>> {
    const sessionId = this.requireSession();
    let result: Record<string, unknown>;
    try {
      result = await this.request<Record<string, unknown>>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }, 0, this.watchdog.promptIdleMs > 0
        ? { idleMs: this.watchdog.promptIdleMs, ...(this.watchdog.promptMaxMs > 0 ? { maxMs: this.watchdog.promptMaxMs } : {}) }
        : undefined);
    } catch (error) {
      if (error instanceof AcpSilenceTimeoutError) {
        // 看门狗触发：清掉人工门禁、通知 Grok 停止本轮，再抛出能据以行动的错误。
        await this.clearPendingAsync("模型长时间无响应");
        await this.send(buildCancelNotification(sessionId)).catch(() => undefined);
        throw new Error("模型长时间无响应，已停止本轮任务；可重试或换一个模型。");
      }
      throw error;
    }
    const stopReason = typeof result.stopReason === "string" ? result.stopReason : "unknown";
    const meta = isRecord(result._meta) ? result._meta : {};
    const modelId = typeof meta.modelId === "string" ? meta.modelId : undefined;
    this.emit("event", { type: "completed", stopReason, ...(modelId ? { modelId } : {}) });
    return result;
  }

  async cancel(): Promise<void> {
    const sessionId = this.requireSession();
    await this.clearPendingAsync("用户取消任务");
    await this.send(buildCancelNotification(sessionId));
    // 兜底：Grok 正常会以 stopReason=cancelled 回应在飞的 prompt；
    // 若迟迟不回，事件流会永久挂起。这里把静默阈值收紧，到点合成取消完成。
    if (this.watchdog.cancelGraceMs > 0) {
      const entry = this.findPending("session/prompt");
      if (entry) {
        const [id, pending] = entry;
        pending.idleMs = this.watchdog.cancelGraceMs;
        pending.onSilence = "resolve-cancelled";
        this.armIdle(id, pending);
      }
    }
  }

  /**
   * 回应一次待确认的权限请求。无论用户选择哪一项，发给 Grok 的都只有
   * allow_once 或 reject_once；「本次会话允许」由本地范围规则实现。
   */
  async respondPermission(requestId: string, choice: PermissionChoice): Promise<void> {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) throw new Error(`权限请求已失效：${requestId}`);
    // 用户应答本身算一次活跃：先重置静默计时再摘掉门禁，
    // 否则「删门禁 → 异步回执」的空窗期可能正好撞上看门狗到点。
    this.touchActivity();
    this.pendingPermissions.delete(requestId);

    if (choice !== "reject") {
      const guard = await this.runWriteGuard(requestId, entry.decision, false);
      if (!guard.ok) {
        await this.answerPermission(entry.id, entry.params, "reject");
        this.emitGuardRejection(requestId, entry.decision, guard.reason);
        return;
      }
    }

    // 没有落盘存储时「以后都允许」只能退化为本次会话范围，不假装持久化成功。
    const scope = choice === "allow_always" && this.durableRules ? "always" : "session";
    const rule = choice === "allow_session" || choice === "allow_always"
      ? deriveSessionRule(entry.decision.subject, scope)
      : undefined;
    if (rule) this.sessionRules.allow(rule);

    await this.answerPermission(entry.id, entry.params, choice === "reject" ? "reject" : "allow_once");
    this.emit("event", {
      type: "permission_resolved",
      requestId,
      // 无法归纳出范围规则时退化为仅本次允许，避免 UI 误报「已记住」。
      resolution: !rule && choice !== "reject" && choice !== "allow_once"
        ? "allow_once"
        : rule?.scope === "always" ? "allow_always" : choice,
      automatic: false,
      reason: choice === "reject"
        ? `${entry.decision.label}：已拒绝`
        : rule ? `${entry.decision.label}：${rule.label}` : `${entry.decision.label}：已允许本次`,
      ...(rule ? { rule } : {}),
    });
  }

  async respondPlan(requestId: string, choice: PlanChoice): Promise<void> {
    const pending = this.pendingPlanEntry;
    if (!pending || pending.requestId !== requestId) throw new Error(`计划审批已失效：${requestId}`);
    this.touchActivity();
    this.pendingPlanEntry = undefined;
    if (this.reversePending.has(pending.entry.id)) {
      await this.respond(pending.entry.id, choice);
      this.reversePending.delete(pending.entry.id);
    }
    this.emit("event", { type: "plan_review_closed", requestId, outcome: choice.outcome });
  }

  /**
   * 回答模型的提问。answers 必须与 questions 一一对应；
   * 多选题由宿主把所选项合成一条文本再传进来。
   */
  async respondQuestion(requestId: string, answers: string[]): Promise<void> {
    const pending = this.pendingQuestionEntry;
    if (!pending || pending.requestId !== requestId) throw new Error(`提问已失效：${requestId}`);
    this.touchActivity();
    this.pendingQuestionEntry = undefined;
    if (this.reversePending.has(pending.entry.id)) {
      // answers 数组按下标与 questions 对齐，这里转成 Grok 要的「问题原文 → 答案」映射。
      const answerMap: Record<string, string> = {};
      pending.entry.request.questions.forEach((question, index) => {
        answerMap[question.question] = answers[index] ?? "";
      });
      await this.respond(pending.entry.id, { outcome: "accepted", answers: answerMap } satisfies AskUserAnswerResult);
      this.reversePending.delete(pending.entry.id);
    }
    this.emit("event", { type: "question_resolved", requestId, outcome: "answered", answers });
  }

  /** 同步清理所有待确认项；异步回执由 clearPendingAsync 负责。 */
  clearPending(reason: string): void {
    void this.clearPendingAsync(reason);
  }

  async clearPendingAsync(reason: string): Promise<void> {
    for (const [requestId, entry] of [...this.pendingPermissions]) {
      this.pendingPermissions.delete(requestId);
      if (this.reversePending.has(entry.id)) {
        await this.respond(entry.id, { outcome: { outcome: "cancelled" } });
        this.reversePending.delete(entry.id);
      }
      this.emit("event", {
        type: "permission_resolved",
        requestId,
        resolution: "cancelled",
        automatic: true,
        reason,
      });
    }
    const plan = this.pendingPlanEntry;
    if (plan) {
      this.pendingPlanEntry = undefined;
      if (this.reversePending.has(plan.entry.id)) {
        await this.respond(plan.entry.id, { outcome: "abandoned" } satisfies PlanChoice);
        this.reversePending.delete(plan.entry.id);
      }
      this.emit("event", { type: "plan_review_closed", requestId: plan.requestId, outcome: "dropped" });
    }
    const question = this.pendingQuestionEntry;
    if (question) {
      this.pendingQuestionEntry = undefined;
      if (this.reversePending.has(question.entry.id)) {
        // skip_interview 让 Grok 走「不带答案继续」，比回一个错误把工具打成失败温和得多。
        await this.respond(question.entry.id, { outcome: "skip_interview" } satisfies AskUserAnswerResult);
        this.reversePending.delete(question.entry.id);
      }
      this.emit("event", { type: "question_resolved", requestId: question.requestId, outcome: "cancelled" });
    }
  }

  clearSessionRules(): void {
    this.sessionRules.clear();
  }

  /** 设置项改动后即时切换审批力度，不必重连子进程。 */
  setApprovalPolicy(approval: ApprovalPolicy): void {
    this.safety.setApproval(approval);
  }

  async shutdown(timeoutMs?: number): Promise<ProcessExit | undefined> {
    this.pendingPermissions.clear();
    this.pendingPlanEntry = undefined;
    this.pendingQuestionEntry = undefined;
    this.sessionRules.clear();
    this.failAll(new Error("客户端正在关闭"), false);
    return this.transport.close(timeoutMs);
  }

  /**
   * 调用 Grok 扩展方法（如 compact_conversation）。
   * 标准会话 API 仍走专用方法，避免宿主直接拼 session/prompt。
   */
  async extensionRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    this.assertInitialized();
    return this.request<T>(method, params, timeoutMs);
  }

  private async request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000, watch?: RequestWatch): Promise<T> {
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve: (value) => resolve(value as T), reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          this.clearWatch(pending);
          reject(new Error(`ACP 请求超时：${method}`));
        }, timeoutMs);
        pending.timer.unref();
      }
      if (watch && watch.idleMs > 0) {
        pending.idleMs = watch.idleMs;
        if (watch.maxMs && watch.maxMs > 0) {
          pending.maxMs = watch.maxMs;
          this.armMax(id, pending);
        }
        this.armIdle(id, pending);
      }
      this.pending.set(id, pending);
    });
    // send() 会产生一次异步让步；提前挂接处理器，避免关闭竞态被 Node 视为未处理拒绝。
    void promise.catch(() => undefined);
    try {
      await this.send(message);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending?.timer) clearTimeout(pending.timer);
      if (pending) this.clearWatch(pending);
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  private findPending(method: string): [JsonRpcId, PendingRequest] | undefined {
    for (const entry of this.pending) {
      if (entry[1].method === method) return entry;
    }
    return undefined;
  }

  /** 任何入站活动都重置静默计时（正文/思考/工具输出/反向请求）。 */
  private touchActivity(): void {
    for (const [id, pending] of this.pending) {
      if (pending.idleMs) this.armIdle(id, pending);
    }
  }

  private armIdle(id: JsonRpcId, pending: PendingRequest): void {
    if (!pending.idleMs) return;
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => this.expireSilent(id, "idle"), pending.idleMs);
    pending.idleTimer.unref();
  }

  private armMax(id: JsonRpcId, pending: PendingRequest): void {
    if (!pending.maxMs) return;
    if (pending.maxTimer) clearTimeout(pending.maxTimer);
    pending.maxTimer = setTimeout(() => this.expireSilent(id, "absolute"), pending.maxMs);
    pending.maxTimer.unref();
  }

  /** 权限/计划/提问卡片等的是用户不是模型，门禁打开期间不算静默。 */
  private hasOpenGates(): boolean {
    return this.pendingPermissions.size > 0
      || this.pendingPlanEntry !== undefined
      || this.pendingQuestionEntry !== undefined;
  }

  private expireSilent(id: JsonRpcId, kind: "idle" | "absolute"): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (this.hasOpenGates()) {
      // 用户可能几十分钟后才回卡片；门禁打开时顺延计时（绝对上限一并顺延）。
      if (kind === "idle") this.armIdle(id, pending);
      else this.armMax(id, pending);
      return;
    }
    this.pending.delete(id);
    this.clearWatch(pending);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.onSilence === "resolve-cancelled") {
      void this.logger.app("WARN", "取消后未收到收尾响应，已合成取消完成", { method: pending.method });
      pending.resolve({ stopReason: "cancelled" });
      return;
    }
    void this.logger.app("ERROR", "ACP 请求静默超时", { method: pending.method, kind });
    pending.reject(new AcpSilenceTimeoutError(
      kind === "absolute"
        ? `ACP 请求超过绝对时限：${pending.method}`
        : `模型长时间无响应：${pending.method}`,
    ));
  }

  private clearWatch(pending: PendingRequest): void {
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
      delete pending.idleTimer;
    }
    if (pending.maxTimer) {
      clearTimeout(pending.maxTimer);
      delete pending.maxTimer;
    }
  }

  private async send(message: JsonRpcMessage): Promise<void> {
    await this.logger.raw("OUT", message);
    await this.transport.send(message);
  }

  private async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.send({ jsonrpc: "2.0", id, result } satisfies JsonRpcResponse);
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    // 日志不在关键路径上：先分发再异步落盘（SafeLogger 内部串行，文件顺序仍与处理顺序一致）。
    void this.logger.raw("IN", message);
    if (hasOwn(message, "method")) {
      const incoming = message as JsonRpcRequest;
      if (hasOwn(incoming, "id")) {
        this.touchActivity();
        this.reversePending.add(incoming.id);
        await this.handleReverseRequest(incoming);
      } else {
        this.handleNotification(incoming);
      }
      return;
    }

    const response = message as JsonRpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    this.clearWatch(pending);
    if (response.error) pending.reject(new Error(describeRpcError(response.error)));
    else pending.resolve(response.result);
  }

  private handleNotification(message: JsonRpcRequest): void {
    if (!isRecord(message.params)) return;
    this.touchActivity();

    if (message.method === "session/update" || message.method === "_x.ai/session_notification") {
      // session_notification 与 session/update 载荷同形；Grok 把工具参数流
      // （tool_call_delta_chunk）放在前者里。丢掉的话，写文件的那几分钟
      // 界面会一直停在「思考中」，用户以为卡死了。
      const params = message.params as unknown as SessionUpdateParams;
      for (const event of this.normalizer.normalize(params)) {
        if (event.type === "mode_changed" && event.source === "server") this.serverModeValue = event.mode;
        this.emit("event", event);
      }
      return;
    }

    if (message.method === "_x.ai/session/update") {
      for (const event of this.normalizer.normalizeExtensionUpdate(message.params)) {
        this.emit("event", event);
      }
    }
  }

  private async handleReverseRequest(message: JsonRpcRequest): Promise<void> {
    try {
      if (message.method === "session/request_permission") {
        await this.handlePermission(message.id, message.params as PermissionRequestParams);
      } else if (message.method === "_x.ai/exit_plan_mode") {
        this.handleExitPlanMode(message.id, message.params as ExitPlanModeParams);
      } else if (message.method === "_x.ai/ask_user_question") {
        await this.handleAskUserQuestion(message.id, message.params);
      } else {
        await this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `不支持的方法：${message.method}` } });
        this.reversePending.delete(message.id);
      }
    } catch (error) {
      if (this.reversePending.has(message.id)) {
        await this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        this.reversePending.delete(message.id);
      }
    }
  }

  private handleExitPlanMode(id: JsonRpcId, params: ExitPlanModeParams): void {
    const requestId = String(id);
    const plan = parsePlan(typeof params.planContent === "string" ? params.planContent : "");
    this.pendingPlanEntry = { requestId, entry: { id, plan } };
    this.emit("event", { type: "plan_review_requested", requestId, plan });
  }

  /**
   * 模型提问：登记待回执并交给宿主展示。
   * Grok 侧会一直阻塞到收到应答（托管配置里已关掉问答超时），
   * 因此取消/清场路径（clearPendingAsync）必须兜底回执，否则整轮悬死。
   */
  private async handleAskUserQuestion(id: JsonRpcId, params: unknown): Promise<void> {
    const request = parseAskUserRequest(params);
    if (!request) {
      // 没有可展示的问题时直接让 Grok 继续，不打断轮次，也不弹一张空卡。
      await this.logger.app("WARN", "ask_user_question 请求无有效问题，已跳过", { requestId: String(id) });
      await this.respond(id, { outcome: "skip_interview" } satisfies AskUserAnswerResult);
      this.reversePending.delete(id);
      return;
    }
    // 同一时刻只会有一个未决提问（Grok 阻塞在工具调用上）；万一出现旧条目，先取消再登记。
    const stale = this.pendingQuestionEntry;
    if (stale && this.reversePending.has(stale.entry.id)) {
      await this.respond(stale.entry.id, { outcome: "skip_interview" } satisfies AskUserAnswerResult);
      this.reversePending.delete(stale.entry.id);
      this.emit("event", { type: "question_resolved", requestId: stale.requestId, outcome: "cancelled" });
    }
    const requestId = String(id);
    this.pendingQuestionEntry = { requestId, entry: { id, request } };
    await this.logger.app("INFO", "收到模型提问", {
      requestId,
      questionCount: request.questions.length,
      ...(request.mode ? { mode: request.mode } : {}),
    });
    this.emit("event", { type: "question_requested", requestId, request });
  }

  private async handlePermission(id: JsonRpcId, params: PermissionRequestParams): Promise<void> {
    const requestId = String(id);
    const decision = this.safety.evaluate(this.modeValue, params);
    await this.logger.app("INFO", "收到权限请求", {
      requestId,
      operation: decision.operation,
      risk: decision.risk,
      action: decision.action,
      label: decision.label,
    });

    if (decision.action === "deny") {
      await this.answerPermission(id, params, "reject");
      this.emit("event", {
        type: "permission_resolved",
        requestId,
        resolution: "reject",
        automatic: true,
        reason: `${decision.label}：${decision.policyReason}`,
      });
      return;
    }

    const rule = decision.action === "ask" ? this.sessionRules.matches(decision.subject) : undefined;
    if (decision.action === "allow" || rule) {
      const guard = await this.runWriteGuard(requestId, decision, true);
      if (!guard.ok) {
        await this.answerPermission(id, params, "reject");
        this.emitGuardRejection(requestId, decision, guard.reason);
        return;
      }
      await this.answerPermission(id, params, "allow_once");
      this.emit("event", {
        type: "permission_resolved",
        requestId,
        resolution: rule ? (rule.scope === "always" ? "allow_always" : "allow_session") : "allow_once",
        automatic: true,
        reason: rule ? `${decision.label}：${rule.label}` : `${decision.label}：${decision.policyReason}`,
        ...(rule ? { rule } : {}),
      });
      return;
    }

    this.pendingPermissions.set(requestId, { id, params, decision });
    this.emit("event", {
      type: "permission_requested",
      requestId,
      request: params,
      decision,
      label: decision.label,
      reason: decision.reason,
    });
  }

  /**
   * 放行写入类操作前先交给宿主保存快照。只读操作与未配置钩子时直接通过；
   * 钩子抛错等同于失败，宁可拒绝也不让文件在没有快照的情况下被改动。
   */
  private async runWriteGuard(
    requestId: string,
    decision: SafetyDecision,
    automatic: boolean,
  ): Promise<WriteGuardResult> {
    if (!this.beforeWrite || decision.operation === "read") return { ok: true };
    try {
      return await this.beforeWrite({ requestId, decision, automatic });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logger.app("ERROR", "写入前钩子失败，已拒绝该操作", { requestId, message });
      return { ok: false, reason: message };
    }
  }

  private emitGuardRejection(requestId: string, decision: SafetyDecision, reason: string | undefined): void {
    this.emit("event", {
      type: "permission_resolved",
      requestId,
      resolution: "reject",
      automatic: true,
      reason: `${decision.label}：${reason ?? "修改前快照失败，已阻止该操作"}`,
    });
  }

  /** 只使用 allow_once / reject_once；即使 Grok 提供 allow_always 也不选。 */
  private async answerPermission(
    id: JsonRpcId,
    params: PermissionRequestParams,
    choice: "allow_once" | "reject",
  ): Promise<void> {
    if (!this.reversePending.has(id)) return;
    const desiredKind = choice === "reject" ? "reject_once" : "allow_once";
    const fallbackId = choice === "reject" ? "reject-once" : "allow-once";
    const option = params.options.find((candidate) => candidate.kind === desiredKind)
      ?? params.options.find((candidate) => candidate.optionId === fallbackId);
    if (!option) throw new Error(`Grok 未提供 ${desiredKind} 权限选项`);
    await this.respond(id, { outcome: { outcome: "selected", optionId: option.optionId } });
    this.reversePending.delete(id);
  }

  private failAll(error: Error, emitEvent = true): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      this.clearWatch(pending);
      pending.reject(error);
    }
    this.pending.clear();
    if (emitEvent) this.emit("event", { type: "error", message: error.message });
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("ACP 尚未初始化");
  }

  private requireSession(): string {
    if (!this.sessionIdValue) throw new Error("尚未创建 ACP 会话");
    return this.sessionIdValue;
  }
}
