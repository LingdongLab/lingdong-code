import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { AgentController } from "./agent-controller";
import type { HostToWebviewMessage } from "./messages";
import { handleWebviewMessage } from "./webview-message-handler";
import type { WorkspacePartition } from "./workspace-store";

function createNonce(): string {
  return randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 22);
}

export type SideKind = "plan" | "tasks" | "changes" | "context";

export const SIDE_KINDS: readonly SideKind[] = ["plan", "tasks", "changes", "context"];

/**
 * 侧栏资源名。
 *
 * 脚本与样式必须来自同一个 esbuild entry：每个 entry 各出一份 CSS，
 * 入口自己 import 的样式（如 side-plan-panel 的 plan.css）只在它那一份里，
 * 链到 main.css 会让这些规则整段失效。
 */
export function sidePanelAssets(kind: SideKind): { script: string; style: string } {
  return { script: `side-${kind}-panel.js`, style: `side-${kind}-panel.css` };
}

const VIEW_IDS: Record<SideKind, string> = {
  plan: "lingdongAgent.planView",
  tasks: "lingdongAgent.tasksView",
  changes: "lingdongAgent.changesView",
  context: "lingdongAgent.contextView",
};

/**
 * 右侧同源面板：只订阅 AgentWorkspaceStore，不自建 Plan/Changes 缓存。
 */
export class SidePanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly poster: (message: HostToWebviewMessage) => void;

  constructor(
    private readonly kind: SideKind,
    private readonly context: vscode.ExtensionContext,
    private readonly controller: AgentController,
    private readonly output: vscode.OutputChannel,
  ) {
    this.poster = (message) => {
      void this.view?.webview.postMessage(message);
    };
  }

  static viewId(kind: SideKind): string {
    return VIEW_IDS[kind];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.controller.addPoster(this.poster);
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.render(view.webview);
    view.webview.onDidReceiveMessage(
      (raw: unknown) =>
        void handleWebviewMessage(this.controller, raw, {
          output: this.output,
          post: this.poster,
        }),
      undefined,
      this.context.subscriptions,
    );
    const onChange = (partitions: readonly WorkspacePartition[]): void => {
      if (this.shouldRefresh(partitions)) this.pushSnapshot();
    };
    this.controller.store.on("change", onChange);
    view.onDidDispose(() => {
      this.controller.removePoster(this.poster);
      this.controller.store.off("change", onChange);
      this.view = undefined;
    });
    this.pushSnapshot();
    this.controller.syncState();
  }

  private shouldRefresh(partitions: readonly WorkspacePartition[]): boolean {
    switch (this.kind) {
      case "plan":
      case "tasks":
        return partitions.includes("plan") || partitions.includes("tasks");
      case "changes":
        return partitions.includes("changes");
      case "context":
        return partitions.includes("context") || partitions.includes("usage");
      default:
        return false;
    }
  }

  private pushSnapshot(): void {
    const snap = this.controller.store.snapshot;
    if (this.kind === "plan" || this.kind === "tasks") {
      if (snap.activePlan) this.poster({ type: "planRecord", plan: snap.activePlan });
    }
    if (this.kind === "changes" && snap.changes) {
      this.poster({ type: "changes", view: snap.changes });
    }
    if (this.kind === "context") {
      this.poster({ type: "contextItems", items: snap.contextItems });
      this.poster({
        type: "usage",
        usage: this.controller.getUsage(),
      });
    }
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce();
    const base = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const assets = sidePanelAssets(this.kind);
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, assets.script));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, assets.style));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const titles: Record<SideKind, string> = {
      plan: "Plan",
      tasks: "Tasks",
      changes: "Changes",
      context: "Context",
    };
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${styleUri.toString()}" rel="stylesheet" />
<title>${titles[this.kind]}</title>
</head>
<body class="side-panel side-${this.kind}">
  <div id="root" class="side-root"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

export function registerSidePanels(
  context: vscode.ExtensionContext,
  controller: AgentController,
  output: vscode.OutputChannel,
): void {
  for (const kind of SIDE_KINDS) {
    const provider = new SidePanelProvider(kind, context, controller, output);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(SidePanelProvider.viewId(kind), provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
  }
}
