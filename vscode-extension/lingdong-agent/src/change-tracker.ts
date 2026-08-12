import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { FileSystemPort } from "./file-system-port";
import { SnapshotError, SnapshotStore, sha256, type SnapshotRecord } from "./snapshot-store";
import type { PersistedTurn } from "./storage/turn-repository";
import { isInsideWorkspace } from "./workspace-guard";

export type ChangeKind = "create" | "modify" | "delete" | "rename";
export type ChangeStatus = "pending" | "accepted" | "rejected" | "conflict" | "restored";
export type TurnStatus = "running" | "completed" | "cancelled" | "restored" | "partially_restored";

export interface ChangedFile {
  id: string;
  turnId: string;
  relativePath: string;
  absolutePath: string;
  /** 重命名时记录原路径。 */
  previousRelativePath?: string;
  kind: ChangeKind;
  /** 修改前内容哈希；文件原本不存在时为空。 */
  beforeSha256: string;
  /** 最近一次探测到的修改后哈希；文件已被删除时为空。 */
  afterSha256: string;
  size: number;
  status: ChangeStatus;
  /** 没有修改前快照时不能自动恢复，只能查看。 */
  restorable: boolean;
  conflictReason?: string;
  updatedAt: number;
}

export interface AgentTurn {
  turnId: string;
  sessionId: string;
  index: number;
  startedAt: number;
  mode: string;
  prompt: string;
  contextLabels: string[];
  changedFiles: ChangedFile[];
  status: TurnStatus;
}

export interface RestoreOutcome {
  changeId: string;
  relativePath: string;
  status: "restored" | "conflict" | "skipped";
  reason?: string;
}

export interface RestoreSummary {
  turnId: string;
  restored: number;
  conflicts: number;
  skipped: number;
  message: string;
}

export interface ChangeTrackerOptions {
  workspaceRoot: string;
  fs: FileSystemPort;
  snapshots: SnapshotStore;
}

export const CONFLICT_MESSAGE = "文件已在 Agent 修改后发生其他变化，不能安全自动恢复";
export const SNAPSHOT_MISSING_MESSAGE = "没有修改前快照，无法自动恢复";

function relativeKey(relativePath: string): string {
  return relativePath.toLowerCase();
}

function createId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

/**
 * 按轮次记录 Agent 改了哪些文件，并在写入之前保存快照。
 * 所有判断都基于宿主自己算的 sha256，不依赖 Grok 给的 diff 片段：
 * tool_call_update 里的 oldText/newText 只是被替换的一小段，无法用来还原文件。
 */
export class ChangeTracker {
  private readonly turnsById = new Map<string, AgentTurn>();
  private readonly order: string[] = [];
  private currentTurnId: string | undefined;

  constructor(private readonly options: ChangeTrackerOptions) {}

  get current(): AgentTurn | undefined {
    return this.currentTurnId ? this.turnsById.get(this.currentTurnId) : undefined;
  }

  get turns(): AgentTurn[] {
    return this.order.map((id) => this.turnsById.get(id)).filter((turn): turn is AgentTurn => turn !== undefined);
  }

  turn(turnId: string): AgentTurn | undefined {
    return this.turnsById.get(turnId);
  }

