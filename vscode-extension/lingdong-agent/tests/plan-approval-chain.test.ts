import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { PlanRecord } from "../src/storage/plan-repository";
import type { AppState } from "../src/webview/app-context";
import { PlanController } from "../src/webview/plan-controller";
import { buildPlanDocumentViewModel } from "../src/webview/plan/plan-view-model";

function sampleRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: "plan-abcdef12",
    sessionId: "ses-abcdef12",
    version: 1,
    title: "登录系统改造",
    goal: "拆分会话服务",
    steps: [
      { id: "s1", order: 1, title: "补充失败路径测试", files: [], status: "pending" },
      { id: "s2", order: 2, title: "抽出 SessionService", files: [], status: "pending" },
    ],
    files: ["src/auth/session.ts"],
    risks: [],
    status: "waiting_review",
    createdAt: 1,
    updatedAt: 1,
    source: "grok",
    ...overrides,
  };
}

function installDom(): { container: HTMLElement; panel: HTMLElement } {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"messages\"></div><div id=\"panel-plan\"></div>");
  const { window } = dom;
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Event", { value: window.Event, configurable: true });
  return {
    container: window.document.getElementById("messages") as HTMLElement,
    panel: window.document.getElementById("panel-plan") as HTMLElement,
  };
}

function createHarness(options: { planToolOpen?: boolean } = {}) {
  const { container, panel } = installDom();
  const posts: Array<{ type?: string }> = [];
  let planToolOpen = options.planToolOpen ?? true;
  const state = {
    activePlan: undefined,
    planCardView: undefined,
    liveTaskSteps: undefined,
    planEditing: false,
    uiState: "ready",
  } as unknown as AppState;
  const refreshed: string[] = [];

  const controller = new PlanController({
    el: { panelPlan: panel },
    state,
    post: (message) => posts.push(message),
    appendNode: (node) => {
      container.appendChild(node);
      return node;
    },
    notice: () => undefined,
    fillComposer: () => undefined,
    openPlanTool: () => {
      planToolOpen = true;
      controller.renderRight();
    },
    isPlanToolOpen: () => planToolOpen,
    refreshTool: (tool) => { refreshed.push(tool); },
  });
  return { controller, state, posts, container, panel, refreshed };
}

function clickButton(root: HTMLElement, label: string): void {
  const button = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
  assert.ok(button, `找不到按钮：${label}`);
  button.click();
}

test("中间只有紧凑卡，完整文档渲染在右侧面板", () => {
  const { controller, state, container, panel } = createHarness();
  state.activePlan = sampleRecord();
  state.uiState = "waiting_plan_approval";
  controller.renderCenter();

  assert.ok(container.querySelector(".plan-compact-card"), "中间应是紧凑卡");
  assert.equal(container.querySelectorAll("textarea").length, 0);
  assert.equal(/补充失败路径测试/.test(container.textContent ?? ""), false);
  assert.match(container.textContent ?? "", /登录系统改造/);
  assert.match(container.textContent ?? "", /进度 0\/2/);

  assert.ok(panel.querySelector(".plan-mode-read"), "右侧应是完整文档");
  assert.match(panel.textContent ?? "", /补充失败路径测试/);
  const rightLabels = Array.from(panel.querySelectorAll("button")).map((b) => b.textContent);
  assert.equal(rightLabels.includes("在右侧打开计划"), false);
  assert.equal(rightLabels.includes("继续研究"), false);
  assert.equal(rightLabels.includes("修改计划"), false);
  assert.ok(rightLabels.includes("开始构建"));
  assert.ok(rightLabels.includes("放弃"));
});

test("点紧凑卡标题打开右侧面板", () => {
  const { controller, state, container, panel } = createHarness({ planToolOpen: false });
  state.activePlan = sampleRecord();
  state.uiState = "ready";
  controller.renderCenter();
  assert.equal(panel.childElementCount, 0, "未打开时右侧面板为空");
  clickButton(container, "登录系统改造");
  assert.ok(panel.querySelector(".plan-mode-read"), "点击标题后右侧渲染完整文档");
});

