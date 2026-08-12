// 端到端验证默认规则是否真的进了 Grok 的系统提示。
//
// 存在的理由：单测只能证明我们把 _meta.rules 发出去了，证明不了 Grok 收下并生效。
// Grok 会把每个会话定稿后的系统提示写到
// <GROK_HOME>/sessions/<编码后的 cwd>/<sessionId>/system_prompt.txt，
// 读它就能确认规则落在 <human_rules> 里——不需要模型可用，也不花一次调用。
//
// 用法：node scripts/probe-rules-injection.mjs
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentRuntime, composePromptRules } from "@lingdong/agent-runtime";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";

/** `<human_rules>` 在系统提示里的相对位置（百分比），只报位置不报内容。 */
function rulesBlockPercent(prompt) {
  const at = prompt.indexOf("<human_rules>");
  return at < 0 ? undefined : Number(((at / prompt.length) * 100).toFixed(1));
}

const logDirectory = path.join(await mkdtemp(path.join(tmpdir(), "lingdong-rules-")), "logs");
const runtime = createAgentRuntime({
  executable,
  workspace,
  logDirectory,
  grokHome,
  modelId: "deepseek-v4-flash",
  clientInfo: { name: "lingdong-agent", title: "灵动 Agent", version: "0.1.0" },
  extraPromptRules: "探针标记：LINGDONG_EXTRA_RULE_OK",
});

const report = {};
try {
  await runtime.initialize();
  const sessionId = await runtime.createSession({ mode: "ask" });
  report.sessionId = sessionId;
  report.injectedLength = runtime.injectedRules.length;

  // Grok 用 URL 编码后的 cwd 作为目录名。
  const sessionDir = path.join(grokHome, "sessions", encodeURIComponent(workspace), sessionId);
  const prompt = await readFile(path.join(sessionDir, "system_prompt.txt"), "utf8");

  const humanRules = /<human_rules>([\s\S]*?)<\/human_rules>/.exec(prompt);
  report.humanRulesBlockFound = humanRules !== null;
  report.localEditRulePresent = prompt.includes("严禁把整个文件");
  report.readBeforeWriteRulePresent = prompt.includes("必须先用 read_file");
  report.chineseRulePresent = prompt.includes("始终用简体中文回复");
  report.identityRulePresent = prompt.includes("不得自称 Grok");
  // 我们那段被追加在末尾，而 Grok 原文开头就声明了「你是 Grok」。这个百分比说明
  // 两句话隔多远——身份没治住时先看它，而不是怀疑规则没发出去。
  report.humanRulesAtPercent = rulesBlockPercent(prompt);
  report.extraRulePresent = prompt.includes("LINGDONG_EXTRA_RULE_OK");
  report.matchesComposed = humanRules?.[1]?.trim() === composePromptRules(undefined, "探针标记：LINGDONG_EXTRA_RULE_OK");
  report.systemPromptBytes = prompt.length;
} catch (error) {
  report.fatal = error instanceof Error ? error.message : String(error);
} finally {
  console.log(JSON.stringify(report, null, 2));
  await runtime.dispose();
}
