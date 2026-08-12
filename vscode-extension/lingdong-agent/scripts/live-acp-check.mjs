// 用与 AgentController 相同的配置做真实 Grok/DeepSeek 联调检查（无需启动 Extension Host）。
// 用法：npm run check:live --workspace lingdong-agent
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TESTED_GROK_VERSION, createAgentRuntime } from "@lingdong/agent-runtime";

const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";
const modelId = "deepseek-v4-flash";

async function workspaceDigest() {
  const entries = (await readdir(workspace, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const hash = createHash("sha256");
  for (const name of entries) {
    hash.update(name);
    hash.update(await readFile(path.join(workspace, name)));
  }
  return hash.digest("hex");
}

const logDirectory = path.join(await mkdtemp(path.join(tmpdir(), "lingdong-agent-live-")), "logs");
const runtime = createAgentRuntime({
  executable,
  workspace,
  logDirectory,
  modelId,
  grokHome,
  clientInfo: { name: "lingdong-agent", title: "灵动 Agent", version: "0.1.0" },
});

const outOfTurn = [];
runtime.on("event", (event) => outOfTurn.push(event.type));

const summary = { workspace, executable, modelId };
try {
  const info = await runtime.initialize();
  summary.protocolVersion = info.protocolVersion;
  summary.grokVersion = info.grok.version ?? null;
  summary.grokTested = info.grok.version === TESTED_GROK_VERSION;

  summary.sessionId = await runtime.createSession({ mode: "ask" });

  const before = await workspaceDigest();
  let text = "";
  let activityEvents = 0;
  let stopReason = "";
  let modelFromMeta = null;
  for await (const event of runtime.sendMessage({ text: "请用中文简要说明当前项目包含哪些文件，不要修改任何文件。" })) {
    if (event.type === "text_delta") text += event.text;
    if (event.type === "thought_delta" || event.type === "tool_started" || event.type === "tool_completed") activityEvents += 1;
    if (event.type === "completed") {
      stopReason = event.stopReason;
      modelFromMeta = event.modelId ?? null;
    }
  }
  const after = await workspaceDigest();

  summary.ask = {
    streamedChinese: /[\u4e00-\u9fa5]/.test(text),
    textLength: text.length,
    activityEvents,
    stopReason,
    modelId: modelFromMeta,
    workspaceUnchanged: before === after,
  };

  let cancelStop = "";
  const stream = runtime.sendMessage({ text: "请用中文写一篇非常长的项目分析，至少列出一百条；不要修改文件。" });
  const consume = (async () => {
    for await (const event of stream) {
      if (event.type === "completed") cancelStop = event.stopReason;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await runtime.cancel();
  await consume;
  summary.cancel = { stopReason: cancelStop };
} finally {
  const exit = await runtime.dispose();
  summary.shutdown = { code: exit?.code ?? null, expected: exit?.expected ?? null, running: runtime.processRunning };
  summary.outOfTurnEvents = outOfTurn;
}

console.log(JSON.stringify(summary, null, 2));

const ok = summary.ask?.streamedChinese
  && summary.ask?.workspaceUnchanged
  && summary.ask?.stopReason === "end_turn"
  && summary.cancel?.stopReason === "cancelled"
  && summary.shutdown?.running === false;
if (!ok) process.exitCode = 1;
