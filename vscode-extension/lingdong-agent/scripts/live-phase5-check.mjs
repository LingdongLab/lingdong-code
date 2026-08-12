// 阶段 E 真实联调：用与 AgentController 相同的 Runtime 配置、同一套上下文纯函数、
// 同一个 ChangeTracker / SnapshotStore，无头跑完八项场景，结束后把 workspace/grok-test 还原。
// 用法：npm run check:phase5 --workspace lingdong-agent
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TESTED_GROK_VERSION, createAgentRuntime } from "@lingdong/agent-runtime";
import { ChangeTracker } from "../src/change-tracker.ts";
import { toChangeList } from "../src/change-view.ts";
import {
  CONTEXT_LIMITS,
  buildFolderContent,
  composePrompt,
  languageFromPath,
  looksTextual,
  planFolderContext,
  prepareContent,
  selectionLabel,
} from "../src/context-model.ts";
import { planDiff } from "../src/diff-model.ts";
import { createNodeFileSystem } from "../src/file-system-port.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";

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

async function snapshotWorkspace() {
  const files = new Map();
  for (const name of await listFiles()) files.set(name, await readFile(path.join(workspace, name)));
  return files;
}

function digestOf(files) {
  const hash = createHash("sha256");
  for (const [name, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function digest() {
  return digestOf(await snapshotWorkspace());
}

async function restore(initial) {
  for (const [name, content] of initial) await writeFile(path.join(workspace, name), content);
  for (const name of await listFiles()) {
    if (!initial.has(name)) await rm(path.join(workspace, name), { force: true });
  }
}

function contextItem(input) {
  const prepared = prepareContent(input.raw, input.limit);
  return {
    id: `ctx-${createHash("sha1").update(input.label).digest("hex").slice(0, 12)}`,
    type: input.type,
    label: input.label,
    workspaceRelativePath: input.workspaceRelativePath,
    languageId: input.languageId,
    content: prepared.content,
    ...(input.lineRange ? { lineRange: input.lineRange } : {}),
    createdAt: Date.now(),
    truncated: prepared.truncated,
    size: prepared.content.length,
  };
}

async function fileContext(relativePath) {
  const raw = await readFile(path.join(workspace, relativePath), "utf8");
  return contextItem({
    type: "file",
    label: relativePath,
    workspaceRelativePath: relativePath,
    languageId: languageFromPath(relativePath),
    raw,
    limit: CONTEXT_LIMITS.fileBytes,
  });
}

async function selectionContext(relativePath, startLine, endLine) {
  const lines = (await readFile(path.join(workspace, relativePath), "utf8")).split(/\r?\n/);
  const range = { start: startLine, end: Math.min(endLine, lines.length) };
  return contextItem({
    type: "selection",
    label: selectionLabel(relativePath, range),
    workspaceRelativePath: relativePath,
    languageId: languageFromPath(relativePath),
    raw: lines.slice(range.start - 1, range.end).join("\n"),
    limit: CONTEXT_LIMITS.selectionChars,
    lineRange: range,
  });
}

/** 与 ContextService.pickFolder 相同的候选筛选与正文拼装，只是把 VS Code API 换成 node fs。 */
async function folderContext() {
  const candidates = [];
  for (const name of await listFiles()) {
    const info = await stat(path.join(workspace, name));
    candidates.push({ relativePath: name, size: info.size, isText: looksTextual(name) });
  }
  const plan = planFolderContext(candidates);
  const files = [];
  for (const entry of plan.included) {
    files.push({
      relativePath: entry.relativePath,
      content: await readFile(path.join(workspace, entry.relativePath), "utf8"),
    });
  }
  const content = buildFolderContent({
    relativePath: "",
    tree: candidates.map((candidate) => candidate.relativePath),
    files,
    listedOnly: plan.listedOnly,
    truncated: plan.truncated,
  });
  return {
    item: contextItem({
      type: "folder",
      label: "工作区根目录",
      workspaceRelativePath: "",
      languageId: "plaintext",
      raw: content,
      limit: CONTEXT_LIMITS.folderChars,
    }),
    plan: {
      included: plan.included.length,
      listedOnly: plan.listedOnly.length,
      estimatedChars: plan.estimatedChars,
      truncated: plan.truncated,
    },
  };
}

const logDirectory = path.join(await mkdtemp(path.join(tmpdir(), "lingdong-phase5-")), "logs");
const storageRoot = await mkdtemp(path.join(tmpdir(), "lingdong-snap-"));
const fs = createNodeFileSystem();
const snapshots = new SnapshotStore(path.join(storageRoot, "agent-snapshots"), workspace, fs);
const tracker = new ChangeTracker({ workspaceRoot: workspace, fs, snapshots });
const guardFailures = [];

const runtime = createAgentRuntime({
  executable,
  workspace,
  logDirectory,
  modelId,
  grokHome,
  clientInfo: { name: "lingdong-agent", title: "灵动 Agent", version: "0.1.0" },
  // 与扩展完全一致：写入类操作放行前先由宿主保存修改前快照，失败即拒绝。
  beforeWrite: async (input) => {
    try {
      await tracker.prepare(input.decision.targets);
      return { ok: true };
    } catch (error) {
      guardFailures.push(error.message);
      return { ok: false, reason: error.message };
    }
  },
});

async function runTurn(text, { contextItems = [], onPermission = () => "reject" } = {}) {
  const record = { text: "", stopReason: "", permissions: [], errors: [] };
  tracker.startTurn({
    sessionId: runtime.sessionId ?? "unknown",
    mode: runtime.mode,
    prompt: text,
    contextLabels: contextItems.map((item) => item.label),
  });
  const changedQueue = [];
  for await (const event of runtime.sendMessage({ text: composePrompt(text, contextItems) })) {
    if (event.type === "text_delta") record.text += event.text;
    if (event.type === "error") record.errors.push(event.message);
    if (event.type === "completed") record.stopReason = event.stopReason;
    if (event.type === "file_changed") changedQueue.push(event.path);
    if (event.type === "permission_requested") {
      const decision = onPermission(event, record.permissions.length);
      record.permissions.push({
        operation: event.decision.operation,
        risk: event.decision.risk,
        decision,
      });
      await runtime.respondPermission(event.requestId, decision).catch((error) => {
        record.errors.push(`权限回执失败：${error.message}`);
      });
    }
  }
  for (const target of changedQueue) await tracker.noteChanged(target);
  const turn = await tracker.finalize(record.stopReason === "cancelled" ? "cancelled" : "completed");
  return { ...record, turn, view: turn ? toChangeList(turn) : null };
}

async function ensureMode(mode, { newSession = false } = {}) {
  if (newSession) await runtime.createSession({ mode });
  else if (runtime.mode !== mode) await runtime.setMode(mode);
}

const initial = await snapshotWorkspace();
const initialDigest = digestOf(initial);
const summary = { workspace, executable, modelId, snapshotRoot: snapshots.baseDirectory, scenarios: [] };

function record(name, data) {
  summary.scenarios.push({ name, ...data });
  console.error(`[phase5] ${name} 完成`);
}

try {
  const info = await runtime.initialize();
  summary.protocolVersion = info.protocolVersion;
  summary.grokVersion = info.grok.version ?? null;
  summary.grokTested = info.grok.version === TESTED_GROK_VERSION;
  summary.sessionId = await runtime.createSession({ mode: "ask" });

  // 场景一：当前文件上下文
  {
    const item = await fileContext("index.html");
    await ensureMode("ask");
    const before = await digest();
    const turn = await runTurn("解释当前文件的页面结构，不要修改。", { contextItems: [item] });
    record("1. 当前文件上下文", {
      contextLabel: item.label,
      contextSize: item.size,
      truncated: item.truncated,
      workspaceChanged: before !== (await digest()),
      mentionsFile: /index\.html/i.test(turn.text),
      mentionsStructure: /(标题|结构|body|head|div|section)/i.test(turn.text),
      textLength: turn.text.length,
      stopReason: turn.stopReason,
      errors: turn.errors,
    });
  }

  // 场景二：选中代码
  {
    const item = await selectionContext("index.html", 1, 20);
    await ensureMode("ask");
    const before = await digest();
    const turn = await runTurn("说明这段代码的作用，并给出优化建议，不要修改。", { contextItems: [item] });
    record("2. 选中代码上下文", {
      contextLabel: item.label,
      lineRange: item.lineRange,
      workspaceChanged: before !== (await digest()),
      textLength: turn.text.length,
      hasSuggestion: /(建议|优化|可以)/.test(turn.text),
      stopReason: turn.stopReason,
      errors: turn.errors,
    });
  }

  // 场景三：Agent 修改与 Diff 参数
  let modifyTurnId = null;
  {
    await ensureMode("agent", { newSession: true });
    const originalTitle = await readFile(path.join(workspace, "index.html"), "utf8");
    const turn = await runTurn(
      "直接修改 index.html：把首页可见标题文字改成“灵动 Code Diff 测试”。不要向我提问，直接完成修改。",
      { onPermission: () => "allow_once" },
    );
    modifyTurnId = turn.turn?.turnId ?? null;
    const change = turn.turn?.changedFiles[0];
    const diff = change ? planDiff(change, turn.turn.index) : null;
    const snapshotText = change ? await tracker.snapshotText(turn.turn.turnId, change.relativePath) : "";
    record("3. Agent 修改与 Diff", {
      changedFiles: turn.view?.rows.map((row) => `${row.letter} ${row.relativePath}`) ?? [],
      title: turn.view?.title,
      kind: change?.kind ?? null,
      restorable: change?.restorable ?? false,
      snapshotMatchesOriginal: snapshotText === originalTitle,
      currentDiffers: change ? change.beforeSha256 !== change.afterSha256 : false,
      diffLeft: diff?.left ?? null,
      diffRightKind: diff?.right.kind ?? null,
      diffTitle: diff?.title ?? null,
      permissions: turn.permissions,
      stopReason: turn.stopReason,
      errors: turn.errors,
    });
  }

  // 场景四：拒绝单个文件
  {
    const change = modifyTurnId ? tracker.turn(modifyTurnId)?.changedFiles[0] : undefined;
    const outcome = change ? await tracker.reject(change.id) : null;
    const current = await readFile(path.join(workspace, "index.html"), "utf8");
    record("4. 拒绝单个文件", {
      outcome,
      status: change?.status ?? null,
      restoredToOriginal: current === initial.get("index.html")?.toString("utf8"),
      view: modifyTurnId ? toChangeList(tracker.turn(modifyTurnId)) : null,
    });
  }

  // 场景五：多文件修改，一个接受一个拒绝
  {
    await ensureMode("agent", { newSession: true });
    const turn = await runTurn(
      "直接修改两个文件：把 index.html 的可见标题改成“灵动 Code 多文件测试”，并在 style.css 末尾追加一条 body { padding: 24px; } 规则。不要向我提问，直接完成两个文件的修改。",
      { onPermission: () => "allow_once" },
    );
    const files = turn.turn?.changedFiles ?? [];
    const accepted = files[0] ? await tracker.accept(files[0].id) : undefined;
    const rejected = files[1] ? await tracker.reject(files[1].id) : undefined;
    const contents = {};
    for (const change of files) {
      contents[change.relativePath] = await readFile(change.absolutePath, "utf8").catch(() => null);
    }
    record("5. 多文件修改与逐个处理", {
      changedFiles: turn.view?.rows.map((row) => `${row.letter} ${row.relativePath}`) ?? [],
      count: files.length,
      acceptedFile: accepted?.relativePath ?? null,
      acceptedStatus: accepted?.status ?? null,
      rejectedFile: files[1]?.relativePath ?? null,
      rejectOutcome: rejected ?? null,
      rejectedRestored: files[1]
        ? contents[files[1].relativePath] === initial.get(files[1].relativePath)?.toString("utf8")
        : null,
      diffTitles: files.map((change) => planDiff(change, turn.turn.index).title),
      permissions: turn.permissions,
      stopReason: turn.stopReason,
      errors: turn.errors,
    });
  }

  // 场景六：撤销本轮
  {
    await ensureMode("agent", { newSession: true });
    // 场景五已经明确接受了一个文件，所以这里比对的是「本轮开始前」的状态，不是最初状态。
    const beforeTurn = await digest();
    const turn = await runTurn(
      "直接修改 index.html 与 style.css：标题改成“灵动 Code 撤销测试”，并给 style.css 追加一条 body { line-height: 1.8; }。不要向我提问，直接完成修改。",
      { onPermission: () => "allow_once" },
    );
    const first = turn.turn ? await tracker.undoTurn(turn.turn.turnId) : null;
    const second = turn.turn ? await tracker.undoTurn(turn.turn.turnId) : null;
    record("6. 撤销本轮", {
      changedFiles: turn.view?.rows.map((row) => `${row.letter} ${row.relativePath}`) ?? [],
      firstUndo: first,
      secondUndo: second,
      idempotent: second?.restored === 0,
      workspaceBackToTurnStart: (await digest()) === beforeTurn,
      turnStatus: turn.turn ? tracker.turn(turn.turn.turnId)?.status : null,
      stopReason: turn.stopReason,
      errors: turn.errors,
    });
  }

  // 场景七：外部修改冲突
  {
    await ensureMode("agent", { newSession: true });
    const turn = await runTurn(
      "直接修改 index.html：把首页可见标题改成“灵动 Code 冲突测试”。不要向我提问，直接完成修改。",
      { onPermission: () => "allow_once" },
    );
    const change = turn.turn?.changedFiles[0];
    const manual = "<!-- 用户在 Agent 之后的手工改动 -->\n";
    if (change) await writeFile(change.absolutePath, manual + (await readFile(change.absolutePath, "utf8")), "utf8");
    const outcome = change ? await tracker.reject(change.id) : null;
    const current = change ? await readFile(change.absolutePath, "utf8") : "";
    record("7. 外部修改冲突", {
      changedFiles: turn.view?.rows.map((row) => `${row.letter} ${row.relativePath}`) ?? [],
      outcome,
      status: change?.status ?? null,
      keptUserEdit: current.startsWith(manual),
      view: turn.turn ? toChangeList(tracker.turn(turn.turn.turnId)) : null,
      stopReason: turn.stopReason,
      errors: turn.errors,
    });
    // 冲突场景故意留下用户改动，这里手工还原，避免影响场景八的目录上下文。
    if (change) await writeFile(change.absolutePath, initial.get(change.relativePath) ?? Buffer.from(""));
  }

  // 场景八：文件夹上下文
  {
    const folder = await folderContext();
    await ensureMode("ask", { newSession: true });
    const before = await digest();
    const turn = await runTurn("总结该目录结构和各文件作用，不要修改。", { contextItems: [folder.item] });
    record("8. 文件夹上下文", {
      plan: folder.plan,
      contextSize: folder.item.size,
      truncated: folder.item.truncated,
      withinLimits: folder.plan.included <= CONTEXT_LIMITS.folderFiles
        && folder.item.size <= CONTEXT_LIMITS.folderChars,
      workspaceChanged: before !== (await digest()),
      mentionsFiles: ["index.html", "style.css", "README.md"].filter((name) => turn.text.includes(name)),
      textLength: turn.text.length,
      stopReason: turn.stopReason,
      errors: turn.errors,
    });
  }
} finally {
  const exit = await runtime.dispose();
  summary.shutdown = { code: exit?.code ?? null, running: runtime.processRunning };
  summary.guardFailures = guardFailures;
  await restore(initial);
  summary.workspaceRestored = (await digest()) === initialDigest;
  summary.logDirectory = logDirectory;
}

const json = JSON.stringify(summary, null, 2);
console.log(json);
// PowerShell 重定向会破坏中文，结果另存一份 UTF-8 文件供报告引用。
const resultFile = path.join(import.meta.dirname, "..", "docs", "phase-5-live-result.json");
await writeFile(resultFile, `${json}\n`, "utf8");

const byIndex = Object.fromEntries(summary.scenarios.map((item) => [item.name.slice(0, 2), item]));
const ok = summary.workspaceRestored === true
  && summary.shutdown?.running === false
  && byIndex["1."]?.workspaceChanged === false
  && byIndex["2."]?.workspaceChanged === false
  && byIndex["3."]?.snapshotMatchesOriginal === true
  && byIndex["4."]?.outcome?.status === "restored"
  && byIndex["6."]?.idempotent === true
  && byIndex["6."]?.workspaceBackToTurnStart === true
  && byIndex["7."]?.outcome?.status === "conflict"
  && byIndex["7."]?.keptUserEdit === true
  && byIndex["8."]?.withinLimits === true;
if (!ok) process.exitCode = 1;
