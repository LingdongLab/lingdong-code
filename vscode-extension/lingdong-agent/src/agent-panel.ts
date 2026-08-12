import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { AgentController } from "./agent-controller";
import type { HostToWebviewMessage } from "./messages";
import { handleWebviewMessage } from "./webview-message-handler";

function createNonce(): string {
  return randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 22);
}

/**
 * 编辑器区主 Agent 面板：单 Webview 三栏产品壳，与 Controller / Store 同源。
 */
export class AgentPanel {
  static readonly viewType = "lingdongAgent.agentPanel";
  private static current: AgentPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly poster: (message: HostToWebviewMessage) => void;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly controller: AgentController,
    private readonly output: vscode.OutputChannel,
  ) {
    this.panel = panel;
    this.poster = (message) => {
      void this.panel.webview.postMessage(message);
    };
    this.controller.addPoster(this.poster);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    };
    panel.webview.html = this.render(panel.webview);
    panel.webview.onDidReceiveMessage(
      (raw: unknown) =>
        void handleWebviewMessage(this.controller, raw, {
          output: this.output,
          post: this.poster,
          openAgentPanel: () => undefined,
          openModelSettings: () => {
            void vscode.commands.executeCommand("lingdongAgent.openModelSettings");
          },
          openExtensions: () => {
            void vscode.commands.executeCommand("lingdongAgent.openExtensions");
          },
        }),
      undefined,
      context.subscriptions,
    );
    panel.onDidDispose(() => {
      this.controller.removePoster(this.poster);
      if (AgentPanel.current === this) AgentPanel.current = undefined;
      // 关掉主面板后绝不能落到空白 VS Code 欢迎页（Cursor 也不会）。
      // Agent 形态下主面板就是产品壳；IDE 形态下若编辑区已空，同样回到首页。
      queueMicrotask(() => {
        void vscode.commands.executeCommand("lingdongAgent.ensureHomePanel");
      });
    });
  }

  /** 面板此刻是否已经在编辑区里（含窗口重载后被认领回来的那个）。 */
  static get isOpen(): boolean {
    return AgentPanel.current !== undefined;
  }

  /**
   * 认领窗口重载后被恢复出来的面板标签。
   *
   * 不注册序列化器的话，VS Code 恢复出的标签是个没人接管的空壳，而激活时的
   * reveal 又会再开一个——标签栏上就并排出现两个「灵动 Code」。
   * 面板本身不存快照：状态一律由 Controller 重新推一遍，恢复出来的空壳只要
   * 重挂 html 与消息通道即可。
   */
  static registerSerializer(
    context: vscode.ExtensionContext,
    controller: AgentController,
    output: vscode.OutputChannel,
  ): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(AgentPanel.viewType, {
      deserializeWebviewPanel: (panel) => {
        // 已经有一个了说明 reveal 抢在了恢复之前；留下先到的那个，免得又变成两个。
        if (AgentPanel.current) {
          panel.dispose();
          return Promise.resolve();
        }
        AgentPanel.current = new AgentPanel(panel, context, controller, output);
        controller.syncState();
        return Promise.resolve();
      },
    });
  }

  static show(
    context: vscode.ExtensionContext,
    controller: AgentController,
    output: vscode.OutputChannel,
  ): AgentPanel {
    if (AgentPanel.current) {
      AgentPanel.current.panel.reveal(vscode.ViewColumn.One, false);
      controller.syncState();
      return AgentPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      AgentPanel.viewType,
      "灵动 Code",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    AgentPanel.current = new AgentPanel(panel, context, controller, output);
    return AgentPanel.current;
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce();
    const base = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.css"));
    const markUri = webview.asWebviewUri(vscode.Uri.joinPath(base, "mark.png"));
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
<body class="agent-panel">
<div class="app-shell" id="app-shell">
  <aside class="left" id="left-rail">
    <div class="left-mini" id="left-mini" aria-label="工作区（已收起）">
      <button type="button" class="left-mini-btn" id="left-mini-expand" title="展开工作区" aria-label="展开工作区">»</button>
      <button type="button" class="left-mini-btn" id="left-mini-new" title="新建对话" aria-label="新建对话">＋</button>
      <button type="button" class="left-mini-btn" id="left-mini-search" title="搜索对话" aria-label="搜索对话">⌕</button>
      <button type="button" class="left-mini-btn repo" id="left-mini-repo" title="当前仓库" aria-label="当前仓库"></button>
    </div>
    <div class="brand"><img class="brand-mark" src="${markUri.toString()}" alt="" />灵动 Code</div>
    <div class="left-actions">
      <button type="button" class="btn-primary" id="new-session">新建对话</button>
      <input class="session-search" id="session-search" type="search" placeholder="搜索对话…" />
    </div>
    <!--
      Browser / Terminal 不在这里出口：它们点下去只是转发 openSimpleBrowser /
      openNativeTerminal，等于把宿主已有的入口（终端快捷键、命令面板）在侧栏又摆一遍。
      工具区留给真正只有本面板才有的东西。
    -->
    <div class="left-tools" id="left-tools" aria-label="工作区工具">
      <button type="button" class="left-tool" data-tool="changes" title="打开 Changes">Changes</button>
      <button type="button" class="left-tool" data-tool="files" title="打开 Files">Files</button>
    </div>
    <div class="repo-section-head">
      <span class="repo-section-title">仓库</span>
      <button type="button" class="icon-btn" id="open-folder" title="添加仓库并切换过去（窗口不重开）" aria-label="添加仓库">＋</button>
    </div>
    <div class="repo-tree" id="repo-tree" aria-label="仓库与会话"></div>
    <div class="left-footer">
      <button type="button" class="btn-ghost" id="open-settings">设置</button>
      <button type="button" class="btn-ghost" id="show-logs">日志</button>
    </div>
    <div class="left-resize" id="left-resize" role="separator" aria-orientation="vertical" aria-label="调整工作区宽度" title="拖动调整宽度"></div>
  </aside>

  <section class="main">
    <header class="main-header">
      <div class="main-title" id="session-title">新会话</div>
      <div class="status-line" id="status-line">Ask · DeepSeek V4 Flash · 上下文用量暂不可用</div>
      <div class="layout-toggles">
        <button type="button" class="icon-btn" id="toggle-left" title="显示或隐藏左侧会话栏" aria-label="切换左侧栏">☰</button>
        <button type="button" class="icon-btn" id="toggle-right" title="显示或隐藏右侧面板" aria-label="切换右侧栏">▥</button>
        <button type="button" class="btn-ghost" id="reconnect" hidden>重连</button>
      </div>
    </header>

    <main class="messages" id="messages">
      <div class="search-bar" id="search-bar" role="search" hidden></div>
      <div class="messages-inner" id="messages-inner">
        <div class="empty" id="empty">
          <p>描述任务，灵动 Code 会在此回复。</p>
          <p class="muted">左侧切换会话 · 需要时从左侧或工具条打开右侧工作台</p>
        </div>
      </div>
    </main>

    <footer class="composer">
      <button type="button" class="task-progress" id="task-progress" hidden title="点击定位到任务清单"></button>
      <div class="queue-chips" id="queue-chips" hidden></div>
      <div class="turn-status" id="turn-status" hidden aria-live="polite">
        <div class="turn-status-main">
          <span class="turn-status-dot" aria-hidden="true"></span>
          <span class="turn-status-label" id="turn-status-label"></span>
          <span class="turn-status-elapsed" id="turn-status-elapsed"></span>
        </div>
        <div class="turn-status-summary" id="turn-status-summary"></div>
        <div class="turn-status-actions" id="turn-status-actions"></div>
      </div>
      <div class="composer-shell composer-relative" id="composer-shell">
        <div class="drop-hint" id="drop-hint" hidden aria-hidden="true">松开加入对话 · 按住 Shift 用编辑器打开</div>
        <div class="suggest-popup" id="context-suggest" role="listbox" hidden></div>
        <div class="suggest-popup" id="slash-suggest" role="listbox" hidden></div>
        <div class="chips chips-empty" id="context-items" hidden></div>
        <textarea id="input" rows="1" placeholder="描述你想让灵动 Code 完成的任务……"></textarea>
        <div class="composer-bar composer-relative" id="composer-bar">
          <div class="composer-bar-left">
            <button type="button" class="chip chip-icon" id="context" title="添加上下文" aria-label="添加上下文">＋</button>
            <button type="button" class="chip chip-mode" id="mode-chip" title="切换工作模式">Agent</button>
            <button type="button" class="chip chip-model" id="model-btn"><span class="chip-model-name">DeepSeek V4 Flash</span><span class="chip-caret" aria-hidden="true">▾</span></button>
            <button type="button" class="chip usage-chip" id="usage-label" hidden title="上下文用量" aria-label="上下文用量">
              <svg class="usage-ring" viewBox="0 0 20 20" aria-hidden="true">
                <circle class="usage-ring-track" cx="10" cy="10" r="7" fill="none" />
                <circle class="usage-ring-value" cx="10" cy="10" r="7" fill="none" />
              </svg>
              <span class="usage-pct" id="usage-pct" hidden></span>
            </button>
          </div>
          <div class="composer-bar-right">
            <span class="composer-hint" id="composer-hint" aria-hidden="true">⏎ 发送 · ⇧⏎ 换行</span>
            <button type="button" class="send-btn" id="send" title="发送（Enter）"><span class="send-label">发送</span><span class="send-icon" aria-hidden="true">↑</span></button>
          </div>
          <div class="plus-menu" id="plus-menu" hidden role="menu"></div>
          <div class="plus-menu mode-menu" id="mode-menu" hidden role="menu"></div>
          <div class="model-popover" id="model-popover" hidden></div>
          <div class="usage-popover" id="usage-popover" hidden></div>
        </div>
      </div>
    </footer>
  </section>

  <aside class="right workbench" id="right-rail" hidden>
    <div class="wb-resize" id="wb-resize" title="拖动调整宽度" role="separator" aria-orientation="vertical"></div>
    <div class="wb-header">
      <div class="wb-tabs" id="wb-tabs" role="tablist"></div>
      <button type="button" class="icon-btn" id="wb-close" title="关闭工作台" aria-label="关闭工作台">×</button>
    </div>
    <div class="wb-body" id="wb-body">
      <div class="tab-panel" data-panel="changes" id="panel-changes"></div>
      <div class="tab-panel" data-panel="files" id="panel-files"></div>
      <div class="tab-panel" data-panel="tasks" id="panel-tasks"></div>
      <div class="tab-panel" data-panel="context" id="panel-context"></div>
      <div class="tab-panel" data-panel="plan" id="panel-plan"></div>
      <div class="tab-panel" data-panel="browser" id="panel-browser"></div>
      <div class="tab-panel" data-panel="terminal" id="panel-terminal"></div>
      <div class="tab-panel" data-panel="preview" id="panel-preview"></div>
    </div>
  </aside>
</div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
