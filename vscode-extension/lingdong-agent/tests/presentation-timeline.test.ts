import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@lingdong/agent-runtime";
import type { HostToWebviewMessage } from "../src/messages";
import { groupKindForAction, describeGroup } from "../src/presentation/activity-group";
import type { ActivityAction } from "../src/presentation/activity-item";
import { classifyTool, toRelativeTarget } from "../src/presentation/event-classifier";
import {
  interruptPresentation,
  parseTurnPresentation,
  serializeTurnPresentation,
} from "../src/presentation/presentation-serializer";
import { buildTurnSummary } from "../src/presentation/summary-builder";
import { TimelineBuilder } from "../src/presentation/timeline-builder";
import { formatDuration } from "../src/presentation/turn-presentation";
import { describeTurnSummary } from "../src/presentation/turn-summary";
import { mergeVerification, parseVerification } from "../src/presentation/verification-parser";
import { TimelineService } from "../src/services/timeline-service";

const ROOT = "E:/work/demo";

function tool(overrides: Partial<Parameters<typeof classifyTool>[0]> = {}) {
  return {
    toolCallId: "call-1",
    kind: "other",
    name: "tool",
    label: "tool",
    readOnly: true,
    ...overrides,
  };
}

function actionOf(overrides: Partial<Parameters<typeof classifyTool>[0]>): ActivityAction | undefined {
  return classifyTool(tool(overrides), { workspaceRoot: ROOT })?.action;
}

// ---------------------------------------------------------------------------
// 事件分类
// ---------------------------------------------------------------------------

test("读取、列目录、搜索与诊断都归类为 exploration", () => {
  const actions = [
    actionOf({ kind: "read", name: "read_file", label: "Read", target: `${ROOT}/src/a.ts` }),
    actionOf({ kind: "other", name: "list_files", label: "List Files" }),
    actionOf({ kind: "search", name: "grep", label: "Search" }),
    actionOf({ kind: "other", name: "get_diagnostics", label: "问题面板" }),
  ];
  assert.deepEqual(actions, ["read", "list", "search", "diagnostics"]);
  for (const action of actions) {
    assert.equal(groupKindForAction(action as ActivityAction), "exploration");
  }
});

test("修改、创建、删除与重命名都归类为 editing", () => {
  const actions = [
    actionOf({ kind: "edit", name: "apply_patch", label: "Edit", target: `${ROOT}/src/a.ts` }),
    actionOf({ kind: "edit", name: "create_file", label: "Create" }),
    actionOf({ kind: "edit", name: "delete_file", label: "Delete" }),
    actionOf({ kind: "edit", name: "rename_file", label: "Rename" }),
  ];
  assert.deepEqual(actions, ["edit", "create", "delete", "rename"]);
  for (const action of actions) {
    assert.equal(groupKindForAction(action as ActivityAction), "editing");
  }
});

test("测试、类型检查、Lint 与构建命令归类为 verification", () => {
  const cases: Array<[string, ActivityAction]> = [
    ["npm test", "test"],
    ["npm run typecheck", "typecheck"],
    ["npm run lint", "lint"],
    ["npm run build", "build"],
  ];
  for (const [command, expected] of cases) {
    const action = actionOf({ kind: "execute", name: "run_command", label: command });
    assert.equal(action, expected, command);
    assert.equal(groupKindForAction(expected), "verification");
  }
});

test("普通命令归类为 command 而不是验证", () => {
  const action = actionOf({ kind: "execute", name: "run_command", label: "git status" });
  assert.equal(action, "run");
  assert.equal(groupKindForAction("run"), "command");
});

test("计划类工具不进时间线，交给计划文档", () => {
  assert.equal(classifyTool(tool({ kind: "plan", name: "update_plan", label: "Plan" })), undefined);
});

test("绝对路径被压成工作区相对路径，不进入呈现层", () => {
  const activity = classifyTool(
    tool({ kind: "read", name: "read_file", label: "Read", target: `${ROOT}/src/auth/session.ts` }),
    { workspaceRoot: ROOT },
  );
  assert.equal(activity?.target, "src/auth/session.ts");
  // 工作区外的绝对路径只留尾部片段，绝不整条泄漏。
  assert.equal(toRelativeTarget("E:/other/deep/nested/file.ts", ROOT), "nested/file.ts");
  assert.ok(!String(activity?.target).includes(ROOT));
});

