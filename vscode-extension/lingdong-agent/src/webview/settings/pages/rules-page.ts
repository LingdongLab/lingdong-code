import type { RuleFileEntryView } from "../../../extensions-messages";
import { Section, button, el, listItem, textInput, toggle } from "../components";
import type { PageDeps } from "../page-types";
import { settingRow } from "../setting-rows";

const VENDOR_LABEL: Record<RuleFileEntryView["vendor"], string> = {
  grok: "Grok",
  claude: "Claude 兼容",
  cursor: "Cursor 兼容",
};

/** 规则文件、跨会话记忆、语言服务：三样都是「喂给 Agent 的上下文」。 */
export function renderRulesPage(deps: PageDeps): HTMLElement[] {
  return [
    renderRuleFiles(deps),
    renderMemory(deps),
    renderLsp(deps),
  ];
}

function renderRuleFiles(deps: PageDeps): HTMLElement {
  const { state } = deps;
  const section = new Section(
    "规则文件",
    "Grok 会读仓库根的 AGENTS.md，以及 .grok/rules、.cursor/rules、.claude/rules 下的 *.md 和用户级同名目录。"
      + "从 Cursor 迁过来的规则可直接复用。",
  );

  for (const rule of state.rules) {
    section.add(listItem({
      title: rule.label,
      badges: [
        { text: rule.scope === "project" ? "项目" : "用户", tone: "muted" },
        { text: VENDOR_LABEL[rule.vendor], tone: "muted" },
        { text: `约 ${rule.approxTokens} tokens`, tone: "muted" },
      ],
      meta: [rule.path],
      actions: [button("编辑", "default", () => deps.post({ type: "openRuleFile", path: rule.path }))],
    }));
  }
  section.empty("还没有规则文件。规则是让 Agent 记住项目约定最省事的方式。");

  const toolbar = el("div", "st-page-actions");
  toolbar.appendChild(button(
    "新建项目 AGENTS.md",
    "primary",
    () => deps.post({ type: "createProjectAgents" }),
    { disabled: !state.workspaceAvailable },
  ));

  const title = textInput(state.newRuleTitle, (next) => {
    state.newRuleTitle = next;
  }, { placeholder: "新规则名称" });
  // 输入过程中不重绘（会丢焦点），所以这里直接读 DOM 而不是读 state。
  toolbar.appendChild(title);

  const create = (scope: "project" | "user"): void => {
    const value = title.value.trim();
    if (!value) return;
    deps.post({ type: "createRule", scope, title: value });
    state.newRuleTitle = "";
  };
  toolbar.appendChild(button("加到项目", "default", () => create("project"), {
    disabled: !state.workspaceAvailable,
  }));
  toolbar.appendChild(button("加到用户", "default", () => create("user")));
  section.root.appendChild(toolbar);
  return section.root;
}

function renderMemory(deps: PageDeps): HTMLElement {
  const section = new Section("跨会话记忆");
  section.add(settingRow("memory", deps.settingRows));
  if (deps.state.memoryDirectory) {
    section.add(el("div", "st-item-meta st-row", `记忆目录：${deps.state.memoryDirectory}`));
  }
  return section.root;
}

function renderLsp(deps: PageDeps): HTMLElement {
  const section = new Section(
    "语言服务（LSP）",
    "探测到的 language server 会写进用户级 lsp.json，Grok 据此提供诊断与跳转。"
      + "没装的不会写入——写一个跑不起来的命令只会让每次会话白起一个失败进程。",
  );

  for (const server of deps.state.lspServers) {
    section.add(listItem({
      title: server.label,
      badges: [
        { text: server.found ? "已就绪" : "未安装", tone: server.found ? "ok" : "muted" },
        ...(server.source === "workspace" ? [{ text: "仓库内", tone: "muted" as const }] : []),
      ],
      meta: [server.hint, server.found ? (server.command ?? "") : `安装：${server.install}`],
      control: toggle(
        server.enabled,
        (next) => deps.post({ type: "setLspEnabled", id: server.id, enabled: next }),
        { disabled: !server.found, label: server.label },
      ),
    }));
  }
  section.empty("没有探测到可用的 language server。");
  return section.root;
}
