import type { AgentTurn, ChangeKind, ChangeStatus, ChangedFile, TurnStatus } from "../change-tracker";
import { JsonStore, type LoadStatus } from "./json-store";

/**
 * 轮次与变更摘要。只存摘要与哈希，文件原文继续由 SnapshotStore 管；
 * 绝对路径不落盘，恢复时用当前工作区根目录 + 相对路径重新拼。
 */

export type VerificationStatus = "unknown" | "verified" | "unverified";

export interface PersistedChangedFile {
  id: string;
  relativePath: string;
  previousRelativePath?: string;
  kind: ChangeKind;
  beforeSha256: string;
  afterSha256: string;
  size: number;
  status: ChangeStatus;
  restorable: boolean;
  conflictReason?: string;
  updatedAt: number;
}

export interface PersistedTurn {
  turnId: string;
  sessionId: string;
  index: number;
  prompt: string;
  contextLabels: string[];
  mode: string;
  startedAt: number;
  completedAt?: number;
  status: TurnStatus;
  stopReason?: string;
  verificationStatus: VerificationStatus;
  changedFiles: PersistedChangedFile[];
}

const CHANGE_KINDS = new Set<ChangeKind>(["create", "modify", "delete", "rename"]);
const CHANGE_STATUSES = new Set<ChangeStatus>(["pending", "accepted", "rejected", "conflict", "restored"]);
const TURN_STATUSES = new Set<TurnStatus>(["running", "completed", "cancelled", "restored", "partially_restored"]);

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function toPersistedChange(change: ChangedFile): PersistedChangedFile {
  return {
    id: change.id,
    relativePath: change.relativePath,
    ...(change.previousRelativePath ? { previousRelativePath: change.previousRelativePath } : {}),
    kind: change.kind,
    beforeSha256: change.beforeSha256,
    afterSha256: change.afterSha256,
    size: change.size,
    status: change.status,
    restorable: change.restorable,
    ...(change.conflictReason ? { conflictReason: change.conflictReason } : {}),
    updatedAt: change.updatedAt,
  };
}

export function toPersistedTurn(
  turn: AgentTurn,
  extra: { completedAt?: number; stopReason?: string; verificationStatus?: VerificationStatus } = {},
): PersistedTurn {
  return {
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    index: turn.index,
    prompt: turn.prompt,
    contextLabels: [...turn.contextLabels],
    mode: turn.mode,
    startedAt: turn.startedAt,
    ...(extra.completedAt === undefined ? {} : { completedAt: extra.completedAt }),
    status: turn.status,
    ...(extra.stopReason ? { stopReason: extra.stopReason } : {}),
    verificationStatus: extra.verificationStatus ?? "unknown",
    changedFiles: turn.changedFiles.map(toPersistedChange),
  };
}

function validateChange(data: unknown): PersistedChangedFile | undefined {
  if (!isRecordObject(data) || typeof data.id !== "string" || typeof data.relativePath !== "string") return undefined;
  const kind = CHANGE_KINDS.has(data.kind as ChangeKind) ? (data.kind as ChangeKind) : "modify";
  const status = CHANGE_STATUSES.has(data.status as ChangeStatus) ? (data.status as ChangeStatus) : "pending";
  return {
    id: data.id,
    relativePath: data.relativePath,
    ...(typeof data.previousRelativePath === "string" ? { previousRelativePath: data.previousRelativePath } : {}),
    kind,
    beforeSha256: stringOr(data.beforeSha256, ""),
    afterSha256: stringOr(data.afterSha256, ""),
    size: numberOr(data.size, 0),
    status,
    restorable: data.restorable === true,
    ...(typeof data.conflictReason === "string" ? { conflictReason: data.conflictReason } : {}),
    updatedAt: numberOr(data.updatedAt, 0),
  };
}

