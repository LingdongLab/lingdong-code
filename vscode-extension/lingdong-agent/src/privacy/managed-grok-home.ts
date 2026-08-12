import { Buffer } from "node:buffer";
import * as path from "node:path";
import type { FileSystemPort } from "../file-system-port";

/**
 * 托管 GROK_HOME。
 *
 * 为什么要托管：Grok 的隐私开关有一部分只存在于 config.toml，没有对应的环境变量
 * （`[features] remote_fetch` 就是这样），而且文档明确写着某些键 TOML 优先于 env。
 * 只靠注入环境变量无法真正关闭这些通道，必须由扩展持有 config.toml 的写入权。
 *
 * 为什么不就地改用户的那份：grok 二进制自己也会写 config.toml（marketplace 段就是它写的），
 * 并发写有损坏风险。改为在扩展存储下另建一份托管目录，原目录只读不动。
 *
 * 播种只做一次，从原目录挑必要的东西复制过来，其余交给 grok 自己按需重建。
 */

/** 从源 GROK_HOME 复制的条目；只保留缺了会掉功能的部分。 */
export const SEED_ENTRIES = [
  // 自带的 ripgrep override，缺了 grok 的搜索会退回系统 rg 或直接失效。
  "vendor",
  // 安装身份标识；不复制会触发 grok 的首次运行初始化。
  "agent_id",
  ".metadata_version",
] as const;

/**
 * 明确不复制的条目，避免体积失控或把过期状态带进新目录。
 * `config.toml` 由扩展整份生成；`installer-profile` 里有一个 140MB 的安装包。
 */
export const SKIP_ENTRIES = [
  "config.toml",
  "installer-profile",
  "logs",
  "sessions",
  "memtrace",
  "relocations",
  "docs",
  "CHANGELOG.md",
  "CHANGELOG.json",
  "README.md",
  "version.json",
] as const;

/** 托管标记文件；存在即视为已播种。 */
export const SEED_MARKER = ".lingdong-managed.json";

/** 校验闭环钩子的文件名；固定名字才能在关闭开关时准确删除。 */
export const VERIFY_HOOKS_FILE = "lingdong-verify.json";

export interface SeedMarker {
  seededFrom: string;
  seededAt: number;
  /** 播种时的 Grok 版本，便于日后判断要不要重新播种。 */
  grokVersion?: string;
}

export interface ManagedGrokHomeDeps {
  fs: FileSystemPort;
  /** 扩展存储根目录，托管目录建在它下面。 */
  storageRoot: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface EnsureInput {
  /** 探测到的原 GROK_HOME；没有也能建目录，只是没有 vendor 可复制。 */
  source?: string;
  grokVersion?: string;
}

export class ManagedGrokHome {
  private readonly now: () => number;

  constructor(private readonly deps: ManagedGrokHomeDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get directory(): string {
    return path.join(this.deps.storageRoot, "grok-home");
  }

  get configFile(): string {
    return path.join(this.directory, "config.toml");
  }

  private get markerFile(): string {
    return path.join(this.directory, SEED_MARKER);
  }

  async isSeeded(): Promise<boolean> {
    return this.deps.fs.exists(this.markerFile);
  }

  /**
   * 确保托管目录可用，返回目录路径。
   * 已播种时直接返回，不重复复制——用户可能在托管目录里放了自己的东西。
   */
  async ensure(input: EnsureInput = {}): Promise<string> {
    await this.deps.fs.ensureDirectory(this.directory);
    if (await this.isSeeded()) return this.directory;

    if (input.source && input.source !== this.directory) {
      await this.seedFrom(input.source);
    }

    const marker: SeedMarker = {
      seededFrom: input.source ?? "",
      seededAt: this.now(),
      ...(input.grokVersion ? { grokVersion: input.grokVersion } : {}),
    };
    await this.writeJson(this.markerFile, marker);
    this.deps.log?.(`[privacy] 已建立托管 GROK_HOME：${this.directory}`);
    return this.directory;
  }

  async readMarker(): Promise<SeedMarker | undefined> {
    const bytes = await this.deps.fs.read(this.markerFile);
    if (!bytes) return undefined;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const record = parsed as Record<string, unknown>;
      if (typeof record.seededFrom !== "string" || typeof record.seededAt !== "number") {
        return undefined;
      }
      return {
        seededFrom: record.seededFrom,
        seededAt: record.seededAt,
        ...(typeof record.grokVersion === "string" ? { grokVersion: record.grokVersion } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** 写入生成好的 config.toml。内容由 grok-config-writer 产出，这里只落盘。 */
  async writeConfig(contents: string): Promise<void> {
    await this.deps.fs.ensureDirectory(this.directory);
    await this.deps.fs.write(this.configFile, Buffer.from(contents, "utf8"));
  }

  get hooksFile(): string {
    return path.join(this.directory, "hooks", VERIFY_HOOKS_FILE);
  }

  /**
   * 写入校验闭环的 hooks JSON；contents 为 undefined 时删除。
   *
   * 放在托管目录的 `hooks/` 下是刻意的：按 Grok 文档这属于「Global，Always trusted」，
   * 不需要用户执行 `/hooks-trust`。写进项目的 `.grok/hooks/` 则要先信任目录，
   * 那等于默认不生效。
   */
  async writeVerifyHooks(contents: string | undefined): Promise<void> {
    if (contents === undefined) {
      if (await this.deps.fs.exists(this.hooksFile)) await this.deps.fs.remove(this.hooksFile);
      return;
    }
    await this.deps.fs.ensureDirectory(path.dirname(this.hooksFile));
    await this.deps.fs.write(this.hooksFile, Buffer.from(contents, "utf8"));
  }

  get lspFile(): string {
    return path.join(this.directory, "lsp.json");
  }

  /**
   * 写入用户级 lsp.json；contents 为 undefined 时删除。
   *
   * 刻意写在托管目录而不是仓库的 `.grok/lsp.json`：项目级 LSP 配置要过 Grok 的
   * folder-trust 关卡，未授信的仓库里整段被丢弃且只在它自己的日志里留一行 warn。
   * 用户级不受该关卡限制，而这份文件本来就由我们按活动仓库重算。
   */
  async writeLspConfig(contents: string | undefined): Promise<void> {
    if (contents === undefined) {
      if (await this.deps.fs.exists(this.lspFile)) await this.deps.fs.remove(this.lspFile);
      return;
    }
    await this.deps.fs.ensureDirectory(this.directory);
    await this.deps.fs.write(this.lspFile, Buffer.from(contents, "utf8"));
  }

  private async seedFrom(source: string): Promise<void> {
    for (const entry of SEED_ENTRIES) {
      const from = path.join(source, entry);
      if (!(await this.deps.fs.exists(from))) continue;
      await this.copyRecursive(from, path.join(this.directory, entry));
    }
  }

  private async copyRecursive(from: string, to: string): Promise<void> {
    const entries = await this.deps.fs.listEntries(from);
    if (entries.length === 0) {
      // 空目录与普通文件在这里无法区分，先按文件读；读不到就当空目录建出来。
      const bytes = await this.deps.fs.read(from);
      if (bytes) {
        await this.deps.fs.write(to, bytes);
        return;
      }
      await this.deps.fs.ensureDirectory(to);
      return;
    }
    await this.deps.fs.ensureDirectory(to);
    for (const entry of entries) {
      if ((SKIP_ENTRIES as readonly string[]).includes(entry.name)) continue;
      await this.copyRecursive(path.join(from, entry.name), path.join(to, entry.name));
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await this.deps.fs.write(file, Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`, "utf8"));
  }
}
