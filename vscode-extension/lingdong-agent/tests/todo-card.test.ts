import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { PlanCardView, PlanStepView } from "../src/plan-view-model";
import { TodoCardView, stepUiStatus } from "../src/webview/todo-card";

/** 每个用例独立的 DOM，避免节点在用例之间串味。 */
function installDom(): Document {
  const dom = new JSDOM(`<!DOCTYPE html><div id="host"></div>`);
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  return window.document;
}

function card(steps: PlanStepView[], overrides: Partial<PlanCardView> = {}): PlanCardView {
  return {
    title: "任务进度",
    steps,
    files: [],
    risks: [],
    empty: false,
    canApprove: false,
    status: "executing",
    ...overrides,
  };
}

function step(overrides: Partial<PlanStepView> = {}): PlanStepView {
  return { index: 1, title: "读取 index.html", files: [], ...overrides };
}

interface Harness {
  host: HTMLElement;
  view: TodoCardView;
  mounts: number;
  progress: HTMLElement;
}

function createHarness(): Harness {
  const document = installDom();
  const host = document.getElementById("host") as HTMLElement;
  const progress = document.createElement("button");
  progress.hidden = true;
  document.body.appendChild(progress);
  const harness = { host, mounts: 0, progress } as unknown as Harness;
  harness.view = new TodoCardView({
    mount: (node) => {
      harness.mounts += 1;
      host.appendChild(node);
    },
    progress,
  });
  return harness;
}

test("清单按状态打标：完成打勾划掉，进行中高亮，待办空圈", () => {
  const { view, host } = createHarness();
  view.apply(card([
    step({ index: 1, title: "读取文件", status: "completed" }),
    step({ index: 2, title: "修改标题", status: "in_progress" }),
    step({ index: 3, title: "运行校验", status: "pending" }),
  ]));

  const rows = Array.from(host.querySelectorAll(".todo-step"));
  assert.equal(rows.length, 3);
  assert.ok(rows[0]?.classList.contains("todo-completed"));
  assert.equal(rows[0]?.querySelector(".todo-mark")?.textContent, "✓");
  assert.ok(rows[1]?.classList.contains("todo-in_progress"));
  assert.equal(rows[1]?.querySelector(".todo-mark")?.textContent, "●");
  assert.ok(rows[2]?.classList.contains("todo-pending"));
  assert.equal(rows[2]?.querySelector(".todo-mark")?.textContent, "○");
  assert.equal(host.querySelector(".todo-progress")?.textContent, "1/3");
});

test("重复下发就地更新同一张卡片，不追加新卡", () => {
  const { view, host } = createHarness();
  view.apply(card([step({ status: "in_progress" }), step({ index: 2, title: "修改标题" })]));
  const first = host.querySelector(".todo-card");
  assert.ok(first);

  view.apply(card([
    step({ status: "completed" }),
    step({ index: 2, title: "修改标题", status: "in_progress" }),
  ]));

  assert.equal(host.querySelectorAll(".todo-card").length, 1, "同一份清单只保留一张卡");
  assert.equal(host.querySelector(".todo-card"), first, "卡片节点必须原地更新");
  assert.equal(host.querySelector(".todo-progress")?.textContent, "1/2");
  const rows = Array.from(host.querySelectorAll(".todo-step"));
  assert.ok(rows[0]?.classList.contains("todo-completed"));
  assert.ok(rows[1]?.classList.contains("todo-in_progress"));
});

test("空清单不挂卡片", () => {
  const harness = createHarness();
  harness.view.apply(card([]));
  assert.equal(harness.host.querySelector(".todo-card"), null);
  assert.equal(harness.view.mounted, false);
});

test("reset 后再次下发会重新挂一张卡（新会话）", () => {
  const harness = createHarness();
  harness.view.apply(card([step({ status: "in_progress" })]));
  assert.equal(harness.mounts, 1);

  harness.view.reset();
  harness.host.replaceChildren();
  harness.view.apply(card([step({ status: "in_progress" })]));
  assert.equal(harness.mounts, 2);
  assert.equal(harness.host.querySelectorAll(".todo-card").length, 1);
});

