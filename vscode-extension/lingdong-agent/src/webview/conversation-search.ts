import {
  describeProgress,
  findMatches,
  type SearchMatch,
  type SearchableRecord,
} from "../search/search-result";
import { element } from "./dom-utils";

/**
 * 当前会话内搜索。
 *
 * 搜索源来自 ConversationView 保存的可搜记录，因此内容与已渲染的会话流完全一致，
 * 隐藏工具输出、ACP 帧与模型私有推理根本不在其中。
 *
 * 命中未加载的更早分页时，由 revealRecord 按需补渲染包含目标的那一页，
 * 而不是一次性铺开全部历史。
 */

export interface ConversationSearchDeps {
  root: HTMLElement;
  input: HTMLInputElement;
  count: HTMLElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
  /** 搜索源快照。 */
  records(): readonly SearchableRecord[];
  /** 让记录进入已渲染区域并滚动到位，返回定位到的节点。 */
  reveal(record: SearchableRecord): HTMLElement | undefined;
  /** 关闭后把焦点交还给谁。 */
  onClose(): void;
  /** 记录关闭时要恢复的滚动位置。 */
  scrollTop(): number;
  restoreScroll(top: number): void;
}

export class ConversationSearch {
  private matches: SearchMatch[] = [];
  private cursor = 0;
  private highlighted: HTMLElement | undefined;
  private savedScroll = 0;

  constructor(private readonly deps: ConversationSearchDeps) {
    const { input, previous, next, close } = deps;
    deps.root.hidden = true;
    input.addEventListener("input", () => this.run(input.value));
    previous.addEventListener("click", () => this.step(-1));
    next.addEventListener("click", () => this.step(1));
    close.addEventListener("click", () => this.hide());
    input.addEventListener("keydown", (event) => this.handleKeydown(event));
  }

  get isOpen(): boolean { return !this.deps.root.hidden; }
  get matchCount(): number { return this.matches.length; }
  get currentIndex(): number { return this.cursor; }

  show(): void {
    if (!this.isOpen) {
      this.savedScroll = this.deps.scrollTop();
      this.deps.root.hidden = false;
    }
    this.deps.input.focus();
    this.deps.input.select();
    if (this.deps.input.value) this.run(this.deps.input.value);
  }

  hide(): void {
    if (!this.isOpen) return;
    this.clearHighlight();
    this.deps.root.hidden = true;
    this.matches = [];
    this.cursor = 0;
    this.paintCount();
    this.deps.restoreScroll(this.savedScroll);
    this.deps.onClose();
  }

  /** 返回 true 表示按键已被查找条消费。 */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      this.hide();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.step(event.shiftKey ? -1 : 1);
      return true;
    }
    return false;
  }

  /** 重新执行当前查询；会话内容变化后调用。 */
  refresh(): void {
    if (this.isOpen) this.run(this.deps.input.value);
  }

  private run(query: string): void {
    this.matches = findMatches(this.deps.records(), query);
    this.cursor = 0;
    this.paintCount();
    if (this.matches.length === 0) {
      this.clearHighlight();
      return;
    }
    this.jump();
  }

  private step(delta: number): void {
    if (this.matches.length === 0) return;
    this.cursor = (this.cursor + delta + this.matches.length) % this.matches.length;
    this.paintCount();
    this.jump();
  }

  private jump(): void {
    const match = this.matches[this.cursor];
    if (!match) return;
    this.clearHighlight();
    const node = this.deps.reveal(match.record);
    if (!node) return;
    node.classList.add("search-hit");
    this.highlighted = node;
  }

  private clearHighlight(): void {
    this.highlighted?.classList.remove("search-hit");
    this.highlighted = undefined;
  }

  private paintCount(): void {
    const total = this.matches.length;
    this.deps.count.textContent = this.deps.input.value.trim() === ""
      ? ""
      : describeProgress(this.cursor, total);
    this.deps.previous.disabled = total === 0;
    this.deps.next.disabled = total === 0;
  }
}

/** 查找条的 DOM；由 agent-panel 提供容器，这里只填充内容。 */
export function createSearchBar(root: HTMLElement): {
  input: HTMLInputElement;
  count: HTMLElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
} {
  const input = element("input", "search-input");
  input.type = "text";
  input.placeholder = "在当前会话中查找";
  input.setAttribute("aria-label", "在当前会话中查找");
  const count = element("span", "search-count");
  const previous = element("button", "search-nav", "‹");
  previous.type = "button";
  previous.title = "上一个（Shift+Enter）";
  const next = element("button", "search-nav", "›");
  next.type = "button";
  next.title = "下一个（Enter）";
  const close = element("button", "search-nav", "×");
  close.type = "button";
  close.title = "关闭（Escape）";
  root.replaceChildren(input, count, previous, next, close);
  return { input, count, previous, next, close };
}
