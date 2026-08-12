import {
  TESTED_GROK_VERSION,
  type AgentEvent,
  type AgentRuntimeFactory,
  type AgentRuntimeHandle,
  type ApprovalPolicy,
  type DurablePermissionRules,
  type WriteGuardInput,
  type WriteGuardResult,
} from "@lingdong/agent-runtime";
import type { ContextUsageService } from "../context-usage";
import type { HostToWebviewMessage, UiAgentMode } from "../messages";
import { toRuntimeMode } from "../messages";
import type { ModelSelection } from "../model-selection";
import type { UiStateMachine } from "../ui-state";
import { buildVersionNotice } from "../version-notice";
import type { AgentWorkspaceStore } from "../workspace-store";
import type { LaunchFailure, ProviderService } from "./provider-service";
import type { RuntimeService } from "./runtime-service";
import type { SessionService } from "./session-service";
import { SurfacedError } from "./surfaced-error";

/**
 * 「拉起一次连接」的完整编排：定位可执行文件、建立变更快照根、初始化 ACP、
 * 探测压缩能力、绑定会话，最后把连接与会话状态推给面板。
 * 单独成类是因为它同时依赖 Runtime / Session / Change / Context 四个域，
 * 放在任何一个里都会造成互相引用。
 */
export interface RuntimeBootstrapDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  postState(detail?: string): void;
  readonly ui: UiStateMachine;
  readonly store: AgentWorkspaceStore;
  readonly runtimes: RuntimeService;
  readonly sessions: SessionService;
  createRuntime: AgentRuntimeFactory;
  readonly providers: ProviderService;
  /** 用户最后一次在界面上选的模型；会话记录缺失时靠它。 */
  lastSelection(): ModelSelection | undefined;
  /**
   * 第一个真正能用的模型（Provider 已启用、凭据已配、模型已验证）。
   *
   * 会话记录与「最后一次选择」都是按工作区存的，换个文件夹当工作区两者就都是空的。
   * 没有这一层，那种场景只能退回设置项的默认模型，而用户可能压根没配过它的凭据。
   *
   * 是异步的：得先确保 Provider 注册表已加载。UI 用的模型投影是构造时异步刷的，
   * 刷完之前它还停在内置 DeepSeek 上——直接读它就会把要修的 bug 原样搬进兜底。
   */
  defaultUsableModel(): Promise<LaunchModelChoice | undefined>;
  logDirectory(): string;
  /** agent 正在操作的目录，直接作为 Grok 子进程的 cwd。 */
  activeRoot(): string | undefined;
  mode(): UiAgentMode;
  usage(): ContextUsageService;
  setupChangeTracking(workspaceRoot: string): void;
  captureBeforeWrite(input: WriteGuardInput): Promise<WriteGuardResult>;
  ensureStorage(): Promise<void>;
  onEvent(event: AgentEvent): void;
  onReady(): void;
  /** Agent 模式的审批力度，取自设置项。 */
  approvalPolicy(): ApprovalPolicy;
  /** 「以后都允许」规则存储；工作区未就绪时返回 undefined。 */
  durableRules(): DurablePermissionRules | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一个模型来源。providerId 允许缺失：设置项只写模型 id，
 * v3 之前的会话记录也可能没有 Provider，这两种都交给 resolveLaunch 按 id 反查。
 */
export interface LaunchModelChoice {
  providerId?: string;
  modelId: string;
}

/** {@link chooseLaunchModel} 的输入；每一项都对应一处「模型是谁定的」。 */
export interface LaunchModelSources {
  /** 恢复中的会话记录。它记着这轮对话一直在用的模型，优先级最高。 */
  session: LaunchModelChoice | undefined;
  /** 用户最后一次在 Composer 里选的模型（按工作区存）。 */
  remembered: ModelSelection | undefined;
  /** 用户显式写进 settings.json 的模型 id；没写过是 undefined。 */
  settingExplicit: string | undefined;
  /** 第一个凭据齐全、真的能用的模型。 */
  usable: LaunchModelChoice | undefined;
  /** 设置项的默认值，最后的兜底。 */
  settingDefault: string;
}

