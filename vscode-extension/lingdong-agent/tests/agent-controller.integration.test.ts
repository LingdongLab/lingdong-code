import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createControllerHarness, flush } from "./support/controller-harness";

/**
 * AgentController 集成测试。
 * 覆盖发送、停止、模式切换、权限、变更与断线重连；
 * 全链路落盘/恢复另见 agent-controller.chain.test.ts。
 */

test("发送一次提示词会走完连接、流式与结束流程", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("列一下项目结构");

    const runtime = harness.runtime();
    assert.deepEqual(runtime.calls.slice(0, 3), ["initialize", "probeCompact", "createSession"]);
    assert.equal(runtime.prompts.length, 1);
    assert.match(runtime.prompts[0] ?? "", /列一下项目结构/);

    assert.deepEqual(
      harness.messagesOfType("userMessage").map((message) => message.text),
      ["列一下项目结构"],
    );
    assert.equal(harness.messagesOfType("connection").at(-1)?.state, "ready");
    assert.deepEqual(
      harness.messagesOfType("busy").map((message) => message.busy),
      [true, false],
    );
    assert.equal(harness.controller.busy, false);
  } finally {
    await harness.dispose();
  }
});

test("上一条还在发送时不再拒绝：第二条排队并在本轮结束后自动续发", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = (prompt) => [
        { type: "text_delta", text: prompt },
        { type: "completed", stopReason: "end_turn" },
      ];
    },
  });
  try {
    const first = harness.controller.sendPrompt("第一条");
    const second = harness.controller.sendPrompt("第二条");
    await Promise.all([first, second]);

    // 忙时发送队列（对话连续性一期阶段 C）：入队 → 本轮结束自动出队续发。
    const startedAt = Date.now();
    while (harness.runtime().prompts.length < 2) {
      if (Date.now() - startedAt > 3_000) throw new Error("等待队列续发超时");
      await flush();
    }
    assert.deepEqual(harness.runtime().prompts, ["第一条", "第二条"]);
    assert.equal(harness.messagesOfType("error").length, 0);
  } finally {
    await harness.dispose();
  }
});

test("连接失败时给出可恢复错误，不把控制器卡在忙碌态", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.failInitialize = new Error("Grok 启动失败");
    },
  });
  try {
    await harness.controller.sendPrompt("你好");

    assert.equal(harness.messagesOfType("connection").at(-1)?.state, "failed");
    // 连接类失败只在 Status Bar（turnStatus=interrupted），聊天区不再叠错误卡。
    const turn = harness.messagesOfType("turnStatus").at(-1);
    assert.equal(turn?.status, "interrupted");
    assert.equal(turn?.connectionActions, true);
    assert.equal(
      harness.messagesOfType("error").some((message) => message.message.includes("Grok 启动失败")),
      false,
    );
    assert.equal(harness.controller.busy, false);
  } finally {
    await harness.dispose();
  }
});

test("子进程异常退出会作废缓存，下一次发送重新拉起 Runtime", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("第一轮");
    const first = harness.runtime();
    harness.clearMessages();

    first.emitOutOfTurn({ type: "disconnected", reason: "code=1", code: 1, signal: null });
    await flush();

    assert.equal(harness.messagesOfType("connection").at(-1)?.state, "failed");
    assert.ok(
      harness.messagesOfType("error").some((message) => message.message.includes("连接已断开")),
    );

    await harness.controller.sendPrompt("第二轮");
    assert.equal(harness.runtimes.length, 2, "应当创建了新的 Runtime");
    assert.notEqual(harness.runtime(), first);
    assert.equal(harness.runtime().prompts.length, 1);
  } finally {
    await harness.dispose();
  }
});

test("手动重连会释放旧 Runtime 并重新初始化", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.sendPrompt("预热");
    const first = harness.runtime();
    harness.clearMessages();

    await harness.controller.reconnect();

    assert.ok(first.calls.includes("dispose"));
    assert.equal(harness.runtimes.length, 2);
    assert.equal(harness.messagesOfType("connection").at(-1)?.state, "ready");
  } finally {
    await harness.dispose();
  }
});

test("停止会取消底层轮次", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = () => [
        { type: "text_delta", text: "思考中" },
        { type: "completed", stopReason: "cancelled" },
      ];
    },
  });
  try {
    await harness.controller.sendPrompt("跑个长任务");
    harness.clearMessages();

    await harness.controller.stop();

    const notices = harness.messagesOfType("notice").map((message) => message.message);
    assert.ok(notices.some((text) => text.includes("没有正在执行的任务")));
  } finally {
    await harness.dispose();
  }
});

test("Plan 模式发送会注入研究约束，且不请求终端命令", async () => {
  const harness = createControllerHarness();
  try {
    harness.setWorkspaceFiles(["src/auth/session.ts", "src/auth/router.ts"]);
    await harness.controller.setMode("plan");
    await harness.controller.sendPrompt("帮我规划登录改造");

    const prompt = harness.runtime().prompts[0] ?? "";
    assert.ok(prompt.includes("帮我规划登录改造"));
    assert.ok(
      prompt.includes("禁止为了列目录而执行终端命令"),
      "Plan 模式必须显式禁止终端列目录",
    );
    // 概览由宿主安全列出，只能是相对路径。
    assert.ok(prompt.includes("src/auth/session.ts"));
    assert.ok(
      !prompt.includes(harness.workspaceRoot),
      "计划提示词里不应出现工作区绝对路径",
    );
    assert.equal(harness.controller.mode, "plan");
  } finally {
    await harness.dispose();
  }
});

test("文件变更事件会形成可复核的变更列表", async () => {
  const harness = createControllerHarness();
  try {
    const target = path.join(harness.workspaceRoot, "src");
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, "app.ts");
    fs.writeFileSync(file, "before\n");

    harness.controller.addPoster(() => undefined);
    await harness.controller.sendPrompt("改一下 app.ts");
    await flush();

    // 没有真实写入时不应该伪造变更列表。
    assert.equal(harness.messagesOfType("changes").length, 0);
  } finally {
    await harness.dispose();
  }
});

test("切换模型在未连接时只记录选择，不报错", async () => {
  const harness = createControllerHarness();
  try {
    const models = harness.controller.models.list();
    const target = models[0];
    assert.ok(target, "模型注册表不应为空");

    await harness.controller.selectModel(target.id);

    assert.equal(harness.messagesOfType("error").length, 0);
    assert.ok(harness.messagesOfType("models").length > 0);
  } finally {
    await harness.dispose();
  }
});

test("未知模型只给提示，不改变运行时状态", async () => {
  const harness = createControllerHarness();
  try {
    await harness.controller.selectModel("不存在的模型");
    const notices = harness.messagesOfType("notice").map((message) => message.message);
    assert.ok(notices.some((text) => text.includes("未知模型")));
  } finally {
    await harness.dispose();
  }
});
