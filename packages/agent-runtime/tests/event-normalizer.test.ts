import assert from "node:assert/strict";
import test from "node:test";
import { EventNormalizer, toDisplayKind, type AgentEvent } from "../src/event-normalizer.js";
import type { SessionUpdateParams } from "../src/protocol.js";

function update(payload: Record<string, unknown>): SessionUpdateParams {
  return { sessionId: "s1", update: payload };
}

function find<T extends AgentEvent["type"]>(events: AgentEvent[], type: T): Extract<AgentEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}

test("待办进度的状态使用中文，不外泄英文枚举", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "plan",
    entries: [
      { content: "读取 index.html", status: "completed" },
      { content: "修改标题", status: "in_progress" },
      { content: "运行校验", status: "pending" },
    ],
  }));
  const plan = find(events, "plan_updated");
  assert.ok(plan);
  assert.deepEqual(plan.plan.steps.map((step) => step.detail), ["状态：已完成", "状态：进行中", "状态：待处理"]);
});

test("待办进度同时保留结构化状态，供 UI 逐项勾选", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "plan",
    entries: [
      { content: "读取 index.html", status: "completed" },
      { content: "修改标题", status: "in_progress" },
      { content: "运行校验", status: "pending" },
    ],
  }));
  const plan = find(events, "plan_updated");
  assert.ok(plan);
  assert.deepEqual(plan.plan.steps.map((step) => step.status), ["completed", "in_progress", "pending"]);
});

test("陌生的状态值不带结构化状态，但文字兜底保留原样", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "plan",
    entries: [{ content: "神秘步骤", status: "half_done" }],
  }));
  const plan = find(events, "plan_updated");
  assert.ok(plan);
  assert.equal(plan.plan.steps[0]?.status, undefined, "无法归类的枚举不该传给 UI");
  assert.equal(plan.plan.steps[0]?.detail, "状态：half_done");
});

test("工具参数流第一条带 name 时立刻发出 tool_started", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_call_id: "call_write_1",
    tool_index: 0,
    name: "write",
  }));
  const started = find(events, "tool_started");
  assert.ok(started, "参数还没写完就该让 UI 知道在改文件");
  assert.equal(started.toolCallId, "call_write_1");
  assert.equal(started.name, "write");
  assert.equal(started.kind, "edit");
});

test("后续 arguments_delta 映射为 tool_progress，沿用同一 toolCallId", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_call_id: "call_write_1",
    tool_index: 0,
    name: "write",
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_index: 0,
    arguments_delta: '{"path":"models.html"',
  }));
  const progress = find(events, "tool_progress");
  assert.ok(progress);
  assert.equal(progress.toolCallId, "call_write_1");
  assert.equal(progress.name, "write");
  assert.equal(progress.target, "models.html", "参数流前缀就该抠出路径，状态栏才能显示具体文件");
});

test("跨多条 arguments_delta 拼出 path 后才带 target", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_call_id: "call_write_2",
    tool_index: 0,
    name: "write",
  }));
  const mid = normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_index: 0,
    arguments_delta: '{"pa',
  }));
  assert.equal(find(mid, "tool_progress")?.target, undefined);
  const done = normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_index: 0,
    arguments_delta: 'th":"src/app.ts","contents":"',
  }));
  assert.equal(find(done, "tool_progress")?.target, "src/app.ts");
});

test("正式 tool_call 到达时仍发出 tool_started（时间线按 id 去重）", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_call_id: "call_write_1",
    tool_index: 0,
    name: "write",
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call_write_1",
    title: "write",
    rawInput: { path: "models.html" },
    _meta: { "x.ai/tool": { name: "write", kind: "edit", label: "Write", read_only: false } },
  }));
  const started = find(events, "tool_started");
  assert.ok(started);
  assert.equal(started.target, "models.html");
  assert.equal(started.label, "Write");
});

test("diff 内容映射为文件变更事件", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    content: [{ type: "diff", path: "E:\\ws\\index.html", oldText: "旧", newText: "新" }],
  }));
  const changed = find(events, "file_changed");
  assert.equal(changed?.path, "E:\\ws\\index.html");
  assert.equal(changed?.change, "modify");
});