/**
 * 决定这次启动用哪个模型。
 *
 * 排序的依据是「这个模型有多接近用户的真实意图」：会话记录 > 界面选择 >
 * 手写设置 > 唯一能用的模型 > 我们编的默认值。
 *
 * 关键是 usable 必须排在 settingDefault 前面。会话记录和界面选择都按工作区隔离，
 * 换个文件夹当工作区两者同时归零，直接掉到默认值就会拿内置 DeepSeek 去解析，
 * 报「原来使用 DeepSeek，但凭据已不存在」—— 用户从没选过它，谈不上「原来使用」。
 *
 * 这不违反「缺凭据不换一个能用的顶上」：那条规矩约束的是用户**选定**的模型解析失败时
 * 不许改投他家。这里压根没有用户选择，是在挑一个合理的默认值。
 */
export function chooseLaunchModel(sources: LaunchModelSources): LaunchModelChoice {
  if (sources.session?.modelId !== undefined) return sources.session;
  if (sources.remembered) return sources.remembered;
  // 设置项只有模型 id，没有 Provider；交给 resolveLaunch 按 id 反查。
  if (sources.settingExplicit !== undefined && sources.settingExplicit !== "") {
    return { modelId: sources.settingExplicit };
  }
  if (sources.usable) return sources.usable;
  return { modelId: sources.settingDefault };
}

export class RuntimeBootstrap {
  constructor(private readonly deps: RuntimeBootstrapDeps) {}

  async start(): Promise<AgentRuntimeHandle> {
    const root = this.deps.activeRoot();
    if (!root) throw new Error("请先选择一个本地文件夹作为仓库，灵动 Code 需要一个工作边界。");

    const launch = this.deps.runtimes.resolveLaunchConfig();
    this.deps.ui.transition("initializing");
    this.deps.postState();
    this.deps.post({ type: "connection", state: "starting" });

    this.deps.setupChangeTracking(root);
    await this.deps.ensureStorage();

    // 解析出「一个 Provider + 一个模型 + 一个凭据」。失败就明确失败，不换模型顶上。
    // Provider 与模型必须成对取自同一处，否则换过 Provider 之后会拿
    // 「新 Provider + 旧模型」去解析，必然失败。优先级见 chooseLaunchModel。
    const chosen = chooseLaunchModel({
      session: this.deps.sessions.current,
      remembered: this.deps.lastSelection(),
      settingExplicit: launch.modelExplicit ? launch.modelId : undefined,
      usable: await this.deps.defaultUsableModel(),
      settingDefault: launch.modelId,
    });
    const resolution = await this.deps.providers.resolveLaunch(chosen.providerId, chosen.modelId);
    if (!resolution.ok) {
      const detail = this.deps.providers.describeFailure(resolution.failure);
      this.promptReconfigure(detail, resolution.failure);
      throw new SurfacedError(detail);
    }
    const target = resolution.target;

    const home = await this.deps.providers.prepareHome({
      detectedHome: launch.grokHome,
      defaultModelId: target.model.id,
    });

    // 子进程环境由扩展整份构造：剥掉全部已知模型凭据，
    // 注入所有已启用且配置了密钥的 Provider（免重连切模的前提）。
    const envBuild = await this.deps.providers.buildEnv(target, home.grokHome);
    const durableRules = this.deps.durableRules();
    const runtime = this.deps.createRuntime({
      executable: launch.executable,
      workspace: root,
      logDirectory: this.deps.logDirectory(),
      modelId: target.model.id,
      ...(home.grokHome ? { grokHome: home.grokHome } : {}),
      env: envBuild.env,
      redactValues: envBuild.credentialValues,
      clientInfo: { name: "lingdong-agent", title: "灵动 Code", version: "0.1.0" },
      beforeWrite: (input) => this.deps.captureBeforeWrite(input),
      approvalPolicy: this.deps.approvalPolicy(),
      ...(durableRules ? { durableRules } : {}),
    });
    // 轮次之外的事件（模式切换、子进程异常）也要送到面板。
    runtime.on("event", (event) => this.deps.onEvent(event));

    const info = await runtime.initialize();
    // 换仓会 bump 代数：过期启动必须在 bindSession 之前停掉，
    // 否则会在新仓库的 persistence 里 ensureCurrent 造出幽灵会话。
    if (!this.deps.runtimes.markStarted(runtime)) {
      throw new Error("启动已取消（换仓）");
    }
    // 快照 = 本次子进程「注入了谁的密钥 + config 里有哪些模型」；
    // 之后切模型命中快照就走 session/set_model 免重连。
    const snapshot = this.deps.providers.recordLaunchSnapshot(envBuild.injectedProviderIds);
    this.deps.log(
      `[startup] 免重连快照：${snapshot.providerIds.length} 个 Provider、${snapshot.modelIds.length} 个模型`,
    );
    this.deps.providers.recordProfile({
      target,
      grokHome: home.grokHome ?? "",
      configFile: home.configFile ?? "",
      managed: home.managed,
    });
    this.deps.log(
      `[startup] ACP v${info.protocolVersion} · ${info.grok.version ?? "未知版本"}`
      + ` · ${target.provider.displayName} · ${info.modelId} · ${info.workspace}`,
    );

    const notice = buildVersionNotice(info.grok, TESTED_GROK_VERSION);
    // 只走对话内 notice，不再叠加 VS Code Warning toast（Cursor 式少打断）。
    this.deps.post({
      type: "notice",
      level: notice.level,
      message: notice.message,
      ...(notice.level === "warn"
        ? {
            actions: [
              { id: "openGrokSettings" as const, label: "打开 Grok 设置" },
              { id: "dismiss" as const, label: "继续" },
            ],
          }
        : {}),
    });

    await this.probeCompact(runtime);
    if (this.deps.runtimes.current !== runtime) {
      await runtime.dispose().catch(() => undefined);
      throw new Error("启动已取消（换仓）");
    }
    const sessionId = await this.bindSession(runtime);

    this.deps.ui.transition("ready");
    this.deps.store.patchRuntime({
      connection: "ready",
      connectionDetail: `ACP v${info.protocolVersion}`,
      model: info.modelId,
      compactCapability: this.deps.usage().compactionCapability,
    });
    this.deps.post({ type: "connection", state: "ready", detail: `ACP v${info.protocolVersion}` });
    this.deps.post({
      type: "session",
      sessionId,
      model: info.modelId,
      mode: this.deps.mode(),
      ...(this.deps.sessions.current ? { title: this.deps.sessions.current.title } : {}),
    });
    this.deps.onReady();
    return runtime;
  }

