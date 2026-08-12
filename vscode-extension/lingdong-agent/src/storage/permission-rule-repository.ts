import type { DurablePermissionRules, SessionRule } from "@lingdong/agent-runtime";
import type { JsonStore } from "./json-store";

/**
 * 「以后都允许」规则的工作区级仓库。
 *
 * Runtime 侧的接口是同步的（权限判定发生在 ACP 反向请求的处理链上，不能等磁盘），
 * 所以内存是唯一真相：启动时 load() 一次，之后 add() 立即改内存、异步落盘。
 * 落盘失败只丢"记住"这件事，下次重新问一遍，不影响本次判定。
 */

const MAX_RULES = 200;

/** 只接受能被 Runtime 匹配的三种范围，其余一律丢弃，避免旧版本或手工编辑写入无效规则。 */
const VALID_KINDS = new Set(["workspace-write", "command-prefix", "read-path"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRule(value: unknown): SessionRule | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, value: scopeValue, label } = value;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) return undefined;
  if (typeof scopeValue !== "string" || scopeValue.trim() === "") return undefined;
  if (typeof label !== "string") return undefined;
  return {
    kind: kind as SessionRule["kind"],
    value: scopeValue,
    label,
    // 落盘的规则一律是 always；旧文件里没有 scope 字段也按 always 读回。
    scope: "always",
  };
}

export interface PermissionRuleRepositoryOptions {
  onDamage?: (detail: string) => void;
  log?: (line: string) => void;
}

export class PermissionRuleRepository implements DurablePermissionRules {
  private rules: SessionRule[] = [];
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly store: JsonStore,
    private readonly options: PermissionRuleRepositoryOptions = {},
  ) {}

  get size(): number {
    return this.rules.length;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const result = await this.store.read<SessionRule[]>(this.file, {
      kind: "permissions",
      fallback: () => [],
      validate: (data) => {
        if (!Array.isArray(data)) return undefined;
        return data.map(toRule).filter((rule): rule is SessionRule => rule !== undefined);
      },
    });
    this.rules = result.data.slice(0, MAX_RULES);
    this.loaded = true;
    if (result.detail) this.options.onDamage?.(`权限规则：${result.detail}`);
  }

  list(): readonly SessionRule[] {
    return this.rules;
  }

  add(rule: SessionRule): void {
    if (this.rules.some((existing) => existing.kind === rule.kind && existing.value === rule.value)) return;
    if (this.rules.length >= MAX_RULES) this.rules.shift();
    this.rules.push({ ...rule, scope: "always" });
    this.flush();
  }

  /**
   * 删掉一条规则。
   *
   * 身份用 kind + value —— 那本来就是 add() 的去重键，所以它天然唯一，
   * 不需要再造一个会随重启漂移的自增 id。删不到返回 false，调用方据此决定是否提示。
   */
  async remove(kind: string, value: string): Promise<boolean> {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => !(rule.kind === kind && rule.value === value));
    if (this.rules.length === before) return false;
    await this.store.write(this.file, "permissions", this.rules);
    return true;
  }

  async clear(): Promise<void> {
    this.rules = [];
    await this.store.write(this.file, "permissions", this.rules);
  }

  private flush(): void {
    void this.store.write(this.file, "permissions", this.rules).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.log?.(`[permission] 规则落盘失败，本次仅在当前会话生效：${detail}`);
    });
  }
}
