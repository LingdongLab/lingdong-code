// 查明 Grok 的斜杠命令（/goal、/workflow、/deep-research…）能不能经 ACP 调起来。
//
// 存在的理由：slash-command.ts 把这些命令一律拒掉，理由写的是「Grok 的斜杠命令是 TUI
// 前端自己解析的，不经过 ACP，我们连命令列表都拿不到（只有 headless 会 advertise）」。
// 但 probe-acp-surface 实测 `agent stdio` 的 initialize._meta.availableCommands 里就有
// goal / workflow / deep-research，session/update 里还有 available_commands_update。
// 两个说法冲突，得判个真假——这决定了接入它们是「加个开关」还是「造一个功能」。
//
// 手法：拿一条不需要模型的命令（/session-info）当试纸，用 session/prompt 发过去。
//   - Agent 侧解析了 → 拿到结果，不会碰模型
//   - 只是被当普通消息 → 会走到模型，当前配置下必然是 401
// 401 在这里不是失败，是「没被当命令」的证据。
//
// 用法：node scripts/probe-slash-over-acp.mjs
import { spawn } from "node:child_process";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";

const child = spawn(executable, ["--no-auto-update", "agent", "stdio"], {
  cwd: workspace,
  env: { ...process.env, GROK_HOME: grokHome },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
const seenUpdates = new Set();
let sawModelAuthError = false;

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handleLine(line);
    index = buffer.indexOf("\n");
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  if (/Unauthorized|authentication_error/.test(chunk)) sawModelAuthError = true;
});

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      entry(message);
    }
    return;
  }
  if (message.method === "session/update") {
    const update = message.params?.update ?? message.params;
    if (update?.sessionUpdate) seenUpdates.add(update.sessionUpdate);
    return;
  }
  // 反向请求一律拒绝：探针不该真的动文件。
  if (message.id !== undefined && message.method) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const report = {};
try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "lingdong-probe", title: "灵动探针", version: "0.1.0" },
  });
  const commands = init.result?._meta?.availableCommands ?? [];
  report.advertisedOverStdio = commands.map((item) => item.name).sort();
  report.goalAdvertised = report.advertisedOverStdio.includes("goal");
  report.workflowAdvertised = report.advertisedOverStdio.includes("workflow");

  const session = await request("session/new", { cwd: workspace, mcpServers: [], _meta: {} });
  const sessionId = session.result?.sessionId;
  report.sessionCreated = Boolean(sessionId);

  if (sessionId) {
    // 试纸：/session-info 不需要模型。被 Agent 解析掉就不会产生模型调用。
    const probe = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/session-info" }],
    });
    report.promptStopReason = probe.result?.stopReason ?? probe.error?.code ?? "未知";
    report.seenUpdates = [...seenUpdates].sort();
    report.reachedModel = sawModelAuthError;
    report.verdict = sawModelAuthError
      ? "斜杠命令没被 Agent 解析，原样当提问送进了模型"
      : "Agent 侧解析了斜杠命令，没有产生模型调用";
  }
} catch (error) {
  report.fatal = error instanceof Error ? error.message : String(error);
} finally {
  console.log(JSON.stringify(report, null, 2));
  child.stdin.end();
  child.kill();
}
