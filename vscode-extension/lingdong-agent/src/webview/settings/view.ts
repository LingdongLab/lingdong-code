/**
 * 设置页根视图：左侧分类导航 + 右侧内容。
 *
 * 纯函数：输入 state 与回调，输出 DOM，因此可以在 jsdom 里直接断言。
 * 整页共用这一个 paint，任何一段数据更新都重绘全页——设置页的交互频率低，
 * 与其做局部更新、承担「切过去发现是旧数据」的风险，不如整页重画。
 */

import {
  CATEGORY_LABEL,
  SETTINGS_CATEGORIES,
  SETTING_KEYS,
  SETTING_SPECS,
  type SettingsCategory,
  type SettingsWebviewMessage,
} from "../../settings-messages";
import { Section, button, el, notice } from "./components";
import { renderAgentPage } from "./pages/agent-page";
import { renderCapabilitiesPage } from "./pages/capabilities-page";
import { renderGeneralPage } from "./pages/general-page";
import { renderModelsPage } from "./pages/models-page";
import { renderPrivacyPage } from "./pages/privacy-page";
import { renderRulesPage } from "./pages/rules-page";
import type { PageDeps } from "./page-types";
import { settingMatches, settingRow } from "./setting-rows";
import type { PageState } from "./state";

const CATEGORY_DESC: Record<SettingsCategory, string> = {
  general: "窗口形态、编辑预览与运行时路径。",
  models: "服务商、密钥与可用模型。密钥保存在系统凭据库。",
  agent: "Agent 什么时候问你、改完做什么、能不能出网。",
  capabilities: "Skills 与自定义 MCP 服务器。",
  rules: "规则文件、跨会话记忆与语言服务。",
  privacy: "已记住的权限、运行时通道画像与快照存储。",
};

const RENDERERS: Record<SettingsCategory, (deps: PageDeps) => HTMLElement[]> = {
  general: renderGeneralPage,
  models: renderModelsPage,
  agent: renderAgentPage,
  capabilities: renderCapabilitiesPage,
  rules: renderRulesPage,
  privacy: renderPrivacyPage,
};

export interface ViewCallbacks {
  post(message: SettingsWebviewMessage): void;
  repaint(): void;
  navigate(category: SettingsCategory): void;
  search(query: string): void;
}

export function renderSettings(
  root: HTMLElement,
  state: PageState,
  callbacks: ViewCallbacks,
  now: number = Date.now(),
): void {
  root.replaceChildren();

  const deps: PageDeps = {
    state,
    post: callbacks.post,
    repaint: callbacks.repaint,
    now,
    settingRows: {
      config: state.config,
      update: (key, value) => callbacks.post({ type: "updateSetting", key, value }),
      pickExecutable: () => callbacks.post({ type: "pickGrokExecutable" }),
    },
  };

  const shell = el("div", "st-shell");
  shell.appendChild(renderNav(state, callbacks));
  shell.appendChild(renderMain(state, callbacks, deps));
  root.appendChild(shell);
}

function renderNav(state: PageState, callbacks: ViewCallbacks): HTMLElement {
  const nav = el("nav", "st-nav");

  const back = el("button", "st-nav-back", "← 返回 Agent");
  back.type = "button";
  back.addEventListener("click", () => callbacks.post({ type: "backToAgent" }));
  nav.appendChild(back);

  nav.appendChild(el("div", "st-nav-title", "设置"));

  const search = document.createElement("input");
  search.type = "search";
  search.className = "st-search";
  search.placeholder = "搜索设置";
  search.value = state.search;
  search.addEventListener("input", () => callbacks.search(search.value));
  nav.appendChild(search);

  const list = el("div", "st-nav-list");
  for (const category of SETTINGS_CATEGORIES) {
    const active = !state.search && state.category === category;
    const item = el("button", `st-nav-item${active ? " active" : ""}`, CATEGORY_LABEL[category]);
    item.type = "button";
    item.setAttribute("aria-current", active ? "page" : "false");
    item.addEventListener("click", () => callbacks.navigate(category));
    list.appendChild(item);
  }
  nav.appendChild(list);
  return nav;
}

function renderMain(state: PageState, callbacks: ViewCallbacks, deps: PageDeps): HTMLElement {
  const main = el("div", "st-main");
  const page = el("div", "st-page");

  const searching = state.search.trim().length > 0;
  const head = el("div", "st-page-head");
  const text = el("div");
  text.appendChild(el(
    "h1",
    "st-page-title",
    searching ? "搜索结果" : CATEGORY_LABEL[state.category],
  ));
  text.appendChild(el(
    "p",
    "st-page-desc",
    searching ? `匹配「${state.search.trim()}」的设置项。` : CATEGORY_DESC[state.category],
  ));
  head.appendChild(text);

  const actions = el("div", "st-page-actions");
  actions.appendChild(button("刷新", "ghost", () => callbacks.post({ type: "refresh" })));
  head.appendChild(actions);
  page.appendChild(head);

  if (state.busy) page.appendChild(el("div", "st-busy", state.busyLabel ?? "处理中…"));
  if (state.notice) page.appendChild(notice(state.notice.level, state.notice.message));

  const body = searching
    ? renderSearchResults(state, deps)
    : RENDERERS[state.category](deps);
  for (const node of body) page.appendChild(node);

  main.appendChild(page);
  return main;
}

/**
 * 搜索只覆盖规格表里的设置项。
 *
 * 技能名、MCP 服务器名这些是数据不是设置，混进同一个结果列表里，
 * 用户会以为搜索能找到一切，然后在找不到某个东西时怀疑是不是没装上。
 * 所以这里明确只搜设置，并在结果为空时说清楚这一点。
 */
function renderSearchResults(state: PageState, deps: PageDeps): HTMLElement[] {
  const query = state.search.trim();
  const nodes: HTMLElement[] = [];

  for (const category of SETTINGS_CATEGORIES) {
    const keys = SETTING_KEYS.filter(
      (key) => SETTING_SPECS[key].category === category && settingMatches(key, query),
    );
    if (keys.length === 0) continue;
    const section = new Section(CATEGORY_LABEL[category]);
    for (const key of keys) section.add(settingRow(key, deps.settingRows));
    nodes.push(section.root);
  }

  if (nodes.length === 0) {
    const section = new Section();
    section.empty(
      `没有匹配「${query}」的设置项。搜索只覆盖开关与取值；`
        + "技能、MCP 服务器、模型这些内容请到对应分类里找。",
    );
    nodes.push(section.root);
  }
  return nodes;
}
