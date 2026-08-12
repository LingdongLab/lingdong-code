import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentPlan, AgentRuntimeHandle } from "@lingdong/agent-runtime";
import { createNodeFileSystem } from "../src/file-system-port";
import type { HostToWebviewMessage } from "../src/messages";
import {
  compileStepPrompt,
  nextStep,
  planFinished,
  planGateAction,
  runnableSteps,
  stepOutcome,
  stepProgress,
} from "../src/plan-gate";
import { PlanFacade, type PlanFacadeDeps } from "../src/services/plan-facade";
import { createTurnState } from "../src/services/turn-state";
import { JsonStore } from "../src/storage/json-store";
import { PlanRepository, type PlanRecord, type PlanStepStatus } from "../src/storage/plan-repository";
import { UiStateMachine } from "../src/ui-state";

/** 只关心步骤，其余字段给到能过校验即可。 */
function plan(statuses: PlanStepStatus[], overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: "plan-1",
    sessionId: "ses-1",
    version: 1,
    title: "登录系统改造",
    steps: statuses.map((status, index) => ({
      id: `s${index + 1}`,
      order: index,
      title: `第${index + 1}件事`,
      files: [`src/step${index + 1}.ts`],
      status,
    })),
    files: [],
    risks: [],
    status: "executing",
    createdAt: 0,
    updatedAt: 0,
    source: "grok",
    ...overrides,
  };
}

test("跳过与取消的步骤不参与执行", () => {
  const record = plan(["completed", "skipped", "cancelled", "pending"]);
  assert.deepEqual(runnableSteps(record).map((s) => s.id), ["s1", "s4"]);
});

test("下一步取第一个未完成的", () => {
  assert.equal(nextStep(plan(["completed", "pending", "pending"]))?.id, "s2");
});

test("上一轮没走完的 in_progress 优先，不跳过去做下一步", () => {
  assert.equal(nextStep(plan(["completed", "in_progress", "pending"]))?.id, "s2");
});

test("失败的步骤会被重新下发，而不是被跳过", () => {
  const step = nextStep(plan(["failed", "pending"]));
  assert.equal(step?.id, "s1");
});

test("全部完成后没有下一步", () => {
  const record = plan(["completed", "completed"]);
  assert.equal(nextStep(record), undefined);
  assert.equal(planFinished(record), true);
});

test("被跳过的步骤不影响「已全部完成」的判定", () => {
  assert.equal(planFinished(plan(["completed", "skipped"])), true);
});

test("一个可执行步骤都没有时不算完成", () => {
  assert.equal(planFinished(plan(["skipped", "cancelled"])), false);
});

test("进度按可执行步骤算，跳过的不占位", () => {
  const record = plan(["completed", "skipped", "pending"]);
  const step = nextStep(record);
  assert.ok(step);
  assert.deepEqual(stepProgress(record, step), { index: 2, total: 2, completed: 1 });
});

test("单步提示词写明只做这一步，并列出已完成的不要重做", () => {
  const record = plan(["completed", "pending"]);
  const prompt = compileStepPrompt(record, record.steps[1]!);
  assert.match(prompt, /第 2\/2 步/);
  assert.match(prompt, /第2件事/);
  assert.match(prompt, /src\/step2\.ts/);
  assert.match(prompt, /只做这一步/);
  assert.match(prompt, /已完成的步骤（不要重做）/);
  assert.match(prompt, /第1件事/);
  assert.ok(!/上一轮没走完/.test(prompt), "首次下发不该说成续做");
});

test("重发失败的步骤时说清是在续做", () => {
  const record = plan(["failed"]);
  assert.match(compileStepPrompt(record, record.steps[0]!), /上一轮没走完/);
});

test("轮次结果映射：停止记回 pending，不背失败的名", () => {
  assert.equal(stepOutcome("completed"), "completed");
  assert.equal(stepOutcome("failed"), "failed");
  assert.equal(stepOutcome("stopped"), "pending");
});

