import {
  GROUP_TITLE,
  readMentionQuery,
  truncationHint,
  type CandidateGroup,
  type ContextCandidate,
  type MentionQuery,
} from "../../composer/context-candidate";
import type { Post } from "../app-context";
import { SuggestionPopup, type SuggestionItem, type SuggestionSection } from "../suggestion-popup";

/**
 * Composer 内联 @ 补全。
 *
 * Webview 只做三件事：识别光标前的 `@token`、把查询串交给宿主、把用户选中的
 * opaque candidateId 回传。候选路径的解析、读取与脱敏全部在宿主完成，
 * 这里既不读文件，也不构造路径。
 */

/** 输入防抖：规格要求 100～150ms。 */
export const SUGGEST_DEBOUNCE_MS = 120;

export interface ContextSuggestionsDeps {
  input: HTMLTextAreaElement;
  root: HTMLElement;
  post: Post;
  debounceMs?: number;
}

export class ContextSuggestions {
  private readonly popup: SuggestionPopup;
  private readonly debounceMs: number;
  private token: MentionQuery | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private candidates = new Map<string, ContextCandidate>();

  constructor(private readonly deps: ContextSuggestionsDeps) {
    this.debounceMs = deps.debounceMs ?? SUGGEST_DEBOUNCE_MS;
    this.popup = new SuggestionPopup({
      root: deps.root,
      onAccept: (item) => this.accept(item.id),
      onClose: () => this.deps.input.focus(),
    });
  }

  get isOpen(): boolean { return this.popup.isOpen; }

  /** 输入变化时检测 `@token`；离开 token 立刻关闭浮层。 */
  handleInput(): void {
    const { input } = this.deps;
    const token = readMentionQuery(input.value, input.selectionStart ?? input.value.length);
    if (!token) {
      this.close();
      return;
    }
    this.token = token;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.deps.post({ type: "contextSuggestQuery", query: token.query });
    }, this.debounceMs);
  }

  /** 宿主回包。查询串与当前 token 不一致说明是过期结果，直接丢弃。 */
  applyResults(query: string, groups: readonly CandidateGroup[], truncated: boolean): void {
    if (!this.token || this.token.query !== query) return;
    this.candidates = new Map();
    const sections: SuggestionSection[] = groups.map((group) => ({
      title: GROUP_TITLE[group.id],
      items: group.candidates.map((candidate) => {
        this.candidates.set(candidate.id, candidate);
        return toItem(candidate);
      }),
    }));
    const shown = groups.find((group) => group.id === "workspace")?.candidates.length ?? 0;
    this.popup.open(sections, truncated ? truncationHint(shown) : undefined);
  }

  handleKeydown(event: KeyboardEvent): boolean {
    return this.popup.handleKeydown(event);
  }

  close(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.token = undefined;
    this.candidates = new Map();
    this.popup.close();
  }

  private accept(candidateId: string): void {
    const candidate = this.candidates.get(candidateId);
    const token = this.token;
    if (!candidate || !token) {
      this.close();
      return;
    }
    this.deps.post({
      type: "contextSuggestSelect",
      candidateId: candidate.id,
      sourceType: candidate.source,
    });
    this.removeToken(token);
    this.close();
    this.deps.input.focus();
  }

  /** 确认后把 `@token` 从输入框摘掉：chip 已经代表这条上下文。 */
  private removeToken(token: MentionQuery): void {
    const { input } = this.deps;
    const caret = input.selectionStart ?? input.value.length;
    const end = Math.max(caret, token.start + 1 + token.query.length);
    input.value = `${input.value.slice(0, token.start)}${input.value.slice(end)}`;
    input.selectionStart = token.start;
    input.selectionEnd = token.start;
  }
}

function toItem(candidate: ContextCandidate): SuggestionItem {
  return {
    id: candidate.id,
    label: candidate.label,
    ...(candidate.detail ? { detail: candidate.detail } : {}),
    ...(candidate.disabledReason ? { disabledReason: candidate.disabledReason } : {}),
    ...(candidate.alreadyAdded ? { hint: "已添加" } : {}),
  };
}
