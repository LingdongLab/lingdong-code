import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderPlanDocumentView } from "../src/webview/plan/plan-document-view";
import {
  collectPlanPayloadFromRoot,
  renderPlanMarkdownEditor,
  synthesizePlanMarkdown,
} from "../src/webview/plan/plan-markdown-editor";
import { renderPlanRightRail } from "../src/webview/plan/plan-right-rail";
import {
  buildPlanDocumentViewModel,
  isAnalysisNoiseStep,
  moveStep,
  toUiRelativePath,
  type PlanDocumentViewModel,
} from "../src/webview/plan/plan-view-model";
import type { PlanRecord } from "../src/storage/plan-repository";
import {
  buildPlanResearchPrompt,
  isForbiddenPlanShellCommand,
  PLAN_RESEARCH_GUIDANCE,
} from "../src/plan-research";
import { WorkspaceSafetyPolicy } from "@lingdong/agent-runtime";

function sampleRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: "plan-abcdef12",
    sessionId: "ses-abcdef12",
    version: 2,
    title: "登录系统改造",
    goal: "拆分会话服务并补齐测试",
    steps: [
      {
        id: "step-aaaaaa",
        order: 1,
        title: "补充失败路径测试",
        description: "覆盖过期与错误码",
        files: ["tests/auth/session.test.ts"],
        status: "pending",
      },
      {
        id: "step-bbbbbb",
        order: 2,
        title: "抽出 SessionService",
        files: ["src/auth/session.ts"],
        status: "pending",
      },
    ],
    files: [
      "E:\\LingdongCode\\workspace\\grok-test\\src\\auth\\session.ts",
      "src/auth/router.ts",
    ],
    risks: [],
    status: "waiting_review",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    source: "grok",
    ...overrides,
  };
}

function installDom(): Document {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  const { window } = dom;
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Event", { value: window.Event, configurable: true });
  return window.document;
}

function mount(node: HTMLElement): Document {
  const document = globalThis.document ?? installDom();
  const root = document.getElementById("root") ?? document.body;
  root.appendChild(node);
  return document;
}

function baseActions(overrides: Partial<{
  onSave: (payload: unknown) => void;
  onDiscard: () => void;
  onStartBuild: () => void;
  onOpenFile: (path: string) => void;
}> = {}) {
  return {
    onSave: overrides.onSave ?? (() => undefined),
    onDiscard: overrides.onDiscard ?? (() => undefined),
    onStartBuild: overrides.onStartBuild ?? (() => undefined),
    onOpenFile: overrides.onOpenFile ?? (() => undefined),
  };
}

test("Plan 默认就是渲染态可编辑，没有 textarea", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const doc = mount(renderPlanDocumentView(model, baseActions()));
  assert.equal(doc.querySelector(".plan-mode-wysiwyg") !== null, true);
  const md = doc.querySelector<HTMLElement>(".plan-raw-md");
  assert.equal(md?.contentEditable, "true");
  assert.equal(doc.querySelectorAll("textarea").length, 0);
  assert.equal(doc.querySelectorAll("input").length, 0);
  assert.match(doc.body.textContent ?? "", /登录系统改造/);
  assert.match(doc.body.textContent ?? "", /补充失败路径测试/);
  assert.equal(doc.body.textContent?.includes("直接改下面的 Markdown"), false);
});

test("给了勾选回调才渲染勾选框，取消勾选把步骤报成不参与", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const toggles: Array<[string, boolean]> = [];
  const doc = mount(renderPlanDocumentView(model, {
    ...baseActions(),
    onToggleStep: (stepId, included) => toggles.push([stepId, included]),
  }));
  const boxes = doc.querySelectorAll<HTMLInputElement>(".plan-step-check");
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0]?.checked, true);

  boxes[0]!.checked = false;
  boxes[0]!.dispatchEvent(new globalThis.Event("change"));
  assert.deepEqual(toggles, [["step-aaaaaa", false]]);
});

test("已完成与执行中的步骤勾选框禁用", () => {
  installDom();
  const record = sampleRecord();
  record.steps[0]!.status = "completed";
  record.steps[1]!.status = "in_progress";
  const model = buildPlanDocumentViewModel(record)!;
  const doc = mount(renderPlanDocumentView(model, {
    ...baseActions(),
    onToggleStep: () => undefined,
  }));
  const boxes = doc.querySelectorAll<HTMLInputElement>(".plan-step-check");
  assert.equal(boxes[0]?.disabled, true);
  assert.equal(boxes[1]?.disabled, true);
});