function validateTurn(data: unknown): PersistedTurn | undefined {
  if (!isRecordObject(data) || typeof data.turnId !== "string" || typeof data.sessionId !== "string") return undefined;
  const changes = Array.isArray(data.changedFiles) ? data.changedFiles : [];
  const verification = data.verificationStatus;
  return {
    turnId: data.turnId,
    sessionId: data.sessionId,
    index: numberOr(data.index, 1),
    prompt: stringOr(data.prompt, ""),
    contextLabels: Array.isArray(data.contextLabels)
      ? data.contextLabels.filter((label): label is string => typeof label === "string")
      : [],
    mode: stringOr(data.mode, "ask"),
    startedAt: numberOr(data.startedAt, 0),
    ...(typeof data.completedAt === "number" ? { completedAt: data.completedAt } : {}),
    status: TURN_STATUSES.has(data.status as TurnStatus) ? (data.status as TurnStatus) : "completed",
    ...(typeof data.stopReason === "string" ? { stopReason: data.stopReason } : {}),
    verificationStatus:
      verification === "verified" || verification === "unverified" ? verification : "unknown",
    changedFiles: changes
      .map(validateChange)
      .filter((change): change is PersistedChangedFile => change !== undefined),
  };
}

function validateTurns(data: unknown): { turns: PersistedTurn[] } | undefined {
  if (!isRecordObject(data) || !Array.isArray(data.turns)) return undefined;
  return {
    turns: data.turns.map(validateTurn).filter((turn): turn is PersistedTurn => turn !== undefined),
  };
}

export interface TurnRepositoryOptions {
  onDamage?: (detail: string) => void;
}

export class TurnRepository {
  private turnsValue: PersistedTurn[] = [];
  private readonly onDamage: (detail: string) => void;
  private queue: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private file: string,
    private readonly store: JsonStore,
    options: TurnRepositoryOptions = {},
  ) {
    this.onDamage = options.onDamage ?? (() => undefined);
  }

  get turns(): PersistedTurn[] {
    return this.turnsValue.map((turn) => ({ ...turn, changedFiles: turn.changedFiles.map((change) => ({ ...change })) }));
  }

  get pendingCount(): number {
    return this.countByStatus("pending");
  }

  get conflictCount(): number {
    return this.countByStatus("conflict");
  }

  countByStatus(status: ChangeStatus): number {
    return this.turnsValue.reduce(
      (total, turn) => total + turn.changedFiles.filter((change) => change.status === status).length,
      0,
    );
  }

  async open(file: string): Promise<LoadStatus> {
    await this.flush();
    this.file = file;
    const result = await this.store.read<{ turns: PersistedTurn[] }>(file, {
      kind: "turns",
      fallback: () => ({ turns: [] }),
      validate: validateTurns,
    });
    if (result.status !== "ok" && result.status !== "missing") {
      this.onDamage(`轮次记录：${result.detail ?? result.status}`);
    }
    this.turnsValue = result.data.turns;
    this.dirty = false;
    return result.status;
  }

  upsert(turn: PersistedTurn): void {
    const index = this.turnsValue.findIndex((entry) => entry.turnId === turn.turnId);
    if (index === -1) this.turnsValue.push(turn);
    else this.turnsValue[index] = turn;
    this.dirty = true;
  }

  /** 只有变更状态改变的场景：接受、拒绝、撤销后回写。 */
  updateChanges(turnId: string, changes: readonly ChangedFile[], status?: TurnStatus): void {
    const turn = this.turnsValue.find((entry) => entry.turnId === turnId);
    if (!turn) return;
    turn.changedFiles = changes.map(toPersistedChange);
    if (status) turn.status = status;
    this.dirty = true;
  }

  remove(turnId: string): void {
    const next = this.turnsValue.filter((turn) => turn.turnId !== turnId);
    if (next.length === this.turnsValue.length) return;
    this.turnsValue = next;
    this.dirty = true;
  }

  clear(): void {
    this.turnsValue = [];
    this.dirty = true;
  }

  /** 全部文件都已接受或已恢复的轮次，快照可以回收。 */
  removableTurnIds(): string[] {
    return this.turnsValue
      .filter(
        (turn) =>
          turn.changedFiles.length > 0 &&
          turn.changedFiles.every((change) => change.status === "accepted" || change.status === "restored"),
      )
      .map((turn) => turn.turnId);
  }

  flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await this.store.write(this.file, "turns", { turns: this.turnsValue });
    });
    return this.queue;
  }
}
