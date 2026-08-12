import type { ActivityGroup } from "./activity-group";
import type { TurnSummary } from "./turn-summary";

/**
 * 一轮任务的完整呈现模型。
 * 纯数据：不依赖 DOM、Webview 与 VS Code API，宿主与 Webview 共用同一份类型。
 */

export type TurnStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface TurnPresentation {
  sessionId: string;
  turnId: string;
  status: TurnStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  groups: ActivityGroup[];
  summary?: TurnSummary;
  /** 用户点重试后给旧时间线打的标记。 */
  retried?: boolean;
}

/** 推送轮次状态时不带 groups，组和条目各自增量推送。 */
export type TurnPresentationHeader = Omit<TurnPresentation, "groups">;

export const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "已中断",
};

/** 这些终态不再计时，也不再订阅实时更新。 */
export function isTerminalStatus(status: TurnStatus): boolean {
  return status !== "running";
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
}

/** 运行中说「已运行」，结束后说「耗时」。 */
export function describeElapsed(input: {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  running: boolean;
  now?: number;
}): string {
  const elapsed = input.durationMs
    ?? (input.completedAt !== undefined
      ? input.completedAt - input.startedAt
      : (input.now ?? Date.now()) - input.startedAt);
  return input.running ? `已运行 ${formatDuration(elapsed)}` : `耗时 ${formatDuration(elapsed)}`;
}
