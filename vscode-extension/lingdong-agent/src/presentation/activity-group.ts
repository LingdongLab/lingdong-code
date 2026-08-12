import { type ActivityAction, type ActivityItem, type ActivityStatus } from "./activity-item";

/**
 * 活动分组：同一轮里语义相同且相邻的活动合成一组。
 *
 * 分组只按语义相邻归并，不会为了减少卡片把 read → edit → read 压成两组。
 */

export type ActivityGroupKind =
  | "exploration"
  | "editing"
  | "command"
  | "verification"
  | "subagent"
  | "warning"
  | "failure";

export type ActivityGroupStatus = ActivityStatus;

export interface ActivityGroup {
  id: string;
  kind: ActivityGroupKind;
  title: string;
  /** 仅当存在已批准计划且当前步骤可明确映射时出现；永不替换主标题。 */
  subtitle?: string;
  status: ActivityGroupStatus;
  startedAt: number;
  completedAt?: number;
  items: ActivityItem[];
}

/** 组头：推送增量时不带 items，避免整组重绘。 */
export type ActivityGroupHeader = Omit<ActivityGroup, "items">;

/** 主标题固定，不允许模型自由生成。 */
export const GROUP_TITLE: Record<ActivityGroupKind, string> = {
  exploration: "探索代码库",
  editing: "修改代码",
  command: "执行命令",
  verification: "验证结果",
  subagent: "子 Agent",
  warning: "需要注意",
  failure: "任务失败",
};

const RUNNING_TITLE: Partial<Record<ActivityGroupKind, string>> = {
  exploration: "正在探索代码库",
  editing: "正在修改代码",
  command: "正在执行命令",
  verification: "正在验证结果",
  subagent: "正在等待子 Agent",
};

const ACTION_GROUP: Record<ActivityAction, ActivityGroupKind> = {
  list: "exploration",
  read: "exploration",
  search: "exploration",
  diagnostics: "exploration",
  edit: "editing",
  create: "editing",
  delete: "editing",
  rename: "editing",
  run: "command",
  test: "verification",
  typecheck: "verification",
  lint: "verification",
  build: "verification",
  subagent: "subagent",
};

export function groupKindForAction(action: ActivityAction): ActivityGroupKind {
  return ACTION_GROUP[action];
}

export function groupTitle(kind: ActivityGroupKind, status: ActivityGroupStatus): string {
  if (status === "running") return RUNNING_TITLE[kind] ?? GROUP_TITLE[kind];
  return GROUP_TITLE[kind];
}

export const GROUP_STATUS_LABEL: Record<ActivityGroupStatus, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** 从已有条目推导组状态：任一失败即失败，全部结束才算完成。 */
export function resolveGroupStatus(items: ActivityItem[]): ActivityGroupStatus {
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "running")) return "running";
  if (items.length > 0 && items.every((item) => item.status === "stopped")) return "stopped";
  return "completed";
}

export interface GroupStatsOptions {
  /** 运行中的组用它算「已运行 N 秒」。 */
  now?: number;
}

/**
 * 组摘要，例如「查看 5 个文件 · 搜索 2 次 · 8 秒」。
 * 全部来自真实条目，不做任何推测。
 */
export function describeGroup(group: ActivityGroup, options: GroupStatsOptions = {}): string[] {
  const parts: string[] = [];
  const readTargets = new Set<string>();
  let listCount = 0;
  let searchCount = 0;
  let diagnosticsCount = 0;
  const editTargets = new Set<string>();
  const createTargets = new Set<string>();
  const deleteTargets = new Set<string>();
  let commandCount = 0;
  let verificationCount = 0;
  let subagentCount = 0;

  for (const item of group.items) {
    switch (item.action) {
      case "read":
        readTargets.add(item.target ?? item.id);
        break;
      case "list":
        listCount += 1;
        break;
      case "search":
        searchCount += 1;
        break;
      case "diagnostics":
        diagnosticsCount += 1;
        break;
      case "edit":
      case "rename":
        editTargets.add(item.target ?? item.id);
        break;
      case "create":
        createTargets.add(item.target ?? item.id);
        break;
      case "delete":
        deleteTargets.add(item.target ?? item.id);
        break;
      case "run":
        commandCount += 1;
        break;
      case "subagent":
        subagentCount += 1;
        break;
      default:
        verificationCount += 1;
        break;
    }
  }

  if (readTargets.size > 0) parts.push(`查看 ${readTargets.size} 个文件`);
  if (listCount > 0) parts.push(`查看目录 ${listCount} 次`);
  if (searchCount > 0) parts.push(`搜索 ${searchCount} 次`);
  if (diagnosticsCount > 0) parts.push(`读取问题面板 ${diagnosticsCount} 次`);
  if (editTargets.size > 0) parts.push(`修改 ${editTargets.size} 个文件`);
  if (createTargets.size > 0) parts.push(`新建 ${createTargets.size} 个文件`);
  if (deleteTargets.size > 0) parts.push(`删除 ${deleteTargets.size} 个文件`);
  if (commandCount > 0) parts.push(`执行 ${commandCount} 条命令`);
  if (verificationCount > 0) parts.push(`运行 ${verificationCount} 项检查`);
  if (subagentCount > 0) parts.push(`派出 ${subagentCount} 个子 Agent`);
  return parts;
}
