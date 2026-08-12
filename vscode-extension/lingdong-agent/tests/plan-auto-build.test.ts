import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentPlan, AgentRuntimeHandle } from "@lingdong/agent-runtime";
import { createNodeFileSystem } from "../src/file-system-port";
import type { HostToWebviewMessage, UiAgentMode } from "../src/messages";
import { PlanFacade, type PlanFacadeDeps } from "../src/services/plan-facade";
import { createTurnState } from "../src/services/turn-state";
import { JsonStore } from "../src/storage/json-store";
import { PlanRepository } from "../src/storage/plan-repository";
import { UiStateMachine } from "../src/ui-state";

/**
 * 「批准即开跑」的布防/撤防。
 *
 * 这条链路的坑在于：批准发生在一轮任务的中途（模型正等 exit_plan_mode 的回复），
 * 此刻直接发提示词只会进排队。所以 approve 只布防，真正补发要等本轮收尾——
 * 而且模型如果自己就接着干了，必须撤防，否则等于让它把活儿重做一遍。
 */

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

/**
 * 计划审批只能在一轮任务里发生，状态机不允许从 idle 直接跳到 waiting_plan_approval。
 * 这里把真实的路径走一遍，免得 canApprovePlan 守卫把测试挡在门外。
 */
function enterTurn(ui: UiStateMachine): UiStateMachine {
  for (const state of ["initializing", "ready", "sending"] as const) {
    assert.ok(ui.transition(state), `无法进入 ${state}`);
  }
  return ui;
}

interface Harness {
  facade: PlanFacade;
  prompts: string[];
  messages: HostToWebviewMessage[];
  modes: UiAgentMode[];
  plans: PlanRepository;
  ui: UiStateMachine;
  turn: ReturnType<typeof createTurnState>;
  setTurnPending(pending: boolean): void;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-autobuild-"));
  const fs = createNodeFileSystem();
  const plans = new PlanRepository(path.join(directory, "plans.json"), new JsonStore(fs));
  await plans.open(path.join(directory, "plans.json"));

  const prompts: string[] = [];
  const messages: HostToWebviewMessage[] = [];
  const modes: UiAgentMode[] = [];
  const ui = enterTurn(new UiStateMachine());
  const turn = createTurnState();
  let turnPending = true;

  const runtime = {
    approvePlan: async () => {},
    rejectPlan: async () => {},
    revisePlan: async () => {},
  } as unknown as AgentRuntimeHandle;

  // 只有 plans 这一支被 PlanFacade 用到；sessions.patch 在审批落盘时会走一次。
  const persistence = {
    plans,
    sessions: { patch: async () => undefined },
  } as unknown as ReturnType<PlanFacadeDeps["persistence"]>;

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
    persistence: () => persistence,
    flushPersistence: async () => {},
    activeSessionId: () => "ses-1",
    setActiveSession: () => {},
    runtime: () => runtime,
    setMode: async (mode) => { modes.push(mode); },
    forceMode: (mode) => { modes.push(mode); },
    sendPrompt: async (text) => { prompts.push(text); },
    stop: async () => {},
    turnPending: () => turnPending,
    // 这一组用例只管「批准之后有没有开跑」，逐步门控另有专门的测试文件。
    stepGating: () => false,
  };

  const facade = new PlanFacade(deps);
  // 走一遍真实的审批入口，UI 与 pendingPlan 才处在能批准的状态。
  facade.handleReviewRequested(agentPlan());
  return {
    facade,
    prompts,
    messages,
    modes,
    plans,
    ui,
    turn,
    setTurnPending: (pending) => { turnPending = pending; },
  };
}

test("批准时本轮还在飞：先不发提示词，等收尾再补", async () => {
  const h = await harness();
  await h.facade.approve();
  assert.deepEqual(h.prompts, [], "此刻发出去只会进排队");
  assert.equal(h.plans.active?.status, "approved");

  await h.facade.onTurnSettled("completed");
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0] ?? "", /登录系统改造/);
  assert.equal(h.plans.active?.status, "executing");
});

test("批准时没有在飞的轮次：当场开跑，不用再等", async () => {
  const h = await harness();
  h.setTurnPending(false);
  await h.facade.approve();
  assert.equal(h.prompts.length, 1, "历史里翻出来的审批卡没有「收尾」可等");
});

test("模型批准后自己就接着干了：撤防，不再补发", async () => {
  const h = await harness();
  await h.facade.approve();

  // plan_updated 带着步骤状态推进过来，说明它没在等我们。
  const live = agentPlan();
  live.steps[0] = { ...live.steps[0]!, status: "in_progress" };
  h.facade.handleExecutingUpdate(live);

  await h.facade.onTurnSettled("completed");
  assert.deepEqual(h.prompts, [], "再补一遍等于让它把活儿重做一遍");
});

test("本轮失败或被停：不替用户自作主张继续", async () => {
  for (const status of ["failed", "stopped"] as const) {
    const h = await harness();
    await h.facade.approve();
    await h.facade.onTurnSettled(status);
    assert.deepEqual(h.prompts, [], `${status} 之后不该自动开跑`);
  }
});

test("补发只发一次，重复收尾不会连发两轮", async () => {
  const h = await harness();
  await h.facade.approve();
  await h.facade.onTurnSettled("completed");
  await h.facade.onTurnSettled("completed");
  assert.equal(h.prompts.length, 1);
});

test("批准的 RPC 失败：撤防并保留待审批状态", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-autobuild-fail-"));
  const fs = createNodeFileSystem();
  const plans = new PlanRepository(path.join(directory, "plans.json"), new JsonStore(fs));
  await plans.open(path.join(directory, "plans.json"));
  const prompts: string[] = [];
  const ui = enterTurn(new UiStateMachine());
  const turn = createTurnState();
  const deps: PlanFacadeDeps = {
    post: () => {},
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
      approvePlan: async () => { throw new Error("连接已断开"); },
    } as unknown as AgentRuntimeHandle),
    setMode: async () => {},
    forceMode: () => {},
    sendPrompt: async (text) => { prompts.push(text); },
    stop: async () => {},
    turnPending: () => false,
    stepGating: () => false,
  };
  const facade = new PlanFacade(deps);
  facade.handleReviewRequested(agentPlan());

  await facade.approve();
  assert.deepEqual(prompts, []);
  assert.equal(turn.pendingPlan, true, "失败后用户还得能再批一次");

  await facade.onTurnSettled("completed");
  assert.deepEqual(prompts, [], "失败的批准不该留下布防");
});

test("没有待审批计划时批准被守卫拦住", async () => {
  const h = await harness();
  h.turn.pendingPlan = false;
  await h.facade.approve();
  assert.deepEqual(h.prompts, []);
  assert.ok(
    h.messages.some((m) => m.type === "notice" && m.message.includes("没有待审批")),
    "要给用户一句话，而不是静默什么都不做",
  );
});
