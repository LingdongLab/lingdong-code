import { looksBinaryText } from "../dropped-file";
import type { UiAgentMode, WebviewToHostMessage } from "../messages";
import { MODE_LABELS, type AppElements, type AppState, type Post } from "./app-context";
import { element } from "./dom-utils";
import { statusStack } from "./status-stack";

/**
 * 底部输入区：输入框、发送 / 停止、上下文 chips、「+」菜单、模型浮层与用量浮层。
 * 上下文为空时整块 chips 容器隐藏，避免出现空白胶囊。
 */

// 空态 1-2 行起步（对齐 Cursor 的紧凑输入框），输入时自动长高到上限。
const INPUT_MIN_HEIGHT = 44;
const INPUT_MAX_HEIGHT = 220;

/** 上下文 chips 默认最多铺这么多个，其余折成 +N。 */
export const CONTEXT_CHIP_LIMIT = 4;
/** ↑ 召回最多记这么多条历史输入。 */
const RECALL_LIMIT = 30;
/** 底条窄于这个宽度就进紧凑态：藏快捷键提示、发送只留箭头。 */
export const COMPACT_BAR_WIDTH = 420;

const CONTEXT_ICONS: Record<string, string> = {
  file: "📄",
  selection: "✂",
  folder: "📁",
  terminal: "▸",
  diagnostics: "⚠",
  image: "🖼",
};

/** Windows / Snipaste 拖出来的文件经常 `type` 为空，不能只靠 MIME。 */
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|heif)$/i;

/** 一次拖入的非图片文件上限；每个文件都要读内容并发给宿主逐个还原，太多会卡。 */
const MAX_DROPPED_FILES = 5;

/**
 * 拖入文件的大小上限，与宿主的 CONTEXT_LIMITS.fileBytes 对齐（200KB）。
 * 不直接 import context-model：它依赖 @lingdong/agent-runtime（Node 模块），进不了 webview 包。
 */
const DROPPED_FILE_BYTES = 200 * 1024;

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
};

/** 是否应按「看图附件」处理（MIME 或扩展名）。 */
export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return IMAGE_NAME.test(file.name);
}

/** FileReader 在 type 为空时会写成 application/octet-stream，宿主校验只认 image/*。 */
function normalizeImageDataUrl(dataUrl: string, fileName: string): string | undefined {
  if (dataUrl.startsWith("data:image/")) return dataUrl;
  const match = /^data:([^;]*);base64,(.+)$/i.exec(dataUrl);
  if (!match) return undefined;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const mime = EXT_MIME[ext];
  if (!mime) return undefined;
  return `data:${mime};base64,${match[2]}`;
}

function contextIcon(type: string): string {
  return CONTEXT_ICONS[type] ?? "◆";
}

function contextChipTitle(item: { label: string; size: number; truncated: boolean }): string {
  const size = item.size > 0 ? `约 ${formatTokenCount(item.size)} 字符` : "";
  return [item.label, size, item.truncated ? "已截断" : ""].filter(Boolean).join(" · ");
}

export interface ComposerDeps {
  el: AppElements;
  state: AppState;
  post: Post;
  /** 需要在会话流里给出提示时调用。 */
  notice(text: string): void;
  openWorkbenchTool(tool: "context"): void;
  /** 提交前的拦截钩子；返回 true 表示这次输入已被 Slash 命令消费。 */
  interceptSubmit?(): boolean;
  /** 一并关闭 @ 与 / 候选浮层；返回 true 表示确实关掉了什么。 */
  closeExtraPopovers?(): boolean;
  onSend(text: string): void;
}

export class ComposerView {
  /** 上下文 chips 是否已展开到全部；折叠是默认态。 */
  private contextChipsExpanded = false;
  /** 空输入按 ↑ 依次召回历史 prompt；-1 表示没在召回。 */
  private recallCursor = -1;
  private readonly recallHistory: string[] = [];

  constructor(private readonly deps: ComposerDeps) {}

