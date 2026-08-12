/**
 * Plan 模式研究引导：优先宿主只读能力，禁止默认用终端列目录。
 * 不修改 Runtime；在 Extension 组装提示词时注入。
 *
 * Agent 模式另有正文去重引导（见 AGENT_REPLY_GUIDANCE）：工具过程已在 Timeline，
 * 回复不必复述。前端不对模型正文做过滤。
 */

/** Agent 模式：避免正文复述 Timeline 已展示的工具过程。 */
export const AGENT_REPLY_GUIDANCE = [
  "【回复风格】",
  "工具调用过程（读了哪些文件、搜索了几次、执行了哪些命令）已在界面时间线中展示给用户。",
  "回复无需复述这些过程，直接给出发现、结论和下一步。",
  "若用户明确询问过程细节，再按问法简要说明即可。",
].join("\n");

/** 组装 Agent 模式提示：引导 + 用户任务（不改模型已输出的正文）。 */
export function buildAgentReplyPrompt(userText: string): string {
  return [AGENT_REPLY_GUIDANCE, "", "【用户任务】", userText.trim()].join("\n");
}

export const FORBIDDEN_PLAN_SHELL_PATTERNS: RegExp[] = [
  /\bGet-ChildItem\b/i,
  /^\s*dir\b/i,
  /^\s*ls\b/i,
  /\bGet-ChildItem\b/i,
];

export const PLAN_RESEARCH_GUIDANCE = [
  "【Plan 模式研究约束】",
  "你当前处于 Plan 模式：只允许分析代码并生成结构化实施计划，禁止修改/删除/创建业务文件，禁止执行构建或测试。",
  "研究项目时优先使用只读文件工具（Read / Glob / Grep / List files）。",
  "禁止为了列目录而执行终端命令：Get-ChildItem、dir、ls。除非用户明确要求并已获权限确认。",
  "不要把文件列表或终端输出写成实施步骤；步骤必须是可执行的改造动作。",
  "路径请使用工作区相对路径（如 src/auth/session.ts），不要输出绝对盘符路径。",
  "完成研究后，输出清晰的实施计划（目标、步骤、涉及文件、风险），等待用户确认后再开始构建。",
].join("\n");

export function isForbiddenPlanShellCommand(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  return FORBIDDEN_PLAN_SHELL_PATTERNS.some((pattern) => pattern.test(text));
}

/** 组装 Plan 模式提示：引导 + 可选工作区概览 + 用户任务。 */
export function buildPlanResearchPrompt(userText: string, workspaceOverview?: string): string {
  const parts = [PLAN_RESEARCH_GUIDANCE, ""];
  if (workspaceOverview?.trim()) {
    parts.push("【工作区文件概览（宿主安全列出，相对路径）】", workspaceOverview.trim(), "");
  }
  parts.push("【用户任务】", userText.trim());
  return parts.join("\n");
}

export function formatWorkspaceOverview(
  files: ReadonlyArray<{ relativePath: string }>,
  limit = 80,
): string {
  if (files.length === 0) return "（当前仓库暂无匹配文件，或还没有选仓库）";
  const lines = files.slice(0, limit).map((f) => `- ${f.relativePath.replace(/\\/g, "/")}`);
  if (files.length > limit) lines.push(`- …共 ${files.length} 个文件，已截断`);
  return lines.join("\n");
}
