import { normalizeStepTitle } from "./plan-step-sync";

/**
 * 从计划 Markdown 正文反推 Tasks/步骤清单。
 * UI WYSIWYG 只改 raw 时，必须用这份逻辑同步 steps，否则右侧 Tasks 会停在旧勾选。
 */

export interface PlanStepDraft {
  id?: string;
  title: string;
  description?: string;
  files: string[];
}

export interface PreviousPlanStep {
  id?: string;
  title: string;
  description?: string;
  files?: readonly string[];
}

const CHECKBOX_RE = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+(.+?)\s*$/;
const BULLET_RE = /^\s*(?:[-*+]|\d+\.)\s+(?!\[[ xX]\])(.+?)\s*$/;
const STEP_SECTION_RE = /(?:实施步骤|步骤清单|任务清单|待办|Todos?\b|Tasks?\b|下一步建议|结论与下一步|下一步)/i;

function stripMdDecor(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

function parseCheckboxItems(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = CHECKBOX_RE.exec(line);
    if (!match?.[2]) continue;
    const title = stripMdDecor(match[2]);
    if (title) out.push(title);
  }
  return out;
}

/** 从「实施步骤 / 下一步」这类章节里抽编号或项目符号列表。 */
function parseSectionListItems(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = stripMdDecor(heading[1] ?? "");
      // 进入匹配章节；离开时若已采到条目就结束（避免吃到后续无关章节）。
      if (STEP_SECTION_RE.test(name)) {
        inSection = true;
        continue;
      }
      if (inSection && out.length > 0) break;
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    if (!line.trim()) continue;
    const bullet = BULLET_RE.exec(line);
    if (!bullet?.[1]) {
      // 条目说明行（html→md 常把缩进说明拍扁成普通段落），跳过继续找下一条。
      continue;
    }
    const title = stripMdDecor(bullet[1]);
    if (title) out.push(title);
  }
  return out;
}

function titlesStillInRaw(raw: string, title: string): boolean {
  const needle = title.trim();
  if (!needle) return false;
  if (raw.includes(needle)) return true;
  // 标题被加粗/截断时，用归一化包含关系再判一次。
  const normRaw = normalizeStepTitle(raw);
  const normTitle = normalizeStepTitle(needle);
  return normTitle.length >= 4 && normRaw.includes(normTitle);
}

function toDrafts(
  titles: string[],
  previous: readonly PreviousPlanStep[],
): PlanStepDraft[] {
  const unused = [...previous];
  return titles.map((title) => {
    const key = normalizeStepTitle(title);
    const index = unused.findIndex((step) => normalizeStepTitle(step.title) === key);
    const matched = index >= 0 ? unused.splice(index, 1)[0] : undefined;
    return {
      ...(matched?.id ? { id: matched.id } : {}),
      title,
      ...(matched?.description?.trim() ? { description: matched.description } : {}),
      files: [...(matched?.files ?? [])],
    };
  });
}

/**
 * 用最新 Markdown 收敛步骤：
 * 1) 有 checkbox → 以勾选列表为准
 * 2) 否则有步骤/下一步章节列表 → 以该列表为准
 * 3) 否则保留正文里仍出现的旧步骤（删掉的章节对应任务会被清掉）
 */
export function reconcilePlanStepsFromMarkdown(
  raw: string,
  previous: readonly PreviousPlanStep[],
): PlanStepDraft[] {
  const text = raw.trim();
  if (!text) return [];

  const checkboxes = parseCheckboxItems(text);
  if (checkboxes.length > 0) return toDrafts(checkboxes, previous);

  const sectionItems = parseSectionListItems(text);
  if (sectionItems.length > 0) return toDrafts(sectionItems, previous);

  if (previous.length === 0) return [];
  return previous
    .filter((step) => titlesStillInRaw(text, step.title))
    .map((step) => ({
      ...(step.id ? { id: step.id } : {}),
      title: step.title,
      ...(step.description?.trim() ? { description: step.description } : {}),
      files: [...(step.files ?? [])],
    }));
}
