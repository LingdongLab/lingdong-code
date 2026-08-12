import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { toPlanCard } from "../src/plan-view-model";
import type { AgentPlan } from "@lingdong/agent-runtime";
import { JsonStore } from "../src/storage/json-store";
import { PlanRepository, type PlanRecord } from "../src/storage/plan-repository";

function agentPlan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    title: "登录系统改造",
    steps: [
      { index: 1, title: "更新路由", detail: "调整 auth 路由", files: ["src/router.ts"] },
      { index: 2, title: "补充测试", files: ["tests/auth.test.ts"] },
    ],
    files: ["src/router.ts", "tests/auth.test.ts"],
    risks: ["可能影响现有登录流程"],
    raw: "# 登录系统改造",
    empty: false,
    ...overrides,
  };
}

async function setup(options: { now?: () => number } = {}): Promise<{
  repo: PlanRepository;
  file: string;
  now: () => number;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-plans-"));
  const file = path.join(directory, "plans.json");
  let tick = 1_000;
  const now = options.now ?? (() => tick++);
  const repo = new PlanRepository(file, new JsonStore(createNodeFileSystem(), { now }), { now });
  await repo.open(file);
  return { repo, file, now };
}

test("createFromCard 创建计划并可落盘读回", async () => {
  const { repo, file } = await setup();
  const card = toPlanCard(agentPlan(), "ready");
  const created = repo.createFromCard("ses-abc", card);
  repo.upsert(created);
  await repo.flush();

  const reopened = new PlanRepository(file, new JsonStore(createNodeFileSystem()));
  await reopened.open(file);
  assert.equal(reopened.plans.length, 1);
  assert.equal(reopened.plans[0]?.title, "登录系统改造");
  assert.equal(reopened.plans[0]?.sessionId, "ses-abc");
  assert.equal(reopened.plans[0]?.status, "waiting_review");
  assert.equal(reopened.plans[0]?.steps.length, 2);
});

test("upsert 同 id 替换时 version 自动递增", async () => {
  const { repo } = await setup();
  const card = toPlanCard(agentPlan(), "ready");
  const created = repo.createFromCard("ses-abc", card);
  repo.upsert(created);

  const replaced: PlanRecord = { ...created, title: "登录系统改造 v2", version: created.version };
  repo.upsert(replaced);
  assert.equal(repo.plans[0]?.version, 2);
  assert.equal(repo.plans[0]?.title, "登录系统改造 v2");

  repo.upsert({ ...replaced, title: "登录系统改造 v3", version: 5 });
  assert.equal(repo.plans[0]?.version, 5);
});

test("setStatus 迁移状态并写入批准/完成时间戳", async () => {
  let tick = 10_000;
  const now = () => tick++;
  const { repo } = await setup({ now });
  const created = repo.createFromCard("ses-abc", toPlanCard(agentPlan(), "ready"));
  repo.upsert(created);

  const approved = repo.setStatus(created.id, "approved", "用户已批准");
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.version, 2);
  assert.equal(approved?.approvedAt, 10_002);

  const executing = repo.setStatus(created.id, "executing");
  assert.equal(executing?.status, "executing");
  assert.equal(executing?.version, 3);

  const completed = repo.setStatus(created.id, "completed");
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.completedAt, 10_004);
});

test("addStep/removeStep/reorderSteps/updateMeta 递增版本", async () => {
  const { repo } = await setup();
  const created = repo.createFromCard("ses-abc", toPlanCard(agentPlan(), "ready"));
  repo.upsert(created);
  const added = repo.addStep(created.id, { title: "第三步", description: "收尾" });
  assert.equal(added?.steps.length, 3);
  assert.equal(added?.version, 2);
  const reordered = repo.reorderSteps(created.id, [
    added!.steps[2]!.id,
    added!.steps[0]!.id,
    added!.steps[1]!.id,
  ]);
  assert.equal(reordered?.steps[0]?.title, "第三步");
  assert.equal(reordered?.version, 3);
  const meta = repo.updateMeta(created.id, { title: "新标题", goal: "完成改造", risks: ["r1"] });
  assert.equal(meta?.title, "新标题");
  assert.equal(meta?.goal, "完成改造");
  assert.equal(meta?.version, 4);
  const removed = repo.removeStep(created.id, reordered!.steps[0]!.id);
  assert.equal(removed?.steps.length, 2);
  assert.equal(removed?.version, 5);
});