test("diff 内容同时产出带前后全文的 file_diff，未收尾时标为 pending", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "in_progress",
    content: [{ type: "diff", path: "E:\\ws\\a.ts", oldText: "旧", newText: "新" }],
  }));
  const diff = find(events, "file_diff");
  assert.equal(diff?.path, "E:\\ws\\a.ts");
  assert.equal(diff?.oldText, "旧");
  assert.equal(diff?.newText, "新");
  assert.equal(diff?.pending, true);
  assert.equal(diff?.change, "modify");
});

test("同一份 diff 重复到达只发一次；内容变了才再发", () => {
  const normalizer = new EventNormalizer();
  const first = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "in_progress",
    content: [{ type: "diff", path: "a.ts", oldText: "旧", newText: "新" }],
  }));
  assert.equal(first.filter((event) => event.type === "file_diff").length, 1);

  // Grok 的每条 update 都是全量 content，同一份 diff 会一遍遍重复。
  const repeat = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "in_progress",
    content: [{ type: "diff", path: "a.ts", oldText: "旧", newText: "新" }],
  }));
  assert.equal(repeat.filter((event) => event.type === "file_diff").length, 0);
  assert.equal(repeat.filter((event) => event.type === "file_changed").length, 0);

  const grown = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
    content: [{ type: "diff", path: "a.ts", oldText: "旧", newText: "新的更长" }],
  }));
  const diff = find(grown, "file_diff");
  assert.equal(diff?.newText, "新的更长");
  assert.equal(diff?.pending, false);
});

test("首条 tool_call 就带 diff 时也发预览事件（此时磁盘还没落笔）", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call_edit",
    title: "search_replace",
    content: [{ type: "diff", path: "a.ts", oldText: "", newText: "全新文件" }],
    _meta: { "x.ai/tool": { name: "search_replace", kind: "edit" } },
  }));
  const diff = find(events, "file_diff");
  assert.equal(diff?.change, "create");
  assert.equal(diff?.pending, true);
});

test("模式切换同时产出日志状态与结构化事件", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({ sessionUpdate: "current_mode_update", currentModeId: "agent" }));
  assert.equal(find(events, "status")?.message, "Grok 模式已切换为 agent");
  assert.equal(find(events, "mode_changed")?.mode, "agent");
});

test("_meta.totalTokens 映射为流式 token_usage", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize({
    sessionId: "s1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    _meta: { totalTokens: 11908 },
  });
  const usage = find(events, "token_usage");
  assert.ok(usage);
  assert.equal(usage.source, "stream");
  assert.equal(usage.totalTokens, 11908);
  assert.equal(find(events, "text_delta")?.text, "hi");
});

test("turn_completed usage 映射为精确 token_usage", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalizeExtensionUpdate({
    sessionId: "s1",
    update: {
      sessionUpdate: "turn_completed",
      stop_reason: "end_turn",
      usage: {
        inputTokens: 22744,
        outputTokens: 660,
        totalTokens: 23404,
        cachedReadTokens: 22528,
        reasoningTokens: 202,
        modelCalls: 2,
      },
    },
  });
  const usage = find(events, "token_usage");
  assert.ok(usage);
  assert.equal(usage.source, "exact");
  assert.equal(usage.inputTokens, 22744);
  assert.equal(usage.outputTokens, 660);
  assert.equal(usage.totalTokens, 23404);
  assert.equal(usage.cachedReadTokens, 22528);
  assert.equal(usage.reasoningTokens, 202);
  assert.equal(usage.modelCalls, 2);
});

test("子 Agent 相关工具都归到 subagent，不被 command 规则抢走", () => {
  assert.equal(toDisplayKind(undefined, "spawn_subagent"), "subagent");
  assert.equal(toDisplayKind(undefined, "Task"), "subagent");
  // 这三个名字里都带 command，以前会被 execute 规则先匹配掉。
  assert.equal(toDisplayKind("execute", "get_command_or_subagent_output"), "subagent");
  assert.equal(toDisplayKind("execute", "wait_commands_or_subagents"), "subagent");
  assert.equal(toDisplayKind("execute", "kill_command_or_subagent"), "subagent");
  // task_output 不是子 Agent 工具，^task$ 的锚点保证它不被误伤。
  assert.notEqual(toDisplayKind(undefined, "task_output"), "subagent");
  assert.equal(toDisplayKind(undefined, "run_terminal_cmd"), "execute");
});

