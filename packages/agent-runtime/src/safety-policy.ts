import { createHash } from "node:crypto";
import path from "node:path";
import { explainOperation, type OperationExplanation } from "./permission-explainer.js";
import { isRecord, type PermissionRequestParams } from "./protocol.js";
import {
  classifyCommand,
  classifyWriteTarget,
  isSensitivePath,
  worstRisk,
  type OperationKind,
  type RiskLevel,
} from "./risk-policy.js";
import type { PermissionSubject } from "./session-permissions.js";

export type ClientMode = "ask" | "plan" | "agent" | "auto";
export type SafetyAction = "allow" | "ask" | "deny";
export type SafetyOperation = "read" | "write" | "delete" | "execute";

/**
 * Agent 模式下的审批力度。
 * - balanced：工作区内的改动与常规工程命令自动放行，只对破坏性、装依赖与联网操作确认。
 * - strict：只放行 low，其余逐项确认（旧行为）。
 * - yolo：除 blocked 之外全部放行。
 */
export type ApprovalPolicy = "balanced" | "strict" | "yolo";

/**
 * balanced 力度下可自动放行的 medium 类操作。
 * 破坏性动作（删除、git reset/push、内联脚本、改环境变量）在 risk-policy 里已经是
 * high 或 blocked，不会走到这里；这份名单只决定「改文件、跑构建、提交代码」是否打断。
 */
const AUTO_APPROVED_MEDIUM_KINDS: ReadonlySet<OperationKind> = new Set([
  "write_file",
  "create_file",
  "rename_file",
  "modify_config",
  "run_command",
  "long_running_service",
  "git_write",
]);

export interface SafetyDecision {
  action: SafetyAction;
  operation: SafetyOperation;
  operationKind: OperationKind;
  /** 卡片标题，例如「修改文件 index.html」。 */
  label: string;
  /** 判定依据，始终由本地按真实操作算出，不采用模型的说法。 */
  reason: string;
  /** 判定依据 + 当前模式为什么要问，用于日志与自动放行/拒绝的通知。 */
  policyReason: string;
  /**
   * 给人看的操作说明：这条命令会做什么、有什么后果。
   * 同样只由本地静态推导，理由见 permission-explainer 的文件注释。
   */
  explanation: OperationExplanation;
  /**
   * 模型自己写的意图说明（工具参数里的 description）。
   *
   * 它来自被审批的一方，所以只能作为参考陈述展示、必须标明出处，
   * 绝不能拿去覆盖上面那些本地算出来的字段。
   */
  intent?: string;
  risk: RiskLevel;
  target?: string;
  targets: string[];
  command?: string;
  /** 命令的执行目录；工具没给就没有。 */
  cwd?: string;
  fingerprint: string;
  /** 供会话规则缓存匹配的规范化事实。 */
  subject: PermissionSubject;
}

const PATH_KEYS = new Set([
  "path", "file", "file_path", "filepath", "target", "target_file", "target_directory",
  "directory", "parent_dir", "parentdir", "cwd", "current_dir", "old_path", "new_path",
]);
const DELETE_PATTERN = /\b(delete|remove|unlink|rmdir|rm|del|erase)\b/i;
const EDIT_PATTERN = /\b(edit|write|create|replace|patch|move|rename|mkdir)\b/i;
const EXECUTE_PATTERN = /\b(?:shell|bash|powershell|command|execute|terminal)\b/i;
const EDIT_VARIANT = /^(?:SearchReplace|Write|Create|MultiEdit|Edit|Rename|Move|Mkdir)$/i;
const DELETE_VARIANT = /^(?:Delete|Remove)$/i;
const EXECUTE_VARIANT = /^(?:Bash|Shell|PowerShell|Command)$/i;
const READ_VARIANT = /^(?:Read|View|Glob|Grep|Search|List)$/i;

const OPERATION_LABEL: Record<SafetyOperation, string> = {
  read: "读取",
  write: "修改",
  delete: "删除",
  execute: "执行命令",
};

function collectPaths(value: unknown, key = "", output: string[] = []): string[] {
  if (typeof value === "string" && PATH_KEYS.has(key.toLowerCase())) output.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, key, output);
  } else if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) collectPaths(child, childKey, output);
  }
  return output;
}

interface ToolMeta {
  name: string;
  label?: string;
  kind?: string;
  readOnly?: boolean;
}

export function readToolMeta(toolCall: PermissionRequestParams["toolCall"]): ToolMeta {
  const meta = isRecord(toolCall._meta) ? toolCall._meta : {};
  const xai = isRecord(meta["x.ai/tool"]) ? meta["x.ai/tool"] : {};
  const name = [xai.name, toolCall.title, toolCall.kind]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  return {
    name,
    ...(typeof xai.label === "string" ? { label: xai.label } : {}),
    ...(typeof xai.kind === "string" ? { kind: xai.kind } : {}),
    ...(typeof xai.read_only === "boolean" ? { readOnly: xai.read_only } : {}),
  };
}