// ---------------------------------------------------------------------------
// 合并与分组
// ---------------------------------------------------------------------------

test("同一 toolCallId 的开始与结束合并为一个条目", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 10);
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 20);
  builder.completeTool("c1", { success: true, at: 30 });

  const groups = builder.presentation.groups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.items.length, 1);
  assert.equal(groups[0]?.items[0]?.status, "completed");
  assert.equal(groups[0]?.items[0]?.completedAt, 30);
});

test("不同 toolCallId 与不同文件不会互相合并", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 1);
  builder.startTool({ toolCallId: "c2", action: "read", target: "src/a.ts" }, 2);
  builder.startTool({ toolCallId: "c3", action: "read", target: "src/b.ts" }, 3);

  const items = builder.presentation.groups[0]?.items ?? [];
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((item) => item.id)).size, 3);
});

test("语义变化就换组，read → edit → read 产生三组", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 1);
  builder.startTool({ toolCallId: "c2", action: "edit", target: "src/a.ts" }, 2);
  builder.startTool({ toolCallId: "c3", action: "read", target: "src/b.ts" }, 3);

  assert.deepEqual(
    builder.presentation.groups.map((group) => group.kind),
    ["exploration", "editing", "exploration"],
  );
});

test("同类活动连续到达时继续留在同一组", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 1);
  builder.startTool({ toolCallId: "c2", action: "search", target: "login" }, 2);
  assert.equal(builder.presentation.groups.length, 1);
});

test("计划步骤只作副标题，不替换固定主标题", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "edit", target: "src/a.ts" }, 1);
  builder.setSubtitle("修复 Runtime 生命周期");

  const group = builder.presentation.groups[0];
  assert.equal(group?.title, "修改代码");
  assert.equal(group?.subtitle, "修复 Runtime 生命周期");
});

test("组摘要按真实条目统计，同一文件读多次只算一个", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 1);
  builder.startTool({ toolCallId: "c2", action: "read", target: "src/a.ts" }, 2);
  builder.startTool({ toolCallId: "c3", action: "read", target: "src/b.ts" }, 3);
  builder.startTool({ toolCallId: "c4", action: "search", target: "login" }, 4);

  const group = builder.presentation.groups[0];
  assert.ok(group);
  assert.deepEqual(describeGroup(group), ["查看 2 个文件", "搜索 1 次"]);
});

// ---------------------------------------------------------------------------
// 真实统计
// ---------------------------------------------------------------------------

test("统计只认唯一路径与真实 toolCallId", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 1);
  builder.startTool({ toolCallId: "c2", action: "read", target: "src/a.ts" }, 2);
  builder.startTool({ toolCallId: "c3", action: "search", target: "login" }, 3);
  builder.startTool({ toolCallId: "c4", action: "search", target: "logout" }, 4);
  builder.startTool({ toolCallId: "c5", action: "run", target: "git status" }, 5);

  const summary = buildTurnSummary({ groups: builder.presentation.groups });
  assert.equal(summary.filesRead, 1);
  assert.equal(summary.searches, 2);
  assert.equal(summary.commandsRun, 1);
});

test("文件增删改数量只来自 ChangeTracker", () => {
  const summary = buildTurnSummary({
    groups: [],
    changes: { modified: 3, created: 1, deleted: 0 },
  });
  assert.equal(summary.filesModified, 3);
  assert.equal(summary.filesCreated, 1);
  assert.equal(summary.filesDeleted, undefined);
});

test("没有可靠 Diff 时不出现任何行数", () => {
  const summary = buildTurnSummary({ groups: [], changes: { modified: 3, created: 0, deleted: 0 } });
  assert.equal(summary.addedLines, undefined);
  assert.equal(summary.deletedLines, undefined);

  const text = describeTurnSummary(summary).join(" · ");
  assert.equal(text, "修改 3 个文件");
  assert.ok(!/[+-]\d/.test(text));
});

