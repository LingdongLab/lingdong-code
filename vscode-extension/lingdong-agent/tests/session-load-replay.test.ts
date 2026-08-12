import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createControllerHarness, flush } from "./support/controller-harness";

/**
 * session/load 时 Grok 会把历史以 session/update 回放。
 * 那些事件只服务模型上下文；若再 post/persist，每次点开会话正文都会翻倍。
 */

test("ACP session/load 回放不写入 transcript、不刷对话区", async () => {
  const harness = createControllerHarness({
    onCreateRuntime: (runtime) => {
      const original = runtime.loadSession.bind(runtime);
      runtime.loadSession = async (sessionId, cwd?, mode?) => {
        await original(sessionId, cwd, mode);
        runtime.emitOutOfTurn({ type: "text_delta", text: "REPLAY_SHOULD_NOT_PERSIST" });
        runtime.emitOutOfTurn({ type: "status", message: "客户端安全模式：agent" });
      };
    },
  });
  try {
    await harness.controller.sendPrompt("你好啊");
    await flush(6);
    const sessionId = harness.controller.activeSessionId;
    assert.ok(sessionId);

    harness.clearMessages();
    await harness.controller.loadPersistedSession(sessionId);
    await flush(8);

    const replayed = harness.messages.filter(
      (message) => message.type === "assistantDelta" && message.text.includes("REPLAY_SHOULD_NOT_PERSIST"),
    );
    assert.equal(replayed.length, 0, "回放正文不得推到面板");

    const transcriptFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "transcript.json") transcriptFiles.push(full);
      }
    };
    walk(path.join(harness.storageRoot, "agent-sessions"));
    assert.ok(transcriptFiles.length > 0, "应有 transcript 文件");
    for (const file of transcriptFiles) {
      const raw = fs.readFileSync(file, "utf8");
      assert.equal(
        raw.includes("REPLAY_SHOULD_NOT_PERSIST"),
        false,
        `回放不得落盘：${file}`,
      );
    }
  } finally {
    await harness.dispose();
  }
});
