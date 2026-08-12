// 阶段 F 真实联调：会话持久化、session/load、Plan/变更恢复、损坏恢复、用量与压缩能力。
// 用法：npm run check:phase6 --workspace lingdong-agent
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TESTED_GROK_VERSION, createAgentRuntime } from "@lingdong/agent-runtime";
import { ChangeTracker } from "../src/change-tracker.ts";
import { ContextUsageService } from "../src/context-usage.ts";
import { createNodeFileSystem } from "../src/file-system-port.ts";
import { generateSessionTitle } from "../src/session-title.ts";
import { SessionPersistence } from "../src/session-persistence.ts";
import { SnapshotStore } from "../src/snapshot-store.ts";
import { JsonStore } from "../src/storage/json-store.ts";
import { toRestoreMessages } from "../src/storage/transcript-repository.ts";
import { toPersistedTurn } from "../src/storage/turn-repository.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(__dirname, "..", "docs");
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

async function restore(initial) {
  for (const [name, content] of initial) await writeFile(path.join(workspace, name), content);
  for (const name of await listFiles()) {
    if (!initial.has(name)) await rm(path.join(workspace, name), { force: true });
  }
}

const logDirectory = path.join(await mkdtemp(path.join(tmpdir(), "lingdong-phase6-")), "logs");
const storageRoot = await mkdtemp(path.join(tmpdir(), "lingdong-sess-"));
const fs = createNodeFileSystem();
const snapshots = new SnapshotStore(path.join(storageRoot, "agent-snapshots"), workspace, fs);
const tracker = new ChangeTracker({ workspaceRoot: workspace, fs, snapshots });
const persistence = new SessionPersistence({
  globalStorageRoot: storageRoot,
  workspaceRoot: workspace,
  fs,
  onDamage: (detail) => console.error(`[storage] ${detail}`),
});
const usage = new ContextUsageService({ contextLimit: 1_000_000 });

