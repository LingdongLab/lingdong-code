import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { JsonStore } from "../src/storage/json-store";
import {
  EXPIRED_PERMISSION_TEXT,
  MAX_TOOL_OUTPUT_CHARS,
  TRIMMED_HISTORY_TEXT,
  TranscriptRepository,
  sanitizeEntry,
  toRestoreMessages,
  type TranscriptEntry,
} from "../src/storage/transcript-repository";

async function setup(options: { maxEntries?: number } = {}): Promise<{ repo: TranscriptRepository; file: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-transcript-"));
  const file = path.join(directory, "transcript.json");
  const repo = new TranscriptRepository(file, new JsonStore(createNodeFileSystem()), options);
  await repo.open(file);
  return { repo, file };
}

test("用户消息与助手回复落盘后可以读回", async () => {
  const { repo, file } = await setup();
  repo.append({ kind: "user", at: 1, text: "解释一下 index.html", contextLabels: ["index.html"] });
  repo.appendAssistantText("这是", 2);
  repo.appendAssistantText("一个页面", 2);
  repo.append({ kind: "assistantEnd", at: 3, stopReason: "end_turn", modelId: "deepseek-v4-flash" });
  await repo.flush();

  const reopened = new TranscriptRepository(file, new JsonStore(createNodeFileSystem()));
  await reopened.open(file);
  const entries = reopened.entries;
  assert.equal(entries.length, 3);
  assert.equal(entries[1]?.kind, "assistant");
  assert.equal((entries[1] as { text: string }).text, "这是一个页面");
});

test("落盘前脱敏，密钥不进对话记录", () => {
  const entry = sanitizeEntry({ kind: "user", at: 1, text: "用 api_key=sk-abcdefghij1234567890 调接口" });
  assert.ok(!JSON.stringify(entry).includes("sk-abcdefghij1234567890"));
});

test("工具输出截断到 20000 字符", () => {
  const entry = sanitizeEntry({
    kind: "tool",
    at: 1,
    toolCallId: "call-1",
    toolKind: "execute",
    label: "运行命令",
    readOnly: false,
    status: "completed",
    output: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500),
  });
  const output = (entry as { output: string }).output;
  assert.ok(output.length < MAX_TOOL_OUTPUT_CHARS + 100);
  assert.ok(output.includes("已截断"));
});

test("工具状态与输出可以按 toolCallId 追加更新", async () => {
  const { repo } = await setup();
  repo.append({
    kind: "tool",
    at: 1,
    toolCallId: "call-1",
    toolKind: "execute",
    label: "npm test",
    readOnly: false,
    status: "running",
  });
  repo.updateTool("call-1", { output: "第一段" });
  repo.updateTool("call-1", { output: "第二段", status: "completed", exitCode: 0, completedAt: 9 });
  const entry = repo.entries[0] as { output: string; status: string; exitCode: number };
  assert.equal(entry.output, "第一段第二段");
  assert.equal(entry.status, "completed");
  assert.equal(entry.exitCode, 0);
});

test("超过条目上限时丢最旧的并留下省略提示", async () => {
  const { repo } = await setup({ maxEntries: 5 });
  for (let index = 0; index < 20; index += 1) {
    repo.append({ kind: "notice", at: index, level: "info", message: `第 ${index} 条` });
  }
  const entries = repo.entries;
  assert.equal(entries.length, 5);
  assert.equal((entries[0] as { message: string }).message, TRIMMED_HISTORY_TEXT);
  assert.equal((entries.at(-1) as { message: string }).message, "第 19 条");
});

test("未决权限在重启后被标记失效", async () => {
  const { repo } = await setup();
  repo.append({
    kind: "permission",
    at: 1,
    requestId: "42",
    title: "修改 index.html",
    operation: "write",
    risk: "medium",
    decision: "pending",
  });
  assert.equal(repo.expirePendingPermissions(), 1);
  const messages = toRestoreMessages(repo.entries);
  assert.equal(messages.length, 1);
  assert.ok((messages[0] as { message: string }).message.includes(EXPIRED_PERMISSION_TEXT));
});

test("提问条目：回答后更新答案，回放成「问题 → 答案」摘要", async () => {
  const { repo } = await setup();
  repo.append({
    kind: "question",
    at: 1,
    requestId: "88",
    questions: [
      { question: "测试语言？", options: [{ label: "TypeScript" }], multiSelect: false },
      { question: "覆盖场景？", options: [{ label: "单元" }, { label: "集成" }], multiSelect: true },
    ],
    outcome: "pending",
  });
  repo.updateQuestion("88", "answered", ["TypeScript", "单元、集成"]);

  const messages = toRestoreMessages(repo.entries);
  assert.equal(messages.length, 1);
  const text = (messages[0] as { message: string }).message;
  assert.ok(text.includes("已回答"));
  assert.ok(text.includes("测试语言？ → TypeScript"));
  assert.ok(text.includes("覆盖场景？ → 单元、集成"));
});

