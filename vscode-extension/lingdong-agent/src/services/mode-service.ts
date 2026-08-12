import type { AgentRuntimeHandle } from "@lingdong/agent-runtime";
import type { HostToWebviewMessage, UiAgentMode } from "../messages";
import { toRuntimeMode } from "../messages";
import type { UiStateMachine } from "../ui-state";
import type { AgentWorkspaceStore } from "../workspace-store";
import type { TurnState } from "./turn-state";

/**
 * 工作模式的唯一权威来源：本地模式、待切换模式与 Debug 阶段。
 * 执行中切换请求会被挂起到本轮结束，Runtime 回写失败则整体回退，
 * 避免 UI 显示的模式与 Grok 实际模式不一致。
 */

export interface ModeServiceDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  readonly ui: UiStateMachine;
  readonly store: AgentWorkspaceStore;
  readonly turn: TurnState;
  runtime(): AgentRuntimeHandle | undefined;
  /** 模式变化会影响 Composer 的能力提示。 */
  pushComposerStatus(): void;
  /** 当前模型是否通过了工具调用检测；未通过的只允许 Ask。 */
  agentCompatible(): boolean;
  currentModelName(): string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 默认 Agent 而非 Ask：Ask 会硬拒所有写操作、并对每条命令弹窗，
 * 用户拿到的第一印象是「什么都做不了还一直问」。未通过工具调用检测的模型
 * 仍会被 enforceAskOnly 降级回 Ask。
 */
const DEFAULT_MODE: UiAgentMode = "agent";

export class ModeService {
  private modeValue: UiAgentMode = DEFAULT_MODE;
  private pendingValue: UiAgentMode | undefined;

  constructor(private readonly deps: ModeServiceDeps) {}

  get current(): UiAgentMode { return this.modeValue; }
  get pending(): UiAgentMode | undefined { return this.pendingValue; }

  /** 恢复会话或批准计划时直接落定模式，不再回写 Runtime。 */
  force(mode: UiAgentMode): void { this.modeValue = mode; }

  publish(serverMode?: string): void {
    const server = serverMode ?? this.deps.runtime()?.serverMode;
    const askOnly = !this.deps.agentCompatible();
    this.deps.post({
      type: "modeState",
      mode: this.modeValue,
      canSwitch: this.deps.ui.canSwitchMode,
      ...(server ? { serverMode: server } : {}),
      ...(this.pendingValue ? { pending: this.pendingValue } : {}),
      ...(this.deps.ui.canSwitchMode ? {} : { reason: "任务执行中不能切换模式" }),
      // 带上原因，界面才能在禁用 Plan / Agent 的同时说明为什么，
      // 而不是让用户面对一个没有解释的灰按钮。
      ...(askOnly
        ? {
          askOnly: true,
          askOnlyReason: `${this.deps.currentModelName()} 未通过工具调用检测，目前仅支持 Ask 模式。`,
        }
        : {}),
    });
  }

  /**
   * 模型换成仅 Ask 的那一刻主动降级。
   *
   * 不等用户切到 Agent 再拒绝：那时他已经写好了一个需要改文件的任务，
   * 拒绝的代价比提前降级高得多。
   *
   * 兼容性由调用方直接给出，不去读「当前模型」——切换过程中运行时与会话
   * 可能还指向上一个模型，读出来的会是旧值。
   */
  async enforceAskOnly(input: { modelName: string; agentCompatible: boolean }): Promise<void> {
    const { modelName, agentCompatible } = input;
    if (agentCompatible) {
      this.publish();
      return;
    }
    this.pendingValue = undefined;
    if (this.modeValue !== "ask") {
      await this.apply("ask");
      this.deps.post({
        type: "notice",
        level: "warn",
        message: `${modelName} 未通过工具调用检测，已切换到 Ask 模式。`,
      });
      return;
    }
    this.publish();
  }

  async set(mode: UiAgentMode): Promise<void> {
    if (mode === this.modeValue && !this.pendingValue) {
      this.publish();
      return;
    }
    // 没通过工具调用检测的模型进不了 Ask 以外的模式：它无法真正执行工具，
    // 放进去只会得到一个看起来在干活、实际什么都没做的轮次。
    if (mode !== "ask" && !this.deps.agentCompatible()) {
      this.deps.post({
        type: "notice",
        level: "warn",
        message: `${this.deps.currentModelName()} 尚未通过工具调用测试，目前仅支持 Ask 模式。`,
      });
      this.publish();
      return;
    }
    if (!this.deps.ui.canSwitchMode) {
      this.pendingValue = mode;
      this.deps.post({
        type: "notice",
        level: "info",
        message: `任务执行中不能切换模式，将在本轮结束后切换到 ${mode}。`,
      });
      this.publish();
      return;
    }
    await this.apply(mode);
  }

  /** 本轮结束后补做被挂起的切换。 */
  async applyPending(): Promise<void> {
    const pending = this.pendingValue;
    if (!pending) return;
    this.pendingValue = undefined;
    if (pending === this.modeValue) {
      this.publish();
      return;
    }
    await this.apply(pending);
  }

  handleRuntimeModeChanged(mode: string, source: "server" | "client"): void {
    this.deps.log(`[mode] ${source === "server" ? "Grok" : "客户端"} 模式：${mode}`);
    // Debug 在 Runtime 侧映射为 ask，不能用客户端回写覆盖 UI 模式。
    if (
      source === "client"
      && this.modeValue !== "debug"
      && (mode === "ask" || mode === "plan" || mode === "agent" || mode === "auto")
    ) {
      this.modeValue = mode;
      this.deps.store.patchRuntime({ mode });
    }
    this.publish(source === "server" ? mode : undefined);
  }

  private async apply(mode: UiAgentMode): Promise<void> {
    const previous = this.modeValue;
    this.modeValue = mode;
    this.pendingValue = undefined;
    this.syncDebugPhase(mode, previous);
    this.announce(mode);
    if (mode === "plan" && previous !== "plan") {
      this.deps.post({
        type: "notice",
        level: "info",
        message: "Plan 模式：将使用宿主只读能力研究项目，不会执行 Get-ChildItem / dir / ls 列目录。",
      });
    }
    const runtime = this.deps.runtime();
    if (!runtime?.sessionId) return;
    try {
      await runtime.setMode(toRuntimeMode(mode));
    } catch (error) {
      this.modeValue = previous;
      this.deps.post({
        type: "error",
        message: `切换模式失败，已回退到 ${previous}：${errorText(error)}`,
        recoverable: true,
      });
      this.announce(previous);
    }
  }

  private announce(mode: UiAgentMode): void {
    this.deps.post({ type: "mode", mode });
    this.publish();
    this.deps.store.patchRuntime({ mode });
    this.deps.pushComposerStatus();
  }

  /** 进入 Debug 时回到只读收集阶段，离开时清掉授权标记。 */
  private syncDebugPhase(mode: UiAgentMode, previous: UiAgentMode): void {
    if (mode === "debug") {
      const phase = this.deps.turn.debugPhase === "idle" ? "collect" : this.deps.turn.debugPhase;
      this.deps.turn.debugPhase = phase;
      this.deps.store.setDebugArmed(false);
      this.deps.post({ type: "debugState", phase, message: "Debug 模式：初始阶段只读。" });
      return;
    }
    if (previous === "debug") {
      this.deps.turn.debugPhase = "idle";
      this.deps.store.setDebugArmed(false);
      this.deps.post({ type: "debugState", phase: "idle" });
    }
  }
}