const runtime = createAgentRuntime({
  executable,
  workspace,
  logDirectory,
  modelId,
  grokHome,
  clientInfo: { name: "lingdong-agent", title: "灵动 Agent", version: "0.1.0" },
  beforeWrite: async (input) => {
    try {
      await tracker.prepare(input.decision.targets);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
});

async function runTurn(text, { onPermission = () => "reject", mode } = {}) {
  if (mode && runtime.mode !== mode) await runtime.setMode(mode);
  const record = { text: "", stopReason: "", permissions: [], errors: [], usage: null };
  tracker.startTurn({
    sessionId: runtime.sessionId ?? "unknown",
    mode: runtime.mode,
    prompt: text,
    contextLabels: [],
  });
  const changedQueue = [];
  for await (const event of runtime.sendMessage({ text })) {
    if (event.type === "text_delta") record.text += event.text;
    if (event.type === "error") record.errors.push(event.message);
    if (event.type === "completed") record.stopReason = event.stopReason;
    if (event.type === "file_changed") changedQueue.push(event.path);
    if (event.type === "token_usage" && event.source === "exact") {
      record.usage = event;
      usage.recordExact(event);
    }
    if (event.type === "permission_requested") {
      const decision = onPermission(event);
      record.permissions.push({ operation: event.decision.operation, risk: event.decision.risk, decision });
      await runtime.respondPermission(event.requestId, decision).catch((error) => {
        record.errors.push(`权限回执失败：${error.message}`);
      });
    }
    if (event.type === "plan_review_requested") {
      record.plan = event.plan;
      await runtime.rejectPlan().catch(() => undefined);
    }
  }
  for (const target of changedQueue) await tracker.noteChanged(target);
  const turn = await tracker.finalize(record.stopReason === "cancelled" ? "cancelled" : "completed");
  return { ...record, turn };
}

const initial = await snapshotWorkspace();
const summary = {
  workspace,
  executable,
  modelId,
  storageRoot,
  scenarios: [],
};

function record(name, data) {
  summary.scenarios.push({ name, ...data });
  console.error(`[phase6] ${name} 完成`);
}

try {
  const info = await runtime.initialize();
  summary.protocolVersion = info.protocolVersion;
  summary.grokVersion = info.grok.version ?? null;
  summary.grokTested = info.grok.version === TESTED_GROK_VERSION;
  summary.agentCapabilities = info.agentCapabilities ?? null;

  // 场景一：会话恢复（本地落盘 + 读回）
  {
    const grokSessionId = await runtime.createSession({ mode: "ask" });
    const session = await persistence.sessions.create({
      modelId,
      localMode: "ask",
      grokSessionId,
    });
    await persistence.openSessionFiles(session.id);
    const prompt = "用一句话说明这个工作区是做什么的，不要修改任何文件。";
    persistence.transcript.append({ kind: "user", at: Date.now(), text: prompt });
    const turn = await runTurn(prompt);
    persistence.transcript.appendAssistantText(turn.text, Date.now());
    persistence.transcript.append({ kind: "assistantEnd", at: Date.now(), stopReason: turn.stopReason || "end_turn" });
    await persistence.sessions.applyAutoTitle(session.id, prompt);
    await persistence.sessions.patch(session.id, {
      messageCount: 1,
      turnCount: 1,
      lastSummary: prompt.slice(0, 80),
      contextUsage: usage.current,
    });
    await persistence.flush();

    // 模拟重启：新仓库读同一目录
    const reloaded = new SessionPersistence({ globalStorageRoot: storageRoot, workspaceRoot: workspace, fs });
    const loaded = await reloaded.sessions.load(session.id);
    await reloaded.openSessionFiles(session.id);
    const messages = toRestoreMessages(reloaded.transcript.entries);
    record("1. 会话恢复", {
      sessionId: session.id,
      grokSessionId,
      title: loaded?.title,
      expectedTitleHint: generateSessionTitle(prompt),
      messageCount: loaded?.messageCount,
      restoredMessages: messages.map((message) => message.type),
      hasUser: messages.some((message) => message.type === "userMessage"),
      hasAssistant: messages.some((message) => message.type === "assistantDelta"),
      mode: loaded?.localMode,
      modelId: loaded?.modelId,
      stopReason: turn.stopReason,
      errors: turn.errors,
    });
    summary.primarySessionId = session.id;
    summary.primaryGrokSessionId = grokSessionId;
  }

  // 场景二：底层 session/load 续聊
  {
    const grokSessionId = summary.primaryGrokSessionId;
    await runtime.loadSession(grokSessionId, workspace, "ask");
    const follow = await runTurn("继续刚才的分析，再补充一点要点，不要修改文件。");
    record("2. 底层 session/load", {
      loadedSessionId: runtime.sessionId,
      matches: runtime.sessionId === grokSessionId,
      followTextLength: follow.text.length,
      continuesContext: follow.text.length > 20,
      stopReason: follow.stopReason,
      tokenUsage: follow.usage,
      errors: follow.errors,
    });
  }

  // 场景三：Plan 恢复（生成计划后放弃执行，落盘再读回）
  {
    await runtime.createSession({ mode: "plan" });
    const session = await persistence.sessions.create({
      modelId,
      localMode: "plan",
      grokSessionId: runtime.sessionId ?? undefined,
    });
    await persistence.openSessionFiles(session.id);
    let planCard = null;
    const recordTurn = { text: "", errors: [], stopReason: "" };
    for await (const event of runtime.sendMessage({
      text: "请制定一个把首页标题改成“计划恢复测试”的实施计划，先不要修改文件。",
    })) {
      if (event.type === "text_delta") recordTurn.text += event.text;
      if (event.type === "error") recordTurn.errors.push(event.message);
      if (event.type === "completed") recordTurn.stopReason = event.stopReason;
      if (event.type === "plan_review_requested") {
        planCard = event.plan;
        const created = persistence.plans.createFromCard(session.id, {
          title: event.plan.title,
          steps: event.plan.steps.map((step) => ({
            index: step.index,
            title: step.title,
            ...(step.detail ? { detail: step.detail } : {}),
            files: step.files ?? [],
          })),
          files: event.plan.files ?? [],
          risks: event.plan.risks ?? [],
          status: "ready",
          canApprove: true,
          ...(event.plan.raw ? { raw: event.plan.raw } : {}),
        }, "waiting_review");
        persistence.plans.upsert(created);
        persistence.transcript.append({
          kind: "plan",
          at: Date.now(),
          plan: {
            title: created.title,
            steps: created.steps.map((step) => ({
              index: step.order,
              title: step.title,
              files: step.files,
              ...(step.description ? { detail: step.description } : {}),
            })),
            files: created.files,
            risks: created.risks,
            status: "ready",
            canApprove: true,
          },
          status: "ready",
        });
        await runtime.rejectPlan().catch(() => undefined);
      }
    }
    await persistence.flush();
    const reloaded = new SessionPersistence({ globalStorageRoot: storageRoot, workspaceRoot: workspace, fs });
    await reloaded.openSessionFiles(session.id);
    const active = reloaded.plans.plans[0];
    record("3. Plan 恢复", {
      gotPlan: planCard !== null,
      persisted: active !== undefined,
      title: active?.title ?? null,
      steps: active?.steps.length ?? 0,
      status: active?.status ?? null,
      restoreKinds: toRestoreMessages(reloaded.transcript.entries).map((message) => message.type),
      errors: recordTurn.errors,
    });
  }

  // 场景四：未处理变更恢复
  {
    await runtime.createSession({ mode: "agent" });
    const session = await persistence.sessions.create({
      modelId,
      localMode: "agent",
      grokSessionId: runtime.sessionId ?? undefined,
    });
    await persistence.openSessionFiles(session.id);
    const turn = await runTurn(
      "直接修改 index.html：把可见标题改成“灵动 Code 持久化变更测试”。不要提问，直接改。",
      { mode: "agent", onPermission: () => "allow_once" },
    );
    if (turn.turn) {
      persistence.turns.upsert(toPersistedTurn(turn.turn, { completedAt: Date.now(), stopReason: turn.stopReason }));
      await persistence.sessions.patch(session.id, {
        lastTurnId: turn.turn.turnId,
        pendingChanges: turn.turn.changedFiles.filter((change) => change.status === "pending").length,
      });
    }
    await persistence.flush();

    const snaps2 = new SnapshotStore(path.join(storageRoot, "agent-snapshots"), workspace, fs);
    const tracker2 = new ChangeTracker({ workspaceRoot: workspace, fs, snapshots: snaps2 });
    await snaps2.hydrate();
    const reloaded = new SessionPersistence({ globalStorageRoot: storageRoot, workspaceRoot: workspace, fs });
    const loaded = await reloaded.sessions.load(session.id);
    await reloaded.openSessionFiles(session.id);
    tracker2.rehydrate(reloaded.turns.turns);
    await tracker2.reevaluate();
    const change = tracker2.turns.at(-1)?.changedFiles[0];
    const reject = change ? await tracker2.reject(change.id) : null;
    record("4. 未处理变更恢复", {
      sessionId: session.id,
      pendingBefore: loaded?.pendingChanges,
      restoredCount: tracker2.turns.at(-1)?.changedFiles.length ?? 0,
      changeStatusAfterReject: change?.status ?? null,
      rejectOutcome: reject,
      snapshotReadable: change
        ? (await snaps2.read(change.turnId, change.relativePath)) !== undefined || change.kind === "create"
        : false,
      errors: turn.errors,
    });
  }

  // 场景五：冲突恢复
  {
    await restore(initial);
    await runtime.createSession({ mode: "agent" });
    const turn = await runTurn(
      "直接修改 index.html：把可见标题改成“冲突恢复测试”。不要提问，直接改。",
      { mode: "agent", onPermission: () => "allow_once" },
    );
    const change = turn.turn?.changedFiles[0];
    if (change) {
      await writeFile(change.absolutePath, `${await readFile(change.absolutePath, "utf8")}\n<!-- user edit -->\n`, "utf8");
    }
    const session = await persistence.sessions.create({
      modelId,
      localMode: "agent",
      grokSessionId: runtime.sessionId ?? undefined,
    });
    await persistence.openSessionFiles(session.id);
    if (turn.turn) persistence.turns.upsert(toPersistedTurn(turn.turn));
    await persistence.flush();

    const snaps2 = new SnapshotStore(path.join(storageRoot, "agent-snapshots"), workspace, fs);
    const tracker2 = new ChangeTracker({ workspaceRoot: workspace, fs, snapshots: snaps2 });
    await snaps2.hydrate();
    const reloaded = new SessionPersistence({ globalStorageRoot: storageRoot, workspaceRoot: workspace, fs });
    await reloaded.openSessionFiles(session.id);
    tracker2.rehydrate(reloaded.turns.turns);
    const affected = await tracker2.reevaluate();
    const conflict = affected.at(-1)?.changedFiles.find((entry) => entry.status === "conflict");
    const current = await readFile(path.join(workspace, "index.html"), "utf8");
    record("5. 冲突恢复", {
      conflictDetected: conflict !== undefined,
      conflictReason: conflict?.conflictReason ?? null,
      userContentPreserved: current.includes("user edit"),
      errors: turn.errors,
    });
  }

  // 场景六：工作区隔离
  {
    const otherRoot = await mkdtemp(path.join(tmpdir(), "lingdong-ws2-"));
    await writeFile(path.join(otherRoot, "readme.txt"), "other workspace\n", "utf8");
    const a = new SessionPersistence({ globalStorageRoot: storageRoot, workspaceRoot: workspace, fs });
    const b = new SessionPersistence({ globalStorageRoot: storageRoot, workspaceRoot: otherRoot, fs });
    await a.sessions.create({ modelId, localMode: "ask", title: "工作区A会话" });
    await b.sessions.create({ modelId, localMode: "ask", title: "工作区B会话" });
    const listA = await a.sessions.list();
    const listB = await b.sessions.list();
    record("6. 工作区隔离", {
      workspaceA: a.workspaceId,
      workspaceB: b.workspaceId,
      differentIds: a.workspaceId !== b.workspaceId,
      titlesA: listA.map((item) => item.title),
      titlesB: listB.map((item) => item.title),
      noCross: !listA.some((item) => item.title === "工作区B会话")
        && !listB.some((item) => item.title === "工作区A会话"),
    });
    await rm(otherRoot, { recursive: true, force: true });
  }

  // 场景七：损坏恢复（先写两版形成 .bak，再破坏主文件）
  {
    const store = new JsonStore(fs);
    const file = path.join(storageRoot, "corrupt-demo.json");
    const sample = {
      id: "ok",
      workspaceId: "x",
      title: "完好备份",
      titleSource: "manual",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      modelId,
      localMode: "ask",
      status: "active",
      archived: false,
      pinned: false,
      messageCount: 0,
      turnCount: 0,
      pendingChanges: 0,
      conflictChanges: 0,
      hasUnfinishedPlan: false,
      schemaVersion: 1,
    };
    await store.write(file, "session", sample);
    await store.write(file, "session", { ...sample, title: "完好备份-v2" });
    await writeFile(file, "{ not json", "utf8");
    const result = await store.read(file, {
      kind: "session",
      fallback: () => null,
      validate: (data) => (data && typeof data === "object" && "id" in data ? data : undefined),
    });
    record("7. 损坏恢复", {
      status: result.status,
      recoveredTitle: result.data?.title ?? null,
      detail: result.detail ?? null,
      archived: result.archived ?? null,
      hostWouldSurvive: result.status === "recovered" || result.status === "corrupt",
    });
  }

  // 场景八：上下文与压缩能力
  {
    let compactCapability = runtime.compactCapability;
    try {
      compactCapability = await runtime.probeCompact();
    } catch (error) {
      compactCapability = "unavailable";
      summary.compactProbeError = error instanceof Error ? error.message : String(error);
    }
    usage.setCompactionCapability(compactCapability);
    record("8. 上下文与压缩能力", {
      exactUsageSeen: summary.scenarios.some((item) => item.tokenUsage),
      currentUsage: usage.current,
      usageSource: usage.current.source,
      contextLimit: usage.current.contextLimit,
      compactCapability,
      autoCompactNote: "Grok 0.2.118 内置 auto_compact_threshold_percent=85，ACP 客户端无需触发",
      manualCompactViaSlash: false,
      agentCapabilitiesKeys: info.agentCapabilities ? Object.keys(info.agentCapabilities) : [],
    });
  }
} catch (error) {
  summary.fatal = error instanceof Error ? error.message : String(error);
  console.error(error);
} finally {
  try {
    await runtime.dispose();
  } catch {
    // ignore
  }
  await restore(initial);
  await writeFile(path.join(docsDir, "phase-6-live-result.json"), `${JSON.stringify(summary, undefined, 2)}\n`, "utf8");
  console.error(`[phase6] 结果已写入 ${path.join(docsDir, "phase-6-live-result.json")}`);
}
