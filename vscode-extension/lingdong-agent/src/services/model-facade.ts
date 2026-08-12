import * as vscode from "vscode";
import type { AgentRuntimeHandle } from "@lingdong/agent-runtime";
import type { HostToWebviewMessage, UiAgentMode } from "../messages";
import type { ModelRegistry } from "../model-registry";
import type { ModelSelection } from "../model-selection";
import type { SessionPersistence } from "../session-persistence";
import type { SessionRecord } from "../storage/session-repository";
import type { AgentWorkspaceStore } from "../workspace-store";
import type { ProviderService } from "./provider-service";

/**
 * 模型选择与 Composer 控制中心菜单。
 * 只列出已真实接入的模型，未配置的能力显式标注为不可用，不做假入口。
 */

export const FALLBACK_MODEL_ID = "deepseek-v4-flash";

export interface ModelFacadeDeps {
  post(message: HostToWebviewMessage): void;
  readonly store: AgentWorkspaceStore;
  readonly models: ModelRegistry;
  readonly providers: ProviderService;
  runtime(): AgentRuntimeHandle | undefined;
  persistence(): SessionPersistence | undefined;
  currentSession(): SessionRecord | undefined;
  setCurrentSession(record: SessionRecord): void;
  /** 上一次选择；没有会话记录时它就是唯一的依据。 */
  lastSelection(): ModelSelection | undefined;
  rememberSelection(selection: ModelSelection): Promise<void>;
  mode(): UiAgentMode;
  pushComposerStatus(): void;
  setMode(mode: UiAgentMode): Promise<void>;
  /** 任务执行中；此时换模型会让本轮的一半请求打到另一个服务商去。 */
  busy(): boolean;
  /** 切到仅 Ask 模型后主动降级并说明原因。 */
  enforceAskOnly(input: { modelName: string; agentCompatible: boolean }): Promise<void>;
  /** 目标模型不在启动快照内（会话中途新增）时的兜底：重启子进程重新载入。 */
  restartRuntime(): Promise<void>;
  /** Composer 菜单里的上下文动作。 */
  contextActions: {
    addCurrentFile(): Promise<void>;
    addSelection(): Promise<void>;
    pickFiles(): Promise<void>;
    pickFolder(): Promise<void>;
    addTerminalOutput(): void;
    addDiagnostics(): Promise<void>;
  };
  skillsConfigured(): boolean;
  mcpConfigured(): boolean;
  openExtensions(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ModelFacade {
  constructor(private readonly deps: ModelFacadeDeps) {}

  /** 当前生效的模型：运行时优先，其次会话记录，再次上一次选择，最后注册表首项。 */
  currentModelId(): string {
    return this.deps.runtime()?.model
      ?? this.deps.currentSession()?.modelId
      ?? this.deps.lastSelection()?.modelId
      ?? this.deps.models.list()[0]?.id
      ?? FALLBACK_MODEL_ID;
  }

  publish(): void {
    const selected = this.currentModelId();
    this.deps.store.setModels(this.deps.models.list());
    this.deps.store.patchRuntime({ model: selected });
    this.deps.post({
      type: "models",
      models: this.deps.models.list(),
      selected,
      capabilities: {
        skillsConfigured: this.deps.skillsConfigured(),
        mcpConfigured: this.deps.mcpConfigured(),
        // 只看当前这一个模型收不收图：粘贴放不放行是按当前模型决定的，
        // 「库里有别的视觉模型」（hasVisionModel）只够用来提示去哪儿切。
        imagesConfigured: this.deps.models.get(selected)?.supportsVision ?? false,
        autoSelectModels: this.deps.models.canAutoSelect(),
        hasVisionModel: this.deps.models.hasVisionModel(),
      },
    });
  }

  async select(modelId: string): Promise<void> {
    const model = this.deps.models.get(modelId);
    if (!model) {
      this.deps.post({ type: "notice", level: "warn", message: "未知模型，已忽略。" });
      this.publish();
      return;
    }
    // 执行中换模型意味着同一轮的前后半段发给不同服务商，凭据与上下文都对不上。
    if (this.deps.busy()) {
      this.deps.post({
        type: "notice",
        level: "warn",
        message: "任务执行中不能切换模型，请先等本轮结束或点停止。",
      });
      this.publish();
      return;
    }
    const runtime = this.deps.runtime();
    const previous = runtime?.model ?? this.deps.currentSession()?.modelId ?? modelId;
    // 没有会话记录时也要认得出「换了 Provider」，否则连着的子进程会继续用旧凭据。
    const previousProvider = this.deps.currentSession()?.providerId
      ?? this.deps.lastSelection()?.providerId;
    this.deps.store.patchRuntime({ model: modelId });
    // 先落地选择本身。会话记录可能还不存在（首次使用、上一个会话被删），
    // 这时它是启动解析唯一能读到的依据。
    await this.deps.rememberSelection({ providerId: model.providerId, modelId });
    this.publish();

    // 子进程启动时已注入全部已启用 Provider 的密钥、config.toml 也写全了模型，
    // 命中启动快照就走 session/set_model 免重连（对标 Cursor 秒切）；
    // 未命中（会话中途新加的 Provider/模型，子进程还不认识）才兜底重连。
    const hotSwappable = this.canHotSwap(model.providerId, modelId, previousProvider);

    if (!runtime?.sessionId || !hotSwappable) {
      await this.patchSessionModel(modelId, model.providerId);
      await this.deps.providers.writeConfig(modelId);
      if (!hotSwappable && runtime?.sessionId) {
        this.deps.post({
          type: "notice",
          level: "info",
          message: `正在切换到 ${model.provider} · ${model.displayName}：`
            + "该模型是本次连接之后新增的，需要重新连接一次载入。",
        });
        await this.deps.restartRuntime();
        await this.downgradeIfAskOnly(model);
        this.deps.pushComposerStatus();
        return;
      }
      this.deps.post({
        type: "notice",
        level: "info",
        message: `已选择模型 ${model.displayName}（将在连接后生效）。`,
      });
      await this.downgradeIfAskOnly(model);
      this.deps.pushComposerStatus();
      return;
    }

    try {
      await runtime.setModel(modelId);
      const patched = await this.patchSessionModel(modelId, model.providerId);
      if (patched) this.deps.store.setActiveSession(patched);
      await this.deps.providers.writeConfig(modelId);
      // setModel 之后 runtime.model 才是新值，重新发布一次让选择器立刻回显。
      this.publish();
      const title = this.deps.currentSession()?.title;
      this.deps.post({
        type: "session",
        sessionId: runtime.sessionId ?? "",
        model: modelId,
        mode: this.deps.mode(),
        ...(title ? { title } : {}),
      });
      this.deps.post({ type: "notice", level: "info", message: `模型已切换为 ${model.displayName}` });
      await this.downgradeIfAskOnly(model);
      this.deps.pushComposerStatus();
    } catch (error) {
      this.deps.store.patchRuntime({ model: previous });
      this.publish();
      // 回退到用户上一次自己选的模型，不是替他挑一个别的 Provider。
      this.deps.post({
        type: "error",
        message: `切换模型失败，仍在使用 ${previous}：${errorText(error)}`,
        recoverable: true,
      });
      this.deps.pushComposerStatus();
    }
  }

  /**
   * 目标模型能否免重连热切。
   * 有启动快照时按快照判定（密钥已注入 + 模型已在 config.toml）；
   * 没有快照（托管 GROK_HOME 关闭等）退回旧规则：同 Provider 热切、跨 Provider 重连。
   */
  private canHotSwap(providerId: string, modelId: string, previousProvider: string | undefined): boolean {
    const snapshot = this.deps.providers.launchSnapshot;
    if (snapshot) {
      return snapshot.providerIds.includes(providerId) && snapshot.modelIds.includes(modelId);
    }
    return previousProvider === undefined || previousProvider === providerId;
  }

  /** 选中仅 Ask 模型后立即降级；能力标记来自刚选中的这个模型，不读全局当前值。 */
  private async downgradeIfAskOnly(model: { displayName: string; agentCompatible: boolean }): Promise<void> {
    await this.deps.enforceAskOnly({
      modelName: model.displayName,
      agentCompatible: model.agentCompatible,
    });
  }

  private async patchSessionModel(modelId: string, providerId: string): Promise<SessionRecord | undefined> {
    const current = this.deps.currentSession();
    if (!current) return undefined;
    const patched = await this.deps.persistence()?.sessions.patch(current.id, { modelId, providerId });
    if (patched) this.deps.setCurrentSession(patched);
    return patched;
  }

  async openPicker(): Promise<void> {
    const items = this.deps.models.list().map((model) => ({
      label: model.displayName,
      description: model.agentCompatible ? `${model.provider} · ${model.id}` : `${model.provider} · 仅 Ask`,
      detail: model.agentCompatible
        ? `上下文 ${model.contextWindow.toLocaleString()} · 工具 ${model.supportsTools ? "是" : "否"}`
        : "该模型尚未通过工具调用测试，目前仅支持 Ask 模式。",
      modelId: model.id,
    }));
    if (items.length === 0) {
      this.deps.post({ type: "notice", level: "warn", message: "没有已配置的模型。" });
      return;
    }
    if (!this.deps.models.canAutoSelect()) {
      this.deps.post({
        type: "notice",
        level: "info",
        message: "当前仅注册了一个真实模型，「自动选择」已关闭。",
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: "选择模型",
      placeHolder: "仅列出已接入的真实模型",
    });
    if (picked) await this.select(picked.modelId);
  }

  /**
   * 打开 Composer「＋」菜单（webview 内联），不再弹宿主 QuickPick 控制中心。
   * 命令面板 / 旧消息 `openComposerMenu` 仍走这里。
   */
  openComposerMenu(): void {
    this.deps.post({ type: "openPlusMenu" });
  }
}
