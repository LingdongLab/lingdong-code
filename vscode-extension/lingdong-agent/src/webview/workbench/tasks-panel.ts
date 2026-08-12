import type { BackgroundTaskView } from "../../services/background-task-tracker";
import type { WebviewToHostMessage } from "../../messages";
import type { SubagentTaskView } from "../../services/subagent-tracker";
import type { PlanRecord } from "../../storage/plan-repository";
import { element, emptyPanel } from "../dom-utils";

/** 右侧 Tasks 工具：并行子 Agent + 计划步骤 / 执行期实时 todo，状态全来自真实事件。 */
const STEP_MARKS: Record<string, { mark: string; className: string }> = {
  completed: { mark: "✓", className: "done" },
  in_progress: { mark: "●", className: "run" },
  failed: { mark: "!", className: "fail" },
  skipped: { mark: "－", className: "" },
  cancelled: { mark: "－", className: "" },
  pending: { mark: "○", className: "" },
};

const SUBAGENT_MARKS: Record<SubagentTaskView["status"], { mark: string; className: string }> = {
  running: { mark: "●", className: "run" },
  completed: { mark: "✓", className: "done" },
  failed: { mark: "!", className: "fail" },
};

const BACKGROUND_MARKS: Record<BackgroundTaskView["status"], { mark: string; className: string }> = {
  running: { mark: "●", className: "run" },
  completed: { mark: "✓", className: "done" },
  failed: { mark: "!", className: "fail" },
  killed: { mark: "－", className: "" },
};

const BACKGROUND_STATUS_LABEL: Record<BackgroundTaskView["status"], string> = {
  running: "运行中",
  completed: "已结束",
  failed: "失败",
  killed: "已终止",
};

export interface TasksPanelModel {
  plan?: PlanRecord;
  /** 执行期直播 todo；优先于落盘 steps。 */
  liveSteps?: Array<{ title: string; status: string }>;
  /** 并行跑着的子 Agent；与计划步骤是两回事，各占一段。 */
  subagents?: SubagentTaskView[];
  /** 后台任务（background shell / monitor）。跨轮存活，所以是常驻卡。 */
  backgroundTasks?: BackgroundTaskView[];
}

function normalizeStatus(status: string | undefined): string {
  if (!status) return "pending";
  if (status in STEP_MARKS) return status;
  return "pending";
}