test("跳过的步骤仍然看得见，只是压暗且勾选框空着", () => {
  installDom();
  const record = sampleRecord();
  record.steps[1]!.status = "skipped";
  const model = buildPlanDocumentViewModel(record)!;
  const doc = mount(renderPlanDocumentView(model, {
    ...baseActions(),
    onToggleStep: () => undefined,
  }));
  assert.match(doc.body.textContent ?? "", /抽出 SessionService/);
  const rows = doc.querySelectorAll(".plan-step-row");
  assert.equal(rows[1]?.classList.contains("plan-step-excluded"), true);
  assert.equal(doc.querySelectorAll<HTMLInputElement>(".plan-step-check")[1]?.checked, false);
});

test("步骤编排与正文共存：默认折叠，展开后才有拖拽编辑", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const doc = mount(renderPlanDocumentView(model, {
    ...baseActions(),
    onEditSteps: () => undefined,
  }));
  // 正文与阅读态清单没有被编排区取代。
  assert.equal(doc.querySelector(".plan-raw-md") !== null, true);
  assert.equal(doc.querySelector(".plan-steps-read") !== null, true);

  const fold = doc.querySelector<HTMLDetailsElement>(".plan-step-arrange");
  assert.ok(fold);
  assert.equal(fold.open, false, "默认折叠");
  const cards = fold.querySelectorAll<HTMLElement>("[data-step-block]");
  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.draggable, true);
  assert.match(fold.textContent ?? "", /新增步骤/);
});

test("没给编排回调就不渲染编排区", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const doc = mount(renderPlanDocumentView(model, baseActions()));
  assert.equal(doc.querySelector(".plan-step-arrange"), null);
});

test("编排区里删一步会把整份新列表报出来", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const emitted: string[][] = [];
  const doc = mount(renderPlanDocumentView(model, {
    ...baseActions(),
    onEditSteps: (steps) => emitted.push(steps.map((step) => step.id)),
  }));
  const remove = doc.querySelectorAll<HTMLButtonElement>(".plan-step-arrange .btn-danger")[0];
  assert.ok(remove);
  remove.click();
  assert.deepEqual(emitted, [["step-bbbbbb"]]);
});

test("步骤说明按 markdown 渲染，表格不会退化成一串竖线", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord({
    steps: [{
      id: "step-aaaaaa",
      order: 1,
      title: "差距 1：中栏顶部标题区",
      description: "| 项 | 现状 |\n|----|----|\n| 字号 | 13px |\n\n**改动**：调到 20px。",
      files: [],
      status: "pending",
    }],
  }))!;
  const doc = mount(renderPlanDocumentView(model, baseActions()));

  const desc = doc.querySelector(".plan-step-desc");
  assert.ok(desc, "应有步骤说明");
  assert.ok(desc.querySelector("table td"), "表格要真的渲染成 table");
  assert.ok(desc.querySelector("strong"), "加粗要真的加粗");
  // 样式全挂在 .md-body 下，少这个类表格就没有边框和滚动壳。
  assert.ok(desc.classList.contains("md-body"));
  assert.equal(/\|----/.test(desc.textContent ?? ""), false, "不该出现 markdown 原文的分隔行");
});

test("正文 markdown 复用 .md-body 排版，标题不重复一遍", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord({
    raw: "# 登录系统改造\n\n## 目标\n\n拆分会话服务\n\n| 项 | 现状 |\n|----|----|\n| 字号 | 13px |",
  }))!;
  const doc = mount(renderPlanDocumentView(model, baseActions()));

  const md = doc.querySelector(".plan-raw-md");
  assert.ok(md?.classList.contains("md-body"), "缺 md-body 就拿不到表格与代码块样式");
  // 头部已经有大标题，正文开头再来一遍同样的字就像渲染坏了。
  assert.equal(md?.querySelector("h1"), null);
  assert.equal(doc.querySelectorAll(".plan-doc-title").length, 1);
  assert.equal((doc.body.textContent?.match(/登录系统改造/g) ?? []).length, 1);
  assert.ok(md?.querySelector(".table-scroll table"), "表格应带滚动壳");
});

test("正文标题和计划标题不同时保留原文标题", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord({ raw: "# 改造方案\n\n正文" }))!;
  const doc = mount(renderPlanDocumentView(model, baseActions()));
  assert.ok(doc.querySelector(".plan-raw-md h1"), "换了说法就不是重复，不该砍");
});

test("空章节紧凑显示", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord({ risks: [], clarifications: [] }))!;
  const doc = mount(renderPlanDocumentView(model, baseActions()));
  // 无 raw 时合成 markdown，风险节来自合成正文或澄清空态。
  assert.match(doc.body.textContent ?? "", /当前没有待确认事项/);
  assert.equal(doc.querySelectorAll("textarea").length, 0);
});

