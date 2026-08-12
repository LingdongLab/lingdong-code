import type { UiToolKind } from "../messages";
import { productizeToolLabel } from "./message-renderer";

/** 工具事件聚合：按 toolCallId + action + relativePath 识别；不同文件不因 3 秒去重消失。 */

export const TOOL_VERB: Record<string, string> = {
  read: "已读取",
  edit: "已修改",
  execute: "已执行命令",
  search: "已搜索",
  plan: "已规划",
  other: "已处理",
  create: "已创建",
  delete: "已删除",
  list: "查看项目文件",
  ask: "需要确认",
};

export interface ToolEventInput {
  toolCallId: string;
  kind: UiToolKind;
  label: string;
  target?: string;
  readOnly: boolean;
  at: number;
  turnId?: string;
  sessionId?: string;
}

export interface ToolGroupItem {
  toolCallId: string;
  kind: UiToolKind;
  verb: string;
  detail: string;
  /** 产品化短句，不含内部工具名 */
  productDetail: string;
  /** 原始标签，仅展开详情 */
  rawLabel: string;
  relativePath?: string;
  status: "running" | "completed" | "failed";
  identity: string;
}

export interface ToolGroupView {
  id: string;
  title: string;
  status: "running" | "completed" | "failed";
  items: ToolGroupItem[];
  startedAt: number;
  endedAt?: number;
}

const DEDUPE_MS = 3_000;

function relativePathOf(target?: string): string | undefined {
  if (!target?.trim()) return undefined;
  const t = target.trim().replace(/\\/g, "/");
  // 去掉盘符与绝对前缀，仅展示相对感路径；完整内部路径进 raw
  const stripped = t.replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "");
  const parts = stripped.split("/");
  if (parts.length > 4) return parts.slice(-3).join("/");
  return stripped;
}

function actionKey(kind: UiToolKind, label: string): string {
  const product = productizeToolLabel(label, kind);
  if (product.title === "查看项目文件") return "list";
  if (product.title === "需要确认") return "ask";
  if (product.title === "已创建") return "create";
  if (product.title === "已删除") return "delete";
  if (product.title === "已执行命令") return "execute";
  if (product.title === "已搜索") return "search";
  if (product.title === "已修改") return "edit";
  if (product.title === "已读取") return "read";
  return kind;
}

function identityOf(input: ToolEventInput): string {
  const action = actionKey(input.kind, input.label);
  const path = relativePathOf(input.target) ?? "";
  return [input.sessionId ?? "", input.turnId ?? "", input.toolCallId, action, path].join("|");
}

function verbFor(kind: UiToolKind, label: string, target?: string): string {
  const product = productizeToolLabel(label, kind);
  if (product.title === "已创建" || (/新建|create/i.test(target ?? "") && kind === "edit")) {
    return TOOL_VERB.create ?? "已创建";
  }
  if (product.title === "已删除" || (/删除|delete/i.test(target ?? "") && kind === "edit")) {
    return TOOL_VERB.delete ?? "已删除";
  }
  if (product.title === "查看项目文件") return TOOL_VERB.list ?? "查看项目文件";
  if (product.title === "需要确认") return TOOL_VERB.ask ?? "需要确认";
  if (product.title === "已执行命令") return TOOL_VERB.execute ?? "已执行命令";
  if (product.title.startsWith("已") || product.title.startsWith("查看") || product.title.startsWith("需要")) {
    return product.title;
  }
  return TOOL_VERB[kind] ?? TOOL_VERB.other ?? "已处理";
}

export class ToolTurnAggregator {
  private groups: ToolGroupView[] = [];
  private activeId: string | undefined;
  private readonly byTool = new Map<string, { groupId: string; itemIndex: number }>();
  private readonly seenIdentity = new Map<string, number>();

  reset(): void {
    this.groups = [];
    this.activeId = undefined;
    this.byTool.clear();
    this.seenIdentity.clear();
  }

