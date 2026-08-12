import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, flush } from "./support/controller-harness";

/**
 * 连接加速（对话连续性一期阶段 D）：
 * - 面板挂载（syncState）即后台预热连接，首条消息不吃冷启动；
 * - 预热失败只记日志，不把 UI 锁在 initializing，之后仍可正常发送；
 * - 未连接时切换会话，预热完成后自动补 session/load 恢复模型上下文。
 */

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor 超时");
    await flush();
  }
}

test("面板挂载即后台预热连接，且只预热一次", async () => {
  const harness = createControllerHarness();
  try {
    harness.controller.syncState();
    await waitFor(() => harness.runtimes.length === 1);
    await waitFor(() =>
      harness.messagesOfType("connection").some((message) => message.state === "ready"));
    // 预热完成后连接已就绪，且没有发送过任何 prompt。
    assert.deepEqual(harness.runtime().prompts, []);

    // 面板反复挂载不应重复拉起子进程。
    harness.controller.syncState();
    await flush(6);
    assert.equal(harness.runtimes.length, 1);
  } finally {
    await harness.dispose();
  }
});

test("预热失败只记日志，不锁死 UI，之后发送自动重试", async () => {
  let created = 0;
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      created += 1;
      if (created === 1) runtime.failInitialize = new Error("预热阶段网络不可达");
    },
  });
  try {
    harness.controller.syncState();
    await waitFor(() => harness.logLines.some((line) => line.includes("[preheat] 连接预热失败")));
    await flush(6);
    // 不向用户抛错误卡片，状态机也不能停在 initializing（那会禁用发送）。
    assert.equal(harness.messagesOfType("error").length, 0);
    assert.notEqual(harness.messagesOfType("state").at(-1)?.state, "initializing");

    // 预热失败不影响正常使用：发送时重新拉起并成功执行。
    await harness.controller.sendPrompt("预热失败后照常发送");
    await waitFor(() => harness.runtimes.length === 2 && harness.runtime().prompts.length === 1);
    assert.deepEqual(harness.runtime().prompts, ["预热失败后照常发送"]);
  } finally {
    await harness.dispose();
  }
});

test("未连接时切会话：预热完成后自动补 session/load", async () => {
  // 第一段：造出一个已绑定 Grok 会话的本地记录。
  const first = createControllerHarness();
  const { storageRoot, workspaceRoot } = first;
  let recordId: string;
  let grokSessionId: string;
  try {
    await first.controller.sendPrompt("建立会话");
    await waitFor(() => first.runtime().prompts.length === 1);
    const sessions = first.messagesOfType("sessions").at(-1)?.sessions ?? [];
    assert.equal(sessions.length, 1);
    recordId = sessions[0]!.id;
    grokSessionId = first.runtime().sessionId!;
    assert.ok(grokSessionId);
  } finally {
    await first.dispose();
  }

  // 第二段：新控制器（模拟重开窗口），不预热、不发送，直接切会话。
  const second = createControllerHarness({ storageRoot, workspaceRoot });
  try {
    await second.controller.loadPersistedSession(recordId);
    // runtime 为 undefined 时应触发后台预热并补 session/load。
    await waitFor(() =>
      second.runtimes.length === 1
      && second.runtime().calls.includes(`loadSession:${grokSessionId}`));
    // 启动编排已经绑定过该会话，补载守卫不应重复 load。
    const loads = second.runtime().calls.filter((call) => call.startsWith("loadSession:"));
    assert.equal(loads.length, 1);
    // 连接就绪且没有错误。
    assert.ok(second.messagesOfType("connection").some((message) => message.state === "ready"));
    assert.equal(second.messagesOfType("error").length, 0);
  } finally {
    await second.dispose();
  }
});
