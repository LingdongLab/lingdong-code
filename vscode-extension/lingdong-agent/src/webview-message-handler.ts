import type { AgentController } from "./agent-controller";
import { parseWebviewMessage, type HostToWebviewMessage, type WebviewToHostMessage } from "./messages";

export type HostPoster = (message: HostToWebviewMessage) => void;

export interface WebviewMessageOptions {
  output: { appendLine(line: string): void };
  post: HostPoster;
  onReady?: () => void;
  openAgentPanel?: () => Promise<void> | void;
  /** 打开模型中心；未提供时消息被忽略而不是报错。 */
  openModelSettings?: () => Promise<void> | void;
  /** 打开 Skills / MCP 扩展能力面板。 */
  openExtensions?: () => Promise<void> | void;
}

/**
 * 各 Webview 共用的语义消息路由，避免侧栏与主面板各写一套 switch。
 * 所有调用点都是 `void handleWebviewMessage(...)`，因此这里必须兜住异常，
 * 否则处理器抛错会变成无人处理的 Promise rejection，用户侧只看到「没反应」。
 */
export async function handleWebviewMessage(
  controller: AgentController,
  raw: unknown,
  options: WebviewMessageOptions,
): Promise<void> {
  const message = parseWebviewMessage(raw);
  if (!message) {
    options.output.appendLine("[webview] 已丢弃无法通过校验的消息");
    return;
  }

  try {
    await dispatch(controller, message, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.output.appendLine(`[webview] 处理 ${message.type} 失败：${detail}`);
    options.post({ type: "error", message: `操作失败：${detail}`, recoverable: true });
  }
}

async function dispatch(
  controller: AgentController,
  message: WebviewToHostMessage,
  options: WebviewMessageOptions,
): Promise<void> {
  switch (message.type) {
    case "ready":
      options.post({ type: "mode", mode: controller.mode });
      options.post({ type: "connection", state: "idle" });
      options.onReady?.();
      controller.publishWorkspaces();
      controller.syncState();
      return;
    case "sendPrompt":
      // 先切模式再发问，两步都在这一条消息里做完，中间不会插进别的消息。
      if (message.mode) await controller.setMode(message.mode);
      await controller.sendPrompt(message.text);
      return;
    case "stop":
      await controller.stop();
      return;
    case "newSession":
      await controller.newSession();
      return;
    case "openHistory":
      await controller.openSessionHistory();
      return;
    case "openFolder":
      await controller.openFolder();
      return;
    case "switchWorkspace":
      await controller.switchWorkspace(message.path);
      return;
    case "removeWorkspace":
      await controller.removeWorkspace(message.path);
      return;
    case "loadSession":
      await controller.loadPersistedSession(message.sessionId);
      return;
    case "renameSession":
      await controller.renameSession(message.sessionId, message.title);
      return;
    case "deleteSession":
      await controller.deleteSession(message.sessionId);
      return;
    case "openSessionMenu":
      await controller.openSessionMenu(message.sessionId);
      return;
    case "pinSession":
      await controller.pinSession(message.sessionId);
      return;
    case "archiveSession":
      await controller.archiveSession(message.sessionId);
      return;
    case "searchSessions":
      controller.setSessionQuery(message.query);
      return;
    case "openSettings":
      await controller.openSettings();
      return;
    case "openExternalUrl":
      await controller.openExternalUrl(message.url);
      return;
    case "listWorkspaceFiles":
      await controller.listWorkspaceFiles(message.query);
      return;
    case "openWorkspaceFile":
      await controller.openWorkspaceFile(message.relativePath, message.line);
      return;
    case "openNativeTerminal":
      await controller.openNativeTerminal();
      return;
    case "openSimpleBrowser":
      await controller.openSimpleBrowser(message.url);
      return;
    case "setMode":
      await controller.setMode(message.mode);
      return;
    case "showLogs":
      await controller.showLogs();
      return;
    case "reconnect":
      await controller.reconnect();
      return;
    case "approvePlan":
      await controller.approvePlan();
      return;
    case "rejectPlan":
      await controller.rejectPlan();
      return;
    case "revisePlan":
      await controller.revisePlan(message.feedback);
      return;
    case "permissionDecision":
      await controller.respondPermission(message.requestId, message.decision);
      return;
    case "answerQuestion":
      await controller.respondQuestion(message.requestId, message.answers);
      return;
    case "askIntentOverride":
      await controller.continuePendingPrompt();
      return;
    case "addCurrentFile":
      await controller.addCurrentFile();
      return;
    case "addSelection":
      await controller.addSelection();
      return;
    case "pickFiles":
      await controller.pickContextFiles();
      return;
    case "pickFolder":
      await controller.pickContextFolder();
      return;
    case "addTerminalOutput":
      controller.addTerminalOutput();
      return;
    case "addImageContext":
      controller.addImageContext(message.name, message.dataUrl);
      return;
    case "addDroppedUris":
      await controller.addDroppedUris(message.uris);
      return;
    case "addDroppedFile":
      await controller.addDroppedNamedFile(message.name, message.content);
      return;
    case "addDiagnostics":
      await controller.addDiagnosticsContext();
      return;
    case "removeContext":
      controller.removeContext(message.id);
      return;
    case "clearContext":
      controller.clearContext();
      return;
    case "showContext":
      await controller.showContext(message.id);
      return;
    case "contextSuggestQuery":
      await controller.suggestContext(message.query);
      return;
    case "contextSuggestSelect":
      await controller.selectContextCandidate(message.candidateId, message.sourceType);
      return;
    case "openDiff":
      await controller.openDiff(message.changeId);
      return;
    case "requestChangeDiff":
      await controller.changeDiff(message.changeId);
      return;
    case "acceptChange":
      await controller.acceptChange(message.changeId);
      return;
    case "rejectChange":
      await controller.rejectChange(message.changeId);
      return;
    case "hunkAction":
      await controller.hunkAction(message.changeId, message.hunkId, message.action);
      return;
    case "showConflict":
      await controller.showConflict(message.changeId);
      return;
    case "acceptAll":
      await controller.acceptAll(message.turnId);
      return;
    case "rejectAll":
      await controller.rejectAll(message.turnId);
      return;
    case "undoTurn":
      await controller.undoTurn(message.turnId);
      return;
    case "showBackgroundTaskOutput":
      await controller.showBackgroundTaskOutput(message.taskId);
      return;
    case "killBackgroundTask":
      await controller.killBackgroundTask(message.taskId);
      return;
    case "openComposerMenu":
      controller.openComposerMenu();
      return;
    case "setupAction":
      await controller.handleSetupAction(message.action);
      return;
    case "selectModel":
      await controller.selectModel(message.modelId);
      return;
    case "compactContext":
      await controller.compactConversation();
      return;
    case "requestUsageDetail":
      options.post({ type: "usageDetail", usage: controller.getUsage() });
      return;
    case "openAgentPanel":
      await options.openAgentPanel?.();
      return;
    case "openModelSettings":
      await options.openModelSettings?.();
      return;
    case "openExtensions":
      await options.openExtensions?.();
      return;
    case "savePlanEdits":
      await controller.savePlanEdits(message.plan);
      return;
    case "addPlanStep":
      await controller.addPlanStep(message.title, message.description);
      return;
    case "removePlanStep":
      await controller.removePlanStep(message.stepId);
      return;
    case "setPlanStepIncluded":
      await controller.setPlanStepIncluded(message.stepId, message.included);
      return;
    case "updatePlanStep":
      await controller.updatePlanStep(message.stepId, {
        title: message.title,
        ...(message.description !== undefined ? { description: message.description } : {}),
        ...(message.files ? { files: message.files } : {}),
      });
      return;
    case "reorderPlanSteps":
      await controller.reorderPlanSteps(message.stepIds);
      return;
    case "startPlanBuild":
      await controller.startPlanBuild();
      return;
    case "pausePlanBuild":
      await controller.pausePlanBuild();
      return;
    case "resumePlanBuild":
      await controller.resumePlanBuild();
      return;
    case "discardPlanEdits":
      controller.discardPlanEdits();
      return;
    case "answerClarification":
      await controller.answerClarification(message.clarificationId, message.answer);
      return;
    case "confirmDebugFix":
      await controller.confirmDebugFix();
      return;
    case "queueRemove":
      controller.removeQueuedPrompt(message.id);
      return;
    case "queueEdit":
      controller.editQueuedPrompt(message.id, message.text);
      return;
    case "queueReorder":
      controller.reorderQueuedPrompts(message.orderedIds);
      return;
    case "queueFlush":
      await controller.flushQueuedPrompt(message.id);
      return;
    default:
      return;
  }
}