  /** 状态栏、按钮可用性与占位文案统一在这里刷新。 */
  updateChrome(): void {
    const { el, state } = this.deps;
    // 顶部会话行：不再塞「任务执行中」或不可用用量；运行态只在 Composer 上方 Status Bar。
    const usageBit = formatComposerUsageBit(state.usage);
    el.statusLine.textContent = state.composerLine?.includes("暂不可用")
      ? `${MODE_LABELS[state.mode]} · ${state.modelLabel}${usageBit ? ` · ${usageBit}` : ""}`
      : (state.composerLine || `${MODE_LABELS[state.mode]} · ${state.modelLabel}${usageBit ? ` · ${usageBit}` : ""}`);
    this.applyModeRestriction();
    el.modelName.textContent = state.modelLabel;
    el.modelBtn.title = state.modelLabel;
    // 发送/停止是同一个形态切换按钮：空闲=发送，运行中=停止（Esc 同样可停）。
    // stopping 时 canStop=false → 按钮立刻 disabled。
    const stopping = state.busy || state.turnActive;
    const canStop = state.canCancel || state.turnCanStop;
    const disabled = stopping ? !canStop : !state.canSend;
    const sendLabel = el.send.querySelector<HTMLElement>(".send-label");
    if (sendLabel) sendLabel.textContent = stopping ? "停止" : "发送";
    el.send.classList.toggle("btn-stop", stopping);
    el.send.disabled = disabled;
    el.send.title = stopping
      ? disabled
        ? "任务正在收尾，这一刻停不下来"
        : "停止当前任务（Esc）"
      : disabled
        ? el.input.value.trim() ? "还没连上模型，先看右下角的重连" : "先写点内容再发送"
        : "发送（Enter）";
    el.input.placeholder = stopping
      ? "任务执行中……Enter 排队发送，Esc 停止"
      : state.mode === "plan"
        ? "补充澄清或要求调整计划…"
        : "描述你想让灵动 Code 完成的任务……";
    this.renderQueueChips();
    // 完整计划文档已移到右侧工作台，中间只剩紧凑卡，不再因「存在计划」而加宽会话栏。
    this.setWide(state.mode === "plan");
    this.paintUsageChip();
  }

  /** Context 不可用则隐藏；可用显示 Cursor 式圆环；满则保留压缩入口。 */
  paintUsageChip(): void {
    const { el, state } = this.deps;
    const pct = formatComposerUsagePercent(state.usage);
    if (pct === undefined) {
      el.usageLabel.hidden = true;
      return;
    }
    el.usageLabel.hidden = false;
    if (state.usage) el.usageLabel.dataset.level = state.usage.level;
    const clamped = Math.max(0, Math.min(100, pct));
    el.usageLabel.style.setProperty("--usage-pct", String(clamped));
    const value = el.usageLabel.querySelector<SVGCircleElement>(".usage-ring-value");
    if (value) {
      const radius = Number(value.getAttribute("r") || 7);
      const circumference = 2 * Math.PI * radius;
      value.style.strokeDasharray = String(circumference);
      value.style.strokeDashoffset = String(circumference * (1 - clamped / 100));
    }
    // 到了警戒线光看圆环判断不出「还剩多少」，直接把数字摆出来。
    const showNumber = state.usage?.level === "warning"
      || state.usage?.level === "critical"
      || state.usage?.level === "full";
    el.usagePct.hidden = !showNumber;
    el.usagePct.textContent = showNumber ? `${Math.round(clamped)}%` : "";
    el.usageLabel.classList.toggle("with-number", showNumber);
    if (state.usage?.level === "full") {
      el.usageLabel.title = "上下文已满，点击可压缩";
    } else {
      const hover = [
        state.usage ? formatUsagePercentLineFromView(state.usage) : "",
        state.usage ? formatUsageTokensLineFromView(state.usage) : "",
      ].filter(Boolean).join("\n");
      el.usageLabel.title = hover || "上下文用量";
    }
  }

  /**
   * 模式芯片：只负责切换 Ask/Plan/Agent…（对标 Cursor 的 mode picker）。
   * 「＋」只加上下文，不再塞同一份模式列表。
   */
  private applyModeRestriction(): void {
    const { el, state } = this.deps;
    el.modeChip.textContent = MODE_LABELS[state.mode];
    el.modeChip.disabled = !state.canSwitchMode;
    el.modeChip.title = state.askOnly
      ? state.askOnlyReason
      : state.canSwitchMode
        ? "切换工作模式"
        : "任务执行中不能切换模式";
  }

