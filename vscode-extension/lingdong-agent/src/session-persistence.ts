import * as path from "node:path";
import type { FileSystemPort } from "./file-system-port";
import type { HostToWebviewMessage, UiAgentMode } from "./messages";
import { ChangeTracker } from "./change-tracker";
import { toChangeList } from "./change-view";
import type { ContextUsageService } from "./context-usage";
import { JsonStore } from "./storage/json-store";
import { PermissionRuleRepository } from "./storage/permission-rule-repository";
import { PlanRepository } from "./storage/plan-repository";
import {
  SessionRepository,
  type SessionRecord,
} from "./storage/session-repository";
import {
  TranscriptRepository,
  toRestoreMessages,
} from "./storage/transcript-repository";
import { TurnRepository, toPersistedTurn } from "./storage/turn-repository";
import { SnapshotStore, workspaceHash } from "./snapshot-store";

/**
 * 工作区级会话持久化门面：把多个 JSON 仓库与快照/变更重判绑在一起，
 * AgentController 只通过这里读写，避免存储细节散落在 UI 状态机里。
 */

export interface SessionPersistenceOptions {
  globalStorageRoot: string;
  workspaceRoot: string;
  fs: FileSystemPort;
  onDamage?: (detail: string) => void;
  now?: () => number;
}

export class SessionPersistence {
  readonly workspaceId: string;
  readonly store: JsonStore;
  readonly sessions: SessionRepository;
  readonly transcript: TranscriptRepository;
  readonly turns: TurnRepository;
  readonly plans: PlanRepository;
  /** 「以后都允许」规则；按工作区隔离，与会话无关。 */
  readonly permissionRules: PermissionRuleRepository;
  private readonly onDamage: (detail: string) => void;

  constructor(private readonly options: SessionPersistenceOptions) {
    this.workspaceId = workspaceHash(options.workspaceRoot);
    this.onDamage = options.onDamage ?? (() => undefined);
    this.store = new JsonStore(options.fs, options.now ? { now: options.now } : {});
    const sessionsRoot = path.join(options.globalStorageRoot, "agent-sessions");
    this.sessions = new SessionRepository(
      sessionsRoot,
      this.workspaceId,
      options.fs,
      this.store,
      {
        onDamage: this.onDamage,
        workspaceRoot: options.workspaceRoot,
        ...(options.now ? { now: options.now } : {}),
      },
    );
    const placeholder = path.join(this.sessions.directory, "_none", "transcript.json");
    this.transcript = new TranscriptRepository(placeholder, this.store, { onDamage: this.onDamage });
    this.turns = new TurnRepository(path.join(this.sessions.directory, "_none", "turns.json"), this.store, {
      onDamage: this.onDamage,
    });
    this.plans = new PlanRepository(path.join(this.sessions.directory, "_none", "plans.json"), this.store, {
      onDamage: this.onDamage,
      ...(options.now ? { now: options.now } : {}),
    });
    // 权限规则按工作区存一份，和会话目录平级：换会话不该让用户重新授权一遍。
    this.permissionRules = new PermissionRuleRepository(
      path.join(options.globalStorageRoot, "agent-permissions", `${this.workspaceId}.json`),
      this.store,
      { onDamage: this.onDamage },
    );
  }

  sessionFiles(sessionId: string): {
    transcript: string;
    turns: string;
    plans: string;
  } {
    const directory = this.sessions.sessionDirectory(sessionId);
    return {
      transcript: path.join(directory, "transcript.json"),
      turns: path.join(directory, "turns.json"),
      plans: path.join(directory, "plans.json"),
    };
  }

  async flush(): Promise<void> {
    await Promise.all([this.transcript.flush(), this.turns.flush(), this.plans.flush()]);
  }

  async openSessionFiles(sessionId: string): Promise<void> {
    const files = this.sessionFiles(sessionId);
    await this.transcript.open(files.transcript);
    await this.turns.open(files.turns);
    await this.plans.open(files.plans);
  }

  /**
   * 打开会话文件、失效未决权限、从磁盘重判变更，并产出面板恢复消息。
   */
  async prepareRestore(input: {
    record: SessionRecord;
    tracker: ChangeTracker;
    snapshots: SnapshotStore;
    usage: ContextUsageService;
  }): Promise<{
    record: SessionRecord;
    restore: Extract<HostToWebviewMessage, { type: "restore" }>;
    changesTurnId?: string;
  }> {
    await this.flush();
    await this.openSessionFiles(input.record.id);
    this.transcript.expirePendingPermissions();
    this.transcript.expirePendingQuestions();
    this.transcript.interruptRunningTimelines();
    await input.snapshots.hydrate(input.record.grokSessionId ?? input.record.id);
    // 快照目录按 Grok sessionId 分层；本地 id 与 grok id 不同时两边都试一次。
    if (input.record.grokSessionId && input.record.grokSessionId !== input.record.id) {
      await input.snapshots.hydrate(input.record.grokSessionId);
    }
    input.tracker.rehydrate(this.turns.turns);
    const affected = await input.tracker.reevaluate();
    for (const turn of affected) {
      this.turns.updateChanges(turn.turnId, turn.changedFiles, turn.status);
    }
    await this.turns.flush();
    await this.transcript.flush();

    const pendingChanges = this.turns.pendingCount;
    const conflictChanges = this.turns.conflictCount;
    const activePlan = this.plans.active;
    const lastTurnId = input.record.lastTurnId ?? this.turns.turns.at(-1)?.turnId;
    const patched = await this.sessions.patch(input.record.id, {
      pendingChanges,
      conflictChanges,
      hasUnfinishedPlan: activePlan !== undefined,
      ...(activePlan ? { activePlanId: activePlan.id } : {}),
      ...(lastTurnId ? { lastTurnId } : {}),
    });
    const record = patched ?? input.record;
    input.usage.restore(record.contextUsage);

    const entries = toRestoreMessages(this.transcript.entries);
    const restoreTurnId = record.lastTurnId ?? lastTurnId;
    if (restoreTurnId) {
      const turn = input.tracker.turn(restoreTurnId);
      if (turn && turn.changedFiles.length > 0) {
        entries.push({ type: "changes", view: toChangeList(turn) });
      }
    }

    return {
      record,
      restore: {
        type: "restore",
        sessionId: record.id,
        model: record.modelId || "deepseek-v4-flash",
        mode: (["ask", "plan", "agent", "auto", "debug"].includes(record.localMode)
          ? record.localMode
          : "ask") as UiAgentMode,
        entries,
        title: record.title,
      },
      ...(restoreTurnId ? { changesTurnId: restoreTurnId } : {}),
    };
  }

  async syncTurn(turn: Parameters<typeof toPersistedTurn>[0], extra?: Parameters<typeof toPersistedTurn>[1]): Promise<void> {
    this.turns.upsert(toPersistedTurn(turn, extra));
    await this.turns.flush();
  }

  async syncSessionCounters(sessionId: string, patch: Partial<SessionRecord>): Promise<SessionRecord | undefined> {
    return this.sessions.patch(sessionId, {
      ...patch,
      pendingChanges: this.turns.pendingCount,
      conflictChanges: this.turns.conflictCount,
      hasUnfinishedPlan: this.plans.active !== undefined,
    });
  }
}
