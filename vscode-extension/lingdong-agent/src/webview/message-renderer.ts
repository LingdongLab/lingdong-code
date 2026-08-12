/**
 * 安全 Markdown 渲染：rawMarkdown → markdown-it → DOMPurify → DOM。
 * 持久化仍保存原始 Markdown；此处只负责展示。
 */

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { highlightCodeBlocks } from "./code-highlight";
import { IncrementalMarkdownBody } from "./incremental-markdown";

/**
 * 流式重绘的最小间隔。这是**节流**不是防抖：分片再密也照样按这个节奏出字。
 * 上游常常成串下发（几十个分片挤在几毫秒内到达，然后停几百毫秒），
 * 用防抖的话整串期间一次都不画，空档一到又整段吐出来，看着就是一卡一卡。
 */
export const STREAM_PAINT_INTERVAL_MS = 60;

type Markdown = InstanceType<typeof MarkdownIt>;

const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4",
  "hr", "i", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th",
  "thead", "tr", "ul", "input", "del", "sup", "sub",
];

const ALLOWED_ATTR = [
  "href", "title", "target", "rel", "class", "data-language", "type", "checked", "disabled",
];

let md: Markdown | undefined;

function getMarkdown(): Markdown {
  if (md) return md;
  const instance = new MarkdownIt({
    // 允许渲染器输出受控 HTML（任务列表 checkbox）；最终仍经 DOMPurify。
    html: true,
    linkify: true,
    breaks: true,
    typographer: false,
  });
  instance.use((plugin: Markdown) => {
    plugin.core.ruler.after("inline", "task_lists", (state) => {
      for (const block of state.tokens) {
        if (block.type !== "inline" || !block.children) continue;
        const children = block.children;
        const first = children[0];
        if (!first || first.type !== "text") continue;
        const match = /^\[([ xX])\]\s+/.exec(first.content);
        if (!match) continue;
        first.content = first.content.slice(match[0].length);
        const open = new state.Token("html_inline", "", 0);
        const checked = match[1] !== " ";
        open.content = `<input type="checkbox" disabled${checked ? " checked" : ""} class="task-list-item-checkbox"> `;
        children.unshift(open);
      }
    });
  });
  const fence = instance.renderer.rules.fence;
  instance.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const lang = (token.info || "").trim().split(/\s+/u)[0] ?? "";
    const html = fence
      ? fence(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
    if (!lang) return html;
    return html.replace("<pre>", `<pre data-language="${escapeAttr(lang)}">`);
  };
  md = instance;
  return instance;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export type SanitizeFn = (dirty: string) => string;

let sanitizeImpl: SanitizeFn | undefined;

export function setSanitizeFn(fn: SanitizeFn | undefined): void {
  sanitizeImpl = fn;
}

/** 无 Window 时的严格降级净化。 */
export function fallbackSanitize(dirty: string): string {
  return dirty
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\shref\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, ' href="#"')
    .replace(/\ssrc\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, "");
}

function defaultSanitize(dirty: string): string {
  if (typeof window !== "undefined" && DOMPurify?.sanitize) {
    return DOMPurify.sanitize(dirty, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: true,
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "style"],
      FORBID_ATTR: ["style", "onerror", "onclick", "onload", "onmouseover"],
    });
  }
  return fallbackSanitize(dirty);
}

export function sanitizeHtml(dirty: string): string {
  return (sanitizeImpl ?? defaultSanitize)(dirty);
}

export function renderMarkdownToHtml(rawMarkdown: string): string {
  const rendered = getMarkdown().render(rawMarkdown ?? "");
  return sanitizeHtml(rendered);
}

export function looksLikePlanOutline(rawMarkdown: string): boolean {
  const text = rawMarkdown.trim();
  if (text.length < 40) return false;
  const headingPlan = /(?:^|\n)#{1,3}\s*.*(?:计划|步骤|实施|Plan)\b/im.test(text);
  const numbered = (text.match(/^\s*\d+\.\s+\S+/gm) ?? []).length >= 3;
  const stepWords = /(?:步骤|涉及文件|潜在风险|目标)\s*[:：]/m.test(text);
  return (headingPlan && numbered) || (numbered && stepWords);
}

export function isDisplayNoise(message: string): boolean {
  const text = message.trim();
  if (!text) return true;
  if (/(?:ses-[a-f0-9]{8,}|sessionId|\bACP\b|Grok\s*Build|\\Users\\|\\AppData\\|E:\\|\/home\/|JSON\.parse|Unexpected token|tool_started|tool_completed)/i.test(text)) {
    return true;
  }
  if (/^已完成\s*·\s*\S+/u.test(text)) return true;
  if (/^(?:客户端安全模式|Grok 模式已切换|会话：)/.test(text)) return true;
  return false;
}

export function friendlyRecoveryMessage(raw: string): string | undefined {
  if (/恢复失败|history.*fail|restore.*fail|transcript.*corrupt/i.test(raw)) {
    return "历史记录恢复失败，已使用最近备份。";
  }
  return undefined;
}

