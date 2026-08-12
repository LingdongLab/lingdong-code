import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { ContextUsageRecord } from "../context-usage";
import type { FileSystemPort } from "../file-system-port";
import { DEFAULT_TITLE, MAX_TITLE_CHARS, generateSessionTitle, shouldApplyAutoTitle } from "../session-title";
import { JsonStore, type LoadStatus } from "./json-store";
import { SCHEMA_VERSION } from "./storage-migration";

/**
 * 工作区级会话索引。
 * 目录：<root>/<workspaceId>/index.json 与 <root>/<workspaceId>/<sessionId>/session.json。
 * 索引只存 id 顺序，真正的记录各自成文件；索引损坏时可以直接按目录重建，不会丢会话。
 */

export type SessionTitleSource = "auto" | "manual" | "placeholder";
export type SessionStatus = "active" | "completed" | "error";

export interface SessionRecord {
  id: string;
  workspaceId: string;
  /**
   * 工作区根目录的绝对路径。v4 起记录。
   *
   * workspaceId 是路径的哈希，反查不出路径；排查「这个会话属于哪个文件夹」时
   * 只能靠这个字段，UI 的仓库树也用它做 tooltip。旧记录由仓库读取时按已知根补齐。
   */
  workspaceRoot?: string;
  grokSessionId?: string;
  title: string;
  titleSource: SessionTitleSource;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  modelId: string;
  /**
   * 模型所属的服务商。v3 起记录；更早的会话由迁移按 modelId 补上已知归属，
   * 补不上就留空，交给恢复流程提示用户重新配置，绝不猜一个顶上。
   */
  providerId?: string;
  localMode: string;
  serverMode?: string;
  status: SessionStatus;
  archived: boolean;
  pinned: boolean;
  messageCount: number;
  turnCount: number;
  activePlanId?: string;
  lastTurnId?: string;
  contextUsage?: ContextUsageRecord;
  /** 最近一条任务摘要，用于历史列表第二行。 */
  lastSummary?: string;
  /** 列表展示用的计数，真实状态仍以 turns.json 与磁盘哈希为准。 */
  pendingChanges: number;
  conflictChanges: number;
  hasUnfinishedPlan: boolean;
  schemaVersion: number;
}

export interface SessionRepositoryOptions {
  now?: () => number;
  onDamage?: (detail: string) => void;
  /** 工作区根目录绝对路径，用于新建记录与补齐 v3 及更早的旧记录。 */
  workspaceRoot?: string;
}

interface SessionIndex {
  sessionIds: string[];
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createSessionId(): string {
  return `ses-${randomBytes(8).toString("hex")}`;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validateSession(data: unknown): SessionRecord | undefined {
  if (!isRecordObject(data)) return undefined;
  if (typeof data.id !== "string" || data.id === "") return undefined;
  if (typeof data.workspaceId !== "string" || data.workspaceId === "") return undefined;
  const titleSource = data.titleSource === "manual" || data.titleSource === "auto" ? data.titleSource : "placeholder";
  const status: SessionStatus = data.status === "completed" || data.status === "error" ? data.status : "active";
  const now = numberOr(data.updatedAt, 0);
  return {
    id: data.id,
    workspaceId: data.workspaceId,
    ...(optionalString(data.workspaceRoot) ? { workspaceRoot: data.workspaceRoot as string } : {}),
    ...(optionalString(data.grokSessionId) ? { grokSessionId: data.grokSessionId as string } : {}),
    title: typeof data.title === "string" && data.title !== "" ? data.title : DEFAULT_TITLE,
    titleSource,
    createdAt: numberOr(data.createdAt, now),
    updatedAt: now,
    lastOpenedAt: numberOr(data.lastOpenedAt, now),
    modelId: typeof data.modelId === "string" ? data.modelId : "",
    ...(optionalString(data.providerId) ? { providerId: data.providerId as string } : {}),
    localMode: typeof data.localMode === "string" ? data.localMode : "ask",
    ...(optionalString(data.serverMode) ? { serverMode: data.serverMode as string } : {}),
    status,
    archived: data.archived === true,
    pinned: data.pinned === true,
    messageCount: numberOr(data.messageCount, 0),
    turnCount: numberOr(data.turnCount, 0),
    ...(optionalString(data.activePlanId) ? { activePlanId: data.activePlanId as string } : {}),
    ...(optionalString(data.lastTurnId) ? { lastTurnId: data.lastTurnId as string } : {}),
    ...(isRecordObject(data.contextUsage) ? { contextUsage: data.contextUsage as unknown as ContextUsageRecord } : {}),
    ...(optionalString(data.lastSummary) ? { lastSummary: data.lastSummary as string } : {}),
    pendingChanges: numberOr(data.pendingChanges, 0),
    conflictChanges: numberOr(data.conflictChanges, 0),
    hasUnfinishedPlan: data.hasUnfinishedPlan === true,
    schemaVersion: numberOr(data.schemaVersion, SCHEMA_VERSION),
  };
}

function validateIndex(data: unknown): SessionIndex | undefined {
  if (!isRecordObject(data)) return undefined;
  const ids = data.sessionIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return undefined;
  return { sessionIds: ids as string[] };
}

/** 固定的排在前面，其余按更新时间倒序。 */
export function sortSessions(records: readonly SessionRecord[]): SessionRecord[] {
  return [...records].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.updatedAt - left.updatedAt;
  });
}

