// 阶段 D 真实联调：用与 AgentController 相同的 Runtime 配置，无头跑完八项场景。
// 每项前后计算工作区哈希，结束时把 workspace/grok-test 还原为初始内容。
// 用法：npm run check:phase4 --workspace lingdong-agent
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TESTED_GROK_VERSION, createAgentRuntime } from "@lingdong/agent-runtime";

const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";
const modelId = "deepseek-v4-flash";

async function listFiles() {
  return (await readdir(workspace, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

async function snapshot() {
  const files = new Map();
  for (const name of await listFiles()) {
    files.set(name, await readFile(path.join(workspace, name)));
  }
  return files;
}

async function digest() {
  const hash = createHash("sha256");
  for (const [name, content] of [...(await snapshot()).entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function restore(initial) {
  for (const [name, content] of initial) {
    await writeFile(path.join(workspace, name), content);
  }
  for (const name of await listFiles()) {
    if (!initial.has(name)) await rm(path.join(workspace, name), { force: true });
  }
}

const logDirectory = path.join(await mkdtemp(path.join(tmpdir(), "lingdong-phase4-")), "logs");
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

/**
 * 跑一轮提示词。permission 决定与 plan 决定由调用方给出，
 * 与扩展里 AgentController 的处理路径一致（只用 allow_once / allow_session / reject）。
 */
async function runTurn(text, { onPermission = () => "reject", onPlan = () => "reject", cancelAfterMs } = {}) {
  const record = {
    prompt: text,
    text: "",
    stopReason: "",
    permissionRequests: [],
    autoResolved: [],
    plan: null,
    planOutcome: null,
    toolCalls: [],
    errors: [],
  };
  const stream = runtime.sendMessage({ text });
  const consume = (async () => {
    for await (const event of stream) {
      if (event.type === "text_delta") record.text += event.text;
      if (event.type === "error") record.errors.push(event.message);
      if (event.type === "tool_started") record.toolCalls.push(`${event.kind}:${event.label}`);
      if (event.type === "completed") record.stopReason = event.stopReason;
      if (event.type === "permission_resolved" && event.automatic) {
        record.autoResolved.push({ resolution: event.resolution, reason: event.reason });
      }
      if (event.type === "permission_requested") {
        const decision = onPermission(event, record.permissionRequests.length);
        record.permissionRequests.push({
          label: event.label,
          risk: event.decision.risk,
          operation: event.decision.operation,
          decision,
        });
        await runtime.respondPermission(event.requestId, decision).catch((error) => {
          record.errors.push(`权限回执失败：${error.message}`);
        });
      }
      if (event.type === "plan_review_requested") {
        record.plan = {
          title: event.plan.title,
          steps: event.plan.steps.length,
          files: event.plan.files,
          risks: event.plan.risks.length,
          empty: event.plan.empty,
        };
        const action = onPlan(event);
        record.planOutcome = action;
        const call = action === "approve"
          ? runtime.approvePlan()
          : action === "revise"
            ? runtime.revisePlan("请补充验证步骤后再执行。")
            : runtime.rejectPlan();
        await call.catch((error) => record.errors.push(`计划回执失败：${error.message}`));
      }
    }
  })();
  if (cancelAfterMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, cancelAfterMs));
    await runtime.cancel();
  }
  await consume;
  return record;
}

async function scenario(name, mode, text, options = {}) {
  // 计划审批必须在干净会话里验证：同一会话中刚被否掉的计划会让 Grok 直接用文本作答。
  if (options.newSession) await runtime.createSession({ mode });
  else if (runtime.mode !== mode) await runtime.setMode(mode);
  const before = await digest();
  const record = await runTurn(text, options);
  const after = await digest();
  return {
    name,
    mode,
    workspaceChanged: before !== after,
    stopReason: record.stopReason,
    textLength: record.text.length,
    permissionRequests: record.permissionRequests,
    autoResolved: record.autoResolved,
    plan: record.plan,
    planOutcome: record.planOutcome,
    toolCalls: record.toolCalls,
    errors: record.errors,
  };
}

const initial = await snapshot();
const summary = { workspace, executable, modelId, scenarios: [] };

try {
  const info = await runtime.initialize();
  summary.protocolVersion = info.protocolVersion;
  summary.grokVersion = info.grok.version ?? null;
  summary.grokTested = info.grok.version === TESTED_GROK_VERSION;
  summary.sessionId = await runtime.createSession({ mode: "ask" });

  summary.scenarios.push(await scenario(
    "1. Ask 只读分析",
    "ask",
    "请用中文简要说明当前项目包含哪些文件，不要修改任何文件。",
  ));

  summary.scenarios.push(await scenario(
    "2. Ask 模式拒绝修改",
    "ask",
    "请把 index.html 里的页面标题改成“Ask 模式不应写入”。",
  ));

  summary.scenarios.push(await scenario(
    "3. Plan 放弃计划",
    "plan",
    "请给出把 README.md 增加一节“阶段 D 验证”的实施计划。",
    { onPlan: () => "reject" },
  ));

  summary.scenarios.push(await scenario(
    "4. Plan 批准并执行",
    "plan",
    "请给出在 README.md 末尾追加一行“阶段 D 计划已批准”的实施计划。",
    { newSession: true, onPlan: () => "approve", onPermission: () => "allow_once" },
  ));

  summary.scenarios.push(await scenario(
    "5. Agent 允许修改",
    "agent",
    "直接修改 index.html：把页面可见标题文字改成“灵动 Code 阶段 D”。不要向我提问，直接完成修改。",
    { onPermission: (_event, index) => (index === 0 ? "allow_once" : "allow_session") },
  ));

  summary.scenarios.push(await scenario(
    "6. Agent 拒绝修改",
    "agent",
    "请把 style.css 的 body 背景色改成黑色。",
    // 新会话同时验证第 5 项写入的会话规则已被清空，这里必须重新弹出确认。
    { newSession: true, onPermission: () => "reject" },
  ));

  summary.scenarios.push(await scenario(
    "7. Auto 低风险自动执行",
    "auto",
    "请用中文说明 index.html 当前显示的标题是什么，不要修改文件。",
    { onPermission: () => "reject" },
  ));

  summary.scenarios.push(await scenario(
    "8. 停止任务",
    "agent",
    "请用中文写一篇非常长的项目分析，至少列出一百条；不要修改任何文件。",
    { cancelAfterMs: 1_500, onPermission: () => "reject" },
  ));
} finally {
  const exit = await runtime.dispose();
  summary.shutdown = { code: exit?.code ?? null, expected: exit?.expected ?? null, running: runtime.processRunning };
  summary.outOfTurnEvents = [...new Set(outOfTurn)];
  await restore(initial);
  summary.workspaceRestored = (await digest()) === (await (async () => {
    const hash = createHash("sha256");
    for (const [name, content] of [...initial.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(name);
      hash.update(content);
    }
    return hash.digest("hex");
  })());
}

// 直接检查真实报文：任何时候都不能选择 allow_always 类选项。
const rawLog = await readFile(path.join(logDirectory, "acp-raw.log"), "utf8").catch(() => "");
summary.usedAllowAlways = rawLog
  .split(/\r?\n/)
  .filter((line) => line.includes(" OUT "))
  .some((line) => line.includes("allow-edits-session") || line.includes("allow_always"));
summary.logDirectory = logDirectory;

console.log(JSON.stringify(summary, null, 2));

const byName = Object.fromEntries(summary.scenarios.map((item) => [item.name.slice(0, 2), item]));
const ok = summary.usedAllowAlways === false
  && summary.workspaceRestored === true
  && summary.shutdown?.running === false
  && byName["1."]?.workspaceChanged === false
  && byName["2."]?.workspaceChanged === false
  && byName["3."]?.workspaceChanged === false
  && byName["6."]?.workspaceChanged === false
  && byName["7."]?.workspaceChanged === false
  && byName["8."]?.stopReason === "cancelled";
if (!ok) process.exitCode = 1;