export function productizeToolLabel(label: string, kind?: string): { title: string; raw: string } {
  const raw = label.trim() || kind || "tool";
  const lower = raw.toLowerCase();
  if (/list[_ ]?files|list_dir|listdir|glob|列出文件|查看项目/.test(lower)) {
    return { title: "查看项目文件", raw };
  }
  if (/ask[_ ]?user|需要确认|clarif/.test(lower)) {
    return { title: "需要确认", raw };
  }
  if (/run[_ ]?command|execute|bash|shell|终端|命令/.test(lower) || kind === "execute") {
    return { title: "已执行命令", raw };
  }
  if (/^read\b|read_file|读取/.test(lower) || kind === "read") {
    return { title: "已读取", raw };
  }
  if (/search|grep|查找|搜索/.test(lower) || kind === "search") {
    return { title: "已搜索", raw };
  }
  if (/create|write_new|新建|创建/.test(lower)) {
    return { title: "已创建", raw };
  }
  if (/delete|unlink|删除/.test(lower)) {
    return { title: "已删除", raw };
  }
  if (/edit|write|修改|apply_patch/.test(lower) || kind === "edit") {
    return { title: "已修改", raw };
  }
  if (kind === "plan" || /plan|计划/.test(lower)) {
    return { title: "已规划", raw };
  }
  return { title: "已处理", raw };
}

/**
 * 「灵动 Code」表头只在一轮里的第一条助手消息上出现。
 *
 * 从插入位置往前走到上一条用户消息为止：这一段就是当前轮次。中间已经有过助手消息，
 * 说明署名已经出现过，再重复一遍只是噪音——一轮里可能有十几条正文夹着工具卡。
 */
function shouldShowAssistantHeader(parent: HTMLElement): boolean {
  for (let node = parent.lastElementChild; node; node = node.previousElementSibling) {
    if (node.classList.contains("message") && node.classList.contains("user")) return true;
    if (node.classList.contains("assistant-msg")) return false;
  }
  return true;
}

function appendAssistantHeader(root: HTMLElement, parent: HTMLElement): void {
  if (!shouldShowAssistantHeader(parent)) {
    root.classList.add("assistant-continued");
    return;
  }
  const header = document.createElement("div");
  header.className = "assistant-header";
  header.textContent = "灵动 Code";
  root.appendChild(header);
}

export interface StreamRenderHandle {
  root: HTMLElement;
  body: HTMLElement;
  rawMarkdown: string;
  append(delta: string): void;
  finalize(): void;
  dispose(): void;
}

