// ask_user_question 全链路真实联调：模型提问 → question_requested → respondQuestion → 模型拿到答案继续。
// 用法：设置 LINGDONG_LIVE_KEY（Poe API Key）后 npx tsx scripts/live-ask-question-check.mjs。
// 用临时 GROK_HOME 起一个 Poe 模型，与扩展一致地经过本地净化代理，
// config 里带上与托管配置相同的 ask 超时关闭段。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentRuntime } from "@lingdong/agent-runtime";
import { ModelProxy } from "../src/models/providers/model-proxy";

const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const apiKey = process.env.LINGDONG_LIVE_KEY;
const modelId = process.env.LINGDONG_LIVE_MODEL ?? "claude-opus-4.8";
if (!apiKey) {
  console.error("缺少 LINGDONG_LIVE_KEY（Poe API Key）");
  process.exit(1);
}

const root = await mkdtemp(path.join(tmpdir(), "lingdong-ask-live-"));
const grokHome = path.join(root, "grok-home");
const logDirectory = path.join(root, "logs");
await mkdir(grokHome, { recursive: true });

// 抓包用：把上游响应原文（净化前）落盘，方便定位 Grok 反序列化到底卡在哪个字段。
const capturePath = path.join(root, "upstream-capture.txt");
const { appendFile } = await import("node:fs/promises");
const capturingFetch = async (url, init) => {
  await appendFile(capturePath, `\n===== ${init.method ?? "GET"} ${url}\n`, "utf8");
  const upstream = await fetch(url, init);
  if (!upstream.body) return upstream;
  const [forward, tap] = upstream.body.tee();
  void (async () => {
    const decoder = new TextDecoder();
    for await (const piece of tap) {
      await appendFile(capturePath, decoder.decode(piece, { stream: true }), "utf8");
    }
  })();
  return new Response(forward, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
};

const proxy = new ModelProxy({ log: (line) => console.error(line), fetch: capturingFetch });
await proxy.start();
const baseUrl = proxy.register("https://api.poe.com/v1");
console.error(`capture: ${capturePath}`);

await writeFile(path.join(grokHome, "config.toml"), [
  "[models]",
  `default = "${modelId}"`,
  "",
  `[model."${modelId}"]`,
  `model = "${modelId}"`,
  `base_url = "${baseUrl}"`,
  'name = "Live Ask Check"',
  'env_key = "LINGDONG_LIVE_KEY"',
  'api_backend = "chat_completions"',
  "",
  "[toolset.ask_user_question]",
  "timeout_enabled = false",
  "",
].join("\n"), "utf8");

const runtime = createAgentRuntime({
  executable,
  workspace,
  logDirectory,
  modelId,
  grokHome,
  env: { ...process.env, LINGDONG_LIVE_KEY: apiKey },
  clientInfo: { name: "lingdong-agent", title: "灵动 Agent", version: "0.1.0" },
});

const summary = { logDirectory };
const CHOSEN = "蓝色";

try {
  await runtime.initialize();
  summary.sessionId = await runtime.createSession({ mode: "agent" });

  let questionRequest;
  let requestId;
  let answeredAt = 0;
  let text = "";
  let stopReason = "";

  const prompt = [
    "在回答我之前，你必须先调用内置的 ask_user_question 工具问我一个问题：",
    "「你最喜欢的颜色是什么？」，给出三个选项：红色、蓝色、绿色（单选）。",
    "拿到我的答案后，用中文一句话复述我选了哪个颜色，不要做任何其他事情，不要修改文件。",
  ].join("");

  for await (const event of runtime.sendMessage({ text: prompt })) {
    if (event.type === "question_requested") {
      requestId = event.requestId;
      questionRequest = event.request;
      // 记录真实请求形状后按题回答：每题选第一个匹配 CHOSEN 的选项，找不到就回自由文本。
      const answers = event.request.questions.map((question) => {
        const hit = question.options.find((option) => option.label.includes(CHOSEN));
        return hit ? hit.label : CHOSEN;
      });
      await runtime.respondQuestion(event.requestId, answers);
      answeredAt = Date.now();
    }
    if (event.type === "text_delta") text += event.text;
    if (event.type === "completed") stopReason = event.stopReason;
  }

  summary.question = questionRequest ?? null;
  summary.requestId = requestId ?? null;
  summary.answered = answeredAt > 0;
  summary.stopReason = stopReason;
  summary.finalText = text;
  summary.echoedAnswer = text.includes(CHOSEN);
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  const exit = await runtime.dispose();
  await proxy.stop();
  summary.shutdown = { code: exit?.code ?? null, running: runtime.processRunning };
}

console.log(JSON.stringify(summary, null, 2));

const ok = summary.question
  && summary.answered
  && summary.stopReason === "end_turn"
  && summary.echoedAnswer
  && summary.shutdown?.running === false;
if (!ok) process.exitCode = 1;
