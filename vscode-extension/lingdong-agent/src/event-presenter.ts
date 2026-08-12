import type { AgentEvent } from "@lingdong/agent-runtime";
import type { HostToWebviewMessage } from "./messages";
import { toPlanCard } from "./plan-view-model";

// 省略号统一用单个「…」，与 TURN_STATUS_LABEL 一致：状态栏与思考块的文案会紧挨着出现，
// 一边一个点数会显得像两套东西。
const DEFAULT_THOUGHT = "正在分析项目结构…";
const THOUGHT_RULES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  { pattern: /(查找|搜索|定位|search|grep|glob)/i, message: "正在查找相关文件…" },
  { pattern: /(读取|阅读|打开文件|read file|文件内容)/i, message: "正在阅读文件内容…" },
  { pattern: /(实施计划|制定计划|规划步骤|拟定方案)/, message: "正在制定实施计划…" },
  { pattern: /(修改结果|改动是否|检查修改|复核改动|verify the change)/i, message: "正在检查修改结果…" },
  { pattern: /(检查|核对|验证|现有实现|check|verify)/i, message: "正在检查现有实现…" },
  { pattern: /(计划|方案|步骤|plan)/i, message: "正在整理实施思路…" },
  { pattern: /(总结|归纳|回答|summar)/i, message: "正在整理回答…" },
];

/** 模式切换与会话元信息属于过程细节，只进日志；对话区仅由模式选择器显示最终模式。 */
const LOG_ONLY_STATUS = /^(?:客户端安全模式|Grok 模式已切换|会话：)/;

/** 内部调试 / ACP / 路径 / JSON 噪声不得进入产品对话区。 */
const LOG_ONLY_CHAT_NOISE = /(?:ses-[a-f0-9]{8,}|sessionId|ACP\b|Grok\s*Build|\\Users\\|\\AppData\\|JSON\.parse|Unexpected token|E:\\|\/home\/|tool_started|tool_completed)/i;

export function statusTarget(message: string): "chat" | "log" {
  const text = message.trim();
  if (LOG_ONLY_STATUS.test(text) || LOG_ONLY_CHAT_NOISE.test(text)) return "log";
  return "chat";
}

function thoughtStatus(text: string): string {
  for (const rule of THOUGHT_RULES) {
    if (rule.pattern.test(text)) return rule.message;
  }
  return DEFAULT_THOUGHT;
}

/**
 * 把标准化后的 AgentEvent 转成面板消息。
 *
 * 推理原文（thought_delta）会以 reasoningDelta 送给面板，折叠在思考块里供用户
 * 自己展开——这是对标 Cursor 的可展开推理链。同时仍然产出固定的状态文案当标题。
 * 边界没有放宽的地方：原文不落盘、不进时间线、不进转录，宿主侧还有开关可以整体关掉。
 *
 * 需要人工决策的事件（权限请求、计划审批）由 AgentController 处理，这里不产出卡片。
 */
export class EventPresenter {
  private lastActivity: string | undefined;

  reset(): void {
    this.lastActivity = undefined;
  }

  present(event: AgentEvent): HostToWebviewMessage[] {
    switch (event.type) {
      case "text_delta":
        this.lastActivity = undefined;
        return [{ type: "assistantDelta", text: event.text }];

      case "thought_delta":
        // 两条一起出：固定文案当折叠标题（一眼知道在干什么），原文进展开区。
        // 原文只走内存到界面这一条路，不落盘——见 turn-service 的 persistHostMessage。
        return [
          ...this.activity(thoughtStatus(event.text)),
          { type: "reasoningDelta", text: event.text },
        ];

      case "status":
        return statusTarget(event.message) === "log"
          ? []
          : [{ type: "notice", level: "info", message: event.message }];

      // 工具事件统一由 TimelineService 转成任务时间线，这里不再产出第二套工具记录。
      case "tool_started":
      case "tool_progress":
      case "tool_completed":
      case "command_output":
      case "file_changed":
      // 子 Agent 与后台任务由右侧 Tasks 面板的常驻卡片呈现，对话流里再刷一遍只是噪音。
      case "subagent_started":
      case "subagent_completed":
      case "subagent_output":
      case "background_task":
      // 编辑前后全文只服务编辑器里的实时 diff 预览，全文进对话流会把聊天区淹掉。
      case "file_diff":
        return [];

      case "permission_resolved": {
        const rejected = event.resolution === "reject" || event.resolution === "expired" || event.resolution === "cancelled";
        // 自动放行不进对话流：工具本身已在任务时间线里，逐条通知只会刷屏。
        // 自动拒绝必须可见，否则操作静默失败会让人摸不着头脑。
        if (event.automatic && !rejected) return [];
        const prefix = event.automatic
          ? event.rule ? "已根据本会话规则自动允许" : "安全策略已拒绝"
          : rejected ? "已拒绝" : "已允许";
        return [{
          type: "notice",
          level: rejected ? "warn" : "info",
          message: `${prefix}：${event.reason}`,
        }];
      }

      case "plan_updated":
        return [{ type: "plan", plan: toPlanCard(event.plan, "executing") }];

      case "error":
        return [{ type: "error", message: event.message, recoverable: true }];

      case "completed":
        this.lastActivity = undefined;
        return [{
          type: "assistantEnd",
          stopReason: event.stopReason,
          ...(event.modelId ? { modelId: event.modelId } : {}),
        }];

      // 由 AgentController 负责队列、状态机与卡片，这里不重复呈现。
      // disconnected 同理：作废 Runtime 与重连提示都在 Controller，避免重复报错行。
      // 提问（question_*）由 QuestionFacade 出卡片与回执。
      case "permission_requested":
      case "plan_review_requested":
      case "plan_review_closed":
      case "question_requested":
      case "question_resolved":
      case "mode_changed":
      case "token_usage":
      case "context_compacted":
      case "disconnected":
        return [];
    }
  }

  private activity(message: string): HostToWebviewMessage[] {
    if (message === this.lastActivity) return [];
    this.lastActivity = message;
    return [{ type: "activity", message }];
  }
}