  list(): ToolGroupView[] {
    return this.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item })),
    }));
  }

  start(input: ToolEventInput): { group: ToolGroupView; item: ToolGroupItem; deduped: boolean } {
    const identity = identityOf(input);
    const path = relativePathOf(input.target);
    const product = productizeToolLabel(input.label, input.kind);
    const verb = verbFor(input.kind, input.label, input.target);
    const productDetail = path ? `${verb} ${path}` : verb;
    const detail = path ? `${verb} ${path}` : `${verb} ${product.title}`;

    // 仅当 identity 完全相同（含 path）且 3 秒内才去重；不同文件永不互相去重
    const lastAt = this.seenIdentity.get(identity);
    const deduped = lastAt !== undefined && input.at - lastAt < DEDUPE_MS;
    if (!deduped) this.seenIdentity.set(identity, input.at);

    let group = this.activeId ? this.groups.find((g) => g.id === this.activeId) : undefined;
    if (!group || group.status !== "running") {
      group = {
        id: `tg-${input.toolCallId}`,
        title: product.title === "已读取" || product.title === "已搜索" || product.title === "查看项目文件"
          ? "分析项目结构"
          : product.title,
        status: "running",
        items: [],
        startedAt: input.at,
      };
      // 若有更具体的非工具协议标题，优先用产品化后的人类标题
      if (!/^(read|write|edit|search|list|run|tool)/i.test(input.label) && input.label.trim().length > 1) {
        const human = input.label.replace(/[_-]+/g, " ").trim();
        if (!/^(read file|list files|run command)$/i.test(human)) {
          // 仍避免直接暴露协议名
          if (!/^[a-z]+(?:_[a-z]+)+$/i.test(input.label)) group.title = human.slice(0, 40);
        }
      }
      this.groups.push(group);
      this.activeId = group.id;
    }

    const item: ToolGroupItem = {
      toolCallId: input.toolCallId,
      kind: input.kind,
      verb,
      detail,
      productDetail,
      rawLabel: product.raw,
      ...(path ? { relativePath: path } : {}),
      status: "running",
      identity,
    };

    if (!deduped) {
      group.items.push(item);
      this.byTool.set(input.toolCallId, { groupId: group.id, itemIndex: group.items.length - 1 });
    } else {
      this.byTool.set(input.toolCallId, { groupId: group.id, itemIndex: Math.max(0, group.items.length - 1) });
    }
    return { group, item, deduped };
  }

  status(
    toolCallId: string,
    status: "running" | "completed" | "failed",
    at = Date.now(),
  ): ToolGroupView | undefined {
    const ref = this.byTool.get(toolCallId);
    if (!ref) return undefined;
    const group = this.groups.find((g) => g.id === ref.groupId);
    if (!group) return undefined;
    const item = group.items[ref.itemIndex];
    if (item && item.toolCallId === toolCallId) item.status = status;

    if (status === "failed") {
      group.status = "failed";
      group.endedAt = at;
      if (this.activeId === group.id) this.activeId = undefined;
      return group;
    }

    const stillRunning = group.items.some((entry) => entry.status === "running");
    if (!stillRunning) {
      group.status = group.items.some((entry) => entry.status === "failed") ? "failed" : "completed";
      group.endedAt = at;
      if (this.activeId === group.id) this.activeId = undefined;
    }
    return group;
  }

  summaryLines(group: ToolGroupView): string[] {
    const counts = new Map<string, number>();
    for (const item of group.items) {
      counts.set(item.verb, (counts.get(item.verb) ?? 0) + 1);
    }
    const lines: string[] = [];
    for (const [verb, count] of counts) {
      if (verb === TOOL_VERB.search || verb === "已搜索") lines.push(`${verb} ${count} 个引用`);
      else if (verb === TOOL_VERB.execute || verb === "已执行命令") lines.push(`${verb} ${count} 条`);
      else if (verb === TOOL_VERB.list || verb === "查看项目文件") lines.push(`${verb} ${count} 次`);
      else lines.push(`${verb} ${count} 个文件`);
    }
    const elapsed = Math.max(1, Math.round(((group.endedAt ?? Date.now()) - group.startedAt) / 1000));
    if (group.status === "running") lines.push(`进行中 ${elapsed} 秒`);
    else lines.push(`耗时 ${elapsed} 秒`);
    return lines;
  }

  statusLabel(status: ToolGroupView["status"]): string {
    if (status === "running") return "进行中";
    if (status === "failed") return "未成功";
    return "已完成";
  }
}
