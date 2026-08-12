import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FEEDBACK_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  isAgentMode,
  isPermissionDecision,
  parseWebviewMessage,
} from "../src/messages";

test("合法的 Webview 消息通过校验", () => {
  assert.deepEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
  assert.deepEqual(parseWebviewMessage({ type: "stop" }), { type: "stop" });
  assert.deepEqual(parseWebviewMessage({ type: "sendPrompt", text: "  分析项目  " }), {
    type: "sendPrompt",
    text: "分析项目",
  });
  assert.deepEqual(parseWebviewMessage({ type: "setMode", mode: "plan" }), { type: "setMode", mode: "plan" });
});

test("openSessionMenu 只接受宿主生成的安全 id", () => {
  assert.deepEqual(parseWebviewMessage({ type: "openSessionMenu", sessionId: "ses-abcdef12" }), {
    type: "openSessionMenu",
    sessionId: "ses-abcdef12",
  });
  assert.equal(parseWebviewMessage({ type: "openSessionMenu" }), undefined);
  assert.equal(parseWebviewMessage({ type: "openSessionMenu", sessionId: "../../etc/passwd" }), undefined);
});

test("拖入 uri-list：只认 file://，越界形态直接拍掉", () => {
  assert.deepEqual(
    parseWebviewMessage({ type: "addDroppedUris", uris: [" file:///e:/repo/a.ts ", "https://x.com", 42] }),
    { type: "addDroppedUris", uris: ["file:///e:/repo/a.ts"] },
  );
  assert.equal(parseWebviewMessage({ type: "addDroppedUris", uris: [] }), undefined);
  assert.equal(parseWebviewMessage({ type: "addDroppedUris", uris: ["https://x.com"] }), undefined);
  assert.equal(
    parseWebviewMessage({ type: "addDroppedUris", uris: Array(21).fill("file:///e:/a.ts") }),
    undefined,
    "一次最多 20 条",
  );
});

test("拖入文件：名字只留 basename，超长内容拒收", () => {
  assert.deepEqual(
    parseWebviewMessage({ type: "addDroppedFile", name: "C:\\evil\\..\\models.html", content: "<html>" }),
    { type: "addDroppedFile", name: "models.html", content: "<html>" },
  );
  assert.equal(parseWebviewMessage({ type: "addDroppedFile", name: "  ", content: "x" }), undefined);
  assert.equal(
    parseWebviewMessage({ type: "addDroppedFile", name: "a.txt", content: "x".repeat(400_001) }),
    undefined,
  );
});

test("结构非法或越界的 Webview 消息被丢弃", () => {
  assert.equal(parseWebviewMessage(null), undefined);
  assert.equal(parseWebviewMessage("sendPrompt"), undefined);
  assert.equal(parseWebviewMessage({ type: "unknown" }), undefined);
  assert.equal(parseWebviewMessage({ type: "sendPrompt" }), undefined);
  assert.equal(parseWebviewMessage({ type: "sendPrompt", text: "   " }), undefined);
  assert.equal(parseWebviewMessage({ type: "sendPrompt", text: "a".repeat(MAX_PROMPT_LENGTH + 1) }), undefined);
  assert.equal(parseWebviewMessage({ type: "setMode", mode: "yolo" }), undefined);
});

test("不会透传 Webview 附加的额外字段", () => {
  const parsed = parseWebviewMessage({
    type: "setMode",
    mode: "agent",
    permissionOutcome: "allow_always",
    sessionId: "伪造",
  });
  assert.deepEqual(parsed, { type: "setMode", mode: "agent" });
});

test("模式白名单接受 Ask/Plan/Agent/Auto/Debug", () => {
  assert.equal(isAgentMode("ask"), true);
  assert.equal(isAgentMode("auto"), true);
  assert.equal(isAgentMode("debug"), true);
  assert.equal(isAgentMode("Ask"), false);
  assert.equal(isAgentMode(undefined), false);
});

