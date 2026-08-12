// 端到端渲染一次 Agent 诊断报告：真实调用 grok inspect --json，再走我们的解析与渲染。
//
// 存在的理由：单测用的是固定样本，证明不了「真实二进制的输出能被我们解析」。
// 上游一改字段名，只有这个脚本会先报警。
//
// 用法：npx tsx scripts/probe-diagnostics.mts
import { composePromptRules } from "@lingdong/agent-runtime";
import { renderAgentDiagnostics } from "../src/diagnostics/agent-diagnostics";
import { runGrokInspect } from "../src/diagnostics/run-grok-inspect";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";

const inspect = await runGrokInspect({ executable, cwd: workspace, grokHome });

console.log(renderAgentDiagnostics({
  ...(inspect.json ? { inspectJson: inspect.json } : {}),
  ...(inspect.error ? { inspectError: inspect.error } : {}),
  injectedRules: composePromptRules(),
  workspaceRoot: workspace,
  grokExecutable: executable,
  grokHome,
}));
