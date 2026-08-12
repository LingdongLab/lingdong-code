import "./main.css";
import "./plan/plan.css";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../messages";
import type { PlanRecord } from "../storage/plan-repository";
import { renderPlanRightRail } from "./plan/plan-right-rail";
import { buildPlanDocumentViewModel } from "./plan/plan-view-model";

/**
 * 辅助侧边栏的 Plan 只读投影。
 *
 * 计划的唯一编辑入口是主面板中间的计划文档；这里过去是一套独立的表单
 * （textarea + window.prompt），和主面板构成两套发散的交互，已降级为只读，
 * 只显示标题、进度与步骤状态，需要修改时引导回主面板。
 */

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const root = document.getElementById("root");
if (!root) throw new Error("缺少 root");

let plan: PlanRecord | undefined;

function post(message: WebviewToHostMessage): void {
  vscode.postMessage(message);
}

function render(): void {
  if (!root) return;
  const model = buildPlanDocumentViewModel(plan, undefined);
  // 编辑与批准的唯一入口在主面板，这里给按钮而不是一句"请去主面板"的裸文本。
  root.replaceChildren(renderPlanRightRail(model, {
    onStartBuild: () => post({ type: "startPlanBuild" }),
    onOpenMain: () => post({ type: "openAgentPanel" }),
  }));
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  if (event.data.type !== "planRecord") return;
  plan = event.data.plan;
  render();
});

post({ type: "ready" });
render();
