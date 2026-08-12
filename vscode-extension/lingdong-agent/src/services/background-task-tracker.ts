import type { AgentEvent, BackgroundTaskFrame } from "@lingdong/agent-runtime";
import { redact } from "../privacy/secret-redactor";

/**
 * 后台任务台账（background 的 shell 与 monitor）。
 *
 * 纯逻辑，不碰 vscode。和子 Agent 台账分开是因为两者的「结束」判定完全不同：
 * 子 Agent 的派发调用会一直开着直到它干完，而后台命令的派发调用立刻就返回 task_id，
 * 那次调用 completed 不代表任务结束——任务是否活着只能靠后续取输出才知道。
 *
 * 卡片先用 toolCallId 建立，拿到 task_id 后再挂上。解析不出 task_id 的卡片依然显示，
 * 只是不能终止（终止需要 id），UI 会把按钮禁掉并说明原因。
 */

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundTaskView {
  /** 卡片主键，取派发那次调用的 toolCallId：它在 task_id 到达之前就有了。 */
  id: string;
  /** Grok 侧的任务 id。缺失表示没能从返回里解析出来，此时无法终止。 */
  taskId?: string;
  command: string;
  kind: "command" | "monitor";
  status: BackgroundTaskStatus;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  /** 已收到的输出长度，用来在卡片上显示「N 行输出」。 */
  outputLines: number;
  /** 最近几行输出（已脱敏），运行中的卡片实时滚动显示。 */
  outputTail?: string;
}

/** 每个任务保留的输出上限。够看清最近发生了什么，又不至于把内存吃满。 */
const MAX_OUTPUT_CHARS = 200_000;
const MAX_TASKS = 20;
/** 卡片上实时尾巴的行数与字符上限。 */
const TAIL_LINES = 3;
const TAIL_CHARS = 360;

interface TaskRecord extends BackgroundTaskView {
  output: string;
}

export class BackgroundTaskTracker {
  private readonly tasks = new Map<string, TaskRecord>();
  /** task_id → 卡片主键。取输出与终止的帧只带 task_id。 */
  private readonly byTaskId = new Map<string, string>();

  /** @returns 台账是否变化，调用方据此决定要不要推 UI。 */
  handleEvent(event: AgentEvent, at = Date.now()): boolean {
    if (event.type === "background_task") return this.applyFrame(event.frame, at);
    // 派发那次调用自己的输出（启动回执、日志路径）也归到这张卡上。
    if (event.type === "command_output") return this.appendOutput(event.toolCallId, event.text);
    return false;
  }

  snapshot(): BackgroundTaskView[] {
    const all = [...this.tasks.values()].map(({ output: _output, ...view }) => view);
    const running = all.filter((task) => task.status === "running");
    const settled = all.filter((task) => task.status !== "running");
    return [...running, ...settled];
  }

  /** 「查看输出」用。返回 undefined 表示没有这张卡。 */
  output(id: string): string | undefined {
    return this.tasks.get(id)?.output;
  }

  find(id: string): BackgroundTaskView | undefined {
    const record = this.tasks.get(id);
    if (!record) return undefined;
    const { output: _output, ...view } = record;
    return view;
  }

  /** 还在跑的任务数，用于「N 个后台任务仍在运行」这类提示。 */
  get runningCount(): number {
    return [...this.tasks.values()].filter((task) => task.status === "running").length;
  }

  reset(): void {
    this.tasks.clear();
    this.byTaskId.clear();
  }

  /**
   * 用户点了终止但还没等到 Grok 的确认时，先把卡片标成已终止。
   * @returns 是否真的改了。
   */
  markKilled(id: string, at = Date.now()): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return false;
    task.status = "killed";
    task.endedAt = at;
    return true;
  }

  private applyFrame(frame: BackgroundTaskFrame, at: number): boolean {
    switch (frame.phase) {
      case "started": {
        if (this.tasks.has(frame.toolCallId)) return false;
        this.tasks.set(frame.toolCallId, {
          id: frame.toolCallId,
          command: frame.command,
          kind: frame.kind,
          status: "running",
          startedAt: at,
          outputLines: 0,
          output: "",
        });
        this.evictOldest();
        return true;
      }
      case "registered": {
        const task = this.tasks.get(frame.toolCallId);
        if (!task || task.taskId === frame.taskId) return false;
        task.taskId = frame.taskId;
        this.byTaskId.set(frame.taskId, task.id);
        return true;
      }
      case "output": {
        const id = this.byTaskId.get(frame.taskId);
        return id === undefined ? false : this.appendOutput(id, frame.text);
      }
      case "exited": {
        const task = this.resolveByTaskId(frame.taskId);
        if (!task || task.status !== "running") return false;
        task.status = frame.success ? "completed" : "failed";
        task.endedAt = at;
        if (frame.exitCode !== undefined) task.exitCode = frame.exitCode;
        return true;
      }
      case "killed": {
        const task = this.resolveByTaskId(frame.taskId);
        if (!task || task.status === "killed") return false;
        task.status = "killed";
        task.endedAt = at;
        return true;
      }
    }
  }

  private resolveByTaskId(taskId: string): TaskRecord | undefined {
    const id = this.byTaskId.get(taskId);
    return id === undefined ? undefined : this.tasks.get(id);
  }

  private appendOutput(id: string, text: string): boolean {
    const task = this.tasks.get(id);
    if (!task || !text) return false;
    const merged = `${task.output}${text}`;
    // 长输出只留尾部：后台任务的有用信息（报错、退出）都在末尾。
    task.output = merged.length > MAX_OUTPUT_CHARS
      ? merged.slice(merged.length - MAX_OUTPUT_CHARS)
      : merged;
    task.outputLines = countLines(task.output);
    task.outputTail = tailOf(task.output);
    return true;
  }

  private evictOldest(): void {
    while (this.tasks.size > MAX_TASKS) {
      const victim = [...this.tasks.values()].find((task) => task.status !== "running")
        ?? this.tasks.values().next().value;
      if (!victim) return;
      this.tasks.delete(victim.id);
      if (victim.taskId) this.byTaskId.delete(victim.taskId);
    }
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n").length;
  // 末尾换行不算多出一行。
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** 最近几行输出，脱敏后直接进卡片 UI。 */
function tailOf(output: string): string {
  const lines = output.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  const compact = redact(tail);
  if (compact.length <= TAIL_CHARS) return compact;
  return `…${compact.slice(compact.length - TAIL_CHARS)}`;
}
