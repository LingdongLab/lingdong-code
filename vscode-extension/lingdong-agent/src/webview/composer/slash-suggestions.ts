import {
  filterSlashCommands,
  findSlashCommand,
  parseSlashInput,
  readSlashQuery,
  slashHostMessages,
  SLASH_COMMANDS,
  type SlashClientAction,
  type SlashCommand,
  type SlashState,
} from "../../composer/slash-command";
import type { Post } from "../app-context";
import { SuggestionPopup, type SuggestionItem } from "../suggestion-popup";

/**
 * Slash 快捷命令的 Composer 接线。
 *
 * 命令只走 slash-command.ts 的允许列表，命中后 submit 提前返回，
 * 绝不会把 `/plan` 之类的文字当成普通消息发给模型。
 *
 * Grok 终端界面里的那些命令（`/dream`、`/imagine`…）也在这里被挡住：
 * 它们的解析在 Grok 的 TUI 前端，ACP 上没有对应通路，放它们过去只会让模型
 * 假装执行一个并不存在的命令。
 */

export interface SlashSuggestionsDeps {
  input: HTMLTextAreaElement;
  root: HTMLElement;
  post: Post;
  state(): SlashState;
  /** 轻量操作反馈，落在会话流里。 */
  notice(text: string): void;
  /** 纯 Webview 动作：重试、打开工作台、/help。 */
  onClientAction(action: SlashClientAction): void;
  /** 命令后面跟的那段文字，当普通提问发出去（`/plan 重构登录`）。 */
  onPrompt(text: string): void;
}

export class SlashSuggestions {
  private readonly popup: SuggestionPopup;

  constructor(private readonly deps: SlashSuggestionsDeps) {
    this.popup = new SuggestionPopup({
      root: deps.root,
      onAccept: (item) => {
        this.execute(item.id);
      },
      onClose: () => this.deps.input.focus(),
    });
  }

  get isOpen(): boolean { return this.popup.isOpen; }

  handleInput(): void {
    const { input } = this.deps;
    const token = readSlashQuery(input.value, input.selectionStart ?? input.value.length);
    if (!token) {
      this.popup.close();
      return;
    }
    const state = this.deps.state();
    const items: SuggestionItem[] = filterSlashCommands(token.query, state).map((candidate) => ({
      id: candidate.command.id,
      label: candidate.command.restHint
        ? `${candidate.command.trigger} <${candidate.command.restHint}>`
        : candidate.command.trigger,
      hint: candidate.command.title,
      ...(candidate.disabledReason ? { disabledReason: candidate.disabledReason } : {}),
    }));
    this.popup.open([{ title: "快捷命令", items }]);
  }

  handleKeydown(event: KeyboardEvent): boolean {
    return this.popup.handleKeydown(event);
  }

  close(): void { this.popup.close(); }

  /**
   * 提交拦截。返回 true 表示这次输入已被命令消费，调用方据此跳过 sendPrompt。
   *
   * 三种结局：本地命令（可带一段文字，执行完再把那段文字发出去）、
   * Grok 终端专属命令（明确拒绝）、其余按普通提问放行。
   */
  consumeSubmit(): boolean {
    const parsed = parseSlashInput(this.deps.input.value);
    if (parsed.kind === "prompt") return false;
    if (parsed.kind === "unsupported") {
      // 关键：不放行。让 `/dream` 之类的词流到模型那里，模型会假装执行。
      this.deps.notice(`/${parsed.word} 在这里不可用。${parsed.reason}`);
      this.popup.close();
      this.deps.input.focus();
      return true;
    }
    return this.execute(parsed.command.id, parsed.rest);
  }

  /**
   * 只接受允许列表里的 id；返回 true 表示这次输入已被命令消费。
   * rest 是命令词之后的文字，只有声明了 `rest: "prompt"` 的命令才接受。
   */
  private execute(commandId: string, rest = ""): boolean {
    const command = findSlashCommand(commandId);
    if (!command) {
      this.deps.notice("未知命令，已忽略。");
      return false;
    }
    const candidate = filterSlashCommands(command.id, this.deps.state())
      .find((entry) => entry.command.id === command.id);
    if (candidate?.disabledReason) {
      // 失败不清空输入框，用户可以改完再执行。
      this.deps.notice(`${command.trigger}：${candidate.disabledReason}`);
      this.popup.close();
      this.deps.input.focus();
      return true;
    }

    const trailing = rest.trim();
    if (trailing && command.rest !== "prompt") {
      // 不吃参数的命令带了参数：说清楚，但不要把整行当提问发出去——
      // 用户想执行的是命令，静默改语义比报错更糟。
      this.deps.notice(`${command.trigger} 不接受参数，请单独发送这条命令。`);
      this.popup.close();
      this.deps.input.focus();
      return true;
    }

    if (command.target.kind === "host") {
      // 带参数的切模式命令在这里被合成成一条 sendPrompt，不会分两条竞争。
      for (const message of slashHostMessages(command, trailing)) this.deps.post(message);
    } else if (command.target.action === "help") {
      this.deps.notice(this.helpText());
    } else {
      this.deps.onClientAction(command.target.action);
      if (trailing && command.rest === "prompt") this.deps.onPrompt(trailing);
    }

    this.clearInput();
    this.popup.close();
    if (command.target.kind !== "client" || command.target.action !== "help") {
      const suffix = trailing && command.rest === "prompt" ? "，并已发送你的需求" : "";
      this.deps.notice(`已执行 ${command.trigger}：${command.title}${suffix}`);
    }
    this.deps.input.focus();
    return true;
  }

  private clearInput(): void {
    const { input } = this.deps;
    input.value = "";
    input.selectionStart = 0;
    input.selectionEnd = 0;
  }

  private helpText(): string {
    const state = this.deps.state();
    const lines = SLASH_COMMANDS.map((command) => describe(command, state));
    return ["可用快捷命令：", ...lines].join("\n");
  }
}

function describe(command: SlashCommand, state: SlashState): string {
  const reason = filterSlashCommands(command.id, state)
    .find((entry) => entry.command.id === command.id)?.disabledReason;
  const trigger = command.restHint
    ? `${command.trigger} <${command.restHint}>`
    : command.trigger;
  const aliases = command.aliases?.length
    ? `（也可写 ${command.aliases.map((alias) => `/${alias}`).join(" ")}）`
    : "";
  return `${trigger} — ${command.title}${aliases}${reason ? `（${reason}）` : ""}`;
}
