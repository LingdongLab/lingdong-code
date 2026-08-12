import type { HostToWebviewMessage } from "../messages";

/**
 * 会话内搜索的纯数据层。
 *
 * v1 只覆盖对话流：用户消息、Agent 公开回复、提示行，以及任务时间线的
 * 分组标题与文件相对路径。
 *
 * 明确不进搜索源：隐藏工具输出（toolOutput）、旧版工具摘要的内部标签
 * （rawLabel）、ACP 原始帧、Output Channel 全文与模型私有推理。
 * 这些内容要么根本没进 Webview，要么在这里被显式跳过。
 */

export type SearchField = "user" | "assistant" | "notice" | "timeline";

/** 命中时间线时用来展开对应分组。 */
export interface TimelineAnchor {
  turnId: string;
  groupId?: string;
}

export interface SearchableRecord {
  /**
   * 所属渲染单元的下标，与 ConversationView 的 RenderUnit 顺序一致。
   * 命中尚未渲染的更早分页时，据此按需补渲染。
   */
  unitIndex: number;
  field: SearchField;
  text: string;
  anchor?: TimelineAnchor;
}

export interface SearchMatch {
  record: SearchableRecord;
  /** 命中在 record.text 中的位置，用于高亮。 */
  start: number;
  end: number;
}

export const FIELD_LABEL: Record<SearchField, string> = {
  user: "我的消息",
  assistant: "Agent 回复",
  notice: "提示",
  timeline: "任务时间线",
};

/** 一条记录里最多标出的命中数，避免超长文本产生上万个高亮节点。 */
const MATCHES_PER_RECORD = 50;

export type SearchableDraft = Omit<SearchableRecord, "unitIndex">;

/**
 * 从宿主消息里抽取可搜字段。
 * 未列出的消息类型一律返回空数组——新增消息默认不进搜索源。
 */
export function extractSearchable(message: HostToWebviewMessage): SearchableDraft[] {
  switch (message.type) {
    case "userMessage":
      return [{ field: "user", text: message.text }];
    case "notice":
      return [{ field: "notice", text: message.message }];
    case "error":
      return [{ field: "notice", text: message.message }];
    case "timelineRestore":
      return timelineDrafts(message.presentation);
    default:
      // toolOutput / toolStarted / activity 等隐藏或内部内容不进搜索源。
      return [];
  }
}

function timelineDrafts(
  presentation: Extract<HostToWebviewMessage, { type: "timelineRestore" }>["presentation"],
): SearchableDraft[] {
  const drafts: SearchableDraft[] = [];
  for (const group of presentation.groups) {
    const anchor: TimelineAnchor = { turnId: presentation.turnId, groupId: group.id };
    drafts.push({ field: "timeline", text: group.title, anchor });
    if (group.subtitle) drafts.push({ field: "timeline", text: group.subtitle, anchor });
    for (const item of group.items) {
      if (item.target) drafts.push({ field: "timeline", text: item.target, anchor });
    }
  }
  return drafts;
}

/** 大小写不敏感的顺序命中；查询串为空时返回空结果。 */
export function findMatches(
  records: readonly SearchableRecord[],
  query: string,
): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const matches: SearchMatch[] = [];
  for (const record of records) {
    const haystack = record.text.toLowerCase();
    let from = 0;
    let count = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      matches.push({ record, start: at, end: at + needle.length });
      from = at + needle.length;
      count += 1;
      if (count >= MATCHES_PER_RECORD) break;
    }
  }
  return matches;
}

/** 「3 / 12」形式的计数文案；无结果时给出明确提示。 */
export function describeProgress(current: number, total: number): string {
  if (total === 0) return "未找到匹配内容";
  return `${current + 1} / ${total}`;
}