test("派发子 Agent 时除 tool_started 外另发一条 subagent_started", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    _meta: { "x.ai/tool": { name: "spawn_subagent" } },
    rawInput: {
      description: "梳理构建脚本",
      subagent_type: "explore",
      background: true,
      prompt: "去看一遍 esbuild 配置",
    },
  }));
  const started = find(events, "subagent_started");
  assert.ok(started);
  assert.equal(started.toolCallId, "call-1");
  assert.equal(started.description, "梳理构建脚本");
  assert.equal(started.subagentType, "explore");
  assert.equal(started.background, true);
  assert.equal(find(events, "tool_started")?.kind, "subagent");
});

test("没写 description 时退到 prompt 首行，且不会长到撑坏卡片", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-2",
    _meta: { "x.ai/tool": { name: "spawn_subagent" } },
    rawInput: { prompt: `${"很长的一句任务描述".repeat(20)}\n第二行` },
  }));
  const started = find(events, "subagent_started");
  assert.ok(started);
  assert.ok(started.description.endsWith("…"), "过长的描述要截断");
  assert.ok(!started.description.includes("第二行"), "只取首行");
  assert.equal(started.background, false);
});

test("子 Agent 收尾把汇总回填到 subagent_completed", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-3",
    _meta: { "x.ai/tool": { name: "spawn_subagent" } },
    rawInput: { description: "查清构建流程" },
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-3",
    status: "completed",
    rawOutput: { output_for_prompt: "已确认入口是 esbuild.mjs。" },
  }));
  const done = find(events, "subagent_completed");
  assert.ok(done);
  assert.equal(done.success, true);
  assert.equal(done.summary, "已确认入口是 esbuild.mjs。");
});

test("后台子 Agent 的报告靠 task_id 认回派发它的那次调用", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn-1",
    _meta: { "x.ai/tool": { name: "spawn_subagent" } },
    rawInput: { description: "调研会员分档", background: true },
  }));
  // 派发是立刻返回的，返回里只有 task_id，不是结果。
  normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "spawn-1",
    status: "completed",
    rawOutput: { task_id: "task-77" },
  }));

  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "probe-1",
    _meta: { "x.ai/tool": { name: "get_command_or_subagent_output" } },
    rawInput: { task_ids: ["task-77"] },
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "probe-1",
    status: "completed",
    rawOutput: { output_for_prompt: "会员分三档，年付打八折。" },
  }));

  const output = find(events, "subagent_output");
  assert.ok(output, "取回的输出要认回子 Agent，否则任务卡上永远没有结论");
  assert.equal(output.toolCallId, "spawn-1");
  assert.equal(output.text, "会员分三档，年付打八折。");
});

test("一次取多个任务的输出不猜归属", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn-2",
    _meta: { "x.ai/tool": { name: "spawn_subagent" } },
    rawInput: { description: "调研竞品", background: true },
  }));
  normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "spawn-2",
    status: "completed",
    rawOutput: { task_id: "task-88" },
  }));
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "probe-2",
    _meta: { "x.ai/tool": { name: "get_command_or_subagent_output" } },
    rawInput: { task_ids: ["task-88", "task-99"] },
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "probe-2",
    status: "completed",
    rawOutput: { output_for_prompt: "两段输出混在一起，拆不开。" },
  }));

  assert.equal(find(events, "subagent_output"), undefined, "拆不开就不该贴到某一张卡上");
});

test("普通工具收尾不会误发 subagent_completed", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-4",
    _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-4",
    status: "completed",
    rawOutput: { output_for_prompt: "ok" },
  }));
  assert.equal(find(events, "subagent_completed"), undefined);
});

test("参数流里读出 description 就先建卡，且整场只建一次", () => {
  const normalizer = new EventNormalizer();
  const first = normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_index: 0,
    tool_call_id: "call-5",
    name: "spawn_subagent",
    arguments_delta: '{"description":"排查失败用例",',
  }));
  assert.equal(find(first, "subagent_started")?.description, "排查失败用例");

  // prompt 可以长达几百字，后续分片不该反复建卡。
  const later = normalizer.normalize(update({
    sessionUpdate: "tool_call_delta_chunk",
    tool_index: 0,
    arguments_delta: '"prompt":"先跑一遍 npm test',
  }));
  assert.equal(find(later, "subagent_started"), undefined);
});

