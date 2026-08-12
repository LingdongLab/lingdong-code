import * as vscode from "vscode";
import {
  draftToUpsertInput,
  type ExtensionsHostMessage,
  type ExtensionsWebviewMessage,
  type LspServerEntryView,
  type McpServerView,
  type RuleFileEntryView,
  type SkillView,
} from "../extensions-messages";
import type { McpServerRegistry } from "../mcp/mcp-server-registry";
import type { LspService } from "./lsp-service";
import type { RulesService } from "./rules-service";
import type { SkillsService } from "./skills-service";

export interface ExtensionsServiceDeps {
  skills: SkillsService;
  mcp: McpServerRegistry;
  rules: RulesService;
  lsp: LspService;
  log(line: string): void;
  /** Skills / MCP 变更后：重写 config、刷新 capabilities。 */
  onChanged(): Promise<void>;
  workspaceAvailable(): boolean;
  /** Runtime 已连接时提示新对话生效。 */
  runtimeConnected(): boolean;
  /** 跨会话记忆当前是否开启（读扩展设置）。 */
  memoryEnabled(): boolean;
  /** 写扩展设置里的记忆开关；由宿主决定写全局还是工作区。 */
  setMemoryEnabled(enabled: boolean): Promise<void>;
  /** 记忆文件落盘目录（托管 GROK_HOME/memory）。 */
  memoryDirectory(): string;
  /** 在编辑器里打开一个文件。 */
  openFile(absolutePath: string): Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExtensionsService {
  private poster: ((message: ExtensionsHostMessage) => void) | undefined;

  constructor(private readonly deps: ExtensionsServiceDeps) {}

  setPoster(poster: ((message: ExtensionsHostMessage) => void) | undefined): void {
    this.poster = poster;
  }

  private post(message: ExtensionsHostMessage): void {
    this.poster?.(message);
  }

  async publish(): Promise<void> {
    const [skills, servers, rules, lspServers] = await Promise.all([
      this.deps.skills.list(),
      this.deps.mcp.list(),
      this.deps.rules.list(),
      this.deps.lsp.list(),
    ]);
    const skillViews: SkillView[] = skills.map((item) => ({
      name: item.name,
      description: item.description,
      scope: item.scope,
      directory: item.directory,
      disabled: item.disabled,
      slash: `/${item.name}`,
    }));
    const mcpServers: McpServerView[] = servers.map((item) => ({
      id: item.id,
      name: item.name,
      transport: item.transport,
      enabled: item.enabled,
      ...(item.command ? { command: item.command } : {}),
      ...(item.args ? { argsText: item.args.join("\n") } : {}),
      ...(item.url ? { url: item.url } : {}),
      envKeys: Object.keys(item.env ?? {}),
      secretEnvKeys: [...(item.secretEnvKeys ?? [])],
      headerKeys: Object.keys(item.headers ?? {}),
      secretHeaderKeys: [...(item.secretHeaderKeys ?? [])],
    }));
    const ruleViews: RuleFileEntryView[] = rules.map((item) => ({
      path: item.path,
      label: item.label,
      scope: item.scope,
      vendor: item.vendor,
      kind: item.kind,
      approxTokens: item.approxTokens,
    }));
    const lspViews: LspServerEntryView[] = lspServers.map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.hint,
      install: item.install,
      ...(item.command ? { command: item.command } : {}),
      ...(item.source ? { source: item.source } : {}),
      found: item.found,
      enabled: item.enabled,
      extensions: item.extensions,
    }));
    this.post({
      type: "snapshot",
      skills: skillViews,
      mcpServers,
      workspaceAvailable: this.deps.workspaceAvailable(),
      rules: ruleViews,
      lspServers: lspViews,
      memory: {
        enabled: this.deps.memoryEnabled(),
        directory: this.deps.memoryDirectory(),
      },
    });
  }

  async handle(message: ExtensionsWebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
      case "refresh":
        await this.publish();
        return;
      case "installSkillFromFolder":
        await this.installSkillFromFolder(message.scope);
        return;
      case "installSkillFromZip":
        await this.installSkillFromZip(message.scope);
        return;
      case "removeSkill":
        await this.deps.skills.remove(message.name, message.scope);
        await this.afterMutation("已删除技能。");
        return;
      case "setSkillEnabled":
        await this.deps.skills.setSkillEnabled(message.name, message.enabled);
        await this.afterMutation(message.enabled ? "已启用技能。" : "已禁用技能。");
        return;
      case "openSkillFolder":
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(message.directory),
        );
        return;
      case "upsertMcp":
        await this.deps.mcp.upsert(draftToUpsertInput(message.draft));
        await this.afterMutation("已保存 MCP 服务器。", true);
        return;
      case "setMcpEnabled":
        await this.deps.mcp.setEnabled(message.id, message.enabled);
        await this.afterMutation(
          message.enabled ? "已启用 MCP 服务器。" : "已禁用 MCP 服务器。",
          true,
        );
        return;
      case "removeMcp":
        await this.deps.mcp.remove(message.id);
        await this.afterMutation("已删除 MCP 服务器。", true);
        return;
      case "openRuleFile":
        await this.deps.openFile(message.path);
        return;
      case "createProjectAgents":
        await this.createProjectAgents();
        return;
      case "createRule":
        await this.createRule(message.scope, message.title);
        return;
      case "setLspEnabled":
        await this.setLspEnabled(message.id, message.enabled);
        return;
      case "setMemoryEnabled":
        await this.setMemoryEnabled(message.enabled);
        return;
      default:
        return;
    }
  }

  private async createProjectAgents(): Promise<void> {
    try {
      const file = await this.deps.rules.ensureProjectAgents();
      await this.publish();
      await this.deps.openFile(file);
      this.post({
        type: "notice",
        level: "info",
        message: "已准备好 AGENTS.md，保存后在新一轮对话生效。",
      });
    } catch (error) {
      this.post({ type: "error", message: errorText(error) });
    }
  }

  private async createRule(scope: "project" | "user", title: string): Promise<void> {
    try {
      const file = await this.deps.rules.createRule(scope, title);
      await this.publish();
      await this.deps.openFile(file);
      this.post({
        type: "notice",
        level: "info",
        message: scope === "project"
          ? "已在 .grok/rules 下新建规则，保存后在新一轮对话生效。"
          : "已在用户级 rules 下新建规则，对所有项目生效。",
      });
    } catch (error) {
      this.post({ type: "error", message: errorText(error) });
    }
  }

  private async setLspEnabled(id: string, enabled: boolean): Promise<void> {
    try {
      await this.deps.lsp.setEnabled(id, enabled);
      // lsp.json 与 config.toml 一起重写，Grok 只在会话建立时读一次。
      await this.afterMutation(
        enabled ? "已启用该语言服务，新一轮对话生效。" : "已停用该语言服务。",
      );
    } catch (error) {
      this.post({ type: "error", message: errorText(error) });
    }
  }

  private async setMemoryEnabled(enabled: boolean): Promise<void> {
    try {
      await this.deps.setMemoryEnabled(enabled);
      await this.afterMutation(
        enabled
          ? "已开启跨会话记忆：Grok 会把结论写到本机记忆目录，并在新会话首轮自动带回。"
          : "已关闭跨会话记忆：已写下的文件仍留在磁盘上，可自行删除。",
      );
    } catch (error) {
      this.post({ type: "error", message: errorText(error) });
    }
  }

  private async installSkillFromFolder(scope: "user" | "workspace"): Promise<void> {
    if (scope === "workspace" && !this.deps.workspaceAvailable()) {
      this.post({ type: "error", message: "当前没有活动仓库，无法安装到项目级。" });
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "安装此技能文件夹",
      title: "选择包含 SKILL.md 的文件夹",
    });
    const folder = picked?.[0]?.fsPath;
    if (!folder) return;
    try {
      const skill = await this.deps.skills.installFromFolder(folder, scope);
      await this.afterMutation(`已安装技能 ${skill.name}。`);
    } catch (error) {
      this.post({ type: "error", message: errorText(error) });
    }
  }

  private async installSkillFromZip(scope: "user" | "workspace"): Promise<void> {
    if (scope === "workspace" && !this.deps.workspaceAvailable()) {
      this.post({ type: "error", message: "当前没有活动仓库，无法安装到项目级。" });
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Zip: ["zip"] },
      openLabel: "安装此压缩包",
      title: "选择技能 zip",
    });
    const zip = picked?.[0]?.fsPath;
    if (!zip) return;
    try {
      const skill = await this.deps.skills.installFromZip(zip, scope);
      await this.afterMutation(`已安装技能 ${skill.name}。`);
    } catch (error) {
      this.post({ type: "error", message: errorText(error) });
    }
  }

  private async afterMutation(message: string, mcp = false): Promise<void> {
    try {
      await this.deps.onChanged();
    } catch (error) {
      this.deps.log(`[extensions] 变更收口失败：${errorText(error)}`);
    }
    await this.publish();
    this.post({ type: "notice", level: "info", message });
    if (mcp && this.deps.runtimeConnected()) {
      this.post({
        type: "notice",
        level: "info",
        message: "MCP 变更将在新一轮对话中生效。",
      });
    }
  }

  /** 供 ProviderService.writeConfig / buildEnv / redaction 使用。 */
  async skillsToml(): Promise<{ disabled: string[]; paths?: string[] }> {
    const disabled = await this.deps.skills.disabledNames();
    const paths = await this.deps.skills.skillConfigPaths();
    return {
      disabled,
      ...(paths.length > 0 ? { paths } : {}),
    };
  }

  async userMcpForConfig(): Promise<
    Array<{
      name: string;
      transport: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      headers?: Record<string, string>;
    }>
  > {
    const resolved = await this.deps.mcp.resolveEnabled();
    return resolved.map((item) => ({
      name: item.name,
      transport: item.transport,
      ...(item.command ? { command: item.command } : {}),
      ...(item.args ? { args: item.args } : {}),
      ...(item.url ? { url: item.url } : {}),
      ...(Object.keys(item.env).length > 0 ? { env: item.env } : {}),
      ...(Object.keys(item.headers).length > 0 ? { headers: item.headers } : {}),
    }));
  }

  async mcpCredentials(): Promise<{ name: string; value: string }[]> {
    const resolved = await this.deps.mcp.resolveEnabled();
    return resolved.flatMap((item) => item.credentials);
  }

  async mcpSecretLiterals(): Promise<string[]> {
    return this.deps.mcp.secretLiterals();
  }

  async capabilities(): Promise<{ skillsConfigured: boolean; mcpConfigured: boolean }> {
    const [skills, mcpConfigured] = await Promise.all([
      this.deps.skills.list(),
      this.deps.mcp.hasEnabledUserServer(),
    ]);
    return {
      skillsConfigured: skills.length > 0,
      mcpConfigured,
    };
  }
}
