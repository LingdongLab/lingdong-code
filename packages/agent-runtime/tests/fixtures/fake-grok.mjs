// 最小 ACP 假实现，仅用于 Agent Runtime 单元测试，不涉及任何真实模型调用。
// 支持按提示词关键字发起反向请求：权限确认与退出计划模式。
import process from "node:process";

let buffer = "";
let pendingPrompt;
let sessionMode = "ask";
let swallowCancel = false;
const pendingReverse = new Map();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notifyChunk(sessionId, text) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
}

function finishPrompt(stopReason) {
  if (!pendingPrompt) return;
  const { id } = pendingPrompt;
  clearTimeout(pendingPrompt.timer);
  pendingPrompt = undefined;
  pendingReverse.clear();
  write({ jsonrpc: "2.0", id, result: { stopReason, _meta: { modelId: "deepseek-v4-flash" } } });
}

function requestEditPermission(sessionId, id, fileName) {
  pendingReverse.set(id, "permission");
  write({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: `tool-${id}`,
        title: "Edit",
        kind: "edit",
        rawInput: {
          variant: "SearchReplace",
          file_path: fileName,
          old_string: "旧标题",
          new_string: "新标题",
          description: "更新页面标题",
        },
        locations: [{ path: fileName }],
        _meta: { "x.ai/tool": { name: "search_replace", label: "Edit", kind: "edit", read_only: false } },
      },
      // 真实 0.2.118 会给出 allow_always；测试用它验证我们从不选择该项。
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-edits-session", name: "Allow edits this session", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}

function requestCommandPermission(sessionId, id, command) {
  pendingReverse.set(id, "permission");
  write({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: `tool-${id}`,
        title: "Run command",
        kind: "execute",
        rawInput: { variant: "Bash", command, description: "运行测试", is_background: false },
        _meta: { "x.ai/tool": { name: "run_terminal_command", label: "Run", kind: "execute", read_only: false } },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}

function requestReadPermission(sessionId, id, fileName) {
  pendingReverse.set(id, "permission");
  write({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: `tool-${id}`,
        title: "Read",
        kind: "read",
        rawInput: { variant: "Read", file_path: fileName, description: "读取文件" },
        locations: [{ path: fileName }],
        _meta: { "x.ai/tool": { name: "read_file", label: "Read", kind: "read", read_only: true } },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}

function requestPlanReview(sessionId, id, planContent) {
  pendingReverse.set(id, "plan");
  write({ jsonrpc: "2.0", id, method: "_x.ai/exit_plan_mode", params: { sessionId, toolCallId: `plan-${id}`, planContent } });
}

const SAMPLE_PLAN = [
  "# 更新首页标题",
  "",
  "## 目标",
  "把首页标题改成灵动 Code。",
  "",
  "## 需要修改的文件",
  "",
  "### 1. `index.html`",
  "- 修改 `<h1>` 文案",
  "",
  "### 2. `styles/site.css`",
  "- 同步标题字号",
  "",
  "## 验证方式",
  "- 手动打开页面确认",
  "",
  "## 备注",
  "- 风险：改动会影响首屏展示",
].join("\n");

function handlePrompt(id, params) {
  const sessionId = params?.sessionId ?? "fake-session";
  const text = (params?.prompt ?? []).map((part) => part?.text ?? "").join("");
  pendingPrompt = { id, timer: undefined };

  // 需要确认卡的用例统一用依赖安装：Agent 模式对标 Cursor 后，工作区内的文件写入
  // （含 package.json 这类清单）与构建、git commit 都自动放行，只有装依赖、访问网络
  // 与 high 风险动作还会产生确认卡。
  if (text.includes("两次权限")) {
    requestCommandPermission(sessionId, 0, "npm install left-pad");
    requestCommandPermission(sessionId, 1, "npm install ms");
    return;
  }
  if (text.includes("命令权限")) {
    requestCommandPermission(sessionId, 0, "npm install");
    return;
  }
  if (text.includes("再次命令")) {
    requestCommandPermission(sessionId, 0, "npm install --save-dev left-pad");
    return;
  }
  if (text.includes("确认权限")) {
    requestCommandPermission(sessionId, 0, "npm install lodash");
    return;
  }
  // 写入类用例（Ask 模式硬拒、Auto 模式自动放行前过钩子）仍需要一个 write 操作。
  if (text.includes("需要权限")) {
    requestEditPermission(sessionId, 0, "package.json");
    return;
  }
  if (text.includes("低风险写入")) {
    requestEditPermission(sessionId, 0, "index.html");
    return;
  }
  if (text.includes("读取权限")) {
    requestReadPermission(sessionId, 0, "index.html");
    return;
  }
  if (text.includes("同帧收尾")) {
    // 复现截断竞态：最后一段正文与 prompt 响应拼进同一次 stdout 写入。
    // 客户端若不按到达顺序串行处理，「完成」会抢在正文尾巴之前结束轮次。
    notifyChunk(sessionId, "第一段。");
    const tail = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "结尾一句。" } } },
    });
    const done = JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", _meta: { modelId: "deepseek-v4-flash" } } });
    process.stdout.write(`${tail}\n${done}\n`);
    pendingPrompt = undefined;
    return;
  }
  if (text.includes("静默挂死")) {
    // 永不回应也不发更新：静默看门狗应结束这一轮。
    return;
  }
  if (text.includes("缓慢输出")) {
    // 每 50ms 一段共 8 段：只要静默阈值大于间隔，长任务不得被误杀。
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      notifyChunk(sessionId, `第${count}段。`);
      if (count >= 8) {
        clearInterval(timer);
        finishPrompt("end_turn");
      }
    }, 50);
    return;
  }
  if (text.includes("取消不回包")) {
    // 收到 session/cancel 后既不回 prompt 响应也不退出：测 cancel 兜底合成完成。
    swallowCancel = true;
    return;
  }
  if (text.includes("空计划")) {
    requestPlanReview(sessionId, 100, "");
    return;
  }
  if (text.includes("给出计划")) {
    requestPlanReview(sessionId, 100, SAMPLE_PLAN);
    return;
  }

  notifyChunk(sessionId, "你好，");
  notifyChunk(sessionId, "这是流式回复。");
  pendingPrompt.timer = setTimeout(() => finishPrompt("end_turn"), 40);
}

