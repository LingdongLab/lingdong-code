import type { ChangeListView, HunkView } from "./change-view";
import {
  CANDIDATE_SOURCES,
  SUGGEST_QUERY_MAX,
  type CandidateGroup,
  type CandidateSource,
} from "./composer/context-candidate";
import type { ContextItemType } from "./context-model";
import type { DiffText } from "./diff-text";
import type { CompactionCapability, ContextUsageLevel, ContextUsageRecord, UsageBreakdown } from "./context-usage";
import type { ModelDescriptor } from "./model-registry";
import type { PlanCardView, PlanStatus } from "./plan-view-model";
import type { ActivityGroupHeader } from "./presentation/activity-group";
import type { ActivityItem } from "./presentation/activity-item";
import type { TurnPresentation, TurnPresentationHeader } from "./presentation/turn-presentation";
import type { BackgroundTaskView } from "./services/background-task-tracker";
import { IMAGE_LIMITS } from "./services/image-store";
import type { SubagentTaskView } from "./services/subagent-tracker";
import type { PlanClarification, PlanRecord } from "./storage/plan-repository";
import type { UiState } from "./ui-state";

/** UI 模式含本地 Debug；发给 Grok 时 Debug 映射为 ask。 */
export const AGENT_MODES = ["ask", "plan", "agent", "auto", "debug"] as const;
export type UiAgentMode = (typeof AGENT_MODES)[number];

/** Runtime / 安全策略真正认识的模式。 */
export const RUNTIME_MODES = ["ask", "plan", "agent", "auto"] as const;
export type RuntimeAgentMode = (typeof RUNTIME_MODES)[number];

export function toRuntimeMode(mode: UiAgentMode): RuntimeAgentMode {
  return mode === "debug" ? "ask" : mode;
}

/** Webview 输入长度上限，防止一次性把超大内容推给 Extension Host。 */
export const MAX_PROMPT_LENGTH = 20_000;
/** 计划反馈长度上限。 */
export const MAX_FEEDBACK_LENGTH = 4_000;
/** requestId 由 Runtime 生成，正常只是短数字串；超长一律视为伪造。 */
export const MAX_REQUEST_ID_LENGTH = 128;

export const PERMISSION_DECISIONS = ["allow_once", "allow_session", "allow_always", "reject"] as const;
export type UiPermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export type UiRiskLevel = "low" | "medium" | "high" | "blocked";
export type UiToolKind = "read" | "edit" | "execute" | "search" | "plan" | "subagent" | "other";

/**
 * 对话内联引导按钮（替代 VS Code show*Message toast）。
 * 宿主只认这一组 id，未知 id 在 parse 时丢弃。
 */
export const SETUP_ACTION_IDS = [
  "configureProviderKey",
  "openModelSettings",
  "openExtensionSettings",
  "locateGrok",
  "openGrokSettings",
  "importLegacyKey",
  "dismiss",
] as const;
export type SetupActionId = (typeof SETUP_ACTION_IDS)[number];

export function isSetupActionId(value: unknown): value is SetupActionId {
  return typeof value === "string" && (SETUP_ACTION_IDS as readonly string[]).includes(value);
}

export interface SetupActionButton {
  id: SetupActionId;
  label: string;
}

/** Webview 只拿摘要，不拿上下文正文。 */
export interface ContextItemView {
  id: string;
  type: ContextItemType;
  label: string;
  size: number;
  truncated: boolean;
  lineRange?: { start: number; end: number };
}

/** 权限卡上的一步说明：命令原段落 + 这一段用人话说是在做什么。 */
export interface PermissionStepView {
  command: string;
  action: string;
}

export interface PermissionCardView {
  requestId: string;
  title: string;
  operation: string;
  target?: string;
  command?: string;
  /** 命令的执行目录；工具没给就没有。 */
  cwd?: string;
  /** 「会做什么」：逐段人话说明，顺序即执行顺序。 */
  steps: PermissionStepView[];
  /** 「要注意」：这次操作的后果，每条都是完整句子。 */
  notes: string[];
  /**
   * 模型自己写的意图说明。
   * 它来自被审批的一方，界面上必须标明出处，不能和本地推导的说明混在一起。
   */
  intent?: string;
  risk: UiRiskLevel;
  /** high / blocked 不允许「本次会话允许」。 */
  allowSession: boolean;
  /** 能否持久化为「以后都允许」；需要同时满足风险可记忆与存储可用。 */
  allowAlways: boolean;
}

/** 模型提问的单个选项。 */
export interface AskQuestionOptionView {
  label: string;
  preview?: string;
}

