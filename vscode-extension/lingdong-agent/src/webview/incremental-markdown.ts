/**
 * 流式正文的增量渲染。
 *
 * 流式回复过去每 80ms 就把整段 Markdown 重新 innerHTML 一次，长回复会
 * 越写越卡，已渲染的代码块也会被反复重建（复制按钮闪一下、滚动位置跳动）。
 * 这里把 Markdown 切成顶层块，只重绘「和上次不同的那些块」——流式时通常
 * 只有最后一块在增长，前面的 DOM 完全不动。
 */

const FENCE_OPEN = /^\s{0,3}(?:```|~~~)/;

type BlockKind = "list" | "table" | "quote" | "other";

function blockKind(text: string): BlockKind {
  const first = text.split("\n", 1)[0] ?? "";
  if (/^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(first)) return "list";
  if (/^\s{0,3}\|/.test(first)) return "table";
  if (/^\s{0,3}>/.test(first)) return "quote";
  return "other";
}

function fenceMarker(line: string): string | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  return match?.[1];
}

/**
 * 按空行切分顶层块；围栏代码块整体保留，列表 / 表格 / 引用的连续段落合并，
 * 避免「松散列表」被拆成两个 <ul> 而改变观感。
 */
export function splitMarkdownBlocks(raw: string): string[] {
  const lines = raw.split("\n");
  const chunks: string[] = [];
  let buffer: string[] = [];
  let fence: string | undefined;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n");
    if (text.trim()) chunks.push(text);
    buffer = [];
  };

  for (const line of lines) {
    if (fence) {
      buffer.push(line);
      const marker = fenceMarker(line);
      // 结束围栏的标记长度必须不短于开启标记。
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
        flush();
      }
      continue;
    }
    const opening = FENCE_OPEN.test(line) ? fenceMarker(line) : undefined;
    if (opening) {
      flush();
      buffer.push(line);
      fence = opening;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  const merged: string[] = [];
  for (const chunk of chunks) {
    const previous = merged.at(-1);
    const kind = blockKind(chunk);
    if (previous && kind !== "other" && blockKind(previous) === kind) {
      merged[merged.length - 1] = `${previous}\n\n${chunk}`;
      continue;
    }
    merged.push(chunk);
  }
  return merged;
}

/** 块是否是一个尚未闭合的围栏代码块（首行开栏、无对应收栏行）。 */
export function isOpenFence(block: string): boolean {
  const lines = block.split("\n");
  const opening = fenceMarker(lines[0] ?? "");
  if (!opening) return false;
  for (const line of lines.slice(1)) {
    const marker = fenceMarker(line);
    if (marker && marker[0] === opening[0] && marker.length >= opening.length) return false;
  }
  return true;
}

function firstLine(block: string): string {
  return block.split("\n", 1)[0] ?? "";
}

/** 未闭合围栏在 markdown-it 下渲染出的代码文本：开栏行之后的一切，带结尾换行。 */
function openFenceBody(block: string): string {
  const index = block.indexOf("\n");
  if (index < 0) return "";
  return `${block.slice(index + 1)}\n`;
}

export interface IncrementalMarkdownOptions {
  /** Markdown → 净化后 HTML。由调用方注入，保持本模块与渲染器解耦。 */
  renderHtml(source: string): string;
  /** 渲染后的增强处理（代码块工具栏、外链拦截等）。 */
  enhance?(block: HTMLElement): void;
}

/** 维护 `.md-body` 下的块级 DOM，与上一次渲染做前缀比较后只重绘尾部。 */
export class IncrementalMarkdownBody {
  private rendered: string[] = [];

  constructor(
    private readonly body: HTMLElement,
    private readonly options: IncrementalMarkdownOptions,
  ) {}

  /** 已渲染的块，供测试断言增量行为。 */
  get blocks(): readonly string[] {
    return this.rendered;
  }

  update(rawMarkdown: string): void {
    const next = splitMarkdownBlocks(rawMarkdown);
    let common = 0;
    while (
      common < next.length
      && common < this.rendered.length
      && next[common] === this.rendered[common]
    ) {
      common += 1;
    }
    if (common === next.length && next.length === this.rendered.length) return;

    // 尾块是未闭合围栏且只有它在增长：只更新 <code> 文本，不整块重建，
    // 消除代码块工具条每帧闪烁与滚动跳动。围栏闭合那一帧块内容会变化，
    // 自然落回下面的整块重绘，拿到完整的最终渲染。
    if (
      next.length === this.rendered.length
      && common === next.length - 1
      && isOpenFence(next[common] ?? "")
      // 开栏行（含语言标注）必须没变，否则重建以刷新语言标签。
      && firstLine(next[common] ?? "") === firstLine(this.rendered[common] ?? "")
      && this.patchFenceTail(next[common] ?? "")
    ) {
      this.rendered = next;
      return;
    }

    while (this.body.children.length > common) {
      this.body.lastElementChild?.remove();
    }
    for (let index = common; index < next.length; index += 1) {
      this.body.appendChild(this.renderBlock(next[index] ?? ""));
    }
    this.rendered = next;
  }

  /** 就地更新尾部代码块的文本。DOM 形状对不上（尾块不是单个代码块）时返回 false 走整块重绘。 */
  private patchFenceTail(source: string): boolean {
    const last = this.body.lastElementChild;
    if (!last) return false;
    const codes = last.querySelectorAll("pre code");
    const code = codes.length === 1 ? codes[0] : undefined;
    if (!code) return false;
    code.textContent = openFenceBody(source);
    return true;
  }

  reset(): void {
    this.rendered = [];
    this.body.replaceChildren();
  }

  private renderBlock(source: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "md-block";
    wrap.innerHTML = this.options.renderHtml(source);
    this.options.enhance?.(wrap);
    return wrap;
  }
}