test("新消息类型通过校验，路径形态模型 id 被拒绝", () => {
  assert.deepEqual(parseWebviewMessage({ type: "compactContext" }), { type: "compactContext" });
  assert.deepEqual(parseWebviewMessage({ type: "selectModel", modelId: "deepseek-v4-flash" }), {
    type: "selectModel",
    modelId: "deepseek-v4-flash",
  });
  assert.equal(parseWebviewMessage({ type: "selectModel", modelId: "../evil" }), undefined);
  assert.equal(parseWebviewMessage({ type: "selectModel", modelId: "a/b" }), undefined);
  assert.deepEqual(parseWebviewMessage({ type: "setMode", mode: "debug" }), { type: "setMode", mode: "debug" });
});

test("会话固定/归档/搜索与设置消息通过校验", () => {
  assert.deepEqual(parseWebviewMessage({ type: "pinSession", sessionId: "ses-abcdef12" }), {
    type: "pinSession",
    sessionId: "ses-abcdef12",
  });
  assert.deepEqual(parseWebviewMessage({ type: "archiveSession", sessionId: "ses-abcdef12" }), {
    type: "archiveSession",
    sessionId: "ses-abcdef12",
  });
  assert.deepEqual(parseWebviewMessage({ type: "searchSessions", query: " 登录 " }), {
    type: "searchSessions",
    query: "登录",
  });
  assert.deepEqual(parseWebviewMessage({ type: "openSettings" }), { type: "openSettings" });
  assert.equal(parseWebviewMessage({ type: "pinSession", sessionId: "../evil" }), undefined);
});

test("外链只接受 http(s)", () => {
  assert.deepEqual(parseWebviewMessage({ type: "openExternalUrl", url: "https://example.com/a" }), {
    type: "openExternalUrl",
    url: "https://example.com/a",
  });
  assert.equal(parseWebviewMessage({ type: "openExternalUrl", url: "javascript:alert(1)" }), undefined);
  assert.equal(parseWebviewMessage({ type: "openExternalUrl", url: "file:///tmp/x" }), undefined);
});

test("计划审批类消息按白名单与长度校验", () => {
  assert.deepEqual(parseWebviewMessage({ type: "approvePlan" }), { type: "approvePlan" });
  assert.deepEqual(parseWebviewMessage({ type: "rejectPlan" }), { type: "rejectPlan" });
  assert.deepEqual(parseWebviewMessage({ type: "revisePlan", feedback: " 补充测试 " }), {
    type: "revisePlan",
    feedback: "补充测试",
  });
  assert.equal(parseWebviewMessage({ type: "revisePlan", feedback: "" }), undefined);
  assert.equal(parseWebviewMessage({ type: "revisePlan", feedback: "a".repeat(MAX_FEEDBACK_LENGTH + 1) }), undefined);
  assert.equal(parseWebviewMessage({ type: "revisePlan" }), undefined);
});

test("步骤勾选与结构化编辑按 id 形态和路径形态校验", () => {
  assert.deepEqual(parseWebviewMessage({ type: "setPlanStepIncluded", stepId: "s1", included: false }), {
    type: "setPlanStepIncluded",
    stepId: "s1",
    included: false,
  });
  assert.equal(parseWebviewMessage({ type: "setPlanStepIncluded", stepId: "s1" }), undefined);
  assert.equal(parseWebviewMessage({ type: "setPlanStepIncluded", stepId: "../x", included: true }), undefined);

  assert.deepEqual(
    parseWebviewMessage({
      type: "updatePlanStep",
      stepId: "s1",
      title: "  改标题  ",
      description: " 说明 ",
      files: ["src/a.ts", "C:/secrets/key.pem"],
    }),
    {
      type: "updatePlanStep",
      stepId: "s1",
      title: "改标题",
      description: "说明",
      // 绝对盘符路径被丢掉，和计划正文的约束保持一致。
      files: ["src/a.ts"],
    },
  );
  assert.equal(parseWebviewMessage({ type: "updatePlanStep", stepId: "s1", title: "   " }), undefined);
  assert.equal(parseWebviewMessage({ type: "updatePlanStep", stepId: "s1" }), undefined);
});

