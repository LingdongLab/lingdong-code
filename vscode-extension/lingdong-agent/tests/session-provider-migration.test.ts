import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { JsonStore } from "../src/storage/json-store";
import { SessionRepository } from "../src/storage/session-repository";
import { MIGRATIONS, SCHEMA_VERSION, migrateDocument } from "../src/storage/storage-migration";

function openRepository(root: string): SessionRepository {
  const fs = createNodeFileSystem();
  return new SessionRepository(root, "ws-1", fs, new JsonStore(fs));
}

async function createRepository(): Promise<{ repo: SessionRepository; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "lingdong-sessions-"));
  return { repo: openRepository(root), root };
}

test("v2 ? DeepSeek ??????? providerId", () => {
  const result = migrateDocument("session", 2, {
    id: "ses-1",
    workspaceId: "ws-1",
    modelId: "deepseek-v4-flash",
  });
  assert.equal(result.ok, true);
  const data = result.ok ? result.data as Record<string, unknown> : {};
  assert.equal(data.providerId, "deepseek");
});

test("???????????? providerId", () => {
  const result = migrateDocument("session", 2, {
    id: "ses-2",
    workspaceId: "ws-1",
    modelId: "some-unknown-model",
  });
  const data = result.ok ? result.data as Record<string, unknown> : {};
  // ??? providerId ???????????????????????????
  assert.equal(data.providerId, undefined);
});

test("??? providerId ?????????", () => {
  const result = migrateDocument("session", 2, {
    id: "ses-3",
    workspaceId: "ws-1",
    modelId: "deepseek-v4-flash",
    providerId: "my-gateway",
  });
  const data = result.ok ? result.data as Record<string, unknown> : {};
  assert.equal(data.providerId, "my-gateway");
});

test("SCHEMA_VERSION 为 4，且 session/providers 每一级迁移都在册", () => {
  assert.equal(SCHEMA_VERSION, 4);
  for (let from = 1; from < SCHEMA_VERSION; from += 1) {
    assert.equal(typeof MIGRATIONS.session?.[from], "function", `session 缺 v${from} 迁移`);
    assert.equal(typeof MIGRATIONS.providers?.[from], "function", `providers 缺 v${from} 迁移`);
  }
});

test("v3 会话缺 workspaceRoot 时按已知工作区根补齐", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingdong-sessions-"));
  const fs = createNodeFileSystem();
  const store = new JsonStore(fs);
  const seeded = await new SessionRepository(root, "ws-1", fs, store).create({
    modelId: "deepseek-v4-flash",
    localMode: "agent",
  });
  await writeFile(
    path.join(root, "ws-1", seeded.id, "session.json"),
    JSON.stringify({
      schemaVersion: 3,
      kind: "session",
      updatedAt: 1,
      data: { id: seeded.id, workspaceId: "ws-1", modelId: "deepseek-v4-flash", localMode: "agent" },
    }),
  );

  const withRoot = new SessionRepository(root, "ws-1", fs, store, { workspaceRoot: "E:\\proj\\demo" });
  assert.equal((await withRoot.load(seeded.id))?.workspaceRoot, "E:\\proj\\demo");
  // 不知道根目录时留空，绝不猜一个路径填进去。
  const withoutRoot = new SessionRepository(root, "ws-1", fs, store);
  assert.equal((await withoutRoot.load(seeded.id))?.workspaceRoot, undefined);
});

test("v1 ?????????? v3??????????", async () => {
  const { repo, root } = await createRepository();
  // ????????????????????? v1 ????
  const seeded = await repo.create({ modelId: "deepseek-v4-flash", localMode: "ask" });
  const file = path.join(repo.sessionDirectory(seeded.id), "session.json");
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      kind: "session",
      updatedAt: 1,
      data: {
        id: seeded.id,
        workspaceId: "ws-1",
        title: "???",
        modelId: "deepseek-v4-flash",
        localMode: "agent",
      },
    }),
  );

  const loaded = await openRepository(root).load(seeded.id);
  assert.equal(loaded?.title, "???");
  assert.equal(loaded?.providerId, "deepseek");
});

test("?????? providerId ? modelId????????", async () => {
  const { repo, root } = await createRepository();
  const created = await repo.create({
    modelId: "gateway-model",
    localMode: "ask",
    providerId: "my-gateway",
  });
  assert.equal(created.providerId, "my-gateway");

  const loaded = await openRepository(root).load(created.id);
  assert.equal(loaded?.providerId, "my-gateway");
  assert.equal(loaded?.modelId, "gateway-model");
});

test("????? providerId ???????????? Provider", async () => {
  const { repo } = await createRepository();
  const created = await repo.create({
    modelId: "deepseek-v4-flash",
    localMode: "ask",
    providerId: "deepseek",
  });
  const patched = await repo.patch(created.id, { modelId: "gateway-model", providerId: "my-gateway" });
  assert.equal(patched?.providerId, "my-gateway");
  assert.equal(patched?.modelId, "gateway-model");
});
