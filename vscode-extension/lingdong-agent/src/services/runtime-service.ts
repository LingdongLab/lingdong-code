import * as fs from "node:fs";
import * as vscode from "vscode";
import type { AgentRuntimeHandle } from "@lingdong/agent-runtime";
import {
  bundledGrokRoots,
  describeGrokResolution,
  resolveGrokExecutable,
  resolveGrokHome,
  type GrokLocatorDeps,
  type GrokResolution,
} from "../grok-locator";
import type { HostToWebviewMessage } from "../messages";
import type { UiStateMachine } from "../ui-state";
import type { AgentWorkspaceStore } from "../workspace-store";
import { isSurfaced } from "./surfaced-error";

/**
 * Grok 子进程的连接生命周期：启动缓存、存活校验、异常断线与自动重连。
 * 具体的「启动一个 Runtime」由控制器提供，这里只负责什么时候启动、什么时候作废。
 */

/** Grok 异常退出后的自动重连节奏；用完仍失败就交回给用户手动重连。 */
const RECONNECT_BACKOFF_MS = [1_000, 3_000, 8_000] as const;

export interface RuntimeLaunchConfig {
  executable: string;
  modelId: string;
  /**
   * `modelId` 是用户自己在设置里写的，而不是我们给的默认值。
   *
   * 两者必须分开：默认值指向内置 DeepSeek，而用户完全可能一个 DeepSeek 凭据都没配过。
   * 分不清的话，任何没有历史选择可依的场景（新工作区就是典型）都会拿这个默认值去解析，
   * 报「此会话原来使用 DeepSeek，但凭据已不存在」—— 可那个模型根本不是用户选的。
   */
  modelExplicit: boolean;
  grokHome: string | undefined;
  source: string;
}

