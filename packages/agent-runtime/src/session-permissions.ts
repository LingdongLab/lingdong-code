import path from "node:path";
import { isAtLeast, splitCommandSegments, type RiskLevel } from "./risk-policy.js";

export type SessionRuleKind = "workspace-write" | "command-prefix" | "read-path";

/** session 规则随连接消失；always 规则由宿主落盘，跨会话与重启生效。 */
export type SessionRuleScope = "session" | "always";

export interface SessionRule {
  kind: SessionRuleKind;
  /** 范围值：工作区根、命令前缀或目录路径。 */
  value: string;
  /** 中文说明，直接用于 UI 提示。 */
  label: string;
  /** 省略等同 session，保持旧数据可读。 */
  scope?: SessionRuleScope;
}

/**
 * 持久化规则存储。由宿主实现（需要磁盘访问），Runtime 只按接口读写，
 * 这样 agent-runtime 依然不依赖 VS Code 或文件布局。
 */
export interface DurablePermissionRules {
  list(): readonly SessionRule[];
  add(rule: SessionRule): void;
}

/** 权限判定所需的规范化事实，由 safety-policy 产出，避免缓存直接依赖 ACP 报文结构。 */
export interface PermissionSubject {
  operation: "read" | "write" | "delete" | "execute";
  risk: RiskLevel;
  workspace: string;
  /** 已解析为绝对路径的操作目标。 */
  targets: string[];
  command?: string;
  insideWorkspace: boolean;
}

const MAX_RULES = 64;

function normalize(candidate: string): string {
  return path.win32.resolve(candidate).toLowerCase();
}

function isWithin(parent: string, child: string): boolean {
  const root = normalize(parent);
  const target = normalize(child);
  return target === root || target.startsWith(`${root}\\`);
}

/** 命令前缀取第一段的前两个非选项 token，例如 `npm test`、`git status`。 */
export function commandPrefix(command: string): string | undefined {
  const first = splitCommandSegments(command)[0];
  if (!first) return undefined;
  const tokens = first
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith("-"));
  if (tokens.length === 0) return undefined;
  return tokens.slice(0, 2).join(" ").toLowerCase();
}

/**
 * 由一次「本次会话允许」或「以后都允许」决定推导范围规则。
 * high 与 blocked 永不缓存；无法归纳范围时返回 undefined，调用方应退化为仅本次允许。
 */
export function deriveSessionRule(
  subject: PermissionSubject,
  scope: SessionRuleScope = "session",
): SessionRule | undefined {
  if (isAtLeast(subject.risk, "high")) return undefined;
  if (!subject.insideWorkspace) return undefined;
  const prefixText = scope === "always" ? "以后都允许" : "本次会话允许";

  if (subject.operation === "execute") {
    const command = subject.command ?? "";
    if (splitCommandSegments(command).length > 1) return undefined;
    const prefix = commandPrefix(command);
    if (!prefix) return undefined;
    return {
      kind: "command-prefix",
      value: prefix,
      label: `${prefixText}执行 ${prefix} 开头的命令`,
      scope,
    };
  }

  if (subject.operation === "write") {
    return {
      kind: "workspace-write",
      value: path.win32.resolve(subject.workspace),
      label: `${prefixText}在当前工作区内修改文件`,
      scope,
    };
  }

  if (subject.operation === "read") {
    const first = subject.targets[0];
    const directory = first ? path.win32.dirname(path.win32.resolve(first)) : path.win32.resolve(subject.workspace);
    return {
      kind: "read-path",
      value: directory,
      label: `${prefixText}读取 ${directory} 目录`,
      scope,
    };
  }

  return undefined;
}

function ruleMatches(rule: SessionRule, subject: PermissionSubject): boolean {
  if (rule.kind === "workspace-write" && subject.operation === "write") {
    const targets = subject.targets;
    return targets.length > 0 && targets.every((target) => isWithin(rule.value, target));
  }
  if (rule.kind === "command-prefix" && subject.operation === "execute") {
    const command = subject.command ?? "";
    if (splitCommandSegments(command).length > 1) return false;
    return commandPrefix(command) === rule.value;
  }
  if (rule.kind === "read-path" && subject.operation === "read") {
    const targets = subject.targets;
    return targets.length > 0 && targets.every((target) => isWithin(rule.value, target));
  }
  return false;
}

/**
 * 权限规则缓存。会话级规则只存在于扩展进程内存中，断开即清空；
 * scope 为 always 的规则转交宿主注入的持久化存储，跨重启仍然命中。
 * 两者都不使用 Grok 自身的 allow-edits-session 选项。
 */
export class SessionPermissionCache {
  private rules: SessionRule[] = [];

  constructor(private readonly durable?: DurablePermissionRules) {}

  get size(): number {
    return this.rules.length + (this.durable?.list().length ?? 0);
  }

  list(): readonly SessionRule[] {
    return [...this.rules, ...(this.durable?.list() ?? [])];
  }

  allow(rule: SessionRule): void {
    if (rule.scope === "always" && this.durable) {
      this.durable.add(rule);
      return;
    }
    if (this.rules.some((existing) => existing.kind === rule.kind && existing.value === rule.value)) return;
    if (this.rules.length >= MAX_RULES) this.rules.shift();
    this.rules.push(rule);
  }

  /** 命中返回对应规则；high/blocked 与工作区外操作永不命中。 */
  matches(subject: PermissionSubject): SessionRule | undefined {
    if (isAtLeast(subject.risk, "high")) return undefined;
    if (!subject.insideWorkspace) return undefined;

    for (const rule of this.list()) {
      if (ruleMatches(rule, subject)) return rule;
    }
    return undefined;
  }

  /** 只清会话级规则；持久化规则由用户在设置里显式清空。 */
  clear(): void {
    this.rules = [];
  }
}