function rawInputRecord(params: PermissionRequestParams): Record<string, unknown> {
  return isRecord(params.toolCall.rawInput) ? params.toolCall.rawInput : {};
}

function commandText(params: PermissionRequestParams): string {
  const raw = params.toolCall.rawInput;
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return "";
  for (const key of ["command", "cmd", "script"]) {
    if (typeof raw[key] === "string") return raw[key];
  }
  return "";
}

export class WorkspaceSafetyPolicy {
  private readonly workspace: string;
  private readonly workspacePrefix: string;
  private approvalValue: ApprovalPolicy;

  constructor(workspace: string, approval: ApprovalPolicy = "balanced") {
    this.workspace = path.win32.resolve(workspace);
    this.workspacePrefix = `${this.workspace.toLowerCase()}\\`;
    this.approvalValue = approval;
  }

  get root(): string {
    return this.workspace;
  }

  get approval(): ApprovalPolicy {
    return this.approvalValue;
  }

  /** 设置项改动后即时生效，无需重连子进程。 */
  setApproval(approval: ApprovalPolicy): void {
    this.approvalValue = approval;
  }

  evaluate(mode: ClientMode, params: PermissionRequestParams): SafetyDecision {
    const meta = readToolMeta(params.toolCall);
    const raw = rawInputRecord(params);
    const variant = typeof raw.variant === "string" ? raw.variant : "";
    const command = commandText(params);
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const combined = `${meta.name} ${variant}`;

    const isDelete = DELETE_VARIANT.test(variant)
      || (!READ_VARIANT.test(variant) && DELETE_PATTERN.test(combined));
    const isExecute = !isDelete
      && (EXECUTE_VARIANT.test(variant) || meta.kind === "execute" || params.toolCall.kind === "execute"
        || EXECUTE_PATTERN.test(meta.name));
    const isEdit = !isDelete && !isExecute
      && (EDIT_VARIANT.test(variant) || meta.kind === "edit" || params.toolCall.kind === "edit"
        || (!READ_VARIANT.test(variant) && EDIT_PATTERN.test(meta.name)));
    const operation: SafetyOperation = isDelete ? "delete" : isExecute ? "execute" : isEdit ? "write" : "read";

    const rawPaths = [
      ...collectPaths(params.toolCall.rawInput),
      ...collectPaths(params.toolCall.locations),
    ];
    const targets = rawPaths.map((candidate) => this.resolveCandidate(candidate));
    const target = targets[0];
    const outside = targets.find((candidate) => !this.isInside(candidate));
    const sensitive = targets.find((candidate) => isSensitivePath(candidate));
    const insideWorkspace = outside === undefined;

    const { risk, operationKind, policyReason } = this.classify({
      operation, targets, command, outside, sensitive, readOnly: meta.readOnly,
    });

    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ operation, name: meta.name, command, paths: targets }))
      .digest("hex");
    const label = this.buildLabel(operation, meta, target, command);
    const subject: PermissionSubject = {
      operation,
      risk,
      workspace: this.workspace,
      targets,
      insideWorkspace,
      ...(command ? { command } : {}),
    };

    const action = this.decideAction(mode, operation, risk, operationKind);
    const modeReason = this.modeReason(mode, operation, risk, action);
    const cwd = typeof raw.cwd === "string" && raw.cwd.trim() !== ""
      ? this.resolveCandidate(raw.cwd)
      : undefined;

    return {
      action,
      operation,
      operationKind,
      label,
      // 这里刻意不再让 description 顶掉 policyReason。判定依据必须是本地算出来的：
      // 模型写的说明和它想执行的命令来自同一方，让它决定卡上那句话等于把审批依据
      // 交给被审批者。模型的说法改走 intent，在界面上单独标注出处。
      reason: policyReason,
      policyReason: modeReason ? `${policyReason}；${modeReason}` : policyReason,
      explanation: explainOperation({ operation, operationKind, risk, targets, command }),
      ...(description ? { intent: description } : {}),
      risk,
      ...(target ? { target } : {}),
      targets,
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      fingerprint,
      subject,
    };
  }

  isInside(candidate: string): boolean {
    const normalized = path.win32.resolve(candidate).toLowerCase();
    return normalized === this.workspace.toLowerCase() || normalized.startsWith(this.workspacePrefix);
  }

  private classify(input: {
    operation: SafetyOperation;
    targets: string[];
    command: string;
    outside: string | undefined;
    sensitive: string | undefined;
    readOnly: boolean | undefined;
  }): { risk: RiskLevel; operationKind: OperationKind; policyReason: string } {
    if (input.outside !== undefined) {
      return {
        risk: "blocked",
        operationKind: "access_outside_workspace",
        policyReason: `目标超出当前工作区：${input.outside}`,
      };
    }
    if (input.sensitive !== undefined) {
      return {
        risk: "blocked",
        operationKind: "read_credentials",
        policyReason: `目标属于敏感凭据或密钥位置：${input.sensitive}`,
      };
    }

    if (input.operation === "delete") {
      const hitsRoot = input.targets.some((candidate) => candidate.toLowerCase() === this.workspace.toLowerCase());
      return hitsRoot
        ? { risk: "blocked", operationKind: "delete_file", policyReason: "禁止删除工作区根目录" }
        : { risk: "high", operationKind: "delete_file", policyReason: "删除操作不可自动恢复" };
    }

    if (input.operation === "execute") {
      const verdict = classifyCommand(input.command);
      return { risk: verdict.risk, operationKind: verdict.kind, policyReason: verdict.reason };
    }

    if (input.operation === "write") {
      const verdict = classifyWriteTarget(input.targets);
      const risk = input.targets.length === 0 ? worstRisk(verdict.risk, "medium") : verdict.risk;
      const policyReason = input.targets.length === 0
        ? "未能确定写入目标，按较高风险处理"
        : verdict.reason;
      return { risk, operationKind: verdict.kind, policyReason };
    }

    // 只有工具自报只读、或参数里没有任何可疑写入迹象时才可能落到 low。
    if (input.readOnly === false) {
      return { risk: "high", operationKind: "unknown", policyReason: "工具声明会产生副作用，但无法归类，按高风险处理" };
    }
    return { risk: "low", operationKind: "read_file", policyReason: "工作区内只读访问" };
  }

  private decideAction(
    mode: ClientMode,
    operation: SafetyOperation,
    risk: RiskLevel,
    kind: OperationKind,
  ): SafetyAction {
    if (risk === "blocked") return "deny";

    if (mode === "ask") {
      if (operation === "write" || operation === "delete") return "deny";
      if (operation === "execute") return "ask";
      return "allow";
    }

    if (mode === "plan") {
      if (operation === "read") return "allow";
      return "deny";
    }

    if (mode === "agent") {
      // beforeWrite 快照 + Changes 面板保证每笔改动可撤销，所以放行的门槛可以比
      // 「只放 low」宽：真正不可逆的动作在 risk-policy 里已经是 high/blocked。
      if (this.approvalValue === "yolo") return "allow";
      if (risk === "low") return "allow";
      if (this.approvalValue === "strict") return "ask";
      if (risk === "high") return "ask";
      return AUTO_APPROVED_MEDIUM_KINDS.has(kind) ? "allow" : "ask";
    }

    // Auto：low 自动放行；工作区内文件变更即使是 medium 也放行；其余 medium 询问；high 硬拒绝。
    if (risk === "low") return "allow";
    if (risk === "high") return "deny";
    if (operation === "write") return "allow";
    return "ask";
  }

  private modeReason(mode: ClientMode, operation: SafetyOperation, risk: RiskLevel, action: SafetyAction): string {
    if (risk === "blocked") return "该操作被安全策略硬性禁止";
    if (mode === "ask" && action === "deny") return "Ask 模式只允许读取，不允许修改文件";
    if (mode === "plan" && action === "deny") return "Plan 模式只允许分析和生成计划";
    if (mode === "auto" && action === "deny") return "Auto 模式不自动执行高风险操作，请切换到 Agent 模式逐项确认";
    if (action === "ask") {
      if (mode === "auto") return "Auto 模式仅自动执行低风险操作，此项需要人工确认";
      if (mode === "agent" && this.approvalValue === "balanced") {
        return risk === "high"
          ? `${OPERATION_LABEL[operation]}不可自动撤销，需要人工确认`
          : `${OPERATION_LABEL[operation]}会装入依赖或访问网络，需要人工确认`;
      }
      return `${OPERATION_LABEL[operation]}需要人工确认`;
    }
    return "";
  }

  private buildLabel(operation: SafetyOperation, meta: ToolMeta, target: string | undefined, command: string): string {
    if (operation === "execute") {
      const text = command.trim().replace(/\s+/g, " ");
      return text ? `执行命令 ${text.slice(0, 120)}` : "执行命令";
    }
    const name = target ? path.win32.basename(target) : meta.label ?? meta.kind ?? "工作区内容";
    return `${OPERATION_LABEL[operation]}${target ? "文件 " : ""}${name}`;
  }

  private resolveCandidate(candidate: string): string {
    return path.win32.isAbsolute(candidate)
      ? path.win32.resolve(candidate)
      : path.win32.resolve(this.workspace, candidate);
  }
}
