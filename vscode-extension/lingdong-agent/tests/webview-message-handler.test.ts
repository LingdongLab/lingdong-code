import assert from "node:assert/strict";
import test from "node:test";
import type { AgentController } from "../src/agent-controller";
import type { HostToWebviewMessage } from "../src/messages";
import { handleWebviewMessage } from "../src/webview-message-handler";

interface Harness {
  calls: string[];
  posted: HostToWebviewMessage[];
  logs: string[];
  controller: AgentController;
  options: Parameters<typeof handleWebviewMessage>[2];
}

function harness(overrides: Record<string, unknown> = {}): Harness {
  const calls: string[] = [];
  const posted: HostToWebviewMessage[] = [];
  const logs: string[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}(${args.map((arg) => String(arg)).join(",")})`);
    return Promise.resolve();
  };
  const controller = {
    mode: "ask",
    syncState: record("syncState"),
    sendPrompt: record("sendPrompt"),
    stop: record("stop"),
    openSessionMenu: record("openSessionMenu"),
    loadPersistedSession: record("loadPersistedSession"),
    ...overrides,
  } as unknown as AgentController;

  return {
    calls,
    posted,
    logs,
    controller,
    options: {
      output: { appendLine: (line: string) => logs.push(line) },
      post: (message: HostToWebviewMessage) => posted.push(message),
    },
  };
}

test("openSessionMenu 路由到宿主的原生会话菜单", async () => {
  const h = harness();
  await handleWebviewMessage(h.controller, { type: "openSessionMenu", sessionId: "ses-abcdef12" }, h.options);
  assert.deepEqual(h.calls, ["openSessionMenu(ses-abcdef12)"]);
});

test("路径形态的 sessionId 在校验层就被丢弃", async () => {
  const h = harness();
  await handleWebviewMessage(h.controller, { type: "openSessionMenu", sessionId: "../../etc" }, h.options);
  assert.deepEqual(h.calls, []);
  assert.equal(h.logs.length, 1);
});

test("处理器抛错不会变成未捕获的 Promise rejection，而是回报可恢复错误", async () => {
  const h = harness({
    sendPrompt: () => Promise.reject(new Error("Grok ACP 子进程未运行")),
  });
  await handleWebviewMessage(h.controller, { type: "sendPrompt", text: "你好" }, h.options);

  const error = h.posted.find((message) => message.type === "error");
  assert.ok(error, "应向 Webview 回报错误");
  assert.equal(error.type === "error" ? error.recoverable : undefined, true);
  assert.match(error.type === "error" ? error.message : "", /Grok ACP 子进程未运行/);
  assert.match(h.logs.join("\n"), /处理 sendPrompt 失败/);
});

test("同步抛出的处理器同样被兜住", async () => {
  const h = harness({
    stop: () => {
      throw new Error("状态机拒绝");
    },
  });
  await handleWebviewMessage(h.controller, { type: "stop" }, h.options);
  const error = h.posted.find((message) => message.type === "error");
  assert.ok(error);
  assert.match(error.type === "error" ? error.message : "", /状态机拒绝/);
});
