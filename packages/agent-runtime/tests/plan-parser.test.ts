import assert from "node:assert/strict";
import test from "node:test";
import { parsePlan } from "../src/plan-parser.js";

const REAL_PLAN = [
  "# 修改首页标题",
  "",
  "## 目标",
  "把首页可见标题改成灵动 Code。",
  "",
  "## 需要修改的文件",
  "",
  "### 1. `index.html`",
  "- 把 `<h1>` 内容改成新标题",
  "- 同步 `<title>`",
  "",
  "### 2. `styles/site.css`",
  "- 调整标题字号",
  "",
  "## 不需要修改",
  "- `README.md`",
  "",
  "## 验证方式",
  "- 打开页面确认标题",
  "",
  "## 备注",
  "- 风险：改动影响首屏",
  "- 需要人工确认视觉效果",
].join("\n");

test("能解析真实中文 Markdown 计划的标题、步骤与文件", () => {
  const plan = parsePlan(REAL_PLAN);
  assert.equal(plan.title, "修改首页标题");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]?.index, 1);
  assert.equal(plan.steps[0]?.title, "index.html");
  assert.ok(plan.steps[0]?.detail?.includes("<h1>"));
  assert.deepEqual(plan.steps[0]?.files, ["index.html"]);
  assert.deepEqual(plan.steps[1]?.files, ["styles/site.css"]);
  assert.ok(plan.files.includes("index.html"));
  assert.ok(plan.files.includes("styles/site.css"));
  assert.equal(plan.empty, false);
});

test("风险小节被单独收集", () => {
  const plan = parsePlan(REAL_PLAN);
  assert.equal(plan.risks.length, 2);
  assert.ok(plan.risks[0]?.includes("风险"));
});

test("没有子节时退回编号列表", () => {
  const plan = parsePlan("# 简单计划\n\n1. 读取配置\n2. 更新 `config.json`\n");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1]?.title, "更新 config.json");
  assert.ok(plan.files.includes("config.json"));
});

test("完全无法解析时保留原文，只有真正空计划才置 empty", () => {
  const messy = parsePlan("这是一段没有结构的说明文本。");
  assert.equal(messy.steps.length, 0);
  assert.equal(messy.empty, false);
  assert.equal(messy.raw.trim(), "这是一段没有结构的说明文本。");

  const blank = parsePlan("   \n\n");
  assert.equal(blank.steps.length, 0);
  assert.equal(blank.empty, true);
});

test("计划原文会经过脱敏", () => {
  const plan = parsePlan("# 计划\n\n1. 设置 `XAI_API_KEY=sk-abcdefghijklmn`");
  assert.equal(plan.raw.includes("sk-abcdefghijklmn"), false);
});
