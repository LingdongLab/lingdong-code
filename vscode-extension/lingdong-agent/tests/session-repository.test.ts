import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { JsonStore } from "../src/storage/json-store";
import { SessionRepository, filterSessions, sortSessions, type SessionRecord } from "../src/storage/session-repository";
import { workspaceHash } from "../src/snapshot-store";

interface Harness {
  root: string;
  repo: SessionRepository;
  damages: string[];
}

async function setup(workspaceId = "ws-a"): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "lingdong-session-"));
  const fs = createNodeFileSystem();
  const damages: string[] = [];
  const repo = new SessionRepository(root, workspaceId, fs, new JsonStore(fs), {
    onDamage: (detail) => damages.push(detail),
  });
  return { root, repo, damages };
}

async function create(repo: SessionRepository, title?: string): Promise<SessionRecord> {
  return repo.create({ modelId: "deepseek-v4-flash", localMode: "ask", ...(title ? { title } : {}) });
}

test("新建会话写入记录与索引", async () => {
  const { repo, root } = await setup();
  const record = await create(repo);
  assert.ok(record.id.startsWith("ses-"));
  assert.equal(record.title, "新会话");
  assert.equal(record.titleSource, "placeholder");
  assert.equal(record.workspaceId, "ws-a");

  const index = JSON.parse(await readFile(path.join(root, "ws-a", "index.json"), "utf8")) as {
    data: { sessionIds: string[] };
  };
  assert.deepEqual(index.data.sessionIds, [record.id]);
  const loaded = await repo.load(record.id);
  assert.equal(loaded?.id, record.id);
});

test("加载会话列表按固定与更新时间排序", async () => {
  const { repo } = await setup();
  const first = await create(repo);
  const second = await create(repo);
  await repo.patch(first.id, { updatedAt: 5_000 });
  await repo.patch(second.id, { updatedAt: 9_000 });
  assert.deepEqual((await repo.list()).map((item) => item.id), [second.id, first.id]);

  await repo.setPinned(first.id, true);
  assert.equal((await repo.list())[0]?.id, first.id);
});

test("重命名把标题来源改为手动，自动标题不再覆盖", async () => {
  const { repo } = await setup();
  const record = await create(repo);
  await repo.applyAutoTitle(record.id, "给首页增加产品介绍区域");
  assert.equal((await repo.load(record.id))?.title, "首页产品介绍区域");

  await repo.rename(record.id, "我自己起的名字");
  await repo.applyAutoTitle(record.id, "换一个完全不同的任务描述");
  const after = await repo.load(record.id);
  assert.equal(after?.title, "我自己起的名字");
  assert.equal(after?.titleSource, "manual");
});

test("删除会话只清理本地记录目录", async () => {
  const { repo, root } = await setup();
  const record = await create(repo);
  await repo.remove(record.id);
  assert.equal(await repo.load(record.id), undefined);
  assert.deepEqual(await repo.list(), []);
  assert.equal(await createNodeFileSystem().exists(path.join(root, "ws-a", record.id)), false);
});

test("固定与归档状态持久化，归档默认不出现在列表里", async () => {
  const { repo } = await setup();
  const record = await create(repo);
  await repo.setArchived(record.id, true);
  assert.deepEqual(await repo.list(), []);
  const archived = await repo.list({ includeArchived: true });
  assert.equal(archived[0]?.archived, true);

  await repo.setPinned(record.id, true);
  assert.equal((await repo.load(record.id))?.pinned, true);
});

test("不同工作区的会话互不可见", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingdong-session-"));
  const fs = createNodeFileSystem();
  const store = new JsonStore(fs);
  const left = new SessionRepository(root, workspaceHash("E:\\proj-a"), fs, store);
  const right = new SessionRepository(root, workspaceHash("E:\\proj-b"), fs, store);

  const owned = await create(left);
  assert.equal((await left.list()).length, 1);
  assert.deepEqual(await right.list(), []);
  assert.equal(await right.load(owned.id), undefined);
});

test("记录里的工作区标识不匹配时拒绝加载", async () => {
  const { repo, root } = await setup();
  const record = await create(repo);
  const file = path.join(root, "ws-a", record.id, "session.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as { data: SessionRecord };
  raw.data.workspaceId = "ws-别的工作区";
  await writeFile(file, JSON.stringify(raw), "utf8");
  assert.equal(await repo.load(record.id), undefined);
});

test("索引损坏时按目录自愈并上报损坏", async () => {
  const { repo, root, damages } = await setup();
  const record = await create(repo);
  const indexFile = path.join(root, "ws-a", "index.json");
  await writeFile(indexFile, "坏掉的索引", "utf8");

  const list = await repo.list();
  assert.deepEqual(list.map((item) => item.id), [record.id]);
  assert.ok(damages.some((detail) => detail.startsWith("会话索引")));
  const rebuilt = JSON.parse(await readFile(indexFile, "utf8")) as { data: { sessionIds: string[] } };
  assert.deepEqual(rebuilt.data.sessionIds, [record.id]);
});

test("patch 合并字段并推进更新时间", async () => {
  const { repo } = await setup();
  const record = await create(repo);
  const patched = await repo.patch(record.id, {
    grokSessionId: "019fcda9-b958-71d0-a2f6-374fed208d5b",
    pendingChanges: 2,
    conflictChanges: 1,
    hasUnfinishedPlan: true,
    lastSummary: "修改了首页标题",
    updatedAt: 12_345,
  });
  assert.equal(patched?.grokSessionId, "019fcda9-b958-71d0-a2f6-374fed208d5b");
  assert.equal(patched?.pendingChanges, 2);
  assert.equal(patched?.updatedAt, 12_345);
  assert.equal((await repo.load(record.id))?.lastSummary, "修改了首页标题");
});

test("最近会话取排序后的第一条", async () => {
  const { repo } = await setup();
  const first = await create(repo);
  const second = await create(repo);
  await repo.patch(first.id, { updatedAt: 1 });
  await repo.patch(second.id, { updatedAt: 2 });
  assert.equal((await repo.mostRecent())?.id, second.id);
});

test("排序函数把固定会话放在最前", () => {
  const base = { pinned: false, updatedAt: 0 } as SessionRecord;
  const sorted = sortSessions([
    { ...base, id: "a", updatedAt: 3 },
    { ...base, id: "b", updatedAt: 1, pinned: true },
    { ...base, id: "c", updatedAt: 9 },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["b", "c", "a"]);
});

test("filterSessions 按标题/摘要/模式本地过滤", () => {
  const base = {
    pinned: false,
    updatedAt: 1,
    title: "登录改造",
    lastSummary: "调整鉴权",
    localMode: "plan",
    modelId: "deepseek-v4-flash",
    status: "active",
  } as SessionRecord;
  const records = [
    { ...base, id: "a" },
    { ...base, id: "b", title: "其他", lastSummary: "无关", localMode: "ask" },
  ];
  assert.equal(filterSessions(records, "鉴权").length, 1);
  assert.equal(filterSessions(records, "ask").length, 1);
  assert.equal(filterSessions(records, "").length, 2);
});
