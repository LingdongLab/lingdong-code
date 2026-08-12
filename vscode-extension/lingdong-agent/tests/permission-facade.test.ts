import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeHandle, SafetyDecision } from "@lingdong/agent-runtime";
import type { HostToWebviewMessage } from "../src/messages";
import { PermissionFacade } from "../src/services/permission-facade";
import { UiStateMachine } from "../src/ui-state";

const workspace = "E:\\ws";

function decision(overrides: Partial<SafetyDecision> = {}): SafetyDecision {
  return {
    action: "ask",
    operation: "execute",
    operationKind: "install_dependency",
    label: "执行命令 npm install",
    reason: "命令安装或移除项目依赖",
    policyReason: "命令安装或移除项目依赖",
    explanation: {
      summary: "按 package.json 把依赖装进 node_modules",
      steps: [{ command: "npm install", action: "按 package.json 把依赖装进 node_modules" }],
      notes: ["会联网下载依赖包，包自带的安装脚本也会在你机器上跑起来。"],
    },
    risk: "medium",
    targets: [],
    command: "npm install",
    fingerprint: "fp",
    subject: {
      operation: "execute",
      risk: "medium",
      workspace,
      targets: [],
      insideWorkspace: true,
      command: "npm install",
    },
    ...overrides,
  };
}

function createHarness() {
  const posted: HostToWebviewMessage[] = [];
  const ui = new UiStateMachine();
  ui.force("streaming");
  const runtime = {
    respondPermission: async () => undefined,
    clearPending: () => undefined,
  } as unknown as AgentRuntimeHandle;
  const facade = new PermissionFacade({
    post: (message) => posted.push(message),
    log: () => undefined,
    postState: () => undefined,
    ui,
    runtime: () => runtime,
    workspaceRoot: () => workspace,
    timeoutMs: () => 300_000,
    canRememberRules: () => true,
  });
  const cards = (): HostToWebviewMessage[] => posted.filter((message) => message.type === "permission");
  return { facade, posted, cards, ui };
}

test("别的请求被自动放行时不重发当前卡片：面板会因此多出一张一模一样的卡", () => {
  const { facade, cards } = createHarness();
  facade.handleRequested("1", decision(), "执行命令 npm install");
  assert.equal(cards().length, 1);

  // 自动放行 / 自动拒绝的请求从没入过队，但它们同样会走 handleResolved。
  facade.handleResolved("auto-42", "allow_once");

  assert.equal(cards().length, 1, "队首没变就不该再推一次");
});

test("当前卡结算后才推下一张，且只推一次", () => {
  const { facade, cards } = createHarness();
  facade.handleRequested("1", decision(), "执行命令 npm install");
  facade.handleRequested("2", decision({ command: "npm test" }), "执行命令 npm test");
  assert.equal(cards().length, 1, "一次只暴露一张卡");

  facade.handleResolved("1", "allow_once");
  const published = cards();
  assert.equal(published.length, 2);
  assert.equal(published[1]?.type === "permission" ? published[1].card.requestId : "", "2");

  // 队首已经是 2 了，再有无关请求结算也不该重复推它。
  facade.handleResolved("auto-7", "allow_once");
  assert.equal(cards().length, 2);
});

test("面板重挂时补推当前卡：新面板是空的，必须重发", () => {
  const { facade, cards } = createHarness();
  facade.handleRequested("1", decision(), "执行命令 npm install");
  facade.republishCurrent();
  assert.equal(cards().length, 2, "补推是重挂场景的正常需求，由面板按 requestId 去重");
});

test("卡片组装带上人话说明与模型意图", () => {
  const { facade, cards } = createHarness();
  facade.handleRequested("1", decision({ intent: "补上缺失的依赖再跑测试" }), "执行命令 npm install");
  const first = cards()[0];
  assert.ok(first?.type === "permission");
  assert.equal(first.card.steps[0]?.action, "按 package.json 把依赖装进 node_modules");
  assert.equal(first.card.notes.length, 1);
  assert.equal(first.card.intent, "补上缺失的依赖再跑测试");
});

test("目标越界直接拒绝，不弹卡", () => {
  const { facade, cards, posted } = createHarness();
  facade.handleRequested(
    "1",
    decision({ operation: "write", targets: ["E:\\other\\x.ts"] }),
    "修改文件 x.ts",
  );
  assert.equal(cards().length, 0);
  assert.ok(posted.some((message) => message.type === "notice" && message.message.includes("越界")));
});
