import { createHash } from "node:crypto";
import * as path from "node:path";
import { isSensitivePath } from "@lingdong/agent-runtime";
import { normalizeRelativePath } from "./context-model";
import type { FileSystemPort } from "./file-system-port";

/**
 * 修改前快照。目录结构：
 * <globalStorage>/agent-snapshots/<workspace-hash>/<sessionId>/<turnId>/
 *   manifest.json          记录相对路径与落盘文件名的映射
 *   files/<sha1(relPath)>  快照正文，文件名不落任何真实路径
 */

export interface SnapshotRecord {
  relativePath: string;
  /** 快照正文的落盘文件名；文件原本不存在时为空。 */
  storedAs: string;
  /** 快照时文件是否存在；false 表示这是一次新建。 */
  existed: boolean;
  /** 修改前内容的 sha256；文件不存在时为空字符串。 */
  sha256: string;
  size: number;
  createdAt: number;
}

interface TurnSnapshots {
  sessionId: string;
  turnId: string;
  directory: string;
  totalBytes: number;
  records: Map<string, SnapshotRecord>;
  updatedAt: number;
}

export interface ScannedTurn {
  sessionId: string;
  turnId: string;
  directory: string;
  updatedAt: number;
  totalBytes: number;
  fileCount: number;
}

export interface SnapshotStoreOptions {
  /** 单轮快照总量上限，超过后拒绝继续快照（也就拒绝继续修改）。 */
  maxTurnBytes?: number;
}

interface ManifestData {
  sessionId: string;
  turnId: string;
  workspace: string;
  updatedAt: number;
  totalBytes: number;
  files: SnapshotRecord[];
}

export interface CleanupInput {
  removableTurnIds: Iterable<string>;
  maxAgeMs: number;
  /** 快照总大小超限时，从 removableTurnIds 里按 updatedAt 从旧到新继续删除。 */
  maxTotalBytes?: number;
  /** 传入已知 turnId 时，cleanup 返回值会附带 orphanDirectories。 */
  knownTurnIds?: Iterable<string>;
}

export interface CleanupResult {
  removed: string[];
  orphanDirectories: string[];
}

const DEFAULT_MAX_TURN_BYTES = 50 * 1024 * 1024;

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function storageName(relativePath: string): string {
  return createHash("sha1").update(relativePath.toLowerCase()).digest("hex");
}

export function workspaceHash(workspaceRoot: string): string {
  return createHash("sha1").update(workspaceRoot.toLowerCase()).digest("hex").slice(0, 12);
}

export class SnapshotError extends Error {}

export class SnapshotStore {
  private readonly maxTurnBytes: number;
  private readonly turns = new Map<string, TurnSnapshots>();

  constructor(
    private readonly rootDirectory: string,
    private readonly workspaceRoot: string,
    private readonly fs: FileSystemPort,
    options: SnapshotStoreOptions = {},
  ) {
    this.maxTurnBytes = options.maxTurnBytes ?? DEFAULT_MAX_TURN_BYTES;
  }

  get baseDirectory(): string {
    return path.join(this.rootDirectory, workspaceHash(this.workspaceRoot));
  }

  turnDirectory(sessionId: string, turnId: string): string {
    return path.join(this.baseDirectory, sessionId, turnId);
  }

  /**
   * 保存某个文件在被修改之前的内容。
   * 已经快照过的文件直接复用第一次的结果，保证同一轮里多次修改仍能回到最初状态。
   */
  async capture(sessionId: string, turnId: string, relativePath: string): Promise<SnapshotRecord> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new SnapshotError("快照路径为空");
    if (isSensitivePath(normalized)) {
      throw new SnapshotError(`拒绝为敏感文件创建快照：${normalized}`);
    }
    const turn = this.ensureTurn(sessionId, turnId);
    const existing = this.findRecord(turn, normalized);
    if (existing) return existing;

    const absolute = path.resolve(this.workspaceRoot, normalized);
    const bytes = await this.fs.read(absolute);
    const size = bytes?.byteLength ?? 0;
    if (turn.totalBytes + size > this.maxTurnBytes) {
      throw new SnapshotError(
        `本轮快照已超过 ${Math.round(this.maxTurnBytes / (1024 * 1024))} MB 上限，已阻止继续修改文件。`,
      );
    }

    const record: SnapshotRecord = {
      relativePath: normalized,
      storedAs: bytes ? storageName(normalized) : "",
      existed: bytes !== undefined,
      sha256: bytes ? sha256(bytes) : "",
      size,
      createdAt: Date.now(),
    };