test("计划不在执行态时门控不自作主张开跑", () => {
  assert.equal(planGateAction(undefined).kind, "idle");
  assert.equal(planGateAction(plan(["pending"], { status: "waiting_review" })).kind, "idle");
  assert.equal(planGateAction(plan(["pending"], { status: "paused" })).kind, "idle");
  assert.equal(planGateAction(plan(["pending"], { status: "approved" })).kind, "dispatch");
});

test("全部完成时门控给出 finished", () => {
  assert.equal(planGateAction(plan(["completed"])).kind, "finished");
});

// ---------------------------------------------------------------------------
// PlanFacade 上的逐步推进
// ---------------------------------------------------------------------------

function agentPlan(): AgentPlan {
  return {
    title: "登录系统改造",
    steps: [
      { index: 1, title: "更新路由", detail: "调整 auth 路由", files: ["src/router.ts"] },
      { index: 2, title: "补充测试", files: ["tests/auth.test.ts"] },
    ],
    files: ["src/router.ts"],
    risks: [],
    raw: "# 登录系统改造",
    empty: false,
  };
}

function enterTurn(ui: UiStateMachine): UiStateMachine {
  for (const state of ["initializing", "ready", "sending"] as const) {
    assert.ok(ui.transition(state), `无法进入 ${state}`);
  }
  return ui;
}

async function harness(options: { gating?: boolean; turnPending?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-plan-gate-"));
  const fs = createNodeFileSystem();
  const file = path.join(directory, "plans.json");
  const plans = new PlanRepository(file, new JsonStore(fs));
  await plans.open(file);

  const prompts: string[] = [];
  const messages: HostToWebviewMessage[] = [];
  const runtimeCalls: string[] = [];
  const ui = enterTurn(new UiStateMachine());
  const turn = createTurnState();

  const deps: PlanFacadeDeps = {
    post: (message) => messages.push(message),
    postState: () => {},
    postModeState: () => {},
    ui,
    store: { setActivePlan: () => {} } as unknown as PlanFacadeDeps["store"],
    turn,
    fs,
    workspaceRoot: () => directory,
    grokHome: () => undefined,
    grokSessionId: () => undefined,
    ensureStorage: async () => {},
    persistence: () => ({
      plans,
      sessions: { patch: async () => undefined },
    } as unknown as ReturnType<PlanFacadeDeps["persistence"]>),
    flushPersistence: async () => {},
    activeSessionId: () => "ses-1",
    setActiveSession: () => {},
    runtime: () => ({
      approvePlan: async () => { runtimeCalls.push("approvePlan"); },
      approvePlanStepwise: async () => { runtimeCalls.push("approvePlanStepwise"); },
      rejectPlan: async () => { runtimeCalls.push("rejectPlan"); },
      revisePlan: async () => { runtimeCalls.push("revisePlan"); },
    } as unknown as AgentRuntimeHandle),
    setMode: async () => {},
    forceMode: () => {},
    sendPrompt: async (text) => { prompts.push(text); },
    stop: async () => {},
    // 默认不掺「批准即开跑」：多数用例直接调 startBuild。
    turnPending: () => options.turnPending === true,
    stepGating: () => options.gating !== false,
  };

  const facade = new PlanFacade(deps);
  facade.handleReviewRequested(agentPlan());
  return { facade, prompts, messages, plans, runtimeCalls, turn, ui };
}

test("开始构建只下发第一步，并把它标成进行中", async () => {
  const h = await harness();
  await h.facade.startBuild();

  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0] ?? "", /第 1\/2 步/);
  assert.match(h.prompts[0] ?? "", /更新路由/);
  assert.ok(!/补充测试/.test(h.prompts[0] ?? ""), "第二步的内容不该提前泄漏给模型");
  assert.equal(h.plans.active?.steps[0]?.status, "in_progress");
  assert.equal(h.plans.active?.steps[1]?.status, "pending");
});