  /** 从持久化摘要重建内存轮次；running 在重启后一律视为 completed。 */
  rehydrate(turns: readonly PersistedTurn[]): void {
    this.turnsById.clear();
    this.order.length = 0;
    this.currentTurnId = undefined;

    for (const persisted of turns) {
      const turn: AgentTurn = {
        turnId: persisted.turnId,
        sessionId: persisted.sessionId,
        index: persisted.index,
        startedAt: persisted.startedAt,
        mode: persisted.mode,
        prompt: persisted.prompt,
        contextLabels: [...persisted.contextLabels],
        status: persisted.status === "running" ? "completed" : persisted.status,
        changedFiles: persisted.changedFiles.map((change) => ({
          id: change.id,
          turnId: persisted.turnId,
          relativePath: change.relativePath,
          absolutePath: path.resolve(this.options.workspaceRoot, change.relativePath),
          ...(change.previousRelativePath ? { previousRelativePath: change.previousRelativePath } : {}),
          kind: change.kind,
          beforeSha256: change.beforeSha256,
          afterSha256: change.afterSha256,
          size: change.size,
          status: change.status,
          restorable: change.restorable,
          ...(change.conflictReason ? { conflictReason: change.conflictReason } : {}),
          updatedAt: change.updatedAt,
        })),
      };
      this.turnsById.set(turn.turnId, turn);
      this.order.push(turn.turnId);
    }
  }

  /**
   * 重算磁盘哈希并更新 pending/conflict/restorable。
   * 快照缺失时 restorable=false；原 pending 会标为 conflict。
   * 最后消化被后轮覆盖的同路径旧变更，避免侧边栏堆出虚假「N 个冲突」。
   */
  async reevaluate(turnId?: string): Promise<AgentTurn[]> {
    const targets = turnId
      ? [this.turnsById.get(turnId)].filter((turn): turn is AgentTurn => turn !== undefined)
      : this.turns;
    const affected = new Map<string, AgentTurn>();

    for (const turn of targets) {
      let dirty = false;
      for (const change of turn.changedFiles) {
        const snapshotPath = change.previousRelativePath ?? change.relativePath;
        const snapshot = this.options.snapshots.get(turn.turnId, snapshotPath);

        if (change.status === "accepted" || change.status === "restored") {
          const restorable = snapshot !== undefined;
          if (change.restorable !== restorable) {
            change.restorable = restorable;
            dirty = true;
          }
          continue;
        }

        if (change.status !== "pending" && change.status !== "conflict") continue;

        if (snapshot === undefined) {
          if (change.restorable !== false) {
            change.restorable = false;
            dirty = true;
          }
          if (change.status === "pending") {
            change.status = "conflict";
            change.conflictReason = SNAPSHOT_MISSING_MESSAGE;
            change.updatedAt = Date.now();
            dirty = true;
          }
          continue;
        }

        if (!change.restorable) {
          change.restorable = true;
          dirty = true;
        }

        const currentHash = await this.hashOf(change.absolutePath);
        if (currentHash !== change.afterSha256) {
          if (change.status !== "conflict" || change.conflictReason !== CONFLICT_MESSAGE) {
            change.status = "conflict";
            change.conflictReason = CONFLICT_MESSAGE;
            change.updatedAt = Date.now();
            dirty = true;
          }
        }
      }
      if (dirty) affected.set(turn.turnId, turn);
    }

    for (const turn of this.digestSuperseded()) affected.set(turn.turnId, turn);
    return [...affected.values()];
  }

  /**
   * 同一路径若已被更后一轮记录，前轮的 pending/conflict 自动视为「保留现状」并消化掉。
   * 多轮反复改 models.html 时，否则会留下一串「文件已在 Agent 修改后发生其他变化」假冲突。
   */
  digestSuperseded(): AgentTurn[] {
    const latestByPath = new Map<string, { turnIndex: number; changeId: string }>();
    for (const turn of this.turns) {
      for (const change of turn.changedFiles) {
        const key = relativeKey(change.relativePath);
        const prev = latestByPath.get(key);
        if (!prev || turn.index > prev.turnIndex) {
          latestByPath.set(key, { turnIndex: turn.index, changeId: change.id });
        }
      }
    }

    const affected: AgentTurn[] = [];
    for (const turn of this.turns) {
      let dirty = false;
      for (const change of turn.changedFiles) {
        if (change.status !== "pending" && change.status !== "conflict") continue;
        const latest = latestByPath.get(relativeKey(change.relativePath));
        if (!latest || latest.changeId === change.id) continue;
        change.status = "accepted";
        delete change.conflictReason;
        change.updatedAt = Date.now();
        dirty = true;
      }
      if (dirty) affected.push(turn);
    }
    return affected;
  }

