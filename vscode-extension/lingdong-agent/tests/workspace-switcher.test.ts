import assert from "node:assert/strict";
import test from "node:test";
import * as vscode from "vscode";
import type { HostToWebviewMessage } from "../src/messages";
import { parseWebviewMessage } from "../src/messages";
import { WorkspaceSwitcher } from "../src/services/workspace-switcher";
import {
  MAX_WORKSPACE_HISTORY,
  forgetWorkspace,
  globalStateWorkspaceHistory,
  memoryDismissedWorkspaces,
  memoryWorkspaceHistory,
  rememberWorkspace,
  samePath,
  type WorkspaceEntry,
} from "../src/workspace-history";
import { __test as vscodeHarness } from "./support/vscode-stub";

/**
 * 左栏的工作区区块。
 * 面板之前没有任何打开或切换文件夹的入口，没打开工作区就只能撞上一句报错。
 */

function entry(path: string, openedAt = 1): WorkspaceEntry {
  return { path, name: path.split(/[\\/]/).pop() ?? path, openedAt };
}

function createSwitcher(options: {
  history?: WorkspaceEntry[];
  exists?: (path: string) => boolean;
  /** 不给就回落到宿主工作区的第一个根，跟真实的 resolveActiveRepo 一致。 */
  activeRoot?: string;
} = {}) {
  const posted: HostToWebviewMessage[] = [];
  const logLines: string[] = [];
  const history = memoryWorkspaceHistory(options.history ?? []);
  const dismissed = memoryDismissedWorkspaces();
  // 真实的切换由控制器编排；这里只记下它被请求切到哪，并让活动仓库跟着变，
  // 后续的 publish 才反映得出切换结果。
  const activated: string[] = [];
  let cleared = 0;
  // 与生产一致：明确清空后不再回落宿主根（用空串哨兵）。
  let active: string | undefined = options.activeRoot;
  let clearedExplicitly = false;
  const switcher = new WorkspaceSwitcher({
    post: (message) => posted.push(message),
    log: (line) => logLines.push(line),
    activeRoot: () => {
      if (clearedExplicitly) return undefined;
      return active ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    },
    activateRepo: (target) => {
      activated.push(target);
      active = target;
      clearedExplicitly = false;
      return Promise.resolve();
    },
    clearRepo: () => {
      cleared += 1;
      active = undefined;
      clearedExplicitly = true;
      return Promise.resolve();
    },
    history,
    dismissed,
    directoryExists: (path) => Promise.resolve(options.exists?.(path) ?? true),
    now: () => 1_000,
  });
  return { switcher, posted, logLines, history, dismissed, activated, getCleared: () => cleared };
}

// ---------------------------------------------------------------------------
// 历史记录本身
// ---------------------------------------------------------------------------

test("同一个目录不会因为大小写或分隔符不同而出现两条", () => {
  assert.equal(samePath("E:\\Code\\Demo", "e:/code/demo"), true);
  assert.equal(samePath("E:\\Code\\Demo\\", "E:\\Code\\Demo"), true);
  assert.equal(samePath("E:\\Code\\Demo", "E:\\Code\\Other"), false);

  const history = rememberWorkspace([entry("E:\\Code\\Demo", 1)], entry("e:/code/demo", 2));
  assert.equal(history.length, 1);
  assert.equal(history[0]?.openedAt, 2);
});

test("最近打开的排在最前，超出上限的丢掉", () => {
  let history: WorkspaceEntry[] = [];
  for (let index = 0; index < MAX_WORKSPACE_HISTORY + 3; index += 1) {
    history = rememberWorkspace(history, entry(`E:\\Code\\p${index}`, index));
  }
  assert.equal(history.length, MAX_WORKSPACE_HISTORY);
  assert.equal(history[0]?.path, `E:\\Code\\p${MAX_WORKSPACE_HISTORY + 2}`);
  // 最早的几个被挤出去。
  assert.equal(history.some((item) => item.path === "E:\\Code\\p0"), false);
});