// ---------------------------------------------------------------------------
// 验证输出解析
// ---------------------------------------------------------------------------

test("结构明确的测试输出被正确解析", () => {
  const cases: Array<[string, string, number, number]> = [
    ["npm test", "# pass 296\n# fail 0\n", 296, 0],
    ["npx vitest run", "  Tests  2 failed | 294 passed (296)\n", 294, 2],
    ["npx jest", "Tests:       1 failed, 295 passed, 296 total\n", 295, 1],
    ["npx mocha", "  296 passing (2s)\n  2 failing\n", 296, 2],
    ["pytest", "===== 2 failed, 294 passed in 1.20s =====\n", 294, 2],
  ];
  for (const [command, output, passed, failed] of cases) {
    const result = parseVerification({ command, output, exitCode: failed > 0 ? 1 : 0 });
    assert.equal(result.testsPassed, passed, command);
    assert.equal(result.testsFailed, failed, command);
    assert.equal(result.status, failed > 0 ? "failed" : "passed", command);
  }
});

test("typecheck 输出里的 TS 报错判为失败", () => {
  const result = parseVerification({
    command: "npm run typecheck",
    output: "src/a.ts(3,1): error TS2304: Cannot find name 'foo'.",
    exitCode: 2,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.tool, "typescript");
  assert.equal(result.testsPassed, undefined);
});

test("认得出是测试命令但数不出数量时不编造数字", () => {
  const result = parseVerification({ command: "npm test", output: "全部完成", exitCode: 0 });
  assert.equal(result.status, "passed");
  assert.equal(result.testsPassed, undefined);
  assert.equal(result.testsFailed, undefined);

  const summary = buildTurnSummary({ groups: [], verification: result });
  assert.deepEqual(describeTurnSummary(summary), ["验证通过"]);
});

test("完全无法判断的输出返回 unavailable，界面不显示验证结论", () => {
  const result = parseVerification({ command: "git status", output: "nothing to commit" });
  assert.equal(result.status, "unavailable");

  const summary = buildTurnSummary({ groups: [], verification: result });
  assert.equal(summary.verificationStatus, "unavailable");
  assert.deepEqual(describeTurnSummary(summary), []);
});

test("多条验证命令合并为一个结论，数量累加", () => {
  const merged = mergeVerification([
    { status: "passed", testsPassed: 296, testsFailed: 0 },
    { status: "failed", testsPassed: 70, testsFailed: 5 },
    { status: "unavailable" },
  ]);
  assert.equal(merged.status, "failed");
  assert.equal(merged.testsPassed, 366);
  assert.equal(merged.testsFailed, 5);
});

// ---------------------------------------------------------------------------
// 状态与耗时
// ---------------------------------------------------------------------------

test("耗时按真实起止时间计算", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 1_000 });
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 1_100);
  builder.completeTool("c1", { success: true, at: 2_000 });
  builder.finish({ status: "completed", at: 360_000 });

  assert.equal(builder.presentation.durationMs, 359_000);
  assert.equal(formatDuration(359_000), "5 分 59 秒");
});

test("用户停止把运行中的条目与组一并置为已停止", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "edit", target: "src/a.ts" }, 10);
  builder.finish({ status: "stopped", at: 50 });

  const presentation = builder.presentation;
  assert.equal(presentation.status, "stopped");
  assert.equal(presentation.groups[0]?.status, "stopped");
  assert.equal(presentation.groups[0]?.items[0]?.status, "stopped");
});

test("工具失败让条目与组都变成失败", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "run", target: "npm run bad" }, 10);
  builder.completeTool("c1", { success: false, at: 20, exitCode: 1, detail: "命令不存在" });

  const group = builder.presentation.groups[0];
  assert.equal(group?.status, "failed");
  assert.equal(group?.items[0]?.status, "failed");
  assert.equal(group?.items[0]?.exitCode, 1);
  assert.equal(group?.items[0]?.detail, "命令不存在");
});

