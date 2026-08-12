import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { WebviewToHostMessage } from "../src/messages";
import { ConversationView, type RenderUnit } from "../src/webview/conversation";
import { element } from "../src/webview/dom-utils";

interface Harness {
  document: Document;
  view: ConversationView;
  inner: HTMLElement;
  sent: WebviewToHostMessage[];
}

function createHarness(canSend = true): Harness {
  const dom = new JSDOM(`<!DOCTYPE html>
    <div id="messages"><div id="messages-inner"><div id="empty">空</div></div></div>`);
  const { window } = dom;
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Node", { value: window.Node, configurable: true });
  Object.defineProperty(globalThis, "Event", { value: window.Event, configurable: true });

  const sent: WebviewToHostMessage[] = [];
  const document = window.document;
  const view = new ConversationView({
    el: {
      messages: document.getElementById("messages") as HTMLElement,
      messagesInner: document.getElementById("messages-inner") as HTMLElement,
      empty: document.getElementById("empty") as HTMLElement,
    },
    post: (message) => sent.push(message),
    canSend: () => canSend,
    onOpenLink: () => undefined,
    onOpenFile: () => undefined,
    onViewPlan: () => undefined,
  });
  return { document, view, inner: document.getElementById("messages-inner") as HTMLElement, sent };
}

function units(count: number, log: string[]): RenderUnit[] {
  return Array.from({ length: count }, (_, index) => () => {
    log.push(`unit-${index}`);
    (globalThis.document.getElementById("messages-inner") as HTMLElement).appendChild(
      element("div", "message", `第 ${index} 条`),
    );
  });
}

test("恢复长会话只渲染尾部一页", () => {
  const { view, inner } = createHarness();
  const log: string[] = [];
  const rendered = view.renderHistory(units(100, log), 20);

  assert.equal(rendered, 20, "只应立即渲染最后 20 条");
  assert.equal(log.length, 20);
  assert.equal(log[0], "unit-80");
  const button = inner.querySelector(".history-more");
  assert.ok(button, "应出现「加载更早消息」按钮");
  assert.match(button!.textContent ?? "", /还有 80 条/);
});

test("加载更早消息按页补渲染并插在按钮之后", () => {
  const { view, inner } = createHarness();
  const log: string[] = [];
  view.renderHistory(units(50, log), 20);
  log.length = 0;

  view.loadEarlierHistory(20);
  assert.equal(log.length, 20, "一次补一页");
  assert.equal(log[0], "unit-10");
  const page = inner.querySelector(".history-page");
  assert.ok(page, "补渲染内容应放进历史分页容器");
  assert.equal(inner.firstElementChild?.className, "history-more", "按钮仍在最上方");
  assert.match(inner.querySelector(".history-more")!.textContent ?? "", /还有 10 条/);

  view.loadEarlierHistory(20);
  assert.equal(inner.querySelector(".history-more"), null, "全部加载后按钮消失");
});

test("条目不足一页时不出现加载按钮", () => {
  const { view, inner } = createHarness();
  view.renderHistory(units(5, []), 20);
  assert.equal(inner.querySelector(".history-more"), null);
});

test("流式气泡封口后新内容接在其后", () => {
  const { view, inner } = createHarness();
  view.appendAssistantDelta("正文");
  view.sealStreaming();
  view.appendRow("notice info", "工具已完成");

  const classes = Array.from(inner.children).map((node) => node.className);
  const assistant = classes.findIndex((name) => name.includes("assistant-msg"));
  const notice = classes.findIndex((name) => name.includes("notice"));
  assert.ok(assistant >= 0 && notice > assistant, "提示行必须排在助手气泡之后");
});

test("忙碌时重试给出提示而不是重复发送", () => {
  const { view, sent } = createHarness(false);
  view.appendUserMessage("原始问题");
  view.retryLast();
  assert.deepEqual(sent, [], "不应重复发送");
});

test("空闲时重试会重新发送最近一条用户消息", () => {
  const { view, sent } = createHarness(true);
  view.appendUserMessage("原始问题");
  view.retryLast();
  assert.deepEqual(sent, [{ type: "sendPrompt", text: "原始问题" }]);
});