    try {
      if (bytes) await this.fs.write(path.join(turn.directory, "files", record.storedAs), bytes);
      turn.records.set(normalized, record);
      turn.totalBytes += size;
      turn.updatedAt = Date.now();
      await this.writeManifest(turn);
    } catch (error) {
      throw new SnapshotError(`保存修改前快照失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return record;
  }

  get(turnId: string, relativePath: string): SnapshotRecord | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    return this.findRecord(turn, normalizeRelativePath(relativePath));
  }

  records(turnId: string): SnapshotRecord[] {
    return [...(this.turns.get(turnId)?.records.values() ?? [])];
  }

  /** 读取快照正文；返回 undefined 表示「文件原本不存在」。 */
  async read(turnId: string, relativePath: string): Promise<Uint8Array | undefined> {
    let turn = this.turns.get(turnId);
    if (!turn) {
      await this.loadTurnFromDisk(turnId);
      turn = this.turns.get(turnId);
    }
    if (!turn) return undefined;
    const record = this.findRecord(turn, normalizeRelativePath(relativePath));
    if (!record || !record.existed) return undefined;
    return this.fs.read(path.join(turn.directory, "files", record.storedAs));
  }

  /**
   * 用规范化路径取记录；Windows 上再做一次大小写不敏感兜底，
   * 避免「快照在、Diff 左侧却是斜纹空栏」。
   */
  private findRecord(turn: TurnSnapshots, relativePath: string): SnapshotRecord | undefined {
    if (!relativePath) return undefined;
    const direct = turn.records.get(relativePath);
    if (direct) return direct;
    const lowered = relativePath.toLowerCase();
    for (const [key, record] of turn.records) {
      if (key.toLowerCase() === lowered) return record;
    }
    return undefined;
  }

  /**
   * 扫描磁盘 manifest，重建内存 turns Map。
   * 重启后调用方可恢复 read/cleanup 能力；返回成功加载的轮次数。
   */
  async hydrate(sessionId?: string): Promise<number> {
    let count = 0;
    for await (const { directory, manifest } of this.iterManifests(sessionId)) {
      if (manifest.workspace !== workspaceHash(this.workspaceRoot)) continue;
      this.turns.set(manifest.turnId, this.manifestToTurn(directory, manifest));
      count += 1;
    }
    return count;
  }

  /** 列出磁盘上的快照轮次摘要，不强制写入内存。 */
  async scan(sessionId?: string): Promise<ScannedTurn[]> {
    const results: ScannedTurn[] = [];
    for await (const { directory, manifest } of this.iterManifests(sessionId)) {
      if (manifest.workspace !== workspaceHash(this.workspaceRoot)) continue;
      results.push({
        sessionId: manifest.sessionId,
        turnId: manifest.turnId,
        directory,
        updatedAt: manifest.updatedAt,
        totalBytes: manifest.totalBytes,
        fileCount: manifest.files.length,
      });
    }
    return results.sort((left, right) => left.updatedAt - right.updatedAt);
  }

  /** 磁盘上有目录但调用方 turn 仓库未记录的孤儿快照。 */
  async findOrphans(knownTurnIds: Iterable<string>): Promise<string[]> {
    const known = new Set(knownTurnIds);
    const orphans: string[] = [];
    for (const turn of await this.scan()) {
      if (!known.has(turn.turnId)) orphans.push(turn.directory);
    }
    return orphans;
  }

  async releaseTurn(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    await this.fs.removeDirectory(turn.directory);
  }

  /**
   * 清理策略：只清理调用方明确允许回收的轮次（全部已接受或已恢复）且超过保留时长的目录；
   * 还有未决变更的轮次一律保留，否则用户就再也回不去了。
   * maxTotalBytes 超限时继续从 removableTurnIds 删除最旧轮次；pending 轮次不在 removable 里就不会被删。
   */
  async cleanup(input: CleanupInput): Promise<CleanupResult> {
    const removed: string[] = [];
    const now = Date.now();
    const removable = [...input.removableTurnIds];

    for (const turnId of removable) {
      const turn = this.turns.get(turnId);
      if (!turn) continue;
      if (now - turn.updatedAt < input.maxAgeMs) continue;
      await this.releaseTurn(turnId);
      removed.push(turnId);
    }

    if (input.maxTotalBytes !== undefined) {
      let total = (await this.scan()).reduce((sum, entry) => sum + entry.totalBytes, 0);
      const candidates = removable
        .filter((turnId) => !removed.includes(turnId))
        .map((turnId) => this.turns.get(turnId))
        .filter((turn): turn is TurnSnapshots => turn !== undefined)
        .sort((left, right) => left.updatedAt - right.updatedAt);

      for (const turn of candidates) {
        if (total <= input.maxTotalBytes) break;
        await this.releaseTurn(turn.turnId);
        removed.push(turn.turnId);
        total -= turn.totalBytes;
      }
    }

    const orphanDirectories =
      input.knownTurnIds === undefined ? [] : await this.findOrphans(input.knownTurnIds);
    return { removed, orphanDirectories };
  }

  private ensureTurn(sessionId: string, turnId: string): TurnSnapshots {
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    const turn: TurnSnapshots = {
      sessionId,
      turnId,
      directory: this.turnDirectory(sessionId, turnId),
      totalBytes: 0,
      records: new Map(),
      updatedAt: Date.now(),
    };
    this.turns.set(turnId, turn);
    return turn;
  }

  private async *iterManifests(sessionId?: string): AsyncGenerator<{ directory: string; manifest: ManifestData }> {
    const sessions = await this.fs.listEntries(this.baseDirectory);
    for (const sessionEntry of sessions) {
      if (!sessionEntry.isDirectory) continue;
      if (sessionId !== undefined && sessionEntry.name !== sessionId) continue;
      const sessionPath = path.join(this.baseDirectory, sessionEntry.name);
      const turnEntries = await this.fs.listEntries(sessionPath);
      for (const turnEntry of turnEntries) {
        if (!turnEntry.isDirectory) continue;
        const directory = path.join(sessionPath, turnEntry.name);
        const manifest = await this.readManifest(path.join(directory, "manifest.json"));
        if (manifest) yield { directory, manifest };
      }
    }
  }

  private async loadTurnFromDisk(turnId: string): Promise<void> {
    if (this.turns.has(turnId)) return;
    for await (const { directory, manifest } of this.iterManifests()) {
      if (manifest.turnId !== turnId) continue;
      if (manifest.workspace !== workspaceHash(this.workspaceRoot)) return;
      this.turns.set(turnId, this.manifestToTurn(directory, manifest));
      return;
    }
  }

  private manifestToTurn(directory: string, manifest: ManifestData): TurnSnapshots {
    const records = new Map<string, SnapshotRecord>();
    for (const file of manifest.files) {
      const key = normalizeRelativePath(file.relativePath) || file.relativePath;
      records.set(key, { ...file, relativePath: key });
    }
    return {
      sessionId: manifest.sessionId,
      turnId: manifest.turnId,
      directory,
      totalBytes: manifest.totalBytes,
      records,
      updatedAt: manifest.updatedAt,
    };
  }

  private async readManifest(manifestPath: string): Promise<ManifestData | undefined> {
    const bytes = await this.fs.read(manifestPath);
    if (!bytes) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
      const data = parsed as Record<string, unknown>;
      if (typeof data.sessionId !== "string" || typeof data.turnId !== "string") return undefined;
      if (typeof data.workspace !== "string") return undefined;
      const files = Array.isArray(data.files) ? data.files : [];
      const records: SnapshotRecord[] = [];
      for (const file of files) {
        if (typeof file !== "object" || file === null || Array.isArray(file)) continue;
        const entry = file as Record<string, unknown>;
        if (typeof entry.relativePath !== "string") continue;
        records.push({
          relativePath: entry.relativePath,
          storedAs: typeof entry.storedAs === "string" ? entry.storedAs : "",
          existed: entry.existed === true,
          sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
          size: typeof entry.size === "number" ? entry.size : 0,
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
        });
      }
      return {
        sessionId: data.sessionId,
        turnId: data.turnId,
        workspace: data.workspace,
        updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
        totalBytes: typeof data.totalBytes === "number" ? data.totalBytes : 0,
        files: records,
      };
    } catch {
      return undefined;
    }
  }

  private async writeManifest(turn: TurnSnapshots): Promise<void> {
    const manifest = {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      workspace: workspaceHash(this.workspaceRoot),
      updatedAt: turn.updatedAt,
      totalBytes: turn.totalBytes,
      files: [...turn.records.values()],
    };
    await this.fs.write(
      path.join(turn.directory, "manifest.json"),
      Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`, "utf8"),
    );
  }
}
