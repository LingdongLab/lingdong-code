// 能力位探针：验证三个 clientCapabilities._meta 能力位在目标 grok 二进制上的支持面。
//
// 背景：源码盘点（1.0.0 alpha）确认 initialize 的 clientCapabilities._meta 里可以声明
//   - "x.ai/hunkTracker": { "mode": "agent_only" | "all_dirty" }   → 开启逐 hunk 追踪
//   - "x.ai/incrementalBashOutput": true                            → bash 流式更新只发增量
//   - "x.ai/bashOutputNoColor": true                                → 命令环境注入 NO_COLOR
// 但捆绑运行时是 0.2.118 stable，能不能用得先问二进制本人。设计要点：hunk 追踪在
// all_dirty 模式下会跟踪 git 脏文件，所以不需要模型 API Key——探针自己 git init、
// 改文件，就能拿到真实的 hunk 报文形状。
//
// 用法：node scripts/probe-caps.mjs
//   LINGDONG_GROK       目标二进制（默认官方捆绑 grok.exe）
//   LINGDONG_PROBE_WS   探针工作区（默认 E:\LingdongCode\workspace\grok-probe-caps，会被重建）
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const workspace = process.env.LINGDONG_PROBE_WS ?? "E:\\LingdongCode\\workspace\\grok-probe-caps";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";

// —— 1. 准备一个带 git 基线的一次性工作区 ——
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
git("init", "-q");
git("config", "user.email", "probe@lingdong.local");
git("config", "user.name", "lingdong-probe");
const samplePath = path.join(workspace, "sample.txt");
writeFileSync(samplePath, "line one\nline two\nline three\n", "utf8");
git("add", ".");
git("commit", "-q", "-m", "baseline");

const child = spawn(executable, ["--no-auto-update", "agent", "stdio"], {
  cwd: workspace,
  env: { ...process.env, GROK_HOME: grokHome },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
/** 收到的所有 x.ai/* 通知（method + params），用来核对 queue/changed 之类的广播形状。 */
const extNotifications = [];

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

const stderrChunks = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry.resolve(message);
    return;
  }
  if (typeof message.method === "string" && message.method.includes("x.ai/") && message.id === undefined) {
    extNotifications.push({ method: message.method, params: message.params });
    return;
  }
  // 反向请求一律拒绝，探针不动真格。
  if (message.id !== undefined && message.method) {
    const method = message.method;
    let result = {};
    if (method.endsWith("request_permission")) result = { outcome: { outcome: "selected", optionId: "reject_once" } };
    else if (method.endsWith("ask_user_question")) result = { cancelled: true };
    else if (method.endsWith("exit_plan_mode")) result = { approved: false };
    send({ jsonrpc: "2.0", id: message.id, result });
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
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/** 调用并把完整响应（result 或 error）原样记下来——这次要的是报文形状，不只是在不在。 */
async function capture(method, params) {
  try {
    const message = await request(method, params, 15_000);
    if (message.error) {
      return { ok: false, code: message.error.code, error: message.error.message ?? message.error.data };
    }
    return { ok: true, result: message.result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** 扩展方法有 `x.ai/` 与 `_x.ai/`（未定稿）两种前缀，先裸名后下划线，记下哪个通了。 */
async function captureExt(method, params) {
  const bare = await capture(method, params);
  if (bare.ok || bare.code !== -32601) return { via: method, ...bare };
  const underscored = await capture(`_${method}`, params);
  return { via: `_${method}`, ...underscored };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { executable };

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      _meta: {
        "x.ai/hunkTracker": { mode: "all_dirty" },
        "x.ai/incrementalBashOutput": true,
        "x.ai/bashOutputNoColor": true,
      },
    },
    clientInfo: { name: "lingdong-probe-caps", title: "灵动能力位探针", version: "0.1.0" },
  });
  report.initialize = init.result ?? init.error;

  const session = await request("session/new", {
    cwd: workspace,
    mcpServers: [],
    _meta: { autoMode: false, yoloMode: false },
  });
  report.sessionNewMeta = session.result?._meta ?? null;
  report.sessionNewError = session.error ?? null;
  const sessionId = session.result?.sessionId;

  if (sessionId) {
    // —— 2. 制造一个外部脏改动，让 all_dirty 模式有东西可追 ——
    writeFileSync(samplePath, "line one CHANGED\nline two\nline three\nline four added\n", "utf8");
    await sleep(2_500); // 给 fs-notify / 惰性扫描一点时间

    report.hunkTracker = {};
    report.hunkTracker.getFiles = await captureExt("x.ai/hunk-tracker/get-files", { sessionId });
    report.hunkTracker.getHunksAll = await captureExt("x.ai/hunk-tracker/get-hunks", { sessionId });
    report.hunkTracker.getHunksForPath = await captureExt("x.ai/hunk-tracker/get-hunks", {
      sessionId,
      path: samplePath,
    });
    report.hunkTracker.getSummary = await captureExt("x.ai/hunk-tracker/get-summary", { sessionId });

    // 有真实 hunk 就点一下 accept，拿 ActionResponse 的真实形状（一次性工作区，随便点）。
    const hunkBody = report.hunkTracker.getHunksAll?.result;
    const hunks = hunkBody?.hunks ?? hunkBody?.result?.hunks;
    const firstHunkId = Array.isArray(hunks) && hunks[0] ? (hunks[0].id ?? hunks[0].hunkId) : undefined;
    if (firstHunkId) {
      report.hunkTracker.hunkAction = await captureExt("x.ai/hunk-tracker/hunk-action", {
        sessionId,
        hunkId: String(firstHunkId),
        action: "accept",
      });
      // accept 之后再取一次，验证 hunk 消失/selected 状态翻转的行为。
      report.hunkTracker.getFilesAfterAction = await captureExt("x.ai/hunk-tracker/get-files", { sessionId });
    }

    // —— 3. queue 支持面。注意：x.ai/queue/* 是「通知」不是请求（acp_agent.rs 的
    // ext_notification 分支），发出去没有响应，真值信号是 x.ai/queue/changed 广播。
    // handle_clear_queue 即使队列为空也会无条件重广播，正好当探测器用。
    report.queue = {};
    // 线协议约定：扩展方法（请求与通知都是）要带 `_` 前缀，库在派发前剥掉。
    const changedBefore = extNotifications.filter((n) => n.method.includes("queue/changed")).length;
    send({ jsonrpc: "2.0", method: "_x.ai/queue/clear", params: { sessionId, clientIdentifier: "lingdong-probe" } });
    await sleep(2_000);
    const changedAfter = extNotifications.filter((n) => n.method.includes("queue/changed")).length;
    report.queue.clearNotificationTriggersChanged = changedAfter > changedBefore;
    report.queue.changedPayload = extNotifications.find((n) => n.method.includes("queue/changed")) ?? null;
  }
} catch (error) {
  report.fatal = error.message;
} finally {
  await sleep(500);
  report.extNotifications = extNotifications.slice(0, 20);
  report.stderr = stderrChunks.join("").slice(-1500);
  console.log(JSON.stringify(report, null, 2));
  child.stdin.end();
  child.kill();
}