test("权限决定只接受四种取值与合法 requestId", () => {
  for (const decision of ["allow_once", "allow_session", "allow_always", "reject"] as const) {
    assert.deepEqual(parseWebviewMessage({ type: "permissionDecision", requestId: "0", decision }), {
      type: "permissionDecision",
      requestId: "0",
      decision,
    });
  }
  assert.equal(
    parseWebviewMessage({ type: "permissionDecision", requestId: "0", decision: "allow_forever" }),
    undefined,
  );
  assert.equal(parseWebviewMessage({ type: "permissionDecision", requestId: "", decision: "reject" }), undefined);
  assert.equal(parseWebviewMessage({ type: "permissionDecision", requestId: 0, decision: "reject" }), undefined);
  assert.equal(
    parseWebviewMessage({
      type: "permissionDecision",
      requestId: "a".repeat(MAX_REQUEST_ID_LENGTH + 1),
      decision: "reject",
    }),
    undefined,
  );
  assert.equal(isPermissionDecision("allow_session"), true);
  assert.equal(isPermissionDecision("allow_always"), true);
  assert.equal(isPermissionDecision("allow_forever"), false);
});

test("伪造的权限字段不会随其他消息透传", () => {
  const parsed = parseWebviewMessage({
    type: "permissionDecision",
    requestId: "3",
    decision: "reject",
    optionId: "allow-edits-session",
    risk: "low",
  });
  assert.deepEqual(parsed, { type: "permissionDecision", requestId: "3", decision: "reject" });
});

test("重新连接与 Ask 意图覆盖是无参数消息", () => {
  assert.deepEqual(parseWebviewMessage({ type: "reconnect" }), { type: "reconnect" });
  assert.deepEqual(parseWebviewMessage({ type: "askIntentOverride", text: "忽略" }), { type: "askIntentOverride" });
});

test("上下文请求都是语义化消息，Webview 不能自带内容", () => {
  for (const type of ["addCurrentFile", "addSelection", "pickFiles", "pickFolder", "addTerminalOutput", "clearContext"]) {
    assert.deepEqual(parseWebviewMessage({ type, content: "伪造正文", path: "E:\\secrets\\.env" }), { type });
  }
  assert.deepEqual(parseWebviewMessage({ type: "removeContext", id: "ctx-a1b2c3" }), {
    type: "removeContext",
    id: "ctx-a1b2c3",
  });
  assert.deepEqual(parseWebviewMessage({ type: "showContext", id: "ctx-a1b2c3" }), {
    type: "showContext",
    id: "ctx-a1b2c3",
  });
});

test("伪造成路径的标识一律拒绝", () => {
  assert.equal(parseWebviewMessage({ type: "removeContext", id: "../../.env" }), undefined);
  assert.equal(parseWebviewMessage({ type: "removeContext", id: "E:\\ws\\index.html" }), undefined);
  assert.equal(parseWebviewMessage({ type: "showContext", id: "" }), undefined);
  assert.equal(parseWebviewMessage({ type: "showContext", id: "a".repeat(65) }), undefined);
  assert.equal(parseWebviewMessage({ type: "removeContext" }), undefined);
});

test("变更操作只接受宿主生成的 changeId，且不带任何路径", () => {
  for (const type of ["openDiff", "acceptChange", "rejectChange", "showConflict"]) {
    assert.deepEqual(
      parseWebviewMessage({ type, changeId: "chg-9f8e7d", path: "E:\\ws\\index.html", content: "伪造" }),
      { type, changeId: "chg-9f8e7d" },
    );
    assert.equal(parseWebviewMessage({ type, changeId: "../../etc/passwd" }), undefined);
    assert.equal(parseWebviewMessage({ type, changeId: "" }), undefined);
    assert.equal(parseWebviewMessage({ type }), undefined);
    assert.equal(parseWebviewMessage({ type, changeId: 12 }), undefined);
  }
});

