import type { McpServerDraft } from "../../../extensions-messages";
import { Section, button, dropdown, el, listItem, row, textArea, textInput, toggle } from "../components";
import type { PageDeps } from "../page-types";
import { emptyMcpDraft, mcpDraftFrom } from "../state";

/** 能力扩展：Skills 与自定义 MCP 服务器。 */
export function renderCapabilitiesPage(deps: PageDeps): HTMLElement[] {
  return [renderSkills(deps), ...renderMcp(deps)];
}

function renderSkills(deps: PageDeps): HTMLElement {
  const { state } = deps;
  const section = new Section(
    "Skills",
    "扫描托管 GROK_HOME/skills、本机 ~/.grok/skills 与当前仓库 .grok/skills。对话里用 /技能名 触发。",
  );

  for (const skill of state.skills) {
    section.add(listItem({
      title: skill.name,
      badges: [
        { text: skill.scope === "user" ? "用户" : "项目", tone: "muted" },
        { text: skill.slash, tone: "muted" },
      ],
      meta: [skill.description, skill.directory],
      control: toggle(
        !skill.disabled,
        (next) => deps.post({ type: "setSkillEnabled", name: skill.name, enabled: next }),
        { label: skill.name },
      ),
      actions: [
        button("打开目录", "ghost", () => {
          deps.post({ type: "openSkillFolder", directory: skill.directory });
        }),
        button("删除", "danger", () => {
          deps.post({ type: "removeSkill", name: skill.name, scope: skill.scope });
        }),
      ],
    }));
  }
  section.empty("尚未发现技能。技能是把一套固定做法教给 Agent 的最短路径。");

  const toolbar = el("div", "st-page-actions");
  toolbar.appendChild(button("从文件夹安装", "primary", () => {
    deps.post({ type: "installSkillFromFolder", scope: "user" });
  }));
  toolbar.appendChild(button("从 zip 安装", "default", () => {
    deps.post({ type: "installSkillFromZip", scope: "user" });
  }));
  toolbar.appendChild(button("安装到当前仓库", "default", () => {
    deps.post({ type: "installSkillFromFolder", scope: "workspace" });
  }, { disabled: !state.workspaceAvailable }));
  section.root.appendChild(toolbar);
  return section.root;
}

function renderMcp(deps: PageDeps): HTMLElement[] {
  const { state } = deps;
  const section = new Section(
    "MCP 服务器",
    "可添加 stdio 或 HTTP/SSE 服务。密钥写入系统凭据库，不会出现在 config.toml。"
      + "系统联网搜索（lingdong_web）由宿主管理，不在这里列出也不可覆盖。",
  );

  for (const server of state.mcpServers) {
    const detail = server.transport === "stdio"
      ? `${server.command ?? ""}${server.argsText ? ` ${server.argsText.replace(/\n/g, " ")}` : ""}`
      : (server.url ?? "");
    const secrets = [
      ...server.secretEnvKeys.map((key) => `env:${key}`),
      ...server.secretHeaderKeys.map((key) => `header:${key}`),
    ];
    section.add(listItem({
      title: server.name,
      badges: [{ text: server.transport, tone: "muted" }],
      meta: [
        detail.trim() || "（未填写命令/URL）",
        secrets.length > 0 ? `已保存密钥槽：${secrets.join("、")}` : "",
      ],
      control: toggle(
        server.enabled,
        (next) => deps.post({ type: "setMcpEnabled", id: server.id, enabled: next }),
        { label: server.name },
      ),
      actions: [
        button("编辑", "ghost", () => {
          state.mcpDraft = mcpDraftFrom(server);
          deps.repaint();
        }),
        button("删除", "danger", () => deps.post({ type: "removeMcp", id: server.id })),
      ],
    }));
  }
  section.empty("还没有自定义 MCP 服务器。");

  const toolbar = el("div", "st-page-actions");
  toolbar.appendChild(button("添加服务器", "primary", () => {
    state.mcpDraft = emptyMcpDraft();
    deps.repaint();
  }, { disabled: state.mcpDraft !== undefined }));
  section.root.appendChild(toolbar);

  const nodes = [section.root];
  if (state.mcpDraft) nodes.push(renderMcpForm(deps, state.mcpDraft));
  return nodes;
}

/**
 * MCP 编辑表单。
 *
 * draft 是就地可变对象：输入过程中改 draft 但不重绘，否则每敲一个字符
 * 都会重建 DOM 并丢掉焦点。只有切换传输类型才重绘——那会换掉整组字段。
 */
function renderMcpForm(deps: PageDeps, draft: McpServerDraft): HTMLElement {
  const { state } = deps;
  const section = new Section(draft.id ? `编辑 ${draft.name}` : "添加 MCP 服务器");

  section.add(row({
    title: "名称",
    description: "只允许字母、数字、下划线与连字符。",
    control: textInput(draft.name, (next) => { draft.name = next; }, { placeholder: "my-server" }),
  }));

  section.add(row({
    title: "传输类型",
    description: "stdio 由本机拉起子进程；HTTP/SSE 连远端地址。",
    control: dropdown(draft.transport, [
      { value: "stdio", label: "stdio（本地命令）" },
      { value: "http", label: "HTTP / SSE" },
    ], (next) => {
      draft.transport = next as McpServerDraft["transport"];
      deps.repaint();
    }),
  }));

  section.add(row({
    title: "启用",
    description: "关闭后保留配置但不拉起。",
    control: toggle(draft.enabled, (next) => { draft.enabled = next; }, { label: "启用" }),
  }));

  if (draft.transport === "stdio") {
    section.add(row({
      title: "命令",
      control: textInput(draft.command ?? "", (next) => { draft.command = next; }, { placeholder: "node" }),
    }));
    section.add(row({
      title: "参数",
      description: "每行一个。",
      block: textArea(draft.argsText ?? "", (next) => { draft.argsText = next; }),
    }));
    section.add(row({
      title: "环境变量",
      description: "非敏感，KEY=VALUE 每行一个。",
      block: textArea(draft.envText ?? "", (next) => { draft.envText = next; }),
    }));
    section.add(row({
      title: "敏感环境变量",
      description: "写入系统凭据库，不进 config.toml。留空值可清除已保存的槽位。",
      block: textArea(draft.secretEnvText ?? "", (next) => { draft.secretEnvText = next; }),
    }));
  } else {
    section.add(row({
      title: "URL",
      control: textInput(draft.url ?? "", (next) => { draft.url = next; }, {
        placeholder: "https://example.com/sse",
      }),
    }));
    section.add(row({
      title: "Headers",
      description: "非敏感，Name=Value 每行一个。",
      block: textArea(draft.headersText ?? "", (next) => { draft.headersText = next; }),
    }));
    section.add(row({
      title: "敏感 Headers",
      description: "写入系统凭据库。留空值可清除已保存的槽位。",
      block: textArea(draft.secretHeadersText ?? "", (next) => { draft.secretHeadersText = next; }),
    }));
  }

  const actions = el("div", "st-page-actions");
  actions.appendChild(button("保存", "primary", () => {
    deps.post({ type: "upsertMcp", draft: { ...draft } });
    state.mcpDraft = undefined;
  }));
  actions.appendChild(button("取消", "default", () => {
    state.mcpDraft = undefined;
    deps.repaint();
  }));
  section.root.appendChild(actions);
  return section.root;
}
