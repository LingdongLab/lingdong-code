import {
  type TurnPresentationHeader,
  TURN_STATUS_LABEL,
} from "../../presentation/turn-presentation";
import { describeTurnSummary } from "../../presentation/turn-summary";
import { element } from "../dom-utils";
import { paintDuration } from "./duration-view";

/**
 * 时间线底部的一行结算：统计 · 耗时 · 终态。
 * 没有任何可靠统计时整行隐藏，宁可不显示也不编造数字。
 */

export interface SummaryNodes {
  root: HTMLElement;
  stats: HTMLElement;
  duration: HTMLElement;
  status: HTMLElement;
}

export function createSummaryNode(): SummaryNodes {
  const root = element("div", "tl-summary");
  const stats = element("span", "tl-summary-stats");
  const duration = element("span", "tl-summary-duration");
  const status = element("span", "tl-summary-status");
  root.append(stats, duration, status);
  return { root, stats, duration, status };
}

export function paintSummary(nodes: SummaryNodes, turn: TurnPresentationHeader): void {
  const parts = describeTurnSummary(turn.summary);
  nodes.stats.textContent = parts.join(" · ");
  nodes.stats.hidden = parts.length === 0;

  paintDuration(nodes.duration, {
    startedAt: turn.startedAt,
    ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt }),
    ...(turn.durationMs === undefined ? {} : { durationMs: turn.durationMs }),
    running: turn.status === "running",
  });

  const label = turn.retried ? `${TURN_STATUS_LABEL[turn.status]} · 已重试` : TURN_STATUS_LABEL[turn.status];
  nodes.status.textContent = label;
  nodes.status.className = `tl-summary-status tl-${turn.status}`;
  // 进行中不用重复说明状态，头部已经在转了。
  nodes.status.hidden = turn.status === "running";
}

/** 异常终态的一句解释；正常完成不加噪声。 */
export function statusHint(turn: TurnPresentationHeader): string | undefined {
  switch (turn.status) {
    case "failed":
      return "任务未能完成，展开分组可查看失败环节。";
    case "stopped":
      return "任务已按你的要求停止，已产生的修改仍保留在变更列表中。";
    case "interrupted":
      return "任务因扩展重启而中断。";
    default:
      return undefined;
  }
}