test("旧版会话记录没有结构化状态时，从 detail 文案倒推", () => {
  assert.equal(stepUiStatus(step({ detail: "状态：已完成" })), "completed");
  assert.equal(stepUiStatus(step({ detail: "状态：进行中" })), "in_progress");
  assert.equal(stepUiStatus(step({ detail: "状态：待处理" })), "pending");
  assert.equal(stepUiStatus(step({ detail: "状态：未成功" })), "failed");
  assert.equal(stepUiStatus(step({ detail: "状态：已取消" })), "cancelled");
  assert.equal(stepUiStatus(step({ detail: "别的说明文字" })), "pending");
  assert.equal(stepUiStatus(step()), "pending");
  assert.equal(stepUiStatus(step({ detail: "状态：进行中", status: "completed" })), "completed", "结构化状态优先");
});

test("卡片标题随更新刷新", () => {
  const { view, host } = createHarness();
  view.apply(card([step({ status: "in_progress" })], { title: "任务进度" }));
  view.apply(card([step({ status: "completed" })], { title: "修复登录页" }));
  assert.equal(host.querySelector(".card-title")?.textContent, "修复登录页");
});

test("带时序号时忽略旧快照：加载更早消息不会把清单回写", () => {
  const { view, host } = createHarness();
  view.apply(card([
    step({ status: "completed" }),
    step({ index: 2, title: "修改标题", status: "in_progress" }),
  ]), 5);

  // 分页回放：更早的快照（seq 更小）必须被忽略。
  view.apply(card([
    step({ status: "in_progress" }),
    step({ index: 2, title: "修改标题" }),
  ]), 2);
  assert.equal(host.querySelector(".todo-progress")?.textContent, "1/2");

  // 更新的快照（seq 更大）正常应用。
  view.apply(card([
    step({ status: "completed" }),
    step({ index: 2, title: "修改标题", status: "completed" }),
  ]), 6);
  assert.equal(host.querySelector(".todo-progress")?.textContent, "2/2");
});

test("reset 清掉时序号，新会话从头计数", () => {
  const harness = createHarness();
  harness.view.apply(card([step({ status: "completed" })]), 9);
  harness.view.reset();
  harness.host.replaceChildren();
  harness.view.apply(card([step({ status: "in_progress" })]), 1);
  assert.equal(harness.host.querySelector(".todo-progress")?.textContent, "0/1");
});

test("composer 进度条显示 N/M 与当前项，reset 后隐藏", () => {
  const harness = createHarness();
  harness.view.apply(card([
    step({ status: "completed" }),
    step({ index: 2, title: "修改 login.html", status: "in_progress" }),
    step({ index: 3, title: "运行校验" }),
  ]));
  assert.equal(harness.progress.hidden, false);
  assert.equal(harness.progress.textContent, "任务进度 1/3 · 正在：修改 login.html");

  harness.view.apply(card([
    step({ status: "completed" }),
    step({ index: 2, title: "修改 login.html", status: "completed" }),
    step({ index: 3, title: "运行校验", status: "completed" }),
  ]));
  assert.equal(harness.progress.textContent, "任务进度 3/3 · 已完成");

  harness.view.reset();
  assert.equal(harness.progress.hidden, true);
});

test("界面文案不出现英文枚举", () => {
  const { view, host } = createHarness();
  view.apply(card([
    step({ status: "completed" }),
    step({ index: 2, title: "修改标题", status: "in_progress", detail: "状态：进行中" }),
  ]));
  const text = host.textContent ?? "";
  for (const forbidden of ["completed", "in_progress", "pending"]) {
    assert.ok(!text.includes(forbidden), `不应出现英文枚举 ${forbidden}`);
  }
});
