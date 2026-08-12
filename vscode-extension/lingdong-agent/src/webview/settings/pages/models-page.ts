import type {
  SettingsCatalogEntryView,
  SettingsCatalogView,
  SettingsProviderView,
  SettingsTestResultView,
} from "../../../model-settings-messages";
import { Section, badge, button, dropdown, el, listItem, row, textInput, toggle } from "../components";
import type { PageDeps } from "../page-types";
import { CATALOG_PAGE, formatContextWindow, formatTestedAt, emptyProviderDraft } from "../state";
import { settingRowsFor } from "../setting-rows";

/**
 * 需要固定隐私说明的服务商。
 *
 * Poe 是中转：请求先到 Poe，再由 Poe 转给所选模型的上游厂商，
 * 也就是数据经过两家而不是一家。这一点必须在用户添加模型的同一屏里说清楚。
 */
const PRIVACY_NOTES: Record<string, string> = {
  poe: "使用 Poe 模型时，任务中的消息、代码片段和工具结果将发送到 Poe，"
    + "并可能由 Poe 转交给所选模型的上游服务商。",
};

/** 有余额接口的服务商；没有的就不显示这个按钮，免得点了只会报错。 */
const BALANCE_PROVIDERS: readonly string[] = ["poe"];

export function renderModelsPage(deps: PageDeps): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (deps.state.addingProvider) nodes.push(renderProviderEditor(deps));
  nodes.push(renderProviderList(deps));

  const expanded = deps.state.providers.find((p) => p.id === deps.state.expandedProviderId);
  if (expanded) nodes.push(...renderProviderDetail(deps, expanded));

  const advanced = new Section("高级");
  for (const node of settingRowsFor("models", deps.settingRows)) advanced.add(node);
  if (!advanced.isEmpty) nodes.push(advanced.root);
  return nodes;
}

function renderProviderList(deps: PageDeps): HTMLElement {
  const { state } = deps;
  const section = new Section(
    "服务商",
    "密钥保存在系统凭据库中，本页面不会显示密钥的任何部分。",
  );

  for (const provider of state.providers) {
    const expanded = state.expandedProviderId === provider.id;
    section.add(listItem({
      title: provider.displayName,
      badges: [
        ...(provider.builtin ? [{ text: "内置", tone: "muted" as const }] : []),
        provider.keyConfigured
          ? { text: "已配置密钥", tone: "ok" as const }
          : { text: "未配置密钥", tone: "warn" as const },
        { text: `${provider.modelCount} 个模型`, tone: "muted" as const },
      ],
      meta: [provider.host, formatTestedAt(provider.lastTestedAt, deps.now)],
      control: toggle(
        provider.enabled,
        (next) => deps.post({ type: "setProviderEnabled", providerId: provider.id, enabled: next }),
        { label: provider.displayName },
      ),
      actions: [
        button(expanded ? "收起" : "管理", "ghost", () => {
          state.expandedProviderId = expanded ? undefined : provider.id;
          deps.repaint();
        }),
        ...(provider.builtin
          ? []
          : [button("删除", "danger", () => {
            deps.post({ type: "deleteProvider", providerId: provider.id });
          })]),
      ],
    }));
  }

  for (const template of state.availableBuiltins) {
    section.add(listItem({
      title: template.displayName,
      badges: [{ text: "未添加", tone: "muted" }],
      meta: [template.host, template.description],
      actions: [button("添加", "primary", () => {
        deps.post({ type: "addBuiltinProvider", providerId: template.id });
      })],
    }));
  }

  section.empty("还没有任何服务商。先添加一个内置服务商，或自定义一个兼容 OpenAI 协议的地址。");

  const toolbar = el("div", "st-page-actions");
  toolbar.appendChild(button("添加自定义服务商", "default", () => {
    state.addingProvider = true;
    state.providerDraft = emptyProviderDraft();
    deps.repaint();
  }, { disabled: state.addingProvider }));
  section.root.appendChild(toolbar);
  return section.root;
}

