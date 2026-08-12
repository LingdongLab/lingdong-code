import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_REPO_CLEARED,
  ACTIVE_REPO_KEY,
  globalStateActiveRepo,
  insideHostWorkspace,
  memoryActiveRepo,
  resolveActiveRepo,
} from "../src/services/active-repo";

test("没选过仓库时回落到宿主工作区的第一个根", () => {
  // 这一条保证「直接打开一个文件夹就用」跟以前行为完全一致，
  // 用户不需要先去选一次仓库。
  assert.equal(
    resolveActiveRepo({ stored: undefined, hostRoots: ["E:/a", "E:/b"] }),
    "E:/a",
  );
});

test("选过的仓库优先于宿主工作区", () => {
  assert.equal(
    resolveActiveRepo({ stored: "E:/picked", hostRoots: ["E:/a"] }),
    "E:/picked",
  );
});

test("空窗口里也能有活动仓库", () => {
  // 解耦的意义就在这里：不打开任何文件夹也能对着一个仓库干活，
  // 换仓库不再需要动窗口。
  assert.equal(resolveActiveRepo({ stored: "E:/picked", hostRoots: [] }), "E:/picked");
});

test("两边都没有就是没有", () => {
  assert.equal(resolveActiveRepo({ stored: undefined, hostRoots: [] }), undefined);
});

test("明确清空后不得回落到宿主根", () => {
  // 左栏点 × 清掉当前后若仍回落宿主根，会立刻又变成「当前」，像删不掉。
  assert.equal(
    resolveActiveRepo({ stored: ACTIVE_REPO_CLEARED, hostRoots: ["E:/a"] }),
    undefined,
  );
  // 纯空白仍视为脏数据，回落宿主根。
  assert.equal(resolveActiveRepo({ stored: "   ", hostRoots: ["E:/a"] }), "E:/a");
});

test("判断活动仓库在不在宿主工作区里，按平台规则比路径", () => {
  // Windows 上大小写和分隔符都可能不同，同一个目录不该被判成两个。
  assert.equal(insideHostWorkspace("E:/repo", ["E:/repo"]), true);
  assert.equal(insideHostWorkspace("E:\\Repo", ["E:/repo"]), true);
  assert.equal(insideHostWorkspace("E:/repo/", ["E:/repo"]), true);
  assert.equal(insideHostWorkspace("E:/other", ["E:/repo"]), false);
  assert.equal(insideHostWorkspace(undefined, ["E:/repo"]), false);
  assert.equal(insideHostWorkspace("E:/repo", []), false);
});

test("globalState 存取：非字符串当成没选过；空串是清空哨兵", () => {
  const bag = new Map<string, unknown>();
  const port = globalStateActiveRepo({
    get: <T>(key: string) => bag.get(key) as T | undefined,
    update: (key, value) => {
      bag.set(key, value);
      return Promise.resolve();
    },
  });

  assert.equal(port.stored(), undefined);
  bag.set(ACTIVE_REPO_KEY, 42);
  assert.equal(port.stored(), undefined);
  bag.set(ACTIVE_REPO_KEY, ACTIVE_REPO_CLEARED);
  assert.equal(port.stored(), ACTIVE_REPO_CLEARED);
});

test("记下选择后能读回来；清掉写入哨兵且不再回落宿主根", async () => {
  const bag = new Map<string, unknown>();
  const port = globalStateActiveRepo({
    get: <T>(key: string) => bag.get(key) as T | undefined,
    update: (key, value) => {
      bag.set(key, value);
      return Promise.resolve();
    },
  });

  await port.remember("E:/repo");
  assert.equal(port.stored(), "E:/repo");
  await port.remember(undefined);
  assert.equal(port.stored(), ACTIVE_REPO_CLEARED);
  assert.equal(
    resolveActiveRepo({ stored: port.stored(), hostRoots: ["E:/host"] }),
    undefined,
  );
});

test("内存实现与 globalState 实现行为一致，供单测替换", async () => {
  const port = memoryActiveRepo("E:/repo");
  assert.equal(port.stored(), "E:/repo");
  await port.remember("E:/other");
  assert.equal(port.stored(), "E:/other");
  await port.remember(undefined);
  assert.equal(port.stored(), ACTIVE_REPO_CLEARED);
});
