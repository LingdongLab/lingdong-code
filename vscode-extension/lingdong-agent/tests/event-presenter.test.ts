import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@lingdong/agent-runtime";
import { EventPresenter, statusTarget } from "../src/event-presenter";
import { classifyTool } from "../src/presentation/event-classifier";

test("模式与会话类状态只进日志，不刷对话区", () => {
  const presenter = new EventPresenter();
  assert.equal(statusTarget("客户端安全模式：agent"), "log");
  assert.equal(statusTarget("Grok 模式已切换为 agent"), "log");
  assert.equal(statusTarget("会话：修改首页标题"), "log");
  assert.deepEqual(presenter.present({ type: "status", message: "客户端安全模式：agent" }), []);
  assert.deepEqual(presenter.present({ type: "status", message: "Grok 模式已切换为 agent" }), []);
});

test("其他状态仍然作为提示展示", () => {
  const presenter = new EventPresenter();
  assert.equal(statusTarget("子进程已重启"), "chat");
  const messages = presenter.present({ type: "status", message: "子进程已重启" });
  assert.equal(messages[0]?.type, "notice");
});

test("含 sessionId / 绝对路径的状态只进日志", () => {
  assert.equal(statusTarget("会话已就绪：ses-abcdef123456"), "log");
  assert.equal(statusTarget("读取 E:\\ws\\src\\a.ts"), "log");
});

test("思考增量的折叠标题是脱敏文案，不含原文", () => {
  const presenter = new EventPresenter();
  const messages = presenter.present({ type: "thought_delta", text: "我需要先搜索 index.html 里的标题定义" });
  const activity = messages.find((message) => message.type === "activity");
  const text = activity?.type === "activity" ? activity.message : "";
  assert.equal(text, "正在查找相关文件…");
  assert.equal(text.includes("index.html"), false);
});

test("思考增量同时给出原文，供折叠区展开", () => {
  const presenter = new EventPresenter();
  const messages = presenter.present({ type: "thought_delta", text: "我需要先搜索 index.html" });
  const reasoning = messages.find((message) => message.type === "reasoningDelta");
  assert.equal(reasoning?.type === "reasoningDelta" ? reasoning.text : "", "我需要先搜索 index.html");
});

test("相同状态不重复刷标题，但原文仍逐段送出", () => {
  const presenter = new EventPresenter();
  presenter.present({ type: "thought_delta", text: "继续分析" });
  const repeated = presenter.present({ type: "thought_delta", text: "继续分析" });
  assert.equal(repeated.filter((message) => message.type === "activity").length, 0);
  assert.equal(repeated.filter((message) => message.type === "reasoningDelta").length, 1);
});

test("阶段文案统一用单个省略号", () => {
  const presenter = new EventPresenter();
  for (const text of ["随便想想", "我要读文件内容", "先制定计划", "总结一下"]) {
    const messages = presenter.present({ type: "thought_delta", text });
    const activity = messages.find((message) => message.type === "activity");
    if (activity?.type !== "activity") continue;
    assert.doesNotMatch(activity.message, /……/, activity.message);
    assert.match(activity.message, /…$/, activity.message);
  }
});

test("文本增量与完成事件按顺序映射", () => {
  const presenter = new EventPresenter();
  const delta = presenter.present({ type: "text_delta", text: "你好" });
  assert.deepEqual(delta, [{ type: "assistantDelta", text: "你好" }]);
  const done = presenter.present({ type: "completed", stopReason: "end_turn", modelId: "deepseek-v4-flash" });
  assert.deepEqual(done, [{ type: "assistantEnd", stopReason: "end_turn", modelId: "deepseek-v4-flash" }]);
});

test("权限事件只展示 Extension Host 已经做出的决定", () => {
  const presenter = new EventPresenter();
  const event: AgentEvent = {
    type: "permission_resolved",
    requestId: "0",
    resolution: "reject",
    automatic: true,
    reason: "Ask 模式只允许读取，不允许修改文件",
  };
  const messages = presenter.present(event);
  assert.equal(messages[0]?.type, "notice");
  const notice = messages[0];
  assert.equal(notice?.type === "notice" ? notice.level : "", "warn");
  assert.match(notice?.type === "notice" ? notice.message : "", /已拒绝/);
});

test("自动放行不进对话流，避免逐条通知刷屏", () => {
  const presenter = new EventPresenter();
  const allowed = presenter.present({
    type: "permission_resolved",
    requestId: "1",
    resolution: "allow_once",
    automatic: true,
    reason: "修改工作区内普通源文件",
  });
  assert.deepEqual(allowed, []);
  const byRule = presenter.present({
    type: "permission_resolved",
    requestId: "2",
    resolution: "allow_session",
    automatic: true,
    rule: { kind: "command-prefix", value: "npm test", label: "本次会话允许运行 npm test" },
    reason: "运行 npm test",
  });
  assert.deepEqual(byRule, []);
});

test("权限请求本身不由 Presenter 呈现，交给控制器排队", () => {
  const presenter = new EventPresenter();
  const messages = presenter.present({
    type: "permission_requested",
    requestId: "0",
    request: { sessionId: "s", toolCall: { kind: "edit" }, options: [] },
    label: "修改文件 index.html",
    reason: "Agent 模式的变更需要人工确认",
    decision: {
      action: "ask",
      operation: "write",
      operationKind: "write_file",
      label: "修改文件 index.html",
      reason: "Agent 模式的变更需要人工确认",
      policyReason: "修改工作区内普通源文件",
      explanation: {
        summary: "改写 index.html",
        steps: [{ command: "", action: "改写 index.html" }],
        notes: ["会新建或改写文件。"],
      },
      risk: "low",
      targets: ["E:\\ws\\index.html"],
      fingerprint: "abc",
      subject: {
        operation: "write",
        risk: "low",
        workspace: "E:\\ws",
        targets: ["E:\\ws\\index.html"],
        insideWorkspace: true,
      },
    },
  });
  assert.deepEqual(messages, []);
});

test("工具事件不再产出第二套记录，交由任务时间线呈现", () => {
  const presenter = new EventPresenter();
  const started = presenter.present({
    type: "tool_started",
    toolCallId: "t1",
    name: "read_file",
    kind: "read",
    label: "read_file",
    readOnly: true,
    target: "index.html",
  });
  const output = presenter.present({ type: "command_output", toolCallId: "t1", text: "内容" });
  const finished = presenter.present({ type: "tool_completed", toolCallId: "t1", name: "read_file", success: true });
  const changed = presenter.present({ type: "file_changed", path: "index.html", change: "modify" });

  // 工具呈现的唯一出口是 TimelineService；这里再产出 toolStarted 就会两套并存。
  assert.deepEqual([started, output, finished, changed], [[], [], [], []]);
});

test("未知形态的工具事件仍能被分类成可读动作", () => {
  // 原始工具名不可读时也必须落到确定动作上，否则真实活动会静默消失。
  assert.equal(
    classifyTool({ toolCallId: "t1", kind: "other", name: "mystery_op", label: "mystery_op", readOnly: true })?.action,
    "read",
  );
  assert.equal(
    classifyTool({ toolCallId: "t2", kind: "other", name: "mystery_op", label: "mystery_op", readOnly: false })?.action,
    "run",
  );
});
