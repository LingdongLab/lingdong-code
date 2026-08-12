import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import type { TurnPresentation } from "../src/presentation/turn-presentation";
import { JsonStore } from "../src/storage/json-store";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrateDocument,
  type StorageKind,
} from "../src/storage/storage-migration";
import {
  TranscriptRepository,
  sanitizeEntry,
  toRestoreMessages,
} from "../src/storage/transcript-repository";

const ALL_KINDS: StorageKind[] = [
  "session-index",
  "session",
  "transcript",
  "turns",
  "plans",
  "providers",
  "catalog",
  "permissions",
];

function presentation(overrides: Partial<TurnPresentation> = {}): TurnPresentation {
  return {
    sessionId: "s1",
    turnId: "t1",
    status: "completed",
    startedAt: 1_000,
    completedAt: 6_000,
    durationMs: 5_000,
    summary: { filesRead: 5, searches: 2, filesModified: 3, verificationStatus: "passed", testsPassed: 296 },
    groups: [
      {
        id: "g1",
        kind: "exploration",
        title: "探索代码库",
        status: "completed",
        startedAt: 1_000,
        completedAt: 3_000,
        items: [
          {
            id: "i1",
            toolCallId: "c1",
            action: "read",
            target: "src/a.ts",
            status: "completed",
            startedAt: 1_000,
            completedAt: 3_000,
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function setup(): Promise<{ repo: TranscriptRepository; file: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-timeline-"));
  const file = path.join(directory, "transcript.json");
  const repo = new TranscriptRepository(file, new JsonStore(createNodeFileSystem()));
  await repo.open(file);
  return { repo, file };
}

test("时间线落盘后可以读回并恢复统计与耗时", async () => {
  const { repo, file } = await setup();
  repo.append({ kind: "user", at: 1, text: "修复登录问题" });
  repo.append({ kind: "timeline", at: 10, turnId: "t1", presentation: presentation() });
  await repo.flush();

  const reopened = new TranscriptRepository(file, new JsonStore(createNodeFileSystem()));
  await reopened.open(file);
  const entry = reopened.entries.find((item) => item.kind === "timeline");
  assert.ok(entry && entry.kind === "timeline");
  assert.equal(entry.presentation.turnId, "t1");
  assert.equal(entry.presentation.durationMs, 5_000);
  assert.equal(entry.presentation.summary?.testsPassed, 296);
  assert.equal(entry.presentation.groups[0]?.items[0]?.target, "src/a.ts");
});

test("恢复时时间线条目映射为 timelineRestore，按原顺序夹在消息之间", async () => {
  const { repo } = await setup();
  repo.append({ kind: "user", at: 1, text: "修复登录问题" });
  repo.append({ kind: "timeline", at: 10, turnId: "t1", presentation: presentation() });
  repo.append({ kind: "assistantEnd", at: 20, stopReason: "end_turn" });

  const messages = toRestoreMessages(repo.entries);
  const types = messages.map((message) => message.type);
  assert.deepEqual(types, ["userMessage", "timelineRestore", "assistantEnd"]);
  const restore = messages[1];
  assert.equal(restore?.type === "timelineRestore" ? restore.presentation.turnId : "", "t1");
});

test("重启后仍为运行中的时间线恢复成已中断", async () => {
  const { repo, file } = await setup();
  repo.append({
    kind: "timeline",
    at: 10,
    turnId: "t1",
    presentation: presentation({
      status: "running",
      groups: [{
        id: "g1",
        kind: "editing",
        title: "修改代码",
        status: "running",
        startedAt: 1_000,
        items: [{ id: "i1", toolCallId: "c1", action: "edit", target: "src/a.ts", status: "running", startedAt: 1_200 }],
      }],
    }),
  });
  await repo.flush();

  const reopened = new TranscriptRepository(file, new JsonStore(createNodeFileSystem()));
  await reopened.open(file);
  assert.equal(reopened.interruptRunningTimelines(), 1);

  const entry = reopened.entries[0];
  assert.ok(entry && entry.kind === "timeline");
  assert.equal(entry.presentation.status, "interrupted");
  assert.equal(entry.presentation.groups[0]?.items[0]?.status, "stopped");
  // 已经改写过就不再重复计数。
  assert.equal(reopened.interruptRunningTimelines(), 0);
});

test("落盘前脱敏，密钥与绝对路径都不进时间线", () => {
  const entry = sanitizeEntry({
    kind: "timeline",
    at: 1,
    turnId: "t1",
    presentation: presentation({
      groups: [{
        id: "g1",
        kind: "command",
        title: "执行命令",
        status: "failed",
        startedAt: 1_000,
        items: [{
          id: "i1",
          toolCallId: "c1",
          action: "run",
          target: "E:/work/demo/scripts/deploy.sh",
          status: "failed",
          startedAt: 1_000,
          detail: "使用 api_key=sk-abcdefghij1234567890 失败",
        }],
      }],
    }),
  });
  const dump = JSON.stringify(entry);
  assert.ok(!dump.includes("sk-abcdefghij1234567890"));
  assert.ok(!dump.includes("E:/work/demo"));
  assert.ok(dump.includes("scripts/deploy.sh"));
});

test("结构损坏的时间线条目被整条丢弃，其余记录不受影响", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-timeline-bad-"));
  const file = path.join(directory, "transcript.json");
  await writeFile(file, JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: "transcript",
    updatedAt: 1,
    data: {
      entries: [
        { kind: "user", at: 1, text: "你好" },
        { kind: "timeline", at: 2, turnId: "t1", presentation: { turnId: "t1" } },
        { kind: "timeline", at: 3, turnId: "t2", presentation: presentation({ turnId: "t2" }) },
      ],
    },
  }), "utf8");

  const repo = new TranscriptRepository(file, new JsonStore(createNodeFileSystem()));
  await repo.open(file);
  assert.deepEqual(repo.entries.map((entry) => entry.kind), ["user", "timeline"]);
  const kept = repo.entries[1];
  assert.equal(kept?.kind === "timeline" ? kept.turnId : "", "t2");
});

test("schema 每一级都为全部 kind 登记了迁移", () => {
  assert.equal(SCHEMA_VERSION, 4);
  for (const kind of ALL_KINDS) {
    for (let from = 1; from < SCHEMA_VERSION; from += 1) {
      // 少登记任何一级，migrateDocument 都会判定缺少迁移并丢掉整份数据。
      assert.equal(
        typeof MIGRATIONS[kind]?.[from],
        "function",
        `${kind} 缺少 v${from} → v${from + 1} 迁移`,
      );
    }
    const result = migrateDocument(kind, 1, { entries: [], turns: [], plans: [] });
    assert.equal(result.ok, true, `${kind} 迁移失败`);
    assert.equal(result.ok === true ? result.migrated : false, true);
  }
});

test("v1 会话文件仍能读出来，不会因为缺时间线而丢数据", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-timeline-v1-"));
  const file = path.join(directory, "transcript.json");
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    kind: "transcript",
    updatedAt: 1,
    data: {
      entries: [
        { kind: "user", at: 1, text: "旧会话" },
        {
          kind: "tool",
          at: 2,
          toolCallId: "c1",
          toolKind: "read",
          label: "Read",
          target: "src/a.ts",
          readOnly: true,
          status: "completed",
        },
      ],
    },
  }), "utf8");

  const repo = new TranscriptRepository(file, new JsonStore(createNodeFileSystem()));
  await repo.open(file);
  assert.deepEqual(repo.entries.map((entry) => entry.kind), ["user", "tool"]);
  // 旧记录没有时间线，恢复时走旧版工具摘要，不伪造统计。
  const types = toRestoreMessages(repo.entries).map((message) => message.type);
  assert.ok(types.includes("toolStarted"));
  assert.ok(!types.includes("timelineRestore"));
});

test("未来版本的数据被拒绝读取，避免旧扩展覆盖新结构", () => {
  const result = migrateDocument("transcript", SCHEMA_VERSION + 1, { entries: [] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "unsupported_version");
});