  /**
   * 窄面板下先撤快捷键提示、再把发送收成一个箭头。
   * 面板宽度会随左右栏拖动变，媒体查询看的是窗口宽度，对不上，只能量自己。
   */
  observeWidth(): void {
    const bar = this.deps.el.composerBar;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => this.applyCompact(bar.clientWidth));
    observer.observe(bar);
    this.applyCompact(bar.clientWidth);
  }

  applyCompact(width: number): void {
    // 420px 以下三枚芯片加提示加发送就开始互相挤压。
    this.deps.el.composerBar?.classList.toggle("compact", width > 0 && width < COMPACT_BAR_WIDTH);
  }

  setWide(wide: boolean): void {
    this.deps.el.messagesInner.classList.toggle("plan-wide", wide);
    this.deps.el.composerShell.classList.toggle("plan-wide", wide);
  }

  autoResize(): void {
    const { input } = this.deps.el;
    input.style.height = "auto";
    const next = Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, input.scrollHeight));
    input.style.height = `${next}px`;
  }

  fill(text: string): void {
    this.deps.el.input.value = text;
    this.deps.el.input.focus();
    this.autoResize();
  }

  focus(): void { this.deps.el.input.focus(); }

  submit(): void {
    if (this.deps.interceptSubmit?.()) return;
    const text = this.deps.el.input.value.trim();
    if (!text) return;
    // 忙时不再静默丢弃：照常发给宿主，由宿主入队并回执队列快照。
    if (!this.deps.state.canSend && !this.deps.state.busy) return;
    this.deps.el.input.value = "";
    this.noteSent(text);
    this.autoResize();
    this.deps.onSend(text);
  }

  /** 记进召回历史；连续重复的同一句只留一条。 */
  noteSent(text: string): void {
    this.recallCursor = -1;
    if (this.recallHistory[0] === text) return;
    this.recallHistory.unshift(text);
    if (this.recallHistory.length > RECALL_LIMIT) this.recallHistory.length = RECALL_LIMIT;
  }

  /**
   * 空输入按 ↑ 召回上一条 prompt，继续按继续往前翻，↓ 往回走直到清空。
   * 返回 true 表示这次按键已被消费。输入框里有内容时不拦截——那时 ↑ 应该移动光标。
   */
  recallPrompt(direction: "up" | "down"): boolean {
    const input = this.deps.el.input;
    const recalling = this.recallCursor >= 0;
    if (!recalling && (direction === "down" || input.value.trim() !== "")) return false;
    if (this.recallHistory.length === 0) return false;

    const next = direction === "up" ? this.recallCursor + 1 : this.recallCursor - 1;
    if (next >= this.recallHistory.length) return true;
    this.recallCursor = Math.max(-1, next);
    input.value = this.recallCursor < 0 ? "" : this.recallHistory[this.recallCursor] as string;
    this.autoResize();
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
    return true;
  }

  /**
   * 「＋」菜单选图：不走 VS Code 拖放（默认会被编辑器抢走），用隐藏 file input。
   */
  pickImageFiles(): void {
    this.closeAllPopovers();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp,.png,.jpg,.jpeg,.gif,.webp,.bmp";
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) this.handleImageDrop(files);
    });
    input.click();
  }

  /**
   * 粘贴 / 拖入图片：字节发给宿主暂存，回来变成一枚上下文 chip。
   *
   * 当前模型不收图就直接拒绝，不做「保存成附件」那种看着成功、模型其实什么都没看见的降级。
   * 返回 true 表示这次粘贴已被接管（要 preventDefault），拒绝也算接管——
   * 否则图片文件名会被当成文本插进输入框。
   */
  /**
   * 拖入的非图片文件。
   *
   * 浏览器安全模型拿不到拖入文件的真实路径（Electron 高版本已移除 File.path），
   * 所以这里读出名字和内容交给宿主，由宿主按名字在仓库里还原路径后走正规的
   * 文件上下文入口（含边界校验与脱敏）。还原不了宿主会明确提示，不静默吞掉。
   * 返回 true 表示这次拖放已被接管。
   */
  handleFileDrop(files: readonly File[]): boolean {
    const plain = files.filter((file) => !isImageFile(file));
    if (plain.length === 0) return false;
    const batch = plain.slice(0, MAX_DROPPED_FILES);
    if (plain.length > batch.length) {
      this.deps.notice(`一次最多拖入 ${MAX_DROPPED_FILES} 个文件，多出的已忽略。`);
    }
    for (const file of batch) {
      if (file.size > DROPPED_FILE_BYTES) {
        this.deps.notice(`${file.name} 超过单文件 ${Math.floor(DROPPED_FILE_BYTES / 1024)}KB 上限，未添加。`);
        continue;
      }
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        if (looksBinaryText(text)) {
          this.deps.notice(`${file.name} 看起来是二进制文件，无法作为文本上下文添加。`);
          return;
        }
        this.deps.post({ type: "addDroppedFile", name: file.name, content: text });
      });
      reader.addEventListener("error", () => {
        this.deps.notice(`读取 ${file.name} 失败。`);
      });
      reader.readAsText(file);
    }
    return true;
  }

  handleImageDrop(files: readonly File[]): boolean {
    const images = files.filter(isImageFile);
    if (images.length === 0) return false;
    if (!this.deps.state.capabilities.imagesConfigured) {
      this.deps.notice(
        this.deps.state.capabilities.hasVisionModel
          ? "当前模型不支持图片输入，换一个支持看图的模型再试。"
          : "当前没有支持图片输入的模型，可在模型中心添加一个。",
      );
      return true;
    }
    for (const image of images) {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const raw = typeof reader.result === "string" ? reader.result : "";
        const data = raw ? normalizeImageDataUrl(raw, image.name || "paste.png") : undefined;
        if (!data) {
          this.deps.notice("这张图读不出来，请换一张或改用粘贴。");
          return;
        }
        this.deps.post({
          type: "addImageContext",
          name: image.name || "粘贴的图片",
          dataUrl: data,
        });
      });
      reader.addEventListener("error", () => {
        this.deps.notice("读取图片失败，请换一张或改用粘贴。");
      });
      reader.readAsDataURL(image);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 忙时发送队列 chips
  // ---------------------------------------------------------------------------

  /** 正在就地编辑的排队消息 id；null 表示没有条目处于编辑态。 */
  private editingQueueId: string | null = null;

  /**
   * composer 上方的排队消息：点文本就地改写，↑/↓ 重排，删除常在，
   * 空闲（如停止后）补「立即发送」。编辑/重排都走宿主本地队列，
   * 不经 Grok 的 x.ai/queue/*——我们的队列是宿主侧一次只发一条，Grok 队列始终空。
   */
  renderQueueChips(): void {
    const { el, state } = this.deps;
    el.queueChips.replaceChildren();
    const queue = state.sendQueue;
    queue.forEach((item, index) => {
      const chip = element("span", "queue-chip");
      chip.appendChild(this.queueChipBody(item, index, queue.length));
      if (!state.busy && this.editingQueueId !== item.id) {
        const flush = element("button", "queue-chip-send", "立即发送");
        flush.type = "button";
        flush.addEventListener("click", () => this.deps.post({ type: "queueFlush", id: item.id }));
        chip.appendChild(flush);
      }
      const remove = element("button", "queue-chip-remove", "×");
      remove.type = "button";
      remove.title = "从队列移除";
      remove.addEventListener("click", () => this.deps.post({ type: "queueRemove", id: item.id }));
      chip.appendChild(remove);
      el.queueChips.appendChild(chip);
    });
    statusStack.register("queue", el.queueChips);
    statusStack.want("queue", queue.length > 0);
  }

  /** chip 主体：编辑态给输入框，否则给可点击的文本 + ↑/↓ 重排按钮。 */
  private queueChipBody(item: { id: string; text: string }, index: number, total: number): HTMLElement {
    if (this.editingQueueId === item.id) {
      const editor = element("input", "queue-chip-edit") as HTMLInputElement;
      editor.type = "text";
      editor.value = item.text;
      let done = false;
      const commit = (): void => {
        if (done) return;
        done = true;
        const next = editor.value.trim();
        this.editingQueueId = null;
        if (next.length > 0 && next !== item.text) {
          this.deps.post({ type: "queueEdit", id: item.id, text: next });
        } else {
          this.renderQueueChips();
        }
      };
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        else if (event.key === "Escape") { event.preventDefault(); done = true; this.editingQueueId = null; this.renderQueueChips(); }
      });
      editor.addEventListener("blur", commit);
      // 渲染后聚焦并把光标移到末尾。
      queueMicrotask(() => { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); });
      return editor;
    }

    const body = element("span", "queue-chip-body");
    const label = element("button", "queue-chip-text", item.text);
    label.type = "button";
    label.title = "点击编辑这条排队消息";
    label.addEventListener("click", () => { this.editingQueueId = item.id; this.renderQueueChips(); });
    body.appendChild(label);

    if (total > 1) {
      const up = element("button", "queue-chip-move", "↑");
      up.type = "button";
      up.title = "上移";
      up.disabled = index === 0;
      up.addEventListener("click", () => this.moveQueued(index, index - 1));
      const down = element("button", "queue-chip-move", "↓");
      down.type = "button";
      down.title = "下移";
      down.disabled = index === total - 1;
      down.addEventListener("click", () => this.moveQueued(index, index + 1));
      body.append(up, down);
    }
    return body;
  }

  /** 相邻交换后把整串新顺序发给宿主；本地不改状态，等 sendQueue 回执重绘。 */
  private moveQueued(from: number, to: number): void {
    const ids = this.deps.state.sendQueue.map((item) => item.id);
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    this.deps.post({ type: "queueReorder", orderedIds: ids });
  }

  // ---------------------------------------------------------------------------
  // 上下文 chips
  // ---------------------------------------------------------------------------

  renderContextChips(): void {
    const { el, state } = this.deps;
    el.contextItems.replaceChildren();
    const items = state.contextItems.filter((item) => item.label?.trim());
    // 超过这个数就折成 +N：chips 铺满两三行时输入框被挤到只剩一条缝。
    const visible = this.contextChipsExpanded ? items : items.slice(0, CONTEXT_CHIP_LIMIT);

    for (const item of visible) {
      const chip = element("span", "chip context-chip");
      const label = element("button", "context-chip-label");
      label.type = "button";
      label.appendChild(element("span", "context-chip-icon", contextIcon(item.type)));
      label.appendChild(element("span", "context-chip-text", item.label));
      if (item.lineRange) {
        const { start, end } = item.lineRange;
        label.appendChild(element(
          "span",
          "context-chip-lines",
          start === end ? `:${start}` : `:${start}-${end}`,
        ));
      }
      // hover 预览：chip 上只放得下文件名，全路径和大小得靠 title。
      label.title = contextChipTitle(item);
      label.addEventListener("click", () => this.deps.post({ type: "showContext", id: item.id }));

      const remove = element("button", "context-chip-remove", "×");
      remove.type = "button";
      remove.title = `移除 ${item.label}`;
      remove.setAttribute("aria-label", `移除 ${item.label}`);
      remove.addEventListener("click", () => this.deps.post({ type: "removeContext", id: item.id }));
      chip.append(label, remove);
      el.contextItems.appendChild(chip);
    }

    const hidden = items.length - visible.length;
    if (hidden > 0 || this.contextChipsExpanded) {
      const more = element(
        "button",
        "chip context-chip-more",
        this.contextChipsExpanded ? "收起" : `+${hidden}`,
      );
      more.type = "button";
      more.title = this.contextChipsExpanded ? "收起上下文列表" : `还有 ${hidden} 项上下文`;
      more.addEventListener("click", () => {
        this.contextChipsExpanded = !this.contextChipsExpanded;
        this.renderContextChips();
      });
      el.contextItems.appendChild(more);
    }

    const empty = el.contextItems.childElementCount === 0;
    if (empty) this.contextChipsExpanded = false;
    el.contextItems.hidden = empty;
    el.contextItems.classList.toggle("chips-empty", empty);
  }

  // ---------------------------------------------------------------------------
  // 浮层
  // ---------------------------------------------------------------------------

  closeAllPopovers(): boolean {
    const { el } = this.deps;
    const layers = [el.plusMenu, el.modeMenu, el.modelPopover, el.usagePopover];
    const had = layers.some((layer) => !layer.hidden);
    for (const layer of layers) layer.hidden = true;
    const extra = this.deps.closeExtraPopovers?.() ?? false;
    return had || extra;
  }

  /**
   * 弹层贴着触发按钮开，不再写死 left/bottom。
   * 芯片行的成员会随模式、模型名长度、用量是否可见而移位，硬编码坐标必然对不齐；
   * 右侧还要防止溢出面板。
   */
  private anchorPopover(popover: HTMLElement, trigger: HTMLElement): void {
    const host = this.deps.el.composerBar;
    const hostRect = host.getBoundingClientRect();
    const rect = trigger.getBoundingClientRect();
    popover.style.bottom = `${hostRect.height + 8}px`;
    // 先量宽度再定位：hidden 的元素量不出尺寸。
    popover.style.left = "0px";
    const width = popover.offsetWidth || 240;
    const max = Math.max(0, hostRect.width - width);
    popover.style.left = `${Math.max(0, Math.min(max, rect.left - hostRect.left))}px`;
  }

  private openLayer(popover: HTMLElement, trigger: HTMLElement, paint: () => void): boolean {
    const wasHidden = popover.hidden;
    this.closeAllPopovers();
    if (!wasHidden) return false;
    paint();
    popover.hidden = false;
    this.anchorPopover(popover, trigger);
    return true;
  }

  togglePlusMenu(): void {
    const { el } = this.deps;
    this.openLayer(el.plusMenu, el.context, () => this.renderPlusMenu());
  }

  /** 模式芯片专用菜单：只有工作模式，不含上下文。 */
  toggleModeMenu(): void {
    const { el } = this.deps;
    this.openLayer(el.modeMenu, el.modeChip, () => this.renderModeMenu());
  }

  toggleModelPopover(): void {
    const { el } = this.deps;
    this.openLayer(el.modelPopover, el.modelBtn, () => this.renderModelPopover());
  }

  toggleUsagePopover(): void {
    const { el } = this.deps;
    const opened = this.openLayer(el.usagePopover, el.usageLabel, () => this.renderUsagePopover());
    if (opened) this.deps.post({ type: "requestUsageDetail" });
  }

  get usagePopoverOpen(): boolean { return !this.deps.el.usagePopover.hidden; }

  private menuItem(host: HTMLElement, label: string, action: string): HTMLButtonElement {
    const button = element("button", "menu-item", label);
    button.type = "button";
    button.dataset.action = action;
    host.appendChild(button);
    return button;
  }

  private menuSection(host: HTMLElement, title: string): void {
    host.appendChild(element("div", "menu-section", title));
  }

  private appendModeItems(host: HTMLElement): void {
    const { state } = this.deps;
    for (const mode of ["ask", "plan", "agent", "auto", "debug"] as const) {
      const button = this.menuItem(host, MODE_LABELS[mode], `mode:${mode}`);
      if (mode === state.mode) {
        button.classList.add("current");
        button.appendChild(element("span", "menu-check", "✓"));
      }
      const restricted = (state.askOnly && mode !== "ask") || !state.canSwitchMode;
      if (restricted) {
        button.disabled = true;
        button.title = state.askOnly && mode !== "ask" ? state.askOnlyReason : "任务执行中不能切换模式";
      }
    }
  }

  /** 「＋」：只加上下文（对标 Cursor @ / Add Context）。模型走右侧模型芯片。 */
  renderPlusMenu(): void {
    const host = this.deps.el.plusMenu;
    host.replaceChildren();
    this.menuSection(host, "添加上下文");
    this.menuItem(host, "图片…", "pickImage");
    this.menuItem(host, "当前文件", "addCurrentFile");
    this.menuItem(host, "选中代码", "addSelection");
    // 指定文件走内联 @，不再弹宿主 QuickPick。
    this.menuItem(host, "指定文件（@）", "beginAtMention");
    this.menuItem(host, "指定文件夹", "pickFolder");
    this.menuItem(host, "终端输出", "addTerminalOutput");
    this.menuItem(host, "问题面板", "addDiagnostics");
    this.menuSection(host, "扩展");
    this.menuItem(host, "设置 · 能力扩展…", "openExtensions");
  }

  /**
   * 在输入框光标处插入 `@` 并聚焦，触发内联补全。
   * 对标 Cursor：加文件上下文不离开对话区。
   */
  beginAtMention(): void {
    const { el } = this.deps;
    this.closeAllPopovers();
    const input = el.input;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insert = `${needsSpace ? " @" : "@"}`;
    input.value = `${before}${insert}${after}`;
    const caret = before.length + insert.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** 模式芯片菜单：只切工作模式。 */
  renderModeMenu(): void {
    const host = this.deps.el.modeMenu;
    host.replaceChildren();
    this.menuSection(host, "工作模式");
    this.appendModeItems(host);
  }

  /** 「+」/模式菜单点击派发。 */
  handlePlusMenuClick(target: EventTarget | null): void {
    const { el } = this.deps;
    if (!(target instanceof Element)) return;
    // 当前模式那一项里有个 ✓ 的 span，点在它上面拿到的是 span 而不是按钮。
    const button = target.closest<HTMLButtonElement>("button.menu-item");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    el.plusMenu.hidden = true;
    el.modeMenu.hidden = true;
    if (!action) return;
    if (action.startsWith("mode:")) {
      this.deps.post({ type: "setMode", mode: action.slice(5) as UiAgentMode });
      return;
    }
    if (action === "beginAtMention") {
      this.beginAtMention();
      return;
    }
    if (action === "pickImage") {
      this.pickImageFiles();
      return;
    }
    this.deps.post({ type: action as WebviewToHostMessage["type"] } as WebviewToHostMessage);
  }

  renderModelPopover(): void {
    const { el, state } = this.deps;
    el.modelPopover.replaceChildren();
    const search = element("input", "model-search");
    search.placeholder = "搜索模型";
    el.modelPopover.appendChild(search);
    const list = element("div");
    el.modelPopover.appendChild(list);

    const paint = (query: string): void => {
      list.replaceChildren();
      if (state.capabilities.autoSelectModels) {
        const auto = element("button", "model-item");
        auto.type = "button";
        auto.appendChild(element("span", "name", "Auto"));
        auto.appendChild(element("span", "meta", "自动选择可用模型"));
        auto.disabled = true;
        auto.title = "当前模型数量不足以启用 Auto";
        list.appendChild(auto);
      }
      const needle = query.trim().toLowerCase();
      // 按 Provider 分组：用户需要一眼看出数据会发给哪一家。
      const groups = new Map<string, typeof state.models>();
      for (const model of state.models) {
        const hit = !needle
          || model.displayName.toLowerCase().includes(needle)
          || model.id.toLowerCase().includes(needle)
          || model.provider.toLowerCase().includes(needle);
        if (!hit) continue;
        const key = model.provider || model.providerId;
        const bucket = groups.get(key);
        if (bucket) bucket.push(model);
        else groups.set(key, [model]);
      }
      for (const [providerName, models] of groups) {
        list.appendChild(element("div", "model-group", providerName));
        for (const model of models) {
          const button = element("button", `model-item${model.id === state.model ? " active" : ""}`);
          button.type = "button";
          const name = element("span", "name", model.displayName);
          // 没通过工具调用检测的模型必须当场说清限制，而不是等进了 Agent 才失败。
          if (!model.agentCompatible) name.appendChild(element("span", "model-badge", "仅 Ask"));
          button.appendChild(name);
          button.appendChild(element(
            "span",
            "meta",
            `${model.reasoningProfile === "deep" ? "深度" : "标准"}`
            + ` · 工具 ${model.supportsTools ? "是" : "否"} · 图片 ${model.supportsVision ? "是" : "否"}`,
          ));
          if (!model.agentCompatible) {
            button.title = "该模型未通过工具调用检测，选中后将只能使用 Ask 模式。";
          }
          button.addEventListener("click", () => {
            this.deps.post({ type: "selectModel", modelId: model.id });
            el.modelPopover.hidden = true;
          });
          list.appendChild(button);
        }
      }
      if (groups.size === 0) {
        list.appendChild(element(
          "div",
          "model-empty",
          "没有可用模型。请在「设置 · 模型」里配置服务商密钥并通过连接测试。",
        ));
      }
      const custom = element("button", "menu-item", "设置 · 模型…");
      custom.type = "button";
      custom.addEventListener("click", () => {
        this.deps.post({ type: "openModelSettings" });
        el.modelPopover.hidden = true;
      });
      list.appendChild(custom);
    };
    search.addEventListener("input", () => paint(search.value));
    paint("");
  }

  renderUsagePopover(): void {
    const { el, state } = this.deps;
    el.usagePopover.replaceChildren();
    const head = element("div", "usage-popover-head");
    head.appendChild(element("div", "panel-title", "上下文用量"));
    const close = element("button", "usage-popover-close", "×");
    close.type = "button";
    close.title = "关闭";
    close.setAttribute("aria-label", "关闭上下文用量");
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      el.usagePopover.hidden = true;
    });
    head.appendChild(close);
    el.usagePopover.appendChild(head);

    // 对标 Cursor：百分比一行 + tokens 一行，圆环旁点开即见。
    const percent = state.usage ? formatUsagePercentLineFromView(state.usage) : "";
    const tokens = state.usage ? formatUsageTokensLineFromView(state.usage) : "";
    el.usagePopover.appendChild(element("div", "usage-popover-percent", percent || "上下文用量暂不可用"));
    if (tokens) el.usagePopover.appendChild(element("div", "usage-popover-tokens", tokens));
    if (state.usage?.source && state.usage.source !== "unavailable") {
      el.usagePopover.appendChild(element("div", "activity", `来源：${sourceLabel(state.usage.source)}`));
    }
    el.usagePopover.appendChild(element("div", "activity", `已添加 ${state.contextItems.length} 项`));

    const row = element("div", "card-actions");
    const manage = element("button", "btn-ghost", "在右侧管理");
    manage.addEventListener("click", () => {
      el.usagePopover.hidden = true;
      this.deps.openWorkbenchTool("context");
    });
    const compact = element("button", "btn-primary", state.usage?.compactBusy ? "压缩中…" : "压缩");
    compact.disabled = state.usage?.compactCapability !== "available" || !!state.usage?.compactBusy;
    compact.addEventListener("click", () => this.deps.post({ type: "compactContext" }));
    row.append(manage, compact);
    el.usagePopover.appendChild(row);
  }
}

