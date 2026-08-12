import type { AgentRuntimeHandle, AskUserRequest } from "@lingdong/agent-runtime";
import type { AskQuestionCardView, HostToWebviewMessage } from "../messages";
import { MAX_QUESTIONS_PER_ASK } from "../messages";
import type { UiStateMachine } from "../ui-state";

/**
 * 模型提问（ask_user_question）的宿主编排。
 *
 * 与权限卡不同：同一时刻只会有一个未决提问（Grok 阻塞在工具调用上），
 * 不需要队列；也不设本地超时——托管 config.toml 已关闭 Grok 侧问答超时，
 * 与 Cursor 一致地无限等待用户作答，用户随时可以取消整轮。
 */

export interface QuestionFacadeDeps {
  post(message: HostToWebviewMessage): void;
  log(line: string): void;
  postState(detail?: string): void;
  readonly ui: UiStateMachine;
  runtime(): AgentRuntimeHandle | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class QuestionFacade {
  private currentCard: AskQuestionCardView | undefined;

  constructor(private readonly deps: QuestionFacadeDeps) {}

  get current(): AskQuestionCardView | undefined {
    return this.currentCard;
  }

  handleRequested(requestId: string, request: AskUserRequest): void {
    const card: AskQuestionCardView = {
      requestId,
      questions: request.questions.slice(0, MAX_QUESTIONS_PER_ASK).map((question) => ({
        question: question.question,
        options: question.options.map((option) => ({
          label: option.label,
          ...(option.preview ? { preview: option.preview } : {}),
        })),
        multiSelect: question.multiSelect,
      })),
    };
    this.currentCard = card;
    this.deps.post({ type: "askQuestion", card });
    this.deps.ui.transition("waiting_question");
    this.deps.postState();
  }

  handleResolved(requestId: string, outcome: "answered" | "cancelled", answers?: string[]): void {
    if (this.currentCard?.requestId === requestId) this.currentCard = undefined;
    this.deps.post({
      type: "askQuestionResolved",
      requestId,
      message: outcome === "answered" ? "已回答" : "提问已取消，任务将不带答案继续",
      ...(answers && answers.length > 0 ? { answers } : {}),
    });
    if (this.deps.ui.state === "waiting_question") {
      this.deps.ui.transition("streaming");
      this.deps.postState();
    }
  }

  async respond(requestId: string, answers: string[]): Promise<void> {
    if (!this.deps.ui.canRespondQuestion) {
      this.deps.log(`[question] 状态 ${this.deps.ui.state} 下拒绝处理问答回执 ${requestId}`);
      return;
    }
    const card = this.currentCard;
    if (!card || card.requestId !== requestId) {
      this.deps.post({ type: "notice", level: "warn", message: "该提问已失效。" });
      return;
    }
    const runtime = this.deps.runtime();
    if (!runtime) return;

    // 答案与问题按下标对齐：缺的补空串，多的截掉，绝不让 Grok 收到错位的答案。
    const aligned = card.questions.map((_, index) => answers[index] ?? "");
    try {
      await runtime.respondQuestion(requestId, aligned);
    } catch (error) {
      this.deps.post({ type: "error", message: `回答提问失败：${errorText(error)}`, recoverable: true });
      this.currentCard = undefined;
      if (this.deps.ui.state === "waiting_question") {
        this.deps.ui.transition("streaming");
        this.deps.postState();
      }
    }
  }

  /** 面板重新挂载时补推当前提问卡。 */
  republishCurrent(): void {
    if (!this.currentCard) return;
    this.deps.post({ type: "askQuestion", card: this.currentCard });
  }
}
