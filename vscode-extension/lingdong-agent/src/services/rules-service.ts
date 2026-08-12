import { Buffer } from "node:buffer";
import os from "node:os";
import * as path from "node:path";
import type { FileSystemPort } from "../file-system-port";
import {
  AGENTS_TEMPLATE,
  approxTokens,
  isRuleMarkdown,
  newRuleTemplate,
  ruleLabel,
  ruleScanTargets,
  sanitizeRuleFileName,
  type RuleFileView,
} from "../rules/rule-files";

/**
 * 项目规则的读写。
 *
 * 只做三件事：列出 Grok 真的会加载的规则文件、按模板新建一份、把路径交给宿主去打开。
 * 刻意不提供删除：规则文件通常进了版本控制，误删的代价远大于「去资源管理器里删」的麻烦。
 */

export interface RulesServiceDeps {
  fs: FileSystemPort;
  /** 当前活动仓库根；没有仓库时只有用户级规则。 */
  workspaceRoot(): string | undefined;
  /** 托管 GROK_HOME。 */
  grokHome(): string;
  homeDir?: () => string;
}

export class RulesService {
  constructor(private readonly deps: RulesServiceDeps) {}

  private get homeDir(): string {
    return this.deps.homeDir?.() ?? os.homedir();
  }

  async list(): Promise<RuleFileView[]> {
    const root = this.deps.workspaceRoot();
    const targets = ruleScanTargets({
      ...(root ? { workspaceRoot: root } : {}),
      grokHome: this.deps.grokHome(),
      homeDir: this.homeDir,
    });

    const out: RuleFileView[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const files: string[] = [];
      if (target.kind === "file") {
        if (await this.deps.fs.exists(target.path)) files.push(target.path);
      } else {
        for (const entry of await this.deps.fs.listEntries(target.path)) {
          if (entry.isDirectory || !isRuleMarkdown(entry.name)) continue;
          files.push(path.join(target.path, entry.name));
        }
        files.sort((a, b) => a.localeCompare(b, "zh-CN"));
      }

      for (const file of files) {
        // 大小写不敏感的文件系统上 Agents.md 与 AGENTS.md 是同一个文件，只算一次。
        const key = path.resolve(file).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const info = await this.deps.fs.stat(file);
        const sizeBytes = info?.size ?? 0;
        out.push({
          path: file,
          label: ruleLabel(target, file),
          scope: target.scope,
          vendor: target.vendor,
          kind: target.fileKind,
          sizeBytes,
          approxTokens: approxTokens(sizeBytes),
        });
      }
    }
    return out;
  }

  /** 仓库根的 AGENTS.md；已存在时不覆盖，直接返回路径供打开。 */
  async ensureProjectAgents(): Promise<string> {
    const root = this.deps.workspaceRoot()?.trim();
    if (!root) throw new Error("当前没有活动仓库，无法创建项目规则。");
    const file = path.join(root, "AGENTS.md");
    if (!(await this.deps.fs.exists(file))) {
      await this.deps.fs.write(file, Buffer.from(AGENTS_TEMPLATE, "utf8"));
    }
    return file;
  }

  /** 新建一条规则；scope=project 落在 .grok/rules，user 落在托管 GROK_HOME/rules。 */
  async createRule(scope: "project" | "user", title: string): Promise<string> {
    const dir = scope === "project"
      ? path.join(this.requireRoot(), ".grok", "rules")
      : path.join(this.deps.grokHome(), "rules");
    const file = path.join(dir, sanitizeRuleFileName(title));
    if (await this.deps.fs.exists(file)) {
      throw new Error(`规则文件已存在：${path.basename(file)}`);
    }
    await this.deps.fs.ensureDirectory(dir);
    await this.deps.fs.write(file, Buffer.from(newRuleTemplate(title), "utf8"));
    return file;
  }

  private requireRoot(): string {
    const root = this.deps.workspaceRoot()?.trim();
    if (!root) throw new Error("当前没有活动仓库，无法创建项目规则。");
    return root;
  }
}
