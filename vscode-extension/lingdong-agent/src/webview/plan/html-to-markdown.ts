/**
 * 把计划正文 contenteditable 里的 HTML 收回 Markdown。
 * 对标 Cursor 内联 Preview：用户改的是渲染态，落盘仍是 markdown。
 */

// 不用全局 Node.*：Node 测试环境未必挂到 globalThis。
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function collapseBlank(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function textOf(node: Node): string {
  return (node.textContent ?? "").replace(/\u00a0/g, " ");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function serializeInline(el: Element): string {
  let out = "";
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      out += textOf(child);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const node = child as HTMLElement;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      out += "\n";
      continue;
    }
    if (tag === "strong" || tag === "b") {
      out += `**${serializeInline(node)}**`;
      continue;
    }
    if (tag === "em" || tag === "i") {
      out += `*${serializeInline(node)}*`;
      continue;
    }
    if (tag === "code") {
      out += `\`${textOf(node).replace(/`/g, "\\`")}\``;
      continue;
    }
    if (tag === "a") {
      const href = node.getAttribute("href") ?? "";
      const label = serializeInline(node) || href;
      out += href ? `[${label}](${href})` : label;
      continue;
    }
    if (tag === "del" || tag === "s") {
      out += `~~${serializeInline(node)}~~`;
      continue;
    }
    out += serializeInline(node);
  }
  return out.replace(/[ \t]{2,}/g, " ");
}

function serializeCodeBlock(el: HTMLElement): string {
  const pre = el.querySelector("pre") ?? (el.tagName.toLowerCase() === "pre" ? el : undefined);
  const lang =
    el.querySelector(".code-lang")?.textContent?.trim()
    || pre?.getAttribute("data-language")
    || "";
  const body = (pre?.textContent ?? textOf(el)).replace(/\n$/, "");
  return `\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
}

function serializeTable(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return "";
  const matrix = rows.map((row) =>
    Array.from(row.querySelectorAll("th,td")).map((cell) => escapeCell(serializeInline(cell))),
  );
  const width = Math.max(...matrix.map((r) => r.length), 0);
  if (width === 0) return "";
  const padded = matrix.map((r) => {
    const next = [...r];
    while (next.length < width) next.push("");
    return next;
  });
  const header = padded[0] ?? Array.from({ length: width }, () => "");
  const sep = Array.from({ length: width }, () => "----");
  const body = padded.slice(1);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ];
  return `\n${lines.join("\n")}\n\n`;
}

function serializeList(list: HTMLElement, ordered: boolean): string {
  const items = Array.from(list.children).filter((c) => c.tagName.toLowerCase() === "li");
  let out = "\n";
  items.forEach((li, index) => {
    const marker = ordered ? `${index + 1}.` : "-";
    const clone = li.cloneNode(true) as HTMLElement;
    for (const nested of Array.from(clone.querySelectorAll(":scope > ul, :scope > ol"))) {
      nested.remove();
    }
    const head = serializeInline(clone).trim() || textOf(clone).trim();
    out += `${marker} ${head}\n`;
    for (const nested of Array.from(li.children)) {
      const tag = nested.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") {
        const nestedMd = serializeList(nested as HTMLElement, tag === "ol")
          .split("\n")
          .filter(Boolean)
          .map((line) => `   ${line}`)
          .join("\n");
        if (nestedMd) out += `${nestedMd}\n`;
      }
    }
  });
  return `${out}\n`;
}

function serializeBlock(node: Node): string {
  if (node.nodeType === TEXT_NODE) {
    const text = textOf(node);
    return text.trim() ? text : "";
  }
  if (node.nodeType !== ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (el.classList.contains("code-block-bar") || el.classList.contains("code-copy")) return "";
  if (el.classList.contains("code-block") || tag === "pre") return serializeCodeBlock(el);
  if (el.classList.contains("table-scroll")) {
    const table = el.querySelector("table");
    return table ? serializeTable(table as HTMLElement) : "";
  }

  switch (tag) {
    case "h1":
      return `\n# ${serializeInline(el).trim()}\n\n`;
    case "h2":
      return `\n## ${serializeInline(el).trim()}\n\n`;
    case "h3":
      return `\n### ${serializeInline(el).trim()}\n\n`;
    case "h4":
      return `\n#### ${serializeInline(el).trim()}\n\n`;
    case "h5":
      return `\n##### ${serializeInline(el).trim()}\n\n`;
    case "h6":
      return `\n###### ${serializeInline(el).trim()}\n\n`;
    case "p":
    case "div": {
      // contenteditable 里回车常变成 div
      if (el.querySelector("table, pre, ul, ol, .code-block, .table-scroll")) {
        return serializeChildren(el);
      }
      const inline = serializeInline(el).trim();
      return inline ? `\n${inline}\n\n` : "";
    }
    case "ul":
      return serializeList(el, false);
    case "ol":
      return serializeList(el, true);
    case "blockquote": {
      const inner = collapseBlank(serializeChildren(el));
      return `\n${inner.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    case "hr":
      return "\n\n---\n\n";
    case "table":
      return serializeTable(el);
    case "br":
      return "\n";
    case "li":
      return serializeInline(el);
    default:
      return serializeChildren(el);
  }
}

function serializeChildren(el: Element): string {
  let out = "";
  for (const child of Array.from(el.childNodes)) {
    out += serializeBlock(child);
  }
  return out;
}

/** 将 contenteditable 根节点序列化为 Markdown 正文。 */
export function htmlToMarkdown(root: HTMLElement): string {
  const md = collapseBlank(serializeChildren(root));
  return md ? `${md}\n` : "";
}

export function extractMarkdownTitle(markdown: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim();
}
