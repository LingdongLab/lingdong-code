import type { AgentRuntimeHandle, SafetyDecision } from "@lingdong/agent-runtime";
import type {
  HostToWebviewMessage,
  PermissionCardView,
  UiPermissionDecision,
} from "../messages";
import { PermissionQueue } from "../permission-queue";
import type { UiStateMachine } from "../ui-state";
import { isInsideWorkspace } from "../workspace-guard";

/**
 * 权限卡片编排：入队、超时、回执与连续拒绝提示。
 * 不直接依赖 VS Code API，超时时长由宿主以回调形式注入，便于单测。
 */

export const REPEAT_REJECTION_THRESHOLD = 2;

interface PendingCard {
  card: PermissionCardView;
  fingerprint: string;
}

export interface PermissionFacadeDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  postState(detail?: string): void;
  readonly ui: UiStateMachine;
  runtime(): AgentRuntimeHandle | undefined;
  workspaceRoot(): string | undefined;
  /** 单次权限等待的超时毫秒数。 */
  timeoutMs(): number;
  /** 「以后都允许」是否有落盘存储；没有就不展示这个按钮，避免承诺记不住的事。 */
  canRememberRules(): boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PermissionFacade {
  private readonly queue = new PermissionQueue<PendingCard>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly rejections = new Map<string, number>();
  /** 本轮内 requestId → 操作类型，用于统计被拒的执行类操作。 */
  private readonly operations = new Map<string, string>();
  private rejectedExecute = false;
  /**
   * 已经推给面板的队首 id。
   *
   * 自动放行与自动拒绝也会走 handleResolved，但它们从没入过队；那种结算不该
   * 把当前这张卡再推一遍。面板那边一推就是一张新卡，同一条命令并排出现两次。
   */
  private publishedRequestId: string | undefined;

  constructor(private readonly deps: PermissionFacadeDeps) {}

  /** 本轮是否出现过被拒绝的执行类操作，用于标记验证状态。 */
  get turnRejectedExecute(): boolean {
    return this.rejectedExecute;
  }

  get current(): { requestId: string; item: PendingCard } | undefined {
    return this.queue.current;
  }

  get waiting(): number {
    return this.queue.waiting;
  }

  /** 新一轮开始时清空本轮统计，但不动仍在排队的卡片。 */
  resetTurnStats(): void {
    this.operations.clear();
    this.rejectedExecute = false;
  }

  noteOperation(requestId: string, operation: string): void {
    this.operations.set(requestId, operation);
  }

  handleRequested(requestId: string, decision: SafetyDecision, label: string): void {
    const runtime = this.deps.runtime();
    if (!runtime) return;

    // 宿主二次校验：Runtime 已判过一次工作区边界，这里再判一次，任何越界一律拒绝。
    const root = this.deps.workspaceRoot();
    const outside = root
      ? decision.targets.find((target) => !isInsideWorkspace(root, target))
      : undefined;
    if (outside) {
      this.deps.log(`[permission] 目标越界，直接拒绝：${outside}`);
      void runtime.respondPermission(requestId, "reject").catch((error: unknown) => {
        this.deps.log(`[permission] 拒绝失败：${errorText(error)}`);
      });
      this.deps.post({ type: "notice", level: "warn", message: `已拒绝越界操作：${outside}` });
      return;
    }

    const rememberable = decision.risk === "low" || decision.risk === "medium";
    const card: PermissionCardView = {
      requestId,
      title: label,
      operation: decision.operation,
      steps: decision.explanation.steps.map((step) => ({ ...step })),
      notes: [...decision.explanation.notes],
      risk: decision.risk,
      allowSession: rememberable,
      allowAlways: rememberable && this.deps.canRememberRules(),
      ...(decision.target ? { target: decision.target } : {}),
      ...(decision.command ? { command: decision.command } : {}),
      ...(decision.cwd ? { cwd: decision.cwd } : {}),
      ...(decision.intent ? { intent: decision.intent } : {}),
    };
    if (!this.queue.enqueue(requestId, { card, fingerprint: decision.fingerprint })) {
      this.deps.log(`[permission] 忽略重复或已处理的权限请求：${requestId}`);
      return;
    }

    this.startTimer(requestId);
    if (this.queue.current?.requestId === requestId) {
      this.publish(card, requestId);
      this.deps.ui.transition("waiting_permission");
      this.deps.postState();
    }
  }

  handleResolved(
    requestId: string,
    resolution: "allow_once" | "allow_session" | "allow_always" | "reject" | "expired" | "cancelled",
  ): void {
    this.clearTimer(requestId);
    const operation = this.operations.get(requestId);
    this.operations.delete(requestId);
    if (operation === "execute" && (resolution === "reject" || resolution === "expired")) {
      this.rejectedExecute = true;
    }
    const wasCurrent = this.queue.current?.requestId === requestId;
    if (this.queue.has(requestId)) this.queue.expire(requestId);
    this.deps.post({
      type: "permissionResolved",
      requestId,
      resolution,
      message: resolutionText(resolution),
      waiting: this.queue.waiting,
    });
    if (wasCurrent || this.deps.ui.state === "waiting_permission") this.advance();
  }

  async respond(requestId: string, decision: UiPermissionDecision): Promise<void> {
    if (!this.deps.ui.canRespondPermission) {
      this.deps.log(`[permission] 状态 ${this.deps.ui.state} 下拒绝处理权限回执 ${requestId}`);
      return;
    }
    const current = this.queue.current;
    if (!current || current.requestId !== requestId) {
      this.deps.post({ type: "notice", level: "warn", message: "该权限请求已失效。" });
      return;
    }
    if (decision === "allow_session" && !current.item.card.allowSession) {
      this.deps.post({ type: "notice", level: "warn", message: "该操作风险过高，不能加入本次会话规则。" });
      return;
    }
    if (decision === "allow_always" && !current.item.card.allowAlways) {
      this.deps.post({ type: "notice", level: "warn", message: "该操作不能记为「以后都允许」。" });
      return;
    }
    const runtime = this.deps.runtime();
    if (!runtime) return;

    this.clearTimer(requestId);
    this.queue.resolve(requestId);
    try {
      await runtime.respondPermission(requestId, decision);
    } catch (error) {
      this.deps.post({ type: "error", message: `权限回执失败：${errorText(error)}`, recoverable: true });
      this.advance();
    }
    if (decision === "reject") this.noteRejection(current.item.fingerprint);
  }

  /**
   * 面板重新挂载时补推当前卡片。
   * 这里刻意不看 publishedRequestId：新挂载的面板是空的，必须重发一次。
   * 面板保留了 DOM 的情况由它自己按 requestId 去重。
   */
  republishCurrent(): void {
    const current = this.queue.current;
    if (!current) return;
    this.publish(current.item.card, current.requestId);
  }

  clearCards(reason: string): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.publishedRequestId = undefined;
    for (const entry of this.queue.clear()) {
      this.deps.post({
        type: "permissionResolved",
        requestId: entry.requestId,
        resolution: "cancelled",
        message: reason,
        waiting: 0,
      });
    }
    this.deps.runtime()?.clearPending(reason);
  }

  clearRejectionHistory(): void {
    this.rejections.clear();
  }

  private advance(): void {
    const next = this.queue.current;
    if (next) {
      // 队首没变说明这次结算跟当前这张卡无关，别再推一遍。
      if (next.requestId !== this.publishedRequestId) this.publish(next.item.card, next.requestId);
      this.deps.ui.transition("waiting_permission");
    } else {
      this.publishedRequestId = undefined;
      if (this.deps.ui.state === "waiting_permission") this.deps.ui.transition("streaming");
    }
    this.deps.postState();
  }

  private publish(card: PermissionCardView, requestId: string): void {
    this.publishedRequestId = requestId;
    this.deps.post({ type: "permission", card, waiting: this.queue.waiting });
  }

  private noteRejection(fingerprint: string): void {
    const count = (this.rejections.get(fingerprint) ?? 0) + 1;
    this.rejections.set(fingerprint, count);
    if (count < REPEAT_REJECTION_THRESHOLD) return;
    this.deps.post({
      type: "notice",
      level: "info",
      message: "同一操作已被连续拒绝多次。可以换用更明确的任务描述，或切换到 Plan 模式先确认方案。",
    });
  }

  private startTimer(requestId: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(requestId);
      const entry = this.queue.expire(requestId);
      if (!entry) return;
      this.deps.post({
        type: "permissionResolved",
        requestId,
        resolution: "expired",
        message: "等待超时，已自动拒绝该操作。",
        waiting: this.queue.waiting,
      });
      void this.deps.runtime()?.respondPermission(requestId, "reject").catch((error: unknown) => {
        this.deps.log(`[permission] 超时拒绝失败：${errorText(error)}`);
      });
      this.advance();
    }, this.deps.timeoutMs());
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(requestId, timer);
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(requestId);
  }
}

export function resolutionText(resolution: string): string {
  switch (resolution) {
    case "allow_once": return "已允许本次";
    case "allow_session": return "已加入本次会话规则";
    case "allow_always": return "已记住，以后不再询问";
    case "reject": return "已拒绝";
    case "expired": return "已超时失效";
    default: return "已取消";
  }
}