test("审批未决时右侧「开始构建」先应答 approvePlan RPC", () => {
  const { controller, state, posts, panel } = createHarness();
  state.activePlan = sampleRecord();
  state.uiState = "waiting_plan_approval";
  controller.renderCenter();
  clickButton(panel, "开始构建");
  assert.deepEqual(posts, [{ type: "approvePlan" }]);
});

test("审批未决时紧凑卡「开始构建」同样走 approvePlan", () => {
  const { controller, state, posts, container } = createHarness();
  state.activePlan = sampleRecord();
  state.uiState = "waiting_plan_approval";
  controller.renderCenter();
  clickButton(container, "开始构建");
  assert.deepEqual(posts, [{ type: "approvePlan" }]);
});

test("非审批状态紧凑卡没有构建快捷按钮，也不再堆打开/修改意见", () => {
  const { controller, state, container } = createHarness();
  state.activePlan = sampleRecord({ status: "approved" });
  state.uiState = "ready";
  controller.renderCenter();
  const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
  assert.equal(labels.includes("开始构建"), false);
  assert.equal(labels.includes("修改意见"), false);
  assert.equal(labels.includes("在右侧打开计划"), false);
  assert.ok(labels.includes("登录系统改造"), "标题可点开右侧");
});

test("审批未决时右侧「放弃」先应答 rejectPlan RPC", () => {
  const { controller, state, posts, panel } = createHarness();
  state.activePlan = sampleRecord();
  state.uiState = "waiting_plan_approval";
  controller.renderCenter();
  clickButton(panel, "放弃");
  assert.equal(posts[0]?.type, "rejectPlan");
});

test("没有待审批 RPC 时仍走本地 startPlanBuild / discardPlanEdits", () => {
  const { controller, state, posts, panel } = createHarness();
  state.activePlan = sampleRecord({ status: "approved" });
  state.uiState = "ready";
  controller.renderCenter();
  clickButton(panel, "开始构建");
  assert.deepEqual(posts, [{ type: "startPlanBuild" }]);

  posts.length = 0;
  controller.renderCenter();
  clickButton(panel, "放弃");
  assert.equal(posts[0]?.type, "discardPlanEdits");
});

test("审批未决时不再单独放修改意见框——正文本身可直接改", () => {
  const { controller, state, panel } = createHarness();
  state.activePlan = sampleRecord();
  state.uiState = "waiting_plan_approval";
  controller.renderCenter();
  assert.equal(panel.querySelector(".plan-revise-input"), null);
  const md = panel.querySelector<HTMLElement>(".plan-raw-md");
  assert.equal(md?.contentEditable, "true", "渲染态直接可编辑");
  assert.equal(panel.querySelector(".plan-edit-link"), null);
});

test("计划原文走 markdown 渲染", () => {
  const { controller, state, panel } = createHarness();
  state.activePlan = sampleRecord({
    raw: "# 改造方案\n\n## 目标\n\n拆分会话服务\n\n```ts\nconst a = 1;\n```",
  });
  state.uiState = "waiting_plan_approval";
  controller.renderCenter();
  const md = panel.querySelector(".plan-raw-md");
  assert.ok(md, "应有 markdown 正文");
  assert.ok(md.querySelector("h1"), "标题应渲染为 h1");
  assert.ok(md.querySelector("pre"), "代码块应保留");
  assert.match(panel.textContent ?? "", /补充失败路径测试/);
});