/** 标题 / 摘要 / 模式本地过滤，不访问存储。 */
export function filterSessions(records: readonly SessionRecord[], query: string): SessionRecord[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...records];
  return records.filter((record) => {
    const haystack = [
      record.title,
      record.lastSummary ?? "",
      record.localMode,
      record.modelId,
      record.status,
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export class SessionRepository {
  private readonly now: () => number;
  private readonly onDamage: (detail: string) => void;
  private readonly workspaceRoot: string | undefined;
  /** 每个会话一条 patch 队列，见 patch() 的说明。 */
  private readonly patchQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly rootDirectory: string,
    private readonly workspaceId: string,
    private readonly fs: FileSystemPort,
    private readonly store: JsonStore,
    options: SessionRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.onDamage = options.onDamage ?? (() => undefined);
    this.workspaceRoot = options.workspaceRoot;
  }

  get directory(): string {
    return path.join(this.rootDirectory, this.workspaceId);
  }

  sessionDirectory(sessionId: string): string {
    return path.join(this.directory, sessionId);
  }

  private get indexFile(): string {
    return path.join(this.directory, "index.json");
  }

  private sessionFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "session.json");
  }

  async list(options: { includeArchived?: boolean } = {}): Promise<SessionRecord[]> {
    const ids = await this.sessionIds();
    const records: SessionRecord[] = [];
    for (const id of ids) {
      const record = await this.load(id);
      if (!record) continue;
      if (!options.includeArchived && record.archived) continue;
      records.push(record);
    }
    return sortSessions(records);
  }

  /**
   * 精确查出引用某个模型的会话。
   *
   * 与 filterSessions 的模糊文本搜索不同，这里必须精确匹配：删除模型前要给用户
   * 一个准确的数字，「大概有几个」不足以支撑删除决定。范围是当前工作区——
   * 会话按 workspaceId 隔离，跨工作区的引用查不到，这一点写进已知限制。
   */
  async findByModelId(modelId: string): Promise<SessionRecord[]> {
    const all = await this.list({ includeArchived: true });
    return all.filter((record) => record.modelId === modelId);
  }

  async load(sessionId: string): Promise<SessionRecord | undefined> {
    const result = await this.store.read<SessionRecord | undefined>(this.sessionFile(sessionId), {
      kind: "session",
      fallback: () => undefined,
      validate: validateSession,
    });
    this.reportDamage(`会话 ${sessionId}`, result.status, result.detail);
    const record = result.data;
    if (!record) return undefined;
    // 不同工作区的会话绝不混用：记录里的工作区标识必须与当前一致。
    if (record.workspaceId !== this.workspaceId) return undefined;
    // v3 及更早的记录没有 workspaceRoot。上面已经确认过归属，用已知根补齐是安全的；
    // 不额外写盘，下一次 patch 会顺带把它落下去。
    if (!record.workspaceRoot && this.workspaceRoot) record.workspaceRoot = this.workspaceRoot;
    return record;
  }

  async create(input: {
    modelId: string;
    localMode: string;
    title?: string;
    grokSessionId?: string;
    providerId?: string;
  }): Promise<SessionRecord> {
    const timestamp = this.now();
    const hasTitle = typeof input.title === "string" && input.title.trim() !== "";
    const record: SessionRecord = {
      id: createSessionId(),
      workspaceId: this.workspaceId,
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      ...(input.grokSessionId ? { grokSessionId: input.grokSessionId } : {}),
      title: hasTitle ? (input.title as string).trim().slice(0, MAX_TITLE_CHARS) : DEFAULT_TITLE,
      titleSource: hasTitle ? "manual" : "placeholder",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
      modelId: input.modelId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      localMode: input.localMode,
      status: "active",
      archived: false,
      pinned: false,
      messageCount: 0,
      turnCount: 0,
      pendingChanges: 0,
      conflictChanges: 0,
      hasUnfinishedPlan: false,
      schemaVersion: SCHEMA_VERSION,
    };
    await this.save(record);
    await this.addToIndex(record.id);
    return record;
  }

  async save(record: SessionRecord): Promise<void> {
    await this.store.write(this.sessionFile(record.id), "session", record);
  }

  /**
   * 局部更新：调用方只给要改的字段，updatedAt 自动推进。
   *
   * 「读—改—写」三步必须整体排队。并发进来的话两个 patch 会读到同一份底稿，
   * 后写的那个把先写的字段原样盖回去——丢的可能正是 grokSessionId 或 modelId
   * 这种会让下一次发送找不到会话、或者用错模型的关键字段。
   * 触发过一次：session/load 回放期间，带 void 的 contextUsage patch
   * 和发送路径里 await 的 patch 同时打到同一个会话上。
   */
  async patch(sessionId: string, patch: Partial<SessionRecord>): Promise<SessionRecord | undefined> {
    const previous = this.patchQueues.get(sessionId) ?? Promise.resolve();
    const mine = previous.then(() => this.patchOnce(sessionId, patch));
    const queued = mine.catch(() => undefined);

    this.patchQueues.set(sessionId, queued);
    try {
      return await mine;
    } finally {
      if (this.patchQueues.get(sessionId) === queued) this.patchQueues.delete(sessionId);
    }
  }

  private async patchOnce(
    sessionId: string,
    patch: Partial<SessionRecord>,
  ): Promise<SessionRecord | undefined> {
    const current = await this.load(sessionId);
    if (!current) return undefined;
    const next: SessionRecord = { ...current, ...patch, id: current.id, workspaceId: current.workspaceId };
    next.updatedAt = patch.updatedAt ?? this.now();
    await this.save(next);
    return next;
  }

  async rename(sessionId: string, title: string): Promise<SessionRecord | undefined> {
    const trimmed = title.trim();
    if (trimmed === "") return undefined;
    return this.patch(sessionId, {
      title: [...trimmed].slice(0, MAX_TITLE_CHARS).join(""),
      titleSource: "manual",
    });
  }

  /** 首轮结束后的自动标题；手动改过的标题不再被覆盖。 */
  async applyAutoTitle(sessionId: string, prompt: string): Promise<SessionRecord | undefined> {
    const current = await this.load(sessionId);
    if (!current) return undefined;
    if (!shouldApplyAutoTitle(current.titleSource)) return current;
    return this.patch(sessionId, { title: generateSessionTitle(prompt), titleSource: "auto" });
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<SessionRecord | undefined> {
    return this.patch(sessionId, { pinned });
  }

  async setArchived(sessionId: string, archived: boolean): Promise<SessionRecord | undefined> {
    return this.patch(sessionId, { archived });
  }

  async touch(sessionId: string): Promise<SessionRecord | undefined> {
    return this.patch(sessionId, { lastOpenedAt: this.now() });
  }

  /**
   * 删除只清理灵动 Code 自己的记录目录。
   * Grok Build 0.2.118 没有 session/close，也不去动它的数据目录。
   */
  async remove(sessionId: string): Promise<void> {
    await this.fs.removeDirectory(this.sessionDirectory(sessionId));
    const ids = await this.sessionIds();
    await this.writeIndex(ids.filter((id) => id !== sessionId));
  }

  async mostRecent(): Promise<SessionRecord | undefined> {
    const [first] = await this.list();
    return first;
  }

  private async sessionIds(): Promise<string[]> {
    const result = await this.store.read<SessionIndex>(this.indexFile, {
      kind: "session-index",
      fallback: () => ({ sessionIds: [] }),
      validate: validateIndex,
    });
    this.reportDamage("会话索引", result.status, result.detail);

    const scanned = await this.scanSessionDirectories();
    const known = new Set(result.data.sessionIds);
    const missing = scanned.filter((id) => !known.has(id));
    if (result.status !== "ok" || missing.length > 0) {
      // 索引缺失或落后于目录时按目录自愈，避免会话「消失」。
      const merged = [...result.data.sessionIds.filter((id) => scanned.includes(id)), ...missing];
      await this.writeIndex(merged);
      return merged;
    }
    return result.data.sessionIds.filter((id) => scanned.includes(id));
  }

  private async scanSessionDirectories(): Promise<string[]> {
    const entries = await this.fs.listEntries(this.directory);
    return entries.filter((entry) => entry.isDirectory && entry.name.startsWith("ses-")).map((entry) => entry.name);
  }

  private async addToIndex(sessionId: string): Promise<void> {
    const ids = await this.sessionIds();
    if (ids.includes(sessionId)) return;
    await this.writeIndex([...ids, sessionId]);
  }

  private async writeIndex(sessionIds: string[]): Promise<void> {
    await this.store.write(this.indexFile, "session-index", { sessionIds });
  }

  private reportDamage(label: string, status: LoadStatus, detail: string | undefined): void {
    if (status === "ok" || status === "missing") return;
    this.onDamage(`${label}：${detail ?? status}`);
  }
}