function renderProviderEditor(deps: PageDeps): HTMLElement {
  const draft = deps.state.providerDraft;
  const section = new Section(
    "添加自定义服务商",
    "适用于任何兼容 OpenAI Chat Completions 或 Responses 协议的地址。",
  );

  section.add(row({
    title: "显示名称",
    control: textInput(draft.displayName, (next) => { draft.displayName = next; }, {
      placeholder: "例如 我的中转",
    }),
  }));
  section.add(row({
    title: "Base URL",
    description: "只填到 /v1 这一层，不要带具体的接口路径。",
    control: textInput(draft.baseUrl, (next) => { draft.baseUrl = next; }, {
      placeholder: "https://example.com/v1",
    }),
  }));
  section.add(row({
    title: "协议",
    control: dropdown(draft.protocol, [
      { value: "chat_completions", label: "Chat Completions" },
      { value: "responses", label: "Responses" },
    ], (next) => { draft.protocol = next as typeof draft.protocol; }),
  }));
  section.add(row({
    title: "首个模型 ID",
    description: "真正发给服务商的模型名。",
    control: textInput(draft.remoteModelId, (next) => { draft.remoteModelId = next; }, {
      placeholder: "gpt-4o-mini",
    }),
  }));
  section.add(row({
    title: "上下文长度",
    description: "可留空，之后按能力检测结果补。",
    control: textInput(draft.contextWindow, (next) => { draft.contextWindow = next; }, {
      placeholder: "128000",
    }),
  }));

  const actions = el("div", "st-page-actions");
  actions.appendChild(button("保存", "primary", () => {
    const contextWindow = Number(draft.contextWindow.trim());
    deps.post({
      type: "addCustomProvider",
      draft: {
        displayName: draft.displayName.trim(),
        baseUrl: draft.baseUrl.trim(),
        protocol: draft.protocol,
        remoteModelId: draft.remoteModelId.trim(),
        ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      },
    });
  }));
  actions.appendChild(button("取消", "default", () => {
    deps.state.addingProvider = false;
    deps.state.providerDraft = emptyProviderDraft();
    deps.repaint();
  }));
  section.root.appendChild(actions);
  return section.root;
}

function renderProviderDetail(deps: PageDeps, provider: SettingsProviderView): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const section = new Section(provider.displayName, `Base URL：${provider.baseUrl}`);

  const note = PRIVACY_NOTES[provider.id];
  if (note) section.add(row({ title: "数据流向", description: note }));

  section.add(renderKeyRow(deps, provider));

  if (BALANCE_PROVIDERS.includes(provider.id)) {
    const balance = deps.state.balances[provider.id];
    section.add(row({
      title: "积分余额",
      ...(balance ? { description: balance.label } : {}),
      // 只在点击时查一次：余额是账务信息，不该被界面刷新顺带轮询。
      control: button("查询", "default", () => {
        deps.post({ type: "checkBalance", providerId: provider.id });
      }, { disabled: !provider.keyConfigured }),
    }));
  }
  nodes.push(section.root);

  nodes.push(renderCatalog(deps, provider));
  nodes.push(renderModelList(deps, provider));

  // Provider 级别的测试结果（还没落到具体模型时）单独显示一次。
  const providerResult = deps.state.results[provider.id];
  if (providerResult) nodes.push(renderTestResult(deps, providerResult));
  return nodes;
}

function renderKeyRow(deps: PageDeps, provider: SettingsProviderView): HTMLElement {
  const input = document.createElement("input");
  input.type = "password";
  input.className = "st-input";
  input.placeholder = provider.keyConfigured ? "已配置，填写可覆盖" : "粘贴 API Key";
  input.autocomplete = "off";

  const control = el("div", "st-row-control");
  control.appendChild(input);
  control.appendChild(button("保存", "primary", () => {
    const key = input.value.trim();
    if (!key) return;
    deps.post({ type: "saveKey", providerId: provider.id, key });
    // 提交即清空：界面不留副本。
    input.value = "";
  }));
  if (provider.keyConfigured) {
    control.appendChild(button("删除", "danger", () => {
      deps.post({ type: "deleteKey", providerId: provider.id });
    }));
  }

  return row({
    title: "API Key",
    description: provider.keyConfigured
      ? "已保存到系统凭据库。本页读不回它的任何一位。"
      : "保存到系统凭据库，不写入 settings.json 或 config.toml。",
    control,
  });
}

