import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { AskQuestionCardView, WebviewToHostMessage } from "../src/messages";
import { ConversationView } from "../src/webview/conversation";

/**
 * 模型提问卡（ask_user_question）的 Webview 交互：
 * 单选/多选渲染、答完才能提交、答案与题目下标对齐、提交与收尾后锁卡。
 */

interface Harness {
  document: Document;
  view: ConversationView;
  inner: HTMLElement;
  sent: WebviewToHostMessage[];
}

function createHarness(): Harness {
  const dom = new JSDOM(`<!DOCTYPE html>
    <div id="messages"><div id="messages-inner"><div id="empty">空</div></div></div>`);
  const { window } = dom;
  for (const key of ["document", "window", "HTMLElement", "Node", "Event"] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "document" ? window.document : (window as unknown as Record<string, unknown>)[key],
      configurable: true,
    });
  }
  const sent: WebviewToHostMessage[] = [];
  const document = window.document;
  const view = new ConversationView({
    el: {
      messages: document.getElementById("messages") as HTMLElement,
      messagesInner: document.getElementById("messages-inner") as HTMLElement,
      empty: document.getElementById("empty") as HTMLElement,
    },
    post: (message) => sent.push(message),
    canSend: () => true,
    onOpenLink: () => undefined,
    onOpenFile: () => undefined,
    onViewPlan: () => undefined,
  });
  return { document, view, inner: document.getElementById("messages-inner") as HTMLElement, sent };
}

function card(overrides: Partial<AskQuestionCardView> = {}): AskQuestionCardView {
  return {
    requestId: "q-1",
    questions: [
      {
        question: "测试用哪种语言？",
        options: [
          { label: "TypeScript", preview: "与项目现有测试一致" },
          { label: "Python" },
        ],
        multiSelect: false,
      },
      {
        question: "要覆盖哪些场景？",
        options: [{ label: "单元测试" }, { label: "集成测试" }],
        multiSelect: true,
      },
    ],
    ...overrides,
  };
}

function pick(root: HTMLElement, question: number, option: number): void {
  const block = root.querySelectorAll(".ask-q")[question];
  const input = block?.querySelectorAll<HTMLInputElement>(".ask-q-option input")[option];
  assert.ok(input, `找不到第 ${question} 题第 ${option} 个选项`);
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

test("单选题渲染 radio、多选题渲染 checkbox，preview 可见", () => {
  const { view, inner } = createHarness();
  view.renderQuestion(card());

  const blocks = inner.querySelectorAll(".ask-q");
  assert.equal(blocks.length, 2);
  // 每题在业务选项之外还带一个「其他」开关。
  assert.equal(blocks[0]?.querySelectorAll('input[type="radio"]').length, 3);
  assert.equal(blocks[1]?.querySelectorAll('input[type="checkbox"]').length, 3);
  assert.equal(blocks[0]?.querySelector(".ask-q-option-preview")?.textContent, "与项目现有测试一致");
  assert.ok(view.hasPendingQuestion);
});

test("答完所有题才能提交；答案与题目下标对齐，多选合成一条", () => {
  const { view, inner, sent } = createHarness();
  view.renderQuestion(card());
  const root = inner.querySelector(".ask-question") as HTMLElement;
  const submit = root.querySelector("button") as HTMLButtonElement;
  assert.equal(submit.disabled, true, "未作答时不能提交");

  pick(root, 0, 0);
  assert.equal(submit.disabled, true, "只答了一题仍不能提交");

  pick(root, 1, 0);
  pick(root, 1, 1);
  assert.equal(submit.disabled, false);

  submit.click();
  assert.deepEqual(sent, [
    { type: "answerQuestion", requestId: "q-1", answers: ["TypeScript", "单元测试、集成测试"] },
  ]);
  assert.equal(submit.disabled, true, "提交后锁卡");
  const locked = Array.from(root.querySelectorAll<HTMLInputElement>("input")).every((input) => input.disabled);
  assert.ok(locked, "提交后所有选项一起禁用");
});

test("「其他」自由文本：单选选它时以文本为答案，文本为空不能提交", () => {
  const { view, inner, sent } = createHarness();
  view.renderQuestion(card({
    questions: [{ question: "选一个", options: [{ label: "A" }], multiSelect: false }],
  }));
  const root = inner.querySelector(".ask-question") as HTMLElement;
  const submit = root.querySelector("button") as HTMLButtonElement;

  const otherToggle = root.querySelector(".ask-q-other input") as HTMLInputElement;
  otherToggle.checked = true;
  otherToggle.dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(submit.disabled, true, "选了其他但没写内容，不能提交");

  const otherInput = root.querySelector(".ask-q-other-input") as HTMLInputElement;
  otherInput.value = "  两种都要  ";
  otherInput.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(submit.disabled, false);

  submit.click();
  assert.deepEqual(sent, [{ type: "answerQuestion", requestId: "q-1", answers: ["两种都要"] }]);
});

test("同一 requestId 重复下发不追加第二张卡", () => {
  const { view, inner } = createHarness();
  view.renderQuestion(card());
  view.renderQuestion(card());
  assert.equal(inner.querySelectorAll(".ask-question").length, 1);
});

test("resolveQuestion 把卡收拢成一行结论；requestId 不匹配则不动", () => {
  const { view, inner } = createHarness();
  view.renderQuestion(card());
  const root = inner.querySelector(".ask-question") as HTMLElement;

  view.resolveQuestion("别的请求", "不该出现");
  assert.equal(root.classList.contains("card-collapsed"), false);

  view.resolveQuestion("q-1", "已回答", ["TypeScript", "单元测试"]);
  assert.equal(view.hasPendingQuestion, false);
  assert.ok(root.classList.contains("card-collapsed"), "卡片应收拢");
  assert.equal(root.querySelector(".card-collapsed-text")?.textContent, "已回答：TypeScript；单元测试");
  assert.equal(root.querySelectorAll("input").length, 0, "收拢后不再保留全尺寸表单");
});

test("取消提问时收拢为一行取消结论", () => {
  const { view, inner } = createHarness();
  view.renderQuestion(card());
  const root = inner.querySelector(".ask-question") as HTMLElement;
  view.resolveQuestion("q-1", "提问已取消，任务将不带答案继续");
  assert.equal(root.querySelector(".card-collapsed-text")?.textContent, "提问已取消，任务将不带答案继续");
});
