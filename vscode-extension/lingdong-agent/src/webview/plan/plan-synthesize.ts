import type { PlanDocumentViewModel } from "./plan-view-model";

/** 从结构化字段拼一份可编辑的 markdown，给没有 raw 的旧计划用。 */
export function synthesizePlanMarkdown(model: PlanDocumentViewModel): string {
  const lines: string[] = [`# ${model.title}`, ""];
  if (model.goal.trim()) {
    lines.push("## 目标", "", model.goal.trim(), "");
  }
  if (model.files.length > 0) {
    lines.push("## 涉及文件", "");
    for (const file of model.files) lines.push(`- \`${file}\``);
    lines.push("");
  }
  if (model.risks.length > 0) {
    lines.push("## 潜在风险", "");
    for (const risk of model.risks) lines.push(`- ${risk}`);
    lines.push("");
  }
  if (model.steps.length > 0) {
    lines.push("## 实施步骤", "");
    for (const [index, step] of model.steps.entries()) {
      lines.push(`${index + 1}. ${step.title}`);
      if (step.description.trim()) lines.push(`   ${step.description.trim()}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