test("无对应工具调用的失败单独成组，不伪造条目", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.noteFailure({ title: "Agent 连接中断", detail: "子进程退出", at: 30 });

  const group = builder.presentation.groups[0];
  assert.equal(group?.kind, "failure");
  assert.equal(group?.title, "Agent 连接中断");
  assert.equal(group?.status, "failed");
  assert.equal(group?.items.length, 0);
});

// ---------------------------------------------------------------------------
// 序列化、恢复与中断
// ---------------------------------------------------------------------------

test("时间线序列化后能原样解析回来", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 1_000 });
  builder.startTool({ toolCallId: "c1", action: "read", target: "src/a.ts" }, 1_100);
  builder.completeTool("c1", { success: true, at: 1_500 });
  builder.finish({
    status: "completed",
    at: 2_000,
    summary: buildTurnSummary({ groups: builder.presentation.groups }),
  });

  const serialized = serializeTurnPresentation(builder.presentation);
  const parsed = parseTurnPresentation(JSON.parse(JSON.stringify(serialized)));
  assert.deepEqual(parsed, serialized);
  assert.equal(parsed?.summary?.filesRead, 1);
  assert.equal(parsed?.durationMs, 1_000);
});

test("落盘前脱敏并剥掉绝对路径", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "run", target: "deploy --token sk-secret" }, 1);
  builder.completeTool("c1", { success: false, at: 2, detail: "token sk-secret 无效" });
  // 目标里若混进绝对路径，序列化必须只留尾部片段。
  builder.startTool({ toolCallId: "c2", action: "read", target: "E:/work/demo/src/a.ts" }, 3);

  const serialized = serializeTurnPresentation(builder.presentation, {
    redact: (text) => text.replaceAll("sk-secret", "[redacted]"),
  });
  const all = JSON.stringify(serialized);
  assert.ok(!all.includes("sk-secret"));
  assert.ok(!all.includes("E:/work/demo"));
  assert.ok(all.includes("[redacted]"));
});

test("坏数据被丢弃而不是让整条时间线失效", () => {
  assert.equal(parseTurnPresentation({ turnId: "t1" }), undefined);
  const parsed = parseTurnPresentation({
    sessionId: "s1",
    turnId: "t1",
    status: "completed",
    startedAt: 1,
    groups: [
      { id: "g1", kind: "exploration", title: "探索代码库", status: "completed", startedAt: 1, items: [
        { id: "i1", toolCallId: "c1", action: "read", status: "completed", startedAt: 1 },
        { id: "i2", toolCallId: "c2", action: "不存在的动作", status: "completed", startedAt: 1 },
      ] },
      { id: "g2", kind: "无效分组", title: "x", status: "completed", startedAt: 1, items: [] },
    ],
  });
  assert.equal(parsed?.groups.length, 1);
  assert.equal(parsed?.groups[0]?.items.length, 1);
});

test("行数能落盘并原样恢复", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 1_000 });
  builder.startTool({ toolCallId: "c1", action: "edit", target: "src/a.ts" }, 1_100);
  builder.noteLineDiff("c1", { added: 12, deleted: 3 });
  builder.finish({ status: "completed", at: 1_200 });

  const raw = serializeTurnPresentation(builder.presentation);
  const parsed = parseTurnPresentation(raw);
  assert.deepEqual(parsed?.groups[0]?.items[0]?.lines, { added: 12, deleted: 3 });
});

test("残缺的行数记录整条丢掉，不补零", () => {
  const parsed = parseTurnPresentation({
    sessionId: "s1",
    turnId: "t1",
    status: "completed",
    startedAt: 1_000,
    groups: [
      {
        id: "ag-1",
        kind: "edit",
        title: "修改代码",
        status: "completed",
        startedAt: 1_000,
        items: [
          {
            id: "ai-1",
            toolCallId: "c1",
            action: "edit",
            status: "completed",
            startedAt: 1_000,
            lines: { added: 4 },
          },
        ],
      },
    ],
  });
  assert.equal(parsed?.groups[0]?.items[0]?.lines, undefined);
});