test("移除按同样的路径比较规则", () => {
  const history = forgetWorkspace([entry("E:\\Code\\Demo"), entry("E:\\Code\\Other")], "e:/code/demo");
  assert.deepEqual(history.map((item) => item.path), ["E:\\Code\\Other"]);
});

test("存量数据里残缺的条目当作没有", () => {
  vscodeHarness.reset();
  const memento = vscodeHarness.createMemento();
  vscodeHarness.state.globalState.set("lingdongAgent.recentWorkspaces", [
    { path: "E:\\Code\\Demo", name: "Demo", openedAt: 1 },
    { path: "E:\\Code\\NoTime", name: "NoTime" },
    { name: "NoPath", openedAt: 2 },
    "E:\\Code\\JustAString",
    null,
  ]);

  const port = globalStateWorkspaceHistory(memento);
  assert.deepEqual(port.get().map((item) => item.path), ["E:\\Code\\Demo"]);
});

test("存的不是数组时返回空列表而不是抛错", () => {
  vscodeHarness.reset();
  const memento = vscodeHarness.createMemento();
  vscodeHarness.state.globalState.set("lingdongAgent.recentWorkspaces", { broken: true });
  assert.deepEqual(globalStateWorkspaceHistory(memento).get(), []);
});

// ---------------------------------------------------------------------------
// 面板行为
// ---------------------------------------------------------------------------

test("当前工作区单独显示，不在最近列表里重复一遍", () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, posted } = createSwitcher({
    history: [entry("E:\\Code\\Demo"), entry("E:\\Code\\Other")],
  });

  switcher.publish();

  const view = posted.at(-1) as Extract<HostToWebviewMessage, { type: "workspaces" }>;
  assert.equal(view.type, "workspaces");
  assert.equal(view.current?.name, "Demo");
  assert.deepEqual(view.recent.map((item) => item.path), ["E:\\Code\\Other"]);
});

test("没打开文件夹时 current 缺省，列表照常给", () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace(undefined);
  const { switcher, posted } = createSwitcher({ history: [entry("E:\\Code\\Demo")] });

  switcher.publish();

  const view = posted.at(-1) as Extract<HostToWebviewMessage, { type: "workspaces" }>;
  assert.equal(view.current, undefined);
  assert.deepEqual(view.recent.map((item) => item.path), ["E:\\Code\\Demo"]);
});

test("启动时把当前工作区记进历史", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, history } = createSwitcher();

  await switcher.recordCurrent();

  assert.deepEqual(history.get().map((item) => item.path), ["E:\\Code\\Demo"]);
});

test("添加文件夹：用户取消对话框就什么都不做", async () => {
  vscodeHarness.reset();
  const { switcher, history } = createSwitcher();
  vscodeHarness.queueOpenDialog(undefined);

  await switcher.addFolder();

  assert.deepEqual(vscodeHarness.executedCommands(), []);
  assert.deepEqual(history.get(), []);
});

test("空窗口里添加仓库：不开窗口，直接切过去", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace(undefined);
  const { switcher, history, activated } = createSwitcher();
  vscodeHarness.queueOpenDialog([vscode.Uri.file("E:\\Code\\Picked")]);

  await switcher.addFolder();

  assert.deepEqual(vscodeHarness.executedCommands(), [], "不该再走 vscode.openFolder");
  assert.deepEqual(activated, ["E:\\Code\\Picked"]);
  assert.deepEqual(history.get().map((item) => item.path), ["E:\\Code\\Picked"]);
});

