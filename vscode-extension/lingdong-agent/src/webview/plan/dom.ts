/** Plan 组件共用的轻量 DOM 工具。 */

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

export function autosizeTextarea(node: HTMLTextAreaElement): void {
  node.style.height = "auto";
  node.style.height = `${Math.max(node.scrollHeight, 36)}px`;
}

export function bindAutosize(node: HTMLTextAreaElement): void {
  const resize = () => autosizeTextarea(node);
  node.addEventListener("input", resize);
  queueMicrotask(resize);
}
