import "./main.css";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../messages";
import type { PlanRecord, PlanStepStatus } from "../storage/plan-repository";

interface VsCodeApi { postMessage(message: WebviewToHostMessage): void; }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
if (!root) throw new Error("缺少 root");

const ICONS: Record<PlanStepStatus, string> = {
  pending: "○",
  in_progress: "◎",
  completed: "●",
  cancelled: "–",
  failed: "×",
  skipped: "↷",
};

function render(plan?: PlanRecord): void {
  root!.replaceChildren();
  root!.appendChild(Object.assign(document.createElement("div"), { className: "side-title", textContent: "Tasks" }));
  if (!plan || plan.steps.length === 0) {
    root!.appendChild(Object.assign(document.createElement("p"), { className: "muted", textContent: "暂无任务步骤。" }));
    return;
  }
  const list = document.createElement("ol");
  list.className = "task-list";
  for (const step of plan.steps) {
    const item = document.createElement("li");
    item.className = `task-item status-${step.status}`;
    item.textContent = `${ICONS[step.status] ?? "○"} ${step.title}`;
    list.appendChild(item);
  }
  root!.appendChild(list);
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  if (event.data.type === "planRecord") render(event.data.plan);
});
vscode.postMessage({ type: "ready" });
render();