test("渲染态直接改正文并保存，不是表单也不是源码框", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord({
    raw: "# 登录系统改造\n\n改这里",
  }))!;
  let saved: { raw?: string; title?: string } | undefined;
  const editor = renderPlanMarkdownEditor(model, baseActions({
    onSave: (payload) => {
      saved = payload as { raw?: string; title?: string };
    },
  }));
  const doc = mount(editor);
  assert.ok(doc.querySelector(".plan-mode-wysiwyg"));
  assert.equal(doc.querySelectorAll(".plan-step-editor").length, 0, "不再用步骤表单");
  assert.equal(doc.querySelector(".plan-md-editor"), null);
  assert.equal(doc.querySelector(".plan-edit-hint"), null);
  const md = doc.querySelector<HTMLElement>(".plan-raw-md");
  assert.ok(md);
  assert.equal(md.contentEditable, "true");
  md.innerHTML = "<h1>新标题</h1><p>新正文</p>";
  md.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true }));
  const save = Array.from(doc.querySelectorAll("button")).find((b) => b.textContent === "保存");
  assert.ok(save, "改过之后应出现保存");
  save.click();
  assert.equal(saved?.title, "新标题");
  assert.match(saved?.raw ?? "", /新正文/);
});

test("没有 raw 时合成可编辑 Markdown", () => {
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const md = synthesizePlanMarkdown(model);
  assert.match(md, /^# 登录系统改造/m);
  assert.match(md, /补充失败路径测试/);
});

test("上移和下移工具函数仍可用（步骤清单排序）", () => {
  const items = ["a", "b", "c"];
  assert.deepEqual(moveStep(items, 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveStep(items, 0, 2), ["b", "c", "a"]);
});

test("文件 chip 与绝对路径不进入 UI", () => {
  assert.equal(
    toUiRelativePath("E:\\LingdongCode\\workspace\\grok-test\\src\\auth\\session.ts"),
    "src/auth/session.ts",
  );
  assert.equal(isAnalysisNoiseStep("Get-ChildItem src"), true);
  assert.equal(isAnalysisNoiseStep("补充失败路径测试"), false);

  const model = buildPlanDocumentViewModel(sampleRecord())!;
  assert.ok(!model.files.some((f) => /^[A-Za-z]:/.test(f)));
  assert.ok(model.files.includes("src/auth/session.ts"));
  installDom();
  const doc = mount(renderPlanDocumentView(model, baseActions()));
  assert.equal(/E:\\LingdongCode/i.test(doc.body.textContent ?? ""), false);
  assert.match(doc.body.textContent ?? "", /src\/auth\/session\.ts/);
});

test("保存后可收集 payload；文档态无表单", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const editor = renderPlanMarkdownEditor(model, baseActions());
  const payload = collectPlanPayloadFromRoot(editor);
  assert.ok(payload);
  assert.equal(payload!.planId, "plan-abcdef12");
  assert.equal(payload!.title, "登录系统改造");
  assert.ok(payload!.raw, "应带上 markdown 原文");
  assert.equal(payload!.steps.length, 2);
});

test("辅助侧栏 Plan 投影只显示精简内容", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const doc = mount(renderPlanRightRail(model, { onStartBuild: () => undefined, onSave: () => undefined }));
  assert.match(doc.querySelector(".plan-right-progress-count")?.textContent ?? "", /0\/2/);
  assert.equal(doc.querySelectorAll("textarea").length, 0);
  assert.equal(doc.querySelector(".plan-step-editor"), null);
  assert.equal(doc.querySelectorAll("button").length >= 2, true);
});

test("侧栏 Plan 进度条宽度按已完成比例给出", () => {
  installDom();
  const record = sampleRecord({ status: "executing" });
  record.steps[0]!.status = "completed";
  const model = buildPlanDocumentViewModel(record)!;
  const doc = mount(renderPlanRightRail(model, { onStartBuild: () => undefined }));
  const fill = doc.querySelector(".plan-right-progress-fill") as HTMLElement;
  assert.equal(fill.style.width, "50%");
  assert.equal(fill.classList.contains("has-failure"), false);
  // 当前执行到的那一步要带高亮类，用户扫一眼就知道停在哪。
  assert.equal(doc.querySelectorAll(".plan-right-step.is-completed").length, 1);
});

test("侧栏 Plan 有失败步骤时进度条改用错误色", () => {
  installDom();
  const record = sampleRecord({ status: "executing" });
  record.steps[1]!.status = "failed";
  const model = buildPlanDocumentViewModel(record)!;
  const doc = mount(renderPlanRightRail(model, { onStartBuild: () => undefined }));
  assert.ok((doc.querySelector(".plan-right-progress-fill") as HTMLElement).classList.contains("has-failure"));
});

