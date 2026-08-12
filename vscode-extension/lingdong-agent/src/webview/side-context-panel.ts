import "./main.css";
import type { ContextItemView, HostToWebviewMessage, UsageView, WebviewToHostMessage } from "../messages";

interface VsCodeApi { postMessage(message: WebviewToHostMessage): void; }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
if (!root) throw new Error("缺少 root");

let items: ContextItemView[] = [];
let usage: UsageView | undefined;

function render(): void {
  root!.replaceChildren();
  root!.appendChild(Object.assign(document.createElement("div"), { className: "side-title", textContent: "Context" }));
  if (usage) {
    const usageLine = document.createElement("div");
    usageLine.className = `usage-level-${usage.level}`;
    usageLine.textContent = `${usage.label} · ${usage.source}`;
    root!.appendChild(usageLine);
    if (usage.compactCapability === "available") {
      const compact = Object.assign(document.createElement("button"), {
        className: "ghost",
        textContent: usage.compactBusy ? "压缩中…" : "压缩上下文",
        disabled: usage.compactBusy,
      });
      compact.addEventListener("click", () => vscode.postMessage({ type: "compactContext" }));
      root!.appendChild(compact);
    }
  }
  const chips = document.createElement("div");
  chips.className = "context-items";
  for (const item of items) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = `${item.label}${item.truncated ? "…" : ""} (${item.size})`;
    chip.title = "查看";
    chip.addEventListener("click", () => vscode.postMessage({ type: "showContext", id: item.id }));
    const remove = Object.assign(document.createElement("button"), { className: "link", textContent: "移除" });
    remove.addEventListener("click", () => vscode.postMessage({ type: "removeContext", id: item.id }));
    const row = document.createElement("div");
    row.className = "context-row";
    row.appendChild(chip);
    row.appendChild(remove);
    chips.appendChild(row);
  }
  root!.appendChild(chips);
  if (items.length > 0) {
    const clear = Object.assign(document.createElement("button"), { className: "ghost", textContent: "清空上下文" });
    clear.addEventListener("click", () => vscode.postMessage({ type: "clearContext" }));
    root!.appendChild(clear);
  } else {
    root!.appendChild(Object.assign(document.createElement("p"), { className: "muted", textContent: "尚未添加上下文。" }));
  }
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === "contextItems") {
    items = message.items;
    render();
  }
  if (message.type === "usage" || message.type === "usageDetail") {
    usage = message.usage;
    render();
  }
});
vscode.postMessage({ type: "ready" });
render();
