export type UiState =
  | "idle"
  | "initializing"
  | "ready"
  | "sending"
  | "streaming"
  | "waiting_permission"
  | "waiting_plan_approval"
  | "waiting_question"
  | "cancelling"
  | "completed"
  | "reviewing_changes"
  | "restoring_changes"
  | "conflict"
  | "error"
  | "disposed";

const TRANSITIONS: Record<UiState, readonly UiState[]> = {
  idle: ["initializing", "error", "disposed"],
  initializing: ["ready", "error", "idle", "disposed"],
  ready: ["sending", "initializing", "idle", "reviewing_changes", "error", "disposed"],
  sending: ["streaming", "waiting_permission", "waiting_plan_approval", "waiting_question", "cancelling", "completed", "error", "disposed"],
  streaming: ["streaming", "waiting_permission", "waiting_plan_approval", "waiting_question", "cancelling", "completed", "error", "disposed"],
  waiting_permission: ["streaming", "waiting_permission", "waiting_plan_approval", "waiting_question", "cancelling", "completed", "error", "disposed"],
  waiting_plan_approval: ["streaming", "waiting_permission", "waiting_question", "cancelling", "completed", "error", "disposed"],
  // 模型提问：Grok 阻塞在工具调用上等待答案，用户仍可取消整轮。
  waiting_question: ["streaming", "waiting_permission", "waiting_plan_approval", "cancelling", "completed", "error", "disposed"],
  cancelling: ["completed", "ready", "reviewing_changes", "error", "disposed"],
  completed: ["ready", "sending", "initializing", "idle", "reviewing_changes", "error", "disposed"],
  reviewing_changes: [
    "sending", "restoring_changes", "conflict", "reviewing_changes", "ready", "completed",
    "initializing", "idle", "error", "disposed",
  ],
  restoring_changes: ["reviewing_changes", "conflict", "ready", "error", "disposed"],
  conflict: [
    "sending", "restoring_changes", "reviewing_changes", "ready", "initializing", "idle", "error", "disposed",
  ],
  error: ["initializing", "ready", "sending", "idle", "reviewing_changes", "disposed"],
  disposed: [],
};

/** 正在跑一轮任务的状态：这些状态下不能接受或拒绝变更。 */
const EXECUTING_STATES: ReadonlySet<UiState> = new Set<UiState>([
  "sending", "streaming", "waiting_permission", "waiting_plan_approval", "waiting_question", "cancelling",
]);

const BUSY_STATES: ReadonlySet<UiState> = new Set<UiState>([...EXECUTING_STATES, "restoring_changes"]);

const SENDABLE_STATES: ReadonlySet<UiState> = new Set<UiState>([
  "idle", "ready", "completed", "reviewing_changes", "conflict", "error",
]);

export interface UiStateSnapshot {
  state: UiState;
  busy: boolean;
  canSend: boolean;
  canCancel: boolean;
  canSwitchMode: boolean;
  canApprovePlan: boolean;
  canRespondPermission: boolean;
  canReviewChanges: boolean;
  canApplyChanges: boolean;
  canRestoreChanges: boolean;
}

/**
 * UI 状态机。所有来自 Webview 的操作在调用 Runtime 前都要先过这里的守卫，
 * Webview 自己的按钮禁用状态只是提示，不作为安全依据。
 */
export class UiStateMachine {
  private current: UiState = "idle";

  get state(): UiState {
    return this.current;
  }

  get busy(): boolean {
    return BUSY_STATES.has(this.current);
  }

  can(next: UiState): boolean {
    return TRANSITIONS[this.current].includes(next);
  }

  /** 非法迁移会被忽略并返回 false，避免异常事件顺序把 UI 带入错误状态。 */
  transition(next: UiState): boolean {
    if (this.current === next && next !== "streaming" && next !== "waiting_permission") return true;
    if (!this.can(next)) return false;
    this.current = next;
    return true;
  }

  force(next: UiState): void {
    this.current = next;
  }

  get canSend(): boolean {
    return SENDABLE_STATES.has(this.current);
  }

  get canCancel(): boolean {
    return EXECUTING_STATES.has(this.current) && this.current !== "cancelling";
  }

  get canSwitchMode(): boolean {
    return !BUSY_STATES.has(this.current) && this.current !== "disposed" && this.current !== "initializing";
  }

  get canApprovePlan(): boolean {
    return this.current === "waiting_plan_approval";
  }

  get canRespondPermission(): boolean {
    return this.current === "waiting_permission";
  }

  get canRespondQuestion(): boolean {
    return this.current === "waiting_question";
  }

  /** 查看变更与 Diff 是只读操作，等待权限时也允许。 */
  get canReviewChanges(): boolean {
    return this.current !== "disposed";
  }

  /** 接受或拒绝变更：任务执行中与恢复过程中都不允许。 */
  get canApplyChanges(): boolean {
    return !EXECUTING_STATES.has(this.current)
      && this.current !== "restoring_changes"
      && this.current !== "disposed";
  }

  /** 撤销本轮会先停止仍在执行的任务，因此执行中也允许；恢复过程中禁止重复触发。 */
  get canRestoreChanges(): boolean {
    return this.current !== "restoring_changes" && this.current !== "disposed";
  }

  snapshot(): UiStateSnapshot {
    return {
      state: this.current,
      busy: this.busy,
      canSend: this.canSend,
      canCancel: this.canCancel,
      canSwitchMode: this.canSwitchMode,
      canApprovePlan: this.canApprovePlan,
      canRespondPermission: this.canRespondPermission,
      canReviewChanges: this.canReviewChanges,
      canApplyChanges: this.canApplyChanges,
      canRestoreChanges: this.canRestoreChanges,
    };
  }
}