export interface AskQuestionItemView {
  question: string;
  options: AskQuestionOptionView[];
  multiSelect: boolean;
}

/** 模型通过 ask_user_question 工具发起的提问卡片。 */
export interface AskQuestionCardView {
  requestId: string;
  questions: AskQuestionItemView[];
}

/** 单题答案长度上限（多选合并、自由文本都算一条）。 */
export const MAX_ANSWER_LENGTH = 4_000;
/** 一次提问的问题数量上限，超出视为异常报文。 */
export const MAX_QUESTIONS_PER_ASK = 20;

export interface UsageView {
  label: string;
  level: ContextUsageLevel;
  source: ContextUsageRecord["source"];
  usedTokens: number;
  contextLimit?: number;
  percentage?: number;
  compactCapability: CompactionCapability;
  compactBusy: boolean;
  breakdown?: UsageBreakdown;
}

export interface ComposerCapabilities {
  skillsConfigured: boolean;
  mcpConfigured: boolean;
  imagesConfigured: boolean;
  autoSelectModels: boolean;
  hasVisionModel: boolean;
}

/** 左侧会话列表项（不暴露绝对路径与内部调试字段）。 */
export interface SessionListItemView {
  id: string;
  title: string;
  updatedAt: number;
  localMode: string;
  pinned: boolean;
  archived: boolean;
  pendingChanges: number;
  conflictChanges: number;
  hasUnfinishedPlan: boolean;
}

