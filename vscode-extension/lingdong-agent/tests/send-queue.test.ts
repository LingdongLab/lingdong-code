import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, flush, type ControllerHarness } from "./support/controller-harness";

/**
 * 忙时发送队列（对话连续性一期阶段 C，宿主侧）：
 * - 忙时发送不再报错，入队并回执 sendQueue 快照；
 * - 轮次正常结束自动出队续发；
 * - 用户取消（stopReason=cancelled）不自动续发，可手动「立即发送」；
 * - 队列有上限；新建会话清空队列。
 */

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor 超时");
    await flush();
  }
}

function lastQueueItems(harness: ControllerHarness): Array<{ id: string; text: string }> {
  return harness.messagesOfType("sendQueue").at(-1)?.items ?? [];
}

test("忙时发送入队并回执快照，轮次结束后自动续发", async () => {
  const harness = createControllerHarness();
  try {
    const first = harness.controller.sendPrompt("介绍一下项目");
    // 第一轮仍在飞（send 的 sending 标志同步生效），此时再发即入队。
    await harness.controller.sendPrompt("继续介绍测试目录");
    assert.deepEqual(lastQueueItems(harness).map((item) => item.text), ["继续介绍测试目录"]);

    await first;
    await waitFor(() => harness.runtime().prompts.length === 2);
    assert.deepEqual(harness.runtime().prompts, ["介绍一下项目", "继续介绍测试目录"]);
    // 出队后队列快照应为空。
    assert.deepEqual(lastQueueItems(harness), []);
    // 忙时发送不产生错误消息。
    assert.equal(harness.messagesOfType("error").length, 0);
  } finally {
    await harness.dispose();
  }
});

test("用户取消的轮次不自动续发，队列保留可手动立即发送", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = () => [
        { type: "text_delta", text: "执行中……" },
        { type: "completed", stopReason: "cancelled" },
      ];
    },
  });
  try {
    const first = harness.controller.sendPrompt("第一条");
    await harness.controller.sendPrompt("排队的第二条");
    await first;
    await flush();

    // 取消结束：不续发，队列保留。
    assert.deepEqual(harness.runtime().prompts, ["第一条"]);
    const queued = lastQueueItems(harness);
    assert.equal(queued.length, 1);

    // 手动「立即发送」走完整发送链路。
    harness.runtime().script = (prompt) => [
      { type: "text_delta", text: `收到：${prompt}` },
      { type: "completed", stopReason: "end_turn" },
    ];
    await harness.controller.flushQueuedPrompt(queued[0]!.id);
    await waitFor(() => harness.runtime().prompts.length === 2);
    assert.equal(harness.runtime().prompts[1], "排队的第二条");
    assert.deepEqual(lastQueueItems(harness), []);
  } finally {
    await harness.dispose();
  }
});

test("队列可删除条目，且有 10 条上限", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = () => [{ type: "completed", stopReason: "cancelled" }];
    },
  });
  try {
    const first = harness.controller.sendPrompt("第一条");
    for (let index = 1; index <= 11; index += 1) {
      await harness.controller.sendPrompt(`排队第${index}条`);
    }
    // 第 11 条被拒并给出警告。
    assert.equal(lastQueueItems(harness).length, 10);
    assert.ok(
      harness.messagesOfType("notice").some((message) => message.message.includes("上限")),
      "超出上限应有警告",
    );
    await first;

    const queued = lastQueueItems(harness);
    harness.controller.removeQueuedPrompt(queued[0]!.id);
    assert.equal(lastQueueItems(harness).length, 9);
    assert.equal(lastQueueItems(harness).some((item) => item.id === queued[0]!.id), false);
  } finally {
    await harness.dispose();
  }
});

test("编辑排队消息改写文本，重排调整出队顺序", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = () => [{ type: "completed", stopReason: "cancelled" }];
    },
  });
  try {
    const first = harness.controller.sendPrompt("第一条");
    await harness.controller.sendPrompt("排队甲");
    await harness.controller.sendPrompt("排队乙");
    await first;

    let queued = lastQueueItems(harness);
    assert.deepEqual(queued.map((item) => item.text), ["排队甲", "排队乙"]);

    harness.controller.editQueuedPrompt(queued[0]!.id, "排队甲（改）");
    assert.equal(lastQueueItems(harness)[0]?.text, "排队甲（改）");

    queued = lastQueueItems(harness);
    harness.controller.reorderQueuedPrompts([queued[1]!.id, queued[0]!.id]);
    assert.deepEqual(lastQueueItems(harness).map((item) => item.text), ["排队乙", "排队甲（改）"]);

    harness.runtime().script = (prompt) => [
      { type: "text_delta", text: `收到：${prompt}` },
      { type: "completed", stopReason: "end_turn" },
    ];
    const nextId = lastQueueItems(harness)[0]!.id;
    await harness.controller.flushQueuedPrompt(nextId);
    await waitFor(() => harness.runtime().prompts.length === 2);
    assert.equal(harness.runtime().prompts[1], "排队乙");
  } finally {
    await harness.dispose();
  }
});

test("编辑为空白等同删除该排队消息", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = () => [{ type: "completed", stopReason: "cancelled" }];
    },
  });
  try {
    const first = harness.controller.sendPrompt("第一条");
    await harness.controller.sendPrompt("待删除");
    await first;
    const queued = lastQueueItems(harness);
    assert.equal(queued.length, 1);
    harness.controller.editQueuedPrompt(queued[0]!.id, "   ");
    assert.deepEqual(lastQueueItems(harness), []);
  } finally {
    await harness.dispose();
  }
});

test("新建会话清空发送队列", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      runtime.script = () => [{ type: "completed", stopReason: "cancelled" }];
    },
  });
  try {
    const first = harness.controller.sendPrompt("第一条");
    await harness.controller.sendPrompt("排队的旧会话消息");
    await first;
    assert.equal(lastQueueItems(harness).length, 1);

    await harness.controller.newSession();
    await flush();
    assert.deepEqual(lastQueueItems(harness), []);
    // 队列里的消息不得被带进新会话发送。
    assert.deepEqual(harness.runtime().prompts, ["第一条"]);
  } finally {
    await harness.dispose();
  }
});
