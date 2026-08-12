// 验证 system_prompt_label 能否不改源码就替换 Agent 自我认知（对话里自称）。
// 用法：设置 GROK_SYSTEM_PROMPT_LABEL 后运行，问一句“你是谁”看自称。
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
child.stderr.resume();

function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && message.method === undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "session/update") {
    const update = message.params?.update;
    if (update?.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.text;
      if (typeof text === "string") assistantText += text;
    }
    return;
  }
  if (message.id !== undefined && message.method) {
    let result = {};
    if (message.method.endsWith("request_permission")) result = { outcome: { outcome: "selected", optionId: "reject_once" } };
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  }
}

function request(method, params, timeoutMs = 120_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "lingdong-identity-probe", title: "灵动身份探针", version: "0.1.0" },
  });
  const session = await request("session/new", { cwd: workspace, mcpServers: [] });
  const sessionId = session.result?.sessionId;
  const prompt = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "你是谁？用一句话介绍你自己，说出你的名字。不要使用任何工具。" }],
  });
  console.log(JSON.stringify({
    label: process.env.GROK_SYSTEM_PROMPT_LABEL ?? "(默认)",
    stopReason: prompt.result?.stopReason ?? prompt.error,
    reply: assistantText.trim(),
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ fatal: error.message }));
} finally {
  child.stdin.end();
  child.kill();
}