export type WebviewToHostMessage =
  | { type: "ready" }
  /**
   * 发一条提问。
   *
   * mode 只由 `/plan 重构登录` 这类「切模式 + 提问」的斜杠命令带上。
   * 之所以合成一条消息而不是发两条：每条 Webview 消息都是独立 await 的，
   * 分两条会让提问可能赶在模式切换完成之前发出去。
   */
  | { type: "sendPrompt"; text: string; mode?: UiAgentMode }
  | { type: "stop" }
  | { type: "newSession" }
  | { type: "openHistory" }
  | { type: "loadSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "deleteSession"; sessionId: string }
  /** 由宿主弹 QuickPick 承载会话操作，Webview 不再自己 prompt / confirm。 */
  | { type: "openSessionMenu"; sessionId: string }
  | { type: "pinSession"; sessionId: string }
  | { type: "archiveSession"; sessionId: string }
  | { type: "searchSessions"; query: string }
  /** 在只读编辑器里打开某个后台任务已收到的输出。 */
  | { type: "showBackgroundTaskOutput"; taskId: string }
  /** 终止后台任务。taskId 是卡片主键，不是 Grok 的 task_id。 */
  | { type: "killBackgroundTask"; taskId: string }
  | { type: "openSettings" }
  | { type: "openFolder" }
  | { type: "switchWorkspace"; path: string }
  /** 从仓库列表移除；不删磁盘文件夹，只忘掉这条记录。 */
  | { type: "removeWorkspace"; path: string }
  | { type: "openExternalUrl"; url: string }
  | { type: "listWorkspaceFiles"; query?: string }
  | { type: "openWorkspaceFile"; relativePath: string; line?: number }
  | { type: "openNativeTerminal" }
  | { type: "openSimpleBrowser"; url?: string }
  | { type: "setMode"; mode: UiAgentMode }
  | { type: "showLogs" }
  | { type: "reconnect" }
  | { type: "approvePlan" }
  | { type: "rejectPlan" }
  | { type: "revisePlan"; feedback: string }
  | { type: "permissionDecision"; requestId: string; decision: UiPermissionDecision }
  /** 回答模型提问；answers 与问题一一对应，多选已在 Webview 合成一条文本。 */
  | { type: "answerQuestion"; requestId: string; answers: string[] }
  | { type: "askIntentOverride" }
  | { type: "addCurrentFile" }
  | { type: "addSelection" }
  | { type: "pickFiles" }
  | { type: "pickFolder" }
  | { type: "addTerminalOutput" }
  | { type: "addDiagnostics" }
  /** 粘贴 / 拖入的图片：字节进宿主的内存暂存，上下文里只留一个标记。 */
  | { type: "addImageContext"; name: string; dataUrl: string }
  /** 应用内拖拽（编辑器标签 / 资源管理器）带来的 file:// 列表；宿主逐条核对仓库边界。 */
  | { type: "addDroppedUris"; uris: string[] }
  /**
   * 从系统资源管理器拖入的文件。浏览器安全模型拿不到路径，只有名字和内容，
   * 宿主按名字在仓库里还原路径，还原不了就拒绝。
   */
  | { type: "addDroppedFile"; name: string; content: string }
  | { type: "removeContext"; id: string }
  | { type: "clearContext" }
  | { type: "showContext"; id: string }
  /** 内联 @ 候选查询；宿主搜索工作区并回 contextSuggestResults。 */
  | { type: "contextSuggestQuery"; query: string }
  /**
   * 选定一条 @ 候选。
   * 只带宿主先前下发的 opaque candidateId 与其来源类型，协议里不存在路径字段，
   * 因此 Webview 无法请求任意文件。
   */
  | { type: "contextSuggestSelect"; candidateId: string; sourceType: CandidateSource }
  | { type: "openDiff"; changeId: string }
  /** 展开变更卡里的内联 diff 时按需索取；不展开就不算，一轮十几个文件全算会卡一下。 */
  | { type: "requestChangeDiff"; changeId: string }
  | { type: "acceptChange"; changeId: string }
  | { type: "rejectChange"; changeId: string }
  /** 逐 hunk 接受/拒绝（Grok hunk-tracker 通道）；changeId 用来定位文件与回刷。 */
  | { type: "hunkAction"; changeId: string; hunkId: string; action: "accept" | "reject" }
  | { type: "showConflict"; changeId: string }
  | { type: "acceptAll"; turnId: string }
  | { type: "rejectAll"; turnId: string }
  | { type: "undoTurn"; turnId: string }
  | { type: "openComposerMenu" }
  | { type: "selectModel"; modelId: string }
  | { type: "compactContext" }
  | { type: "requestUsageDetail" }
  | { type: "openAgentPanel" }
  | { type: "openModelSettings" }
  | { type: "openExtensions" }
  | { type: "savePlanEdits"; plan: PlanEditPayload }
  | { type: "addPlanStep"; title: string; description?: string }
  | { type: "removePlanStep"; stepId: string }
  /** 结构化步骤编辑：只改这一步，不动计划正文。 */
  | { type: "updatePlanStep"; stepId: string; title: string; description?: string; files?: string[] }
  /** 步骤勾选：取消勾选记成 skipped，逐步门控就不会下发它。 */
  | { type: "setPlanStepIncluded"; stepId: string; included: boolean }
  | { type: "reorderPlanSteps"; stepIds: string[] }
  | { type: "startPlanBuild" }
  | { type: "pausePlanBuild" }
  | { type: "resumePlanBuild" }
  | { type: "discardPlanEdits" }
  | { type: "answerClarification"; clarificationId: string; answer: string }
  | { type: "confirmDebugFix" }
  /** 对话内联引导按钮（配置密钥 / 选择 Grok 等），不再走宿主 toast。 */
  | { type: "setupAction"; action: SetupActionId }
  /** 删除一条排队中的消息。 */
  | { type: "queueRemove"; id: string }
  /** 立即发送一条排队中的消息（仅空闲时有效）。 */
  | { type: "queueFlush"; id: string }
  /** 就地改写一条排队中的消息文本。 */
  | { type: "queueEdit"; id: string; text: string }
  /** 按给定顺序重排队列（orderedIds 为期望的先后次序）。 */
  | { type: "queueReorder"; orderedIds: string[] };

export interface PlanEditPayload {
  planId: string;
  title: string;
  goal?: string;
  files: string[];
  risks: string[];
  steps: Array<{ id?: string; title: string; description?: string; files: string[] }>;
  clarifications?: Array<{ id?: string; question: string; answer?: string }>;
  /** 计划 Markdown 原文；对标 Cursor，直接编辑文档时写入。 */
  raw?: string;
}

/** 会话标题最大长度，与 session-title 保持一致。 */
export const MAX_SESSION_TITLE_LENGTH = 40;

export type HostToWebviewMessage =
  | { type: "connection"; state: "idle" | "starting" | "ready" | "failed"; detail?: string }
  | { type: "session"; sessionId: string; model: string; mode: UiAgentMode; title?: string }
  | { type: "mode"; mode: UiAgentMode }
  | {
      type: "modeState";
      mode: UiAgentMode;
      serverMode?: string;
      pending?: UiAgentMode;
      canSwitch: boolean;
      reason?: string;
      /**
       * 当前模型未通过工具调用检测，只能用 Ask。
       * 与 canSwitch 分开：前者是模型能力限制，后者是本轮执行中的临时限制，
       * 界面要给出的解释完全不同。
       */
      askOnly?: boolean;
      askOnlyReason?: string;
    }
  | {
      type: "state";
      state: UiState;
      busy: boolean;
      canSend: boolean;
      canCancel: boolean;
      canSwitchMode: boolean;
      canApplyChanges: boolean;
      canRestoreChanges: boolean;
      detail?: string;
    }
  | { type: "busy"; busy: boolean }
  /**
   * 一轮任务的唯一主状态。Composer 上方 Status Bar 只认这一条，
   * 其它组件不得再各自猜 busy/thinking。
   */
  | {
      type: "turnStatus";
      status:
        | "idle"
        | "preparing"
        | "thinking"
        | "working"
        | "waiting_for_user"
        | "waiting_for_subagent"
        | "stopping"
        | "completed"
        | "failed"
        | "stopped"
        | "interrupted";
      label: string;
      activeElapsedMs: number;
      showElapsed: boolean;
      visible: boolean;
      canStop: boolean;
      connectionActions: boolean;
      /**
       * 距上一次有新输出过去了多久。缺省表示不适用（没在跑，或正等用户回卡片）。
       * 与 activeElapsedMs 是两回事：那个说「跑了多久」，这个说「还有没有在动」。
       */
      silentMs?: number;
      /** 完成摘要：缺省字段表示该行不显示。 */
      summary?: { filesChanged?: number; testsPassed?: number };
    }
  | { type: "userMessage"; text: string }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantEnd"; stopReason: string; modelId?: string }
  | { type: "activity"; message: string }
  /**
   * 模型推理原文的增量，折叠在思考块里由用户自己展开。
   *
   * 这条消息只从内存直达界面：不落盘、不进转录、不进时间线，
   * 也可以用 lingdongAgent.showReasoning 整体关掉。
   */
  | { type: "reasoningDelta"; text: string }
  | { type: "notice"; level: "info" | "warn"; message: string; actions?: SetupActionButton[] }
  | { type: "error"; message: string; recoverable?: boolean; actions?: SetupActionButton[] }
  /** 打开 Composer「＋」菜单（替代宿主 QuickPick 控制中心）。 */
  | { type: "openPlusMenu" }
  /** 在输入框插入 `@` 并聚焦，走内联补全而非文件 QuickPick。 */
  | { type: "beginAtMention" }
  | { type: "plan"; plan: PlanCardView }
  | { type: "planStatus"; status: PlanStatus; message?: string }
  | { type: "planRecord"; plan: PlanRecord }
  | { type: "permission"; card: PermissionCardView; waiting: number }
  | {
      type: "permissionResolved";
      requestId: string;
      resolution: "allow_once" | "allow_session" | "allow_always" | "reject" | "expired" | "cancelled";
      message: string;
      waiting: number;
    }
  /** 模型提问卡片；用户作答前 Grok 会一直等（托管配置已关闭问答超时）。 */
  | { type: "askQuestion"; card: AskQuestionCardView }
  | { type: "askQuestionResolved"; requestId: string; message: string; answers?: string[] }
  /**
   * 旧版工具摘要消息。新会话不再产生，只在恢复 v1 会话记录时出现，
   * 由旧 ToolSummary 渲染；正式的工具呈现走下面的 timeline* 消息。
   */
  | { type: "toolStarted"; toolCallId: string; kind: UiToolKind; label: string; target?: string; readOnly: boolean }
  | { type: "toolOutput"; toolCallId: string; text: string }
  | { type: "toolStatus"; toolCallId: string; status: "running" | "completed" | "failed"; exitCode?: number }
  /** 任务时间线：轮次状态。groups 由后续 timelineGroup / timelineItem 增量补齐。 */
  | { type: "timelineTurn"; turn: TurnPresentationHeader }
  /** 组头，不含 items，避免整组重绘。 */
  | { type: "timelineGroup"; turnId: string; group: ActivityGroupHeader }
  | { type: "timelineItem"; turnId: string; groupId: string; item: ActivityItem }
  /** 会话恢复时一次性下发的完整时间线，落地后不再订阅实时更新。 */
  | { type: "timelineRestore"; presentation: TurnPresentation }
  /** 子 Agent 任务台账全量快照；Tasks 面板据此画并行卡片。 */
  | { type: "subagents"; tasks: SubagentTaskView[] }
  /** 后台任务（background shell / monitor）全量快照。 */
  | { type: "backgroundTasks"; tasks: BackgroundTaskView[] }
  | { type: "askIntent"; reason: string; keyword?: string }
  | { type: "contextItems"; items: ContextItemView[] }
  /** 内联 @ 候选结果；detail 只可能是工作区相对路径。 */
  | {
      type: "contextSuggestResults";
      query: string;
      groups: CandidateGroup[];
      truncated: boolean;
      matched: number;
    }
  | { type: "changes"; view: ChangeListView }
  | { type: "changeDiff"; changeId: string; diff?: DiffText; error?: string; hunks?: HunkView[] }
  | { type: "usage"; usage: UsageView }
  | { type: "usageDetail"; usage: UsageView }
  | { type: "compactState"; capability: CompactionCapability; busy: boolean; message?: string }
  | { type: "models"; models: ModelDescriptor[]; selected: string; capabilities: ComposerCapabilities }
  | { type: "composerStatus"; line: string }
  | { type: "clarifications"; items: PlanClarification[] }
  | { type: "debugState"; phase: "collect" | "propose" | "await_confirm" | "fixing" | "verify" | "idle"; message?: string }
  /** 忙时发送队列的完整快照；空数组表示队列已清空。 */
  | { type: "sendQueue"; items: Array<{ id: string; text: string }> }
  | {
      type: "sessions";
      sessions: SessionListItemView[];
      activeSessionId?: string;
      query: string;
      workspaceName: string;
    }
  | {
      type: "workspaces";
      /** 当前活动仓库，会话按它归档。未选择时缺省。 */
      current?: { path: string; name: string };
      /**
       * @deprecated 不再嵌进当前仓库节点；其它根已并入 recent。
       * 保留字段以免旧客户端解析炸。
       */
      extraFolders?: Array<{ path: string; name: string }>;
      /** 其它仓库（扁平列表），已排除当前。 */
      recent: Array<{ path: string; name: string }>;
    }
  | {
      type: "workspaceFiles";
      files: Array<{ relativePath: string; directory: boolean }>;
      query: string;
      truncated: boolean;
      /** 命中总数；大于返回条数时说明列表被截断。 */
      matched?: number;
      /** 本次扫描上限；命中扫描上限说明结果可能不完整。 */
      scanLimit?: number;
    }
  | { type: "clear" }
  | {
      type: "restore";
      sessionId: string;
      model: string;
      mode: UiAgentMode;
      entries: HostToWebviewMessage[];
      title?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAgentMode(value: unknown): value is UiAgentMode {
  return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}

export function isPermissionDecision(value: unknown): value is UiPermissionDecision {
  return typeof value === "string" && (PERMISSION_DECISIONS as readonly string[]).includes(value);
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH;
}

/** 宿主生成的标识；Webview 只能原样回传，任何路径形态一律拒绝。 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

/**
 * 模型标识。比 SAFE_ID 宽一点：本地键形如 `poe:Claude-Sonnet-4.6`，
 * 带 Provider 前缀与冒号分隔，长度也超过 64。仍然不允许斜杠、空格与路径形态。
 */
const MODEL_ID = /^[A-Za-z0-9._:+-]{1,128}$/;

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

function parseStringList(value: unknown, max = 64): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, max);
  return items;
}

