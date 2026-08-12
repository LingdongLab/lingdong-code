import * as path from "node:path";
import type { FileSystemPort } from "../file-system-port";
import { detectLspServers, type LspDetection, type LspSource } from "../lsp/detect-lsp";
import {
  composeLspEntry,
  findPreset,
  LSP_PRESETS,
  renderLspJson,
  type LspServerEntry,
} from "../lsp/lsp-presets";
import { JsonStore } from "../storage/json-store";

/**
 * language server 预置的探测、启停与 lsp.json 落盘。
 *
 * 写的是**用户级** lsp.json（托管 GROK_HOME 下那一份），不是仓库里的 `.grok/lsp.json`：
 * 项目级配置要过 Grok 的 folder-trust 关卡，未授信的仓库里会被整段丢掉，
 * 也就是「配了但从来没生效」。用户级不受这个关卡限制，而扩展本来就按活动仓库
 * 重写托管目录里的配置，仓库切换时顺手重算一次即可。
 */

interface LspPrefs {
  /** 被用户显式关掉的预置 id。默认全开（探测到就写）。 */
  disabled: string[];
}

export interface LspServerStatusView {
  id: string;
  label: string;
  hint: string;
  install: string;
  /** 本机探测到的可执行文件路径。 */
  command?: string;
  source?: LspSource;
  found: boolean;
  enabled: boolean;
  /** 覆盖的扩展名，展示用。 */
  extensions: string[];
}

export interface LspServiceDeps {
  fs: FileSystemPort;
  storageRoot: string;
  workspaceRoot(): string | undefined;
  env?: () => NodeJS.ProcessEnv;
  /** 平台判断，决定要不要走 PATHEXT。 */
  platform?: () => NodeJS.Platform;
  onChanged?: () => void;
}

export class LspService {
  private readonly store: JsonStore;
  private prefs: LspPrefs = { disabled: [] };
  private loaded = false;
  private cache: LspDetection[] | undefined;
  private cacheKey = "";

  constructor(private readonly deps: LspServiceDeps) {
    this.store = new JsonStore(deps.fs);
  }

  private prefsFile(): string {
    return path.join(this.deps.storageRoot, "agent-lsp", "prefs.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const result = await this.store.read<LspPrefs>(this.prefsFile(), {
      kind: "lsp-prefs",
      fallback: () => ({ disabled: [] }),
      validate: (data) => {
        if (typeof data !== "object" || data === null) return undefined;
        const disabled = (data as { disabled?: unknown }).disabled;
        if (!Array.isArray(disabled)) return undefined;
        return {
          disabled: disabled
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean),
        };
      },
    });
    this.prefs = result.data;
    this.loaded = true;
  }

  private async detect(): Promise<LspDetection[]> {
    const root = this.deps.workspaceRoot() ?? "";
    const env = this.deps.env?.() ?? process.env;
    const windows = (this.deps.platform?.() ?? process.platform) === "win32";
    const key = `${root}|${windows ? "win" : "posix"}|${env.PATH ?? env.Path ?? ""}`;
    if (this.cache && this.cacheKey === key) return this.cache;

    const detections = await detectLspServers(LSP_PRESETS, {
      exists: (file) => this.deps.fs.exists(file),
      pathEnv: env.PATH ?? env.Path,
      ...(windows ? { pathExt: env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" } : {}),
      delimiter: windows ? ";" : ":",
      ...(root ? { workspaceRoot: root } : {}),
    });
    this.cache = detections;
    this.cacheKey = key;
    return detections;
  }

  /** 仓库切换或用户装了新 server 后丢掉探测缓存。 */
  invalidate(): void {
    this.cache = undefined;
    this.cacheKey = "";
  }

  async list(): Promise<LspServerStatusView[]> {
    await this.load();
    const detections = await this.detect();
    const disabled = new Set(this.prefs.disabled);
    return LSP_PRESETS.map((preset) => {
      const detection = detections.find((item) => item.id === preset.id);
      return {
        id: preset.id,
        label: preset.label,
        hint: preset.hint,
        install: preset.install,
        ...(detection?.command ? { command: detection.command } : {}),
        ...(detection?.source ? { source: detection.source } : {}),
        found: Boolean(detection?.command),
        enabled: !disabled.has(preset.id),
        extensions: Object.keys(preset.extensions),
      };
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!findPreset(id)) throw new Error(`未知的 language server：${id}`);
    await this.load();
    const disabled = new Set(this.prefs.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.prefs = { disabled: [...disabled].sort() };
    await this.store.write(this.prefsFile(), "lsp-prefs", this.prefs);
    this.deps.onChanged?.();
  }

  /** 渲染 lsp.json；没有可写的条目时返回 undefined（调用方删文件）。 */
  async renderConfig(): Promise<string | undefined> {
    await this.load();
    const detections = await this.detect();
    const disabled = new Set(this.prefs.disabled);
    const entries: Record<string, LspServerEntry> = {};
    for (const preset of LSP_PRESETS) {
      if (disabled.has(preset.id)) continue;
      const command = detections.find((item) => item.id === preset.id)?.command;
      // 探测不到就不写：写一个跑不起来的命令只会让 Grok 每次会话都白起一个失败进程。
      if (!command) continue;
      entries[preset.id] = composeLspEntry(preset, command);
    }
    return renderLspJson(entries);
  }

  /** 已启用且探测到的数量，用于能力提示。 */
  async activeCount(): Promise<number> {
    const list = await this.list();
    return list.filter((item) => item.found && item.enabled).length;
  }
}
