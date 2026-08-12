import * as vscode from "vscode";

/**
 * Agent 形态下标签条与编辑器动作都藏了，Diff / 普通预览打开后用户容易「卡住」。
 * 用状态栏常驻「返回 Agent」，并在模型设置 / 扩展面板顶栏放同款入口。
 *
 * 判断"有没有东西盖住主面板"只能按标签页来，不能按 TextEditor：
 * 原生设置编辑器（workbench.action.openSettings 打开的那个）不是 TextEditor，
 * 不出现在 activeTextEditor / visibleTextEditors 里。以前按 TextEditor 判断，
 * 结果点「设置」之后状态栏这个唯一的退路也不亮，用户彻底回不去。
 */

/** 主面板自己的标签不算"盖住"，否则状态栏会一直亮着。 */
const AGENT_PANEL_VIEW_TYPE = "lingdongAgent.agentPanel";

function isAgentPanelTab(tab: vscode.Tab): boolean {
  const input = tab.input as { viewType?: string } | undefined;
  const viewType = String(input?.viewType ?? "");
  // 宿主给扩展创建的 webview 编辑器加了 "mainThreadWebview-" 前缀（见基座的
  // WebviewViewTypeTransformer），标签 API 透出来的就是加过前缀的那个。
  // 只做等值比较会永远不成立，主面板自己会被算成"盖住主面板"，状态栏于是一直亮着。
  return viewType === AGENT_PANEL_VIEW_TYPE || viewType.endsWith(`-${AGENT_PANEL_VIEW_TYPE}`);
}

export interface ReviewNavigationHost {
  openAgentPanel(): void;
  /** 关掉盖住主面板的设置类 Webview。 */
  closeOverlayPanels(): void;
}

export class ReviewNavigation {
  private readonly status: vscode.StatusBarItem;
  private reviewing = false;

  constructor(
    private readonly host: ReviewNavigationHost,
    private readonly subscriptions: { push(...items: vscode.Disposable[]): void },
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1_000);
    this.status.command = "lingdongAgent.backToAgent";
    this.status.text = "$(arrow-left) 返回 Agent";
    this.status.tooltip = "回到灵动 Code 主面板";
    this.subscriptions.push(this.status);

    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      // 设置页这类非文本编辑器只会触发这个事件。
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
    );
  }

  /** 除主面板之外还有别的标签开着，就说明主面板被盖住了。 */
  private hasCoveringTab(): boolean {
    return vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => !isAgentPanelTab(tab)),
    );
  }

  /** Diff / 单栏预览打开时调用，确保状态栏立刻出现。 */
  markReviewOpen(): void {
    this.reviewing = true;
    this.refresh();
  }

  backToAgent(): void {
    this.reviewing = false;
    this.host.closeOverlayPanels();
    // 关掉盖在上面的标签，避免 Agent 形态下它仍占着唯一标签位。
    // 这里同样不能只看 activeTextEditor —— 那样设置页会关不掉，点了返回还留在原地。
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (active && !isAgentPanelTab(active)) {
      void vscode.window.tabGroups.close(active, true);
    }
    this.host.openAgentPanel();
    this.refresh();
  }

  refresh(overlayOpen = false): void {
    const covered = this.hasCoveringTab();
    // 标签都关光了说明用户已经自己回到主面板。不清掉这个标记，
    // 手动关掉 Diff 之后状态栏会一直留着一个没用的返回入口。
    if (!covered) this.reviewing = false;
    if (this.reviewing || overlayOpen || covered) {
      this.status.show();
    } else {
      this.status.hide();
    }
  }
}
