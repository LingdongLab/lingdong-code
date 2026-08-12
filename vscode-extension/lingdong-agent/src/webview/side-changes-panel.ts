import "./main.css";
import type { ChangeListView } from "../change-view";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../messages";

interface VsCodeApi { postMessage(message: WebviewToHostMessage): void; }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
if (!root) throw new Error("缺少 root");

function render(view?: ChangeListView): void {
  root!.replaceChildren();
  root!.appendChild(Object.assign(document.createElement("div"), { className: "side-title", textContent: "Changes" }));
  root!.appendChild(Object.assign(document.createElement("p"), {
    className: "muted",
    textContent: "完整审查请优先使用主面板右侧 Changes。",
  }));
  if (!view || view.rows.length === 0) {
    root!.appendChild(Object.assign(document.createElement("p"), { className: "muted", textContent: "本轮暂无文件变更。" }));
    return;
  }
  for (const file of view.rows) {
    const row = document.createElement("div");
    row.className = `change-row status-${file.status}`;
    const label = document.createElement("button");
    label.className = "link";
    label.textContent = `${file.letter} ${file.relativePath} · ${file.statusLabel}`;
    label.addEventListener("click", () => vscode.postMessage({ type: "openDiff", changeId: file.changeId }));
    row.appendChild(label);
    root!.appendChild(row);
  }
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const accept = Object.assign(document.createElement("button"), {
    className: "primary",
    textContent: "全部接受",
    disabled: !view.canAcceptAll,
  });
  const reject = Object.assign(document.createElement("button"), {
    className: "ghost",
    textContent: "全部拒绝",
    disabled: !view.canRejectAll,
  });
  accept.addEventListener("click", () => vscode.postMessage({ type: "acceptAll", turnId: view.turnId }));
  reject.addEventListener("click", () => vscode.postMessage({ type: "rejectAll", turnId: view.turnId }));
  actions.appendChild(accept);
  actions.appendChild(reject);
  root!.appendChild(actions);
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  if (event.data.type === "changes") render(event.data.view);
});
vscode.postMessage({ type: "ready" });
render();