test("侧栏 Plan 用按钮而不是裸文本指回主面板", () => {
  installDom();
  const opened: string[] = [];
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const doc = mount(renderPlanRightRail(model, {
    onStartBuild: () => undefined,
    onOpenMain: () => opened.push("main"),
  }));
  const buttons = [...doc.querySelectorAll(".plan-right-footer button")] as HTMLButtonElement[];
  const open = buttons.find((button) => button.textContent === "在主面板编辑");
  assert.ok(open, "缺少回主面板的入口");
  open!.click();
  assert.deepEqual(opened, ["main"]);
  assert.doesNotMatch(doc.body.textContent ?? "", /请在 Agent 主面板/);
});

test("无计划时侧栏给出可操作的空态", () => {
  installDom();
  const doc = mount(renderPlanRightRail(undefined, { onStartBuild: () => undefined }));
  assert.match(doc.querySelector(".plan-right-empty-title")?.textContent ?? "", /暂无计划/);
  assert.equal(doc.querySelector(".plan-right-footer"), null, "空态不该给禁用的构建按钮");
});

test("Plan 模式研究引导禁止 Get-ChildItem", () => {
  assert.equal(isForbiddenPlanShellCommand("Get-ChildItem -Recurse"), true);
  assert.equal(isForbiddenPlanShellCommand("dir"), true);
  assert.equal(isForbiddenPlanShellCommand("ls -la"), true);
  assert.equal(isForbiddenPlanShellCommand("npm test"), false);
  const prompt = buildPlanResearchPrompt("调研登录模块", "- src/auth/session.ts");
  assert.match(prompt, /Get-ChildItem/);
  assert.match(prompt, /禁止/);
  assert.match(prompt, /调研登录模块/);
  assert.match(PLAN_RESEARCH_GUIDANCE, /只允许分析/);
});

test("Plan 模式不修改文件且拒绝终端列目录（复用现有 Runtime 策略）", () => {
  const workspace = "E:\\LingdongCode\\workspace\\grok-test";
  const policy = new WorkspaceSafetyPolicy(workspace);
  const write = policy.evaluate("plan", {
    sessionId: "test",
    toolCall: {
      toolCallId: "t1",
      kind: "edit",
      title: "write",
      rawInput: { file_path: `${workspace}\\src\\a.ts` },
    },
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  });
  assert.equal(write.action, "deny");

  const shell = policy.evaluate("plan", {
    sessionId: "test",
    toolCall: {
      toolCallId: "t2",
      kind: "execute",
      title: "shell",
      rawInput: { command: "Get-ChildItem" },
    },
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  });
  assert.equal(shell.action, "deny");
});

test("没有上下文时不渲染空 chip 容器逻辑", () => {
  const dom = new JSDOM(`<!DOCTYPE html><div class="chips chips-empty" id="context-items" hidden></div>`);
  const chips = dom.window.document.getElementById("context-items")!;
  assert.equal(chips.hidden, true);
  assert.equal(chips.classList.contains("chips-empty"), true);
  assert.equal(chips.childElementCount, 0);
});

test("Action Bar 只留构建与放弃（对标 Cursor）", () => {
  installDom();
  const model = buildPlanDocumentViewModel(sampleRecord())!;
  const doc = mount(renderPlanDocumentView(model, baseActions()));
  const bar = doc.querySelector(".plan-action-bar") as HTMLElement;
  assert.ok(bar);
  const labels = Array.from(bar.querySelectorAll("button")).map((b) => b.textContent);
  assert.deepEqual(labels, ["放弃", "开始构建"]);
  assert.equal(doc.querySelector(".plan-edit-link"), null, "无需再点编辑进源码框");
  assert.ok(model.steps.length >= 1);
});

test("构建 ViewModel 过滤分析噪声步骤", () => {
  const model = buildPlanDocumentViewModel(sampleRecord({
    steps: [
      {
        id: "step-noise1",
        order: 1,
        title: "Get-ChildItem src",
        files: [],
        status: "pending",
      },
      {
        id: "step-ok0001",
        order: 2,
        title: "调整路由错误映射",
        files: ["src/auth/router.ts"],
        status: "pending",
      },
    ],
  }))!;
  assert.equal(model.steps.length, 1);
  assert.equal(model.steps[0]?.title, "调整路由错误映射");
});

test("PlanDocumentViewModel 形状完整", () => {
  const model = buildPlanDocumentViewModel(sampleRecord()) as PlanDocumentViewModel;
  for (const key of [
    "id", "version", "status", "title", "goal", "clarifications",
    "files", "risks", "steps", "progress", "createdAt", "updatedAt",
  ]) {
    assert.ok(key in model);
  }
  assert.equal(model.progress.total, 2);
});
