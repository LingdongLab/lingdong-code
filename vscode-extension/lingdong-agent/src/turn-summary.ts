/**
 * 轮次结果文案。stopReason 直接展示给用户会出现「完成：cancelled」这类
 * 既不中文也容易误解的脚注，所以统一在这里翻译，并按本轮实际产生的副作用补充说明。
 */

const STOP_REASON_LABELS: Record<string, string> = {
  end_turn: "已完成",
  cancelled: "已停止",
  canceled: "已停止",
  refusal: "模型拒绝了该请求",
  max_tokens: "已达到长度上限",
  max_turn_requests: "已达到单轮请求上限",
};

export function describeStopReason(stopReason: string): string {
  return STOP_REASON_LABELS[stopReason] ?? `已结束（${stopReason}）`;
}

export interface TurnOutcome {
  stopReason: string;
  /** 本轮已经落盘的工作区文件变更数量。 */
  changedFiles: number;
  /** 本轮是否有执行类权限被拒绝或超时。 */
  rejectedExecute: boolean;
}

export interface TurnNotice {
  level: "info" | "warn";
  message: string;
}

const CANCELLED = new Set(["cancelled", "canceled"]);

/**
 * 任务在文件已经改完之后被终止时，光说「已停止」会让人以为改动没生效。
 * 这里区分「验证命令被拒绝」与「一般中途停止」两种情况。
 */
export function turnOutcomeNotice(outcome: TurnOutcome): TurnNotice | undefined {
  if (!CANCELLED.has(outcome.stopReason)) return undefined;
  if (outcome.changedFiles <= 0) return undefined;
  if (outcome.rejectedExecute) {
    return { level: "warn", message: "代码修改已完成，但验证命令被拒绝，尚未完成最终验证。" };
  }
  return {
    level: "info",
    message: `任务在完成前被停止，本轮已经产生 ${outcome.changedFiles} 个文件修改，可在变更列表中查看或撤销。`,
  };
}
