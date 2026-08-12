import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentRuntime, type AgentMode, type AgentRuntime } from "../src/agent-runtime.js";
import type { WriteGuard } from "../src/acp-client.js";
import type { AgentEvent } from "../src/event-normalizer.js";

const fakeGrok = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));

async function startRuntime(mode: AgentMode = "agent", beforeWrite?: WriteGuard): Promise<AgentRuntime> {
  const workspace = await mkdtemp(path.join(tmpdir(), "lingdong-perm-"));
  const runtime = createAgentRuntime({
    executable: process.execPath,
    args: [fakeGrok],
    workspace,
    logDirectory: path.join(workspace, "logs"),
    ...(beforeWrite ? { beforeWrite } : {}),
  });
  await runtime.initialize();
  await runtime.createSession({ mode });
  return runtime;
}

function textOf(events: AgentEvent[]): string {
  return events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
}

test("允许一次只回 allow-once，绝不使用 allow_always 选项", async () => {
  const runtime = await startRuntime();
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "确认权限：安装依赖" })) {
    events.push(event);
    if (event.type === "permission_requested") {
      assert.equal(event.decision.action, "ask");
      await runtime.respondPermission(event.requestId, "allow_once");
    }
  }
  const text = textOf(events);
  assert.ok(text.includes("[permission:allow-once]"));
  assert.equal(text.includes("allow-edits-session"), false);
  const resolved = events.find((event) => event.type === "permission_resolved");
  assert.equal(resolved?.type === "permission_resolved" ? resolved.automatic : true, false);
  await runtime.dispose();
});

test("拒绝会回 reject-once 并结束该工具调用", async () => {
  const runtime = await startRuntime();
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "确认权限：安装依赖" })) {
    events.push(event);
    if (event.type === "permission_requested") await runtime.respondPermission(event.requestId, "reject");
  }
  assert.ok(textOf(events).includes("[permission:reject-once]"));
  await runtime.dispose();
});

test("本次会话允许后同类命令自动放行且仍只回 allow-once", async () => {
  const runtime = await startRuntime();
  const first: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "命令权限：运行测试" })) {
    first.push(event);
    if (event.type === "permission_requested") await runtime.respondPermission(event.requestId, "allow_session");
  }
  const rule = first.find((event) => event.type === "permission_resolved");
  assert.equal(rule?.type === "permission_resolved" ? rule.rule?.kind : undefined, "command-prefix");

  const second: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "再次命令：继续运行测试" })) {
    second.push(event);
    if (event.type === "permission_requested") await runtime.respondPermission(event.requestId, "reject");
  }
  assert.equal(second.some((event) => event.type === "permission_requested"), false);
  const auto = second.find((event) => event.type === "permission_resolved");
  assert.equal(auto?.type === "permission_resolved" ? auto.automatic : false, true);
  assert.ok(textOf(second).includes("[permission:allow-once]"));
  await runtime.dispose();
});

test("重复回应同一 requestId 会被拒绝", async () => {
  const runtime = await startRuntime();
  let duplicate: unknown;
  for await (const event of runtime.sendMessage({ text: "确认权限：安装依赖" })) {
    if (event.type !== "permission_requested") continue;
    await runtime.respondPermission(event.requestId, "allow_once");
    duplicate = await runtime.respondPermission(event.requestId, "reject").catch((error: unknown) => error);
  }
  assert.ok(duplicate instanceof Error);
  assert.match((duplicate as Error).message, /失效/);
  await runtime.dispose();
});

test("Ask 模式的写入请求被安全策略直接拒绝，不产生待确认卡片", async () => {
  const runtime = await startRuntime("ask");
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "需要权限修改首页" })) events.push(event);
  assert.equal(events.some((event) => event.type === "permission_requested"), false);
  const resolved = events.find((event) => event.type === "permission_resolved");
  assert.equal(resolved?.type === "permission_resolved" ? resolved.resolution : "", "reject");
  assert.equal(resolved?.type === "permission_resolved" ? resolved.automatic : false, true);
  assert.ok(textOf(events).includes("[permission:reject-once]"));
  await runtime.dispose();
});

test("取消会清理所有待确认权限", async () => {
  const runtime = await startRuntime();
  const events: AgentEvent[] = [];
  const stream = runtime.sendMessage({ text: "两次权限：修改两个文件" });
  const consume = (async () => {
    for await (const event of stream) events.push(event);
  })();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runtime.pendingPermissionIds.length, 2);
  await runtime.cancel();
  await consume;

  assert.equal(runtime.pendingPermissionIds.length, 0);
  const cancelled = events.filter(
    (event) => event.type === "permission_resolved" && event.resolution === "cancelled",
  );
  assert.equal(cancelled.length, 2);
  await runtime.dispose();
});

