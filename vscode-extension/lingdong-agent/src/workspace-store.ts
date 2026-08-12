import { EventEmitter } from "node:events";
import type { ChangeListView } from "./change-view";
import type { ContextUsageLevel, ContextUsageRecord, CompactionCapability, UsageBreakdown } from "./context-usage";
import type { ContextItemView, UiAgentMode } from "./messages";
import type { ModelDescriptor } from "./model-registry";
import type { PlanRecord } from "./storage/plan-repository";
import type { SessionRecord } from "./storage/session-repository";
import type { UiState } from "./ui-state";

/**
 * 三栏 Agent IDE 的共享状态源。
 * TreeView / 主面板 / 右侧面板只订阅这里，禁止各自再缓存一套 Plan/Changes。
 */

export type WorkspacePartition =
  | "session"
  | "plan"
  | "changes"
  | "context"
  | "usage"
  | "runtime"
  | "tasks";

export type ConnectionState = "idle" | "starting" | "ready" | "failed";

export interface RuntimeSnapshot {
  mode: UiAgentMode;
  model: string;
  connection: ConnectionState;
  connectionDetail?: string;
  uiState: UiState;
  busy: boolean;
  canSend: boolean;
  canCancel: boolean;
  canSwitchMode: boolean;
  canApplyChanges: boolean;
  canRestoreChanges: boolean;
  compactCapability: CompactionCapability;
  compactBusy: boolean;
  serverMode?: string;
  pendingMode?: UiAgentMode;
}

export interface WorkspaceSnapshot {
  activeSession?: SessionRecord;
  sessions: SessionRecord[];
  sessionQuery: string;
  activePlan?: PlanRecord;
  changes?: ChangeListView;
  contextItems: ContextItemView[];
  usage: ContextUsageRecord;
  usageLevel: ContextUsageLevel;
  usageBreakdown?: UsageBreakdown;
  models: ModelDescriptor[];
  runtime: RuntimeSnapshot;
  layoutFallback: boolean;
  layoutFallbackReason?: string;
  debugArmed: boolean;
}

const DEFAULT_USAGE: ContextUsageRecord = {
  usedTokens: 0,
  source: "unavailable",
  updatedAt: 0,
};

const DEFAULT_RUNTIME: RuntimeSnapshot = {
  mode: "ask",
  model: "deepseek-v4-flash",
  connection: "idle",
  uiState: "idle",
  busy: false,
  canSend: true,
  canCancel: false,
  canSwitchMode: true,
  canApplyChanges: false,
  canRestoreChanges: false,
  compactCapability: "unknown",
  compactBusy: false,
};

export declare interface AgentWorkspaceStore {
  on(event: "change", listener: (partitions: readonly WorkspacePartition[]) => void): this;
  off(event: "change", listener: (partitions: readonly WorkspacePartition[]) => void): this;
  emit(event: "change", partitions: readonly WorkspacePartition[]): boolean;
}

export class AgentWorkspaceStore extends EventEmitter {
  private state: WorkspaceSnapshot = {
    sessions: [],
    sessionQuery: "",
    contextItems: [],
    usage: { ...DEFAULT_USAGE },
    usageLevel: "normal",
    models: [],
    runtime: { ...DEFAULT_RUNTIME },
    layoutFallback: false,
    debugArmed: false,
  };

  get snapshot(): WorkspaceSnapshot {
    return {
      ...this.state,
      sessions: [...this.state.sessions],
      contextItems: [...this.state.contextItems],
      models: [...this.state.models],
      usage: { ...this.state.usage },
      runtime: { ...this.state.runtime },
      ...(this.state.activeSession ? { activeSession: { ...this.state.activeSession } } : {}),
      ...(this.state.activePlan ? { activePlan: structuredClone(this.state.activePlan) } : {}),
      ...(this.state.changes ? { changes: this.state.changes } : {}),
      ...(this.state.usageBreakdown ? { usageBreakdown: { ...this.state.usageBreakdown } } : {}),
      ...(this.state.layoutFallbackReason ? { layoutFallbackReason: this.state.layoutFallbackReason } : {}),
    };
  }

  patch(partial: Partial<WorkspaceSnapshot>, partitions: readonly WorkspacePartition[]): void {
    this.state = {
      ...this.state,
      ...partial,
      runtime: partial.runtime ? { ...this.state.runtime, ...partial.runtime } : this.state.runtime,
      usage: partial.usage ? { ...partial.usage } : this.state.usage,
    };
    if (partitions.length > 0) this.emit("change", partitions);
  }

  patchRuntime(partial: Partial<RuntimeSnapshot>): void {
    this.patch({ runtime: { ...this.state.runtime, ...partial } }, ["runtime"]);
  }

  setSessions(sessions: SessionRecord[], query = this.state.sessionQuery): void {
    this.patch({ sessions, sessionQuery: query }, ["session"]);
  }

  setActiveSession(session: SessionRecord | undefined): void {
    if (session) this.state.activeSession = session;
    else delete this.state.activeSession;
    this.emit("change", ["session"]);
  }

  setActivePlan(plan: PlanRecord | undefined): void {
    if (plan) this.state.activePlan = plan;
    else delete this.state.activePlan;
    this.emit("change", ["plan", "tasks"]);
  }

  setChanges(view: ChangeListView | undefined): void {
    if (view) this.state.changes = view;
    else delete this.state.changes;
    this.emit("change", ["changes"]);
  }

  setContextItems(items: ContextItemView[]): void {
    this.patch({ contextItems: items }, ["context"]);
  }

  setUsage(
    usage: ContextUsageRecord,
    level: ContextUsageLevel,
    breakdown?: UsageBreakdown,
  ): void {
    this.state.usage = { ...usage };
    this.state.usageLevel = level;
    if (breakdown) this.state.usageBreakdown = { ...breakdown };
    else delete this.state.usageBreakdown;
    this.emit("change", ["usage"]);
  }

  setModels(models: ModelDescriptor[]): void {
    this.patch({ models }, ["runtime"]);
  }

  setLayoutFallback(fallback: boolean, reason?: string): void {
    this.state.layoutFallback = fallback;
    if (reason) this.state.layoutFallbackReason = reason;
    else delete this.state.layoutFallbackReason;
    this.emit("change", ["runtime"]);
  }

  setDebugArmed(armed: boolean): void {
    this.patch({ debugArmed: armed }, ["runtime"]);
  }
}
