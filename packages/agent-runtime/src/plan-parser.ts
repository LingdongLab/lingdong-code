import { redactText } from "./logger.js";

/** 与 Grok todo 条目的状态一一对应；审批计划（Markdown 解析）里没有状态。 */
export type AgentPlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface AgentPlanStep {
  index: number;
  title: string;
  detail?: string;
  files: string[];
  /** 仅实时 todo 更新携带；有它 UI 才能逐项勾选。 */
  status?: AgentPlanStepStatus;
}

export interface AgentPlan {
  title: string;
  steps: AgentPlanStep[];
  files: string[];
  risks: string[];
  /** 已脱敏的原始 Markdown，解析失败时供 UI 兜底展示。 */
  raw: string;
  empty: boolean;
}

const MAX_STEPS = 100;
const MAX_FILES = 200;
const MAX_RISKS = 50;
const MAX_DETAIL_LENGTH = 2_000;
const RISK_SECTION = /(风险|注意|备注|注意事项|Risk|Risks|Caveat|Caveats|Warning)/i;
const HEADING = /^(#{1,6})\s+(.*)$/;
const NUMBERED_ITEM = /^\s{0,3}(\d{1,3})[.、)]\s+(.+)$/;
const BULLET_ITEM = /^\s{0,3}[-*+]\s+(.+)$/;
const BACKTICK_TOKEN = /`([^`\n]{1,200})`/g;
const FILE_TOKEN = /^[^\s`"'<>|]+$/;

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

function looksLikeFile(token: string): boolean {
  if (!FILE_TOKEN.test(token)) return false;
  if (token.length > 200) return false;
  if (/[\\/]/.test(token)) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(token);
}

function collectFiles(text: string, into: string[]): void {
  for (const match of text.matchAll(BACKTICK_TOKEN)) {
    const token = (match[1] ?? "").trim().replace(/[),.;:]+$/, "");
    if (!looksLikeFile(token)) continue;
    if (into.length >= MAX_FILES) return;
    if (!into.includes(token)) into.push(token);
  }
}

interface Block {
  title: string;
  /** 未去掉反引号的原始标题，用于提取文件名。 */
  rawTitle: string;
  lines: string[];
}

/**
 * 解析 `_x.ai/exit_plan_mode` 的中文 Markdown 计划。
 * 优先使用 `###` 子节作为步骤；没有子节时退回编号列表项。
 * 解析失败保留脱敏后的 raw，steps 与 raw 同时为空才置 empty。
 */
export function parsePlan(raw: string): AgentPlan {
  const safeRaw = redactText(typeof raw === "string" ? raw : "");
  const lines = safeRaw.split(/\r?\n/);

  let title = "";
  let sectionTitle = "";
  let inRiskSection = false;
  const risks: string[] = [];
  const files: string[] = [];
  const subBlocks: Block[] = [];
  const numberedBlocks: Block[] = [];
  let current: Block | undefined;
  let currentIsSub = false;

  const pushLine = (line: string): void => {
    if (current && current.lines.length < 200) current.lines.push(line);
  };

  for (const line of lines) {
    collectFiles(line, files);
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const text = stripInlineMarkdown(heading[2] ?? "");
      if (level === 1 && title === "") {
        title = text;
        current = undefined;
        currentIsSub = false;
        continue;
      }
      if (level <= 2) {
        sectionTitle = text;
        inRiskSection = RISK_SECTION.test(text);
        current = undefined;
        currentIsSub = false;
        continue;
      }
      // level >= 3：子节即步骤
      if (inRiskSection) {
        current = undefined;
        currentIsSub = false;
        continue;
      }
      current = {
        title: text.replace(/^\d{1,3}[.、)]\s*/, ""),
        rawTitle: heading[2] ?? "",
        lines: [],
      };
      currentIsSub = true;
      if (subBlocks.length < MAX_STEPS) subBlocks.push(current);
      continue;
    }

    if (inRiskSection) {
      const bullet = BULLET_ITEM.exec(line) ?? NUMBERED_ITEM.exec(line);
      const text = bullet ? stripInlineMarkdown(bullet[bullet.length - 1] ?? "") : "";
      if (text && risks.length < MAX_RISKS && !risks.includes(text)) risks.push(text);
      continue;
    }

    const numbered = NUMBERED_ITEM.exec(line);
    if (numbered && !currentIsSub) {
      current = { title: stripInlineMarkdown(numbered[2] ?? ""), rawTitle: numbered[2] ?? "", lines: [] };
      if (numberedBlocks.length < MAX_STEPS) numberedBlocks.push(current);
      continue;
    }

    pushLine(line);
  }

  if (title === "") {
    title = lines.map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 120)
      ?? (sectionTitle || "实施计划");
    title = stripInlineMarkdown(title.replace(/^#+\s*/, ""));
  }

  const blocks = subBlocks.length > 0 ? subBlocks : numberedBlocks;
  const steps: AgentPlanStep[] = blocks.map((block, position) => {
    const detail = block.lines.join("\n").trim().slice(0, MAX_DETAIL_LENGTH);
    const stepFiles: string[] = [];
    collectFiles(block.rawTitle, stepFiles);
    collectFiles(detail, stepFiles);
    return {
      index: position + 1,
      title: block.title.slice(0, 300),
      ...(detail ? { detail } : {}),
      files: stepFiles,
    };
  }).filter((step) => step.title.length > 0);

  return {
    title: title.slice(0, 300),
    steps,
    files,
    risks,
    raw: safeRaw,
    empty: steps.length === 0 && safeRaw.trim() === "",
  };
}
