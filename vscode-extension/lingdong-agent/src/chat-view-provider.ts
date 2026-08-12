import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { AgentController } from "./agent-controller";
import type { HostToWebviewMessage } from "./messages";
import { handleWebviewMessage } from "./webview-message-handler";

function createNonce(): string {
  return randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 22);
}

/** 侧栏兼容入口：仅打开主面板，不再渲染完整对话（消除双聊天）。 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "lingdongAgent.chatView";

  private view: vscode.WebviewView | undefined;
  private readonly poster: (message: HostToWebviewMessage) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: AgentController,
    private readonly output: vscode.OutputChannel,
    private readonly openAgentPanel: () => void,
  ) {
    this.poster = (message) => {
      void this.view?.webview.postMessage(message);
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.render(view.webview);
    this.controller.addPoster(this.poster);
    view.webview.onDidReceiveMessage(
      (raw: unknown) =>
        void handleWebviewMessage(this.controller, raw, {
          output: this.output,
          post: this.poster,
          openAgentPanel: this.openAgentPanel,
          // 走命令而不是再传一层回调：面板的生命周期由命令那边统一管。
          openModelSettings: () => {
            void vscode.commands.executeCommand("lingdongAgent.openModelSettings");
          },
          openExtensions: () => {
            void vscode.commands.executeCommand("lingdongAgent.openExtensions");
          },
        }),
      undefined,
      this.context.subscriptions,
    );
    view.onDidDispose(() => {
      this.controller.removePoster(this.poster);
      this.view = undefined;
    }, undefined, this.context.subscriptions);
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce();
    const base = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, "launcher.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.css"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri.toString()}" rel="stylesheet" />
<title>灵动 Code</title>
</head>
<body class="launcher">
  <div class="launcher-card">
    <h1>灵动 Code</h1>
    <p>完整对话、Plan、Changes 与 Composer 在编辑器主面板中使用。此处不再重复聊天。</p>
    <button type="button" class="btn-primary" id="open-panel">打开主面板</button>
    <button type="button" class="btn-ghost" id="new-session">新建对话并打开</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