  find(changeId: string): { turn: AgentTurn; change: ChangedFile } | undefined {
    for (const turn of this.turns) {
      const change = turn.changedFiles.find((entry) => entry.id === changeId);
      if (change) return { turn, change };
    }
    return undefined;
  }

  startTurn(input: { sessionId: string; mode: string; prompt: string; contextLabels: string[] }): AgentTurn {
    const index = this.order.length + 1;
    const turn: AgentTurn = {
      turnId: `turn-${index}-${randomBytes(4).toString("hex")}`,
      sessionId: input.sessionId,
      index,
      startedAt: Date.now(),
      mode: input.mode,
      prompt: input.prompt,
      contextLabels: input.contextLabels,
      changedFiles: [],
      status: "running",
    };
    this.turnsById.set(turn.turnId, turn);
    this.order.push(turn.turnId);
    this.currentTurnId = turn.turnId;
    return turn;
  }

  /**
   * 写入类权限放行前的准备动作：为每个工作区内目标保存快照。
   * 任何一个目标快照失败都抛错，由调用方把该操作改判为拒绝。
   */
  async prepare(targets: readonly string[]): Promise<SnapshotRecord[]> {
    const turn = this.current;
    if (!turn) return [];
    const saved: SnapshotRecord[] = [];
    for (const target of targets) {
      const relative = this.relativeOf(target);
      // Grok 会写自己 session 目录下的 plan.md，工作区外的路径一律忽略。
      if (relative === undefined) continue;
      saved.push(await this.options.snapshots.capture(turn.sessionId, turn.turnId, relative));
    }
    return saved;
  }

  /** 收到 file_changed 后刷新该文件的当前状态；没有快照的改动只展示不参与恢复。 */
  async noteChanged(target: string): Promise<ChangedFile | undefined> {
    const turn = this.current;
    if (!turn) return undefined;
    const relative = this.relativeOf(target);
    if (relative === undefined) return undefined;
    return this.refresh(turn, relative);
  }

  /** 轮次结束：刷新所有文件的最终状态，合并重命名，并落定轮次状态。 */
  async finalize(status: Exclude<TurnStatus, "running">): Promise<AgentTurn | undefined> {
    const turn = this.current;
    if (!turn) return undefined;

    for (const relative of this.options.snapshots.records(turn.turnId).map((record) => record.relativePath)) {
      await this.refresh(turn, relative);
    }
    for (const change of turn.changedFiles) {
      if (change.status === "pending") await this.updateAfterState(change);
    }
    this.mergeRenames(turn);
    turn.changedFiles = turn.changedFiles.filter((change) => change.kind !== "modify" || change.beforeSha256 !== change.afterSha256);
    turn.status = status;
    this.currentTurnId = undefined;
    return turn;
  }

  async accept(changeId: string): Promise<ChangedFile | undefined> {
    const found = this.find(changeId);
    if (!found || found.change.status !== "pending") return undefined;
    found.change.status = "accepted";
    found.change.updatedAt = Date.now();
    return found.change;
  }

  async acceptAll(turnId: string): Promise<number> {
    const turn = this.turnsById.get(turnId);
    if (!turn) return 0;
    let count = 0;
    for (const change of turn.changedFiles) {
      // conflict 必须人工确认，接受全部不碰它。
      if (change.status !== "pending") continue;
      change.status = "accepted";
      change.updatedAt = Date.now();
      count += 1;
    }
    return count;
  }

