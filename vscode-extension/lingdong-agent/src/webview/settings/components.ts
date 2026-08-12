/**
 * 设置页的基础控件。
 *
 * 存在的理由：改造之前，模型页和能力页各写各的 DOM 辅助函数，开关被就地手搓了
 * 四遍，两套 CSS 前缀（ms-/ex-）互不知道对方存在。于是同一个「开关」在两页里
 * 长得不一样，加一页就再抄一遍。这里把行、开关、下拉、步进器这些收成一份。
 *
 * 版式对齐 Cursor：一行 = 左边标题 + 说明，右边控件；若干行装进一张圆角卡片，
 * 卡片上方是一行小字分组标题。控件宽度固定，所以一列扫下来右边缘是齐的。
 */

export type Tone = "ok" | "warn" | "danger" | "muted";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(
  label: string,
  variant: "primary" | "default" | "ghost" | "danger",
  onClick: () => void,
  options: { disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const node = el("button", `st-btn ${variant}`, label);
  node.type = "button";
  if (options.disabled) node.disabled = true;
  if (options.title) node.title = options.title;
  node.addEventListener("click", onClick);
  return node;
}

export function badge(text: string, tone?: Tone): HTMLElement {
  return el("span", tone ? `st-badge ${tone}` : "st-badge", text);
}

/** 分组：小标题 + 圆角卡片。卡片里的行之间自动加分隔线。 */
export class Section {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;

  constructor(title?: string, description?: string) {
    this.root = el("section", "st-section");
    if (title) this.root.appendChild(el("h2", "st-section-title", title));
    if (description) this.root.appendChild(el("p", "st-section-desc", description));
    this.body = el("div", "st-card");
    this.root.appendChild(this.body);
  }

  add(node: HTMLElement): this {
    this.body.appendChild(node);
    return this;
  }

  /** 卡片里一条内容都没有时，摆一句话而不是留一个空壳。 */
  empty(text: string): this {
    if (this.body.childElementCount === 0) this.body.appendChild(el("div", "st-empty", text));
    return this;
  }

  get isEmpty(): boolean {
    return this.body.childElementCount === 0;
  }
}

export interface RowOptions {
  title: string;
  description?: string;
  /** 需要展开才看的长背景说明。 */
  detail?: string;
  /** 右侧控件。不给就是纯信息行。 */
  control?: HTMLElement;
  /** 控件换到标题下方整行铺开（单选卡、列表编辑器这类装不进右侧的）。 */
  block?: HTMLElement;
}

export function row(options: RowOptions): HTMLElement {
  const root = el("div", "st-row");
  const head = el("div", "st-row-head");

  const text = el("div", "st-row-text");
  text.appendChild(el("div", "st-row-title", options.title));
  if (options.description) {
    text.appendChild(el("div", "st-row-desc", options.description));
  }
  if (options.detail) text.appendChild(detailFold(options.detail));
  head.appendChild(text);

  if (options.control) {
    const control = el("div", "st-row-control");
    control.appendChild(options.control);
    head.appendChild(control);
  }
  root.appendChild(head);

  if (options.block) {
    const block = el("div", "st-row-block");
    block.appendChild(options.block);
    root.appendChild(block);
  }
  return root;
}

/**
 * 长说明折叠。
 *
 * 这些设置背后往往有一段「为什么默认是这个值」的理由，全铺出来会把一页撑得没法扫，
 * 但删掉用户就只能靠猜。折起来是这两者之间唯一诚实的处理。
 */
function detailFold(text: string): HTMLElement {
  const fold = el("details", "st-row-detail");
  const summary = el("summary", undefined, "详细说明");
  fold.appendChild(summary);
  fold.appendChild(el("p", undefined, text));
  return fold;
}

export function toggle(
  checked: boolean,
  onChange: (next: boolean) => void,
  options: { disabled?: boolean; label?: string } = {},
): HTMLElement {
  const wrap = el("label", "st-toggle");
  if (options.disabled) wrap.classList.add("disabled");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = options.disabled === true;
  if (options.label) input.setAttribute("aria-label", options.label);
  input.addEventListener("change", () => onChange(input.checked));
  const track = el("span", "st-toggle-track");
  track.appendChild(el("span", "st-toggle-knob"));
  wrap.append(input, track);
  return wrap;
}

export interface SelectOption {
  value: string;
  label: string;
}

export function dropdown(
  value: string,
  options: readonly SelectOption[],
  onChange: (next: string) => void,
  config: { disabled?: boolean } = {},
): HTMLElement {
  const select = document.createElement("select");
  select.className = "st-select";
  select.disabled = config.disabled === true;
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    if (option.value === value) node.selected = true;
    select.appendChild(node);
  }
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** 每个选项自带一句说明时用卡片：下拉会把这些说明藏起来，等于没写。 */
export function radioCards(
  value: string,
  options: readonly { value: string; label: string; description?: string }[],
  onChange: (next: string) => void,
): HTMLElement {
  const group = el("div", "st-cards");
  group.setAttribute("role", "radiogroup");
  for (const option of options) {
    const active = option.value === value;
    const card = el("button", `st-choice${active ? " active" : ""}`);
    card.type = "button";
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", active ? "true" : "false");
    card.appendChild(el("span", "st-choice-label", option.label));
    if (option.description) {
      card.appendChild(el("span", "st-choice-desc", option.description));
    }
    card.addEventListener("click", () => {
      if (!active) onChange(option.value);
    });
    group.appendChild(card);
  }
  return group;
}

export interface StepperConfig {
  min: number;
  max: number;
  step: number;
  unit?: string;
}

/**
 * 数字步进器。
 *
 * 只在失焦或回车时提交：每敲一个数字就写一次设置，会把「30」这种中间状态
 * 也当成用户的选择存下去，还会触发一串下游重算。
 */
export function stepper(
  value: number,
  config: StepperConfig,
  onCommit: (next: number) => void,
): HTMLElement {
  const wrap = el("div", "st-stepper");
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.className = "st-stepper-input";
  input.value = String(value);

  const clamp = (raw: number): number =>
    Math.min(config.max, Math.max(config.min, Math.round(raw)));

  const commit = (next: number): void => {
    const bounded = clamp(next);
    input.value = String(bounded);
    if (bounded !== value) onCommit(bounded);
  };

  const readInput = (): number => {
    const parsed = Number(input.value.trim());
    return Number.isFinite(parsed) ? parsed : value;
  };

  const minus = button("−", "ghost", () => commit(readInput() - config.step), {
    disabled: value <= config.min,
    title: "减小",
  });
  minus.classList.add("st-stepper-btn");
  const plus = button("+", "ghost", () => commit(readInput() + config.step), {
    disabled: value >= config.max,
    title: "增大",
  });
  plus.classList.add("st-stepper-btn");

  input.addEventListener("blur", () => commit(readInput()));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(readInput());
    }
  });

  wrap.append(minus, input);
  if (config.unit) wrap.appendChild(el("span", "st-stepper-unit", config.unit));
  wrap.appendChild(plus);
  return wrap;
}

