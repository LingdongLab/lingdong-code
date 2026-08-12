import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  NATIVE_ONLY_COMMANDS,
  SLASH_COMMANDS,
  parseSlashInput,
  slashHostMessages,
  type SlashClientAction,
  type SlashState,
} from "../src/composer/slash-command";
import type { WebviewToHostMessage } from "../src/messages";
import type { AppElements, AppState } from "../src/webview/app-context";
import { createAppState } from "../src/webview/app-context";
import { ComposerView } from "../src/webview/composer";
import { SlashSuggestions } from "../src/webview/composer/slash-suggestions";

interface Harness {
  input: HTMLTextAreaElement;
  root: HTMLElement;
  slash: SlashSuggestions;
  composer: ComposerView;
  state: AppState;
  sent: WebviewToHostMessage[];
  notices: string[];
  actions: SlashClientAction[];
  type(value: string): void;
  items(): HTMLButtonElement[];
  key(key: string): boolean;
}

function createHarness(slashState: SlashState = {
  canSwitchMode: true,
  canCancel: false,
  canSend: true,
}): Harness {
  const dom = new JSDOM(`<!DOCTYPE html>
    <div id="composer-shell">
      <div id="slash-suggest" hidden></div>
      <div class="chips" id="context-items" hidden></div>
      <textarea id="input"></textarea>
    </div>`);
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Node: window.Node,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }

  const document = window.document;
  const input = document.getElementById("input") as HTMLTextAreaElement;
  const root = document.getElementById("slash-suggest") as HTMLElement;
  const sent: WebviewToHostMessage[] = [];
  const notices: string[] = [];
  const actions: SlashClientAction[] = [];
  const state = createAppState();

  const slash = new SlashSuggestions({
    input,
    root,
    post: (message) => sent.push(message),
    state: () => slashState,
    notice: (text) => notices.push(text),
    onClientAction: (action) => actions.push(action),
    onPrompt: (text) => sent.push({ type: "sendPrompt", text }),
  });
  const composer = new ComposerView({
    el: { contextItems: document.getElementById("context-items") as HTMLElement, input } as unknown as AppElements,
    state,
    post: (message) => sent.push(message),
    notice: (text) => notices.push(text),
    openWorkbenchTool: () => undefined,
    interceptSubmit: () => slash.consumeSubmit(),
    onSend: (text) => sent.push({ type: "sendPrompt", text }),
  });

  return {
    input,
    root,
    slash,
    composer,
    state,
    sent,
    notices,
    actions,
    type(value: string) {
      input.value = value;
      input.selectionStart = value.length;
      input.selectionEnd = value.length;
      slash.handleInput();
    },
    items: () => Array.from(root.querySelectorAll<HTMLButtonElement>(".suggest-item")),
    key(key: string) {
      return slash.handleKeydown(new window.KeyboardEvent("keydown", { key, cancelable: true }));
    },
  };
}

test("输入 / 打开命令候选", () => {
  const harness = createHarness();
  harness.type("/");
  assert.equal(harness.root.hidden, false);
  assert.equal(harness.items().length, SLASH_COMMANDS.length);
});

test("/pla 过滤为 /plan", () => {
  const harness = createHarness();
  harness.type("/pla");
  assert.deepEqual(harness.items().map((item) => item.dataset.id), ["plan"]);
});

test("/plan 提交后切换模式并清空输入框", () => {
  const harness = createHarness();
  harness.type("/plan");
  harness.composer.submit();

  assert.deepEqual(harness.sent, [{ type: "setMode", mode: "plan" }]);
  assert.equal(harness.input.value, "");
  assert.equal(harness.root.hidden, true);
  assert.ok(harness.notices.some((text) => /已执行 \/plan/.test(text)));
});

test("/new 新建会话", () => {
  const harness = createHarness();
  harness.type("/new");
  harness.composer.submit();
  assert.deepEqual(harness.sent, [{ type: "newSession" }]);
});

test("/stop 在任务执行中发出停止", () => {
  const harness = createHarness({ canSwitchMode: false, canCancel: true, canSend: false });
  harness.type("/stop");
  harness.composer.submit();
  assert.deepEqual(harness.sent, [{ type: "stop" }]);
});

test("/retry 走客户端重试路径，不直接发消息", () => {
  const harness = createHarness();
  harness.type("/retry");
  harness.composer.submit();

  assert.deepEqual(harness.actions, ["retry"]);
  assert.equal(harness.sent.length, 0);
});

test("/compact 不作为普通消息发给模型", () => {
  const harness = createHarness();
  harness.type("/compact");
  harness.composer.submit();

  assert.deepEqual(harness.sent, [{ type: "compactContext" }]);
  assert.equal(harness.sent.some((message) => message.type === "sendPrompt"), false);
});

test("/changes 与 /files 打开对应工作台", () => {
  const harness = createHarness();
  harness.type("/changes");
  harness.composer.submit();
  harness.type("/files");
  harness.composer.submit();
  assert.deepEqual(harness.actions, ["openChanges", "openFiles"]);
});

test("Enter 在候选浮层里确认命令", () => {
  const harness = createHarness();
  harness.type("/term");
  assert.equal(harness.key("Enter"), true);
  assert.deepEqual(harness.sent, [{ type: "openNativeTerminal" }]);
  assert.equal(harness.input.value, "");
});

test("任务执行中禁用的命令不执行，也不清空输入框", () => {
  const harness = createHarness({ canSwitchMode: false, canCancel: true, canSend: false });
  harness.type("/plan");
  harness.composer.submit();

  assert.equal(harness.sent.length, 0);
  assert.equal(harness.input.value, "/plan", "失败时保留输入，便于用户改完再执行");
  assert.ok(harness.notices.some((text) => /暂时不能切换模式/.test(text)));
});

