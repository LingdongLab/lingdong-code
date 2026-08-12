// 打印 Grok Build 在 initialize 里声明的全部 agentCapabilities。
//
// 存在的理由：ACP 里 agent 通过 agentCapabilities.promptCapabilities 声明它能收什么形态的
// prompt（image / audio / embeddedContext）。灵动一直只读了 compact 那几个字段，
// 结果「能不能给模型发图」这种问题只能靠猜。跑一次就有答案。
//
// 用法：node scripts/probe-agent-capabilities.mjs
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentRuntime } from "@lingdong/agent-runtime";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";

const logDirectory = path.join(await mkdtemp(path.join(tmpdir(), "lingdong-probe-")), "logs");
const runtime = createAgentRuntime({
  executable,
  workspace,
  logDirectory,
  grokHome,
  modelId: "deepseek-v4-flash",
  clientInfo: { name: "lingdong-agent", title: "灵动 Agent", version: "0.1.0" },
});

try {
  const info = await runtime.initialize();
  console.log("protocolVersion:", info.protocolVersion);
  console.log("grokVersion:", info.grok.version ?? "unknown");
  console.log("agentInfo:", JSON.stringify(info.agentInfo ?? null));
  console.log("agentCapabilities:");
  console.log(JSON.stringify(info.agentCapabilities ?? null, null, 2));
} finally {
  await runtime.dispose();
}
