import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentTurn } from "../src/change-tracker";
import { createNodeFileSystem } from "../src/file-system-port";
import { JsonStore } from "../src/storage/json-store";
import { toPersistedTurn, TurnRepository, type PersistedTurn } from "../src/storage/turn-repository";

function sampleTurn(turnId: string, status: AgentTurn["status"] = "completed"): PersistedTurn {
  return toPersistedTurn({
    turnId,
    sessionId: "s1",
    index: 1,
    startedAt: Date.now(),
    mode: "agent",
    prompt: "测试",
    contextLabels: [],
    changedFiles: [
      {
        id: "chg-1",
        turnId,
        relativePath: "a.txt",
        absolutePath: "/ws/a.txt",
        kind: "modify",
        beforeSha256: "before",
        afterSha256: "after",
        size: 4,
        status: "pending",
        restorable: true,
        updatedAt: Date.now(),
      },
    ],
    status,
  });
}

async function setup(): Promise<{ file: string; repo: TurnRepository }> {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-turn-repo-"));
  const file = path.join(directory, "turns.json");
  const repo = new TurnRepository(file, new JsonStore(createNodeFileSystem()));
  return { file, repo };
}

test("open 读取空文件时返回 missing", async () => {
  const { file, repo } = await setup();
  assert.equal(await repo.open(file), "missing");
  assert.equal(repo.turns.length, 0);
});

test("upsert 与 flush 持久化轮次摘要", async () => {
  const { file, repo } = await setup();
  await repo.open(file);
  repo.upsert(sampleTurn("turn-1"));
  await repo.flush();

  const reloaded = new TurnRepository(file, new JsonStore(createNodeFileSystem()));
  assert.equal(await reloaded.open(file), "ok");
  assert.equal(reloaded.turns.length, 1);
  assert.equal(reloaded.turns[0]?.turnId, "turn-1");
});

test("pendingCount 统计未决变更数量", async () => {
  const { file, repo } = await setup();
  await repo.open(file);
  repo.upsert(sampleTurn("turn-1"));
  repo.upsert(
    toPersistedTurn({
      ...sampleTurn("turn-2"),
      changedFiles: [
        {
          id: "chg-2",
          turnId: "turn-2",
          relativePath: "b.txt",
          absolutePath: "/ws/b.txt",
          kind: "modify",
          beforeSha256: "b0",
          afterSha256: "b1",
          size: 2,
          status: "accepted",
          restorable: true,
          updatedAt: Date.now(),
        },
      ],
    }),
  );

  assert.equal(repo.pendingCount, 1);
});