test("一步跑完自动下发下一步", async () => {
  const h = await harness();
  await h.facade.startBuild();
  await h.facade.onTurnSettled("completed");

  assert.equal(h.plans.active?.steps[0]?.status, "completed");
  assert.equal(h.plans.active?.steps[1]?.status, "in_progress");
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1] ?? "", /第 2\/2 步/);
  assert.match(h.prompts[1] ?? "", /已完成的步骤（不要重做）/);
});

test("最后一步跑完把计划记成已完成，不再发提示词", async () => {
  const h = await harness();
  await h.facade.startBuild();
  await h.facade.onTurnSettled("completed");
  await h.facade.onTurnSettled("completed");

  assert.equal(h.prompts.length, 2, "没有第三步可发");
  assert.equal(h.plans.active, undefined, "已完成的计划不再是活动计划");
  const finished = h.plans.plans.find((item) => item.id !== undefined);
  assert.equal(finished?.status, "completed");
});

test("这一步失败：停在原地并把计划暂停，不继续往下做", async () => {
  const h = await harness();
  await h.facade.startBuild();
  await h.facade.onTurnSettled("failed");

  assert.equal(h.prompts.length, 1, "失败后不该自动开下一步");
  const record = h.plans.plans[0];
  assert.equal(record?.steps[0]?.status, "failed");
  assert.equal(record?.status, "paused");
  assert.ok(
    h.messages.some((m) => m.type === "notice" && m.message.includes("没跑通")),
    "要明确告诉用户卡在哪儿了",
  );
});

test("用户停掉：这一步记回 pending，下次原样重来", async () => {
  const h = await harness();
  await h.facade.startBuild();
  await h.facade.onTurnSettled("stopped");

  assert.equal(h.plans.plans[0]?.steps[0]?.status, "pending", "主动停止不是这一步做错了");
  assert.equal(h.plans.plans[0]?.status, "paused");
});

test("继续构建从没做完的那一步接着走", async () => {
  const h = await harness();
  await h.facade.startBuild();
  await h.facade.onTurnSettled("completed");
  await h.facade.onTurnSettled("stopped");
  h.prompts.length = 0;

  await h.facade.resumeBuild();
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0] ?? "", /第 2\/2 步/);
  assert.equal(h.plans.active?.steps[0]?.status, "completed", "已完成的步骤不该被重置");
});

test("与本轮无关的收尾不会误记步骤状态", async () => {
  const h = await harness();
  // 没有 startBuild：门控手上没有在跑的步骤。
  await h.facade.onTurnSettled("completed");
  assert.equal(h.plans.active?.steps[0]?.status, "pending");
  assert.deepEqual(h.prompts, []);
});

/**
 * 这一组盯的是线上真实翻过的车：Grok 的 exit_plan_mode 回 approved 之后，
 * 它会在同一轮里把整个计划做穿，宿主拿不到任何轮次边界，门控等于没开。
 * 所以门控生效时批准必须走 approvePlanStepwise（回 abandoned 换边界）。
 */
test("门控开着时批准走 stepwise 回执，而不是让 Grok 同轮跑完", async () => {
  const h = await harness({ turnPending: true });
  await h.facade.approve();
  assert.deepEqual(h.runtimeCalls, ["approvePlanStepwise"]);
  assert.equal(h.prompts.length, 0, "批准当时不发提示词，Grok 还卡在回执上");
  assert.ok(
    h.messages.some((m) => m.type === "notice" && m.message.includes("按步骤逐条执行")),
    "要明确告诉用户接下来是一步一步来",
  );
});

test("门控关掉时批准仍走原来的 approved 回执", async () => {
  const h = await harness({ gating: false, turnPending: true });
  await h.facade.approve();
  assert.deepEqual(h.runtimeCalls, ["approvePlan"]);
});

test("计划没有可做的步骤时不接管，退回让 Grok 自己跑", async () => {
  const h = await harness({ turnPending: true });
  const plan = h.plans.active;
  assert.ok(plan);
  for (const step of plan.steps) {
    h.plans.updateStep(plan.id, step.id, { status: "skipped" });
  }
  await h.facade.approve();
  assert.deepEqual(h.runtimeCalls, ["approvePlan"], "没步骤可发就别接管，否则点了没反应");
});