test("实时输出尾巴只挂在运行中的条目上，收尾即清", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 0 });
  builder.startTool({ toolCallId: "c1", action: "run", target: "npm test" }, 10);

  assert.equal(builder.noteOutputTail("c1", "测试 1 通过").length, 1);
  // 尾巴没变不发补丁，避免高频输出刷爆 Webview。
  assert.equal(builder.noteOutputTail("c1", "测试 1 通过").length, 0);
  assert.equal(builder.noteOutputTail("c1", "测试 2 通过").length, 1);
  assert.equal(builder.presentation.groups[0]?.items[0]?.outputTail, "测试 2 通过");

  builder.completeTool("c1", { success: true, at: 20 });
  assert.equal(builder.presentation.groups[0]?.items[0]?.outputTail, undefined, "收尾后尾巴必须清掉");
  // 收尾后再来的输出不再上屏。
  assert.equal(builder.noteOutputTail("c1", "迟到的输出").length, 0);
});

test("同样的行数不重复推送补丁", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 1_000 });
  builder.startTool({ toolCallId: "c1", action: "edit", target: "src/a.ts" }, 1_100);
  assert.equal(builder.noteLineDiff("c1", { added: 2, deleted: 1 }).length, 1);
  assert.equal(builder.noteLineDiff("c1", { added: 2, deleted: 1 }).length, 0);
  assert.equal(builder.noteLineDiff("c1", { added: 3, deleted: 1 }).length, 1);
  assert.equal(builder.noteLineDiff("unknown", { added: 1, deleted: 0 }).length, 0);
});

test("重启前仍在运行的轮次恢复为已中断，不伪装成完成", () => {
  const builder = new TimelineBuilder({ sessionId: "s1", turnId: "t1", startedAt: 1_000 });
  builder.startTool({ toolCallId: "c1", action: "edit", target: "src/a.ts" }, 1_200);

  const interrupted = interruptPresentation(builder.presentation);
  assert.equal(interrupted?.status, "interrupted");
  assert.equal(interrupted?.groups[0]?.items[0]?.status, "stopped");
  assert.equal(interrupted?.durationMs, 200);

  // 已经是终态的轮次不需要改写。
  builder.finish({ status: "completed", at: 2_000 });
  assert.equal(interruptPresentation(builder.presentation), undefined);
});

// ---------------------------------------------------------------------------
// TimelineService 接线
// ---------------------------------------------------------------------------

function createService(options: {
  changes?: { modified: number; created: number; deleted: number };
  planStep?: string;
} = {}) {
  const posted: HostToWebviewMessage[] = [];
  const persisted: unknown[] = [];
  const service = new TimelineService({
    post: (message) => posted.push(message),
    workspaceRoot: () => ROOT,
    changeCounts: () => options.changes,
    planStepTitle: () => options.planStep,
    persist: (presentation) => persisted.push(presentation),
  });
  return { service, posted, persisted };
}

function started(overrides: Partial<Extract<AgentEvent, { type: "tool_started" }>>): AgentEvent {
  return {
    type: "tool_started",
    toolCallId: "c1",
    name: "read_file",
    kind: "read",
    label: "Read",
    readOnly: true,
    ...overrides,
  };
}

test("一次工具调用的三类事件只推出一个条目", () => {
  const { service, posted } = createService();
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({ target: `${ROOT}/src/a.ts` }), 10);
  service.handleEvent({ type: "command_output", toolCallId: "c1", text: "读取中" }, 15);
  service.handleEvent({ type: "tool_completed", toolCallId: "c1", name: "read_file", success: true }, 20);

  const items = posted.filter((message) => message.type === "timelineItem");
  assert.equal(items.length, 2);
  const ids = new Set(items.map((message) => message.type === "timelineItem" ? message.item.id : ""));
  assert.equal(ids.size, 1, "started 与 completed 必须落在同一个 itemId 上");
});

test("模型私有推理与正文不进入时间线", () => {
  const { service, posted } = createService();
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  posted.length = 0;
  service.handleEvent({ type: "thought_delta", text: "我先假设登录模块有问题，然后……" }, 10);
  service.handleEvent({ type: "text_delta", text: "分析结果如下" }, 11);
  service.handleEvent({ type: "status", message: "会话：ses-abcdef12" }, 12);

  assert.deepEqual(posted, []);
});

