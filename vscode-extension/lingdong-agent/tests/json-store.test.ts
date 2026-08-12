import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { JsonStore } from "../src/storage/json-store";
import { SCHEMA_VERSION, migrateDocument, type MigrationRegistry } from "../src/storage/storage-migration";

interface Payload {
  items: string[];
}

const readOptions = {
  kind: "turns" as const,
  fallback: (): Payload => ({ items: [] }),
  validate: (data: unknown): Payload | undefined => {
    if (typeof data !== "object" || data === null) return undefined;
    const items = (data as { items?: unknown }).items;
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) return undefined;
    return { items: items as string[] };
  },
};

async function setup(): Promise<{ file: string; store: JsonStore; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-json-"));
  return { directory, file: path.join(directory, "turns.json"), store: new JsonStore(createNodeFileSystem()) };
}

test("写入是原子的：临时文件不残留，正式文件带 schemaVersion", async () => {
  const { file, store, directory } = await setup();
  await store.write(file, "turns", { items: ["a"] });

  const raw = JSON.parse(await readFile(file, "utf8")) as { schemaVersion: number; kind: string; data: Payload };
  assert.equal(raw.schemaVersion, SCHEMA_VERSION);
  assert.equal(raw.kind, "turns");
  assert.deepEqual(raw.data.items, ["a"]);

  const names = await createNodeFileSystem().list(directory);
  assert.ok(!names.includes("turns.json.tmp"));
});

test("第二次写入把上一版留成 .bak", async () => {
  const { file, store } = await setup();
  await store.write(file, "turns", { items: ["第一版"] });
  await store.write(file, "turns", { items: ["第二版"] });

  const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as { data: Payload };
  assert.deepEqual(backup.data.items, ["第一版"]);
  const result = await store.read<Payload>(file, readOptions);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data.items, ["第二版"]);
});

test("文件不存在时返回 missing 与空数据", async () => {
  const { file, store } = await setup();
  const result = await store.read<Payload>(file, readOptions);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.data.items, []);
});

test("主文件损坏时从 .bak 恢复并归档坏文件", async () => {
  const { file, store } = await setup();
  await store.write(file, "turns", { items: ["好数据"] });
  await store.write(file, "turns", { items: ["更好的数据"] });
  await writeFile(file, "{ 这不是 JSON", "utf8");

  const result = await store.read<Payload>(file, readOptions);
  assert.equal(result.status, "recovered");
  assert.deepEqual(result.data.items, ["好数据"]);
  assert.ok(result.archived?.includes(".corrupt-"));
  assert.equal(await readFile(result.archived ?? "", "utf8"), "{ 这不是 JSON");
});

test("主文件与备份都损坏时归档两份并返回空仓库", async () => {
  const { file, store } = await setup();
  await store.write(file, "turns", { items: ["旧"] });
  await store.write(file, "turns", { items: ["新"] });
  await writeFile(file, "坏了", "utf8");
  await writeFile(`${file}.bak`, "也坏了", "utf8");

  const result = await store.read<Payload>(file, readOptions);
  assert.equal(result.status, "corrupt");
  assert.deepEqual(result.data.items, []);
  const names = await createNodeFileSystem().list(path.dirname(file));
  assert.equal(names.filter((name) => name.includes(".corrupt-")).length, 2);
});

test("结构校验失败按损坏处理，不把脏数据交出去", async () => {
  const { file, store } = await setup();
  await writeFile(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "turns", data: { items: [1, 2] } }), "utf8");
  const result = await store.read<Payload>(file, readOptions);
  assert.equal(result.status, "corrupt");
  assert.deepEqual(result.data.items, []);
});

test("未来版本的文件拒绝读取且原样保留", async () => {
  const { file, store } = await setup();
  await writeFile(
    file,
    JSON.stringify({ schemaVersion: SCHEMA_VERSION + 5, kind: "turns", data: { items: ["未来"] } }),
    "utf8",
  );
  const result = await store.read<Payload>(file, readOptions);
  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.data.items, []);
  assert.equal(result.archived, undefined);
  assert.ok((await readFile(file, "utf8")).includes("未来"));
});

test("旧版本文件按登记表逐级迁移", async () => {
  const registry: MigrationRegistry = {
    turns: {
      1: (data) => ({ items: [...((data as Payload).items ?? []), "v2"] }),
      2: (data) => ({ items: [...((data as Payload).items ?? []), "v3"] }),
    },
  };
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-json-"));
  const file = path.join(directory, "turns.json");
  const store = new JsonStore(createNodeFileSystem(), { registry, schemaVersion: 3 });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: "turns", data: { items: ["原始"] } }), "utf8");

  const result = await store.read<Payload>(file, readOptions);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data.items, ["原始", "v2", "v3"]);
});

test("缺少迁移步骤时按损坏处理", () => {
  const result = migrateDocument("turns", 1, { items: [] }, {}, 2);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_migration");
});

test("同版本不做迁移，非法版本号直接拒绝", () => {
  const same = migrateDocument("session", SCHEMA_VERSION, { a: 1 });
  assert.equal(same.ok, true);
  if (same.ok) assert.equal(same.migrated, false);
  const bad = migrateDocument("session", 0, {});
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "unsupported_version");
});