test("已经有仓库时再添加一个：窗口和宿主工作区都一动不动", async () => {
  // 这是用户反复抱怨的那件事。以前无论走 openFolder 还是 updateWorkspaceFolders，
  // 都会重开或重载一次；现在仓库跟 VS Code 工作区解耦，两者都不该被碰。
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, history, posted, activated } = createSwitcher();
  vscodeHarness.queueOpenDialog([vscode.Uri.file("E:\\Code\\Extra")]);

  await switcher.addFolder();

  assert.deepEqual(vscodeHarness.executedCommands(), []);
  assert.deepEqual(
    vscodeHarness.workspaceFolderPaths(),
    ["E:\\Code\\Demo"],
    "宿主工作区不该被改，改了就会触发单文件夹→多文件夹的重载",
  );
  assert.deepEqual(activated, ["E:\\Code\\Extra"]);
  // 起始历史是空的，所以只有新加的这一条；当前仓库由控制器在启动时 recordCurrent。
  assert.deepEqual(history.get().map((item) => item.path), ["E:\\Code\\Extra"]);

  const view = [...posted].reverse().find((message) => message.type === "workspaces") as
    Extract<HostToWebviewMessage, { type: "workspaces" }>;
  assert.equal(view.current?.path, "E:\\Code\\Extra", "切完之后当前仓库就是新加的那个");
  // 宿主还开着 Demo：扁平列在 recent 里，不再嵌进当前节点。
  assert.equal(view.extraFolders, undefined);
  assert.deepEqual(view.recent.map((item) => item.path), ["E:\\Code\\Demo"]);
});

test("添加的就是当前仓库：说一句就好，不白切一次", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, posted, activated } = createSwitcher();
  vscodeHarness.queueOpenDialog([vscode.Uri.file("e:/code/demo")]);

  await switcher.addFolder();

  assert.deepEqual(activated, [], "同一个目录不该触发一次完整的拆建");
  const notice = posted.find((message) => message.type === "notice");
  assert.ok(notice && "message" in notice && /已经在这个仓库里.*demo/i.test(notice.message));
});

test("其它仓库扁平列出：宿主根与历史合并，当前不重复", () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  vscodeHarness.setExtraFolders("E:\\Code\\Extra");
  const { switcher, posted } = createSwitcher({
    history: [entry("E:\\Code\\Demo"), entry("E:\\Code\\Extra"), entry("E:\\Code\\Other")],
  });

  switcher.publish();

  const view = posted.at(-1) as Extract<HostToWebviewMessage, { type: "workspaces" }>;
  assert.equal(view.current?.path, "E:\\Code\\Demo");
  assert.equal(view.extraFolders, undefined, "不再下发嵌套用的 extraFolders");
  assert.deepEqual(
    view.recent.map((item) => item.path).sort(),
    ["E:\\Code\\Extra", "E:\\Code\\Other"].sort(),
  );
});

test("从列表移除其它仓库：只忘掉记录，不切当前", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, history, activated, posted } = createSwitcher({
    history: [entry("E:\\Code\\Demo"), entry("E:\\Code\\Other")],
  });

  await switcher.remove("E:\\Code\\Other");

  assert.deepEqual(history.get().map((item) => item.path), ["E:\\Code\\Demo"]);
  assert.deepEqual(activated, [], "移除的不是当前，不该拆建");
  assert.ok(posted.some((message) => message.type === "notice" && message.message.includes("Other")));
});

test("移除仍开着的宿主根：不得被 publish 立刻塞回列表", async () => {
  // 日志里「已清空活动仓库」狂刷、× 点了又出现，根因就是 hostRoots 无条件并进 recent。
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  vscodeHarness.setExtraFolders("E:\\Code\\Extra");
  const { switcher, posted, dismissed } = createSwitcher({
    history: [entry("E:\\Code\\Extra")],
  });

  await switcher.remove("E:\\Code\\Extra");

  assert.ok(dismissed.get().some((path) => /extra/i.test(path)));
  const view = [...posted].reverse().find((message) => message.type === "workspaces") as
    Extract<HostToWebviewMessage, { type: "workspaces" }>;
  assert.ok(view);
  assert.equal(
    view.recent.some((item) => /extra/i.test(item.path)),
    false,
    "宿主仍开着也不能自动冒回 recent",
  );
});