function isRelativePlanPath(value: string): boolean {
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.length > 500) return false;
  if (path.includes("..") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return true;
}

function parsePlanEdit(raw: Record<string, unknown>): PlanEditPayload | undefined {
  if (!isSafeId(raw.planId) || typeof raw.title !== "string") return undefined;
  const title = raw.title.trim();
  if (title.length === 0 || title.length > 200) return undefined;
  const files = (parseStringList(raw.files, 200) ?? []).filter(isRelativePlanPath);
  const risks = parseStringList(raw.risks, 40);
  if (!risks || !Array.isArray(raw.steps)) return undefined;
  const steps: PlanEditPayload["steps"] = [];
  for (const step of raw.steps.slice(0, 80)) {
    if (!isRecord(step) || typeof step.title !== "string") return undefined;
    const stepTitle = step.title.trim();
    if (stepTitle.length === 0 || stepTitle.length > 200) return undefined;
    const stepFiles = (parseStringList(step.files, 80) ?? []).filter(isRelativePlanPath);
    steps.push({
      ...(isSafeId(step.id) ? { id: step.id } : {}),
      title: stepTitle,
      ...(typeof step.description === "string" && step.description.trim()
        ? { description: step.description.trim().slice(0, 2_000) }
        : {}),
      files: stepFiles,
    });
  }
  const clarifications: NonNullable<PlanEditPayload["clarifications"]> = [];
  if (Array.isArray(raw.clarifications)) {
    for (const item of raw.clarifications.slice(0, 40)) {
      if (!isRecord(item) || typeof item.question !== "string") continue;
      const question = item.question.trim().slice(0, 500);
      if (!question) continue;
      clarifications.push({
        ...(typeof item.id === "string" && item.id.trim() ? { id: item.id.trim().slice(0, 64) } : {}),
        question,
        ...(typeof item.answer === "string" && item.answer.trim()
          ? { answer: item.answer.trim().slice(0, MAX_FEEDBACK_LENGTH) }
          : {}),
      });
    }
  }
  const markdown = typeof raw.raw === "string" ? raw.raw.slice(0, 200_000) : undefined;
  return {
    planId: raw.planId,
    title,
    ...(typeof raw.goal === "string" ? { goal: raw.goal.trim().slice(0, 2_000) } : {}),
    files,
    risks,
    steps,
    ...(clarifications.length > 0 ? { clarifications } : {}),
    ...(markdown !== undefined ? { raw: markdown } : {}),
  };
}

