import type { AgentEvent } from "@lingdong/agent-runtime";

/**
 * 子 Agent 任务台账。
 *
 * 纯逻辑，不碰 vscode，也不自己推消息——由 TurnService 在事件侧调用，
 * 变了才推 UI。Tasks 面板要的「并行卡片」就是这里的列表。
 *
 * 为什么不塞进 TimelineService：时间线是按轮次收尾的流水账，
 * 而 background 的子 Agent 会跨轮活着，两者生命周期不一样。
 */

export type SubagentStatus = "running" | "completed" | "failed";

export interface SubagentTaskView {
  id: string;
  description: string;
  subagentType?: string;
  /** background 的子 Agent 不阻塞父 Agent，会跨轮继续跑。 */
  background: boolean;
  status: SubagentStatus;
  /** 子 Agent 交回的汇总，完成后才有。 */
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

/** 同时展示的任务卡上限；再多就只留最近的，免得面板被刷成流水账。 */
const MAX_TASKS = 30;

/** 卡片上汇总的长度上限。完整内容仍在时间线的工具输出里。 */
const MAX_SUMMARY_CHARS = 4_000;

export class SubagentTracker {
  private readonly tasks = new Map<string, SubagentTaskView>();

  /** @returns 列表是否发生了变化，调用方据此决定要不要推 UI。 */
  handleEvent(event: AgentEvent, at = Date.now()): boolean {
    if (event.type === "subagent_started") return this.start(event, at);
    if (event.type === "subagent_completed") return this.complete(event, at);
    if (event.type === "subagent_output") return this.appendOutput(event, at);
    return false;
  }

  /** 按启动顺序返回；运行中的排在前面，方便一眼看到还在跑什么。 */
  snapshot(): SubagentTaskView[] {
    const all = [...this.tasks.values()];
    const running = all.filter((task) => task.status === "running");
    const settled = all.filter((task) => task.status !== "running");
    return [...running, ...settled];
  }

  /**
   * 正挡着父 Agent 的那个子 Agent。background 的不算，它不阻塞。
   *
   * `exceptId` 存在是因为宿主的状态机先于本台账更新：处理 subagent_completed 时，
   * 台账里那一条还标着 running，必须显式排掉它才能判断「是否还要继续等」。
   */
  blockingTask(exceptId?: string): SubagentTaskView | undefined {
    return [...this.tasks.values()].find(
      (task) => task.status === "running" && !task.background && task.id !== exceptId,
    );
  }

  /** 会话切换 / 清空历史。轮次结束不该清——background 子 Agent 还活着。 */
  reset(): void {
    this.tasks.clear();
  }

  /**
   * 轮次收尾时给还在转圈的任务定性。
   *
   * 默认放过 background 的那些：它们本来就跨轮活着，父 Agent 收尾不代表它们结束，
   * 之后模型还会用 get_command_or_subagent_output 去取结果。
   * 只有被用户停掉或连接断了（CLI 进程带着子 Agent 一起没了）才连它们一起结算。
   *
   * @returns 是否有任务被改写。
   */
  settleRunning(
    status: Exclude<SubagentStatus, "running">,
    options: { includeBackground?: boolean; at?: number } = {},
  ): boolean {
    const at = options.at ?? Date.now();
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      if (task.background && !options.includeBackground) continue;
      task.status = status;
      task.endedAt = at;
      changed = true;
    }
    return changed;
  }

  private start(
    event: Extract<AgentEvent, { type: "subagent_started" }>,
    at: number,
  ): boolean {
    const existing = this.tasks.get(event.toolCallId);
    if (existing) {
      // 参数流阶段先建的卡只有 description；正式 tool_call 到达时补全其余字段。
      const changed = existing.description !== event.description
        || existing.background !== event.background
        || existing.subagentType !== event.subagentType;
      if (!changed) return false;
      existing.description = event.description;
      existing.background = event.background;
      if (event.subagentType === undefined) delete existing.subagentType;
      else existing.subagentType = event.subagentType;
      return true;
    }

    this.tasks.set(event.toolCallId, {
      id: event.toolCallId,
      description: event.description,
      ...(event.subagentType ? { subagentType: event.subagentType } : {}),
      background: event.background,
      status: "running",
      startedAt: at,
    });
    this.evictOldest();
    return true;
  }

  /**
   * 后台子 Agent 交回的报告。
   *
   * 取到结果就意味着它跑完了——模型只会在任务结束后才拿得到完整输出，
   * 所以这里顺手把状态从 running 落到 completed，卡片不会一直转圈。
   */
  private appendOutput(
    event: Extract<AgentEvent, { type: "subagent_output" }>,
    at: number,
  ): boolean {
    const task = this.tasks.get(event.toolCallId);
    const text = event.text.trim();
    if (!task || !text) return false;
    const merged = task.summary ? `${task.summary}\n${text}` : text;
    task.summary = merged.length > MAX_SUMMARY_CHARS
      ? `${merged.slice(0, MAX_SUMMARY_CHARS)}…`
      : merged;
    if (task.status === "running") {
      task.status = "completed";
      task.endedAt = at;
    }
    return true;
  }

  private complete(
    event: Extract<AgentEvent, { type: "subagent_completed" }>,
    at: number,
  ): boolean {
    const task = this.tasks.get(event.toolCallId);
    if (!task) return false;
    task.status = event.success ? "completed" : "failed";
    task.endedAt = at;
    if (event.summary) task.summary = event.summary;
    return true;
  }

  private evictOldest(): void {
    while (this.tasks.size > MAX_TASKS) {
      // Map 保持插入序，删掉最早那条即可；运行中的优先保留。
      const victim = [...this.tasks.values()].find((task) => task.status !== "running")
        ?? this.tasks.values().next().value;
      if (!victim) return;
      this.tasks.delete(victim.id);
    }
  }
}
