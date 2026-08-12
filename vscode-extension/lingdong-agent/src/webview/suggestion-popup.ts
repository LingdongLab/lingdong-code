import { element } from "./dom-utils";

/**
 * @ 与 / 共用的紧凑候选浮层。
 *
 * 只负责渲染、键盘导航与确认回调；候选来源、过滤与执行都在各自的控制器里。
 * 浮层锚在 Composer 上方，因此永远不会遮住发送按钮，空间不足时天然向上生长。
 */

export interface SuggestionItem {
  id: string;
  label: string;
  detail?: string;
  /** 右侧附注，例如「已添加」或命令说明。 */
  hint?: string;
  /** 有值即为不可选，并在行内说明原因。 */
  disabledReason?: string;
}

export interface SuggestionSection {
  title: string;
  items: SuggestionItem[];
}

export interface SuggestionPopupDeps {
  root: HTMLElement;
  onAccept(item: SuggestionItem): void;
  /** 用户主动关闭（Escape 或点击外部）时回调，用于把焦点交回输入框。 */
  onClose(): void;
}

export class SuggestionPopup {
  private sections: SuggestionSection[] = [];
  private footer: string | undefined;
  private activeId: string | undefined;

  constructor(private readonly deps: SuggestionPopupDeps) {
    this.deps.root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.deps.root.hidden;
  }

  /** 打开或刷新浮层；没有任何候选时直接关闭，不留空壳。 */
  open(sections: readonly SuggestionSection[], footer?: string): void {
    this.sections = sections.map((section) => ({ ...section, items: [...section.items] }))
      .filter((section) => section.items.length > 0);
    this.footer = footer;
    if (this.sections.length === 0) {
      this.close();
      return;
    }
    const selectable = this.selectable();
    // 逐字过滤时尽量保留原选中项，避免选中行在列表里乱跳。
    if (!this.activeId || !selectable.some((item) => item.id === this.activeId)) {
      this.activeId = selectable[0]?.id;
    }
    this.deps.root.hidden = false;
    this.render();
  }

  close(): void {
    this.deps.root.hidden = true;
    this.deps.root.replaceChildren();
    this.sections = [];
    this.activeId = undefined;
    this.footer = undefined;
  }

  /** 返回 true 表示按键已被浮层消费，调用方不要再处理。 */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.move(1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        this.move(-1);
        return true;
      case "Enter":
      case "Tab": {
        const item = this.selectable().find((candidate) => candidate.id === this.activeId);
        if (!item) return false;
        event.preventDefault();
        this.deps.onAccept(item);
        return true;
      }
      case "Escape":
        event.preventDefault();
        this.close();
        this.deps.onClose();
        return true;
      default:
        return false;
    }
  }

  private selectable(): SuggestionItem[] {
    return this.sections.flatMap((section) => section.items.filter((item) => !item.disabledReason));
  }

  private move(delta: number): void {
    const items = this.selectable();
    if (items.length === 0) return;
    const current = items.findIndex((item) => item.id === this.activeId);
    const next = (current + delta + items.length) % items.length;
    this.activeId = items[next]?.id;
    this.render();
  }

  private render(): void {
    const { root } = this.deps;
    root.replaceChildren();
    for (const section of this.sections) {
      root.appendChild(element("div", "suggest-section", section.title));
      for (const item of section.items) {
        root.appendChild(this.renderItem(item));
      }
    }
    if (this.footer) root.appendChild(element("div", "suggest-footer", this.footer));
    const active = root.querySelector<HTMLElement>(".suggest-item.active");
    active?.scrollIntoView?.({ block: "nearest" });
  }

  private renderItem(item: SuggestionItem): HTMLButtonElement {
    const disabled = !!item.disabledReason;
    const active = !disabled && item.id === this.activeId;
    const button = element("button", `suggest-item${active ? " active" : ""}${disabled ? " disabled" : ""}`);
    button.type = "button";
    button.disabled = disabled;
    button.dataset.id = item.id;

    const main = element("span", "suggest-main");
    main.appendChild(element("span", "suggest-name", item.label));
    const note = item.disabledReason ?? item.detail;
    if (note) main.appendChild(element("span", "suggest-detail", note));
    button.appendChild(main);
    if (item.hint) button.appendChild(element("span", "suggest-hint", item.hint));

    if (!disabled) {
      button.addEventListener("mousedown", (event) => {
        // 用 mousedown 并阻止默认行为，避免点击时输入框先失焦导致光标位置丢失。
        event.preventDefault();
        this.deps.onAccept(item);
      });
      button.addEventListener("mouseenter", () => {
        if (this.activeId === item.id) return;
        this.activeId = item.id;
        this.render();
      });
    }
    return button;
  }
}