/**
 * 校验来自 Webview 的消息。Webview 不受信任：结构、类型和长度都必须显式检查，
 * 校验失败一律丢弃，绝不透传未知字段。
 */
export function parseWebviewMessage(raw: unknown): WebviewToHostMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;

  switch (raw.type) {
    case "ready":
    case "stop":
    case "newSession":
    case "openHistory":
    case "showLogs":
    case "reconnect":
    case "approvePlan":
    case "rejectPlan":
    case "askIntentOverride":
    case "addCurrentFile":
    case "addSelection":
    case "pickFiles":
    case "pickFolder":
    case "addTerminalOutput":
    case "addDiagnostics":
    case "clearContext":
    case "openComposerMenu":
    case "compactContext":
    case "requestUsageDetail":
    case "openAgentPanel":
    case "openModelSettings":
    case "openExtensions":
    case "openSettings":
    case "openFolder":
    case "startPlanBuild":
    case "pausePlanBuild":
    case "resumePlanBuild":
    case "discardPlanEdits":
    case "confirmDebugFix":
      return { type: raw.type } as WebviewToHostMessage;
    case "setupAction": {
      if (!isSetupActionId(raw.action)) return undefined;
      return { type: "setupAction", action: raw.action };
    }
    case "loadSession":
    case "deleteSession":
    case "pinSession":
    case "archiveSession":
    case "openSessionMenu": {
      if (!isSafeId(raw.sessionId)) return undefined;
      return { type: raw.type, sessionId: raw.sessionId };
    }
    case "searchSessions": {
      if (typeof raw.query !== "string") return undefined;
      return { type: "searchSessions", query: raw.query.trim().slice(0, 120) };
    }
    case "switchWorkspace":
    case "removeWorkspace": {
      // 只接受从宿主自己发下去的那份列表里的路径长度量级；真正的存在性校验在宿主侧。
      if (typeof raw.path !== "string") return undefined;
      const target = raw.path.trim();
      if (target === "" || target.length > 4_000) return undefined;
      return { type: raw.type, path: target };
    }
    case "openExternalUrl": {
      if (typeof raw.url !== "string") return undefined;
      const url = raw.url.trim();
      if (!/^https?:\/\//i.test(url) || url.length > 2_000) return undefined;
      return { type: "openExternalUrl", url };
    }
    case "listWorkspaceFiles": {
      if (raw.query !== undefined && typeof raw.query !== "string") return undefined;
      return {
        type: "listWorkspaceFiles",
        ...(typeof raw.query === "string" ? { query: raw.query.trim().slice(0, 120) } : {}),
      };
    }
    case "openWorkspaceFile": {
      if (typeof raw.relativePath !== "string") return undefined;
      const relativePath = raw.relativePath.trim().replace(/\\/g, "/");
      if (
        relativePath.length === 0
        || relativePath.length > 500
        || relativePath.startsWith("/")
        || relativePath.includes("..")
        || /^[A-Za-z]:/.test(relativePath)
      ) {
        return undefined;
      }
      const line = typeof raw.line === "number" && Number.isInteger(raw.line) && raw.line > 0
        ? Math.min(raw.line, 1_000_000)
        : undefined;
      return { type: "openWorkspaceFile", relativePath, ...(line ? { line } : {}) };
    }
    case "addImageContext": {
      if (typeof raw.dataUrl !== "string" || typeof raw.name !== "string") return undefined;
      // 只认 data:image/*;base64；别的一律丢弃。
      if (!/^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(raw.dataUrl)) {
        return undefined;
      }
      // 长度按 base64 折算回字节再比，跟 ImageStore 用的是同一个上限。
      // 从前这里写 8MB 而落盘那侧复用了 200KB 的文件上限，宣称与实际差了 40 倍。
      if (raw.dataUrl.length > Math.ceil(IMAGE_LIMITS.bytes / 3) * 4 + 64) return undefined;
      const name = raw.name.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
      return { type: "addImageContext", name: name || "pasted-image", dataUrl: raw.dataUrl };
    }
    case "addDroppedUris": {
      if (!Array.isArray(raw.uris)) return undefined;
      const uris = raw.uris
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 2_048 && /^file:\/\//i.test(item));
      if (uris.length === 0 || uris.length > 20) return undefined;
      return { type: "addDroppedUris", uris };
    }
    case "addDroppedFile": {
      if (typeof raw.name !== "string" || typeof raw.content !== "string") return undefined;
      // 只留文件名本身：拖放源给不出可信路径，带路径形态的名字一律当可疑输入拍掉。
      const name = raw.name.trim().replace(/^.*[\\/]/, "").slice(0, 120);
      if (!name) return undefined;
      // 上限对齐单文件上下文（200KB）再留些余量；超出的在 Webview 侧就该拦下。
      if (raw.content.length > 400_000) return undefined;
      return { type: "addDroppedFile", name, content: raw.content };
    }
    case "openNativeTerminal":
      return { type: "openNativeTerminal" };
    case "openSimpleBrowser": {
      if (raw.url !== undefined && typeof raw.url !== "string") return undefined;
      if (typeof raw.url === "string") {
        const url = raw.url.trim();
        if (!/^https?:\/\//i.test(url) || url.length > 2_000) return undefined;
        return { type: "openSimpleBrowser", url };
      }
      return { type: "openSimpleBrowser" };
    }
    case "renameSession": {
      if (!isSafeId(raw.sessionId) || typeof raw.title !== "string") return undefined;
      const title = raw.title.trim();
      if (title.length === 0 || title.length > MAX_SESSION_TITLE_LENGTH) return undefined;
      return { type: "renameSession", sessionId: raw.sessionId, title };
    }
    case "removeContext":
    case "showContext": {
      if (!isSafeId(raw.id)) return undefined;
      return { type: raw.type, id: raw.id };
    }
    case "contextSuggestQuery": {
      if (typeof raw.query !== "string") return undefined;
      return { type: "contextSuggestQuery", query: raw.query.slice(0, SUGGEST_QUERY_MAX) };
    }
    case "contextSuggestSelect": {
      // candidateId 必须是宿主下发的 opaque id；任何路径形态都过不了 isSafeId。
      if (!isSafeId(raw.candidateId)) return undefined;
      if (typeof raw.sourceType !== "string") return undefined;
      if (!(CANDIDATE_SOURCES as readonly string[]).includes(raw.sourceType)) return undefined;
      return {
        type: "contextSuggestSelect",
        candidateId: raw.candidateId,
        sourceType: raw.sourceType as CandidateSource,
      };
    }
    case "openDiff":
    case "requestChangeDiff":
    case "acceptChange":
    case "rejectChange":
    case "showConflict": {
      if (!isSafeId(raw.changeId)) return undefined;
      return { type: raw.type, changeId: raw.changeId };
    }
    case "hunkAction": {
      if (!isSafeId(raw.changeId) || !isSafeId(raw.hunkId)) return undefined;
      if (raw.action !== "accept" && raw.action !== "reject") return undefined;
      return { type: "hunkAction", changeId: raw.changeId, hunkId: raw.hunkId, action: raw.action };
    }
    case "acceptAll":
    case "rejectAll":
    case "undoTurn": {
      if (!isSafeId(raw.turnId)) return undefined;
      return { type: raw.type, turnId: raw.turnId };
    }
    case "showBackgroundTaskOutput":
    case "killBackgroundTask": {
      if (!isSafeId(raw.taskId)) return undefined;
      return { type: raw.type, taskId: raw.taskId };
    }
    case "sendPrompt": {
      if (typeof raw.text !== "string") return undefined;
      const text = raw.text.trim();
      if (text.length === 0 || text.length > MAX_PROMPT_LENGTH) return undefined;
      // 认不出来的 mode 直接丢掉整条消息：默默按当前模式发出去，
      // 等于用户以为在 Plan 里问的问题被 Agent 直接动手改了。
      if (raw.mode !== undefined && !isAgentMode(raw.mode)) return undefined;
      return { type: "sendPrompt", text, ...(raw.mode ? { mode: raw.mode } : {}) };
    }
    case "revisePlan": {
      if (typeof raw.feedback !== "string") return undefined;
      const feedback = raw.feedback.trim();
      if (feedback.length === 0 || feedback.length > MAX_FEEDBACK_LENGTH) return undefined;
      return { type: "revisePlan", feedback };
    }
    case "permissionDecision": {
      if (!isValidRequestId(raw.requestId)) return undefined;
      if (!isPermissionDecision(raw.decision)) return undefined;
      return { type: "permissionDecision", requestId: raw.requestId, decision: raw.decision };
    }
    case "answerQuestion": {
      if (!isValidRequestId(raw.requestId)) return undefined;
      if (!Array.isArray(raw.answers)) return undefined;
      if (raw.answers.length === 0 || raw.answers.length > MAX_QUESTIONS_PER_ASK) return undefined;
      if (raw.answers.some((item) => typeof item !== "string")) return undefined;
      // 空字符串保留：答案与问题按下标对齐，跳过的题不能把后面的顶上来。
      const answers = (raw.answers as string[]).map((item) => item.trim().slice(0, MAX_ANSWER_LENGTH));
      return { type: "answerQuestion", requestId: raw.requestId, answers };
    }
    case "setMode": {
      if (!isAgentMode(raw.mode)) return undefined;
      return { type: "setMode", mode: raw.mode };
    }
    case "selectModel": {
      if (typeof raw.modelId !== "string") return undefined;
      const modelId = raw.modelId.trim();
      if (!isModelId(modelId)) return undefined;
      return { type: "selectModel", modelId };
    }
    case "savePlanEdits": {
      if (!isRecord(raw.plan)) return undefined;
      const plan = parsePlanEdit(raw.plan);
      if (!plan) return undefined;
      return { type: "savePlanEdits", plan };
    }
    case "addPlanStep": {
      if (typeof raw.title !== "string") return undefined;
      const title = raw.title.trim();
      if (title.length === 0 || title.length > 200) return undefined;
      return {
        type: "addPlanStep",
        title,
        ...(typeof raw.description === "string" && raw.description.trim()
          ? { description: raw.description.trim().slice(0, 2_000) }
          : {}),
      };
    }
    case "removePlanStep": {
      if (!isSafeId(raw.stepId)) return undefined;
      return { type: "removePlanStep", stepId: raw.stepId };
    }
    case "updatePlanStep": {
      if (!isSafeId(raw.stepId) || typeof raw.title !== "string") return undefined;
      const title = raw.title.trim().slice(0, 200);
      if (!title) return undefined;
      // 文件列表与计划正文用同一套约束：只收工作区相对路径，绝对盘符一律丢掉。
      const files = raw.files === undefined
        ? undefined
        : (parseStringList(raw.files, 80) ?? []).filter(isRelativePlanPath);
      return {
        type: "updatePlanStep",
        stepId: raw.stepId,
        title,
        ...(typeof raw.description === "string"
          ? { description: raw.description.trim().slice(0, 2_000) }
          : {}),
        ...(files ? { files } : {}),
      };
    }
    case "setPlanStepIncluded": {
      if (!isSafeId(raw.stepId) || typeof raw.included !== "boolean") return undefined;
      return { type: "setPlanStepIncluded", stepId: raw.stepId, included: raw.included };
    }
    case "reorderPlanSteps": {
      const stepIds = parseStringList(raw.stepIds, 80);
      if (!stepIds || stepIds.some((id) => !isSafeId(id))) return undefined;
      return { type: "reorderPlanSteps", stepIds };
    }
    case "answerClarification": {
      if (!isSafeId(raw.clarificationId) || typeof raw.answer !== "string") return undefined;
      const answer = raw.answer.trim();
      if (answer.length === 0 || answer.length > MAX_FEEDBACK_LENGTH) return undefined;
      return { type: "answerClarification", clarificationId: raw.clarificationId, answer };
    }
    case "queueEdit": {
      if (!isSafeId(raw.id) || typeof raw.text !== "string") return undefined;
      const text = raw.text.trim();
      if (text.length === 0 || text.length > MAX_PROMPT_LENGTH) return undefined;
      return { type: "queueEdit", id: raw.id, text };
    }
    case "queueReorder": {
      const orderedIds = Array.isArray(raw.orderedIds)
        ? raw.orderedIds.filter((item): item is string => isSafeId(item))
        : [];
      // 允许的最长队列就 SEND_QUEUE_LIMIT，多出来或形态不对一律拒收整条消息。
      if (orderedIds.length === 0 || orderedIds.length > 64) return undefined;
      if (orderedIds.length !== new Set(orderedIds).size) return undefined;
      return { type: "queueReorder", orderedIds };
    }
    case "queueRemove":
    case "queueFlush": {
      if (!isSafeId(raw.id)) return undefined;
      return { type: raw.type, id: raw.id };
    }
    default:
      return undefined;
  }
}