/** 文本框：同样只在失焦/回车提交，理由与步进器一致。 */
export function textInput(
  value: string,
  onCommit: (next: string) => void,
  options: { placeholder?: string; wide?: boolean } = {},
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = options.wide ? "st-input wide" : "st-input";
  input.value = value;
  if (options.placeholder) input.placeholder = options.placeholder;
  const commit = (): void => {
    if (input.value !== value) onCommit(input.value);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });
  return input;
}

export function textArea(
  value: string,
  onInput: (next: string) => void,
  options: { placeholder?: string; rows?: number } = {},
): HTMLTextAreaElement {
  const area = document.createElement("textarea");
  area.className = "st-textarea";
  area.value = value;
  area.rows = options.rows ?? 3;
  if (options.placeholder) area.placeholder = options.placeholder;
  area.addEventListener("input", () => onInput(area.value));
  return area;
}

/**
 * 字符串列表编辑器（域名白名单这类）。
 *
 * 每一项一个可删的 chip，底部一个输入框回车新增。比一个逗号分隔的文本框好在：
 * 用户能看清到底存了几条，也不会因为多打一个逗号就写进一条空域名。
 */
export function stringListEditor(
  values: readonly string[],
  onChange: (next: string[]) => void,
  options: { placeholder?: string } = {},
): HTMLElement {
  const wrap = el("div", "st-list-editor");
  if (values.length === 0) {
    wrap.appendChild(el("span", "st-list-empty", "（空）"));
  }
  for (const value of values) {
    const chip = el("span", "st-chip");
    chip.appendChild(el("span", "st-chip-text", value));
    const remove = el("button", "st-chip-remove", "×");
    remove.type = "button";
    remove.title = `移除 ${value}`;
    remove.addEventListener("click", () => {
      onChange(values.filter((entry) => entry !== value));
    });
    chip.appendChild(remove);
    wrap.appendChild(chip);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "st-list-input";
  input.placeholder = options.placeholder ?? "回车添加";
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const next = input.value.trim();
    if (!next || values.includes(next)) {
      input.value = "";
      return;
    }
    onChange([...values, next]);
  });
  wrap.appendChild(input);
  return wrap;
}

/** 列表条目：技能、MCP 服务器、规则文件、权限规则共用一种壳。 */
export interface ListItemOptions {
  title: string;
  badges?: readonly { text: string; tone?: Tone }[];
  meta?: readonly string[];
  control?: HTMLElement;
  actions?: readonly HTMLElement[];
}

export function listItem(options: ListItemOptions): HTMLElement {
  const root = el("div", "st-item");
  const head = el("div", "st-item-head");

  const title = el("div", "st-item-title-wrap");
  title.appendChild(el("span", "st-item-title", options.title));
  for (const entry of options.badges ?? []) {
    title.appendChild(badge(entry.text, entry.tone));
  }
  head.appendChild(title);

  const right = el("div", "st-item-right");
  for (const action of options.actions ?? []) right.appendChild(action);
  if (options.control) right.appendChild(options.control);
  head.appendChild(right);
  root.appendChild(head);

  for (const line of options.meta ?? []) {
    if (line) root.appendChild(el("div", "st-item-meta", line));
  }
  return root;
}

export function notice(level: "info" | "warn" | "error", message: string): HTMLElement {
  return el("div", `st-notice ${level}`, message);
}