function frames(events: AgentEvent[]) {
  return events
    .filter((event): event is Extract<AgentEvent, { type: "background_task" }> => event.type === "background_task")
    .map((event) => event.frame);
}

test("background:true 的 shell 立刻建卡，再用返回里的 task_id 补登记", () => {
  const normalizer = new EventNormalizer();
  const start = normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
    rawInput: { command: "npm run dev", background: true },
  }));
  assert.deepEqual(frames(start), [
    { phase: "started", toolCallId: "call-1", command: "npm run dev", kind: "command" },
  ]);

  const registered = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    rawOutput: { output_for_prompt: "Background task task-42 started. PID 1234." },
  }));
  assert.deepEqual(frames(registered), [
    { phase: "registered", toolCallId: "call-1", taskId: "task-42" },
  ]);
});

test("结构化 task_id 优先于文本解析", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    _meta: { "x.ai/tool": { name: "run_terminal_command" } },
    rawInput: { command: "npm test", background: true },
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    rawOutput: { task_id: "abc123", output_for_prompt: "Background task other-id started" },
  }));
  assert.deepEqual(
    frames(events).filter((frame) => frame.phase === "registered"),
    [{ phase: "registered", toolCallId: "call-1", taskId: "abc123" }],
  );
});

test("前台命令不建后台卡", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
    rawInput: { command: "npm test" },
  }));
  assert.deepEqual(frames(events), []);
});

test("monitor 天生常驻，不需要 background 标记", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    _meta: { "x.ai/tool": { name: "monitor" } },
    rawInput: { command: "tail -f app.log", description: "盯错误日志" },
  }));
  assert.deepEqual(frames(events), [
    { phase: "started", toolCallId: "call-1", command: "tail -f app.log", kind: "monitor" },
  ]);
});

test("取输出的返回接回对应任务卡，跑完了才 settle", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "probe-1",
    _meta: { "x.ai/tool": { name: "get_command_or_subagent_output" } },
    rawInput: { task_ids: ["task-42"] },
  }));

  // 还在跑：只回灌输出，不能 settle，否则卡片会提前变成「已完成」。
  const running = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "probe-1",
    rawOutput: { output_for_prompt: "Task still running after 3000 ms\nserver listening" },
  }));
  assert.deepEqual(frames(running), [
    { phase: "output", taskId: "task-42", text: "Task still running after 3000 ms\nserver listening" },
  ]);

  const done = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "probe-1",
    status: "completed",
    rawOutput: { output_for_prompt: "Task still running after 3000 ms\nserver listening\nTask completed in 900 ms with exit code: 1" },
  }));
  const exited = frames(done).find((frame) => frame.phase === "exited");
  assert.deepEqual(exited, { phase: "exited", taskId: "task-42", success: false, exitCode: 1 });
});

test("退出码为 0 视为成功", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "probe-1",
    _meta: { "x.ai/tool": { name: "get_command_or_subagent_output" } },
    rawInput: { task_ids: ["task-7"] },
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "probe-1",
    rawOutput: { output_for_prompt: "Task completed in 12 ms with exit code: 0" },
  }));
  assert.deepEqual(
    frames(events).find((frame) => frame.phase === "exited"),
    { phase: "exited", taskId: "task-7", success: true, exitCode: 0 },
  );
});

test("同一次取输出只 settle 一次", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "probe-1",
    _meta: { "x.ai/tool": { name: "get_command_or_subagent_output" } },
    rawInput: { task_ids: ["task-7"] },
  }));
  const first = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "probe-1",
    rawOutput: { output_for_prompt: "Task completed in 12 ms with exit code: 0" },
  }));
  const second = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "probe-1",
    status: "completed",
    rawOutput: { output_for_prompt: "Task completed in 12 ms with exit code: 0" },
  }));
  assert.equal(frames(first).filter((frame) => frame.phase === "exited").length, 1);
  assert.equal(frames(second).filter((frame) => frame.phase === "exited").length, 0);
});

