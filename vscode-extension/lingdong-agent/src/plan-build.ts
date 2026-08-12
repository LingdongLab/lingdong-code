import type { PlanRecord } from "./storage/plan-repository";

/** 把结构化计划编译成 Agent 模式可执行的明确任务提示，不复用旧 requestId。 */
export function compilePlanBuildPrompt(plan: PlanRecord, options: { resume?: boolean } = {}): string {
  const steps = plan.steps
    .filter((step) => step.status !== "cancelled" && step.status !== "skipped")
    .map((step, index) => {
      const files = step.files.length > 0 ? `（文件：${step.files.join("、")}）` : "";
      const detail = step.description ? `\n   ${step.description}` : "";
      return `${index + 1}. [${step.status}] ${step.title}${files}${detail}`;
    })
    .join("\n");

  const files = plan.files.length > 0 ? plan.files.join("、") : "（无）";
  const risks = plan.risks.length > 0 ? plan.risks.map((risk) => `- ${risk}`).join("\n") : "- （无）";
  const clarifications = (plan.clarifications ?? [])
    .filter((item) => item.answer)
    .map((item) => `Q: ${item.question}\nA: ${item.answer}`)
    .join("\n\n");

  const header = options.resume
    ? "继续执行以下已批准计划。跳过已完成步骤，从尚未完成的步骤继续；不要重新开始已完成工作。"
    : "请严格按以下已批准计划开始构建。逐步完成，修改仅限计划范围内的文件；完成后对照步骤汇报结果。";

  return [
    header,
    "",
    `# ${plan.title}`,
    plan.goal ? `目标：${plan.goal}` : undefined,
    "",
    "## 步骤",
    steps || "（无步骤）",
    "",
    `## 涉及文件\n${files}`,
    "",
    `## 风险\n${risks}`,
    clarifications ? `\n## 澄清结论\n${clarifications}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function planHasExecutableContent(plan: PlanRecord): boolean {
  return plan.title.trim() !== "" && plan.steps.some((step) => step.title.trim() !== "");
}