function elapsedText(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 子 Agent 卡片：一行标题 + 一行元信息，完成后追加汇总。
 * 汇总放在 details 里，因为它常有好几百字，平铺会把面板挤爆。
 */
function renderSubagent(task: SubagentTaskView, now: number): HTMLElement {
  const shape = SUBAGENT_MARKS[task.status];
  const card = element("div", `subagent-card ${shape.className}`);

  const head = element("div", "subagent-head");
  head.appendChild(element("span", `task-mark ${shape.className}`, shape.mark));
  head.appendChild(element("span", "subagent-title", task.description));
  card.appendChild(head);

  const meta: string[] = [];
  if (task.subagentType) meta.push(task.subagentType);
  meta.push(task.background ? "后台" : "阻塞等待");
  meta.push(elapsedText(task.startedAt, task.endedAt ?? now));
  card.appendChild(element("div", "subagent-meta", meta.join(" · ")));

  if (task.summary) {
    const details = element("details", "subagent-summary");
    details.appendChild(element("summary", undefined, "查看汇总"));
    details.appendChild(element("div", "subagent-summary-body", task.summary));
    card.appendChild(details);
  }
  return card;
}

/**
 * 后台任务卡：标题是命令原文，底下一行元信息，再底下两个动作。
 *
 * 「终止」在解析不出 task_id 时禁用并给出原因——那种情况下宿主也没法终止它，
 * 与其点了没反应，不如把话说清楚。
 */
function renderBackgroundTask(
  task: BackgroundTaskView,
  now: number,
  post: (message: WebviewToHostMessage) => void,
): HTMLElement {
  const shape = BACKGROUND_MARKS[task.status];
  const card = element("div", `subagent-card ${shape.className}`);

  const head = element("div", "subagent-head");
  head.appendChild(element("span", `task-mark ${shape.className}`, shape.mark));
  head.appendChild(element("span", "subagent-title", task.command));
  card.appendChild(head);

  const meta: string[] = [task.kind === "monitor" ? "monitor" : "后台命令"];
  meta.push(BACKGROUND_STATUS_LABEL[task.status]);
  if (task.exitCode !== undefined) meta.push(`退出码 ${task.exitCode}`);
  meta.push(elapsedText(task.startedAt, task.endedAt ?? now));
  if (task.outputLines > 0) meta.push(`${task.outputLines} 行输出`);
  card.appendChild(element("div", "subagent-meta", meta.join(" · ")));

  // 还在跑的任务把最近几行输出直接铺在卡片上，不用点「查看输出」才知道进展。
  if (task.status === "running" && task.outputTail) {
    card.appendChild(element("pre", "task-output-tail", task.outputTail));
  }

  const actions = element("div", "task-actions");
  const view = element("button", "btn-link", "查看输出");
  view.disabled = task.outputLines === 0;
  if (view.disabled) view.title = "这个任务还没有产生可见输出。";
  view.addEventListener("click", () => post({ type: "showBackgroundTaskOutput", taskId: task.id }));
  actions.appendChild(view);

  if (task.status === "running") {
    const kill = element("button", "btn-link danger", "终止");
    kill.disabled = !task.taskId;
    if (kill.disabled) kill.title = "没能从 Grok 的返回里解析出任务 id，无法直接终止。";
    kill.addEventListener("click", () => post({ type: "killBackgroundTask", taskId: task.id }));
    actions.appendChild(kill);
  }
  card.appendChild(actions);
  return card;
}

export function renderTasksPanel(
  panel: HTMLElement,
  model: TasksPanelModel,
  post: (message: WebviewToHostMessage) => void = () => undefined,
  now = Date.now(),
): void {
  panel.replaceChildren();
  panel.appendChild(element("div", "panel-title", "Tasks"));

  const subagents = model.subagents ?? [];
  const background = model.backgroundTasks ?? [];
  const rows = model.liveSteps && model.liveSteps.length > 0
    ? model.liveSteps.map((step) => ({ title: step.title, status: normalizeStatus(step.status) }))
    : (model.plan?.steps ?? []).map((step) => ({
      title: step.title,
      status: normalizeStatus(step.status),
    }));

  if (rows.length === 0 && subagents.length === 0 && background.length === 0) {
    panel.appendChild(emptyPanel(
      "暂无任务",
      model.plan
        ? "在计划正文里用任务列表（- [ ]）或「实施步骤 / 下一步」章节维护任务，保存后会出现在这里。"
        : "生成或打开计划后，任务清单会出现在这里；Agent 派出子 Agent 或起后台任务时也会在这里并排显示。",
    ));
    return;
  }

  if (subagents.length > 0) {
    const running = subagents.filter((task) => task.status === "running").length;
    panel.appendChild(element(
      "div",
      "panel-section",
      running > 0 ? `子 Agent（${running} 个进行中）` : `子 Agent（${subagents.length}）`,
    ));
    for (const task of subagents) panel.appendChild(renderSubagent(task, now));
  }

  if (background.length > 0) {
    const running = background.filter((task) => task.status === "running").length;
    panel.appendChild(element(
      "div",
      "panel-section",
      running > 0 ? `后台任务（${running} 个运行中）` : `后台任务（${background.length}）`,
    ));
    for (const task of background) panel.appendChild(renderBackgroundTask(task, now, post));
  }

  const hasCards = subagents.length > 0 || background.length > 0;
  if (rows.length === 0) return;
  if (hasCards) panel.appendChild(element("div", "panel-section", "步骤"));

  for (const step of rows) {
    const shape = STEP_MARKS[step.status] ?? STEP_MARKS.pending!;
    const row = element("div", "task-row");
    row.appendChild(element("span", `task-mark ${shape.className}`, shape.mark));
    row.appendChild(element("span", undefined, step.title));
    panel.appendChild(row);
  }
}