test("updateStep 更新步骤并追踪当前步骤", async () => {
  const { repo } = await setup();
  const created = repo.createFromCard("ses-abc", toPlanCard(agentPlan(), "approved"));
  repo.upsert(created);

  const updated = repo.updateStep(created.id, "step-1", { status: "in_progress" });
  assert.equal(updated?.currentStepId, "step-1");
  assert.equal(updated?.steps[0]?.status, "in_progress");
  assert.ok(updated?.steps[0]?.startedAt !== undefined);
  assert.equal(updated?.version, 2);

  const done = repo.updateStep(created.id, "step-1", { status: "completed" });
  assert.equal(done?.steps[0]?.status, "completed");
  assert.ok(done?.steps[0]?.completedAt !== undefined);
});

test("active 返回活跃状态中 updatedAt 最新的计划", async () => {
  let tick = 100;
  const now = () => tick++;
  const { repo } = await setup({ now });

  const older = repo.createFromCard("ses-a", toPlanCard(agentPlan({ title: "旧计划" }), "ready"));
  repo.upsert(older);

  const newer = repo.createFromCard("ses-b", toPlanCard(agentPlan({ title: "新计划" }), "executing"));
  repo.upsert(newer);

  repo.setStatus(older.id, "abandoned");
  assert.equal(repo.active?.id, newer.id);

  repo.setStatus(newer.id, "paused");
  assert.equal(repo.active?.id, newer.id);
});

test("落盘前对 title/raw/risks 脱敏", async () => {
  const { repo, file } = await setup();
  const created = repo.createFromCard(
    "ses-abc",
    toPlanCard(
      agentPlan({
        title: "api_key=sk-abcdefghij1234567890",
        risks: ["Bearer sk-abcdefghij1234567890"],
        raw: "secret=sk-abcdefghij1234567890",
      }),
      "ready",
    ),
  );
  repo.upsert(created);
  await repo.flush();

  const raw = await readFile(file, "utf8");
  assert.ok(!raw.includes("sk-abcdefghij1234567890"));
  assert.ok(raw.includes("REDACTED"));
});

test("损坏数据宽松校验：坏条目丢弃，合法条目保留", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-plans-"));
  const file = path.join(directory, "plans.json");
  const payload = {
    schemaVersion: 1,
    kind: "plans",
    updatedAt: 1,
    data: {
      plans: [
        { id: "plan-good", sessionId: "ses-1", version: 1, title: "好计划", steps: [], files: [], risks: [], status: "draft", createdAt: 1, updatedAt: 1, source: "grok" },
        { id: "", sessionId: "ses-1" },
        "not-an-object",
        { id: "plan-bad-step", sessionId: "ses-1", version: 1, title: "坏步骤", steps: [{ bad: true }, { id: "s1", title: "步骤", files: [], status: "pending", order: 1 }], files: [], risks: [], status: "draft", createdAt: 1, updatedAt: 1, source: "grok" },
      ],
    },
  };
  await writeFile(file, JSON.stringify(payload), "utf8");

  const repo = new PlanRepository(file, new JsonStore(createNodeFileSystem()));
  await repo.open(file);
  assert.equal(repo.plans.length, 2);
  assert.equal(repo.plans.find((plan) => plan.id === "plan-good")?.title, "好计划");
  assert.equal(repo.plans.find((plan) => plan.id === "plan-bad-step")?.steps.length, 1);
});

test("损坏文件时按空列表继续并上报", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-plans-"));
  const file = path.join(directory, "plans.json");
  await writeFile(file, "不是 JSON", "utf8");
  const damages: string[] = [];
  const repo = new PlanRepository(file, new JsonStore(createNodeFileSystem()), {
    onDamage: (detail) => damages.push(detail),
  });
  const status = await repo.open(file);
  assert.equal(status, "corrupt");
  assert.deepEqual(repo.plans, []);
  assert.ok(damages[0]?.startsWith("计划记录"));
});

test("clear 清空后 flush 写入空列表", async () => {
  const { repo, file } = await setup();
  repo.upsert(repo.createFromCard("ses-abc", toPlanCard(agentPlan(), "ready")));
  repo.clear();
  await repo.flush();

  const reopened = new PlanRepository(file, new JsonStore(createNodeFileSystem()));
  await reopened.open(file);
  assert.deepEqual(reopened.plans, []);
});