test("stepwise 批准后本轮收尾才开跑第一步", async () => {
  const h = await harness({ turnPending: true });
  await h.facade.approve();
  assert.equal(h.prompts.length, 0);

  await h.facade.onTurnSettled("completed");
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0] ?? "", /第 1\/2 步/);
  assert.equal(h.plans.active?.steps[0]?.status, "in_progress");
});

test("回 abandoned 被报成 stopped 时也要开跑第一步", async () => {
  const h = await harness({ turnPending: true });
  await h.facade.approve();
  // Grok 对 abandoned 的收尾有可能是 cancelled，不能因此把计划卡死在原地。
  await h.facade.onTurnSettled("stopped");
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0] ?? "", /第 1\/2 步/);
});

test("这一轮本身失败就不硬开第一步", async () => {
  const h = await harness({ turnPending: true });
  await h.facade.approve();
  await h.facade.onTurnSettled("failed");
  assert.equal(h.prompts.length, 0);
});

test("开跑后再收尾，走的是正常推进而不是把刚发出的步骤判掉", async () => {
  const h = await harness({ turnPending: true });
  await h.facade.approve();
  await h.facade.onTurnSettled("completed");
  assert.equal(h.plans.active?.steps[0]?.status, "in_progress");

  // 第一步真的跑完了，这一轮收尾应当把它记成完成并发第二步。
  await h.facade.onTurnSettled("completed");
  assert.equal(h.plans.active?.steps[0]?.status, "completed");
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1] ?? "", /第 2\/2 步/);
});

test("取消勾选的步骤不会被下发", async () => {
  const h = await harness();
  const second = h.plans.active?.steps[1]?.id;
  assert.ok(second);
  await h.facade.setStepIncluded(second, false);
  assert.equal(h.plans.active?.steps[1]?.status, "skipped");

  await h.facade.startBuild();
  await h.facade.onTurnSettled("completed");

  assert.equal(h.prompts.length, 1, "只剩一步可做");
  assert.match(h.prompts[0] ?? "", /第 1\/1 步/);
  assert.equal(h.plans.plans[0]?.status, "completed", "跳过的步骤不该拖着计划不完成");
});

test("勾回来的步骤重新参与执行", async () => {
  const h = await harness();
  const second = h.plans.active?.steps[1]?.id;
  assert.ok(second);
  await h.facade.setStepIncluded(second, false);
  await h.facade.setStepIncluded(second, true);
  assert.equal(h.plans.active?.steps[1]?.status, "pending");

  await h.facade.startBuild();
  assert.match(h.prompts[0] ?? "", /第 1\/2 步/);
});

test("已完成的步骤不许取消勾选", async () => {
  const h = await harness();
  await h.facade.startBuild();
  await h.facade.onTurnSettled("completed");
  const first = h.plans.active?.steps[0]?.id;
  assert.ok(first);

  await h.facade.setStepIncluded(first, false);
  assert.equal(h.plans.active?.steps[0]?.status, "completed", "不能把做过的事实抹掉");
  assert.ok(h.messages.some((m) => m.type === "notice" && m.message.includes("已经做完")));
});

test("正在执行的步骤不许取消勾选", async () => {
  const h = await harness();
  await h.facade.startBuild();
  const first = h.plans.active?.steps[0]?.id;
  assert.ok(first);

  await h.facade.setStepIncluded(first, false);
  assert.equal(h.plans.active?.steps[0]?.status, "in_progress");
  assert.ok(h.messages.some((m) => m.type === "notice" && m.message.includes("正在执行")));
});

test("关掉门控就退回整份计划一次性发出", async () => {
  const h = await harness({ gating: false });
  await h.facade.startBuild();

  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0] ?? "", /更新路由/);
  assert.match(h.prompts[0] ?? "", /补充测试/);
  assert.equal(h.plans.active?.steps[0]?.status, "pending", "老路径不由宿主记步骤状态");

  await h.facade.onTurnSettled("completed");
  assert.equal(h.prompts.length, 1, "老路径不该被门控接着推进");
});