test("权限结论已展示后抑制紧随的重复通知", () => {
  const { view } = createHarness();
  view.renderPermission(
    {
      requestId: "req-1",
      operation: "write",
      risk: "medium",
      title: "修改文件",
      steps: [{ command: "", action: "改写 index.html" }],
      notes: ["会新建或改写文件。"],
      allowSession: true,
      allowAlways: true,
    },
    0,
  );
  view.resolvePermission("req-1", "已允许一次");
  assert.equal(view.shouldSuppressNotice("已允许一次"), true);
  assert.equal(view.shouldSuppressNotice("已允许一次"), false, "只抑制紧随其后的一条");
});

test("权限卡决定后收拢成一行结论", () => {
  const { view, inner } = createHarness();
  view.renderPermission(
    {
      requestId: "req-2",
      operation: "execute",
      risk: "medium",
      title: "执行命令 npm install",
      steps: [{ command: "npm install", action: "按 package.json 把依赖装进 node_modules" }],
      notes: ["会联网下载依赖包，包自带的安装脚本也会在你机器上跑起来。"],
      allowSession: true,
      allowAlways: true,
      command: "npm install",
    },
    0,
  );
  const card = inner.querySelector(".card.permission") as HTMLElement;
  view.resolvePermission("req-2", "已允许一次");
  assert.ok(card.classList.contains("card-collapsed"));
  assert.equal(card.querySelector(".card-collapsed-text")?.textContent, "执行命令 npm install · 已允许一次");
  assert.equal(card.querySelectorAll("button").length, 0, "收拢后不保留按钮");
});

test("权限卡讲人话：安全结论 + 会做什么 + 要注意，不再只甩一个风险等级", () => {
  const { view, inner } = createHarness();
  view.renderPermission(
    {
      requestId: "req-3",
      operation: "execute",
      risk: "low",
      title: "执行命令 git status",
      command: "git status",
      cwd: "E:\\ws",
      steps: [{ command: "git status", action: "看一下工作区里哪些文件被改过" }],
      notes: ["只读取信息，不会改动任何文件。"],
      allowSession: true,
      allowAlways: true,
    },
    0,
  );
  const card = inner.querySelector(".card.permission") as HTMLElement;
  assert.equal(card.querySelector(".badge")?.textContent, "可放心执行", "结论要说安全不安全，不说等级");
  assert.ok(card.classList.contains("tone-safe"));
  assert.equal(card.querySelector(".perm-step-single")?.textContent, "看一下工作区里哪些文件被改过");
  assert.equal(card.querySelector(".perm-notes li")?.textContent, "只读取信息，不会改动任何文件。");
  assert.match(card.querySelector(".perm-meta")?.textContent ?? "", /E:\\ws/);
  assert.equal(card.textContent?.includes("低风险"), false, "旧的等级文案不该再出现");
});

test("同一 requestId 重复下发不追加第二张卡", () => {
  const { view, inner } = createHarness();
  const card = {
    requestId: "req-dup",
    operation: "execute" as const,
    risk: "medium" as const,
    title: "执行命令 npm install",
    command: "npm install",
    steps: [{ command: "npm install", action: "按 package.json 把依赖装进 node_modules" }],
    notes: ["会联网下载依赖包，包自带的安装脚本也会在你机器上跑起来。"],
    allowSession: true,
    allowAlways: true,
  };
  view.renderPermission(card, 0);
  view.renderPermission(card, 0);
  assert.equal(inner.querySelectorAll(".card.permission").length, 1, "重复下发只该留一张卡");

  // 关键是结论要能收拢那唯一一张：先前的 bug 里旧卡的按钮一直可点。
  view.resolvePermission("req-dup", "已允许一次");
  const rendered = inner.querySelectorAll(".card.permission");
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0]?.querySelectorAll("button").length, 0, "不该有留着能点的按钮");
});

