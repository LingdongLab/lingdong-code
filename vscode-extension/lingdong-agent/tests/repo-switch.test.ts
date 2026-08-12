import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ChangeFacade } from "../src/services/change-facade";
import { createControllerHarness, flush } from "./support/controller-harness";
import { __test as vscodeHarness } from "./support/vscode-stub";

/**
 * 换仓库不重开窗口。
 *
 * 用户反复撞上的就是这一条：加一个文件夹当工作区，窗口重开一次，会话看起来像丢了。
 * 根因是「仓库」曾经就是 VS Code 的工作区文件夹，而 VS Code 在
 * 「单文件夹 → 多文件夹」这一步必然重载。现在仓库归扩展自己存，
 * 换仓库退化成一次纯内部的拆建。
 */

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lingdong-repo-"));
}

test("换仓库：Grok 拿到新 cwd，宿主工作区一动不动", async () => {
  const harness = createControllerHarness();
  const other = tempRepo();
  try {
    await harness.controller.sendPrompt("先在第一个仓库里说一句");
    assert.equal(
      harness.runtime().options.workspace,
      harness.workspaceRoot,
      "第一个子进程的 cwd 应该是初始仓库",
    );
    const first = harness.runtime();

    await harness.controller.activateRepo(other);
    await flush(6);

    assert.equal(harness.controller.activeRoot(), other);
    // 旧子进程的 cwd 是上一个仓库，不杀掉它工具调用会落到错的目录去。
    assert.ok(first.calls.includes("dispose"), "旧的 Grok 子进程必须被回收");

    const commands = vscodeHarness.executedCommands();
    assert.ok(
      !commands.includes("vscode.openFolder"),
      `换仓库不该重开窗口，实际执行了：${commands.join(", ")}`,
    );
    assert.deepEqual(
      vscodeHarness.workspaceFolderPaths(),
      [harness.workspaceRoot],
      "宿主工作区不该被改，改了就会触发重载",
    );

    // 新连接由预热拉起，cwd 必须是新仓库。
    await harness.controller.sendPrompt("在新仓库里说一句");
    assert.equal(harness.runtime().options.workspace, other);
  } finally {
    await harness.dispose();
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("切到空仓库：对话区必须清空，不能继续显示上一个仓库的内容", async () => {
  // 这是左栏「添加仓库」看起来像坏了的直接原因：换根后 bootstrap 发现新仓库
  // 没有会话就不会发 restore，若也不发 clear，中间栏会原样留着旧对话。
  const harness = createControllerHarness();
  const other = tempRepo();
  try {
    await harness.controller.sendPrompt("旧仓库里的对话");
    harness.clearMessages();

    await harness.controller.activateRepo(other);
    await flush(6);

    assert.ok(
      harness.messagesOfType("clear").length > 0,
      "切到空仓库必须先 clear，否则界面还挂着旧对话",
    );
    assert.equal(harness.controller.activeSessionId, undefined);
    assert.equal(harness.controller.activeRoot(), other);
    const workspaces = harness.messagesOfType("workspaces").at(-1);
    assert.equal(workspaces?.current?.path, other);
  } finally {
    await harness.dispose();
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("换仓库后会话列表按新仓库重挂，切回来原来的还在", async () => {
  // 会话按根哈希分目录存；重挂闸门没复位的话，新仓库会继续显示上一个仓库的会话。
  const harness = createControllerHarness();
  const other = tempRepo();
  try {
    await harness.controller.sendPrompt("第一个仓库的会话");
    const firstSession = harness.controller.activeSessionId;
    assert.ok(firstSession);

    await harness.controller.activateRepo(other);
    await flush(6);
    assert.equal(
      harness.controller.activeSessionId,
      undefined,
      "新仓库里不该继承上一个仓库的活动会话",
    );

    await harness.controller.activateRepo(harness.workspaceRoot);
    await flush(6);
    assert.equal(
      harness.controller.activeSessionId,
      firstSession,
      "切回原仓库应该恢复到原来那个会话",
    );
  } finally {
    await harness.dispose();
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("换成同一个目录不做任何拆建", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("说一句");
    const runtime = harness.runtime();
    const before = harness.runtimes.length;

    // 大小写与尾随分隔符不同仍是同一个目录，不该白拆一次。
    await harness.controller.activateRepo(harness.workspaceRoot);
    await flush(3);

    assert.equal(harness.runtimes.length, before, "不该新建子进程");
    assert.ok(!runtime.calls.includes("dispose"), "不该回收还在用的子进程");
  } finally {
    await harness.dispose();
  }
});

test("换成不存在的目录：拒绝并说明原因，当前仓库保持原样", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("说一句");
    harness.clearMessages();

    const gone = path.join(os.tmpdir(), "lingdong-not-here-42");
    await harness.controller.activateRepo(gone);

    assert.equal(harness.controller.activeRoot(), harness.workspaceRoot);
    const notice = harness.messagesOfType("notice").find((item) => item.message.includes("不存在"));
    assert.ok(notice, "应当明确说清为什么没切过去");
  } finally {
    await harness.dispose();
  }
});

test("换仓库：先发 workspaces/clear，不必等 Grok dispose 完成", async () => {
  const harness = createControllerHarness();
  const other = tempRepo();
  try {
    await harness.controller.sendPrompt("旧仓");
    const first = harness.runtime();
    const order: string[] = [];
    harness.controller.addPoster((message) => {
      if (message.type === "workspaces" || message.type === "clear") order.push(message.type);
    });
    const originalDispose = first.dispose.bind(first);
    first.dispose = async () => {
      order.push("dispose");
      return originalDispose();
    };

    await harness.controller.activateRepo(other);
    await flush(6);

    assert.equal(harness.controller.activeRoot(), other);
    const clearAt = order.indexOf("clear");
    const workspacesAt = order.indexOf("workspaces");
    const disposeAt = order.indexOf("dispose");
    assert.ok(clearAt >= 0, "应发 clear");
    assert.ok(workspacesAt >= 0, "应发 workspaces");
    assert.ok(
      disposeAt < 0 || Math.min(clearAt, workspacesAt) < disposeAt,
      `换皮应早于 dispose，实际顺序：${order.join(" → ")}`,
    );
  } finally {
    await harness.dispose();
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("连点换仓：只落到最后一次目标", async () => {
  const harness = createControllerHarness();
  const mid = tempRepo();
  const last = tempRepo();
  try {
    await harness.controller.sendPrompt("起步");
    harness.clearMessages();

    const first = harness.controller.activateRepo(mid);
    const second = harness.controller.activateRepo(last);
    await Promise.all([first, second]);
    await flush(8);

    assert.equal(harness.controller.activeRoot(), last);
    const currents = harness.messagesOfType("workspaces")
      .map((item) => item.current?.path)
      .filter((path): path is string => Boolean(path));
    assert.ok(currents.includes(last), "最终 current 应是最后一次点击");
    assert.ok(!currents.includes(mid) || currents.at(-1) === last, "不应停在中间仓库");
  } finally {
    await harness.dispose();
    fs.rmSync(mid, { recursive: true, force: true });
    fs.rmSync(last, { recursive: true, force: true });
  }
});

test("变更跟踪换根时整套重建，不继续对着旧目录算差异", async () => {
  // ChangeFacade.setup 以前只要 tracker 已存在就直接 return，只更新了根字段。
  // 于是切了仓库之后，追踪器还绑在旧根上、快照还写进旧哈希目录，而且一声不响。
  const logLines: string[] = [];
  const snapshotRoot = tempRepo();
  const facade = new ChangeFacade({
    post: () => undefined,
    log: (line) => logLines.push(line),
    postState: () => undefined,
    ui: { } as never,
    store: { } as never,
    fs: { } as never,
    persistence: () => undefined,
    flushPersistence: () => undefined,
    snapshotRoot: () => snapshotRoot,
  });

  try {
    facade.setup("E:\\Code\\First");
    const first = facade.tracker;
    const firstSnapshots = facade.snapshots;
    assert.ok(first && firstSnapshots);

    // 同一个根（只差大小写与分隔符）不该重建。
    facade.setup("e:/code/first");
    assert.equal(facade.tracker, first, "同一个目录不该重建追踪器");

    facade.setup("E:\\Code\\Second");
    assert.notEqual(facade.tracker, first, "换根必须换追踪器");
    assert.notEqual(facade.snapshots, firstSnapshots, "换根必须换快照仓库");
    assert.notEqual(
      facade.snapshots?.baseDirectory,
      firstSnapshots.baseDirectory,
      "快照目录按根哈希分开，换根后不该还写在旧目录",
    );
  } finally {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
});
