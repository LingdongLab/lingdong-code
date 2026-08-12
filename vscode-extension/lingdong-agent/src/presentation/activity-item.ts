/**
 * 单条活动：一次工具调用在时间线上的投影。
 *
 * 一次工具调用会依次产生 started / output / completed 三类原始事件，
 * 它们必须合并到同一个 ActivityItem 上，由 toolCallId 唯一标识。
 */

import { describeLineDiff, type LineDiffStat } from "./line-diff";

export type ActivityAction =
  | "list"
  | "read"
  | "search"
  | "diagnostics"
  | "edit"
  | "create"
  | "delete"
  | "rename"
  | "run"
  | "test"
  | "typecheck"
  | "lint"
  | "build"
  | "subagent";

export type ActivityStatus = "running" | "completed" | "failed" | "stopped";

export interface ActivityItem {
  id: string;
  toolCallId: string;
  action: ActivityAction;
  target?: string;
  status: ActivityStatus;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  detail?: string;
  /**
   * 这次编辑的行级增删。只在 Grok 报来了前后全文、并且真算得出来时才有值——
   * 拿不到就不显示，绝不给一个看着精确其实是猜的数字。
   */
  lines?: LineDiffStat;
  /**
   * 运行中的命令最近几行输出（已脱敏）。只在 running 期间有值，收尾即清：
   * 它的意义是「现在跑到哪了」，命令结束后这份尾巴既不完整也没意义，
   * 失败详情另有 detail 承载。
   */
  outputTail?: string;
}

/** 面向用户的动词。原始工具名（Read / List Files / Run Command）不得出现在这里。 */
export const ACTION_VERB: Record<ActivityAction, string> = {
  list: "查看项目文件",
  read: "已读取",
  search: "已搜索",
  diagnostics: "已读取问题面板",
  edit: "已修改",
  create: "已创建",
  delete: "已删除",
  rename: "已重命名",
  run: "已执行",
  test: "已运行测试",
  typecheck: "已运行类型检查",
  lint: "已运行 Lint",
  build: "已构建",
  subagent: "子 Agent 已完成",
};

const RUNNING_VERB: Partial<Record<ActivityAction, string>> = {
  list: "正在查看项目文件",
  read: "正在读取",
  search: "正在搜索",
  diagnostics: "正在读取问题面板",
  edit: "正在修改",
  create: "正在创建",
  delete: "正在删除",
  rename: "正在重命名",
  run: "正在执行",
  test: "正在运行测试",
  typecheck: "正在运行类型检查",
  lint: "正在运行 Lint",
  build: "正在构建",
  subagent: "子 Agent 正在处理",
};

/** 展开详情里的单行文案，例如「已读取 src/auth/session.ts」。 */
export function describeActivityItem(item: ActivityItem): string {
  const verb = item.status === "running"
    ? RUNNING_VERB[item.action] ?? ACTION_VERB[item.action]
    : ACTION_VERB[item.action];
  const withTarget = item.target ? `${verb} ${item.target}` : verb;
  // 行数跟在路径后面：「已修改 src/app.ts +12 -3」，一眼看出这次动了多大。
  const stat = describeLineDiff(item.lines);
  const base = stat ? `${withTarget} ${stat}` : withTarget;
  if (item.status === "failed") {
    return item.exitCode === undefined ? `${base}（失败）` : `${base}（失败，退出码 ${item.exitCode}）`;
  }
  if (item.status === "stopped") return `${base}（已停止）`;
  return base;
}