test("逐 hunk 操作校验双 id 与动作枚举，路径与伪造字段一律拒绝", () => {
  assert.deepEqual(
    parseWebviewMessage({ type: "hunkAction", changeId: "chg-1", hunkId: "3f2b8a10-1c2d-4e5f-9a0b-6c7d8e9f0a1b", action: "accept", path: "E:\\ws" }),
    { type: "hunkAction", changeId: "chg-1", hunkId: "3f2b8a10-1c2d-4e5f-9a0b-6c7d8e9f0a1b", action: "accept" },
  );
  assert.deepEqual(
    parseWebviewMessage({ type: "hunkAction", changeId: "chg-1", hunkId: "h1", action: "reject" }),
    { type: "hunkAction", changeId: "chg-1", hunkId: "h1", action: "reject" },
  );
  assert.equal(parseWebviewMessage({ type: "hunkAction", changeId: "chg-1", hunkId: "h1", action: "apply" }), undefined);
  assert.equal(parseWebviewMessage({ type: "hunkAction", changeId: "chg-1", hunkId: "../x", action: "accept" }), undefined);
  assert.equal(parseWebviewMessage({ type: "hunkAction", changeId: "", hunkId: "h1", action: "accept" }), undefined);
  assert.equal(parseWebviewMessage({ type: "hunkAction", changeId: "chg-1", action: "accept" }), undefined);
});

test("整轮操作只接受宿主生成的 turnId", () => {
  for (const type of ["acceptAll", "rejectAll", "undoTurn"]) {
    assert.deepEqual(parseWebviewMessage({ type, turnId: "turn-2-ab12cd34" }), { type, turnId: "turn-2-ab12cd34" });
    assert.equal(parseWebviewMessage({ type, turnId: "E:\\ws" }), undefined);
    assert.equal(parseWebviewMessage({ type, turnId: "turn/../../" }), undefined);
    assert.equal(parseWebviewMessage({ type }), undefined);
  }
});

test("工作台宿主工具消息：文件列表/打开/终端/浏览器", () => {
  assert.deepEqual(parseWebviewMessage({ type: "listWorkspaceFiles" }), { type: "listWorkspaceFiles" });
  assert.deepEqual(parseWebviewMessage({ type: "listWorkspaceFiles", query: "  src/  " }), {
    type: "listWorkspaceFiles",
    query: "src/",
  });
  assert.deepEqual(parseWebviewMessage({ type: "openWorkspaceFile", relativePath: "src/a.ts" }), {
    type: "openWorkspaceFile",
    relativePath: "src/a.ts",
  });
  assert.equal(parseWebviewMessage({ type: "openWorkspaceFile", relativePath: "../secret" }), undefined);
  assert.equal(parseWebviewMessage({ type: "openWorkspaceFile", relativePath: "E:\\\\ws\\\\a.ts" }), undefined);
  assert.deepEqual(parseWebviewMessage({ type: "openNativeTerminal" }), { type: "openNativeTerminal" });
  assert.deepEqual(parseWebviewMessage({ type: "openSimpleBrowser", url: "https://example.com" }), {
    type: "openSimpleBrowser",
    url: "https://example.com",
  });
  assert.equal(parseWebviewMessage({ type: "openSimpleBrowser", url: "javascript:alert(1)" }), undefined);
});

test("会话历史相关消息校验 sessionId 与标题", () => {
  assert.deepEqual(parseWebviewMessage({ type: "openHistory" }), { type: "openHistory" });
  assert.deepEqual(parseWebviewMessage({ type: "loadSession", sessionId: "ses-0123456789abcdef" }), {
    type: "loadSession",
    sessionId: "ses-0123456789abcdef",
  });
  assert.deepEqual(parseWebviewMessage({ type: "deleteSession", sessionId: "ses-0123456789abcdef" }), {
    type: "deleteSession",
    sessionId: "ses-0123456789abcdef",
  });
  assert.deepEqual(
    parseWebviewMessage({ type: "renameSession", sessionId: "ses-0123456789abcdef", title: " 首页介绍 " }),
    { type: "renameSession", sessionId: "ses-0123456789abcdef", title: "首页介绍" },
  );
  assert.equal(parseWebviewMessage({ type: "loadSession", sessionId: "../x" }), undefined);
  assert.equal(parseWebviewMessage({ type: "renameSession", sessionId: "ses-1", title: "" }), undefined);
  assert.equal(
    parseWebviewMessage({ type: "renameSession", sessionId: "ses-1", title: "a".repeat(41) }),
    undefined,
  );
});