test("高风险卡走危险配色，结论也换成有风险", () => {
  const { view, inner } = createHarness();
  view.renderPermission(
    {
      requestId: "req-4",
      operation: "execute",
      risk: "high",
      title: "执行命令 rm -rf dist",
      command: "rm -rf dist",
      steps: [{ command: "rm -rf dist", action: "删除 dist，连里面的内容一起删" }],
      notes: ["会删除文件，删掉之后没法自动找回。"],
      allowSession: false,
      allowAlways: false,
    },
    0,
  );
  const card = inner.querySelector(".card.permission") as HTMLElement;
  assert.equal(card.querySelector(".badge")?.textContent, "有风险");
  assert.ok(card.classList.contains("tone-danger"));
});

test("链式命令逐步编号，每步带上自己的命令段", () => {
  const { view, inner } = createHarness();
  view.renderPermission(
    {
      requestId: "req-5",
      operation: "execute",
      risk: "medium",
      title: "执行命令 git add -A && git commit -m 改完了",
      command: 'git add -A && git commit -m "改完了"',
      steps: [
        { command: "git add -A", action: "把所有改动加进待提交列表" },
        { command: 'git commit -m "改完了"', action: "把待提交的改动提交到本地仓库" },
      ],
      notes: ["会改动 Git 仓库的状态。"],
      allowSession: true,
      allowAlways: true,
    },
    0,
  );
  const card = inner.querySelector(".card.permission") as HTMLElement;
  const steps = card.querySelectorAll(".perm-steps li");
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.querySelector(".perm-step-cmd")?.textContent, "git add -A");
  assert.equal(steps[1]?.querySelector(".perm-step-action")?.textContent, "把待提交的改动提交到本地仓库");
});

test("模型自述的意图单独标出处，不混进本地推导的说明里", () => {
  const { view, inner } = createHarness();
  view.renderPermission(
    {
      requestId: "req-6",
      operation: "execute",
      risk: "medium",
      title: "执行命令 npm install",
      command: "npm install",
      steps: [{ command: "npm install", action: "按 package.json 把依赖装进 node_modules" }],
      notes: ["会联网下载依赖包，包自带的安装脚本也会在你机器上跑起来。"],
      intent: "补上缺失的依赖再跑测试",
      allowSession: true,
      allowAlways: true,
    },
    0,
  );
  const card = inner.querySelector(".card.permission") as HTMLElement;
  const intent = card.querySelector(".perm-intent")?.textContent ?? "";
  assert.match(intent, /^模型说这么做是为了：/, "必须标明这句话是模型自己写的");
  assert.match(intent, /补上缺失的依赖再跑测试/);
  assert.equal(
    card.querySelector(".perm-notes")?.textContent?.includes("补上缺失的依赖"),
    false,
    "模型的说法不能出现在本地推导的提示里",
  );
});

test("Debug 确认卡点击后收拢并发送确认消息", () => {
  const { view, inner, sent } = createHarness();
  view.renderDebugConfirm();
  const card = inner.querySelector(".card:not(.permission)") as HTMLElement;
  const confirm = card.querySelector("button") as HTMLButtonElement;
  confirm.click();
  assert.deepEqual(sent, [{ type: "confirmDebugFix" }]);
  assert.ok(card.classList.contains("card-collapsed"));
  assert.equal(card.contains(confirm), false, "收拢后按钮已随卡片内容移除，无法重复点击");
});

/** 让滚动容器模拟「用户已滚离底部」：内容高 1000、视口 200、停在顶部。 */
function scrollAway(document: Document): HTMLElement {
  const messages = document.getElementById("messages") as HTMLElement;
  Object.defineProperty(messages, "scrollHeight", { value: 1_000, configurable: true });
  Object.defineProperty(messages, "clientHeight", { value: 200, configurable: true });
  let top = 0;
  Object.defineProperty(messages, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value; },
  });
  messages.dispatchEvent(new Event("scroll"));
  return messages;
}

