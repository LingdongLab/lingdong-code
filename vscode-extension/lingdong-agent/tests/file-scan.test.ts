import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import type { DirectoryEntry } from "../src/file-system-port";
import { EXCLUDED_DIRECTORIES, scanFiles, type ScanPort } from "../src/services/file-scan";

const ROOT = path.join("E:", "repo");

/** 用一张「目录 → 条目」表冒充文件系统，键是相对根的 POSIX 路径。 */
function fakeFs(tree: Record<string, DirectoryEntry[]>): ScanPort & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    listEntries: (absolutePath) => {
      const relative = path.relative(ROOT, absolutePath).replace(/\\/g, "/");
      reads.push(relative);
      return Promise.resolve(tree[relative] ?? []);
    },
  };
}

function file(name: string): DirectoryEntry {
  return { name, isDirectory: false };
}

function dir(name: string): DirectoryEntry {
  return { name, isDirectory: true };
}

test("返回相对路径，排好序，不带绝对路径", async () => {
  const fs = fakeFs({
    "": [file("readme.md"), dir("src")],
    src: [file("main.ts"), file("index.ts")],
  });
  const result = await scanFiles(ROOT, { limit: 100, fs });
  assert.deepEqual(result.files, ["readme.md", "src/index.ts", "src/main.ts"]);
  assert.equal(result.truncated, false);
  for (const relative of result.files) {
    assert.ok(!relative.includes("E:"), `泄漏了绝对路径：${relative}`);
    assert.ok(!relative.includes("\\"), `分隔符没归一：${relative}`);
  }
});

test("排除目录整棵不进：不列它，也不返回里面的文件", async () => {
  const tree: Record<string, DirectoryEntry[]> = {
    "": [file("app.ts"), ...EXCLUDED_DIRECTORIES.map(dir)],
  };
  for (const name of EXCLUDED_DIRECTORIES) tree[name] = [file("junk.ts"), dir("nested")];

  const fs = fakeFs(tree);
  const result = await scanFiles(ROOT, { limit: 100, fs });
  assert.deepEqual(result.files, ["app.ts"]);
  // 连列一次都不该列：node_modules 里有几十万个条目，光列一层就够卡了。
  for (const name of EXCLUDED_DIRECTORIES) {
    assert.ok(!fs.reads.includes(name), `不该进 ${name}`);
  }
});

test("广度优先：上限用完时留下的是浅层文件，不是某一条深路径", async () => {
  // 深度优先会把配额全花在 deep 那条链上，浅层的 a.ts / b.ts 反而一个都拿不到。
  const fs = fakeFs({
    "": [dir("deep"), file("a.ts"), file("b.ts")],
    deep: [dir("1"), file("x.ts")],
    "deep/1": [dir("2"), file("y.ts")],
    "deep/1/2": [file("z.ts")],
  });
  const result = await scanFiles(ROOT, { limit: 2, fs });
  assert.deepEqual(result.files, ["a.ts", "b.ts"]);
  assert.equal(result.truncated, true);
});

test("撞上限要标 truncated，没走完的目录也算", async () => {
  const fs = fakeFs({
    "": [file("a.ts"), dir("sub")],
    sub: [file("b.ts")],
  });
  // 一个文件就到顶：sub 还排在队列里没展开，结果必然不完整。
  const capped = await scanFiles(ROOT, { limit: 1, fs });
  assert.equal(capped.files.length, 1);
  assert.equal(capped.truncated, true);

  const full = await scanFiles(ROOT, { limit: 50, fs });
  assert.deepEqual(full.files, ["a.ts", "sub/b.ts"]);
  assert.equal(full.truncated, false);
});

test("空目录与列不动的目录都不抛错", async () => {
  const fs = fakeFs({ "": [dir("locked")] });
  const result = await scanFiles(ROOT, { limit: 10, fs });
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, false);
});

test("上限为 0 时直接返回，不去碰文件系统", async () => {
  const fs = fakeFs({ "": [file("a.ts")] });
  const result = await scanFiles(ROOT, { limit: 0, fs });
  assert.deepEqual(result.files, []);
  assert.deepEqual(fs.reads, []);
});