  /**
   * 凭据或 Provider 缺失时给出可操作的两个出口。
   * 刻意不提供「换一个模型继续」——那等于替用户改了数据流向。
   *
   * 一个凭据都没配过不是故障，是还没开始：装完打开文件夹、面板预热连接时就会
   * 撞上这一条，用户此时什么都还没做。红色错误会让人以为装坏了，所以降成普通
   * 提示；出口改在对话内联按钮，不再弹 VS Code toast。
   *
   * 这里发过卡之后 start() 抛的是 SurfacedError，上层据此跳过补发错误卡。
   */
  private promptReconfigure(detail: string, failure: LaunchFailure): void {
    const firstRun = failure.reason === "key-missing" && failure.neverConfigured;
    const actions = [
      { id: "configureProviderKey" as const, label: "配置密钥…" },
      { id: "openExtensionSettings" as const, label: "打开设置" },
    ];
    if (firstRun) {
      this.deps.post({ type: "notice", level: "info", message: detail, actions });
    } else {
      this.deps.post({ type: "error", message: detail, recoverable: true, actions });
    }
  }

  /** 压缩能力探测失败不阻塞连接，只是把手动压缩标记为不可用。 */
  private async probeCompact(runtime: AgentRuntimeHandle): Promise<void> {
    const usage = this.deps.usage();
    usage.setContextLimit(1_000_000);
    try {
      const capability = await runtime.probeCompact();
      usage.setCompactionCapability(capability);
      this.deps.log(`[compact] 手动压缩能力：${capability}`);
    } catch (error) {
      usage.setCompactionCapability("unavailable");
      this.deps.log(`[compact] 探测失败，记为 unavailable：${errorText(error)}`);
    }
  }

  private async bindSession(runtime: AgentRuntimeHandle): Promise<string> {
    const current = this.deps.sessions.current;
    if (current?.grokSessionId) return this.deps.sessions.bindGrokSession(runtime, current);
    const created = await runtime.createSession({ mode: toRuntimeMode(this.deps.mode()) });
    await this.deps.sessions.ensureCurrent(runtime, created);
    return created;
  }
}
