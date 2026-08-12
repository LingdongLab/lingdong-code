// 探明 Grok Build 通过 ACP 实际暴露的能力面，为「对标 Cursor」的改造提供事实依据。
//
// 存在的理由：随包文档（15-agent-mode.md）声称 session/new 的 _meta 支持 rules /
// systemPromptOverride / agentProfile，并列出了 x.ai/git/diffs、x.ai/fs/index 等扩展方法。
// 但文档也明说「treat it as non-exhaustive and discover the available methods from the
// agent's initialize response」。灵动此前只传 { autoMode, yoloMode } 且 clientCapabilities
// 为空，等于没验证过这些到底存不存在。猜错一次就会白改一大片代码，所以先跑一次拿真相。
//
// 用法：node scripts/probe-acp-surface.mjs
import { spawn } from "node:child_process";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";

/** 规则注入的验证标记：出现在回复里就说明 _meta.rules 真的进了系统提示。 */
const RULES_MARKER = "LINGDONG_RULES_OK";

const child = spawn(executable, ["--no-auto-update", "agent", "stdio"], {
  cwd: workspace,
  env: { ...process.env, GROK_HOME: grokHome },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
/** 观察到的 sessionUpdate 类型与工具名，用来核对 event-normalizer 的假设。 */
const seenUpdates = new Set();
const seenTools = new Set();
let assistantText = "";

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
  if (message.method === "session/update" || message.method?.endsWith("session_notification")) {
    const update = message.params?.update ?? message.params;
    collectUpdate(update);
    return;
  }
  // 反向请求：一律拒绝/取消，探针不该真的动文件。
  if (message.id !== undefined && message.method) {
    const method = message.method;
    let result = {};
    if (method.endsWith("request_permission")) result = { outcome: { outcome: "selected", optionId: "reject_once" } };
    else if (method.endsWith("ask_user_question")) result = { cancelled: true };
    else if (method.endsWith("exit_plan_mode")) result = { approved: false };
    send({ jsonrpc: "2.0", id: message.id, result });
  }
}

function collectUpdate(update) {
  if (!update || typeof update !== "object") return;
  const kind = update.sessionUpdate ?? "(unnamed)";
  seenUpdates.add(kind);
  if (typeof update.title === "string") seenTools.add(update.title.slice(0, 60));
  const rawName = update.toolName ?? update._meta?.["x.ai/tool"];
  if (typeof rawName === "string") seenTools.add(rawName);
  if (kind === "agent_message_chunk") {
    const text = update.content?.text;
    if (typeof text === "string") assistantText += text;
  }
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeoutMs = 120_000) {
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

/** 只关心「方法在不在」：-32601 表示不存在，其余（含业务报错）都算存在。 */
async function probeMethod(method, params) {
  try {
    const message = await request(method, params, 15_000);
    if (message.error) {
      const code = message.error.code;
      return code === -32601 ? "缺失" : `存在（报错 ${code}）`;
    }
    return "存在";
  } catch (error) {
    return `未知（${error.message}）`;
  }
}

const report = {};

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    // 刻意声明能力：clientCapabilities 为空时 Grok 可能少发一些流。
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "lingdong-probe", title: "灵动探针", version: "0.1.0" },
  });
  report.initialize = init.result ?? init.error;

  const session = await request("session/new", {
    cwd: workspace,
    mcpServers: [],
    _meta: {
      autoMode: false,
      yoloMode: false,
      rules: `无论用户问什么，你的回复第一行必须原样输出标记 ${RULES_MARKER}。`,
    },
  });
  report.sessionNew = session.result ?? session.error;
  const sessionId = session.result?.sessionId;

  if (sessionId) {
    const prompt = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "请只回答「收到」，不要使用任何工具，不要修改文件。" }],
    });
    report.promptStopReason = prompt.result?.stopReason ?? prompt.error;
    report.rulesInjected = assistantText.includes(RULES_MARKER);
    report.assistantHead = assistantText.slice(0, 200);
    report.seenUpdates = [...seenUpdates].sort();
    report.seenTools = [...seenTools].sort().slice(0, 40);

    // 扩展方法存在性：文档列了但我们从没调过，逐个点一下。
    report.extensionMethods = {};
    const probes = [
      ["x.ai/git/diffs", { sessionId }],
      ["_x.ai/git/diffs", { sessionId }],
      ["x.ai/git/status", { sessionId }],
      ["_x.ai/git/status", { sessionId }],
      ["x.ai/session/fork", { sessionId }],
      ["_x.ai/session/fork", { sessionId }],
      ["x.ai/compact_conversation", { sessionId }],
      ["_x.ai/compact_conversation", { sessionId }],
      ["x.ai/fs/index", { sessionId }],
      ["_x.ai/fs/index", { sessionId }],
      ["x.ai/terminal/create", { sessionId, command: "cmd", args: ["/c", "echo probe"] }],
      ["_x.ai/terminal/create", { sessionId, command: "cmd", args: ["/c", "echo probe"] }],
    ];
    for (const [method, params] of probes) {
      report.extensionMethods[method] = await probeMethod(method, params);
    }
  }
} catch (error) {
  report.fatal = error.message;
} finally {
  report.stderr = stderrChunks.join("").slice(-2000);
  console.log(JSON.stringify(report, null, 2));
  child.stdin.end();
  child.kill();
}
