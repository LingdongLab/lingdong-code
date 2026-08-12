import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CONFLICT_MESSAGE, ChangeTracker, SNAPSHOT_MISSING_MESSAGE } from "../src/change-tracker";
import { createNodeFileSystem } from "../src/file-system-port";
import { SnapshotStore } from "../src/snapshot-store";
import { toPersistedTurn } from "../src/storage/turn-repository";

interface Harness {
  workspace: string;
  tracker: ChangeTracker;
  file(name: string): string;
}

async function setup(): Promise<Harness> {
  const base = await mkdtemp(path.join(tmpdir(), "lingdong-track-"));
  const workspace = path.join(base, "ws");
  const fs = createNodeFileSystem();
  await fs.ensureDirectory(workspace);
  const snapshots = new SnapshotStore(path.join(base, "storage"), workspace, fs);
  const tracker = new ChangeTracker({ workspaceRoot: workspace, fs, snapshots });
  return { workspace, tracker, file: (name) => path.join(workspace, name) };
}

function startTurn(tracker: ChangeTracker): void {
  tracker.startTurn({ sessionId: "s1", mode: "agent", prompt: "改一下首页", contextLabels: [] });
}

test("修改文件被记录为 modify，并保留前后哈希", async () => {
  const harness = await setup();
  await writeFile(harness.file("index.html"), "旧内容", "utf8");
  startTurn(harness.tracker);

  await harness.tracker.prepare([harness.file("index.html")]);
  await writeFile(harness.file("index.html"), "新内容", "utf8");
  await harness.tracker.noteChanged(harness.file("index.html"));
  const turn = await harness.tracker.finalize("completed");

  const change = turn?.changedFiles[0];
  assert.equal(turn?.changedFiles.length, 1);
  assert.equal(change?.kind, "modify");
  assert.equal(change?.relativePath, "index.html");
  assert.equal(change?.status, "pending");
  assert.notEqual(change?.beforeSha256, change?.afterSha256);
  assert.equal(change?.restorable, true);
});

test("新建与删除分别记录为 create 与 delete", async () => {
  const harness = await setup();
  await writeFile(harness.file("old.txt"), "待删除", "utf8");
  startTurn(harness.tracker);

  await harness.tracker.prepare([harness.file("new.txt"), harness.file("old.txt")]);
  await writeFile(harness.file("new.txt"), "新文件", "utf8");
  await rm(harness.file("old.txt"));
  const turn = await harness.tracker.finalize("completed");

  const kinds = Object.fromEntries((turn?.changedFiles ?? []).map((change) => [change.relativePath, change.kind]));
  assert.deepEqual(kinds, { "new.txt": "create", "old.txt": "delete" });
});

test("工作区外的写入目标被忽略", async () => {
  const harness = await setup();
  startTurn(harness.tracker);
  await harness.tracker.prepare([path.join(tmpdir(), "grok-session", "plan.md")]);
  const turn = await harness.tracker.finalize("completed");
  assert.equal(turn?.changedFiles.length, 0);
});

