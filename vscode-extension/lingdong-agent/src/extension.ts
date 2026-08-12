import * as vscode from "vscode";
import { AgentController } from "./agent-controller";
import { AgentPanel } from "./agent-panel";
import { ChatViewProvider } from "./chat-view-provider";
import { SnapshotContentProvider } from "./diff-provider";
import { AGENT_MODES, type UiAgentMode } from "./messages";
import { SettingsPanel } from "./settings-panel";
import { isSettingsCategory } from "./settings-messages";
import { SessionTreeProvider } from "./session-tree";
import { registerSidePanels } from "./side-panels";
import { ReviewNavigation } from "./services/review-navigation";
import {
  applyWindowShape,
  otherShape,
  readShape,
  SHAPE_SETTING_KEY,
  type ShapeHost,
  type WindowShape,
} from "./services/window-shape";
import { samePath } from "./workspace-history";

let controller: AgentController | undefined;

/** 记在 globalState 里的一串根路径：每个文件夹只自动展开一次面板。 */
const INITIAL_REVEAL_KEY = "lingdongAgent.initialRevealRoots";

/** 隐私状态的只读虚拟文档。 */
class PrivacyStatusProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "lingdong-privacy";
  static readonly uri = vscode.Uri.parse(`${PrivacyStatusProvider.scheme}:隐私状态.md`);

  constructor(private readonly render: () => Promise<string>) {}

  provideTextDocumentContent(): Promise<string> {
    return this.render();
  }
}

/** Agent 诊断的只读虚拟文档。 */
class AgentDiagnosticsProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "lingdong-diagnostics";
  static readonly uri = vscode.Uri.parse(`${AgentDiagnosticsProvider.scheme}:Agent 诊断.md`);

  constructor(private readonly render: () => Promise<string>) {}

  provideTextDocumentContent(): Promise<string> {
    return this.render();
  }
}

/**
 * 后台任务输出的只读虚拟文档。
 *
 * 一个任务一个 URI（query 带卡片主键），这样 dev server 与测试的输出各占一个页签，
 * 不会互相顶掉。内容每次打开时重新取，因此重新执行「查看输出」就能看到新增部分。
 */
class BackgroundTaskOutputProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "lingdong-task-output";

  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly read: (id: string) => string | undefined) {}

  static uriFor(id: string, title: string): vscode.Uri {
    // 文件名只是页签标题，真正的键在 query 里，避免命令原文里的斜杠被当成路径。
    return vscode.Uri.from({
      scheme: BackgroundTaskOutputProvider.scheme,
      path: `/${title}.log`,
      query: id,
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.read(uri.query) ?? "（这个后台任务还没有产生可见输出。）";
  }

  refresh(uri: vscode.Uri): void {
    this.changed.fire(uri);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function tryRegisterSecondarySidebar(
  context: vscode.ExtensionContext,
  agent: AgentController,
  output: vscode.OutputChannel,
): boolean {
  try {
    // VS Code ^1.84 不保证 secondarySidebar 贡献点；失败则降级为 panel 区。
    const contributes = vscode.extensions.getExtension("lingdong.lingdong-agent")?.packageJSON?.contributes;
    const hasSecondary = Boolean(contributes?.viewsContainers?.secondarySidebar);
    if (!hasSecondary) {
      agent.markLayoutFallback("package.json 未声明 secondarySidebar，右侧面板改用 Panel 区");
      return false;
    }
    return true;
  } catch (error) {
    agent.markLayoutFallback(`secondarySidebar 检测失败：${error instanceof Error ? error.message : String(error)}`);
    output.appendLine(`[layout] secondarySidebar 不可用，已降级到 Panel 区视图`);
    return false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("灵动 Code");
  context.subscriptions.push(output);

  const agent = new AgentController(context, output);
  controller = agent;

  // 设置页把三段编排合到一个 Webview 里；服务本身仍各管各的，只是共用一个出站通道。
  const settingsPanelServices = {
    models: agent.modelSettings,
    extensions: agent.extensions,
    settings: agent.settings,
  };

  const openAgentPanel = (): void => {
    AgentPanel.show(context, agent, output);
  };
  context.subscriptions.push(AgentPanel.registerSerializer(context, agent, output));

  const reviewNav = new ReviewNavigation(
    {
      openAgentPanel,
      closeOverlayPanels: () => SettingsPanel.close(),
    },
    context.subscriptions,
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("lingdongAgent.backToAgent", () => reviewNav.backToAgent()),
    vscode.commands.registerCommand("lingdongAgent.markReviewOpen", () => reviewNav.markReviewOpen()),
    vscode.commands.registerCommand("lingdongAgent.refreshReviewNav", () => {
      reviewNav.refresh(SettingsPanel.isOpen);
    }),
  );

  const tree = new SessionTreeProvider(agent);
  context.subscriptions.push(tree);
  context.subscriptions.push(vscode.window.createTreeView(SessionTreeProvider.viewId, {
    treeDataProvider: tree,
    showCollapseAll: true,
  }));

  const provider = new ChatViewProvider(context, agent, output, openAgentPanel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  tryRegisterSecondarySidebar(context, agent, output);
  registerSidePanels(context, agent, output);

  // 审批力度改了要立刻生效，否则用户得重连一次才知道设置有没有用。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("lingdongAgent.approvalPolicy")) agent.refreshApprovalPolicy();
    }),
  );

  const snapshots = new SnapshotContentProvider((turnId, relativePath) => agent.readSnapshot(turnId, relativePath));
  context.subscriptions.push(
    snapshots,
    vscode.workspace.registerTextDocumentContentProvider(SnapshotContentProvider.scheme, snapshots),
  );

  // 隐私状态以只读虚拟文档呈现：内容每次打开时重新生成，不缓存旧状态。
  const privacyStatus = new PrivacyStatusProvider(() => agent.privacyStatusText());
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PrivacyStatusProvider.scheme, privacyStatus),
  );

  // 诊断同样每次打开时重新生成：它要回答的是「此刻」加载了什么。
  const agentDiagnostics = new AgentDiagnosticsProvider(() => agent.agentDiagnosticsText());
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(AgentDiagnosticsProvider.scheme, agentDiagnostics),
  );

  const taskOutput = new BackgroundTaskOutputProvider((id) => agent.backgroundTaskOutput(id));
  context.subscriptions.push(
    taskOutput,
    vscode.workspace.registerTextDocumentContentProvider(BackgroundTaskOutputProvider.scheme, taskOutput),
  );
  agent.openBackgroundTaskOutput = async (id, title) => {
    const uri = BackgroundTaskOutputProvider.uriFor(id, title);
    // 已经打开过的页签内容会被缓存，先通知它变了再打开，否则看到的还是旧输出。
    taskOutput.refresh(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("lingdongAgent.open", async () => {
      openAgentPanel();
    }),
    vscode.commands.registerCommand("lingdongAgent.openAgent", async () => {
      openAgentPanel();
    }),
    vscode.commands.registerCommand("lingdongAgent.openSession", async (sessionId?: string) => {
      if (typeof sessionId === "string") {
        await agent.loadPersistedSession(sessionId);
        openAgentPanel();
      }
    }),
    vscode.commands.registerCommand("lingdongAgent.searchSessions", async () => {
      const query = await vscode.window.showInputBox({
        title: "搜索会话",
        prompt: "按标题 / 摘要 / 模式过滤",
        value: agent.store.snapshot.sessionQuery,
      });
      if (query !== undefined) {
        tree.setQuery(query);
        tree.refresh();
      }
    }),
    vscode.commands.registerCommand("lingdongAgent.pinSession", async (item?: { session?: { id: string } }) => {
      const id = item?.session?.id;
      if (id) await agent.pinSession(id);
      tree.refresh();
    }),
    vscode.commands.registerCommand("lingdongAgent.archiveSession", async (item?: { session?: { id: string } }) => {
      const id = item?.session?.id;
      if (id) await agent.archiveSession(id);
      tree.refresh();
    }),
    vscode.commands.registerCommand("lingdongAgent.renameSessionTree", async (item?: { session?: { id: string } }) => {
      const id = item?.session?.id;
      if (id) await agent.renameSession(id);
      tree.refresh();
    }),
    vscode.commands.registerCommand("lingdongAgent.deleteSessionTree", async (item?: { session?: { id: string } }) => {
      const id = item?.session?.id;
      if (id) await agent.deleteSession(id);
      tree.refresh();
    }),
    vscode.commands.registerCommand("lingdongAgent.moveToSecondarySideBar", async () => {
      await vscode.commands.executeCommand("lingdongAgent.chatView.focus");
      await vscode.commands.executeCommand("workbench.action.moveFocusedView");
      void vscode.window.showInformationMessage("在弹出的列表中选择「辅助侧边栏」即可把灵动 Code 固定到右侧。");
    }),
    vscode.commands.registerCommand("lingdongAgent.newSession", () => agent.newSession()),
    vscode.commands.registerCommand("lingdongAgent.stop", () => agent.stop()),
    vscode.commands.registerCommand("lingdongAgent.switchMode", async () => {
      const picked = await vscode.window.showQuickPick([...AGENT_MODES], {
        title: "选择灵动 Code 模式",
        placeHolder: `当前模式：${agent.mode}`,
      });
      if (picked) await agent.setMode(picked as UiAgentMode);
    }),
    vscode.commands.registerCommand("lingdongAgent.selectModel", () => agent.openModelPicker()),
    vscode.commands.registerCommand("lingdongAgent.compactContext", () => agent.compactConversation()),
    vscode.commands.registerCommand("lingdongAgent.showLogs", () => agent.showLogs()),
    vscode.commands.registerCommand("lingdongAgent.reconnect", () => agent.reconnect()),
    vscode.commands.registerCommand(
      "lingdongAgent.configureProviderKey",
      (providerId?: string) => agent.configureProviderKey(typeof providerId === "string" ? providerId : undefined),
    ),
    // 三个入口指向同一页，只是落在不同分类上：设置只有一页，
    // 但从「打开模型设置」进来还是应该直接看到模型，而不是自己再点一下。
    vscode.commands.registerCommand("lingdongAgent.openSettings", (category?: unknown) => {
      SettingsPanel.show(
        context,
        settingsPanelServices,
        output,
        isSettingsCategory(category) ? category : undefined,
      );
    }),
    vscode.commands.registerCommand("lingdongAgent.openModelSettings", () => {
      SettingsPanel.show(context, settingsPanelServices, output, "models");
    }),
    vscode.commands.registerCommand("lingdongAgent.openExtensions", () => {
      SettingsPanel.show(context, settingsPanelServices, output, "capabilities");
    }),
    vscode.commands.registerCommand("lingdongAgent.showPrivacyStatus", async () => {
      const document = await vscode.workspace.openTextDocument(PrivacyStatusProvider.uri);
      await vscode.languages.setTextDocumentLanguage(document, "markdown");
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand("lingdongAgent.showAgentDiagnostics", async () => {
      const document = await vscode.workspace.openTextDocument(AgentDiagnosticsProvider.uri);
      await vscode.languages.setTextDocumentLanguage(document, "markdown");
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand("lingdongAgent.clearPermissionRules", () => agent.clearPermissionRules()),
    vscode.commands.registerCommand("lingdongAgent.approvePlan", () => agent.approvePlan()),
    vscode.commands.registerCommand("lingdongAgent.rejectPlan", () => agent.rejectPlan()),
    vscode.commands.registerCommand("lingdongAgent.addCurrentFile", () => agent.addCurrentFile()),
    vscode.commands.registerCommand("lingdongAgent.addSelection", () => agent.addSelection()),
    vscode.commands.registerCommand("lingdongAgent.addFiles", () => agent.pickContextFiles()),
    vscode.commands.registerCommand("lingdongAgent.addFolder", () => agent.pickContextFolder()),
    vscode.commands.registerCommand("lingdongAgent.addTerminalSelection", () => agent.addTerminalSelection()),
    vscode.commands.registerCommand("lingdongAgent.addDiagnostics", () => agent.addDiagnosticsContext()),
    vscode.commands.registerCommand("lingdongAgent.openDiff", () => agent.revealChanges()),
    vscode.commands.registerCommand("lingdongAgent.undoTurn", () => agent.undoLastTurn()),
    vscode.commands.registerCommand("lingdongAgent.sessionHistory", () => agent.openSessionHistory()),
    vscode.commands.registerCommand("lingdongAgent.renameSession", () => agent.renameSession()),
    vscode.commands.registerCommand("lingdongAgent.deleteSession", () => agent.deleteSession()),
    vscode.commands.registerCommand("lingdongAgent.savePlan", () => agent.savePlanToWorkspace()),
    vscode.commands.registerCommand("lingdongAgent.locateGrok", () => agent.locateGrokExecutable()),
    vscode.commands.registerCommand("lingdongAgent.startPlanBuild", () => agent.startPlanBuild()),
    vscode.commands.registerCommand("lingdongAgent.pausePlanBuild", () => agent.pausePlanBuild()),
    vscode.commands.registerCommand("lingdongAgent.resumePlanBuild", () => agent.resumePlanBuild()),
    // 首次引导用。走的是「加一个文件夹」而不是「换工作区」，空窗口时才退回 openFolder。
    vscode.commands.registerCommand("lingdongAgent.addWorkspaceFolder", () => agent.openFolder()),
    vscode.commands.registerCommand("lingdongAgent.toggleWindowShape", async () => {
      const next = otherShape(currentShape());
      await vscode.workspace.getConfiguration("lingdongAgent")
        .update(SHAPE_SETTING_KEY, next, vscode.ConfigurationTarget.Global);
      await applyWindowShape(next, shapeHost(output));
      if (next === "agent" || !hasOpenEditorTabs()) openAgentPanel();
    }),
    vscode.commands.registerCommand("lingdongAgent.ensureHomePanel", async () => {
      if (AgentPanel.isOpen) return;
      const shape = currentShape();
      if (shape === "agent") {
        openAgentPanel();
        return;
      }
      if (!hasOpenEditorTabs()) openAgentPanel();
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (!AgentPanel.isOpen && !hasOpenEditorTabs()) {
        void vscode.commands.executeCommand("lingdongAgent.ensureHomePanel");
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => agent.publishFirstRunGate()),
  );

  // 装机后第一次打开时侧栏是空的，引导得在用户做任何事之前就到位。
  agent.publishFirstRunGate();
  void agent.promptFirstRunSetup();

  void agent.ensureStorage().catch((error: unknown) => {
    output.appendLine(`[storage] 初始化失败：${error instanceof Error ? error.message : String(error)}`);
  }).then(async () => {
    tree.refresh();
    // 判据用活动仓库而不是宿主工作区的第一个根：空窗口里也可能有记住的仓库。
    const root = agent.activeRoot();
    // 布局要先摆好再开面板，否则会看到面板先出现、活动栏和侧边栏再一格格收起。
    if (firstVisitToRoot(context, root)) await applyWindowShape(currentShape(), shapeHost(output));
    revealPanelOnce(context, root, openAgentPanel);
    // 升级兜底：关掉欢迎页空壳，摆成 Agent 默认形态，确保首页是灵动主面板。
    await dismissVsCodeWelcome();
    await applyWindowShape(currentShape(), shapeHost(output));
    if (!AgentPanel.isOpen) openAgentPanel();
  });
}

function currentShape(): WindowShape {
  return readShape(vscode.workspace.getConfiguration("lingdongAgent").get(SHAPE_SETTING_KEY));
}

function hasOpenEditorTabs(): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.length > 0);
}

/** 关掉基座自带的 Welcome / Get Started，避免用户以为产品还是 VS Code。 */
async function dismissVsCodeWelcome(): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { viewType?: string } | undefined;
      const id = String(input?.viewType ?? "");
      const label = String(tab.label ?? "");
      const looksWelcome =
        /welcome|gettingstarted|walkthrough/i.test(id) ||
        /^(Welcome|欢迎|入门|Get Started)/i.test(label);
      if (looksWelcome) {
        await vscode.window.tabGroups.close(tab, true);
      }
    }
  }
}

function shapeHost(output: vscode.OutputChannel): ShapeHost {
  return {
    executeCommand: (command) => vscode.commands.executeCommand(command),
    updateGlobalSetting: (key, value) =>
      vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global),
    log: (line) => output.appendLine(line),
  };
}

