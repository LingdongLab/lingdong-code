import * as path from "node:path";
import * as vscode from "vscode";
import {
  createAgentRuntime,
  type AgentRuntimeFactory,
  type ApprovalPolicy,
} from "@lingdong/agent-runtime";
import type { CandidateSource } from "./composer/context-candidate";
import { normalizeRelativePath } from "./context-model";
import { collectWorkspaceDiagnostics } from "./diagnostics-context";
import { createNodeFileSystem } from "./file-system-port";
import type {
  HostToWebviewMessage,
  PlanEditPayload,
  SetupActionId,
  UiAgentMode,
  UiPermissionDecision,
  UsageView,
} from "./messages";
import { toRuntimeMode } from "./messages";
import { ModelRegistry, toModelDescriptors } from "./model-registry";
import { PRIVACY_ENV, CREDENTIAL_DENY_LIST } from "./privacy/runtime-env";
import { CatalogCache } from "./models/providers/catalog-cache";
import { workspaceStateSelection, type SelectionStatePort } from "./model-selection";
import { WorkspaceSwitcher } from "./services/workspace-switcher";
import {
  globalStateDismissedWorkspaces,
  globalStateWorkspaceHistory,
  samePath,
} from "./workspace-history";
import { renderAgentDiagnostics } from "./diagnostics/agent-diagnostics";
import { runGrokInspect } from "./diagnostics/run-grok-inspect";
import { renderPrivacyStatus, type PrivacyStatusInput } from "./privacy/privacy-status";
import { redact } from "./privacy/secret-redactor";
import {
  globalStateActiveRepo,
  resolveActiveRepo,
  type ActiveRepoPort,
} from "./services/active-repo";
import { ChangeFacade } from "./services/change-facade";
import { ContextFacade } from "./services/context-facade";
import { FIRST_RUN_CONTEXT_KEY, firstRunGate, type FirstRunGate } from "./services/first-run-gate";
import { hostRoots } from "./services/host-workspace";
import { ImageStore } from "./services/image-store";
import {
  ContextSuggestionService,
  type ActiveFileInfo,
  type ResolvedCandidate,
} from "./services/context-suggestion-service";
import { McpSecretStore } from "./mcp/mcp-secret-store";
import { McpServerRegistry } from "./mcp/mcp-server-registry";
import { ExtensionsService } from "./services/extensions-service";
import { ModeService } from "./services/mode-service";
import { ModelFacade } from "./services/model-facade";
import { ModelSettingsService } from "./services/model-settings-service";
import { SettingsService } from "./services/settings-service";
import { PermissionFacade } from "./services/permission-facade";
import { QuestionFacade } from "./services/question-facade";
import { PlanFacade } from "./services/plan-facade";
import {
  ProviderService,
  editPreviewMode,
  globalStateSecretIndex,
  managedHomeEnabled,
  memoryEnabled,
  planStepGatingEnabled,
  showReasoningEnabled,
} from "./services/provider-service";
import { LspService } from "./services/lsp-service";
import { RulesService } from "./services/rules-service";
import { RuntimeBootstrap } from "./services/runtime-bootstrap";
import { RuntimeService } from "./services/runtime-service";
import { SessionService } from "./services/session-service";
import { SkillsService } from "./services/skills-service";
import { EditPreviewService } from "./services/edit-preview-service";
import { TimelineService } from "./services/timeline-service";
import { TurnService } from "./services/turn-service";
import { createTurnState } from "./services/turn-state";
import { WorkspaceTools } from "./services/workspace-tools";
import type { PlanRecord } from "./storage/plan-repository";
import type { SessionRecord } from "./storage/session-repository";
import { UiStateMachine } from "./ui-state";
import { AgentWorkspaceStore } from "./workspace-store";

export type Poster = (message: HostToWebviewMessage) => void;

/** 可替换依赖；生产使用默认值，集成测试注入假 Runtime 以免拉起真实 Grok 子进程。 */
export interface AgentControllerDeps {
  createRuntime?: AgentRuntimeFactory;
  /** 模型选择的存放处；测试注入内存实现，避免依赖 workspaceState。 */
  selection?: SelectionStatePort;
  /** 活动仓库的存放处；测试注入内存实现即可让取根不等于宿主工作区。 */
  activeRepo?: ActiveRepoPort;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;
const MIN_PERMISSION_TIMEOUT_MS = 10_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @问题面板 候选上的真实条数；没有工作区时视为 0。 */
function countWorkspaceDiagnostics(workspaceRoot: string | undefined): number {
  if (!workspaceRoot) return 0;
  return collectWorkspaceDiagnostics(workspaceRoot).length;
}

/**
 * 活动组副标题。只在计划已批准或执行中、且当前步骤能明确定位时才给，
 * 主标题始终固定，不接受模型自由生成的标题。
 */
function currentPlanStepTitle(plan: PlanRecord | undefined): string | undefined {
  if (!plan) return undefined;
  if (plan.status !== "approved" && plan.status !== "executing") return undefined;
  const step = plan.steps.find((item) => item.id === plan.currentStepId);
  const title = step?.title.trim();
  return title ? `当前步骤：${title}` : undefined;
}

function permissionTimeoutMs(): number {
  const configured = vscode.workspace
    .getConfiguration("lingdongAgent")
    .get<number>("permissionTimeoutMs", DEFAULT_PERMISSION_TIMEOUT_MS);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_PERMISSION_TIMEOUT_MS;
  }
  return Math.max(MIN_PERMISSION_TIMEOUT_MS, Math.floor(configured));
}

const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["balanced", "strict", "yolo"];

/**
 * 认不出来的值一律按默认 balanced 处理，不静默升级成更宽松的力度。
 * 这条也顺带兜住了改名前写下的旧值：回落到的正是同一档力度，行为不变。
 */
function approvalPolicy(): ApprovalPolicy {
  const configured = vscode.workspace.getConfiguration("lingdongAgent").get<string>("approvalPolicy", "balanced");
  return APPROVAL_POLICIES.includes(configured as ApprovalPolicy) ? (configured as ApprovalPolicy) : "balanced";
}

/**
 * Extension Host 侧的 Agent 会话主控。
 * 这里只做三件事：组装各领域服务、维护工作模式、把 Webview 动作路由过去。
 * 连接、会话、计划、变更、上下文、权限与轮次执行分别由 src/services 下的服务承担。
 */
export class AgentController {
  private readonly ui = new UiStateMachine();
  private readonly fs = createNodeFileSystem();
  private readonly turnState = createTurnState();
  private readonly posters = new Set<Poster>();
  private readonly createRuntime: AgentRuntimeFactory;

  readonly store = new AgentWorkspaceStore();
  readonly models = new ModelRegistry();
  /**
   * 粘贴进来的图片字节。上下文服务往里放，转发层出站前取——
   * 两边必须是同一个实例，所以在这里创建再分别注入。
   */
  private readonly images = new ImageStore();