test("拒绝单个文件会写回快照内容", async () => {
  const harness = await setup();
  await writeFile(harness.file("index.html"), "旧内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("index.html")]);
  await writeFile(harness.file("index.html"), "新内容", "utf8");
  const turn = await harness.tracker.finalize("completed");

  const change = turn?.changedFiles[0];
  const outcome = await harness.tracker.reject(change?.id ?? "");
  assert.equal(outcome.status, "restored");
  assert.equal(await readFile(harness.file("index.html"), "utf8"), "旧内容");
  assert.equal(change?.status, "restored");
});

test("拒绝新建会删除文件，拒绝删除会写回原文", async () => {
  const harness = await setup();
  await writeFile(harness.file("old.txt"), "原始内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("new.txt"), harness.file("old.txt")]);
  await writeFile(harness.file("new.txt"), "新文件", "utf8");
  await rm(harness.file("old.txt"));
  const turn = await harness.tracker.finalize("completed");

  const summary = await harness.tracker.undoTurn(turn?.turnId ?? "");
  assert.equal(summary.restored, 2);
  assert.equal(summary.conflicts, 0);
  assert.equal(await readFile(harness.file("old.txt"), "utf8"), "原始内容");
  await assert.rejects(() => readFile(harness.file("new.txt"), "utf8"));
});

test("Agent 修改后文件又被外部改动时标记冲突且不覆盖", async () => {
  const harness = await setup();
  await writeFile(harness.file("index.html"), "旧内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("index.html")]);
  await writeFile(harness.file("index.html"), "Agent 内容", "utf8");
  const turn = await harness.tracker.finalize("completed");

  await writeFile(harness.file("index.html"), "用户后来的改动", "utf8");
  const outcome = await harness.tracker.reject(turn?.changedFiles[0]?.id ?? "");
  assert.equal(outcome.status, "conflict");
  assert.equal(outcome.reason, CONFLICT_MESSAGE);
  assert.equal(await readFile(harness.file("index.html"), "utf8"), "用户后来的改动");
  assert.equal(turn?.changedFiles[0]?.status, "conflict");
});

test("接受后不再回滚，撤销本轮跳过已接受文件", async () => {
  const harness = await setup();
  await writeFile(harness.file("a.txt"), "A0", "utf8");
  await writeFile(harness.file("b.txt"), "B0", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("a.txt"), harness.file("b.txt")]);
  await writeFile(harness.file("a.txt"), "A1", "utf8");
  await writeFile(harness.file("b.txt"), "B1", "utf8");
  const turn = await harness.tracker.finalize("completed");

  const [first, second] = turn?.changedFiles ?? [];
  await harness.tracker.accept(first?.id ?? "");
  const summary = await harness.tracker.undoTurn(turn?.turnId ?? "");
  assert.equal(summary.restored, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(await readFile(harness.file("a.txt"), "utf8"), "A1");
  assert.equal(await readFile(harness.file("b.txt"), "utf8"), "B0");
  assert.equal(second?.status, "restored");
});

test("撤销本轮可重复执行且结果幂等", async () => {
  const harness = await setup();
  await writeFile(harness.file("a.txt"), "A0", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("a.txt")]);
  await writeFile(harness.file("a.txt"), "A1", "utf8");
  const turn = await harness.tracker.finalize("completed");

  const first = await harness.tracker.undoTurn(turn?.turnId ?? "");
  const second = await harness.tracker.undoTurn(turn?.turnId ?? "");
  assert.equal(first.restored, 1);
  assert.equal(second.restored, 0);
  assert.equal(second.skipped, 1);
  assert.equal(await readFile(harness.file("a.txt"), "utf8"), "A0");
});

test("接受全部只处理未决变更，冲突项保持人工确认", async () => {
  const harness = await setup();
  await writeFile(harness.file("a.txt"), "A0", "utf8");
  await writeFile(harness.file("b.txt"), "B0", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("a.txt"), harness.file("b.txt")]);
  await writeFile(harness.file("a.txt"), "A1", "utf8");
  await writeFile(harness.file("b.txt"), "B1", "utf8");
  const turn = await harness.tracker.finalize("completed");

  await writeFile(harness.file("b.txt"), "外部改动", "utf8");
  await harness.tracker.reject(turn?.changedFiles[1]?.id ?? "");
  const accepted = await harness.tracker.acceptAll(turn?.turnId ?? "");
  assert.equal(accepted, 1);
  assert.equal(turn?.changedFiles[0]?.status, "accepted");
  assert.equal(turn?.changedFiles[1]?.status, "conflict");
});

test("删除加新建且内容一致时合并为重命名，可整体还原", async () => {
  const harness = await setup();
  await writeFile(harness.file("old-name.txt"), "同一份内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("old-name.txt"), harness.file("new-name.txt")]);
  await writeFile(harness.file("new-name.txt"), "同一份内容", "utf8");
  await rm(harness.file("old-name.txt"));
  const turn = await harness.tracker.finalize("completed");

  assert.equal(turn?.changedFiles.length, 1);
  const change = turn?.changedFiles[0];
  assert.equal(change?.kind, "rename");
  assert.equal(change?.previousRelativePath, "old-name.txt");

  await harness.tracker.reject(change?.id ?? "");
  assert.equal(await readFile(harness.file("old-name.txt"), "utf8"), "同一份内容");
  await assert.rejects(() => readFile(harness.file("new-name.txt"), "utf8"));
});

test("没有快照的改动只展示不参与自动恢复", async () => {
  const harness = await setup();
  await writeFile(harness.file("stray.txt"), "外部写入", "utf8");
  startTurn(harness.tracker);
  const change = await harness.tracker.noteChanged(harness.file("stray.txt"));
  assert.equal(change?.restorable, false);

  const outcome = await harness.tracker.reject(change?.id ?? "");
  assert.equal(outcome.status, "conflict");
  assert.match(outcome.reason ?? "", /没有修改前快照/);
  assert.equal(await readFile(harness.file("stray.txt"), "utf8"), "外部写入");
});

test("冲突文件可以选择保留当前内容", async () => {
  const harness = await setup();
  await writeFile(harness.file("index.html"), "旧内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("index.html")]);
  await writeFile(harness.file("index.html"), "Agent 内容", "utf8");
  const turn = await harness.tracker.finalize("completed");

  await writeFile(harness.file("index.html"), "用户改动", "utf8");
  const changeId = turn?.changedFiles[0]?.id ?? "";
  await harness.tracker.reject(changeId);
  await harness.tracker.keepCurrent(changeId);

  assert.equal(turn?.changedFiles[0]?.status, "accepted");
  assert.equal(turn?.changedFiles[0]?.conflictReason, undefined);
  assert.equal(await readFile(harness.file("index.html"), "utf8"), "用户改动");

  const summary = await harness.tracker.undoTurn(turn?.turnId ?? "");
  assert.equal(summary.restored, 0);
  assert.equal(await readFile(harness.file("index.html"), "utf8"), "用户改动");
});

test("冲突文件可以把修改前内容另存为恢复副本", async () => {
  const harness = await setup();
  await writeFile(harness.file("index.html"), "旧内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("index.html")]);
  await writeFile(harness.file("index.html"), "Agent 内容", "utf8");
  const turn = await harness.tracker.finalize("completed");

  await writeFile(harness.file("index.html"), "用户改动", "utf8");
  const changeId = turn?.changedFiles[0]?.id ?? "";
  await harness.tracker.reject(changeId);
  const copy = await harness.tracker.createRecoveryCopy(changeId);

  assert.equal(copy, "index.html.lingdong-before");
  assert.equal(await readFile(harness.file("index.html.lingdong-before"), "utf8"), "旧内容");
  assert.equal(await readFile(harness.file("index.html"), "utf8"), "用户改动");
});

test("没有快照时不生成恢复副本", async () => {
  const harness = await setup();
  await writeFile(harness.file("stray.txt"), "外部写入", "utf8");
  startTurn(harness.tracker);
  const change = await harness.tracker.noteChanged(harness.file("stray.txt"));
  assert.equal(await harness.tracker.createRecoveryCopy(change?.id ?? ""), undefined);
});

test("快照可读出修改前文本供 Diff 使用", async () => {
  const harness = await setup();
  await writeFile(harness.file("index.html"), "旧内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("index.html"), harness.file("brand.txt")]);
  const turn = harness.tracker.current;

  assert.equal(await harness.tracker.snapshotText(turn?.turnId ?? "", "index.html"), "旧内容");
  assert.equal(await harness.tracker.snapshotText(turn?.turnId ?? "", "brand.txt"), "");
});

test("rehydrate 从持久化摘要恢复轮次，running 变为 completed", async () => {
  const harness = await setup();
  await writeFile(harness.file("a.txt"), "旧内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("a.txt")]);
  await writeFile(harness.file("a.txt"), "新内容", "utf8");
  const original = await harness.tracker.finalize("completed");
  assert.ok(original);

  const persisted = toPersistedTurn({ ...original, status: "running" });
  const reloaded = new ChangeTracker({
    workspaceRoot: harness.workspace,
    fs: createNodeFileSystem(),
    snapshots: new SnapshotStore(path.join(path.dirname(harness.workspace), "storage"), harness.workspace, createNodeFileSystem()),
  });
  reloaded.rehydrate([persisted]);

  const turn = reloaded.turn(original.turnId);
  assert.equal(turn?.status, "completed");
  assert.equal(turn?.changedFiles.length, 1);
  assert.equal(turn?.changedFiles[0]?.relativePath, "a.txt");
});

test("reevaluate 检测到 Agent 修改后的外部改动", async () => {
  const harness = await setup();
  await writeFile(harness.file("index.html"), "旧内容", "utf8");
  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("index.html")]);
  await writeFile(harness.file("index.html"), "Agent 内容", "utf8");
  const turn = await harness.tracker.finalize("completed");
  assert.ok(turn);

  await writeFile(harness.file("index.html"), "用户后来的改动", "utf8");
  const affected = await harness.tracker.reevaluate(turn.turnId);

  assert.equal(affected.length, 1);
  assert.equal(turn.changedFiles[0]?.status, "conflict");
  assert.equal(turn.changedFiles[0]?.conflictReason, CONFLICT_MESSAGE);
});

test("后轮改同一文件时自动消化前轮 pending/conflict", async () => {
  const harness = await setup();
  await writeFile(harness.file("models.html"), "v0", "utf8");

  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("models.html")]);
  await writeFile(harness.file("models.html"), "v1", "utf8");
  const turn1 = await harness.tracker.finalize("completed");
  assert.equal(turn1?.changedFiles[0]?.status, "pending");

  startTurn(harness.tracker);
  await harness.tracker.prepare([harness.file("models.html")]);
  await writeFile(harness.file("models.html"), "v2", "utf8");
  const turn2 = await harness.tracker.finalize("completed");
  assert.ok(turn1 && turn2);

  const digested = harness.tracker.digestSuperseded();
  assert.equal(digested.length, 1);
  assert.equal(turn1.changedFiles[0]?.status, "accepted");
  assert.equal(turn1.changedFiles[0]?.conflictReason, undefined);
  assert.equal(turn2.changedFiles[0]?.status, "pending");

  // 仅磁盘被用户改过、且没有后轮覆盖时，仍应标冲突。
  await writeFile(harness.file("models.html"), "用户手改", "utf8");
  await harness.tracker.reevaluate();
  assert.equal(turn2.changedFiles[0]?.status, "conflict");
  assert.equal(turn1.changedFiles[0]?.status, "accepted");
});

test("reevaluate 在快照缺失时将 pending 标为 conflict", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "lingdong-reeval-"));
  const workspace = path.join(base, "ws");
  const fs = createNodeFileSystem();
  await fs.ensureDirectory(workspace);
  const snapshots = new SnapshotStore(path.join(base, "storage"), workspace, fs);
  const tracker = new ChangeTracker({ workspaceRoot: workspace, fs, snapshots });

  await writeFile(path.join(workspace, "stray.txt"), "外部写入", "utf8");
  startTurn(tracker);
  const noted = await tracker.noteChanged(path.join(workspace, "stray.txt"));
  const turn = await tracker.finalize("completed");
  assert.ok(turn && noted);

  const affected = await tracker.reevaluate(turn.turnId);
  assert.equal(affected.length, 1);
  assert.equal(noted.restorable, false);
  assert.equal(noted.status, "conflict");
  assert.equal(noted.conflictReason, SNAPSHOT_MISSING_MESSAGE);
});
