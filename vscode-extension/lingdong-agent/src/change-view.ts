import type { AgentTurn, ChangeKind, ChangeStatus, ChangedFile, TurnStatus } from "./change-tracker";
import type { DiffText } from "./diff-text";
import type { LineDiffStat } from "./presentation/line-diff";

/**
 * 变更列表的展示模型。Webview 只拿到宿主生成的 changeId 与相对路径，
 * 不拿绝对路径，也不拿文件内容。
 */

export const CHANGE_LETTERS: Record<ChangeKind, string> = {
  create: "A",
  modify: "M",
  delete: "D",
  rename: "R",
};

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  create: "新建",
  modify: "修改",
  delete: "删除",
  rename: "重命名",
};

export const CHANGE_STATUS_LABELS: Record<ChangeStatus, string> = {
  pending: "待处理",
  accepted: "已接受",
  rejected: "已拒绝",
  conflict: "有冲突",
  restored: "已恢复",
};

export const TURN_STATUS_LABELS: Record<TurnStatus, string> = {
  running: "执行中",
  completed: "已完成",
  cancelled: "已停止",
  restored: "已全部恢复",
  partially_restored: "部分恢复",
};

/**
 * 右栏 Changes 面板的选中态（webview 本地，不持久化）：
 * 选中哪个文件、diff 是否在路上、拿到的内容或错误。
 */
export interface RailChangeState {
  selectedId: string;
  loading: boolean;
  diff?: DiffText;
  error?: string;
  /** Grok hunk-tracker 给出的逐 hunk 明细；缺失表示不支持或没拿到，退回整段 diff。 */
  hunks?: HunkView[];
}

/**
 * 单个 hunk 在面板上的投影（来自 Grok `_x.ai/hunk-tracker/get-hunks`）。
 * 行号信息用来画 @@ 头；oldText 为空串表示纯新增。
 */
export interface HunkView {
  id: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldText: string;
  newText: string;
  /** 外部（用户手动）改动的 hunk，UI 标注区分于 Agent 改动。 */
  external: boolean;
}

export interface ChangeRowView {
  changeId: string;
  relativePath: string;
  previousRelativePath?: string;
  kind: ChangeKind;
  letter: string;
  kindLabel: string;
  status: ChangeStatus;
  statusLabel: string;
  /** 没有修改前快照时只能查看，不能自动恢复。 */
  restorable: boolean;
  conflictReason?: string;
  /**
   * 这个文件本轮的行级增删。
   *
   * 来自编辑事件里的前后全文（file_diff），算不出来就不给——
   * 命令行改出来的文件没有这份数据，此时不显示总比显示一个猜的数字好。
   */
  lines?: LineDiffStat;
}

export interface ChangeListView {
  turnId: string;
  turnIndex: number;
  title: string;
  status: TurnStatus;
  statusLabel: string;
  rows: ChangeRowView[];
  pending: number;
  accepted: number;
  restored: number;
  conflicts: number;
  canAcceptAll: boolean;
  canRejectAll: boolean;
  canUndo: boolean;
  /** 本轮各文件行数的合计；一个文件都没有可靠数据时缺省。 */
  lines?: LineDiffStat;
}

/** 按轮次与工作区相对路径查这个文件的行级增删。 */
export type LineDiffLookup = (turnId: string, relativePath: string) => LineDiffStat | undefined;

function toRow(change: ChangedFile, lines?: LineDiffStat): ChangeRowView {
  return {
    ...(lines ? { lines } : {}),
    changeId: change.id,
    relativePath: change.relativePath,
    ...(change.previousRelativePath ? { previousRelativePath: change.previousRelativePath } : {}),
    kind: change.kind,
    letter: CHANGE_LETTERS[change.kind],
    kindLabel: CHANGE_KIND_LABELS[change.kind],
    status: change.status,
    statusLabel: CHANGE_STATUS_LABELS[change.status],
    restorable: change.restorable,
    ...(change.conflictReason ? { conflictReason: change.conflictReason } : {}),
  };
}

export function toChangeList(turn: AgentTurn, lineDiff?: LineDiffLookup): ChangeListView {
  const rows = turn.changedFiles.map(
    (change) => toRow(change, lineDiff?.(turn.turnId, change.relativePath)),
  );
  const count = (status: ChangeStatus): number => rows.filter((row) => row.status === status).length;
  const pending = count("pending");
  const conflicts = count("conflict");
  const total = sumLines(rows);
  return {
    ...(total ? { lines: total } : {}),
    turnId: turn.turnId,
    turnIndex: turn.index,
    title: `本轮修改了 ${rows.length} 个文件`,
    status: turn.status,
    statusLabel: TURN_STATUS_LABELS[turn.status],
    rows,
    pending,
    accepted: count("accepted"),
    restored: count("restored"),
    conflicts,
    canAcceptAll: pending > 0,
    canRejectAll: pending > 0,
    // 只要还有未接受、未恢复的文件就允许撤销；冲突文件由撤销流程再判一次哈希。
    canUndo: pending + conflicts > 0,
  };
}

/** 各文件行数的合计。一条都没有时返回 undefined，而不是 +0 -0。 */
function sumLines(rows: readonly ChangeRowView[]): LineDiffStat | undefined {
  let added = 0;
  let deleted = 0;
  let seen = false;
  for (const row of rows) {
    if (!row.lines) continue;
    seen = true;
    added += row.lines.added;
    deleted += row.lines.deleted;
  }
  return seen ? { added, deleted } : undefined;
}
