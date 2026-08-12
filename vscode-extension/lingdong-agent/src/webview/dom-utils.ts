/** Webview 通用 DOM 小工具，供各 UI 模块共享。 */

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function emptyPanel(title: string, body: string, compact = false): HTMLElement {
  const box = element("div", compact ? "empty-state compact" : "empty-state");
  box.appendChild(element("strong", undefined, title));
  box.appendChild(document.createTextNode(body));
  return box;
}

/** 卡片给出结论后禁用其中所有按钮，避免重复提交。 */
export function disableActions(card: HTMLElement): void {
  for (const button of Array.from(card.querySelectorAll("button"))) button.disabled = true;
}

/**
 * 已决卡片收拢成一行结论（对标 Cursor）：保留在会话流里作记录，
 * 但不再以全尺寸滞留。可选保留一个动作入口（如「查看变更」）。
 */
export function collapseCard(card: HTMLElement, summary: string, action?: HTMLElement): void {
  card.classList.add("card-collapsed");
  const line = element("div", "card-collapsed-line");
  line.appendChild(element("span", "card-collapsed-text", summary));
  if (action) line.appendChild(action);
  card.replaceChildren(line);
}

export function relativeTime(ts: number, now = Date.now()): string {
  const delta = now - ts;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 172_800_000) return "昨天";
  return `${Math.floor(delta / 86_400_000)} 天前`;
}
