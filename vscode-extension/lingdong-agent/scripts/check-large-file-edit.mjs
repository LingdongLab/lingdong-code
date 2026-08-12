// 阶段 0 验收：改大文件里的一行，量化「是否还在整文件重写」。
//
// 为什么需要客观指标：用户的原始抱怨是「改 47KB 的 models.html 卡了好几分钟」。
// 光看墙钟时间说不清原因——慢可能是模型慢，也可能是它把整份文件重写了一遍。
// 真正的判据是**工具参数的体量**：局部 search_replace 的参数远小于文件本身，
// 整文件重写至少等于文件大小。这里同时量三件事：耗时、参数增量条数、原始流字节数。
//
// 用法：
//   node scripts/check-large-file-edit.mjs              # 带默认规则（治整文件重写）
//   LINGDONG_RULES=off node scripts/check-large-file-edit.mjs   # 关规则，作为对照组
//
// 需要一个可用的模型凭据（DEEPSEEK_API_KEY 或对应 Provider 的 env_key）。
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentRuntime } from "@lingdong/agent-runtime";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const grokHome = process.env.GROK_HOME ?? "E:\\LingdongCode\\grok\\data";
const modelId = process.env.LINGDONG_MODEL ?? "deepseek-v4-flash";
const rulesOff = process.env.LINGDONG_RULES === "off";

/** 目标行的哨兵：改动必须命中它，且文件其余部分必须原样保留。 */
const TARGET_MARKER = "data-lingdong-target";
const OLD_TITLE = "旧标题：待替换";
const NEW_TITLE = "新标题：已替换";

/** 造一个体量接近用户抱怨的那个 models.html（约 47KB）的文件。 */
function buildLargeHtml() {
  const rows = [];
  // 320 行约 47KB，与用户抱怨过的那个 models.html 同量级。
  for (let index = 0; index < 320; index += 1) {
    rows.push(
      `    <tr data-row="${index}">` +
      `<td>模型 ${index}</td>` +
      `<td>提供方 ${index % 7}</td>` +
      `<td>上下文 ${(index % 9 + 1) * 32}K</td>` +
      `<td><button class="act" data-id="${index}">选择</button></td>` +
      "</tr>",
    );
  }
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '  <meta charset="utf-8" />',
    `  <title ${TARGET_MARKER}>${OLD_TITLE}</title>`,
    "</head>",
    "<body>",
    '  <table id="models">',
    "    <tbody>",
    ...rows,
    "    </tbody>",
    "  </table>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

const workspace = await mkdtemp(path.join(tmpdir(), "lingdong-largefile-"));
const logDirectory = path.join(workspace, ".logs");
await mkdir(logDirectory, { recursive: true });

const targetName = "models.html";
const targetPath = path.join(workspace, targetName);
const original = buildLargeHtml();
await writeFile(targetPath, original, "utf8");

const runtime = createAgentRuntime({
  executable,
  workspace,
  logDirectory,
  grokHome,
  modelId,
  clientInfo: { name: "lingdong-agent", title: "灵动 Agent", version: "0.1.0" },
  ...(rulesOff ? { promptRules: "" } : {}),
});

const report = {
  rulesEnabled: !rulesOff,
  fileBytes: Buffer.byteLength(original, "utf8"),
  workspace,
};

try {
  await runtime.initialize();
  await runtime.createSession({ mode: "agent" });
  report.injectedRuleBytes = (runtime.injectedRules ?? "").length;

  let toolProgressEvents = 0;
  const toolsUsed = new Set();
  const startedAt = Date.now();

  for await (const event of runtime.sendMessage({
    text:
      `把 ${targetName} 里 <title> 的文字从「${OLD_TITLE}」改成「${NEW_TITLE}」。` +
      "只改这一处，其余内容一个字都不要动。",
  })) {
    if (event.type === "tool_progress") toolProgressEvents += 1;
    if (event.type === "tool_started") toolsUsed.add(event.name);
    if (event.type === "completed") report.stopReason = event.stopReason;
    if (event.type === "error") report.error = event.message;
  }

  report.wallMs = Date.now() - startedAt;
  // 每条 tool_progress 对应一次工具参数增量。整文件重写时它会涨到几万条。
  report.toolArgumentDeltas = toolProgressEvents;
  report.toolsUsed = [...toolsUsed].sort();

  const updated = await readFile(targetPath, "utf8");
  report.titleReplaced = updated.includes(NEW_TITLE) && !updated.includes(OLD_TITLE);
  // 除了标题那一行，其余必须逐字保持原样。
  const strip = (text) => text.split("\n").filter((line) => !line.includes(TARGET_MARKER)).join("\n");
  report.restOfFileUntouched = strip(updated) === strip(original);

  const rawLog = await stat(runtime.rawLogPath).catch(() => undefined);
  report.acpStreamBytes = rawLog?.size ?? 0;
  // 判据：原始 ACP 流的体量若达到文件大小的数倍，基本可以断定整份内容被写了回去。
  report.streamToFileRatio = Number((report.acpStreamBytes / report.fileBytes).toFixed(2));
  report.verdict = report.toolArgumentDeltas > 2_000 || report.streamToFileRatio > 4
    ? "疑似整文件重写"
    : "局部编辑";
} catch (error) {
  report.fatal = error instanceof Error ? error.message : String(error);
} finally {
  console.log(JSON.stringify(report, null, 2));
  await runtime.dispose();
}