function renderCatalog(deps: PageDeps, provider: SettingsProviderView): HTMLElement {
  const { state } = deps;
  const catalog: SettingsCatalogView | undefined = state.catalogs[provider.id];
  const section = new Section("模型目录", describeCatalog(catalog, deps.now));

  const entries = catalog?.entries ?? [];
  if (entries.length > 0) section.add(renderCatalogFilters(deps, entries));

  const matched = entries.filter((entry) => matchesCatalogFilters(entry, state));
  for (const entry of matched.slice(0, state.catalogLimit)) {
    section.add(listItem({
      title: entry.displayName,
      badges: [
        { text: entry.vendor, tone: "muted" },
        ...(entry.added ? [{ text: "已添加", tone: "ok" as const }] : []),
        // features 只是服务商自己声明的标签，不代表能进 Agent；那要以本地检测为准。
        ...entry.features.slice(0, 3).map((feature) => ({ text: feature, tone: "muted" as const })),
      ],
      meta: [entry.remoteModelId, entry.description ?? "", formatContextWindow(entry.contextWindow)],
      actions: entry.added
        ? []
        : [button("添加", "default", () => {
          deps.post({
            type: "addModel",
            providerId: provider.id,
            remoteModelId: entry.remoteModelId,
            protocol: entry.protocols[0] ?? "chat_completions",
          });
        }, { disabled: !provider.keyConfigured })],
    }));
  }

  if (entries.length === 0) {
    section.empty("还没有同步过目录。同步只拉模型清单，不发送任何对话内容。");
  } else if (matched.length === 0) {
    section.add(el("div", "st-empty", "没有符合当前筛选条件的模型。"));
  }

  const toolbar = el("div", "st-page-actions");
  if (matched.length > state.catalogLimit) {
    toolbar.appendChild(button(
      `加载更多（还有 ${matched.length - state.catalogLimit} 条）`,
      "default",
      () => {
        state.catalogLimit += CATALOG_PAGE;
        deps.repaint();
      },
    ));
  }
  toolbar.appendChild(button("同步目录", "default", () => {
    deps.post({ type: "syncCatalog", providerId: provider.id, force: false });
  }, { disabled: !provider.keyConfigured }));
  toolbar.appendChild(button("强制刷新", "ghost", () => {
    deps.post({ type: "syncCatalog", providerId: provider.id, force: true });
  }, { disabled: !provider.keyConfigured, title: "忽略本地缓存，重新向服务商拉取" }));
  section.root.appendChild(toolbar);
  return section.root;
}

/** 改任一筛选条件都回到第一批：留在第 200 条的位置上看新结果没有意义。 */
function renderCatalogFilters(
  deps: PageDeps,
  entries: readonly SettingsCatalogEntryView[],
): HTMLElement {
  const { state } = deps;
  const reset = (apply: () => void): void => {
    apply();
    state.catalogLimit = CATALOG_PAGE;
    deps.repaint();
  };

  const bar = el("div", "st-row");
  const controls = el("div", "st-row-control");

  const search = document.createElement("input");
  search.type = "search";
  search.className = "st-input";
  search.placeholder = "搜索模型 ID 或厂商";
  search.value = state.catalogQuery;
  search.addEventListener("change", () => reset(() => { state.catalogQuery = search.value; }));
  controls.appendChild(search);

  const vendors = [...new Set(entries.map((entry) => entry.vendor).filter(Boolean))].sort();
  controls.appendChild(dropdown(
    state.catalogVendor,
    [{ value: "", label: "全部厂商" }, ...vendors.map((v) => ({ value: v, label: v }))],
    (next) => reset(() => { state.catalogVendor = next; }),
  ));

  controls.appendChild(dropdown(
    state.catalogProtocol,
    [
      { value: "", label: "全部协议" },
      { value: "chat_completions", label: "Chat Completions" },
      { value: "responses", label: "Responses" },
    ],
    (next) => reset(() => { state.catalogProtocol = next; }),
  ));

  bar.appendChild(controls);
  return bar;
}