/*
  装机版不再为已打开的文件夹弹欢迎页——那页讲的是编辑器自己的功能，对我们的
  用户没有意义。但空着编辑区同样不行：打开文件夹后窗口里没有一处告诉人从哪
  开始，这正是「装完不知道怎么用」的来源。所以把主面板开在欢迎页原来的位置。

  空窗口不开：那时候没有工作区，Grok 根本起不来，面板只能显示一句「先加个
  文件夹」——这话欢迎页上的「打开文件夹」按钮说得更直接。

  每个文件夹只开一次。用户关掉它是明确的意图，下次不该又弹回来。窗口形态也共用
  这一次：摆布局是「第一次进来给个像样的默认」，之后用户怎么调就怎么留着。

  「已开过」这个标记记在 globalState 里、按第一个根的路径记，不能记在
  workspaceState：加文件夹会把单文件夹工作区变成未命名工作区，workspaceState
  跟着换了一份，同一个目录就会被当成没开过而再开一次——那正是重载后标签栏上
  多出一个「灵动 Code」的来源之一。
*/
function firstVisitToRoot(context: vscode.ExtensionContext, root: string | undefined): boolean {
  if (!root) return false;
  const seen = context.globalState.get<string[]>(INITIAL_REVEAL_KEY) ?? [];
  return !seen.some((path) => samePath(path, root));
}

function revealPanelOnce(
  context: vscode.ExtensionContext,
  root: string | undefined,
  openAgentPanel: () => void,
): void {
  if (!root) return;
  // 重载后恢复出来的面板已经被序列化器认领，不必再开。
  if (AgentPanel.isOpen) return;
  if (!firstVisitToRoot(context, root)) return;
  const seen = context.globalState.get<string[]>(INITIAL_REVEAL_KEY) ?? [];
  void context.globalState.update(INITIAL_REVEAL_KEY, [...seen, root]);
  openAgentPanel();
}

export async function deactivate(): Promise<void> {
  const agent = controller;
  controller = undefined;
  await agent?.dispose();
}