test("终止成功才发 killed", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "kill-1",
    _meta: { "x.ai/tool": { name: "kill_command_or_subagent" } },
    rawInput: { task_id: "task-42" },
  }));
  const failed = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "kill-1",
    status: "failed",
  }));
  assert.deepEqual(frames(failed), []);

  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "kill-2",
    _meta: { "x.ai/tool": { name: "kill_command_or_subagent" } },
    rawInput: { task_id: "task-43" },
  }));
  const ok = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "kill-2",
    status: "completed",
  }));
  assert.deepEqual(frames(ok), [{ phase: "killed", taskId: "task-43" }]);
});

test("解析不出 task_id 时不发登记帧，卡片仍然存在", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
    rawInput: { command: "npm run dev", background: true },
  }));
  const events = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    rawOutput: { output_for_prompt: "已在后台启动。" },
  }));
  assert.deepEqual(frames(events), []);
});

test("context_compacted 扩展更新映射为结构化事件", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalizeExtensionUpdate({
    sessionId: "s1",
    update: { sessionUpdate: "context_compacted", trigger: "manual", detail: "窗口已满" },
  });
  const compacted = find(events, "context_compacted");
  assert.ok(compacted);
  assert.equal(compacted.trigger, "manual");
  assert.equal(compacted.detail, "窗口已满");
});

// —— incrementalBashOutput：rawOutput.output_delta 增量通道 ——
// 报文形状来自 grok 源码 BashOutput（output/output_delta 是字节数组，
// output_for_prompt 是 ANSI 剥离后的全量文本）与探针实录。

const bytes = (text: string): number[] => [...Buffer.from(text, "utf8")];

test("output_delta 增量帧直接作为 command_output，不做前缀比对", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call",
    toolCallId: "bash-1",
    _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
    rawInput: { command: "npm test" },
  }));
  const first = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-1",
    status: "in_progress",
    rawOutput: { output: [], output_for_prompt: "第一段", output_delta: bytes("第一段") },
  }));
  assert.equal(find(first, "command_output")?.text, "第一段");
  const second = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-1",
    status: "in_progress",
    rawOutput: { output: [], output_for_prompt: "第一段第二段", output_delta: bytes("第二段") },
  }));
  assert.equal(find(second, "command_output")?.text, "第二段", "增量帧只发新增的这一段");
});

test("空 output_delta 是清空缓冲的重置信号，不产生输出事件", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-2",
    status: "in_progress",
    rawOutput: { output: [], output_delta: bytes("旧内容") },
  }));
  const reset = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-2",
    status: "in_progress",
    rawOutput: { output: [], output_delta: [] },
  }));
  assert.equal(find(reset, "command_output"), undefined, "重置信号不该刷出一条空输出");
  const after = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-2",
    status: "in_progress",
    rawOutput: { output: [], output_delta: bytes("新内容") },
  }));
  assert.equal(find(after, "command_output")?.text, "新内容");
});

test("走过增量通道后，收尾的全量帧不再重复追加输出", () => {
  const normalizer = new EventNormalizer();
  normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-3",
    status: "in_progress",
    rawOutput: { output: [], output_delta: bytes("一二三") },
  }));
  // 收尾帧带 ANSI 剥离 + 软换行后的全量 output_for_prompt，与增量缓冲对不上前缀。
  const final = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-3",
    status: "completed",
    rawOutput: { output_for_prompt: "一二\n三", exit_code: 0 },
  }));
  assert.equal(find(final, "command_output"), undefined, "全量兜底不该把整段输出再刷一遍");
  assert.equal(find(final, "tool_completed")?.exitCode, 0);
});

test("没有 output_delta 时沿用全量前缀比对的旧路径", () => {
  const normalizer = new EventNormalizer();
  const first = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-4",
    status: "in_progress",
    rawOutput: { output_for_prompt: "开头" },
  }));
  assert.equal(find(first, "command_output")?.text, "开头");
  const second = normalizer.normalize(update({
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-4",
    status: "in_progress",
    rawOutput: { output_for_prompt: "开头接着" },
  }));
  assert.equal(find(second, "command_output")?.text, "接着");
});