test("渲染态直接改正文，保存走 savePlanEdits", () => {
  const { controller, state, posts, panel, refreshed } = createHarness();
  state.activePlan = sampleRecord({
    status: "approved",
    raw: "# 登录系统改造\n\n正文",
  });
  state.uiState = "ready";
  controller.renderCenter();
  assert.ok(panel.querySelector(".plan-mode-wysiwyg"));
  assert.equal(panel.querySelector(".plan-md-editor"), null);
  const md = panel.querySelector<HTMLElement>(".plan-raw-md")!;
  assert.equal(md.contentEditable, "true");
  md.innerHTML = "<h1>登录系统改造</h1><p>改过了</p>";
  md.dispatchEvent(new Event("input", { bubbles: true }));
  clickButton(panel, "保存");
  assert.equal(posts.at(-1)?.type, "savePlanEdits");
  const saved = posts.at(-1) as { type: string; plan: { raw?: string } };
  assert.match(saved.plan.raw ?? "", /改过了/);
  assert.equal(state.planEditing, false);
  assert.match(state.activePlan?.raw ?? "", /改过了/, "本地应乐观更新，避免旧稿回弹");
  assert.ok(panel.querySelector(".plan-mode-wysiwyg"), "保存后仍是文档态");
  assert.equal(posts.some((p) => (p as { type?: string }).type === "approvePlan"), false);
  assert.ok(refreshed.includes("tasks"), "保存后应立刻刷新 Tasks");
});

test("保存时正文删掉的步骤不会再留在 activePlan.steps", () => {
  const { controller, state, posts, panel } = createHarness();
  state.activePlan = sampleRecord({
    status: "approved",
    raw: "# 调研\n\n## 五、结论与下一步建议\n\n1. 克隆到本地跑起来\n2. 只读源码学习\n",
    steps: [
      { id: "s1", order: 1, title: "克隆到本地跑起来", files: [], status: "pending" },
      { id: "s2", order: 2, title: "只读源码学习", files: [], status: "pending" },
    ],
  });
  state.uiState = "ready";
  controller.renderCenter();
  const md = panel.querySelector<HTMLElement>(".plan-raw-md")!;
  md.innerHTML = "<h1>调研</h1><h2>一、它是什么</h2><p>简介</p>";
  md.dispatchEvent(new Event("input", { bubbles: true }));
  clickButton(panel, "保存");
  const saved = posts.at(-1) as { type: string; plan: { steps: Array<{ title: string }> } };
  assert.equal(saved.type, "savePlanEdits");
  assert.equal(saved.plan.steps.length, 0);
  assert.equal(state.activePlan?.steps.length, 0);
});

test("仅有审批卡、尚无 activePlan 时保存也不能走 approvePlan", () => {
  const { controller, state, posts, panel } = createHarness();
  state.planCardView = {
    title: "登录系统改造",
    status: "ready",
    empty: false,
    canApprove: true,
    files: [],
    risks: [],
    steps: [],
    raw: "# 登录系统改造\n\n旧正文",
  };
  state.uiState = "waiting_plan_approval";
  controller.renderCenter();
  const md = panel.querySelector<HTMLElement>(".plan-raw-md")!;
  md.innerHTML = "<h1>登录系统改造</h1><p>删掉后的正文</p>";
  md.dispatchEvent(new Event("input", { bubbles: true }));
  clickButton(panel, "保存");
  assert.equal(posts.at(-1)?.type, "savePlanEdits");
  assert.equal(posts.some((p) => (p as { type?: string }).type === "approvePlan"), false);
  assert.match((posts.at(-1) as { plan: { raw?: string } }).plan.raw ?? "", /删掉后的正文/);
});

test("构建中状态头显示 N/M 实时进度", () => {
  const record = sampleRecord({
    status: "executing",
    steps: [
      { id: "s1", order: 1, title: "补充失败路径测试", files: [], status: "completed" },
      { id: "s2", order: 2, title: "抽出 SessionService", files: [], status: "in_progress" },
    ],
  });
  const model = buildPlanDocumentViewModel(record)!;
  assert.equal(model.statusLabel, "构建中 · 1/2");
  assert.deepEqual(model.progress, { done: 1, total: 2 });
});
