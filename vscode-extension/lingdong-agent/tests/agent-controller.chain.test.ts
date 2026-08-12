import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, flush } from "./support/controller-harness";
import type { HostToWebviewMessage } from "../src/messages";

/**
 * 全链路测试：发送 → 流式 → 落盘 → 重开扩展后恢复。
 * 第二个 harness 复用同一份工作区与存储目录，等价于重启 VS Code。
 */

type RestoreMessage = Extract<HostToWebviewMessage, { type: "restore" }>;

function restoreOf(messages: HostToWebviewMessage[]): RestoreMessage {
  const restore = messages.find((message): message is RestoreMessage => message.type === "restore");
  assert.ok(restore, "重开后应当收到 restore 消息");
  return restore;
}

test("发送 → 流式 → 落盘 → 重开后恢复出同一段对话", async () => {
  const first = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = () => [
        { type: "text_delta", text: "先看一下" },
        { type: "text_delta", text: " 项目结构。" },
        { type: "completed", stopReason: "end_turn" },
      ];
    },
  });

  const { workspaceRoot, storageRoot } = first;
  try {
    await first.controller.sendPrompt("介绍一下这个仓库");
    await flush();

    const deltas = first
      .messagesOfType("assistantDelta")
      .map((message) => message.text)
      .join("");
    assert.equal(deltas, "先看一下 项目结构。");
    assert.equal(first.messagesOfType("assistantEnd").length, 1);
  } finally {
    await first.dispose();
  }

  const second = createControllerHarness({ workspaceRoot, storageRoot });
  try {
    await second.controller.ensureStorage();
    second.controller.syncState();
    await flush();

    const restore = restoreOf(second.messages);
    const kinds = restore.entries.map((entry) => entry.type);
    assert.ok(kinds.includes("userMessage"), "应恢复用户消息");
    assert.ok(kinds.includes("assistantDelta"), "应恢复助手回复");

    const userText = restore.entries
      .filter((entry): entry is Extract<HostToWebviewMessage, { type: "userMessage" }> =>
        entry.type === "userMessage")
      .map((entry) => entry.text);
    assert.deepEqual(userText, ["介绍一下这个仓库"]);

    const assistantText = restore.entries
      .filter((entry): entry is Extract<HostToWebviewMessage, { type: "assistantDelta" }> =>
        entry.type === "assistantDelta")
      .map((entry) => entry.text)
      .join("");
    assert.ok(assistantText.includes("项目结构"));
  } finally {
    await second.dispose();
  }
});

test("恢复会保留当时的工作模式", async () => {
  const first = createControllerHarness();
  const { workspaceRoot, storageRoot } = first;
  try {
    await first.controller.setMode("agent");
    await first.controller.sendPrompt("改一下配置");
    await flush();
  } finally {
    await first.dispose();
  }

  const second = createControllerHarness({ workspaceRoot, storageRoot });
  try {
    await second.controller.ensureStorage();
    second.controller.syncState();
    await flush();
    assert.equal(restoreOf(second.messages).mode, "agent");
    assert.equal(second.controller.mode, "agent");
  } finally {
    await second.dispose();
  }
});

test("恢复时会复用已有的 Grok 会话标识", async () => {
  const first = createControllerHarness();
  const { workspaceRoot, storageRoot } = first;
  let firstSessionId: string | undefined;
  try {
    await first.controller.sendPrompt("第一轮");
    firstSessionId = first.runtime().sessionId;
    assert.ok(firstSessionId);
  } finally {
    await first.dispose();
  }

  const second = createControllerHarness({ workspaceRoot, storageRoot });
  try {
    await second.controller.ensureStorage();
    second.controller.syncState();
    await flush();
    await second.controller.sendPrompt("第二轮");

    const runtime = second.runtime();
    assert.ok(
      runtime.calls.includes(`loadSession:${firstSessionId}`),
      `应当尝试恢复底层会话，实际调用：${runtime.calls.join(", ")}`,
    );
  } finally {
    await second.dispose();
  }
});

test("底层会话恢复失败时保留本地记录并新建会话", async () => {
  const first = createControllerHarness();
  const { workspaceRoot, storageRoot } = first;
  try {
    await first.controller.sendPrompt("第一轮");
  } finally {
    await first.dispose();
  }

  const second = createControllerHarness({
    workspaceRoot,
    storageRoot,
    onCreateRuntime: (runtime) => {
      runtime.loadSessionError = new Error("session not found");
    },
  });
  try {
    await second.controller.ensureStorage();
    second.controller.syncState();
    await flush();
    second.clearMessages();
    await second.controller.sendPrompt("第二轮");

    const runtime = second.runtime();
    assert.ok(runtime.calls.some((call) => call.startsWith("loadSession:")));
    assert.ok(runtime.calls.includes("createSession"), "load 失败后应新建底层会话");
    assert.ok(
      second
        .messagesOfType("notice")
        .some((message) => message.message.includes("无法恢复")),
      "应当提示用户底层会话未能恢复",
    );
    assert.equal(runtime.prompts.length, 1, "提示词仍要正常送达");
  } finally {
    await second.dispose();
  }
});

test("多轮对话按时间顺序落盘并按序恢复", async () => {
  const first = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = (prompt) => [
        { type: "text_delta", text: `回应 ${prompt}` },
        { type: "completed", stopReason: "end_turn" },
      ];
    },
  });
  const { workspaceRoot, storageRoot } = first;
  try {
    await first.controller.sendPrompt("问题一");
    await first.controller.sendPrompt("问题二");
    await flush();
  } finally {
    await first.dispose();
  }

  const second = createControllerHarness({ workspaceRoot, storageRoot });
  try {
    await second.controller.ensureStorage();
    second.controller.syncState();
    await flush();

    const restore = restoreOf(second.messages);
    const timeline = restore.entries
      .filter((entry) => entry.type === "userMessage" || entry.type === "assistantDelta")
      .map((entry) => (entry.type === "userMessage" ? `U:${entry.text}` : `A:${entry.text}`));

    assert.deepEqual(timeline, [
      "U:问题一",
      "A:回应 问题一",
      "U:问题二",
      "A:回应 问题二",
    ]);
  } finally {
    await second.dispose();
  }
});
