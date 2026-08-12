/**
 * 一轮任务范围内的共享可变状态。
 * TurnService 负责推进它，PlanFacade 与控制器按引用读取，避免把这些标志层层透传。
 */

export type DebugPhase =
  | "collect"
  | "propose"
  | "await_confirm"
  | "fixing"
  | "verify"
  | "idle";

export interface QueuedPrompt {
  id: string;
  text: string;
}

export interface TurnState {
  /** 是否存在一份等待用户审批的计划。 */
  pendingPlan: boolean;
  /** Ask / Debug 模式拦截后暂存的提示词。 */
  pendingPrompt: string | undefined;
  /** Runtime 报告的本轮结束原因。 */
  stopReason: string | undefined;
  debugPhase: DebugPhase;
  /** 忙时排队的待发送消息；轮次正常结束后自动出队（用户取消不续发）。 */
  sendQueue: QueuedPrompt[];
}

export function createTurnState(): TurnState {
  return {
    pendingPlan: false,
    pendingPrompt: undefined,
    stopReason: undefined,
    debugPhase: "idle",
    sendQueue: [],
  };
}