test("验证命令的真实输出进入统计，普通命令不算验证", () => {
  const { service, persisted } = createService();
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({
    toolCallId: "c1", kind: "execute", name: "run_command", label: "npm test", readOnly: false,
  }), 10);
  service.handleEvent({ type: "command_output", toolCallId: "c1", text: "# pass 296\n# fail 0\n" }, 15);
  service.handleEvent({ type: "tool_completed", toolCallId: "c1", name: "run_command", success: true, exitCode: 0 }, 20);
  service.handleEvent(started({
    toolCallId: "c2", kind: "execute", name: "run_command", label: "git status", readOnly: false,
  }), 25);
  service.handleEvent({ type: "tool_completed", toolCallId: "c2", name: "run_command", success: true, exitCode: 0 }, 30);
  service.finish({ status: "completed", at: 40 });

  const presentation = persisted[0] as { summary?: Record<string, unknown>; groups: Array<{ kind: string }> };
  assert.equal(presentation.summary?.testsPassed, 296);
  assert.equal(presentation.summary?.verificationStatus, "passed");
  assert.equal(presentation.summary?.commandsRun, 1, "只有普通命令计入命令数");
  assert.deepEqual(presentation.groups.map((group) => group.kind), ["verification", "command"]);
});

function fileDiff(overrides: Partial<Extract<AgentEvent, { type: "file_diff" }>> = {}): AgentEvent {
  return {
    type: "file_diff",
    toolCallId: "c1",
    path: `${ROOT}/src/a.ts`,
    change: "modify",
    oldText: "a\nb\nc\n",
    newText: "a\nB\nc\n",
    pending: false,
    ...overrides,
  };
}

test("编辑事件的前后全文变成时间线上的 +N/-N", () => {
  const { service, posted } = createService({ changes: { modified: 1, created: 0, deleted: 0 } });
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({
    toolCallId: "c1", kind: "edit", name: "search_replace", label: "Edit", readOnly: false,
    target: `${ROOT}/src/a.ts`,
  }), 10);
  posted.length = 0;
  service.handleEvent(fileDiff(), 15);

  const items = posted.filter((message) => message.type === "timelineItem");
  const item = items.at(-1);
  assert.equal(item?.type === "timelineItem" ? item.item.lines?.added : undefined, 1);
  assert.equal(item?.type === "timelineItem" ? item.item.lines?.deleted : undefined, 1);
});

test("同一次编辑重复上报只保留最新行数，不累加", () => {
  const { service, persisted } = createService({ changes: { modified: 1, created: 0, deleted: 0 } });
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({
    toolCallId: "c1", kind: "edit", name: "search_replace", label: "Edit", readOnly: false,
    target: `${ROOT}/src/a.ts`,
  }), 10);
  // pending 阶段先报一半，落盘后报完整内容。
  service.handleEvent(fileDiff({ newText: "a\nB\nc\n", pending: true }), 15);
  service.handleEvent(fileDiff({ newText: "a\nB\nC\n", pending: false }), 16);
  service.finish({ status: "completed", at: 30 });

  const presentation = persisted[0] as { summary?: Record<string, unknown> };
  assert.equal(presentation.summary?.addedLines, 2);
  assert.equal(presentation.summary?.deletedLines, 2);
});

test("多个文件的行数在轮次摘要里合计", () => {
  const { service, persisted } = createService({ changes: { modified: 2, created: 0, deleted: 0 } });
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({
    toolCallId: "c1", kind: "edit", name: "search_replace", label: "Edit", readOnly: false,
    target: `${ROOT}/src/a.ts`,
  }), 10);
  service.handleEvent(fileDiff(), 12);
  service.handleEvent(started({
    toolCallId: "c2", kind: "edit", name: "search_replace", label: "Edit", readOnly: false,
    target: `${ROOT}/src/b.ts`,
  }), 14);
  service.handleEvent(fileDiff({
    toolCallId: "c2",
    path: `${ROOT}/src/b.ts`,
    change: "create",
    oldText: "",
    newText: "x\ny\n",
  }), 16);
  service.finish({ status: "completed", at: 30 });

  const presentation = persisted[0] as { summary?: Record<string, unknown> };
  assert.equal(presentation.summary?.addedLines, 3);
  assert.equal(presentation.summary?.deletedLines, 1);
});