  /**
   * 拒绝单个文件：先核对当前内容是否仍是 Agent 留下的版本，
   * 不一致就标记冲突，绝不覆盖用户后来的改动。
   */
  async reject(changeId: string): Promise<RestoreOutcome> {
    const found = this.find(changeId);
    if (!found) return { changeId, relativePath: "", status: "skipped", reason: "该变更已不存在" };
    const { turn, change } = found;
    if (change.status !== "pending" && change.status !== "conflict") {
      return { changeId, relativePath: change.relativePath, status: "skipped", reason: "该变更已处理" };
    }
    if (!change.restorable) {
      change.status = "conflict";
      change.conflictReason = SNAPSHOT_MISSING_MESSAGE;
      return { changeId, relativePath: change.relativePath, status: "conflict", reason: change.conflictReason };
    }

    const currentHash = await this.hashOf(change.absolutePath);
    if (currentHash !== change.afterSha256) {
      change.status = "conflict";
      change.conflictReason = CONFLICT_MESSAGE;
      change.updatedAt = Date.now();
      return { changeId, relativePath: change.relativePath, status: "conflict", reason: CONFLICT_MESSAGE };
    }

    try {
      await this.restoreFile(turn, change);
    } catch (error) {
      change.status = "conflict";
      change.conflictReason = `恢复失败：${error instanceof Error ? error.message : String(error)}`;
      return { changeId, relativePath: change.relativePath, status: "conflict", reason: change.conflictReason };
    }
    change.status = "restored";
    change.updatedAt = Date.now();
    delete change.conflictReason;
    return { changeId, relativePath: change.relativePath, status: "restored" };
  }

  /** 拒绝全部 / 撤销本轮共用：逐个校验哈希，已接受的不动，重复执行幂等。 */
  async undoTurn(turnId: string): Promise<RestoreSummary> {
    const turn = this.turnsById.get(turnId);
    if (!turn) {
      return { turnId, restored: 0, conflicts: 0, skipped: 0, message: "该轮次已不存在。" };
    }
    let restored = 0;
    let conflicts = 0;
    let skipped = 0;
    for (const change of turn.changedFiles) {
      if (change.status === "accepted" || change.status === "restored") {
        skipped += 1;
        continue;
      }
      const outcome = await this.reject(change.id);
      if (outcome.status === "restored") restored += 1;
      else if (outcome.status === "conflict") conflicts += 1;
      else skipped += 1;
    }
    turn.status = conflicts > 0 ? "partially_restored" : "restored";
    return {
      turnId,
      restored,
      conflicts,
      skipped,
      message: conflicts > 0
        ? `已恢复 ${restored} 个文件，${conflicts} 个文件存在冲突，未自动覆盖。`
        : `已恢复 ${restored} 个文件。`,
    };
  }

  /** 冲突文件：保留用户当前的内容，标记为已接受，不再参与恢复。 */
  async keepCurrent(changeId: string): Promise<ChangedFile | undefined> {
    const found = this.find(changeId);
    if (!found) return undefined;
    found.change.status = "accepted";
    delete found.change.conflictReason;
    found.change.updatedAt = Date.now();
    return found.change;
  }

  /**
   * 冲突文件：把修改前内容另存为恢复副本，当前文件保持不动。
   * 副本仍然要落在工作区内，越界一律不写。
   */
  async createRecoveryCopy(changeId: string): Promise<string | undefined> {
    const found = this.find(changeId);
    if (!found) return undefined;
    const before = await this.options.snapshots.read(
      found.turn.turnId,
      found.change.previousRelativePath ?? found.change.relativePath,
    );
    if (!before) return undefined;
    const target = `${found.change.absolutePath}.lingdong-before`;
    if (!isInsideWorkspace(this.options.workspaceRoot, target)) return undefined;
    await this.options.fs.write(target, before);
    return path.relative(this.options.workspaceRoot, target).replace(/\\/g, "/");
  }

  /** 供 Diff 使用：读取修改前内容，文件原本不存在时返回空字符串。 */
  async snapshotText(turnId: string, relativePath: string): Promise<string> {
    const bytes = await this.options.snapshots.read(turnId, relativePath);
    return bytes ? Buffer.from(bytes).toString("utf8") : "";
  }

