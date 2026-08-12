import { Buffer } from "node:buffer";
import type { FileSystemPort } from "../file-system-port";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrateDocument,
  type MigrationRegistry,
  type StorageKind,
} from "./storage-migration";

/**
 * 所有 JSON 仓库共用的落盘层。
 * 写入永远走「临时文件 → 旧文件转 .bak → 改名到正式文件」，任何一步崩溃都还有一个完整可读的版本；
 * 读取时主文件损坏就回退 .bak，两个都坏就把坏文件改名归档，返回空数据而不是让 Extension Host 崩掉。
 */

export type LoadStatus = "missing" | "ok" | "recovered" | "corrupt" | "unsupported";

export interface LoadResult<T> {
  status: LoadStatus;
  data: T;
  /** 损坏文件被归档到的路径，用于日志与界面提示。 */
  archived?: string;
  detail?: string;
}

interface Envelope {
  schemaVersion: number;
  kind: StorageKind;
  updatedAt: number;
  data: unknown;
}

export interface JsonStoreOptions {
  now?: () => number;
  registry?: MigrationRegistry;
  schemaVersion?: number;
}

export interface ReadOptions<T> {
  kind: StorageKind;
  fallback: () => T;
  /** 结构校验：返回 undefined 表示内容虽然是合法 JSON 但结构不可用，按损坏处理。 */
  validate: (data: unknown) => T | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampSuffix(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

export class JsonStore {
  private readonly now: () => number;
  private readonly registry: MigrationRegistry;
  private readonly schemaVersion: number;
  /** 每个文件一条写入队列，见 write() 的说明。 */
  private readonly writeQueues = new Map<string, Promise<void>>();
  private tempCounter = 0;

  constructor(
    private readonly fs: FileSystemPort,
    options: JsonStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.registry = options.registry ?? MIGRATIONS;
    this.schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
  }

  backupPath(file: string): string {
    return `${file}.bak`;
  }

  /**
   * 写入同一个文件必须排队，而且临时文件名必须唯一。
   *
   * 「写 tmp → 旧文件转 .bak → tmp 改名到正式文件」这三步不是原子的，两个写并发进来会这样：
   * A 写好 tmp，B 用同一个名字把它覆盖掉；A 把正文转成 .bak、再把 tmp 改名成正文（tmp 至此消失）；
   * B 接着把 A 刚写好的正文也转成 .bak，最后改名 tmp 时报 ENOENT。
   * 报错只是表象，真正危险的是中间那一下——正文被挪走而 tmp 已经没了，磁盘上一度没有这个文件。
   *
   * 实测触发路径：session/load 回放会在几毫秒内涌进几十条更新，
   * 其中带 `void` 的 contextUsage patch 与发送路径里 await 的 patch 同时落到 session.json 上。
   */
  async write<T>(file: string, kind: StorageKind, data: T): Promise<void> {
    const previous = this.writeQueues.get(file) ?? Promise.resolve();
    // 前一次写失败不能卡死后面的写，所以排队用的这份把异常吞掉，只拿它定顺序。
    const mine = previous.then(() => this.writeOnce(file, kind, data));
    const queued = mine.catch(() => undefined);

    this.writeQueues.set(file, queued);
    try {
      await mine;
    } finally {
      // 队尾还是自己才清理，否则会把后来者的队列头丢掉。
      if (this.writeQueues.get(file) === queued) this.writeQueues.delete(file);
    }
  }

  private async writeOnce<T>(file: string, kind: StorageKind, data: T): Promise<void> {
    const envelope: Envelope = {
      schemaVersion: this.schemaVersion,
      kind,
      updatedAt: this.now(),
      data,
    };
    const payload = Buffer.from(`${JSON.stringify(envelope, undefined, 2)}\n`, "utf8");
    // 名字带进程号与自增序号：同一个 globalStorage 可能被多个窗口同时写，
    // 队列只管得住本进程，唯一的临时名才能保证别的进程抢不走我们这一份。
    this.tempCounter += 1;
    const temporary = `${file}.${process.pid}.${this.tempCounter}.tmp`;
    await this.fs.write(temporary, payload);
    try {
      if (await this.fs.exists(file)) await this.fs.rename(file, this.backupPath(file));
      await this.fs.rename(temporary, file);
    } catch (error) {
      // 别把半成品留在目录里，否则下次启动会看到一堆 .tmp。
      await this.fs.remove(temporary).catch(() => undefined);
      throw error;
    }
  }

  async read<T>(file: string, options: ReadOptions<T>): Promise<LoadResult<T>> {
    const main = await this.parse(file, options);
    if (main.kind === "ok") return { status: "ok", data: main.data };
    if (main.kind === "unsupported") {
      return { status: "unsupported", data: options.fallback(), detail: main.detail };
    }

    const backupFile = this.backupPath(file);
    const backup = await this.parse(backupFile, options);
    if (main.kind === "missing" && backup.kind === "missing") {
      return { status: "missing", data: options.fallback() };
    }

    // 主文件坏了就归档，保留证据同时避免下次启动重复解析失败。
    const archived = main.kind === "damaged" ? await this.archive(file) : undefined;
    const mainDetail = main.kind === "damaged" ? main.detail : undefined;
    if (backup.kind === "ok") {
      const result: LoadResult<T> = {
        status: "recovered",
        data: backup.data,
        detail: mainDetail ?? "主文件不可用，已从上一个有效版本恢复。",
      };
      if (archived) result.archived = archived;
      return result;
    }
    if (backup.kind === "damaged") await this.archive(backupFile);
    const backupDetail = backup.kind === "damaged" || backup.kind === "unsupported" ? backup.detail : undefined;

    const result: LoadResult<T> = {
      status: "corrupt",
      data: options.fallback(),
      detail: mainDetail ?? backupDetail ?? "存储文件已损坏，已重新开始记录。",
    };
    if (archived) result.archived = archived;
    return result;
  }

  private async archive(file: string): Promise<string | undefined> {
    const target = `${file}.corrupt-${timestampSuffix(this.now())}`;
    try {
      await this.fs.rename(file, target);
      return target;
    } catch {
      return undefined;
    }
  }

  private async parse<T>(
    file: string,
    options: ReadOptions<T>,
  ): Promise<
    | { kind: "ok"; data: T }
    | { kind: "missing" }
    | { kind: "damaged"; detail: string }
    | { kind: "unsupported"; detail: string }
  > {
    const bytes = await this.fs.read(file);
    if (!bytes) return { kind: "missing" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch (error) {
      return { kind: "damaged", detail: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!isRecord(parsed) || typeof parsed.schemaVersion !== "number") {
      return { kind: "damaged", detail: "缺少 schemaVersion，无法确认数据结构。" };
    }

    const migrated = migrateDocument(options.kind, parsed.schemaVersion, parsed.data, this.registry, this.schemaVersion);
    if (!migrated.ok) {
      return migrated.reason === "unsupported_version"
        ? { kind: "unsupported", detail: migrated.detail }
        : { kind: "damaged", detail: migrated.detail };
    }

    const validated = options.validate(migrated.data);
    if (validated === undefined) return { kind: "damaged", detail: "数据结构校验失败。" };
    return { kind: "ok", data: validated };
  }
}