export function createStreamingAssistant(
  parent: HTMLElement,
  options: {
    paintIntervalMs?: number;
    onOpenLink?: (href: string) => void;
    onOpenFile?: (ref: FileReference) => void;
    nearBottom?: () => boolean;
    scrollToEnd?: () => void;
    /** 测试用：每次批量 flush 回调一次（含 finalize）。 */
    onPaint?: (final: boolean) => void;
  } = {},
): StreamRenderHandle {
  const paintIntervalMs = options.paintIntervalMs ?? STREAM_PAINT_INTERVAL_MS;
  const root = document.createElement("article");
  root.className = "message assistant-msg";
  appendAssistantHeader(root, parent);
  const body = document.createElement("div");
  body.className = "md-body";
  // 流式正文每几十毫秒重绘一次，读屏软件跟着念会把人淹掉；状态播报交给 turn-status。
  body.setAttribute("aria-live", "off");
  root.appendChild(body);
  parent.appendChild(root);

  let rawMarkdown = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // 首个分片立即出字，不必先等一个间隔。
  let lastPaintedAt = 0;
  // 只重绘变化的块，长回复不再每帧重建整段 DOM。
  const incremental = new IncrementalMarkdownBody(body, {
    renderHtml: renderMarkdownToHtml,
    enhance: (block) => enhanceMarkdownDom(block, options.onOpenLink, options.onOpenFile),
  });

  const paint = (final: boolean): void => {
    if (disposed) return;
    lastPaintedAt = Date.now();
    const stick = options.nearBottom?.() ?? true;
    incremental.update(rawMarkdown);
    root.dataset.rawMarkdown = rawMarkdown;
    if (final) {
      root.dataset.final = "1";
      // 语法高亮只跑终稿：流式中间帧不重算，避免长回复越写越卡。
      highlightCodeBlocks(body);
    }
    options.onPaint?.(final);
    if (stick) options.scrollToEnd?.();
  };

  // 已经排上的重绘绝不改期：改期就退化成防抖，分片一直来就一直不画。
  const schedule = (): void => {
    if (timer) return;
    const wait = Math.max(0, paintIntervalMs - (Date.now() - lastPaintedAt));
    timer = setTimeout(() => {
      timer = undefined;
      paint(false);
    }, wait);
  };

  const handle: StreamRenderHandle = {
    root,
    body,
    get rawMarkdown() {
      return rawMarkdown;
    },
    set rawMarkdown(value: string) {
      rawMarkdown = value;
    },
    append(delta: string) {
      rawMarkdown += delta;
      schedule();
    },
    finalize() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      paint(true);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
  return handle;
}

export function mountAssistantMessage(
  parent: HTMLElement,
  rawMarkdown: string,
  onOpenLink?: (href: string) => void,
  onOpenFile?: (ref: FileReference) => void,
): HTMLElement {
  const root = document.createElement("article");
  root.className = "message assistant-msg";
  root.dataset.final = "1";
  root.dataset.rawMarkdown = rawMarkdown;
  appendAssistantHeader(root, parent);
  const body = document.createElement("div");
  body.className = "md-body";
  body.innerHTML = renderMarkdownToHtml(rawMarkdown);
  enhanceMarkdownDom(body, onOpenLink, onOpenFile);
  highlightCodeBlocks(body);
  root.appendChild(body);
  parent.appendChild(root);
  return root;
}

export interface FileReference {
  relativePath: string;
  line?: number;
}

/**
 * 反引号里的内容是不是一条仓库内文件引用。
 *
 * 只认反引号包住的整段——模型写路径几乎都会加反引号，而扫描散文里的每个词
 * 会把 `1.5` `a.b` 这类东西也变成链接。绝对路径与向上跳出的 `..` 一律不认，
 * 跟 openWorkspaceFile 的宿主校验保持同一条边界。
 */
export function parseFileReference(text: string): FileReference | undefined {
  const raw = text.trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return undefined;
  const match = /^(.+?)(?::(\d{1,7}))?$/.exec(raw);
  if (!match) return undefined;
  const candidate = (match[1] ?? "").replace(/\\/g, "/");
  if (!/^[\w.@~-]+(?:\/[\w.@ ()+-]+)*$/.test(candidate)) return undefined;
  if (candidate.includes("..") || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) {
    return undefined;
  }
  // 必须看起来像文件：有扩展名，或至少带一层目录。
  const named = /\/[^/]+\.[A-Za-z0-9]{1,8}$/.test(`/${candidate}`);
  if (!named && !candidate.includes("/")) return undefined;
  const line = match[2] ? Number(match[2]) : undefined;
  return { relativePath: candidate, ...(line && line > 0 ? { line } : {}) };
}

export function enhanceMarkdownDom(
  root: HTMLElement,
  onOpenLink?: (href: string) => void,
  onOpenFile?: (ref: FileReference) => void,
): void {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (pre.parentElement?.classList.contains("code-block")) continue;
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const lang = pre.getAttribute("data-language") || "";
    const bar = document.createElement("div");
    bar.className = "code-block-bar";
    if (lang) {
      const tag = document.createElement("span");
      tag.className = "code-lang";
      tag.textContent = lang;
      bar.appendChild(tag);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "code-lang";
      bar.appendChild(spacer);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy";
    copy.textContent = "复制";
    copy.addEventListener("click", () => {
      const text = pre.textContent ?? "";
      void navigator.clipboard?.writeText(text).then(() => {
        copy.textContent = "已复制";
        setTimeout(() => {
          copy.textContent = "复制";
        }, 1_200);
      });
    });
    bar.appendChild(copy);
    pre.replaceWith(wrap);
    wrap.appendChild(bar);
    wrap.appendChild(pre);
  }

  for (const table of Array.from(root.querySelectorAll("table"))) {
    if (table.parentElement?.classList.contains("table-scroll")) continue;
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    table.replaceWith(scroll);
    scroll.appendChild(table);
  }

  if (onOpenFile) {
    for (const code of Array.from(root.querySelectorAll("code"))) {
      if (code.closest("pre") || code.classList.contains("file-ref")) continue;
      const ref = parseFileReference(code.textContent ?? "");
      if (!ref) continue;
      code.classList.add("file-ref");
      code.setAttribute("role", "button");
      code.setAttribute("tabindex", "0");
      code.title = ref.line ? `打开 ${ref.relativePath} 第 ${ref.line} 行` : `打开 ${ref.relativePath}`;
      const open = (): void => onOpenFile(ref);
      code.addEventListener("click", open);
      code.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
    }
  }

  for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^\s*javascript:/i.test(href) || /^\s*data:/i.test(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("target", "_blank");
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      if (href && onOpenLink) onOpenLink(href);
    });
  }
}

export function collapseDuplicatePlanMarkdown(root: HTMLElement, onViewPlan: () => void): void {
  const raw = root.dataset.rawMarkdown ?? "";
  if (!looksLikePlanOutline(raw)) return;
  root.classList.add("plan-collapsed");
  const body = root.querySelector(".md-body");
  if (!body) return;
  body.replaceChildren();
  const note = document.createElement("p");
  note.textContent = "已根据研究结果生成实施计划，完整步骤与操作请查看计划。";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary";
  btn.textContent = "查看计划";
  btn.addEventListener("click", onViewPlan);
  body.appendChild(note);
  body.appendChild(btn);
}