  private async restoreFile(turn: AgentTurn, change: ChangedFile): Promise<void> {
    const before = await this.options.snapshots.read(turn.turnId, change.previousRelativePath ?? change.relativePath);
    switch (change.kind) {
      case "create":
        await this.options.fs.remove(change.absolutePath);
        return;
      case "delete":
      case "modify":
        if (!before) throw new SnapshotError("缺少修改前快照");
        await this.options.fs.write(change.absolutePath, before);
        return;
      case "rename": {
        if (!before) throw new SnapshotError("缺少修改前快照");
        const original = path.resolve(this.options.workspaceRoot, change.previousRelativePath ?? "");
        await this.options.fs.write(original, before);
        await this.options.fs.remove(change.absolutePath);
        return;
      }
      default:
        return;
    }
  }

  private async refresh(turn: AgentTurn, relativePath: string): Promise<ChangedFile | undefined> {
    const absolute = path.resolve(this.options.workspaceRoot, relativePath);
    const snapshot = this.options.snapshots.get(turn.turnId, relativePath);
    const existing = turn.changedFiles.find((entry) => relativeKey(entry.relativePath) === relativeKey(relativePath));
    const change: ChangedFile = existing ?? {
      id: createId("chg"),
      turnId: turn.turnId,
      relativePath,
      absolutePath: absolute,
      kind: "modify",
      beforeSha256: snapshot?.sha256 ?? "",
      afterSha256: "",
      size: 0,
      status: "pending",
      restorable: snapshot !== undefined,
      updatedAt: Date.now(),
    };
    if (!existing) turn.changedFiles.push(change);
    if (change.status !== "pending") return change;

    await this.updateAfterState(change, snapshot);
    return change;
  }

  private async updateAfterState(change: ChangedFile, snapshotHint?: SnapshotRecord): Promise<void> {
    const snapshot = snapshotHint ?? this.options.snapshots.get(change.turnId, change.relativePath);
    const bytes = await this.options.fs.read(change.absolutePath);
    const existedBefore = snapshot ? snapshot.existed : change.beforeSha256 !== "";

    change.beforeSha256 = snapshot?.sha256 ?? change.beforeSha256;
    change.restorable = snapshot !== undefined;
    change.afterSha256 = bytes ? sha256(bytes) : "";
    change.size = bytes?.byteLength ?? 0;
    change.kind = existedBefore ? (bytes ? "modify" : "delete") : "create";
    change.updatedAt = Date.now();
  }

  /** Grok 的重命名会拆成「删除旧文件 + 新建新文件」，内容一致时在这里合并回一条。 */
  private mergeRenames(turn: AgentTurn): void {
    const deletions = turn.changedFiles.filter((change) => change.kind === "delete" && change.status === "pending");
    if (deletions.length === 0) return;

    for (const created of turn.changedFiles.filter((change) => change.kind === "create" && change.status === "pending")) {
      const match = deletions.find(
        (deleted) => deleted.beforeSha256 !== "" && deleted.beforeSha256 === created.afterSha256,
      );
      if (!match) continue;
      created.kind = "rename";
      created.previousRelativePath = match.relativePath;
      created.beforeSha256 = match.beforeSha256;
      turn.changedFiles = turn.changedFiles.filter((change) => change.id !== match.id);
      deletions.splice(deletions.indexOf(match), 1);
    }
  }

  private async hashOf(absolutePath: string): Promise<string> {
    const bytes = await this.options.fs.read(absolutePath);
    return bytes ? sha256(bytes) : "";
  }

  private relativeOf(target: string): string | undefined {
    const root = this.options.workspaceRoot;
    const absolute = path.resolve(root, target);
    if (!isInsideWorkspace(root, absolute)) return undefined;
    const relative = path.relative(root, absolute).replace(/\\/g, "/").replace(/^\.\//, "");
    return relative === "" ? undefined : relative;
  }
}