test("用户滚离底部后新内容不强制拉底，出现回到最新消息按钮", () => {
  const { view, document } = createHarness();
  const messages = scrollAway(document);
  assert.equal(view.sticking, false, "离底后不再粘底");

  view.appendRow("notice info", "新内容");
  assert.equal(messages.scrollTop, 0, "非粘底状态下插入内容不应拉底");
  const wrap = messages.querySelector(".jump-bottom-wrap") as HTMLElement;
  assert.equal(wrap.hidden, false, "应显示回到最新消息按钮");
  // 按钮上带的是漏掉的条数，这样用户知道自己错过了多少而不只是「有新的」。
  assert.match((wrap.querySelector(".jump-bottom") as HTMLButtonElement).textContent ?? "", /1 条新消息/);

  (wrap.querySelector(".jump-bottom") as HTMLButtonElement).click();
  assert.equal(messages.scrollTop, 1_000, "点击后滚到底");
  assert.equal(view.sticking, true);
  assert.equal(wrap.hidden, true, "回到最新后按钮隐藏");
});

test("粘底状态下新内容自动拉底", () => {
  const { view, document } = createHarness();
  const messages = scrollAway(document);
  // 用户滚回底部：scrollTop 接近底 → scroll 事件恢复粘底。
  messages.scrollTop = 900;
  messages.dispatchEvent(new Event("scroll"));
  assert.equal(view.sticking, true);

  messages.scrollTop = 500; // 模拟内容插入前的位置
  view.appendRow("notice info", "新内容");
  assert.equal(messages.scrollTop, 1_000, "粘底时新内容拉底");
});

test("清空会话同时清掉分页与工具状态", () => {
  const { view, inner } = createHarness();
  view.renderHistory(units(40, []), 10);
  view.clear();
  assert.equal(inner.querySelector(".history-more"), null);
  assert.equal(inner.children.length, 1, "只保留空态节点");
});

test("旧会话没有时间线时仍回退到旧版工具摘要", () => {
  const { view, inner } = createHarness();
  const { group } = view.tools.start({
    toolCallId: "c1",
    kind: "read",
    label: "Read",
    target: "src/a.ts",
    readOnly: true,
    at: 0,
  });
  view.paintToolGroup(group.id);

  assert.equal(view.usesTimeline, false);
  assert.equal(inner.querySelectorAll("details.tool-summary").length, 1);
});

test("时间线一旦出现，旧版工具摘要不再渲染，杜绝两套工具记录", () => {
  const { view, inner } = createHarness();
  view.applyTimelineTurn({ sessionId: "s1", turnId: "t1", status: "running", startedAt: 0 });
  view.applyTimelineGroup("t1", {
    id: "g1",
    kind: "exploration",
    title: "探索代码库",
    status: "running",
    startedAt: 0,
  });

  // 同一轮里若旧路径也收到工具事件，必须被忽略而不是并列显示。
  const { group } = view.tools.start({
    toolCallId: "c1",
    kind: "read",
    label: "Read",
    target: "src/a.ts",
    readOnly: true,
    at: 0,
  });
  view.paintToolGroup(group.id);

  assert.equal(view.usesTimeline, true);
  assert.equal(inner.querySelectorAll("details.tool-summary").length, 0);
  assert.equal(inner.querySelectorAll("section.timeline").length, 1);
});

// ---------------------------------------------------------------------------
// 可展开推理链
// ---------------------------------------------------------------------------

test("推理原文折叠在思考块里，标题仍是脱敏文案", () => {
  const { view, inner } = createHarness();
  view.showThinking("正在查找相关文件…");
  view.appendReasoning("先看 index.html 的标题定义");

  const block = inner.querySelector("details.thinking-block");
  assert.ok(block, "应有思考折叠块");
  assert.equal((block as HTMLDetailsElement).open, false, "默认折叠，不主动摊开原文");
  assert.equal(block!.querySelector(".thinking-label")?.textContent, "正在查找相关文件…");
  assert.equal(block!.querySelector(".thinking-reasoning")?.textContent, "先看 index.html 的标题定义");

  // showThinking 会起一个 1s 的计时器；不收尾进程就退不出去。
  view.finishThinking();
});

