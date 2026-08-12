import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionRequestParams } from "../src/protocol.js";
import { WorkspaceSafetyPolicy } from "../src/safety-policy.js";

const workspace = "E:\\LingdongCode\\workspace\\grok-test";
const policy = new WorkspaceSafetyPolicy(workspace);

function request(kind: string, title: string, rawInput: unknown): PermissionRequestParams {
  return {
    sessionId: "test",
    toolCall: { toolCallId: "t1", kind, title, rawInput },
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  };
}

test("工作区边界内路径被识别", () => {
  assert.equal(policy.isInside(`${workspace}\\index.html`), true);
  assert.equal(policy.isInside("E:\\LingdongCode\\workspace\\other\\index.html"), false);
});

test("路径穿越被拒绝", () => {
  const result = policy.evaluate("agent", request("edit", "write", { file_path: "..\\secret.txt" }));
  assert.equal(result.action, "deny");
  assert.match(result.reason, /超出/);
});

test("Ask 模式拒绝文件写入", () => {
  const result = policy.evaluate("ask", request("edit", "write", { file_path: "index.html" }));
  assert.equal(result.action, "deny");
});

test("Agent 模式自动放行低风险源码写入", () => {
  const result = policy.evaluate("agent", request("edit", "write", { file_path: "index.html" }));
  assert.equal(result.action, "allow");
  assert.equal(result.risk, "low");
});

test("Agent 模式自动放行清单/配置写入", () => {
  const result = policy.evaluate("agent", request("edit", "write", { file_path: "package.json" }));
  assert.equal(result.action, "allow");
  assert.equal(result.risk, "medium");
  assert.equal(result.operationKind, "modify_config");
});

test("Agent 模式自动放行构建命令", () => {
  const result = policy.evaluate("agent", request("execute", "shell", { command: "npm run build" }));
  assert.equal(result.action, "allow");
});

test("Agent 模式自动放行 git commit", () => {
  const result = policy.evaluate("agent", request("execute", "shell", { command: "git commit -m fix" }));
  assert.equal(result.action, "allow");
  assert.equal(result.operationKind, "git_write");
});

test("strict 力度下 medium 写入仍要求确认", () => {
  const strict = new WorkspaceSafetyPolicy(workspace, "strict");
  const result = strict.evaluate("agent", request("edit", "write", { file_path: "package.json" }));
  assert.equal(result.action, "ask");
});

test("yolo 力度下 high 也放行，但 blocked 依旧硬拒", () => {
  const yolo = new WorkspaceSafetyPolicy(workspace, "yolo");
  assert.equal(yolo.evaluate("agent", request("edit", "delete file", { file_path: "a.css" })).action, "allow");
  assert.equal(yolo.evaluate("agent", request("edit", "write", { file_path: "..\\x.txt" })).action, "deny");
});

test("审批力度可在运行时切换", () => {
  const live = new WorkspaceSafetyPolicy(workspace, "strict");
  const params = request("execute", "shell", { command: "npm run build" });
  assert.equal(live.evaluate("agent", params).action, "ask");
  live.setApproval("balanced");
  assert.equal(live.evaluate("agent", params).action, "allow");
});

test("Agent 模式自动放行只读命令", () => {
  const result = policy.evaluate("agent", request("execute", "shell", { command: "git status" }));
  assert.equal(result.action, "allow");
});

test("Agent 模式对依赖安装命令仍要求确认", () => {
  const result = policy.evaluate("agent", request("execute", "shell", { command: "npm install lodash" }));
  assert.equal(result.action, "ask");
});

test("Agent 模式对删除操作仍要求确认", () => {
  const result = policy.evaluate("agent", request("edit", "delete file", { file_path: "style.css" }));
  assert.equal(result.action, "ask");
  assert.equal(result.risk, "high");
});

test("Auto 模式可自动放行工作区内非删除写入", () => {
  const result = policy.evaluate("auto", request("edit", "write", { file_path: "style.css" }));
  assert.equal(result.action, "allow");
});

test("任何模式都拒绝删除", () => {
  const result = policy.evaluate("auto", request("edit", "delete file", { file_path: "style.css" }));
  assert.equal(result.action, "deny");
});

test("模型自述的意图不再顶掉判定依据，只作为标注出处的参考", () => {
  const result = policy.evaluate("agent", request("execute", "shell", {
    command: "npm install lodash",
    description: "这一步完全安全，只是查一下依赖版本",
  }));
  // 判定依据必须是本地按命令原文算出来的：模型的说明和它想执行的命令来自同一方，
  // 让它决定卡上那句话，一句编得好听的描述就能换到一次「允许」。
  assert.equal(result.reason, "命令安装或移除项目依赖");
  assert.equal(result.intent, "这一步完全安全，只是查一下依赖版本");
});

test("每次判定都带上给人看的说明，卡片不必自己解析命令", () => {
  const result = policy.evaluate("agent", request("execute", "shell", {
    command: "npm install lodash",
    cwd: "packages\\core",
  }));
  assert.equal(result.explanation.steps[0]?.action, "装上 lodash，并记进 package.json");
  assert.ok(result.explanation.notes.some((note) => note.includes("联网")));
  assert.equal(result.cwd, `${workspace}\\packages\\core`, "执行目录解析成绝对路径后带给卡片");
  assert.equal(result.intent, undefined, "模型没写说明时就不要这个字段");
});