test("未决提问在重启后标记失效，回放不再出现可交互卡", async () => {
  const { repo } = await setup();
  repo.append({
    kind: "question",
    at: 1,
    requestId: "89",
    questions: [{ question: "选一个？", options: [{ label: "A" }], multiSelect: false }],
    outcome: "pending",
  });
  assert.equal(repo.expirePendingQuestions(), 1);
  assert.equal(repo.expirePendingQuestions(), 0, "已失效的不再重复计数");

  const messages = toRestoreMessages(repo.entries);
  const text = (messages[0] as { message: string }).message;
  assert.ok(text.includes("已因扩展重启而失效"));
  assert.equal(messages[0]?.type, "notice");
});

test("提问条目落盘前脱敏，密钥不进问题与答案", async () => {
  const { repo } = await setup();
  repo.append({
    kind: "question",
    at: 1,
    requestId: "90",
    questions: [{
      question: "用这个 key 吗 sk-abcdefghijklmnopqrstuvwx？",
      options: [{ label: "是", preview: "sk-abcdefghijklmnopqrstuvwx" }],
      multiSelect: false,
    }],
    outcome: "answered",
    answers: ["sk-abcdefghijklmnopqrstuvwx"],
  });
  const raw = JSON.stringify(repo.entries);
  assert.equal(raw.includes("sk-abcdefghijklmnopqrstuvwx"), false, "密钥必须被脱敏");
});

test("恢复时去掉重复落盘的助手正文（ACP 回放曾污染 transcript）", () => {
  const text = "你好！我是 Grok";
  const messages = toRestoreMessages([
    { kind: "user", at: 1, text: "你好啊" },
    { kind: "assistant", at: 2, text },
    { kind: "assistantEnd", at: 3, stopReason: "end_turn" },
    { kind: "activity", at: 4, message: "正在分析项目结构……" },
    { kind: "assistant", at: 5, text },
    { kind: "activity", at: 6, message: "正在分析项目结构……" },
    { kind: "assistant", at: 7, text },
  ]);
  const assistants = messages.filter((message) => message.type === "assistantDelta");
  assert.equal(assistants.length, 1, "同一段助手正文只恢复一次");
  assert.equal((assistants[0] as { text: string }).text, text);
});

test("已决权限保留原来的结论文案", () => {
  const messages = toRestoreMessages([
    {
      kind: "permission",
      at: 1,
      requestId: "7",
      title: "运行 npm test",
      operation: "execute",
      risk: "low",
      decision: "allow_once",
      message: "已允许本次",
    },
  ]);
  assert.equal((messages[0] as { level: string }).level, "info");
  assert.ok((messages[0] as { message: string }).message.includes("已允许本次"));
});

test("恢复消息顺序与类型正确，运行中的工具按失败呈现", () => {
  const entries: TranscriptEntry[] = [
    { kind: "user", at: 1, text: "改标题", contextLabels: ["index.html"] },
    {
      kind: "tool",
      at: 2,
      toolCallId: "call-1",
      toolKind: "edit",
      label: "写入 index.html",
      readOnly: false,
      status: "running",
      output: "diff",
    },
    { kind: "assistant", at: 3, text: "已完成" },
    { kind: "assistantEnd", at: 4, stopReason: "end_turn" },
    { kind: "mode", at: 5, mode: "agent" },
  ];
  const types = toRestoreMessages(entries).map((message) => message.type);
  assert.deepEqual(types, [
    "userMessage",
    "notice",
    "toolStarted",
    "toolOutput",
    "toolStatus",
    "assistantDelta",
    "assistantEnd",
    "mode",
  ]);
  const status = toRestoreMessages(entries).find((message) => message.type === "toolStatus");
  assert.equal((status as { status: string }).status, "failed");
});

test("对话记录损坏时按空历史继续，并上报损坏", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-transcript-"));
  const file = path.join(directory, "transcript.json");
  await writeFile(file, "不是 JSON", "utf8");
  const damages: string[] = [];
  const repo = new TranscriptRepository(file, new JsonStore(createNodeFileSystem()), {
    onDamage: (detail) => damages.push(detail),
  });
  const status = await repo.open(file);
  assert.equal(status, "corrupt");
  assert.deepEqual(repo.entries, []);
  assert.ok(damages[0]?.startsWith("对话记录"));
});

test("切换会话时换文件读入各自的历史", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-transcript-"));
  const store = new JsonStore(createNodeFileSystem());
  const first = path.join(directory, "a.json");
  const second = path.join(directory, "b.json");
  const repo = new TranscriptRepository(first, store);
  await repo.open(first);
  repo.append({ kind: "notice", at: 1, level: "info", message: "会话 A" });
  await repo.open(second);
  assert.deepEqual(repo.entries, []);
  repo.append({ kind: "notice", at: 2, level: "info", message: "会话 B" });
  await repo.open(first);
  assert.equal(JSON.stringify(repo.entries), JSON.stringify([{ kind: "notice", at: 1, level: "info", message: "会话 A" }]));
});
