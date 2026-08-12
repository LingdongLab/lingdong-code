import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { SnapshotError, SnapshotStore, sha256, storageName, workspaceHash } from "../src/snapshot-store";

async function setup(options: { maxTurnBytes?: number } = {}): Promise<{
  workspace: string;
  store: SnapshotStore;
  storage: string;
}> {
  const base = await mkdtemp(path.join(tmpdir(), "lingdong-snap-"));
  const workspace = path.join(base, "ws");
  const storage = path.join(base, "storage");
  const fs = createNodeFileSystem();
  await fs.ensureDirectory(workspace);
  return { workspace, storage, store: new SnapshotStore(storage, workspace, fs, options) };
}

test("快照保存修改前内容与哈希", async () => {
  const { workspace, store } = await setup();
  await writeFile(path.join(workspace, "index.html"), "<h1>旧标题</h1>", "utf8");

  const record = await store.capture("s1", "turn-1", "index.html");
  assert.equal(record.existed, true);
  assert.equal(record.sha256, sha256(Buffer.from("<h1>旧标题</h1>", "utf8")));

  await writeFile(path.join(workspace, "index.html"), "<h1>新标题</h1>", "utf8");
  const restored = await store.read("turn-1", "index.html");
  assert.equal(Buffer.from(restored ?? new Uint8Array()).toString("utf8"), "<h1>旧标题</h1>");
});

test("同一文件多次快照保留最初版本", async () => {
  const { workspace, store } = await setup();
  await writeFile(path.join(workspace, "a.txt"), "第一版", "utf8");
  await store.capture("s1", "turn-1", "a.txt");
  await writeFile(path.join(workspace, "a.txt"), "第二版", "utf8");
  await store.capture("s1", "turn-1", "a.txt");
  const bytes = await store.read("turn-1", "a.txt");
  assert.equal(Buffer.from(bytes ?? new Uint8Array()).toString("utf8"), "第一版");
});

test("新建文件的快照记录为不存在", async () => {
  const { store } = await setup();
  const record = await store.capture("s1", "turn-1", "new.txt");
  assert.equal(record.existed, false);
  assert.equal(record.sha256, "");
  assert.equal(await store.read("turn-1", "new.txt"), undefined);
});

test("敏感文件一律拒绝快照", async () => {
  const { store } = await setup();
  await assert.rejects(() => store.capture("s1", "turn-1", ".env"), SnapshotError);
  await assert.rejects(() => store.capture("s1", "turn-1", "config/id_rsa"), /敏感文件/);
});

test("单轮快照总量超限时拒绝继续", async () => {
  const { workspace, store } = await setup({ maxTurnBytes: 64 });
  await writeFile(path.join(workspace, "big.txt"), "x".repeat(100), "utf8");
  await assert.rejects(() => store.capture("s1", "turn-1", "big.txt"), /上限/);
});

test("快照目录不落真实路径，manifest 记录映射", async () => {
  const { workspace, storage, store } = await setup();
  await writeFile(path.join(workspace, "中文 目录.txt"), "内容", "utf8");
  await store.capture("s1", "turn-1", "中文 目录.txt");

  const directory = store.turnDirectory("s1", "turn-1");
  assert.ok(directory.includes(workspaceHash(workspace)));
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
    files: Array<{ relativePath: string; storedAs: string }>;
  };
  assert.equal(manifest.files[0]?.relativePath, "中文 目录.txt");
  assert.equal(manifest.files[0]?.storedAs, storageName("中文 目录.txt"));
  const stored = await readFile(path.join(directory, "files", storageName("中文 目录.txt")), "utf8");
  assert.equal(stored, "内容");
});

test("清理只回收调用方允许回收且已过期的轮次", async () => {
  const { workspace, store } = await setup();
  await writeFile(path.join(workspace, "a.txt"), "内容", "utf8");
  await store.capture("s1", "turn-1", "a.txt");
  await store.capture("s1", "turn-2", "a.txt");

  assert.deepEqual((await store.cleanup({ removableTurnIds: ["turn-1"], maxAgeMs: 60_000 })).removed, []);
  assert.deepEqual((await store.cleanup({ removableTurnIds: ["turn-1"], maxAgeMs: 0 })).removed, ["turn-1"]);
  assert.equal(await store.read("turn-1", "a.txt"), undefined);
  assert.notEqual(await store.read("turn-2", "a.txt"), undefined);
});

test("hydrate 后能从磁盘回读快照", async () => {
  const { workspace, storage, store } = await setup();
  await writeFile(path.join(workspace, "a.txt"), "持久化内容", "utf8");
  await store.capture("s1", "turn-1", "a.txt");

  const reloaded = new SnapshotStore(storage, workspace, createNodeFileSystem());
  assert.equal(reloaded.records("turn-1").length, 0);
  assert.equal(await reloaded.hydrate(), 1);
  assert.equal(reloaded.records("turn-1").length, 1);
  const bytes = await reloaded.read("turn-1", "a.txt");
  assert.equal(Buffer.from(bytes ?? new Uint8Array()).toString("utf8"), "持久化内容");
});

test("scan 列出磁盘上的轮次摘要", async () => {
  const { workspace, store } = await setup();
  await writeFile(path.join(workspace, "a.txt"), "内容", "utf8");
  await store.capture("s1", "turn-1", "a.txt");
  await store.capture("s1", "turn-2", "a.txt");

  const scanned = await store.scan("s1");
  assert.equal(scanned.length, 2);
  assert.deepEqual(
    scanned.map((entry) => entry.turnId).sort(),
    ["turn-1", "turn-2"],
  );
  assert.equal(scanned[0]?.fileCount, 1);
  assert.ok(scanned[0]?.totalBytes > 0);
});

test("cleanup 在 maxTotalBytes 超限时仍保留 pending 轮次", async () => {
  const { workspace, store } = await setup();
  await writeFile(path.join(workspace, "a.txt"), "aaaa", "utf8");
  await writeFile(path.join(workspace, "b.txt"), "bbbb", "utf8");
  await store.capture("s1", "turn-pending", "a.txt");
  await store.capture("s1", "turn-old", "b.txt");

  const result = await store.cleanup({
    removableTurnIds: ["turn-old"],
    maxAgeMs: 0,
    maxTotalBytes: 1,
  });
  assert.deepEqual(result.removed, ["turn-old"]);
  assert.notEqual(await store.read("turn-pending", "a.txt"), undefined);
  assert.equal(await store.read("turn-old", "b.txt"), undefined);
});

test("findOrphans 找出 turn 仓库未记录的磁盘目录", async () => {
  const { workspace, store } = await setup();
  await writeFile(path.join(workspace, "a.txt"), "内容", "utf8");
  await store.capture("s1", "turn-known", "a.txt");
  await store.capture("s1", "turn-orphan", "a.txt");

  const orphans = await store.findOrphans(["turn-known"]);
  assert.equal(orphans.length, 1);
  assert.ok(orphans[0]?.includes("turn-orphan"));
});