export interface RuntimeServiceDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  postState(detail?: string): void;
  readonly ui: UiStateMachine;
  readonly store: AgentWorkspaceStore;
  /** 真正拉起并初始化一个 Runtime；由控制器实现具体编排。 */
  start(): Promise<AgentRuntimeHandle>;
  /** 断线时的附加清理，例如清空权限卡片。 */
  onDisconnected(reason: string): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function locatorDeps(): GrokLocatorDeps {
  return {
    platform: process.platform,
    env: process.env,
    // 装机版会把 grok 放在应用目录里；开发态这些路径都不存在，自然落空。
    bundledRoots: bundledGrokRoots(vscode.env.appRoot, process.platform),
    exists: (candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  };
}

export class RuntimeService {
  private runtime: AgentRuntimeHandle | undefined;
  private startup: Promise<AgentRuntimeHandle> | undefined;
  /**
   * 换仓代数：disposeForSwitchFast 递增后，进行中的 start/markStarted 视为过期，
   * 避免旧 cwd 的子进程在清场之后又被登记回来。
   */
  private launchGeneration = 0;
  /** 当前这次 ensureStarted 捕获的代数；供 markStarted 对照。 */
  private startingGeneration = 0;
  /** 断线只处理一次，直到重连成功或用户手动重连。 */
  private disconnectedFlag = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor(private readonly deps: RuntimeServiceDeps) {}

  get current(): AgentRuntimeHandle | undefined {
    return this.runtime;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  ensureStarted(): Promise<AgentRuntimeHandle> {
    // 缓存里可能是一个已经退出的子进程；不作废就会把请求写进死掉的 stdin。
    if (this.runtime && !this.runtime.processRunning) {
      this.deps.log("[runtime] 缓存的 Grok 子进程已退出，作废后重新拉起。");
      this.invalidate();
    }
    if (!this.startup) {
      const generation = this.launchGeneration;
      this.startingGeneration = generation;
      this.startup = this.deps.start()
        .then((runtime) => {
          if (generation !== this.launchGeneration) {
            if (this.runtime === runtime) this.runtime = undefined;
            void runtime.dispose().catch((error: unknown) => {
              this.deps.log(`[shutdown] 换仓后丢弃过期启动失败：${errorText(error)}`);
            });
            throw new Error("启动已取消（换仓）");
          }
          return runtime;
        })
        .catch((error: unknown) => {
          this.startup = undefined;
          throw error;
        });
    }
    return this.startup;
  }

  /** 当前这次启动是否仍被接受（换仓后为 false）。 */
  isLaunchCurrent(generation: number): boolean {
    return generation === this.launchGeneration;
  }

  get launchEpoch(): number {
    return this.launchGeneration;
  }

  /**
   * 启动成功后由控制器登记，并清掉断线标记。
   * @returns false 表示这次启动已在换仓中作废，调用方必须中止后续 bindSession。
   */
  markStarted(runtime: AgentRuntimeHandle): boolean {
    // start() 内部会先 mark 再 bindSession；换仓已 bump 代数时绝不能继续写会话。
    if (this.startingGeneration !== this.launchGeneration) {
      void runtime.dispose().catch((error: unknown) => {
        this.deps.log(`[shutdown] 丢弃过期 Runtime 失败：${errorText(error)}`);
      });
      return false;
    }
    this.runtime = runtime;
    this.disconnectedFlag = false;
    this.reconnectAttempt = 0;
    return true;
  }

  /** 解析可执行文件、GROK_HOME 与模型；定位不到时抛错并引导用户手选。 */
  resolveLaunchConfig(): RuntimeLaunchConfig {
    const settings = vscode.workspace.getConfiguration("lingdongAgent");
    const modelId = (settings.get<string>("model", "deepseek-v4-flash") ?? "").trim()
      || "deepseek-v4-flash";
    // inspect 才分得清「用户写过」和「读到的是 package.json 里的默认值」，get 一律返回后者。
    const written = settings.inspect<string>("model");
    const modelExplicit = [
      written?.workspaceFolderValue,
      written?.workspaceValue,
      written?.globalValue,
    ].some((value) => typeof value === "string" && value.trim() !== "");
    const resolution = resolveGrokExecutable(
      settings.get<string>("grokExecutable", "") ?? "",
      locatorDeps(),
    );
    if (!resolution.ok) {
      this.promptLocate(resolution);
      throw new Error(describeGrokResolution(resolution));
    }
    if (resolution.source !== "setting") {
      this.deps.log(`[startup] 自动定位到 Grok（${resolution.source}）：${resolution.executable}`);
    }
    return {
      executable: resolution.executable,
      modelId,
      modelExplicit,
      grokHome: resolveGrokHome(
        settings.get<string>("grokHome", "") ?? "",
        resolution.executable,
        locatorDeps(),
      ),
      source: resolution.source,
    };
  }

  /**
   * Grok 子进程异常退出：立刻作废 Runtime 缓存并把连接状态置为失败，
   * 否则下一次发送会写向已经死掉的 stdin，用户只看到静默失败。
   */
  handleDisconnected(reason: string): void {
    if (this.disconnectedFlag || this.shuttingDown) return;
    this.disconnectedFlag = true;
    this.deps.log(`[runtime] 连接中断：${reason}`);
    this.deps.onDisconnected(reason);
    this.invalidate();
    this.deps.ui.force("error");
    this.deps.store.patchRuntime({ connection: "failed", connectionDetail: reason });
    this.deps.post({ type: "connection", state: "failed", detail: reason });
    this.deps.post({ type: "error", message: "Grok 连接已断开，本轮任务已中止。", recoverable: true });
    this.deps.postState(reason);
    this.scheduleAutoReconnect();
  }

  async reconnect(options: { auto?: boolean } = {}): Promise<void> {
    this.clearReconnectTimer();
    if (!options.auto) this.reconnectAttempt = 0;
    this.deps.post({
      type: "notice",
      level: "info",
      message: options.auto ? "正在自动重新连接 Grok……" : "正在重新连接 Grok……",
    });
    await this.disposeCurrent();
    this.deps.ui.force("idle");
    this.deps.postState();
    try {
      await this.ensureStarted();
      this.disconnectedFlag = false;
      this.reconnectAttempt = 0;
      this.deps.postState();
      if (options.auto) {
        this.deps.post({ type: "notice", level: "info", message: "Grok 已自动重新连接，可以继续发送。" });
      }
    } catch (error) {
      this.deps.ui.force("error");
      this.deps.store.patchRuntime({ connection: "failed", connectionDetail: errorText(error) });
      this.deps.post({ type: "connection", state: "failed", detail: errorText(error) });
      // 缺凭据这类失败在编排层已经发过带按钮的卡，这里再补一张只是重复同一句话。
      if (!isSurfaced(error)) {
        this.deps.post({ type: "error", message: `重新连接失败：${errorText(error)}`, recoverable: true });
      }
      this.deps.postState(errorText(error));
      if (options.auto) this.scheduleAutoReconnect();
    }
  }

  /** 同步作废缓存：子进程已经不在了，dispose 只用来摘监听与写日志。 */
  invalidate(): void {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.startup = undefined;
    if (!runtime) return;
    void runtime.dispose().catch((error: unknown) => {
      this.deps.log(`[shutdown] 作废 Runtime 失败：${errorText(error)}`);
    });
  }

  async disposeCurrent(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.startup = undefined;
    if (!runtime) return;
    try {
      const exit = await runtime.dispose();
      this.deps.log(`[shutdown] Grok 退出：code=${String(exit?.code ?? "timeout")}`);
    } catch (error) {
      this.deps.log(`[shutdown] ${errorText(error)}`);
    }
  }

  /**
   * 换仓库时的停机。与 shutdown 的区别是不置 shuttingDown——之后还要再起来。
   *
   * 必须先等在飞的 startup 落地：预热正在拉起子进程时直接清场，那个子进程会在
   * 清场之后才出生，cwd 还是旧仓库，而且没有任何人认领它。
   */
  async disposeForSwitch(): Promise<void> {
    this.clearReconnectTimer();
    if (this.startup) await this.startup.catch(() => undefined);
    await this.disposeCurrent();
  }

  /**
   * Cursor 式换仓：关键路径只摘掉引用，进程退出丢到后台。
   * UI 不必等 Grok 杀完再换皮；发送前 ensureStarted 会按新根再拉起。
   */
  disposeForSwitchFast(): void {
    this.clearReconnectTimer();
    this.launchGeneration += 1;
    const abandonedStartup = this.startup;
    const abandonedRuntime = this.runtime;
    this.startup = undefined;
    this.runtime = undefined;
    if (abandonedRuntime) {
      void abandonedRuntime.dispose().catch((error: unknown) => {
        this.deps.log(`[shutdown] 换仓时回收 Runtime 失败：${errorText(error)}`);
      });
    }
    if (abandonedStartup) {
      void abandonedStartup
        .then((runtime) => {
          if (this.runtime === runtime) this.runtime = undefined;
          return runtime.dispose();
        })
        .catch((error: unknown) => {
          // 「启动已取消」是我们自己抛的，不算故障。
          const text = errorText(error);
          if (text.includes("启动已取消")) return;
          this.deps.log(`[shutdown] 换仓时回收在飞启动失败：${text}`);
        });
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearReconnectTimer();
    // 预热/启动还在飞时先等它落地：否则本地代理、子进程会在清场之后才被拉起，
    // 没人回收，进程（或扩展宿主）就此悬住。
    if (this.startup) await this.startup.catch(() => undefined);
    await this.disposeCurrent();
  }

  /**
   * 手动选择 Grok 可执行文件并写回用户级设置。
   * 写用户级而非工作区级，换项目时不用重复配置。
   */
  async locateExecutable(): Promise<void> {
    const filters = process.platform === "win32"
      ? { "可执行文件": ["exe", "cmd", "bat"] }
      : undefined;
    const picked = await vscode.window.showOpenDialog({
      title: "选择 Grok Build 可执行文件",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "使用该文件",
      ...(filters ? { filters } : {}),
    });
    const chosen = picked?.[0];
    if (!chosen) return;

    const settings = vscode.workspace.getConfiguration("lingdongAgent");
    await settings.update("grokExecutable", chosen.fsPath, vscode.ConfigurationTarget.Global);
    const home = resolveGrokHome("", chosen.fsPath, locatorDeps());
    if (home && !(settings.get<string>("grokHome", "") ?? "").trim()) {
      await settings.update("grokHome", home, vscode.ConfigurationTarget.Global);
      this.deps.log(`[startup] 已推断 GROK_HOME：${home}`);
    }
    this.deps.post({ type: "notice", level: "info", message: `已记录 Grok 路径：${chosen.fsPath}` });
    await this.reconnect();
  }

  private scheduleAutoReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[this.reconnectAttempt];
    if (delay === undefined) {
      this.deps.post({
        type: "notice",
        level: "warn",
        message: "自动重连未成功，请检查 Grok 配置后点击「重连」。",
      });
      return;
    }
    this.reconnectAttempt += 1;
    this.deps.post({
      type: "notice",
      level: "info",
      message: `将在 ${Math.round(delay / 1_000)} 秒后自动重连`
        + `（第 ${this.reconnectAttempt}/${RECONNECT_BACKOFF_MS.length} 次）。`,
    });
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect({ auto: true });
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    this.reconnectTimer = timer;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** 找不到 Grok 时给出对话内联引导，而不是 VS Code Error toast。 */
  private promptLocate(resolution: GrokResolution): void {
    if (resolution.ok) return;
    const summary = resolution.reason === "configured-missing"
      ? `设置中的 Grok 路径不存在：${resolution.configured}`
      : "未找到 Grok Build 可执行文件。";
    this.deps.post({
      type: "error",
      message: summary,
      recoverable: true,
      actions: [
        { id: "locateGrok", label: "选择可执行文件…" },
        { id: "openGrokSettings", label: "打开设置" },
      ],
    });
  }
}