export function sourceLabel(source: string): string {
  if (source === "exact") return "精确";
  if (source === "estimated") return "估算";
  return "暂不可用";
}

/** Composer 圆环：不可用返回 undefined 以便隐藏。 */
export function formatComposerUsagePercent(usage: AppState["usage"]): number | undefined {
  if (!usage) return undefined;
  if (usage.source === "unavailable") return undefined;
  if (typeof usage.percentage === "number" && Number.isFinite(usage.percentage)) {
    return usage.percentage;
  }
  if (usage.usedTokens > 0 && usage.contextLimit && usage.contextLimit > 0) {
    return (usage.usedTokens / usage.contextLimit) * 100;
  }
  if (usage.source === "exact" && usage.usedTokens >= 0 && usage.contextLimit && usage.contextLimit > 0) {
    return (usage.usedTokens / usage.contextLimit) * 100;
  }
  return undefined;
}

/** @deprecated 兼容旧调用；新代码用 formatComposerUsagePercent。 */
export function formatComposerUsageBit(usage: AppState["usage"]): string {
  const pct = formatComposerUsagePercent(usage);
  if (pct === undefined) return "";
  if (usage?.level === "full") return "上下文已满 · 压缩";
  return `Context ${Math.round(pct)}%`;
}

function formatUsagePercentLineFromView(usage: NonNullable<AppState["usage"]>): string {
  const pct = formatComposerUsagePercent(usage);
  if (pct === undefined) return "";
  return `${Math.round(pct)}% context used`;
}

function formatUsageTokensLineFromView(usage: NonNullable<AppState["usage"]>): string {
  if (usage.source === "unavailable") return "";
  if (usage.usedTokens <= 0 && usage.source !== "exact") return "";
  const used = formatTokenCount(usage.usedTokens);
  if (usage.contextLimit && usage.contextLimit > 0) {
    return `${used} / ${formatTokenCount(usage.contextLimit)} tokens`;
  }
  return `${used} tokens`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}K`;
  return String(tokens);
}
