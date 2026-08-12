import { parseGrokInspect, type GrokInspectReport, type NamedEntry } from "./grok-inspect";

/**
 * Agent 诊断报告：把「Grok 实际发现了什么」与「我们实际注入了什么」并排放在一页里。
 *
 * 这两半必须一起看才有意义。规则不生效通常是两种原因之一：Grok 没看见那个文件
 * （左半边为空），或者我们压根没注入（右半边为空）。分开看永远只能猜。
 */

export interface DiagnosticsInput {
  /** `grok inspect --json` 的原始输出；执行失败时传 undefined 并给出 inspectError。 */
  inspectJson?: string;
  inspectError?: string;
  /** 我们通过 `_meta.rules` 注入系统提示的文本。 */
  injectedRules: string;
  workspaceRoot?: string;
  grokExecutable?: string;
  grokHome?: string;
}

function fence(text: string): string[] {
  return ["```text", ...text.split("\n"), "```"];
}

function namesOf(entries: readonly NamedEntry[]): string {
  if (entries.length === 0) return "（无）";
  return entries
    .map((entry) => (entry.source ? `${entry.name}（${entry.source}）` : entry.name))
    .join("、");
}

function renderInstructions(report: GrokInspectReport, lines: string[]): void {
  lines.push("## Grok 加载到的项目规则");
  lines.push("");
  if (report.projectInstructions.length === 0) {
    lines.push("Grok 在当前目录**没有**发现任何项目规则文件。");
    lines.push("");
    lines.push("可用的放置位置：工作区根目录的 `AGENTS.md`，或 `.grok/rules/*.md`。");
    lines.push("Grok 也原生读取 Cursor 的规则目录，从 Cursor 迁过来的规则可直接复用。");
    lines.push("");
    return;
  }

  const totalTokens = report.projectInstructions.reduce((sum, item) => sum + item.approxTokens, 0);
  lines.push(`共 ${report.projectInstructions.length} 个文件，合计约 ${totalTokens} tokens。`);
  lines.push("");
  lines.push("| 文件 | 类型 | 范围 | 字节 | 约 tokens |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const item of report.projectInstructions) {
    lines.push(`| \`${item.path}\` | ${item.fileType} | ${item.scope} | ${item.sizeBytes} | ${item.approxTokens} |`);
  }
  lines.push("");
  // 规则和真正的代码上下文抢同一份预算，超了要让用户看得见。
  if (totalTokens > 4_000) {
    lines.push(`> 规则已占用约 ${totalTokens} tokens，会挤压代码上下文预算，建议精简。`);
    lines.push("");
  }
}

export function renderAgentDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = ["# 灵动 Code Agent 诊断", ""];

  lines.push("## 运行环境");
  lines.push("");
  lines.push(`- 工作区：${input.workspaceRoot ? `\`${input.workspaceRoot}\`` : "（未打开工作区）"}`);
  lines.push(`- Grok 可执行文件：${input.grokExecutable ? `\`${input.grokExecutable}\`` : "（未解析）"}`);
  lines.push(`- GROK_HOME：${input.grokHome ? `\`${input.grokHome}\`` : "（继承环境变量）"}`);
  lines.push("");

  if (!input.inspectJson) {
    lines.push("## Grok 配置发现");
    lines.push("");
    lines.push(`执行 \`grok inspect --json\` 失败：${input.inspectError ?? "未知原因"}`);
    lines.push("");
  } else {
    let report: GrokInspectReport | undefined;
    try {
      report = parseGrokInspect(input.inspectJson);
    } catch (error) {
      lines.push("## Grok 配置发现");
      lines.push("");
      lines.push(`解析 \`grok inspect --json\` 输出失败：${error instanceof Error ? error.message : String(error)}`);
      lines.push("");
    }

    if (report) {
      lines.push("## Grok 版本与信任状态");
      lines.push("");
      lines.push(`- 版本：${report.grokVersion ?? "未知"}${report.channel ? `（${report.channel}）` : ""}`);
      lines.push(`- 目录已信任：${report.projectTrusted === true ? "是" : "否"}`);
      lines.push(`- 配置层：${report.configLayers.length === 0
        ? "（无，全部走内置默认值）"
        : report.configLayers.map((layer) => `${layer.role} → \`${layer.path}\``).join("；")}`);
      lines.push("");

      renderInstructions(report, lines);

      lines.push("## 已加载的能力");
      lines.push("");
      lines.push(`- Agents：${namesOf(report.agents)}`);
      lines.push(`- Skills：${namesOf(report.skills)}`);
      lines.push(`- Hooks：${namesOf(report.hooks)}`);
      lines.push(`- MCP 服务：${namesOf(report.mcpServers)}`);
      lines.push(`- LSP 服务：${namesOf(report.lspServers)}`);
      lines.push(`- 插件：${namesOf(report.plugins)}`);
      lines.push(`- 权限规则：已加载 ${report.permissionsLoaded} 条`);
      lines.push("");

      const cursorSurfaces = report.externalCompat
        .filter((cell) => cell.vendor === "cursor")
        .map((cell) => cell.surface);
      if (cursorSurfaces.length > 0) {
        lines.push(`> Grok 原生兼容读取 Cursor 的 ${cursorSurfaces.join(" / ")}，这些配置无需迁移。`);
        lines.push("");
      }
    }
  }

  lines.push("## 灵动注入的行为规则");
  lines.push("");
  if (!input.injectedRules) {
    lines.push("本次会话**没有**注入任何行为规则。");
    lines.push("");
    lines.push("正常情况下应当注入：禁止整文件重写、先读后改、改完自测、中文回复。");
    lines.push("这一段为空说明注入链路断了——最典型的原因是会话由更早的连接创建。");
  } else {
    lines.push(`以下文本已作为 \`<human_rules>\` 追加到系统提示末尾（约 ${input.injectedRules.length} 字）：`);
    lines.push("");
    lines.push(...fence(input.injectedRules));
  }
  lines.push("");

  return `${lines.join("\n").trimEnd()}\n`;
}
