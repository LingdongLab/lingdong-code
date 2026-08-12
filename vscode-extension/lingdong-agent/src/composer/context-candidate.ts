/**
 * Composer 内联 @ 候选的纯数据层。
 *
 * 这里只做匹配、排序、分组与上限，不碰 VS Code API、不读文件、不解析路径。
 * 候选的 id 由宿主分配并保存映射，Webview 只回传 id 与来源类型，
 * 因此本层出现的 detail 只可能是工作区相对路径，绝不含绝对路径。
 */

export type CandidateSource =
  | "current-file"
  | "selection"
  | "problems"
  | "terminal"
  | "file"
  | "folder";

export const CANDIDATE_SOURCES: readonly CandidateSource[] = [
  "current-file", "selection", "problems", "terminal", "file", "folder",
];

export type CandidateGroupId = "quick" | "recent" | "workspace";

export interface ContextCandidate {
  /** 宿主下发的 opaque id；Webview 不得自行构造。 */
  id: string;
  source: CandidateSource;
  /** 主文案：文件名或「问题面板 (3)」。 */
  label: string;
  /** 辅助文案：工作区相对路径。 */
  detail?: string;
  group: CandidateGroupId;
  /** 有值表示当前不可选，并说明原因。 */
  disabledReason?: string;
  alreadyAdded?: boolean;
}

export interface CandidateGroup {
  id: CandidateGroupId;
  title: string;
  candidates: ContextCandidate[];
}

export interface SuggestionResult {
  groups: CandidateGroup[];
  /** 工作区结果被上限截断。 */
  truncated: boolean;
  /** 截断前的真实匹配数。 */
  matched: number;
}

/** 最近使用最多 5 项，工作区文件最多 20 项。 */
export const RECENT_LIMIT = 5;
export const WORKSPACE_LIMIT = 20;
/** @ 查询串的长度上限，超出即截断，避免宿主做无意义的大范围扫描。 */
export const SUGGEST_QUERY_MAX = 200;

export const GROUP_TITLE: Record<CandidateGroupId, string> = {
  quick: "快捷上下文",
  recent: "最近使用",
  workspace: "工作区文件",
};

export function truncationHint(shown: number): string {
  return `仅显示前 ${shown} 项，请继续输入以缩小范围。`;
}

function fileNameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 打分越小越靠前：文件名前缀 > 文件名子串 > 相对路径子串。
 * 返回 undefined 表示不匹配，不进候选。
 */
export function scoreCandidate(query: string, candidate: ContextCandidate): number | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 0;

  const path = (candidate.detail ?? "").toLowerCase();
  const label = candidate.label.toLowerCase();
  const name = path ? fileNameOf(path) : label;

  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  if (path.includes(needle)) return 2;
  // 快捷上下文没有路径，只能按标签匹配，例如「问题」命中「问题面板 (3)」。
  if (!path && label.includes(needle)) return 1;
  return undefined;
}

/** 稳定排序：先分数，再路径深度，最后字典序，保证同一查询结果可预期。 */
export function rankCandidates(query: string, candidates: readonly ContextCandidate[]): ContextCandidate[] {
  const scored: Array<{ candidate: ContextCandidate; score: number; order: number }> = [];
  candidates.forEach((candidate, order) => {
    const score = scoreCandidate(query, candidate);
    if (score === undefined) return;
    scored.push({ candidate, score, order });
  });

  scored.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    const leftPath = left.candidate.detail ?? "";
    const rightPath = right.candidate.detail ?? "";
    const byDepth = leftPath.split("/").length - rightPath.split("/").length;
    if (byDepth !== 0) return byDepth;
    if (leftPath !== rightPath) return leftPath.localeCompare(rightPath);
    return left.order - right.order;
  });

  return scored.map((entry) => entry.candidate);
}

export interface SuggestionInput {
  query: string;
  /** 快捷上下文按固定顺序传入；不可用项带 disabledReason，不要直接丢掉。 */
  quick: readonly ContextCandidate[];
  /** 最近使用，越靠前越新。 */
  recent: readonly ContextCandidate[];
  workspace: readonly ContextCandidate[];
}

/**
 * 组装三组候选。
 *
 * 同一路径只会出现在一组里：已在「最近使用」出现的文件不再进「工作区文件」，
 * 避免同一个文件在浮层里出现两次。
 */
export function buildSuggestions(input: SuggestionInput): SuggestionResult {
  const query = input.query.slice(0, SUGGEST_QUERY_MAX);

  // 快捷上下文顺序固定，不参与打分排序，只做过滤。
  const quick = input.quick.filter((candidate) => scoreCandidate(query, candidate) !== undefined);

  // 最近使用只过滤不重排：这一组的意义就是「最近」，按相关度打乱反而更难找。
  const recentRanked = input.recent.filter((candidate) => scoreCandidate(query, candidate) !== undefined);
  const recent = recentRanked.slice(0, RECENT_LIMIT);
  const recentPaths = new Set(recent.map((candidate) => candidate.detail).filter(Boolean));

  const workspaceRanked = rankCandidates(query, input.workspace)
    .filter((candidate) => !candidate.detail || !recentPaths.has(candidate.detail));
  const workspace = workspaceRanked.slice(0, WORKSPACE_LIMIT);

  const groups: CandidateGroup[] = [];
  if (quick.length > 0) groups.push({ id: "quick", title: GROUP_TITLE.quick, candidates: quick });
  if (recent.length > 0) groups.push({ id: "recent", title: GROUP_TITLE.recent, candidates: recent });
  if (workspace.length > 0) {
    groups.push({ id: "workspace", title: GROUP_TITLE.workspace, candidates: workspace });
  }

  return {
    groups,
    truncated: workspaceRanked.length > workspace.length,
    matched: workspaceRanked.length,
  };
}

/** 浮层里可以真正选中的候选，供键盘上下移动使用。 */
export function selectableCandidates(groups: readonly CandidateGroup[]): ContextCandidate[] {
  return groups.flatMap((group) => group.candidates.filter((candidate) => !candidate.disabledReason));
}

export interface MentionQuery {
  /** `@` 在输入串中的下标。 */
  start: number;
  /** `@` 之后到光标之间的文字。 */
  query: string;
}

/**
 * 识别光标前的 `@token`。
 *
 * `@` 必须位于串首或空白之后，token 内不含空白——否则用户正常写「邮箱 a@b.com」
 * 或换行后的正文都会误触发浮层。
 */
export function readMentionQuery(text: string, caret: number): MentionQuery | undefined {
  const end = Math.max(0, Math.min(caret, text.length));
  for (let index = end - 1; index >= 0; index -= 1) {
    const char = text[index] as string;
    if (/\s/.test(char)) return undefined;
    if (char !== "@") continue;
    const before = index === 0 ? "" : text[index - 1] as string;
    if (before !== "" && !/\s/.test(before)) return undefined;
    return { start: index, query: text.slice(index + 1, end) };
  }
  return undefined;
}