  private readonly tools: WorkspaceTools;
  private readonly runtimes: RuntimeService;
  private readonly sessions: SessionService;
  private readonly changes: ChangeFacade;
  private readonly context: ContextFacade;
  private readonly plans: PlanFacade;
  private readonly permissions: PermissionFacade;
  private readonly questions: QuestionFacade;
  private readonly modelFacade: ModelFacade;
  private readonly providers: ProviderService;
  private readonly suggestions: ContextSuggestionService;
  private readonly timeline: TimelineService;
  /** 编辑器里的实时 diff 预览。 */
  private readonly preview: EditPreviewService;
  private readonly turns: TurnService;
  private readonly bootstrap: RuntimeBootstrap;
  /** 用户最后一次选中的模型；没有会话记录时启动就靠它。 */
  private readonly selection: SelectionStatePort;
  /** 左栏的工作区区块：当前工作区、最近用过的、换一个文件夹。 */
  private readonly workspaces: WorkspaceSwitcher;
  /** agent 正在操作的目录，与宿主工作区解耦；取根一律走 activeRoot()。 */
  private readonly activeRepo: ActiveRepoPort;
  private readonly modes: ModeService;
  /** 模型中心的编排层；面板打开时挂上 poster，关闭后继续可被命令复用。 */
  readonly modelSettings: ModelSettingsService;
  /** Skills / MCP 扩展能力面板编排。 */
  readonly extensions: ExtensionsService;
  /** 设置页里既不属于模型段也不属于能力段的那部分：配置取值、权限规则、隐私画像。 */
  readonly settings: SettingsService;
  private readonly skills: SkillsService;
  private readonly mcp: McpServerRegistry;
  /** 项目规则（AGENTS.md / rules 目录）的读写。 */
  private readonly rules: RulesService;
  /** language server 预置的探测与 lsp.json 落盘。 */
  private readonly lsp: LspService;
  private skillsConfigured = false;
  private mcpConfigured = false;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    deps: AgentControllerDeps = {},
  ) {
    this.createRuntime = deps.createRuntime ?? createAgentRuntime;
    const post = (message: HostToWebviewMessage) => this.post(message);
    // Output Channel 是最容易漏凭据的一处：错误里常带完整请求。统一过一遍脱敏。
    const log = (line: string) => this.output.appendLine(redact(line));
    const postState = (detail?: string) => this.postState(detail);
    const postModeState = (serverMode?: string) => this.modes.publish(serverMode);

    this.activeRepo = deps.activeRepo ?? globalStateActiveRepo(this.extensionContext.globalState);
    this.tools = new WorkspaceTools({
      post,
      log,
      fs: this.fs,
      activeRoot: () => this.activeRoot(),
    });
    this.selection = deps.selection ?? workspaceStateSelection(this.extensionContext.workspaceState);
    this.workspaces = new WorkspaceSwitcher({
      post,
      log,
      activeRoot: () => this.activeRoot(),
      // 走公开入口（换仓泵）：add/remove 触发的切换与左栏点击共用合并逻辑。
      activateRepo: (target) => this.activateRepo(target),
      clearRepo: () => this.clearRepo(),
      history: globalStateWorkspaceHistory(this.extensionContext.globalState),
      dismissed: globalStateDismissedWorkspaces(this.extensionContext.globalState),
      directoryExists: (absolutePath) => this.fs.exists(absolutePath),
      now: () => Date.now(),
    });
    // 当前工作区先记进历史，用户下次能从列表切回来。
    void this.workspaces.recordCurrent();

    const storageRoot = () => this.extensionContext.globalStorageUri.fsPath;
    this.skills = new SkillsService({
      fs: this.fs,
      storageRoot: storageRoot(),
      workspaceRoot: () => this.activeRoot(),
      // 与 ManagedGrokHome.directory 一致：托管 GROK_HOME 下的 skills/。
      grokHome: () => path.join(storageRoot(), "grok-home"),
    });
    this.rules = new RulesService({
      fs: this.fs,
      workspaceRoot: () => this.activeRoot(),
      grokHome: () => path.join(storageRoot(), "grok-home"),
    });
    this.lsp = new LspService({
      fs: this.fs,
      storageRoot: storageRoot(),
      workspaceRoot: () => this.activeRoot(),
    });
    const mcpSecrets = new McpSecretStore(this.extensionContext.secrets);
    this.mcp = new McpServerRegistry({
      fs: this.fs,
      storageRoot: storageRoot(),
      secrets: mcpSecrets,
    });

    this.providers = new ProviderService({
      post,
      log,
      fs: this.fs,
      storageRoot,
      secrets: this.extensionContext.secrets,
      index: globalStateSecretIndex(this.extensionContext.globalState),
      images: () => this.images,
      // 宿主侧联网搜索 MCP（对标 Cursor）：Grok 按 config 拉起该脚本。
      webSearchMcpScript: () =>
        this.extensionContext.asAbsolutePath("dist/web-search-mcp.js"),
      // 校验闭环钩子：Grok 在 Stop 事件上拉起它，跑项目自己的 typecheck / lint。
      verifyGateScript: () =>
        this.extensionContext.asAbsolutePath("dist/verify-gate.js"),
      skillsToml: async () => {
        const disabled = await this.skills.disabledNames();
        const paths = await this.skills.skillConfigPaths();
        return {
          disabled,
          ...(paths.length > 0 ? { paths } : {}),
        };
      },
      userMcpServers: async () => {
        const resolved = await this.mcp.resolveEnabled();
        return resolved.map((item) => ({
          name: item.name,
          transport: item.transport,
          ...(item.command ? { command: item.command } : {}),
          ...(item.args ? { args: item.args } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(Object.keys(item.env).length > 0 ? { env: item.env } : {}),
          ...(Object.keys(item.headers).length > 0 ? { headers: item.headers } : {}),
        }));
      },
      mcpCredentials: async () => {
        const resolved = await this.mcp.resolveEnabled();
        return resolved.flatMap((item) => item.credentials);
      },
      // 用户级 lsp.json：只写本机真的装了、且用户没关掉的那几个 language server。
      lspConfig: () => this.lsp.renderConfig(),
      extraSecretLiterals: async () => this.mcp.secretLiterals(),
    });

    this.modes = new ModeService({
      post,
      log,
      ui: this.ui,
      store: this.store,
      turn: this.turnState,
      runtime: () => this.runtimes.current,
      pushComposerStatus: () => this.context.pushComposerStatus(),
      agentCompatible: () => this.currentModelDescriptor()?.agentCompatible !== false,
      currentModelName: () =>
        this.currentModelDescriptor()?.displayName ?? this.modelFacade.currentModelId(),
    });

    this.runtimes = new RuntimeService({
      post,
      log,
      postState,
      ui: this.ui,
      store: this.store,
      start: () => this.bootstrap.start(),
      onDisconnected: () => {
        this.permissions.clearCards("Grok 连接已断开");
        this.turnState.pendingPlan = false;
      },
    });

    this.changes = new ChangeFacade({
      post,
      log,
      postState,
      ui: this.ui,
      store: this.store,
      fs: this.fs,
      persistence: () => this.sessions.persistence,
      flushPersistence: () => void this.sessions.flush(),
      snapshotRoot: () => path.join(this.extensionContext.globalStorageUri.fsPath, "agent-snapshots"),
      // 时间线在这行之后才构造，靠闭包延迟到真正调用时再取。
      lineDiff: (turnId, relativePath) => this.timeline.linesFor(turnId, relativePath),
      // Grok 逐 hunk 通道：runtime 未起或不支持时这里拿不到 hunks，面板自动退回整段 diff。
      hunkApi: {
        getHunks: async (absolutePath) => {
          const hunks = this.runtimes.current?.hunks;
          return hunks ? hunks.getHunks(absolutePath) : undefined;
        },
        hunkAction: async (hunkId, action) => {
          const hunks = this.runtimes.current?.hunks;
          if (!hunks) return { success: false, error: "Agent 未连接" };
          return hunks.hunkAction(hunkId, action);
        },
      },
    });

    this.context = new ContextFacade({
      post,
      log,
      store: this.store,
      runtime: () => this.runtimes.current,
      mode: () => this.modes.current,
      modelId: () => this.modelFacade.currentModelId(),
      modelContextWindow: () => this.currentModelDescriptor()?.contextWindow,
      // 取活动仓库而不是 sessions.workspaceRoot：后者要等存储 bootstrap 完才有值，
      // 在那之前 @文件 会误报「请先选择仓库」。
      workspaceRoot: () => this.activeRoot(),
      fs: this.fs,
      supportsVision: () => this.currentModelDescriptor()?.supportsVision ?? false,
      images: this.images,
      appendTranscriptNotice: (message) => this.sessions.appendNotice(message),
    });

    this.sessions = new SessionService({
      post,
      log,
      store: this.store,
      fs: this.fs,
      globalStorageRoot: () => this.extensionContext.globalStorageUri.fsPath,
      activeRoot: () => this.activeRoot(),
      tracker: () => this.changes.tracker,
      snapshots: () => this.changes.snapshots,
      usage: () => this.context.usage,
      setupTracker: (root) => this.changes.setup(root),
      applyRestoredMode: (mode) => this.modes.force(mode),
      refreshUi: () => this.republishRuntimeState(),
      mode: () => this.modes.current,
      providerId: (modelId) => this.providers.registry.findModel(modelId)?.provider.id,
      stopIfBusy: async () => { if (this.ui.busy) await this.stop(); },
      clearPermissionCards: (reason) => this.permissions.clearCards(reason),
      clearSendQueue: () => this.turns.clearQueue(),
      ensureRuntime: () => this.runtimes.ensureStarted(),
      resetForNewSession: () => this.resetForNewSession(),
      afterNewSession: () => this.afterNewSession(),
      // turns 在后面才构造；箭头延迟取值，loadSession 时一定已就绪。
      beginSessionReplay: () => this.turns.beginSessionReplay(),
      endSessionReplay: () => this.turns.endSessionReplay(),
    });

    this.plans = new PlanFacade({
      post,
      postState,
      postModeState,
      ui: this.ui,
      store: this.store,
      turn: this.turnState,
      fs: this.fs,
      workspaceRoot: () => this.sessions.workspaceRoot,
      grokHome: () =>
        this.providers.lastProfile?.grokHome?.trim()
        || this.providers.managedHome.directory,
      grokSessionId: () =>
        this.sessions.current?.grokSessionId
        ?? this.runtimes.current?.sessionId,
      ensureStorage: () => this.ensureStorage(),
      persistence: () => this.sessions.persistence,
      flushPersistence: () => this.sessions.flush(),
      activeSessionId: () => this.sessions.activeSessionId,
      setActiveSession: (record) => { this.sessions.current = record as SessionRecord; },
      runtime: () => this.runtimes.current,
      setMode: (mode) => this.setMode(mode),
      forceMode: (mode) => this.modes.force(mode),
      sendPrompt: (text, options) => this.sendPrompt(text, options),
      stop: () => this.stop(),
      turnPending: () => this.turns.pending !== undefined,
      stepGating: () => planStepGatingEnabled(),
    });

    this.permissions = new PermissionFacade({
      post,
      log,
      postState,
      ui: this.ui,
      runtime: () => this.runtimes.current,
      workspaceRoot: () => this.sessions.workspaceRoot,
      timeoutMs: () => permissionTimeoutMs(),
      canRememberRules: () => this.sessions.persistence !== undefined,
    });

    this.questions = new QuestionFacade({
      post,
      log,
      postState,
      ui: this.ui,
      runtime: () => this.runtimes.current,
    });

    this.modelFacade = new ModelFacade({
      post,
      store: this.store,
      models: this.models,
      providers: this.providers,
      restartRuntime: () => this.reconnect(),
      runtime: () => this.runtimes.current,
      persistence: () => this.sessions.persistence,
      currentSession: () => this.sessions.current,
      setCurrentSession: (record) => { this.sessions.current = record; },
      lastSelection: () => this.selection.get(),
      rememberSelection: async (value) => { await this.selection.set(value); },
      mode: () => this.modes.current,
      pushComposerStatus: () => this.context.pushComposerStatus(),
      setMode: (mode) => this.setMode(mode),
      busy: () => this.ui.busy,
      enforceAskOnly: (input) => this.modes.enforceAskOnly(input),
      skillsConfigured: () => this.skillsConfigured,
      mcpConfigured: () => this.mcpConfigured,
      openExtensions: () => {
        void vscode.commands.executeCommand("lingdongAgent.openExtensions");
      },
      contextActions: {
        addCurrentFile: () => this.context.addCurrentFile(),
        addSelection: () => this.context.addSelection(),
        pickFiles: () => this.context.pickFiles(),
        pickFolder: () => this.context.pickFolder(),
        addTerminalOutput: () => this.context.addTerminalOutput(),
        addDiagnostics: async () => { this.context.addDiagnostics(); },
      },
    });

    this.modelSettings = new ModelSettingsService({
      providers: this.providers,
      catalog: new CatalogCache({
        fs: this.fs,
        storageRoot: this.extensionContext.globalStorageUri.fsPath,
        log,
      }),
      log,
      activeModelId: () => this.modelFacade.currentModelId(),
      sessionsUsingModel: async (modelId) => {
        await this.ensureStorage();
        return await this.sessions.persistence?.sessions.findByModelId(modelId) ?? [];
      },
      onProvidersChanged: () => this.onProvidersChanged(),
      onCredentialChanged: (providerId) => this.onCredentialChanged(providerId),
    });

    this.extensions = new ExtensionsService({
      skills: this.skills,
      mcp: this.mcp,
      rules: this.rules,
      lsp: this.lsp,
      log,
      workspaceAvailable: () => Boolean(this.activeRoot()),
      runtimeConnected: () => Boolean(this.runtimes.current?.sessionId),
      onChanged: () => this.onExtensionsChanged(),
      memoryEnabled: () => memoryEnabled(),
      setMemoryEnabled: async (enabled) => {
        await vscode.workspace
          .getConfiguration("lingdongAgent")
          .update("memory", enabled, vscode.ConfigurationTarget.Global);
      },
      memoryDirectory: () => path.join(storageRoot(), "grok-home", "memory"),
      openFile: (absolutePath) => this.openAbsoluteFile(absolutePath),
    });

    this.settings = new SettingsService({
      ensureStorage: () => this.ensureStorage(),
      permissionRules: () => this.sessions.persistence?.permissionRules,
      clearRuntimeSessionRules: () => this.runtimes.current?.clearSessionRules(),
      privacyInput: () => this.privacyStatusInput(),
      memoryDirectory: () => path.join(storageRoot(), "grok-home", "memory"),
      log,
    });

    this.suggestions = new ContextSuggestionService({
      post,
      workspaceRoot: () => this.sessions.workspaceRoot,
      listFiles: () => this.tools.collectFiles(),
      activeFile: () => this.activeFileInfo(),
      diagnosticsCount: () => countWorkspaceDiagnostics(this.sessions.workspaceRoot),
      terminalLines: () => this.context.recentTerminalOutput()?.lines ?? 0,
      addedKeys: () => this.context.addedKeys(),
      changedFiles: () => this.changes.sessionChangedFiles(),
      add: (target) => this.applyContextCandidate(target),
    });
    // 用户打开文件即计入「最近使用」，这是 @ 候选唯一的浏览历史来源。
    this.extensionContext.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.suggestions.noteOpened(this.activeFileInfo()?.relativePath);
      }),
    );

    this.timeline = new TimelineService({
      post,
      workspaceRoot: () => this.sessions.workspaceRoot,
      changeCounts: (turnId) => this.changes.countChanges(turnId),
      planStepTitle: () => currentPlanStepTitle(this.plans.active),
      persist: (presentation) => this.sessions.appendTimeline(presentation),
    });

    this.preview = new EditPreviewService({
      log,
      mode: () => editPreviewMode(),
      workspaceRoot: () => this.sessions.workspaceRoot,
    });
    this.extensionContext.subscriptions.push(this.preview.register());

    this.turns = new TurnService({
      post,
      log,
      postState,
      postModeState,
      ui: this.ui,
      turn: this.turnState,
      changes: this.changes,
      timeline: this.timeline,
      preview: this.preview,
      showReasoning: () => showReasoningEnabled(),
      context: this.context,
      permissions: this.permissions,
      plans: this.plans,
      questions: this.questions,
      sessions: this.sessions,
      runtime: () => this.runtimes.current,
      ensureStarted: () => this.runtimes.ensureStarted(),
      ensureStorage: () => this.ensureStorage(),
      mode: () => this.modes.current,
      planOverview: () => this.tools.planOverview(),
      onModeChanged: (mode, source) => this.modes.handleRuntimeModeChanged(mode, source),
      applyPendingMode: () => this.modes.applyPending(),
      onDisconnected: (reason) => this.runtimes.handleDisconnected(reason),
    });

    this.bootstrap = new RuntimeBootstrap({
      post,
      log,
      postState,
      ui: this.ui,
      store: this.store,
      runtimes: this.runtimes,
      sessions: this.sessions,
      createRuntime: this.createRuntime,
      providers: this.providers,
      lastSelection: () => this.selection.get(),
      // 直接投影注册表，而不是读 this.models：后者是构造时异步刷新的，
      // 刷完之前停在内置 DeepSeek 上，正好是这里要避开的那个模型。
      // load() 本身带记忆，启动路径上等它一次不花钱。
      defaultUsableModel: async () => {
        await this.providers.load();
        const [first] = toModelDescriptors(this.providers.registry.list(), {
          hasKey: (providerId) => this.providers.secretStore.hasKey(providerId),
        });
        return first ? { providerId: first.providerId, modelId: first.id } : undefined;
      },
      logDirectory: () => this.logDirectory,
      activeRoot: () => this.activeRoot(),
      mode: () => this.modes.current,
      usage: () => this.context.usage,
      setupChangeTracking: (root) => this.changes.setup(root),
      captureBeforeWrite: (input) => this.changes.captureBeforeWrite(input),
      ensureStorage: () => this.ensureStorage(),
      approvalPolicy: () => approvalPolicy(),
      durableRules: () => this.sessions.persistence?.permissionRules,
      onEvent: (event) => this.turns.handleEvent(event),
      onReady: () => {
        this.republishRuntimeState();
        // 预热/重连期间入队的消息，连接就绪即续发。
        this.turns.drainQueue();
      },
    });

    this.changes.onTurnPersisted = (turnId) => this.sessions.syncCounters({ lastTurnId: turnId });
    this.store.setModels(this.models.list());
    // 模型清单的权威来源是 Provider 注册表；这里做一次异步对齐，失败也不影响启动。
    void this.syncModelsFromProviders();
  }

  /** 把 Provider 注册表投影成 UI 模型清单，并顺手做一次 DeepSeek 凭据迁移引导。 */
  private async syncModelsFromProviders(): Promise<void> {
    try {
      await this.providers.load();
      // 目录里的能力声明会变，而模型的能力位是添加那一刻写死的；用缓存对一次，不发请求。
      await this.modelSettings.calibrateVisionFromCatalog();
      this.refreshModelProjection();
      this.store.setModels(this.models.list());
      await this.refreshExtensionCapabilities();
      this.modelFacade.publish();
      await this.providers.importLegacyDeepSeekKey();
    } catch (error) {
      this.output.appendLine(`[providers] 初始化失败：${errorText(error)}`);
    }
  }

  /**
   * 重投影模型清单。凭据是否配置走 SecretStore 的非敏感索引，
   * 不会为了回答这个问题把明文读进内存。
   */
  refreshModelProjection(): void {
    this.models.replace(
      toModelDescriptors(this.providers.registry.list(), {
        hasKey: (providerId) => this.providers.secretStore.hasKey(providerId),
      }),
    );
    // 凭据变动会改变首次引导该显示哪一段；这三处调用点正好覆盖凭据能变的全部时机。
    this.publishFirstRunGate();
  }

  /**
   * 把「首次运行卡在哪一步」写进 context key，侧栏的 viewsWelcome 据此分支。
   * 装机后第一次打开时它是唯一会说话的界面，所以启动、凭据变动、工作区变动都要刷。
   */
  publishFirstRunGate(): void {
    void vscode.commands.executeCommand("setContext", FIRST_RUN_CONTEXT_KEY, this.firstRunGate());
  }

  /**
   * 首启时缺凭据就主动提示一次。
   *
   * 这一档不能只靠会话树的 viewsWelcome：只要打开了工作区，树里就有「固定 / 最近 / 已归档」
   * 几个分组，不算空，welcome 根本不会渲染。而缺 Key 现在要等用户发出第一条消息才报错，
   * 中间这段时间他不知道自己少了什么。没有工作区那一档反过来——树确实是空的，welcome
   * 顶得住，就不用在这里再弹一次。
   */
  async promptFirstRunSetup(): Promise<void> {
    if (this.firstRunGate() !== "noApiKey") return;
    // 对话内联引导，避免与首轮发送叠 VS Code toast。
    this.post({
      type: "notice",
      level: "info",
      message: "灵动 Code 还没有可用的模型凭据。填一个 API Key 就能开始对话。",
      actions: [
        { id: "openModelSettings", label: "打开模型设置" },
        { id: "dismiss", label: "稍后" },
      ],
    });
  }

  /** 对话内联引导按钮：配置密钥 / 选 Grok / 打开设置等。 */
  async handleSetupAction(action: SetupActionId): Promise<void> {
    switch (action) {
      case "configureProviderKey":
        await this.configureProviderKey();
        return;
      case "openModelSettings":
        await vscode.commands.executeCommand("lingdongAgent.openModelSettings");
        return;
      case "openExtensionSettings":
        await vscode.commands.executeCommand("lingdongAgent.openSettings");
        return;
      case "locateGrok":
        await this.runtimes.locateExecutable();
        return;
      case "openGrokSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "lingdongAgent.grokExecutable",
        );
        return;
      case "importLegacyKey":
        await this.providers.importLegacyDeepSeekKey(process.env, { force: true });
        this.refreshModelProjection();
        this.modelFacade.publish();
        return;
      case "dismiss":
        return;
      default:
        return;
    }
  }

  private firstRunGate(): FirstRunGate {
    return firstRunGate({
      // 判据是「有没有仓库可操作」，不是「宿主开了几个文件夹」：活动仓库
      // 记在我们自己这边，空窗口里照样可能有一个。
      hasWorkspace: this.activeRoot() !== undefined,
      hasApiKey: this.providers.secretStore.configuredProviders().length > 0,
    });
  }

  /**
   * 当前该操作哪个目录。
   *
   * 全代码取根都必须走这里，不能再直接读 `workspaceFolders[0]`——那等于把
   * 「宿主开了哪些文件夹」和「agent 在哪干活」钉死成一件事，换仓库就只能去动
   * 宿主工作区，而 VS Code 在单文件夹→多文件夹这一步必然重载窗口。
   */
  activeRoot(): string | undefined {
    return resolveActiveRepo({ stored: this.activeRepo.stored(), hostRoots: hostRoots() });
  }

  private currentModelDescriptor() {
    return this.models.get(this.modelFacade.currentModelId());
  }

  // ---------------------------------------------------------------------------
  // 基础状态与消息总线
  // ---------------------------------------------------------------------------

  get busy(): boolean { return this.ui.busy; }
  get mode(): UiAgentMode { return this.modes.current; }
  get state(): string { return this.ui.state; }
  get activeSessionId(): string | undefined { return this.sessions.activeSessionId; }
  get logDirectory(): string {
    return path.join(this.extensionContext.logUri.fsPath, "lingdong-agent");
  }

  /** 多视图共用同一 poster 总线；TreeView / 主面板 / 右侧面板均可订阅。 */
  addPoster(post: Poster): void { this.posters.add(post); }
  removePoster(post: Poster): void { this.posters.delete(post); }

  /** @deprecated 兼容旧侧栏入口，等同 addPoster。 */
  setPoster(post: Poster): void {
    this.posters.clear();
    this.addPoster(post);
  }

  private post(message: HostToWebviewMessage): void {
    for (const poster of this.posters) {
      try {
        poster(message);
      } catch (error) {
        this.output.appendLine(`[post] ${errorText(error)}`);
      }
    }
  }

  ensureStorage(): Promise<void> { return this.sessions.ensureStorage(); }

  /** 面板重新挂载时，把当前状态一次性同步给 Webview。 */
  syncState(): void {
    void this.ensureStorage().then(() => {
      this.republishRuntimeState();
      this.context.publishItems();
      this.context.pushComposerStatus();
      if (this.changes.lastTurnId) this.changes.postChanges(this.changes.lastTurnId);
      this.permissions.republishCurrent();
      this.questions.republishCurrent();
      this.turns.publishQueue();
      void this.sessions.refreshList();
      this.preheatConnection();
    });
  }

  /**
   * 面板打开即后台预热连接，首条消息不再吃冷启动（对齐 grok-app 的做法）。
   * 只试一次；失败不把 UI 打到 error，重连按钮与下次发送都还能正常拉起。
   */
  private preheatAttempted = false;
  private preheatConnection(): void {
    if (this.preheatAttempted || this.runtimes.current) return;
    this.preheatAttempted = true;
    void this.runtimes.ensureStarted()
      .then(() => this.output.appendLine("[preheat] 连接预热完成"))
      .catch((error: unknown) => {
        this.output.appendLine(`[preheat] 连接预热失败（不影响使用，发送时会重试）：${errorText(error)}`);
        // start() 中途失败可能把状态机留在 initializing（不可发送）；
        // 预热失败不该锁死界面，退回 idle 让发送路径自己重试。
        if (this.ui.state === "initializing") {
          this.ui.force("idle");
          this.postState();
        }
      });
  }

  private republishRuntimeState(): void {
    this.postState();
    this.modes.publish();
    this.context.pushUsage();
    this.modelFacade.publish();
    this.plans.publishActive();
  }

  private postState(detail?: string): void {
    const snapshot = this.ui.snapshot();
    this.store.patchRuntime({
      uiState: snapshot.state,
      busy: snapshot.busy,
      canSend: snapshot.canSend,
      canCancel: snapshot.canCancel,
      canSwitchMode: snapshot.canSwitchMode,
      canApplyChanges: snapshot.canApplyChanges,
      canRestoreChanges: snapshot.canRestoreChanges,
      mode: this.modes.current,
    });
    this.post({
      type: "state",
      state: snapshot.state,
      busy: snapshot.busy,
      canSend: snapshot.canSend,
      canCancel: snapshot.canCancel,
      canSwitchMode: snapshot.canSwitchMode,
      canApplyChanges: snapshot.canApplyChanges,
      canRestoreChanges: snapshot.canRestoreChanges,
      ...(detail ? { detail } : {}),
    });
    // 供快捷键 when 子句判断，例如仅在执行中启用「停止」。
    void vscode.commands.executeCommand("setContext", "lingdongAgent.busy", snapshot.busy);
  }

  markLayoutFallback(reason: string): void {
    this.store.setLayoutFallback(true, reason);
    this.output.appendLine(`[layout] 降级：${reason}`);
  }

  // ---------------------------------------------------------------------------
  // 模型与菜单
  // ---------------------------------------------------------------------------

  getUsage(): UsageView { return this.context.toUsageView(); }
  selectModel(modelId: string): Promise<void> { return this.modelFacade.select(modelId); }
  openModelPicker(): Promise<void> { return this.modelFacade.openPicker(); }
  openComposerMenu(): void { this.modelFacade.openComposerMenu(); }

  /** 命令入口：录入或更换某个 Provider 的 API Key。 */
  async configureProviderKey(providerId?: string): Promise<void> {
    const saved = await this.providers.configureKey(providerId);
    this.refreshModelProjection();
    this.modelFacade.publish();
    if (saved) await this.onCredentialChanged(saved);
  }

  /**
   * Provider 配置有任何变更后的收口：重写 config.toml、重投影模型、刷新 Composer。
   *
   * 刻意不在这里重启子进程。当前会话仍在用它自己的 Provider 与凭据，
   * 用户在设置页改别的服务商不该打断正在跑的任务。
   * 密钥变更走 onCredentialChanged，那条路径才会按需重启。
   */
  private async onProvidersChanged(): Promise<void> {
    this.refreshModelProjection();
    try {
      await this.providers.writeConfig(this.modelFacade.currentModelId());
    } catch (error) {
      this.output.appendLine(`[providers] 写入 config.toml 失败：${errorText(error)}`);
    }
    await this.refreshExtensionCapabilities();
    this.modelFacade.publish();
    this.context.pushComposerStatus();
  }

  /**
   * 密钥写入 SecretStorage 之后：若这份密钥已经装进当前子进程，立刻重连。
   *
   * 子进程环境在启动时一次性注入，之后改 SecretStorage 它看不见。
   * 不重连的表现就是：设置页显示「已保存」，对话却继续 401——用户日志里那次就是这个。
   */
  private async onCredentialChanged(providerId: string): Promise<void> {
    const runtime = this.runtimes.current;
    if (!runtime?.sessionId) return;
    const snapshot = this.providers.launchSnapshot;
    const injected = snapshot?.providerIds.includes(providerId) === true;
    if (!injected) return;

    const provider = this.providers.registry.get(providerId);
    const name = provider?.displayName ?? providerId;
    this.post({
      type: "notice",
      level: "info",
      message: `已更新 ${name} 的凭据，正在重新连接以生效……`,
    });
    await this.reconnect();
  }

  /** Skills / MCP 变更：重写 config、刷新脱敏字面量与 capabilities。 */
  private async onExtensionsChanged(): Promise<void> {
    try {
      await this.providers.writeConfig(this.modelFacade.currentModelId());
      await this.providers.refreshRedaction();
    } catch (error) {
      this.output.appendLine(`[extensions] 写入 config.toml 失败：${errorText(error)}`);
    }
    await this.refreshExtensionCapabilities();
    this.modelFacade.publish();
    this.context.pushComposerStatus();
  }

  private async refreshExtensionCapabilities(): Promise<void> {
    try {
      const caps = await this.extensions.capabilities();
      this.skillsConfigured = caps.skillsConfigured;
      this.mcpConfigured = caps.mcpConfigured;
    } catch (error) {
      this.output.appendLine(`[extensions] 刷新能力标记失败：${errorText(error)}`);
    }
  }

  /** 隐私状态文档内容；数据全部来自本次启动的真实画像。 */
  /**
   * 隐私画像的原始输入。
   *
   * Markdown 文档与设置页里的结构化版本共用它，两处才不会各说各话——
   * 这份东西的全部价值就在于「说的是运行时真实发生的事」。
   */
  async privacyStatusInput(): Promise<PrivacyStatusInput> {
    await this.providers.load();
    const profile = this.providers.lastProfile;
    const providerId = profile?.providerId
      ?? this.sessions.current?.providerId
      ?? this.currentModelDescriptor()?.providerId;
    return {
      profile,
      keyConfigured: providerId ? this.providers.secretStore.hasKey(providerId) : false,
      managedHome: managedHomeEnabled(),
      privacyEnv: PRIVACY_ENV,
      strippedCredentials: CREDENTIAL_DENY_LIST,
    };
  }

  async privacyStatusText(): Promise<string> {
    return renderPrivacyStatus(await this.privacyStatusInput());
  }

  /**
   * Agent 诊断文档内容：Grok 实际发现的配置 + 我们实际注入的行为规则。
   *
   * 不要求已经连上 Grok：`inspect` 是独立子命令，未连接时也能回答
   * 「我的 AGENTS.md 到底有没有被读到」。
   */
  async agentDiagnosticsText(): Promise<string> {
    const workspaceRoot = this.activeRoot();
    const grokHome = this.providers.lastProfile?.grokHome?.trim()
      || this.providers.managedHome.directory;

    let executable: string | undefined;
    let inspect: { json?: string; error?: string } = {};
    try {
      executable = this.runtimes.resolveLaunchConfig().executable;
    } catch (error) {
      inspect = { error: `无法定位 Grok 可执行文件：${errorText(error)}` };
    }

    if (executable && workspaceRoot) {
      inspect = await runGrokInspect({
        executable,
        cwd: workspaceRoot,
        ...(grokHome ? { grokHome } : {}),
      });
    } else if (executable && !workspaceRoot) {
      inspect = { error: "尚未打开工作区，无法诊断项目级规则。" };
    }

    return renderAgentDiagnostics({
      ...(inspect.json ? { inspectJson: inspect.json } : {}),
      ...(inspect.error ? { inspectError: inspect.error } : {}),
      injectedRules: this.runtimes.current?.injectedRules ?? "",
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(executable ? { grokExecutable: executable } : {}),
      ...(grokHome ? { grokHome } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // 宿主能力入口
  // ---------------------------------------------------------------------------

  openSettings(): Promise<void> { return this.tools.openSettings(); }
  openExternalUrl(url: string): Promise<void> { return this.tools.openExternalUrl(url); }
  listWorkspaceFiles(query?: string): Promise<void> { return this.tools.listFiles(query); }
  openWorkspaceFile(relativePath: string, line?: number): Promise<void> {
    return this.tools.openFile(relativePath, line);
  }
  openNativeTerminal(): Promise<void> { return this.tools.openTerminal(); }
  openSimpleBrowser(url?: string): Promise<void> { return this.tools.openBrowser(url); }

  /**
   * 打开一个绝对路径的文件。规则文件可能在仓库外（用户级 rules 目录），
   * 所以不能走 tools.openFile 那条限定在工作区内的路径。
   */
  async openAbsoluteFile(absolutePath: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      this.output.appendLine(`[rules] 打开文件失败：${errorText(error)}`);
      throw error;
    }
  }

  async showLogs(): Promise<void> {
    this.output.show(true);
    const appLog = this.runtimes.current?.appLogPath;
    if (!appLog) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(appLog));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.output.appendLine(`[logs] ${errorText(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 会话
  // ---------------------------------------------------------------------------

  refreshSessionList(query?: string): Promise<SessionRecord[]> {
    return query === undefined ? this.sessions.refreshList() : this.sessions.refreshList(query);
  }
  setSessionQuery(query: string): void { void this.sessions.refreshList(query); }
  pinSession(sessionId: string, pinned?: boolean): Promise<void> {
    return this.sessions.setPinned(sessionId, pinned);
  }
  archiveSession(sessionId: string, archived?: boolean): Promise<void> {
    return this.sessions.setArchived(sessionId, archived);
  }
  renameSession(sessionId?: string, title?: string): Promise<void> {
    return this.sessions.rename(sessionId, title);
  }
  deleteSession(sessionId?: string): Promise<void> { return this.sessions.remove(sessionId); }
  loadPersistedSession(sessionId: string): Promise<void> {
    return this.sessions.load(sessionId, this.runtimes.current);
  }
  openSessionMenu(sessionId: string): Promise<void> {
    return this.sessions.openMenu(sessionId, this.runtimes.current);
  }
  openSessionHistory(): Promise<void> {
    return this.sessions.openHistory(this.runtimes.current);
  }

  newSession(): Promise<void> { return this.sessions.createNew(); }

  publishWorkspaces(): void {
    this.workspaces.publish();
    this.publishFirstRunGate();
  }
  openFolder(): Promise<void> { return this.workspaces.addFolder(); }
  switchWorkspace(target: string): Promise<void> {
    // 对标 Cursor：连点只保留最后一次目标，不把每次点击都排成完整拆建。
    this.coalesceRepoTarget = target;
    return this.ensureRepoPump();
  }
  removeWorkspace(target: string): Promise<void> {
    return this.enqueueRepoSerial(() => this.workspaces.remove(target));
  }

  /**
   * 换仓泵：串行执行，但目标可合并。
   * `coalesceRepoTarget` 为 string 表示切过去，`null` 表示清空，`undefined` 表示泵空闲。
   */
  private coalesceRepoTarget: string | null | undefined = undefined;
  private repoPump: Promise<void> | undefined;
  private repoSerial: Promise<void> = Promise.resolve();

  private ensureRepoPump(): Promise<void> {
    this.repoPump ??= this.runRepoPump().finally(() => { this.repoPump = undefined; });
    return this.repoPump;
  }

  private async runRepoPump(): Promise<void> {
    while (this.coalesceRepoTarget !== undefined) {
      const next = this.coalesceRepoTarget;
      this.coalesceRepoTarget = undefined;
      if (next === null) await this.clearRepoInner(() => this.coalesceRepoTarget !== undefined);
      else await this.switchRepoInner(next, () => this.coalesceRepoTarget !== undefined);
    }
  }

  private enqueueRepoSerial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.repoSerial.then(fn, fn);
    this.repoSerial = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 列表被清空后的收尾：没有活动仓库可挂，对话面与存储都拆掉。
   * 跟 activateRepo 对称，只是目标是「无」。
   */
  async clearRepo(): Promise<void> {
    this.coalesceRepoTarget = null;
    return this.ensureRepoPump();
  }

  private async clearRepoInner(isCancelled: () => boolean = () => false): Promise<void> {
    // 忙时只点火取消，不等整轮 finalize——否则清空跟切换一样卡。
    if (this.ui.canCancel) void this.stop().catch(() => undefined);

    this.resetForNewSession();
    this.context.usage.reset();
    void this.changes.reset().catch((error: unknown) => {
      this.output.appendLine(`[workspace] 清空变更跟踪失败：${error instanceof Error ? error.message : String(error)}`);
    });
    await this.sessions.resetForRoot();
    if (isCancelled()) return;

    this.runtimes.disposeForSwitchFast();
    this.preheatAttempted = false;

    await this.activeRepo.remember(undefined);
    this.lsp.invalidate();
    this.output.appendLine("[workspace] 已清空活动仓库");
    this.publishWorkspaces();
    await this.sessions.refreshList();
    if (isCancelled()) return;
    this.republishRuntimeState();
  }

  /**
   * 换仓库，窗口一动不动。对标 Cursor Agents：先换皮，再后台拆建。
   *
   * 以前这件事走的是 `vscode.openFolder`，等于换掉整个窗口的工作区，必然重开；
   * 而用 `updateWorkspaceFolders` 追加也躲不过——VS Code 在「单文件夹 → 多文件夹」
   * 这一步一定会重载。根子在于「仓库」曾经就是 VS Code 的工作区文件夹。
   * 现在仓库归我们自己存，于是换仓库退化成一次纯内部的拆建。
   */
  async activateRepo(target: string): Promise<void> {
    this.coalesceRepoTarget = target;
    return this.ensureRepoPump();
  }

  /** switchTo 入口：存在性检查 + 真正拆建；供泵与 WorkspaceSwitcher 共用 Inner。 */
  private async switchRepoInner(target: string, isCancelled: () => boolean): Promise<void> {
    if (!(await this.fs.exists(target))) {
      this.post({ type: "notice", level: "warn", message: `文件夹已不存在：${target}` });
      return;
    }
    if (isCancelled()) return;
    const previous = this.activeRoot();
    if (previous && samePath(previous, target)) return;
    await this.activateRepoInner(target, isCancelled);
  }

  private async activateRepoInner(target: string, isCancelled: () => boolean = () => false): Promise<void> {
    const previous = this.activeRoot();
    if (previous && samePath(previous, target)) return;
    if (!(await this.fs.exists(target))) {
      this.post({ type: "notice", level: "warn", message: `文件夹已不存在：${target}` });
      return;
    }
    if (isCancelled()) return;

    // —— 第一帧（对标 Cursor）：立刻换当前仓库 + 空出对话面 ——
    // 忙时只请求停止，不阻塞换皮。
    if (this.ui.canCancel) void this.stop().catch(() => undefined);

    this.resetForNewSession();
    this.context.usage.reset();
    void this.changes.reset().catch((error: unknown) => {
      this.output.appendLine(`[workspace] 重置变更跟踪失败：${error instanceof Error ? error.message : String(error)}`);
    });

    await this.activeRepo.remember(target);
    // 探测过的 language server 路径与仓库绑定（node_modules/.bin），换仓即失效。
    this.lsp.invalidate();
    this.output.appendLine(`[workspace] 已切换仓库：${target}`);
    await this.workspaces.recordCurrent();
    if (isCancelled()) return;

    // 左栏 current 立刻变成新仓；clear 抢在 flush 前发出。
    this.publishWorkspaces();
    await this.sessions.resetForRoot();
    if (isCancelled()) return;
    this.republishRuntimeState();

    // —— 后台拆建：杀旧 Grok 不挡 UI；存储恢复与预热随后跟上 ——
    this.runtimes.disposeForSwitchFast();
    this.preheatAttempted = false;

    await this.ensureStorage();
    if (isCancelled()) return;

    await this.sessions.refreshList();
    if (isCancelled()) return;
    this.publishWorkspaces();
    this.republishRuntimeState();
    this.preheatConnection();
  }

  private resetForNewSession(): void {
    this.permissions.clearCards("已新建会话");
    this.permissions.clearRejectionHistory();
    this.turnState.pendingPlan = false;
    this.turnState.pendingPrompt = undefined;
    // 排队的消息是对旧会话说的，跟着一起清。
    this.turns.clearQueue();
    this.context.clear();
    // 新会话不会再重发旧对话，历史轮次里的图片标记也就没人查了。
    this.context.clearImages();
    this.changes.lastTurnId = undefined;
    this.suggestions.reset();
  }

  private afterNewSession(): void {
    this.ui.force("ready");
    this.turnState.debugPhase = this.modes.current === "debug" ? "collect" : "idle";
    this.modes.publish();
    this.postState();
    this.context.pushUsage();
    this.modelFacade.publish();
  }

  // ---------------------------------------------------------------------------
  // 上下文
  // ---------------------------------------------------------------------------

  addCurrentFile(): Promise<void> { return this.context.addCurrentFile(); }
  addSelection(): Promise<void> { return this.context.addSelection(); }
  pickContextFiles(): Promise<void> { return this.context.pickFiles(); }
  pickContextFolder(): Promise<void> { return this.context.pickFolder(); }
  addTerminalOutput(): void { this.context.addTerminalOutput(); }
  addImageContext(name: string, dataUrl: string): void {
    this.context.addImage(name, dataUrl);
  }
  addDroppedUris(uris: readonly string[]): Promise<void> { return this.context.addDroppedUris(uris); }
  addDroppedNamedFile(name: string, content: string): Promise<void> {
    return this.context.addDroppedNamedFile(name, content);
  }
  addTerminalSelection(): Promise<void> { return this.context.addTerminalSelection(); }
  removeContext(id: string): void { this.context.remove(id); }
  clearContext(): void { this.context.clear(); }
  compactConversation(): Promise<void> { return this.context.compactConversation(); }
  showContext(id: string): Promise<void> { return this.context.show(id); }
  async addDiagnosticsContext(): Promise<void> { this.context.addDiagnostics(); }

  suggestContext(query: string): Promise<void> { return this.suggestions.suggest(query); }

  async selectContextCandidate(candidateId: string, sourceType: CandidateSource): Promise<void> {
    await this.suggestions.select(candidateId, sourceType);
  }

  /** 当前编辑器的工作区相对路径与选区状态；工作区外的文件不参与候选。 */
  private activeFileInfo(): ActiveFileInfo | undefined {
    const editor = vscode.window.activeTextEditor;
    const root = this.sessions.workspaceRoot;
    if (!editor || !root || editor.document.uri.scheme !== "file") return undefined;
    const relative = normalizeRelativePath(path.relative(root, editor.document.uri.fsPath));
    if (!relative || relative.startsWith("..")) return undefined;
    return { relativePath: relative, hasSelection: !editor.selection.isEmpty };
  }

  /** 把解析后的候选交给既有上下文入口，读取与脱敏逻辑不在这里重写。 */
  private applyContextCandidate(target: ResolvedCandidate): Promise<void> {
    switch (target.source) {
      case "current-file": return this.context.addCurrentFile();
      case "selection": return this.context.addSelection();
      case "problems": return this.addDiagnosticsContext();
      case "terminal": return Promise.resolve(this.context.addTerminalOutput());
      case "file": return this.context.addFileAtPath(target.relativePath);
      case "folder": return this.context.addFolderAtPath(target.relativePath);
    }
  }

  // ---------------------------------------------------------------------------
  // 计划
  // ---------------------------------------------------------------------------

  savePlanEdits(payload: PlanEditPayload): Promise<void> { return this.plans.saveEdits(payload); }
  addPlanStep(title: string, description?: string): Promise<void> {
    return this.plans.addStep(title, description);
  }
  removePlanStep(stepId: string): Promise<void> { return this.plans.removeStep(stepId); }
  setPlanStepIncluded(stepId: string, included: boolean): Promise<void> {
    return this.plans.setStepIncluded(stepId, included);
  }
  updatePlanStep(
    stepId: string,
    patch: { title: string; description?: string; files?: string[] },
  ): Promise<void> {
    return this.plans.updateStep(stepId, patch);
  }
  reorderPlanSteps(stepIds: string[]): Promise<void> { return this.plans.reorderSteps(stepIds); }
  startPlanBuild(): Promise<void> { return this.plans.startBuild(); }
  pausePlanBuild(): Promise<void> { return this.plans.pauseBuild(); }
  resumePlanBuild(): Promise<void> { return this.plans.resumeBuild(); }
  answerClarification(id: string, answer: string): Promise<void> {
    return this.plans.answerClarification(id, answer);
  }
  discardPlanEdits(): void { this.plans.discardEdits(); }
  approvePlan(): Promise<void> { return this.plans.approve(); }
  rejectPlan(): Promise<void> { return this.plans.reject(); }
  revisePlan(feedback: string): Promise<void> { return this.plans.revise(feedback); }

  savePlanToWorkspace(): Promise<void> { return this.plans.saveToWorkspace(); }

  async confirmDebugFix(): Promise<void> {
    if (this.turnState.debugPhase !== "await_confirm") {
      this.post({ type: "notice", level: "info", message: "当前没有等待确认的 Debug 方案。" });
      return;
    }
    this.turnState.debugPhase = "fixing";
    this.store.setDebugArmed(true);
    this.post({ type: "debugState", phase: "fixing", message: "已确认，切换到 Agent 开始修复。" });
    await this.setMode("agent");
    await this.sendPrompt(
      "请根据前面的只读分析开始修复：先验证问题复现，再做最小必要修改，最后说明如何验证。",
      { skipIntentCheck: true },
    );
  }

  // ---------------------------------------------------------------------------
  // 变更、Diff 与恢复
  // ---------------------------------------------------------------------------

  readSnapshot(turnId: string, relativePath: string): Promise<string> {
    return this.changes.readSnapshot(turnId, relativePath);
  }
  acceptChange(changeId: string): Promise<void> { return this.changes.acceptChange(changeId); }
  rejectChange(changeId: string): Promise<void> { return this.changes.rejectChange(changeId); }
  hunkAction(changeId: string, hunkId: string, action: "accept" | "reject"): Promise<void> {
    return this.changes.hunkAction(changeId, hunkId, action);
  }
  acceptAll(turnId: string): Promise<void> { return this.changes.acceptAll(turnId); }
  rejectAll(turnId: string): Promise<void> { return this.changes.rejectAll(turnId); }
  openDiff(changeId: string): Promise<void> { return this.changes.openDiff(changeId); }
  changeDiff(changeId: string): Promise<void> { return this.changes.changeDiff(changeId); }
  revealChanges(): Promise<void> { return this.changes.reveal(); }
  showConflict(changeId: string): Promise<void> { return this.changes.showConflict(changeId); }

  /** 命令面板入口：撤销最近一轮尚未接受的修改。 */
  async undoLastTurn(): Promise<void> {
    const turnId = this.changes.lastTurnId;
    if (!turnId) {
      this.post({ type: "notice", level: "info", message: "当前会话还没有可撤销的文件修改。" });
      return;
    }
    await this.undoTurn(turnId);
  }

  /** 撤销本轮：先停止仍在执行的任务并清空权限队列，再逐个校验哈希恢复。 */
  async undoTurn(turnId: string): Promise<void> {
    if (!this.ui.canRestoreChanges) {
      this.post({ type: "notice", level: "warn", message: "正在恢复文件，请等待本次恢复完成。" });
      return;
    }
    if (this.ui.canCancel) {
      await this.stop();
      const pending = this.turns.pending;
      if (pending) await pending;
    }
    this.permissions.clearCards("撤销本轮修改");
    await this.changes.restoreTurn(turnId, "撤销本轮修改");
  }

  // ---------------------------------------------------------------------------
  // 连接
  // ---------------------------------------------------------------------------

  reconnect(options: { auto?: boolean } = {}): Promise<void> {
    this.permissions.clearCards("连接已重置");
    this.permissions.clearRejectionHistory();
    this.turnState.pendingPlan = false;
    return this.runtimes.reconnect(options);
  }

  locateGrokExecutable(): Promise<void> { return this.runtimes.locateExecutable(); }

  // ---------------------------------------------------------------------------
  // 一轮任务
  // ---------------------------------------------------------------------------

  sendPrompt(text: string, options: { skipIntentCheck?: boolean } = {}): Promise<void> {
    return this.turns.send(text, options);
  }
  /** 由 extension.ts 注入：把后台任务输出开成只读文档。未注册时（测试）为 undefined。 */
  openBackgroundTaskOutput?: (id: string, title: string) => Promise<void>;

  backgroundTaskOutput(id: string): string | undefined {
    return this.turns.backgroundTaskOutput(id);
  }

  async showBackgroundTaskOutput(id: string): Promise<void> {
    const task = this.turns.backgroundTask(id);
    if (!task) {
      this.post({ type: "notice", level: "info", message: "这个后台任务的记录已经不在了。" });
      return;
    }
    if (!this.openBackgroundTaskOutput) return;
    // 命令原文会进页签标题，路径分隔符与非法文件名字符先换掉。
    const title = task.command.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 40) || "后台任务";
    await this.openBackgroundTaskOutput(id, title);
  }

  /**
   * 终止后台任务。
   *
   * 先试 ACP 的 x.ai/task/kill；那个方法名是从 grok.exe 的字符串里认出来的，
   * 0.2.118 到底受不受理无法离线确认，所以失败就退回到让模型自己调 kill 工具。
   * 后者一定能用，代价是要等下一轮——忙的时候会排队。
   */
  async killBackgroundTask(id: string): Promise<void> {
    const task = this.turns.backgroundTask(id);
    if (!task) {
      this.post({ type: "notice", level: "info", message: "这个后台任务的记录已经不在了。" });
      return;
    }
    if (task.status !== "running") {
      this.post({ type: "notice", level: "info", message: "这个后台任务已经结束了。" });
      return;
    }
    if (!task.taskId) {
      this.post({
        type: "notice",
        level: "warn",
        message: `没能从 Grok 的返回里解析出任务 id，无法直接终止「${task.command}」。可以让 Agent 帮你终止它。`,
      });
      return;
    }

    const runtime = this.runtimes.current;
    if (runtime?.killTask) {
      try {
        await runtime.killTask(task.taskId);
        this.turns.noteBackgroundTaskKilled(id);
        this.post({ type: "notice", level: "info", message: `已终止「${task.command}」。` });
        return;
      } catch (error) {
        this.output.appendLine(`[background] x.ai/task/kill 不可用，改让模型终止：${errorText(error)}`);
      }
    }
    this.post({
      type: "notice",
      level: "info",
      message: `正在请 Agent 终止「${task.command}」。`,
    });
    await this.sendPrompt(
      `请调用 kill_command_or_subagent 终止 task_id 为 ${task.taskId} 的后台任务，完成后只回一句确认。`,
      { skipIntentCheck: true },
    );
  }

  continuePendingPrompt(): Promise<void> { return this.turns.continuePending(); }
  removeQueuedPrompt(id: string): void { this.turns.removeQueued(id); }
  editQueuedPrompt(id: string, text: string): void { this.turns.editQueued(id, text); }
  reorderQueuedPrompts(orderedIds: string[]): void { this.turns.reorderQueue(orderedIds); }
  flushQueuedPrompt(id: string): Promise<void> { return this.turns.flushQueued(id); }
  stop(): Promise<void> { return this.turns.stop(); }

  // ---------------------------------------------------------------------------
  // 模式与权限
  // ---------------------------------------------------------------------------

  setMode(mode: UiAgentMode): Promise<void> { return this.modes.set(mode); }

  respondPermission(requestId: string, decision: UiPermissionDecision): Promise<void> {
    return this.permissions.respond(requestId, decision);
  }

  /** 设置项改动后同步到已连接的 Runtime；未连接时下次拉起自然读到新值。 */
  refreshApprovalPolicy(): void {
    const policy = approvalPolicy();
    this.runtimes.current?.setApprovalPolicy?.(policy);
    this.output.appendLine(`[permission] 审批力度：${policy}`);
  }

  /** 清空「以后都允许」规则；下一次同类操作会重新询问。 */
  async clearPermissionRules(): Promise<void> {
    await this.ensureStorage();
    const rules = this.sessions.persistence?.permissionRules;
    if (!rules || rules.size === 0) {
      this.post({ type: "notice", level: "info", message: "当前工作区没有已记住的权限规则。" });
      return;
    }
    const count = rules.size;
    await rules.clear();
    this.runtimes.current?.clearSessionRules();
    this.post({ type: "notice", level: "info", message: `已清空 ${count} 条权限规则，下次会重新询问。` });
  }

  respondQuestion(requestId: string, answers: string[]): Promise<void> {
    return this.questions.respond(requestId, answers);
  }

  async dispose(): Promise<void> {
    this.permissions.clearCards("扩展已关闭");
    await this.sessions.flush();
    await this.runtimes.shutdown();
    // 子进程先停，再收本地转发端口，避免它还在读时把连接抽掉。
    await this.providers.stopProxy();
    this.ui.force("disposed");
  }
}
