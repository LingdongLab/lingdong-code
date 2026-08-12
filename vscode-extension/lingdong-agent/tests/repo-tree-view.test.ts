/**
 * 左栏「仓库 → 会话」统一树。
 *
 * 这棵树承担的是一个认知问题：会话本来就按打开的文件夹隔离，但以前分成两个并列区块，
 * 用户看不出从属关系。所以这里的断言重点在层级（会话确实挂在当前仓库下）和空状态文案
 * （每种空都要说清楚原因，不能留白让人以为坏了）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { SessionListItemView, WebviewToHostMessage } from "../src/messages";
import { createRepoTreeState, groupSessions, renderRepoTree } from "../src/webview/repo-tree";

function installDom(): HTMLElement {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  const { window } = dom;
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Event", { value: window.Event, configurable: true });
  return window.document.getElementById("root") as unknown as HTMLElement;
}

function session(patch: Partial<SessionListItemView> & { id: string }): SessionListItemView {
  return {
    title: patch.id,
    updatedAt: Date.now(),
    localMode: "agent",
    pinned: false,
    archived: false,
    pendingChanges: 0,
    conflictChanges: 0,
    hasUnfinishedPlan: false,
    ...patch,
  };
}

test("会话平铺在当前仓库节点下，固定项置顶并带图钉", () => {
  const root = installDom();
  renderRepoTree(root, {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [],
    sessions: [
      session({ id: "ses-1", title: "普通会话" }),
      session({ id: "ses-2", title: "固定会话", pinned: true }),
    ],
    activeSessionId: "ses-1",
  }, createRepoTreeState(), () => {});

  const current = root.querySelector(".repo-node.current");
  assert.ok(current, "应有当前仓库节点");
  assert.equal(current?.querySelector(".repo-name")?.textContent, "Demo");
  assert.equal(current?.querySelector(".repo-count")?.textContent, "2");

  const titles = [...root.querySelectorAll(".repo-sessions .repo-session-title")]
    .map((node) => node.textContent);
  assert.deepEqual(titles, ["固定会话", "普通会话"]);
  assert.ok(root.querySelector(".repo-session-pin"), "固定项应有图钉标记");
  assert.ok(root.querySelector(".repo-session.active"), "当前会话应高亮");
});

test("点会话发 loadSession，点⋯发 openSessionMenu", () => {
  const root = installDom();
  const sent: WebviewToHostMessage[] = [];
  renderRepoTree(root, {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [],
    sessions: [session({ id: "ses-1" })],
  }, createRepoTreeState(), (message) => sent.push(message));

  root.querySelector<HTMLButtonElement>(".repo-session")?.click();
  root.querySelector<HTMLButtonElement>(".repo-session-more")?.click();

  assert.deepEqual(sent, [
    { type: "loadSession", sessionId: "ses-1" },
    { type: "openSessionMenu", sessionId: "ses-1" },
  ]);
});

test("已归档默认折叠，展开后才出现", () => {
  const root = installDom();
  const state = createRepoTreeState();
  const view = {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [],
    sessions: [session({ id: "ses-1" }), session({ id: "old", archived: true })],
  };
  renderRepoTree(root, view, state, () => {});

  // 计数只算活跃会话，否则归档越多这个数字越没意义。
  assert.equal(root.querySelector(".repo-count")?.textContent, "1");
  assert.equal(root.querySelectorAll(".repo-session-row").length, 1);

  const toggle = root.querySelector<HTMLButtonElement>(".repo-archived-toggle");
  assert.equal(toggle?.textContent, "▸ 已归档 1");
  toggle?.click();

  assert.equal(root.querySelectorAll(".repo-session-row").length, 2);
  assert.ok(root.querySelector(".repo-session-row.archived"));
});

test("折叠当前仓库后会话全部收起", () => {
  const root = installDom();
  const state = createRepoTreeState();
  renderRepoTree(root, {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [],
    sessions: [session({ id: "ses-1" })],
  }, state, () => {});

  root.querySelector<HTMLButtonElement>(".repo-head")?.click();

  assert.equal(root.querySelectorAll(".repo-session-row").length, 0);
  assert.equal(root.querySelector(".repo-head")?.getAttribute("aria-expanded"), "false");
});

test("其它仓库只有一行，点击切换工作区", () => {
  const root = installDom();
  const sent: WebviewToHostMessage[] = [];
  const optimistic: string[] = [];
  renderRepoTree(root, {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [
      { path: "E:\\Code\\Other", name: "Other" },
      { path: "E:\\Code\\Third", name: "Third" },
    ],
    sessions: [],
  }, createRepoTreeState(), (message) => sent.push(message), (entry) => {
    optimistic.push(entry.path);
  });

  const others = root.querySelectorAll(".repo-node:not(.current)");
  assert.equal(others.length, 2);
  // 名字可能被截断，完整路径挂在 title 上。
  assert.ok((others[0]?.querySelector(".repo-head") as HTMLElement).title.startsWith("E:\\Code\\Other"));

  others[1]?.querySelector<HTMLButtonElement>(".repo-head")?.click();
  assert.deepEqual(optimistic, ["E:\\Code\\Third"], "应对标 Cursor：先乐观换皮");
  assert.deepEqual(sent, [{ type: "switchWorkspace", path: "E:\\Code\\Third" }]);
});

test("当前仓库下面只挂会话，不嵌其它文件夹——对齐 Cursor", () => {
  // 以前把编辑器里开着的文件夹嵌在当前仓库下，点一下整仓切换，
  // 用户感觉「点里面却跳到外面」。那些根现在应出现在 recent 扁平列表里。
  const root = installDom();
  const sent: WebviewToHostMessage[] = [];
  renderRepoTree(root, {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    extraFolders: [{ path: "E:\\Code\\Extra", name: "Extra" }],
    recent: [{ path: "E:\\Code\\Extra", name: "Extra" }],
    sessions: [session({ id: "ses-1" })],
  }, createRepoTreeState(), (message) => sent.push(message));

  assert.equal(root.querySelectorAll(".repo-folder").length, 0, "不再嵌套可点文件夹");
  assert.equal(root.querySelectorAll(".repo-node").length, 2, "其它仓库是兄弟节点");
  assert.equal(root.querySelectorAll(".repo-session-row").length, 1);
  assert.equal(root.querySelector(".repo-node.current .repo-session-title")?.textContent, "ses-1");
});

test("仓库行可以点 × 从列表移除", () => {
  const root = installDom();
  const sent: WebviewToHostMessage[] = [];
  renderRepoTree(root, {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [{ path: "E:\\Code\\Other", name: "Other" }],
    sessions: [],
  }, createRepoTreeState(), (message) => sent.push(message));

  const removes = root.querySelectorAll<HTMLButtonElement>(".repo-remove");
  assert.equal(removes.length, 2, "当前和其它仓库都有移除入口");
  removes[1]?.click();
  assert.deepEqual(sent, [{ type: "removeWorkspace", path: "E:\\Code\\Other" }]);
});

test("还没选仓库时指向选择入口，而不是留一片空白", () => {
  const root = installDom();
  renderRepoTree(root, { recent: [], sessions: [] }, createRepoTreeState(), () => {});

  assert.equal(root.querySelector(".repo-name")?.textContent, "未选择仓库");
  assert.match(root.querySelector(".repo-hint")?.textContent ?? "", /先选一个文件夹/);
});

test("有工作区但没有会话：区分「没有对话」和「搜不到」", () => {
  const root = installDom();
  const base = { current: { path: "E:\\Code\\Demo", name: "Demo" }, recent: [], sessions: [] };

  renderRepoTree(root, base, createRepoTreeState(), () => {});
  assert.match(root.querySelector(".repo-hint")?.textContent ?? "", /还没有对话/);

  renderRepoTree(root, { ...base, query: "找不到的东西" }, createRepoTreeState(), () => {});
  assert.match(root.querySelector(".repo-hint")?.textContent ?? "", /没有匹配的对话/);
});

test("按时间切段：固定置顶，空段不占位", () => {
  const now = new Date("2026-08-09T15:00:00").getTime();
  const day = 86_400_000;
  const groups = groupSessions([
    session({ id: "pin", pinned: true, updatedAt: now - 30 * day }),
    session({ id: "now", updatedAt: now - 3600_000 }),
    session({ id: "yst", updatedAt: now - day }),
    session({ id: "old", updatedAt: now - 90 * day }),
  ], now);

  assert.deepEqual(
    groups.map((group) => [group.label, group.sessions.map((item) => item.id)]),
    [["固定", ["pin"]], ["今天", ["now"]], ["昨天", ["yst"]], ["更早", ["old"]]],
    "本周段没有会话就不该冒出一个空段头",
  );
});

test("分组段头可折叠，折叠后该段会话收起", () => {
  const root = installDom();
  const state = createRepoTreeState();
  const view = {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [],
    sessions: [session({ id: "ses-1" }), session({ id: "ses-2", pinned: true })],
  };
  renderRepoTree(root, view, state, () => {});

  const heads = [...root.querySelectorAll<HTMLButtonElement>(".repo-group-head")];
  assert.deepEqual(heads.map((head) => head.dataset.group), ["pinned", "today"]);
  assert.equal(root.querySelectorAll(".repo-session-row").length, 2);

  heads[1]?.click();
  assert.equal(root.querySelectorAll(".repo-session-row").length, 1, "只收起被点的那段");
  assert.equal(
    root.querySelector<HTMLElement>('.repo-group-head[data-group="today"]')
      ?.getAttribute("aria-expanded"),
    "false",
  );
});

test("搜索时忽略折叠状态，否则「搜到了却看不见」", () => {
  const root = installDom();
  const state = createRepoTreeState();
  state.collapsedGroups.today = true;
  renderRepoTree(root, {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [],
    sessions: [session({ id: "ses-1" })],
    query: "ses",
  }, state, () => {});

  assert.equal(root.querySelectorAll(".repo-session-row").length, 1);
});

test("冲突优先于待处理变更显示徽标，运行中会话有脉冲点", () => {
  const root = installDom();
  renderRepoTree(root, {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [],
    sessions: [
      session({ id: "conflict", pendingChanges: 5, conflictChanges: 2 }),
      session({ id: "pending", pendingChanges: 3 }),
    ],
    runningSessionId: "conflict",
  }, createRepoTreeState(), () => {});

  const badges = [...root.querySelectorAll(".repo-session-badge")];
  assert.deepEqual(badges.map((node) => node.textContent), ["2", "3"]);
  assert.ok(badges[0]?.classList.contains("conflict"));
  assert.ok(!badges[1]?.classList.contains("conflict"));

  const dots = root.querySelectorAll(".repo-session-dot");
  assert.equal(dots.length, 1, "只有正在跑的那条有脉冲点");
  const rows = [...root.querySelectorAll(".repo-session")];
  assert.ok(rows[0]?.querySelector(".repo-session-dot"));
});

test("重复渲染不会叠加条目", () => {
  const root = installDom();
  const view = {
    current: { path: "E:\\Code\\Demo", name: "Demo" },
    recent: [{ path: "E:\\Code\\Other", name: "Other" }],
    sessions: [session({ id: "ses-1" })],
  };
  const state = createRepoTreeState();

  renderRepoTree(root, view, state, () => {});
  renderRepoTree(root, view, state, () => {});

  assert.equal(root.querySelectorAll(".repo-node").length, 2);
  assert.equal(root.querySelectorAll(".repo-session-row").length, 1);
});