test("多段原文按顺序拼接", () => {
  const { view, inner } = createHarness();
  view.appendReasoning("第一段。");
  view.appendReasoning("第二段。");
  assert.equal(
    inner.querySelector(".thinking-reasoning")?.textContent,
    "第一段。第二段。",
  );
});

test("没有原文时不留空的展开区", () => {
  const { view, inner } = createHarness();
  view.showThinking("正在整理回答…");
  assert.equal(inner.querySelector(".thinking-reasoning"), null);
  view.finishThinking();
});

test("空字符串不建块", () => {
  const { view, inner } = createHarness();
  view.appendReasoning("");
  assert.equal(inner.querySelector("details.thinking-block"), null);
});

test("只有原文、没有阶段文案的块也会保留下来", () => {
  const { view, inner } = createHarness();
  view.appendReasoning("一段推理");
  view.finishThinking();

  const block = inner.querySelector("details.thinking-block");
  assert.ok(block, "有原文就不该被当成空块删掉");
  assert.equal(block!.querySelector(".thinking-reasoning")?.textContent, "一段推理");
});

test("原文超长时只留尾部，不让会话流被撑爆", () => {
  const { view, inner } = createHarness();
  view.appendReasoning("A".repeat(19_990));
  view.appendReasoning(`${"B".repeat(30)}尾巴`);

  const text = inner.querySelector(".thinking-reasoning")?.textContent ?? "";
  assert.equal(text.length, 20_000);
  assert.ok(text.endsWith("尾巴"), "保留的必须是最新的那一段");
});

/**
 * 线上翻过的车：模型把推理和正文交替吐出来，界面上就多出一串
 * 「思考完成」卡片，一句话被切成九张，正文也跟着碎成九段。
 * 一轮只该有一个思考块。
 */
test("推理与正文交替到达时只留一个思考块", () => {
  const { view, inner } = createHarness();
  view.appendReasoning("用 D");
  view.appendAssistantDelta("uckDuckGo HTML ");
  view.appendReasoning("可用");
  view.appendAssistantDelta("。将搜索结果保存");
  view.appendReasoning("到临时目录");
  view.appendAssistantDelta("，再用 grep 提取标题");

  assert.equal(inner.querySelectorAll("details.thinking-block").length, 1, "不该每次切换都新起一张卡");
  assert.equal(
    inner.querySelector(".thinking-reasoning")?.textContent,
    "用 D可用到临时目录",
    "后续推理要接进同一个块",
  );
  view.finishThinking();
});

test("正文出字只停表，思考块仍可继续接收推理", () => {
  const { view, inner } = createHarness();
  view.showThinking("正在检索…");
  view.appendAssistantDelta("开始说话");
  const block = inner.querySelector("details.thinking-block");
  assert.ok(block);
  assert.equal(block.classList.contains("done"), true, "出字时应停表");

  view.appendReasoning("又想到一点");
  assert.equal(block.classList.contains("done"), false, "又开始想了就恢复计时态");
  assert.equal(inner.querySelectorAll("details.thinking-block").length, 1);
  view.finishThinking();
});

test("推理原文用 textContent 落地，不会被当成 HTML 解析", () => {
  const { view, inner } = createHarness();
  view.appendReasoning("<img src=x onerror=alert(1)>");
  const node = inner.querySelector(".thinking-reasoning");
  assert.equal(node?.querySelector("img"), null);
  assert.equal(node?.textContent, "<img src=x onerror=alert(1)>");
});

test("时间线挂载前先给助手气泡封口，保持时间顺序", () => {
  const { view, inner } = createHarness();
  view.appendAssistantDelta("先说结论");
  view.applyTimelineTurn({ sessionId: "s1", turnId: "t1", status: "running", startedAt: 0 });

  const nodes = Array.from(inner.children).map((node) => node.className);
  const assistantIndex = nodes.findIndex((name) => name.includes("assistant"));
  const timelineIndex = nodes.findIndex((name) => name.includes("timeline"));
  assert.ok(assistantIndex >= 0 && timelineIndex > assistantIndex, "时间线必须排在已有正文之后");
});
