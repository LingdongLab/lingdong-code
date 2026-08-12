import "./main.css";
import type { WebviewToHostMessage } from "../messages";

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

document.getElementById("open-panel")?.addEventListener("click", () => {
  vscode.postMessage({ type: "openAgentPanel" });
});

document.getElementById("new-session")?.addEventListener("click", () => {
  vscode.postMessage({ type: "openAgentPanel" });
  vscode.postMessage({ type: "newSession" });
});