test("换一轮不带上一轮的行数", () => {
  const { service, persisted } = createService({ changes: { modified: 1, created: 0, deleted: 0 } });
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({
    toolCallId: "c1", kind: "edit", name: "search_replace", label: "Edit", readOnly: false,
    target: `${ROOT}/src/a.ts`,
  }), 10);
  service.handleEvent(fileDiff(), 12);
  service.finish({ status: "completed", at: 20 });

  service.begin({ sessionId: "s1", turnId: "t2", at: 30 });
  service.handleEvent(started({
    toolCallId: "c9", kind: "execute", name: "run_command", label: "npm run build", readOnly: false,
  }), 32);
  service.finish({ status: "completed", at: 40 });

  const second = persisted[1] as { summary?: Record<string, unknown> };
  assert.equal(second.summary?.addedLines, undefined);
});

test("断线让轮次判失败并立即停表", () => {
  const { service, posted, persisted } = createService();
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({ target: `${ROOT}/src/a.ts` }), 10);
  service.noteDisconnected("Grok ACP 异常退出", 30);

  const turns = posted.filter((message) => message.type === "timelineTurn");
  const last = turns.at(-1);
  assert.equal(last?.type === "timelineTurn" ? last.turn.status : "", "failed");
  assert.equal(last?.type === "timelineTurn" ? last.turn.completedAt : 0, 30);
  assert.equal((persisted[0] as { status: string }).status, "failed");
  assert.equal(service.activeTurnId, undefined, "断线后不再有活跃轮次，计时随之停止");
});

test("重试开启新 turnId，旧轮次已落盘不受影响", () => {
  const { service, persisted } = createService();
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({ target: `${ROOT}/src/a.ts` }), 10);
  service.finish({ status: "completed", at: 20 });

  service.begin({ sessionId: "s1", turnId: "t2", at: 30 });
  assert.equal(service.activeTurnId, "t2");
  service.finish({ status: "completed", at: 40 });

  assert.deepEqual(persisted.map((item) => (item as { turnId: string }).turnId), ["t1", "t2"]);
  assert.equal((persisted[0] as { groups: unknown[] }).groups.length, 1);
});

test("轮次结束后仍未收尾的条目按失败处理，不假装完成", () => {
  const { service, persisted } = createService();
  service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  service.handleEvent(started({ target: `${ROOT}/src/a.ts` }), 10);
  service.finish({ status: "failed", at: 20 });

  const presentation = persisted[0] as { groups: Array<{ items: Array<{ status: string }> }> };
  assert.equal(presentation.groups[0]?.items[0]?.status, "failed");
});

test("计划步骤副标题只在能映射时出现", () => {
  const withPlan = createService({ planStep: "修复 Runtime 生命周期" });
  withPlan.service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  withPlan.service.handleEvent(started({ kind: "edit", name: "apply_patch", label: "Edit", readOnly: false }), 10);
  const groups = withPlan.posted.filter((message) => message.type === "timelineGroup");
  const header = groups.at(-1);
  assert.equal(header?.type === "timelineGroup" ? header.group.subtitle : "", "修复 Runtime 生命周期");
  assert.equal(header?.type === "timelineGroup" ? header.group.title : "", "修改代码");

  const withoutPlan = createService();
  withoutPlan.service.begin({ sessionId: "s1", turnId: "t1", at: 0 });
  withoutPlan.service.handleEvent(started({ kind: "edit", name: "apply_patch", label: "Edit", readOnly: false }), 10);
  const plain = withoutPlan.posted.filter((message) => message.type === "timelineGroup").at(-1);
  assert.equal(plain?.type === "timelineGroup" ? plain.group.subtitle : undefined, undefined);
});