test("Agent 模式对清单写入不再弹卡，改动仍先过写入前钩子", async () => {
  const order: string[] = [];
  const runtime = await startRuntime("agent", async ({ decision, automatic }) => {
    order.push(`${decision.operationKind}:${automatic ? "auto" : "manual"}`);
    return { ok: true };
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "需要权限修改首页" })) events.push(event);
  assert.equal(events.some((event) => event.type === "permission_requested"), false);
  assert.deepEqual(order, ["modify_config:auto"]);
  assert.ok(textOf(events).includes("[permission:allow-once]"));
  await runtime.dispose();
});

test("Agent 模式装依赖仍然弹卡", async () => {
  const runtime = await startRuntime();
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "确认权限：安装依赖" })) {
    events.push(event);
    if (event.type === "permission_requested") {
      assert.equal(event.decision.operationKind, "install_dependency");
      await runtime.respondPermission(event.requestId, "reject");
    }
  }
  assert.ok(events.some((event) => event.type === "permission_requested"));
  await runtime.dispose();
});

test("Agent 模式低风险写入自动放行，且先过写入前钩子", async () => {
  const order: string[] = [];
  const runtime = await startRuntime("agent", async ({ automatic }) => {
    order.push(automatic ? "auto" : "manual");
    return { ok: true };
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "低风险写入：更新首页标题" })) events.push(event);
  assert.equal(events.some((event) => event.type === "permission_requested"), false);
  const resolved = events.find((event) => event.type === "permission_resolved");
  assert.equal(resolved?.type === "permission_resolved" ? resolved.automatic : false, true);
  assert.equal(resolved?.type === "permission_resolved" ? resolved.resolution : "", "allow_once");
  assert.deepEqual(order, ["auto"]);
  assert.ok(textOf(events).includes("[permission:allow-once]"));
  await runtime.dispose();
});

test("Auto 模式自动放行前会先执行写入前钩子", async () => {
  const order: string[] = [];
  const runtime = await startRuntime("auto", async ({ decision, automatic }) => {
    order.push(`guard:${decision.operation}:${automatic ? "auto" : "manual"}`);
    return { ok: true };
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "需要权限修改首页" })) {
    events.push(event);
    if (event.type === "text_delta" && event.text.includes("[permission:")) order.push("allowed");
  }
  assert.deepEqual(order, ["guard:write:auto", "allowed"]);
  assert.equal(events.some((event) => event.type === "permission_requested"), false);
  await runtime.dispose();
});

test("人工批准同样先过写入前钩子", async () => {
  const calls: string[] = [];
  const runtime = await startRuntime("agent", async ({ automatic }) => {
    calls.push(automatic ? "auto" : "manual");
    return { ok: true };
  });
  for await (const event of runtime.sendMessage({ text: "确认权限：安装依赖" })) {
    if (event.type === "permission_requested") await runtime.respondPermission(event.requestId, "allow_once");
  }
  assert.deepEqual(calls, ["manual"]);
  await runtime.dispose();
});

test("快照失败时写入被改判为拒绝", async () => {
  const runtime = await startRuntime("agent", async () => ({ ok: false, reason: "快照写入失败" }));
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "确认权限：安装依赖" })) {
    events.push(event);
    if (event.type === "permission_requested") await runtime.respondPermission(event.requestId, "allow_once");
  }
  assert.ok(textOf(events).includes("[permission:reject-once]"));
  const resolved = events.filter((event) => event.type === "permission_resolved");
  const last = resolved.at(-1);
  assert.equal(last?.type === "permission_resolved" ? last.resolution : "", "reject");
  assert.match(last?.type === "permission_resolved" ? last.reason : "", /快照写入失败/);
  await runtime.dispose();
});

test("钩子抛错等同于快照失败，不允许写入", async () => {
  const runtime = await startRuntime("auto", async () => {
    throw new Error("磁盘已满");
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "需要权限修改首页" })) events.push(event);
  assert.ok(textOf(events).includes("[permission:reject-once]"));
  const resolved = events.find((event) => event.type === "permission_resolved");
  assert.match(resolved?.type === "permission_resolved" ? resolved.reason : "", /磁盘已满/);
  await runtime.dispose();
});

test("只读操作不触发写入前钩子", async () => {
  let calls = 0;
  const runtime = await startRuntime("agent", async () => {
    calls += 1;
    return { ok: true };
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ text: "读取权限：查看首页" })) events.push(event);
  assert.equal(calls, 0);
  assert.ok(textOf(events).includes("[permission:allow-once]"));
  await runtime.dispose();
});

test("新建会话会清空待确认权限与会话规则", async () => {
  const runtime = await startRuntime();
  const stream = runtime.sendMessage({ text: "两次权限：修改两个文件" });
  const consume = (async () => {
    for await (const event of stream) void event;
  })();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runtime.pendingPermissionIds.length, 2);
  await runtime.cancel();
  await consume;
  await runtime.createSession({ mode: "agent" });
  assert.equal(runtime.pendingPermissionIds.length, 0);
  await runtime.dispose();
});