function matchesCatalogFilters(
  entry: SettingsCatalogEntryView,
  state: PageDeps["state"],
): boolean {
  const query = state.catalogQuery.trim().toLowerCase();
  if (query) {
    const haystack = `${entry.remoteModelId} ${entry.displayName} ${entry.vendor}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  if (state.catalogVendor && entry.vendor !== state.catalogVendor) return false;
  if (state.catalogProtocol
    && !entry.protocols.includes(state.catalogProtocol as SettingsCatalogEntryView["protocols"][number])) {
    return false;
  }
  return true;
}

function describeCatalog(catalog: SettingsCatalogView | undefined, now: number): string {
  if (!catalog) return "服务商声明的可用模型；添加后仍需本地能力检测才会进 Agent。";
  const parts = [catalog.fromCache ? "来自本地缓存" : "刚从服务商拉取"];
  if (catalog.syncedAt) parts.push(formatTestedAt(catalog.syncedAt, now).replace("测试", "同步"));
  if (catalog.skipped > 0) parts.push(`跳过 ${catalog.skipped} 条无法解析的条目`);
  return parts.join(" · ");
}

function renderModelList(deps: PageDeps, provider: SettingsProviderView): HTMLElement {
  const section = new Section(
    "已添加的模型",
    "能不能进 Agent 一律以本地能力检测为准，不看服务商自己声明的标签。",
  );

  for (const model of provider.models) {
    const active = deps.state.activeModelId === model.id;
    const result = deps.state.results[model.id];
    const item = listItem({
      title: model.displayName,
      badges: [
        ...(active ? [{ text: "当前", tone: "ok" as const }] : []),
        { text: model.protocolLabel, tone: "muted" },
        // 「未检测」与「仅 Ask」是两回事：前者是还没测，后者是测过且确定不支持工具调用。
        model.agentCompatible
          ? { text: "可用于 Agent", tone: "ok" as const }
          : model.verified
            ? { text: "仅 Ask", tone: "warn" as const }
            : { text: "未检测", tone: "muted" as const },
        ...(model.supportsVision ? [{ text: "视觉", tone: "muted" as const }] : []),
      ],
      meta: [
        `${model.remoteModelId} · ${formatContextWindow(model.contextWindow)} · ${formatTestedAt(model.testedAt, deps.now)}`,
      ],
      control: toggle(
        model.enabled,
        (next) => deps.post({
          type: "setModelEnabled",
          providerId: provider.id,
          modelId: model.id,
          enabled: next,
        }),
        { label: model.displayName },
      ),
      actions: [
        button("检测", "ghost", () => {
          deps.post({ type: "testModel", providerId: provider.id, modelId: model.id });
        }, { disabled: !provider.keyConfigured }),
        button("重命名", "ghost", () => {
          const next = window.prompt("新的显示名称", model.displayName);
          if (!next || next.trim() === model.displayName) return;
          deps.post({
            type: "renameModel",
            providerId: provider.id,
            modelId: model.id,
            displayName: next.trim(),
          });
        }),
        button("删除", "danger", () => {
          deps.post({ type: "deleteModel", providerId: provider.id, modelId: model.id });
        }),
      ],
    });

    const vision = el("div", "st-item-meta");
    vision.appendChild(el("span", undefined, "允许发送图片："));
    vision.appendChild(toggle(
      model.supportsVision,
      (next) => deps.post({
        type: "setModelVision",
        providerId: provider.id,
        modelId: model.id,
        vision: next,
      }),
      { label: `${model.displayName} 视觉` },
    ));
    item.appendChild(vision);

    if (result) item.appendChild(renderTestSteps(deps, result));
    section.add(item);
  }
  section.empty("这个服务商下还没有模型。可以从上面的目录里添加。");
  return section.root;
}

function renderTestResult(deps: PageDeps, result: SettingsTestResultView): HTMLElement {
  const section = new Section("能力检测结果");
  section.add(row({
    title: result.conclusionLabel,
    description: `协议：${result.protocolLabel}`,
    ...(result.canTryFallback
      ? {
        control: button("改用 Chat Completions 重试", "default", () => {
          deps.post({
            type: "testModel",
            providerId: result.providerId,
            modelId: result.modelId ?? result.providerId,
            protocol: "chat_completions",
          });
        }),
      }
      : {}),
  }));
  section.add(renderTestSteps(deps, result));
  return section.root;
}

function renderTestSteps(deps: PageDeps, result: SettingsTestResultView): HTMLElement {
  const wrap = el("div", "st-item-meta");
  const STEP_LABEL: Record<string, string> = {
    connection: "连接",
    streaming: "流式",
    capability: "工具调用",
  };
  for (const step of result.steps) {
    const line = el("div");
    const tone = step.status === "ok" ? "ok" : step.status === "failed" ? "danger" : "muted";
    line.appendChild(badge(STEP_LABEL[step.name] ?? step.name, tone));
    line.appendChild(document.createTextNode(` ${step.detail}`));
    wrap.appendChild(line);
  }
  if (result.canTryFallback && result.modelId) {
    const retry = button("改用 Chat Completions 重试", "ghost", () => {
      deps.post({
        type: "testModel",
        providerId: result.providerId,
        modelId: result.modelId as string,
        protocol: "chat_completions",
      });
    });
    wrap.appendChild(retry);
  }
  return wrap;
}
