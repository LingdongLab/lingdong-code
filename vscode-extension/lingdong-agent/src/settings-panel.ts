import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  isExtensionsMessage,
  isModelSettingsMessage,
  parseSettingsMessage,
  type SettingsCategory,
  type SettingsHostMessage,
  type SettingsOwnWebviewMessage,
} from "./settings-messages";
import type { ExtensionsService } from "./services/extensions-service";
import type { ModelSettingsService } from "./services/model-settings-service";
import type { SettingsService } from "./services/settings-service";

function createNonce(): string {
  return randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 22);
}

export interface SettingsPanelServices {
  models: ModelSettingsService;
  extensions: ExtensionsService;
  settings: SettingsService;
}

/**
 * 统一设置面板。
 *
 * 取代了原来的「模型设置」与「Agent 能力」两个面板：同一个 Webview 里
 * 左侧分类导航 + 右侧内容，用户不用再记哪个开关藏在哪一页。
 *
 * 三个服务共用这一个出站通道，各自的消息类型互不重叠（见 settings-messages
 * 里的类型表），所以路由是纯查表，不需要谁去猜消息属于谁。
 * 入站一律先过 parseSettingsMessage，校验不过就丢弃并记一行日志——
 * 这里能触发凭据写入、外部网络请求与配置落盘，不能容忍「大概是合法的」输入。
 */
export class SettingsPanel {
  static readonly viewType = "lingdongAgent.settings";
  private static current: SettingsPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly services: SettingsPanelServices,
    private readonly output: vscode.OutputChannel,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    };
    panel.webview.html = this.render(panel.webview);
    const post = (message: SettingsHostMessage): void => this.post(message);
    services.models.setPoster(post);
    services.extensions.setPoster(post);
    services.settings.setPoster(post);

    panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        const message = parseSettingsMessage(raw);
        if (!message) {
          this.output.appendLine("[settings] 已丢弃一条不合法的界面消息。");
          return;
        }
        if (message.type === "backToAgent") {
          void vscode.commands.executeCommand("lingdongAgent.backToAgent");
          return;
        }
        if (message.type === "ready" || message.type === "refresh") {
          void this.publishAll();
          return;
        }
        void this.dispatch(message).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`[settings] 处理 ${message.type} 失败：${detail}`);
          this.post({ type: "error", message: "操作失败，详情见输出面板。" });
        });
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(() => {
      services.models.setPoster(undefined);
      services.extensions.setPoster(undefined);
      services.settings.setPoster(undefined);
      if (SettingsPanel.current === this) SettingsPanel.current = undefined;
      void vscode.commands.executeCommand("lingdongAgent.refreshReviewNav");
    });
  }

  static get isOpen(): boolean {
    return SettingsPanel.current !== undefined;
  }

  static close(): void {
    SettingsPanel.current?.panel.dispose();
  }

  static show(
    context: vscode.ExtensionContext,
    services: SettingsPanelServices,
    output: vscode.OutputChannel,
    category?: SettingsCategory,
  ): SettingsPanel {
    const existing = SettingsPanel.current;
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      if (category) existing.post({ type: "navigate", category });
      void existing.publishAll();
      void vscode.commands.executeCommand("lingdongAgent.refreshReviewNav");
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      "灵动 Code · 设置",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const created = new SettingsPanel(panel, context, services, output);
    SettingsPanel.current = created;
    // 先落分类再推数据：界面拿到数据时已经在正确的页上，不会闪一下首页。
    if (category) created.post({ type: "navigate", category });
    void vscode.commands.executeCommand("lingdongAgent.refreshReviewNav");
    return created;
  }

  private dispatch(
    message: Exclude<
      ReturnType<typeof parseSettingsMessage>,
      undefined | { type: "ready" } | { type: "refresh" } | { type: "backToAgent" }
    >,
  ): Promise<void> {
    if (isModelSettingsMessage(message)) return this.services.models.handle(message);
    if (isExtensionsMessage(message)) return this.services.extensions.handle(message);
    return this.services.settings.handle(message as SettingsOwnWebviewMessage);
  }

  /** 三段一起推：设置页是一整页，只刷一段会让别的分类停在旧数据上。 */
  private async publishAll(): Promise<void> {
    await Promise.all([
      this.services.models.publish(),
      this.services.extensions.publish(),
      this.services.settings.publish(),
    ]);
  }

  private post(message: SettingsHostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce();
    const base = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "settings");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.js"));
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
<title>设置</title>
</head>
<body class="settings">
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