test("移除当前仓库：有备胎就切过去", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, history, activated } = createSwitcher({
    history: [entry("E:\\Code\\Demo"), entry("E:\\Code\\Other")],
  });

  await switcher.remove("E:\\Code\\Demo");

  assert.deepEqual(history.get().map((item) => item.path), ["E:\\Code\\Other"]);
  assert.deepEqual(activated, ["E:\\Code\\Other"]);
});

test("移除当前且没有备胎：清空活动仓库", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace(undefined);
  const { switcher, getCleared } = createSwitcher({
    activeRoot: "E:\\Code\\Alone",
    history: [entry("E:\\Code\\Alone")],
  });

  await switcher.remove("E:\\Code\\Alone");

  assert.equal(getCleared(), 1);
});

test("切到列表里的仓库：窗口不动，只做一次内部拆建", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, activated } = createSwitcher({ history: [entry("E:\\Code\\Other")] });

  await switcher.switchTo("E:\\Code\\Other");

  assert.deepEqual(vscodeHarness.executedCommands(), []);
  assert.deepEqual(vscodeHarness.workspaceFolderPaths(), ["E:\\Code\\Demo"]);
  assert.deepEqual(activated, ["E:\\Code\\Other"]);
});

test("切到当前这个仓库不做任何事", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, activated } = createSwitcher({ history: [entry("E:\\Code\\Demo")] });

  await switcher.switchTo("e:/code/demo");

  assert.deepEqual(activated, [], "不该白白拆建一次");
});

test("切到宿主还开着的另一个根：这也是一次真切换", async () => {
  // 以前这一条被当成「已经在工作区里了」而直接忽略，于是用户点了没反应。
  // 现在活动仓库跟宿主工作区是两件事，切过去是有意义的。
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  vscodeHarness.setExtraFolders("E:\\Code\\Extra");
  const { switcher, activated } = createSwitcher({ history: [entry("E:\\Code\\Extra")] });

  await switcher.switchTo("E:\\Code\\Extra");

  assert.deepEqual(vscodeHarness.executedCommands(), []);
  assert.deepEqual(activated, ["E:\\Code\\Extra"]);
});

test("目录已经不在了：不切过去，从列表移除并说明原因", async () => {
  vscodeHarness.reset();
  vscodeHarness.setWorkspace("E:\\Code\\Demo", "Demo");
  const { switcher, posted, history, activated } = createSwitcher({
    history: [entry("E:\\Code\\Demo"), entry("E:\\Code\\Gone")],
    exists: (path) => !path.includes("Gone"),
  });

  await switcher.switchTo("E:\\Code\\Gone");

  assert.deepEqual(activated, [], "路径失效就不该拆掉当前仓库");
  assert.deepEqual(history.get().map((item) => item.path), ["E:\\Code\\Demo"]);
  const notice = posted.find((message) => message.type === "notice");
  assert.ok(notice && "message" in notice && notice.message.includes("Gone"));
  // 移除之后立刻重推列表，界面上那一条要跟着消失。
  assert.ok(posted.some((message) => message.type === "workspaces"));
});

// ---------------------------------------------------------------------------
// 消息校验
// ---------------------------------------------------------------------------

test("切换工作区的路径必须是非空字符串", () => {
  assert.deepEqual(
    parseWebviewMessage({ type: "switchWorkspace", path: " E:\\Code\\Demo " }),
    { type: "switchWorkspace", path: "E:\\Code\\Demo" },
  );
  assert.equal(parseWebviewMessage({ type: "switchWorkspace", path: "   " }), undefined);
  assert.equal(parseWebviewMessage({ type: "switchWorkspace", path: 42 }), undefined);
  assert.equal(parseWebviewMessage({ type: "switchWorkspace" }), undefined);
  assert.equal(parseWebviewMessage({ type: "switchWorkspace", path: "x".repeat(4_001) }), undefined);
  assert.deepEqual(parseWebviewMessage({ type: "openFolder" }), { type: "openFolder" });
});
