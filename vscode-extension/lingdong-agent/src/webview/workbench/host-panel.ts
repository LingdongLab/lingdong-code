import { element } from "../dom-utils";

/**
 * Terminal / Browser 这类由 VS Code 原生承担的工具，
 * 右侧只放一个说明与「再次打开」按钮，不在 Webview 里伪造一个假的终端或浏览器。
 */
export function renderHostToolPanel(
  panel: HTMLElement,
  title: string,
  body: string,
  actionLabel: string,
  onAction: () => void,
): void {
  panel.replaceChildren();
  panel.appendChild(element("div", "panel-title", title));
  panel.appendChild(element("div", "perm-reason", body));
  const button = element("button", "btn-primary", actionLabel);
  button.type = "button";
  button.addEventListener("click", onAction);
  panel.appendChild(button);
}
