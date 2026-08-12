import assert from "node:assert/strict";
import test from "node:test";
import type { AskUserRequest } from "@lingdong/agent-runtime";
import type { HostToWebviewMessage } from "../src/messages";
import { QuestionFacade } from "../src/services/question-facade";
import { UiStateMachine } from "../src/ui-state";

/**
 * 提问编排（宿主侧）：卡片下发、等待态进出、答案下标对齐、状态守卫。
 * 运行时侧的反向 RPC 应答见 agent-runtime 的 ask-question-flow 测试。
 */

interface Harness {
  facade: QuestionFacade;
  ui: UiStateMachine;
  posted: HostToWebviewMessage[];
  logs: string[];
  responded: { requestId: string; answers: string[] }[];
  failNext: boolean;
}

function createHarness(withRuntime = true): Harness {
  const harness = {
    posted: [] as HostToWebviewMessage[],
    logs: [] as string[],
    responded: [] as { requestId: string; answers: string[] }[],
    failNext: false,
    ui: new UiStateMachine(),
  } as Harness;
  harness.ui.force("streaming");
  const runtime = {
    respondQuestion: async (requestId: string, answers: string[]) => {
      if (harness.failNext) throw new Error("提问已失效：模拟");
      harness.responded.push({ requestId, answers });
    },
  };
  harness.facade = new QuestionFacade({
    post: (message) => harness.posted.push(message),
    log: (line) => harness.logs.push(line),
    postState: () => undefined,
    ui: harness.ui,
    runtime: () => (withRuntime ? (runtime as never) : undefined),
  });
  return harness;
}

const REQUEST: AskUserRequest = {
  questions: [
    { question: "测试语言？", options: [{ label: "TypeScript", preview: "推荐" }], multiSelect: false },
    { question: "覆盖场景？", options: [{ label: "单元" }, { label: "集成" }], multiSelect: true },
  ],
  mode: "plan",
};

test("提问到达：下发 askQuestion 卡并进入 waiting_question", () => {
  const { facade, ui, posted } = createHarness();
  facade.handleRequested("42", REQUEST);

  assert.equal(ui.state, "waiting_question");
  const message = posted.find((item) => item.type === "askQuestion");
  assert.ok(message && message.type === "askQuestion");
  assert.equal(message.card.requestId, "42");
  assert.equal(message.card.questions.length, 2);
  assert.equal(message.card.questions[0]?.options[0]?.preview, "推荐");
  assert.equal(facade.current?.requestId, "42");
});

test("回答：答案按题目下标对齐（缺的补空串、多的截掉）后交给运行时", async () => {
  const { facade, responded } = createHarness();
  facade.handleRequested("42", REQUEST);

  await facade.respond("42", ["TypeScript"]);
  assert.deepEqual(responded, [{ requestId: "42", answers: ["TypeScript", ""] }]);

  // 运行时确认后事件回流。
  facade.handleResolved("42", "answered", ["TypeScript", ""]);
});

test("运行时确认回答后：下发 askQuestionResolved 并回到 streaming", () => {
  const { facade, ui, posted } = createHarness();
  facade.handleRequested("42", REQUEST);
  facade.handleResolved("42", "answered", ["TypeScript", "单元"]);

  assert.equal(ui.state, "streaming");
  assert.equal(facade.current, undefined);
  const message = posted.find((item) => item.type === "askQuestionResolved");
  assert.ok(message && message.type === "askQuestionResolved");
  assert.equal(message.requestId, "42");
  assert.deepEqual(message.answers, ["TypeScript", "单元"]);
});

test("取消收尾：outcome=cancelled 不带 answers，同样退出等待态", () => {
  const { facade, ui, posted } = createHarness();
  facade.handleRequested("42", REQUEST);
  facade.handleResolved("42", "cancelled");

  assert.equal(ui.state, "streaming");
  const message = posted.find((item) => item.type === "askQuestionResolved");
  assert.ok(message && message.type === "askQuestionResolved");
  assert.equal(message.answers, undefined);
});

test("状态守卫：不在 waiting_question 时拒绝回执，不碰运行时", async () => {
  const { facade, ui, responded, logs } = createHarness();
  facade.handleRequested("42", REQUEST);
  ui.force("streaming");

  await facade.respond("42", ["TypeScript", "单元"]);
  assert.equal(responded.length, 0);
  assert.ok(logs.some((line) => line.includes("拒绝处理问答回执")));
});

test("requestId 不匹配：提示失效，不碰运行时", async () => {
  const { facade, responded, posted } = createHarness();
  facade.handleRequested("42", REQUEST);

  await facade.respond("no-such", ["x", "y"]);
  assert.equal(responded.length, 0);
  const notice = posted.find((item) => item.type === "notice");
  assert.ok(notice && notice.type === "notice");
  assert.match(notice.message, /已失效/);
});

test("运行时报错：给出错误提示并退出等待态，不让 UI 悬死", async () => {
  const harness = createHarness();
  harness.facade.handleRequested("42", REQUEST);
  harness.failNext = true;

  await harness.facade.respond("42", ["TypeScript", "单元"]);
  assert.equal(harness.ui.state, "streaming");
  assert.equal(harness.facade.current, undefined);
  const error = harness.posted.find((item) => item.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.message, /回答提问失败/);
});

test("面板重挂时补推当前提问卡", () => {
  const { facade, posted } = createHarness();
  facade.handleRequested("42", REQUEST);
  posted.length = 0;

  facade.republishCurrent();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.type, "askQuestion");

  facade.handleResolved("42", "cancelled");
  posted.length = 0;
  facade.republishCurrent();
  assert.equal(posted.length, 0, "没有未决提问时不补推");
});