function handleReverseResponse(message) {
  const kind = pendingReverse.get(message.id);
  if (!kind) return;
  pendingReverse.delete(message.id);
  const sessionId = "fake-session";
  const result = message.result ?? {};
  if (kind === "permission") {
    const outcome = result.outcome ?? {};
    const label = outcome.outcome === "selected" ? outcome.optionId : String(outcome.outcome ?? "unknown");
    notifyChunk(sessionId, `[permission:${label}]`);
  } else {
    notifyChunk(sessionId, `[plan:${String(result.outcome ?? "unknown")}]`);
    if (result.outcome === "approved") {
      sessionMode = "agent";
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "agent" } },
      });
    }
  }
  if (pendingReverse.size === 0) setTimeout(() => finishPrompt("end_turn"), 10);
}

function handle(message) {
  const { id, method, params } = message;
  if (method === undefined) {
    handleReverseResponse(message);
    return;
  }
  if (method === "initialize") {
    write({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { name: "fake-grok" }, agentCapabilities: {} } });
    return;
  }
  if (method === "session/new") {
    write({ jsonrpc: "2.0", id, result: { sessionId: "fake-session" } });
    return;
  }
  if (method === "session/set_mode") {
    sessionMode = params?.modeId ?? sessionMode;
    write({ jsonrpc: "2.0", id, result: {} });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: params?.sessionId ?? "fake-session", update: { sessionUpdate: "current_mode_update", currentModeId: sessionMode } },
    });
    return;
  }
  if (method === "session/set_model" || method === "session/load") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/prompt") {
    handlePrompt(id, params);
    return;
  }
  if (method === "session/cancel") {
    if (swallowCancel) return;
    pendingReverse.clear();
    finishPrompt("cancelled");
    return;
  }
  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
