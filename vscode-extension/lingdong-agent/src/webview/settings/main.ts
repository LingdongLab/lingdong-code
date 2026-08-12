import "./settings.css";
import type { SettingsHostMessage, SettingsWebviewMessage } from "../../settings-messages";
import { createPageState } from "./state";
import { renderSettings } from "./view";

/**
 * 统一设置页入口。只装配与接线。
 *
 * 用的是设置页自己的消息联合类型，所以这里在类型上就发不出聊天面板的任何消息，
 * 也收不到聊天面板的推送。
 */

interface VsCodeApi {
  postMessage(message: SettingsWebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
if (!root) throw new Error("缺少 root");

const state = createPageState();

function post(message: SettingsWebviewMessage): void {
  vscode.postMessage(message);
}

function paint(): void {
  renderSettings(root!, state, {
    post,
    repaint: paint,
    navigate: (category) => {
      state.category = category;
      // 点分类等于放弃当前搜索：否则点了没反应，因为搜索结果盖在上面。
      state.search = "";
      paint();
    },
    search: (query) => {
      state.search = query;
      paint();
    },
  });
}

window.addEventListener("message", (event: MessageEvent<SettingsHostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "config":
      state.config = message.config;
      break;
    case "permissionRules":
      state.permissionRules = message.rules;
      break;
    case "privacy":
      state.privacy = message.sections;
      break;
    case "memoryDirectory":
      state.memoryDirectory = message.directory;
      break;
    case "navigate":
      state.category = message.category;
      state.search = "";
      break;
    case "providers":
      state.providers = message.providers;
      state.availableBuiltins = message.availableBuiltins;
      state.activeModelId = message.activeModelId;
      // 保存成功后收起表单：留着它会让人以为还没提交。
      if (state.addingProvider && message.providers.length > 0) state.addingProvider = false;
      break;
    case "catalog":
      state.catalogs[message.catalog.providerId] = message.catalog;
      break;
    case "balance":
      state.balances[message.balance.providerId] = message.balance;
      break;
    case "testResult":
      state.results[message.result.modelId ?? message.result.providerId] = message.result;
      break;
    case "keySaved":
      state.notice = { level: "info", message: "密钥已保存到系统凭据库。" };
      break;
    case "busy":
      state.busy = message.busy;
      state.busyLabel = message.label;
      break;
    case "snapshot":
      state.skills = message.skills;
      state.mcpServers = message.mcpServers;
      state.workspaceAvailable = message.workspaceAvailable;
      state.rules = message.rules;
      state.lspServers = message.lspServers;
      // 记忆开关本身走通用配置通道；这里只取目录用于展示。
      state.memoryDirectory = message.memory.directory;
      break;
    case "notice":
      state.notice = { level: message.level, message: message.message };
      break;
    case "error":
      state.notice = { level: "error", message: message.message };
      break;
    default:
      return;
  }
  paint();
});

paint();
post({ type: "ready" });
