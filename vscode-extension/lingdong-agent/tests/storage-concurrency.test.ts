import assert from "node:assert/strict";
import test from "node:test";

import type { FileSystemPort } from "../src/file-system-port";
import { JsonStore } from "../src/storage/json-store";
import { SessionRepository } from "../src/storage/session-repository";

/**
 * 内存文件系统，语义与 createNodeFileSystem 一致：
 * rename 的源不存在就抛 ENOENT，跟 Node 一样——这条正是当初漏掉的失败面。
 * 每一步都让出一次事件循环，好让并发调用真的交错起来。
 */
function memoryFs(): FileSystemPort & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  return {
    files,
    async read(p) { await yieldTurn(); return files.get(p); },
    async write(p, data) { await yieldTurn(); files.set(p, data); },
    async remove(p) { await yieldTurn(); files.delete(p); },
    async removeDirectory(prefix) {
      await yieldTurn();
      for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
    },
    async rename(from, to) {
      await yieldTurn();
      const data = files.get(from);
      if (data === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`), {
          code: "ENOENT",
        });
      }
      files.delete(from);
      files.set(to, data);
    },
    async stat(p) {
      const data = files.get(p);
      return data ? { size: data.byteLength, modifiedAt: 0 } : undefined;
    },
    async exists(p) { await yieldTurn(); return files.has(p); },
    async ensureDirectory() { /* 内存里没有目录概念 */ },
    async list() { return []; },
    async listEntries() { return []; },
  };
}

function decode(fs: ReturnType<typeof memoryFs>, file: string): { data: unknown } | undefined {
  const raw = fs.files.get(file);
  return raw ? (JSON.parse(Buffer.from(raw).toString("utf8")) as { data: unknown }) : undefined;
}

/**
 * 线上实际报的错：
 * ENOENT: rename 'session.json.tmp' -> 'session.json'
 * 起因是并发写共用同一个 .tmp，先完成的那个把它改名走了。
 */
test("并发写同一个文件不会撞临时文件，也不会报 ENOENT", async () => {
  const fs = memoryFs();
  const store = new JsonStore(fs);
  const file = "/ws/ses-1/session.json";

  const writes = Array.from({ length: 12 }, (_, index) =>
    store.write(file, "session", { seq: index }));
  const settled = await Promise.allSettled(writes);

  const failed = settled.filter((item) => item.status === "rejected");
  assert.deepEqual(
    failed.map((item) => (item as PromiseRejectedResult).reason?.message),
    [],
    "并发写不该有任何一个失败",
  );

  // 最要命的不是报错，而是中途出现「正文文件不存在」的窗口。
  assert.ok(fs.files.has(file), "写完之后正文必须在");
  const leftovers = [...fs.files.keys()].filter((key) => key.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "不该留下临时文件");
});

test("并发写按提交顺序落盘，最后一次写的内容留在盘上", async () => {
  const fs = memoryFs();
  const store = new JsonStore(fs);
  const file = "/ws/ses-1/session.json";

  await Promise.all(
    Array.from({ length: 6 }, (_, index) => store.write(file, "session", { seq: index })),
  );

  assert.deepEqual(decode(fs, file)?.data, { seq: 5 });
});

test("写不同文件不互相排队，谁也不用等谁", async () => {
  const fs = memoryFs();
  const store = new JsonStore(fs);
  await Promise.all([
    store.write("/a.json", "session", { a: 1 }),
    store.write("/b.json", "session", { b: 2 }),
  ]);
  assert.deepEqual(decode(fs, "/a.json")?.data, { a: 1 });
  assert.deepEqual(decode(fs, "/b.json")?.data, { b: 2 });
});

test("一次写失败不会卡住后面排队的写", async () => {
  const fs = memoryFs();
  const store = new JsonStore(fs);
  const file = "/ws/ses-1/session.json";

  const realWrite = fs.write.bind(fs);
  let failNext = true;
  fs.write = async (p, data) => {
    if (failNext && p.includes(".tmp")) {
      failNext = false;
      throw new Error("磁盘满了");
    }
    return realWrite(p, data);
  };

  const first = store.write(file, "session", { seq: 0 });
  const second = store.write(file, "session", { seq: 1 });

  await assert.rejects(first, /磁盘满了/);
  await second;
  assert.deepEqual(decode(fs, file)?.data, { seq: 1 }, "后一次写必须照常完成");
});

test("改名失败时清掉临时文件，不在目录里留垃圾", async () => {
  const fs = memoryFs();
  const store = new JsonStore(fs);
  const realRename = fs.rename.bind(fs);
  fs.rename = async (from, to) => {
    if (from.includes(".tmp")) throw new Error("改名被拒");
    return realRename(from, to);
  };

  await assert.rejects(store.write("/x.json", "session", { a: 1 }), /改名被拒/);
  assert.deepEqual([...fs.files.keys()].filter((k) => k.endsWith(".tmp")), []);
});

/** patch 是读—改—写，不整体排队就会互相盖掉字段。 */
test("并发 patch 不丢字段：每个人改的那一项都要留下来", async () => {
  const fs = memoryFs();
  const store = new JsonStore(fs);
  const repo = new SessionRepository("/root", "ws-1", fs, store);

  const created = await repo.create({ modelId: "deepseek-v4-flash", localMode: "agent" });

  const usage = { usedTokens: 4200, source: "exact" as const, updatedAt: 1 };
  // 复刻现场：发送路径 await 的 patch 与 contextUsage 那个 void patch 同时打进来。
  await Promise.all([
    repo.patch(created.id, { grokSessionId: "grok-abc" }),
    repo.patch(created.id, { contextUsage: usage }),
    repo.patch(created.id, { modelId: "poe:kimi-k3" }),
    repo.patch(created.id, { title: "登录页改版" }),
  ]);

  const final = await repo.load(created.id);
  assert.equal(final?.grokSessionId, "grok-abc", "丢了它下一次发送就找不到底层会话");
  assert.equal(final?.modelId, "poe:kimi-k3", "丢了它就会拿旧模型去解析");
  assert.equal(final?.contextUsage?.usedTokens, 4200);
  assert.equal(final?.title, "登录页改版");
});

test("patch 不存在的会话返回 undefined，且不阻塞同一会话后续的 patch", async () => {
  const fs = memoryFs();
  const store = new JsonStore(fs);
  const repo = new SessionRepository("/root", "ws-1", fs, store);

  const missing = await repo.patch("ses-nope", { title: "x" });
  assert.equal(missing, undefined);

  const created = await repo.create({ modelId: "deepseek-v4-flash", localMode: "agent" });
  const patched = await repo.patch(created.id, { title: "还能用" });
  assert.equal(patched?.title, "还能用");
});
