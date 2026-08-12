import assert from "node:assert/strict";
import test from "node:test";
import { ProcessManager, type ProcessExit } from "../src/process-manager.js";

test("能报告子进程异常退出", async () => {
  const manager = new ProcessManager({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(7), 20)"],
    cwd: process.cwd(),
  });
  const exited = new Promise<ProcessExit>((resolve) => manager.once("exit", resolve));
  await manager.start();
  const result = await exited;
  assert.equal(result.code, 7);
  assert.equal(result.expected, false);
});

test("子进程不读 stdin 时，写入到点报错，而不是永远挂着", async () => {
  const manager = new ProcessManager({
    executable: process.execPath,
    // 只睡觉、从不读自己 stdin 的子进程：管道缓冲区写满之后就再也咽不下去了。
    args: ["-e", "setTimeout(() => {}, 60000)"],
    cwd: process.cwd(),
    writeTimeoutMs: 300,
  });
  // 收尾杀进程时管道会给一记 EPIPE/EOF；这里认领掉，免得它变成未捕获异常。
  manager.on("error", () => undefined);
  await manager.start();
  try {
    // 小消息会先落进管道缓冲区，写不满就不背压，所以这里一次写够大的量。
    const huge = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "session/prompt",
      params: { pad: "x".repeat(4_000_000) },
    };

    await assert.rejects(
      async () => {
        for (let i = 0; i < 4; i += 1) await manager.send(huge);
      },
      /写入 Grok 子进程超时/,
      "没有这个超时的话，这一轮既不完成也不失败，界面会一直停在「正在思考」",
    );
  } finally {
    await manager.close(500);
  }
});
