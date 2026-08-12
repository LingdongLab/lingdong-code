import * as path from "node:path";
import * as vscode from "vscode";
import type {
  HunkActionKind,
  HunkActionResult,
  HunkFilePayload,
  WriteGuardInput,
  WriteGuardResult,
} from "@lingdong/agent-runtime";
import { CONFLICT_MESSAGE, ChangeTracker, type AgentTurn } from "../change-tracker";
import { toChangeList, type HunkView, type LineDiffLookup } from "../change-view";
import { openChangeDiff } from "../diff-provider";
import { computeDiffText } from "../diff-text";
import type { FileSystemPort } from "../file-system-port";
import type { HostToWebviewMessage } from "../messages";
import type { SessionPersistence } from "../session-persistence";
import { SnapshotStore } from "../snapshot-store";
import type { UiStateMachine } from "../ui-state";
import type { AgentWorkspaceStore } from "../workspace-store";
import { isInsideWorkspace } from "../workspace-guard";
import { samePath } from "../workspace-history";

/**
 * 文件变更编排：快照、接受/拒绝/撤销、冲突处理与轮次结算。
 * 与 VS Code API 无关；打开 Diff 与冲突弹窗留在控制器侧。
 */

export interface ChangeFacadeDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  postState(detail?: string): void;
  readonly ui: UiStateMachine;
  readonly store: AgentWorkspaceStore;
  readonly fs: FileSystemPort;
  persistence(): SessionPersistence | undefined;
  flushPersistence(): void;
  /** 快照根目录，通常位于扩展 globalStorage 下。 */
  snapshotRoot(): string;
  /**
   * 某个文件本轮的行级增删，由时间线那边算好。
   * 缺省或返回 undefined 就是没有可靠数据，摘要卡上不显示 +N/-N。
   */
  lineDiff?: LineDiffLookup;
  /**
   * Grok 逐 hunk 审阅通道（可选）。缺省或调用失败时面板退回整段 diff +
   * 快照机制——hunk 操作只在 Grok 真支持时出现，快照永远是兜底。
   */
  hunkApi?: {
    getHunks(absolutePath: string): Promise<HunkFilePayload | undefined>;
    hunkAction(hunkId: string, action: HunkActionKind): Promise<HunkActionResult>;
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeText(data: Uint8Array | undefined): string {
  return data ? new TextDecoder().decode(data) : "";
}

/** Windows 上大小写与尾随分隔符都可能不同，同一个目录不该被判成换了根。 */
function isSameRoot(left: string | undefined, right: string): boolean {
  return left !== undefined && samePath(left, right);
}

export class ChangeFacade {
  private trackerValue: ChangeTracker | undefined;
  private snapshotsValue: SnapshotStore | undefined;
  private workspaceRootValue: string | undefined;
  /** 追踪相关的文件读写串行执行，避免同一文件的多次事件互相覆盖。 */
  private queue: Promise<void> = Promise.resolve();
  private lastTurnIdValue: string | undefined;
  private readonly turnChangedFiles = new Set<string>();

  constructor(private readonly deps: ChangeFacadeDeps) {}

  get tracker(): ChangeTracker | undefined { return this.trackerValue; }
  get snapshots(): SnapshotStore | undefined { return this.snapshotsValue; }
  get lastTurnId(): string | undefined { return this.lastTurnIdValue; }
  set lastTurnId(value: string | undefined) { this.lastTurnIdValue = value; }
  get changedFileCount(): number { return this.turnChangedFiles.size; }
  /** 正在进行的轮次标识；时间线用它做稳定 Key。 */
  get currentTurnId(): string | undefined { return this.trackerValue?.current?.turnId; }

  /**
   * 本会话被 Agent 改动过的文件（最近的轮次在前），作为 @ 候选的「最近使用」来源之一。
   */
  sessionChangedFiles(limit = 20): string[] {
    const paths: string[] = [];
    for (const turn of [...(this.trackerValue?.turns ?? [])].reverse()) {
      for (const file of turn.changedFiles) {
        if (paths.includes(file.relativePath)) continue;
        paths.push(file.relativePath);
        if (paths.length >= limit) return paths;
      }
    }
    return paths;
  }

  /** 时间线的文件增删改数量只认这里，不从工具事件推断。 */
  countChanges(turnId: string): { modified: number; created: number; deleted: number } | undefined {
    const turn = this.trackerValue?.turn(turnId);
    if (!turn) return undefined;
    let modified = 0;
    let created = 0;
    let deleted = 0;
    for (const file of turn.changedFiles) {
      if (file.kind === "create") created += 1;
      else if (file.kind === "delete") deleted += 1;
      else modified += 1;
    }
    return { modified, created, deleted };
  }

  /**
   * 确定仓库后建立追踪器与快照仓库。同一个根重复调用无副作用；换根则整套重建。
   *
   * 重建这一步不能省：追踪器和快照仓库都在构造时绑定了根，只更新
   * workspaceRootValue 会让它们继续对着旧目录算差异、把快照写进旧哈希目录，
   * 而且一声不响——表现是切了仓库之后「变更」列表还是上一个仓库的文件。
   */
  setup(workspaceRoot: string): void {
    if (this.trackerValue && !isSameRoot(this.workspaceRootValue, workspaceRoot)) {
      this.discardRootState();
    }
    this.workspaceRootValue = workspaceRoot;
    if (this.trackerValue) return;
    const snapshots = new SnapshotStore(this.deps.snapshotRoot(), workspaceRoot, this.deps.fs);
    this.snapshotsValue = snapshots;
    this.trackerValue = new ChangeTracker({ workspaceRoot, fs: this.deps.fs, snapshots });
    this.deps.log(`[snapshot] 快照目录：${snapshots.baseDirectory}`);
  }

  /**
   * 换仓库前的收尾：等排队的读写落完，再丢掉与旧根绑定的一切。
   *
   * 必须先 drain 再丢：队列里的任务闭包持有旧的 tracker 与 snapshots，
   * 中途丢引用不会取消它们，只会让写入落到一半。
   */
  async reset(): Promise<void> {
    await this.drain();
    this.discardRootState();
    this.workspaceRootValue = undefined;
  }

  private discardRootState(): void {
    this.trackerValue = undefined;
    this.snapshotsValue = undefined;
    this.lastTurnIdValue = undefined;
    this.turnChangedFiles.clear();
  }

  startTurn(input: {
    sessionId: string;
    mode: string;
    prompt: string;
    contextLabels: string[];
  }): void {
    this.trackerValue?.startTurn(input);
  }

  resetTurnStats(): void {
    this.turnChangedFiles.clear();
  }

  /** 只统计工作区内的改动：Grok 会写自己 session 目录下的 plan.md，那个不算本轮变更。 */
  noteFileChanged(target: string): void {
    const root = this.workspaceRootValue;
    if (!root || !isInsideWorkspace(root, target)) return;
    this.turnChangedFiles.add(path.resolve(root, target).toLowerCase());
    const tracker = this.trackerValue;
    if (!tracker?.current) return;
    const turnId = tracker.current.turnId;
    this.enqueue(async () => {
      const change = await tracker.noteChanged(target);
      if (change) this.postChanges(turnId);
    });
  }

  /** 写入前钩子：Auto 模式与会话规则会在 Runtime 内部直接放行，快照必须在这里完成。 */
  async captureBeforeWrite(input: WriteGuardInput): Promise<WriteGuardResult> {
    const tracker = this.trackerValue;
    if (!tracker) return { ok: true };
    try {
      // targets 偶发为空时回退 decision.target，否则已有文件会被当成「新建」、Diff 左侧空白。
      const targets = input.decision.targets.length > 0
        ? input.decision.targets
        : (input.decision.target ? [input.decision.target] : []);
      if (targets.length === 0) {
        this.deps.log("[snapshot] 写入前未解析到目标路径，跳过快照（该文件将无法左右对比）");
        return { ok: true };
      }
      await tracker.prepare(targets);
      return { ok: true };
    } catch (error) {
      this.deps.log(`[snapshot] ${errorText(error)}`);
      return { ok: false, reason: `保存修改前快照失败，已拒绝该操作：${errorText(error)}` };
    }
  }

  async readSnapshot(turnId: string, relativePath: string): Promise<string> {
    if (!this.trackerValue) return "";
    return this.trackerValue.snapshotText(turnId, relativePath);
  }

  /**
   * 会话流里内联 diff 的唯一数据出口。
   *
   * 只回传差异块，不回传整份文件：面板拿到的永远是相对路径 + 变更行，
   * 跟其它变更消息保持同一条边界。
   */
  async changeDiff(changeId: string): Promise<void> {
    const found = this.find(changeId);
    if (!found) {
      this.deps.post({ type: "changeDiff", changeId, error: "该变更记录已失效。" });
      return;
    }
    if (!this.deps.ui.canReviewChanges) {
      this.deps.post({ type: "changeDiff", changeId, error: "任务执行中，稍后再看改动内容。" });
      return;
    }
    const { change, turn } = found;
    try {
      const current = change.kind === "delete"
        ? ""
        : decodeText(await this.deps.fs.read(change.absolutePath));
      const snapshotPath = change.previousRelativePath ?? change.relativePath;
      // 新建文件没有「之前」；未留快照的修改也只能当作从空白长出来，
      // 至少让人看到新内容，而不是一句「无法显示」。
      const before = change.kind === "create" || !change.restorable
        ? ""
        : await this.readSnapshot(turn.turnId, snapshotPath);
      // hunk 明细是锦上添花：拿得到就带上（面板按 hunk 画、每块带接受/拒绝），
      // 拿不到（旧版 Grok / 已全部处理 / 出错）就只发整段 diff。
      const hunks = change.status === "pending" ? await this.fetchHunks(change.absolutePath) : undefined;
      this.deps.post({
        type: "changeDiff",
        changeId,
        diff: computeDiffText(before, current),
        ...(hunks && hunks.length > 0 ? { hunks } : {}),
      });
    } catch (error) {
      this.deps.post({ type: "changeDiff", changeId, error: `读取改动内容失败：${errorText(error)}` });
    }
  }

  /** 向 Grok 要某个文件的 hunk 明细；任何失败都静默降级为 undefined。 */
  private async fetchHunks(absolutePath: string): Promise<HunkView[] | undefined> {
    const api = this.deps.hunkApi;
    if (!api) return undefined;
    try {
      const payload = await api.getHunks(absolutePath);
      if (!payload) return undefined;
      return payload.hunks.map((hunk) => ({
        id: hunk.id,
        oldStart: hunk.lineInfo.oldStart,
        oldCount: hunk.lineInfo.oldCount,
        newStart: hunk.lineInfo.newStart,
        newCount: hunk.lineInfo.newCount,
        oldText: hunk.oldText ?? "",
        newText: hunk.newText,
        external: hunk.source.type === "external",
      }));
    } catch (error) {
      this.deps.log(`[hunks] 获取 hunk 明细失败：${errorText(error)}`);
      return undefined;
    }
  }

  /**
   * 逐 hunk 接受/拒绝。动作发给 Grok（reject 会由它改写磁盘），
   * 之后刷新我们自己的追踪状态并把最新 diff/hunk 回给面板。
   */
  async hunkAction(changeId: string, hunkId: string, action: HunkActionKind): Promise<void> {
    if (!this.guard()) return;
    const api = this.deps.hunkApi;
    const found = this.find(changeId);
    if (!api || !found) {
      this.deps.post({ type: "notice", level: "warn", message: "该变更记录已失效或当前不支持逐块操作。" });
      return;
    }
    try {
      const result = await api.hunkAction(hunkId, action);
      if (!result.success) {
        this.deps.post({
          type: "notice",
          level: "warn",
          message: `逐块${action === "accept" ? "接受" : "拒绝"}未成功：${result.error ?? "未知原因"}`,
        });
        return;
      }
      // reject 改写了磁盘：让追踪器重新对账（哈希、行数），列表与角标才是真的。
      this.noteFileChanged(found.change.absolutePath);
      await this.drain();
    } catch (error) {
      this.deps.post({ type: "notice", level: "warn", message: `逐块操作失败：${errorText(error)}` });
      return;
    }
    await this.changeDiff(changeId);
  }

  find(changeId: string) {
    return this.trackerValue?.find(changeId);
  }

  turn(turnId: string) {
    return this.trackerValue?.turn(turnId);
  }

  /**
   * 把某一轮的变更列表推给面板。返回是否真的推了。
   *
   * 零改动的轮次一律不推：`finalize` 给每一轮都记了 lastTurnId，纯问答那一轮也算，
   * 于是面板做状态同步时会收到一份空列表，会话流里就多出一张「0 个文件已修改」的空卡。
   * 结算路径（publishFinalized）与会话恢复路径本来就有这道判断，这里补齐。
   *
   * 已接受 / 已拒绝的行会留在列表里带状态标签，不会让列表变空，
   * 所以「列表为空」只意味着这一轮从没碰过文件。
   */
  postChanges(turnId: string): boolean {
    const turn = this.trackerValue?.turn(turnId);
    if (!turn || turn.changedFiles.length === 0) return false;
    const view = toChangeList(turn, this.deps.lineDiff);
    this.deps.store.setChanges(view);
    this.deps.post({ type: "changes", view });
    return true;
  }

  async acceptChange(changeId: string): Promise<void> {
    if (!this.guard()) return;
    const tracker = this.trackerValue;
    const found = tracker?.find(changeId);
    if (!tracker || !found) {
      this.deps.post({ type: "notice", level: "warn", message: "该变更记录已失效。" });
      return;
    }
    const change = await tracker.accept(changeId);
    if (!change) {
      this.deps.post({
        type: "notice",
        level: "warn",
        message: `${found.change.relativePath} 已处理过，不能重复接受。`,
      });
      this.postChanges(found.turn.turnId);
      return;
    }
    this.deps.post({ type: "notice", level: "info", message: `已接受 ${change.relativePath} 的修改。` });
    await this.afterChangeUpdate(found.turn.turnId);
  }

  async rejectChange(changeId: string): Promise<void> {
    if (!this.guard()) return;
    const tracker = this.trackerValue;
    const found = tracker?.find(changeId);
    if (!tracker || !found) {
      this.deps.post({ type: "notice", level: "warn", message: "该变更记录已失效。" });
      return;
    }
    const turnId = found.turn.turnId;
    this.deps.ui.transition("restoring_changes");
    this.deps.postState();
    const outcome = await tracker.reject(changeId);
    if (outcome.status === "restored") {
      this.deps.post({
        type: "notice",
        level: "info",
        message: `已恢复 ${outcome.relativePath} 的修改前内容。`,
      });
    } else if (outcome.status === "conflict") {
      this.deps.post({
        type: "notice",
        level: "warn",
        message: `${outcome.relativePath}：${outcome.reason ?? CONFLICT_MESSAGE}`,
      });
    } else {
      this.deps.post({
        type: "notice",
        level: "warn",
        message: `${outcome.relativePath || "该变更"}：${outcome.reason ?? "未处理"}`,
      });
    }
    await this.afterChangeUpdate(turnId, outcome.status === "conflict");
  }

  async acceptAll(turnId: string): Promise<void> {
    if (!this.guard()) return;
    const tracker = this.trackerValue;
    if (!tracker?.turn(turnId)) {
      this.deps.post({ type: "notice", level: "warn", message: "该轮次的变更记录已失效。" });
      return;
    }
    const count = await tracker.acceptAll(turnId);
    const conflicts = tracker.turn(turnId)?.changedFiles
      .filter((change) => change.status === "conflict").length ?? 0;
    this.deps.post({
      type: "notice",
      level: "info",
      message: conflicts > 0
        ? `已接受 ${count} 个文件的修改；${conflicts} 个冲突文件需要单独确认。`
        : `已接受 ${count} 个文件的修改。`,
    });
    await this.afterChangeUpdate(turnId, conflicts > 0);
  }

  async rejectAll(turnId: string): Promise<void> {
    if (!this.guard()) return;
    await this.restoreTurn(turnId, "拒绝全部");
  }

  async openDiff(changeId: string): Promise<void> {
    const found = this.find(changeId);
    if (!found) {
      this.deps.post({ type: "notice", level: "warn", message: "该变更记录已失效。" });
      return;
    }
    if (!this.deps.ui.canReviewChanges) return;
    try {
      await openChangeDiff(
        found.change,
        found.turn.index,
        (turnId, relativePath) => this.readSnapshot(turnId, relativePath),
      );
    } catch (error) {
      this.deps.post({
        type: "error",
        message: `打开 Diff 失败：${errorText(error)}`,
        recoverable: true,
      });
    }
  }

  /** 命令面板入口：把最近一轮的变更列表重新推到面板。 */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("lingdongAgent.chatView.focus");
    // 最近一轮没碰文件时 postChanges 什么都不推，这里必须自己说一句，
    // 否则用户点了「查看变更」界面毫无反应。
    if (this.lastTurnIdValue && this.postChanges(this.lastTurnIdValue)) return;
    this.deps.post({ type: "notice", level: "info", message: "当前会话还没有产生文件修改。" });
  }

  async showConflict(changeId: string): Promise<void> {
    const found = this.find(changeId);
    if (!found) {
      this.deps.post({ type: "notice", level: "warn", message: "该变更记录已失效。" });
      return;
    }
    await this.openDiff(changeId);
    const choice = await vscode.window.showWarningMessage(
      `${found.change.relativePath}：${found.change.conflictReason ?? CONFLICT_MESSAGE}`,
      { modal: false },
      "保留当前文件",
      "创建恢复副本",
    );
    if (choice === "保留当前文件") {
      await this.trackerValue?.keepCurrent(changeId);
      this.deps.post({
        type: "notice",
        level: "info",
        message: `已保留 ${found.change.relativePath} 的当前内容。`,
      });
      await this.afterChangeUpdate(found.turn.turnId);
      return;
    }
    if (choice !== "创建恢复副本") return;
    const copy = await this.trackerValue?.createRecoveryCopy(changeId);
    this.deps.post({
      type: "notice",
      level: copy ? "info" : "warn",
      message: copy
        ? `修改前内容已另存为 ${copy}，当前文件未被覆盖。`
        : "没有可用的修改前快照，无法创建恢复副本。",
    });
  }

  async restoreTurn(turnId: string, label: string): Promise<void> {
    const tracker = this.trackerValue;
    if (!tracker?.turn(turnId)) {
      this.deps.post({ type: "notice", level: "warn", message: "该轮次的变更记录已失效。" });
      return;
    }
    await this.drain();
    this.deps.ui.transition("restoring_changes");
    this.deps.postState();
    const summary = await tracker.undoTurn(turnId);
    this.deps.log(
      `[restore] ${label}：恢复 ${summary.restored}，冲突 ${summary.conflicts}，跳过 ${summary.skipped}`,
    );
    this.deps.post({
      type: "notice",
      level: summary.conflicts > 0 ? "warn" : "info",
      message: `${label}：${summary.message}`,
    });
    await this.afterChangeUpdate(turnId, summary.conflicts > 0);
  }

  /** 每次变更状态更新后重新推送列表，并在全部处理完成后回收快照。 */
  async afterChangeUpdate(turnId: string, hasConflict = false): Promise<void> {
    const turn = this.trackerValue?.turn(turnId);
    const persistence = this.deps.persistence();
    if (turn) {
      persistence?.turns.updateChanges(turnId, turn.changedFiles, turn.status);
      if (turn.changedFiles.every((change) => change.status === "accepted" || change.status === "restored")) {
        await this.snapshotsValue?.releaseTurn(turnId);
      }
      await this.onTurnPersisted?.(turnId);
      this.deps.flushPersistence();
    }
    this.postChanges(turnId);
    if (
      this.deps.ui.state === "restoring_changes"
      || this.deps.ui.state === "conflict"
      || this.deps.ui.state === "reviewing_changes"
    ) {
      this.deps.ui.force(hasConflict ? "conflict" : "reviewing_changes");
    }
    this.deps.postState();
  }

  /** 由控制器注入：变更落盘后同步会话计数。 */
  onTurnPersisted: ((turnId: string) => Promise<void>) | undefined;

  /** 轮次结束后结算变更：刷新哈希、合并重命名，并把列表推给面板。 */
  async finalize(cancelled: boolean): Promise<AgentTurn | undefined> {
    const tracker = this.trackerValue;
    if (!tracker?.current) return undefined;
    await this.drain();
    try {
      const turn = await tracker.finalize(cancelled ? "cancelled" : "completed");
      if (!turn) return undefined;
      this.lastTurnIdValue = turn.turnId;
      // 后轮覆盖同路径时消化前轮假冲突，并写回 turns.json，侧边栏角标才掉得下来。
      const digested = tracker.digestSuperseded();
      const persistence = this.deps.persistence();
      for (const older of digested) {
        persistence?.turns.updateChanges(older.turnId, older.changedFiles, older.status);
      }
      return turn;
    } catch (error) {
      this.deps.log(`[changes] 结算本轮变更失败：${errorText(error)}`);
      return undefined;
    }
  }

  /** 结算后把变更列表推给面板，并返回是否存在冲突。 */
  publishFinalized(turn: AgentTurn): boolean {
    if (turn.changedFiles.length === 0) return false;
    // 任务被取消也要展示已经产生的修改，取消本身不会自动恢复文件。
    this.postChanges(turn.turnId);
    return turn.changedFiles.some((change) => change.status === "conflict");
  }

  guard(): boolean {
    if (this.deps.ui.canApplyChanges) return true;
    this.deps.post({
      type: "notice",
      level: "warn",
      message: this.deps.ui.state === "restoring_changes"
        ? "正在恢复文件，请等待本次恢复完成。"
        : "任务正在执行，请先等本轮结束再处理变更。",
    });
    return false;
  }

  enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch((error: unknown) => {
        this.deps.log(`[changes] ${errorText(error)}`);
      });
  }

  async drain(): Promise<void> {
    await this.queue;
  }
}