test("未注册的命令按普通消息发送，不被伪装成命令", () => {
  const harness = createHarness();
  harness.input.value = "/deploy";
  assert.equal(harness.slash.consumeSubmit(), false);
  harness.composer.submit();
  assert.deepEqual(harness.sent, [{ type: "sendPrompt", text: "/deploy" }]);
});

test("/help 只列出命令，不产生宿主消息", () => {
  const harness = createHarness();
  harness.type("/help");
  harness.composer.submit();

  assert.equal(harness.sent.length, 0);
  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0] ?? "", /可用快捷命令/);
  assert.match(harness.notices[0] ?? "", /\/plan/);
});

// ---------------------------------------------------------------------------
// 参数、别名与 Grok 终端专属命令
// ---------------------------------------------------------------------------

test("以路径开头的正常提问不被当成命令", () => {
  assert.equal(parseSlashInput("/tmp 下的脚本坏了").kind, "prompt");
  assert.equal(parseSlashInput("/usr/bin 里有什么").kind, "prompt");
  assert.equal(parseSlashInput("/Users/me/a.ts 这个文件").kind, "prompt");
});

test("未注册但形如命令的词仍按提问发送", () => {
  assert.equal(parseSlashInput("/deploy").kind, "prompt");
  assert.equal(parseSlashInput("/deploy 到测试环境").kind, "prompt");
});

test("别名解析到同一条命令", () => {
  const clear = parseSlashInput("/clear");
  assert.equal(clear.kind === "command" ? clear.command.id : "", "new");
  const mcp = parseSlashInput("/mcp");
  assert.equal(mcp.kind === "command" ? mcp.command.id : "", "rules");
  const usage = parseSlashInput("/usage");
  assert.equal(usage.kind === "command" ? usage.command.id : "", "context");
});

test("Grok 终端专属命令被识别为不支持", () => {
  const parsed = parseSlashInput("/dream");
  assert.equal(parsed.kind, "unsupported");
  if (parsed.kind !== "unsupported") return;
  assert.equal(parsed.word, "dream");
  assert.ok(parsed.reason.length > 0);
  // 表里每一条都得给出理由，不能只是个空字符串。
  for (const [word, reason] of Object.entries(NATIVE_ONLY_COMMANDS)) {
    assert.ok(reason.length > 0, `${word} 缺少说明`);
  }
});

test("Grok 终端专属命令不会被当成提问发给模型", () => {
  const harness = createHarness();
  harness.input.value = "/imagine 一只猫";
  assert.equal(harness.slash.consumeSubmit(), true, "必须拦下来");
  assert.equal(harness.sent.length, 0);
  assert.ok(harness.notices.some((text) => /\/imagine 在这里不可用/.test(text)));
});

test("切模式命令带需求时合成一条 sendPrompt，模式与提问不分家", () => {
  const harness = createHarness();
  harness.input.value = "/plan 重构登录模块";
  harness.composer.submit();

  assert.deepEqual(harness.sent, [
    { type: "sendPrompt", text: "重构登录模块", mode: "plan" },
  ]);
  assert.equal(harness.input.value, "");
  assert.ok(harness.notices.some((text) => /并已发送你的需求/.test(text)));
});

test("不吃参数的命令带了参数就明确拒绝，不改成提问", () => {
  const harness = createHarness();
  harness.input.value = "/compact 只留登录相关";
  assert.equal(harness.slash.consumeSubmit(), true);
  assert.equal(harness.sent.length, 0);
  assert.ok(harness.notices.some((text) => /不接受参数/.test(text)));
});

test("slashHostMessages：切模式带参数合一条，其余按顺序两条", () => {
  const plan = SLASH_COMMANDS.find((command) => command.id === "plan");
  assert.ok(plan);
  assert.deepEqual(slashHostMessages(plan, "改登录"), [
    { type: "sendPrompt", text: "改登录", mode: "plan" },
  ]);
  assert.deepEqual(slashHostMessages(plan, ""), [{ type: "setMode", mode: "plan" }]);

  const help = SLASH_COMMANDS.find((command) => command.id === "help");
  assert.ok(help);
  assert.deepEqual(slashHostMessages(help, ""), [], "客户端命令没有宿主消息");
});

test("新增的入口命令都指向已有的宿主能力", () => {
  const harness = createHarness();
  for (const [trigger, expected] of [
    ["/rules", "openExtensions"],
    ["/model", "openModelSettings"],
    ["/settings", "openSettings"],
    ["/history", "openHistory"],
    ["/context", "requestUsageDetail"],
    ["/logs", "showLogs"],
    ["/reconnect", "reconnect"],
  ] as const) {
    harness.sent.length = 0;
    harness.input.value = trigger;
    assert.equal(harness.slash.consumeSubmit(), true, `${trigger} 应被消费`);
    assert.deepEqual(harness.sent, [{ type: expected }], trigger);
  }
});

test("别名可以直接提交", () => {
  const harness = createHarness();
  harness.input.value = "/skills";
  assert.equal(harness.slash.consumeSubmit(), true);
  assert.deepEqual(harness.sent, [{ type: "openExtensions" }]);
});

test("命令词大小写不敏感", () => {
  const harness = createHarness();
  harness.input.value = "/NEW";
  assert.equal(harness.slash.consumeSubmit(), true);
  assert.deepEqual(harness.sent, [{ type: "newSession" }]);
});
