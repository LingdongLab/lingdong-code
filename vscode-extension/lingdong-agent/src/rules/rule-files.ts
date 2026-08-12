import * as path from "node:path";

/**
 * 项目规则的发现规则（纯逻辑）。
 *
 * 位置与文件名全部照抄 Grok 0.2.118 随包文档 data/docs/user-guide/12-project-rules.md：
 * 我们只是把 Grok 已经会读的那些路径列出来给用户看与编辑，绝不自己发明新位置——
 * 界面上列出来的每一个文件，Grok 都真的会加载，否则这个面板就是在骗人。
 *
 * 刻意不做递归扫描：Grok 会从仓库根一路扫到当前工作目录，但界面上列出深层目录里的
 * 每一个 AGENTS.md 只会让人找不到重点。这里只列仓库根与各 rules 目录，
 * 想核对 Grok 的完整加载清单请用「Agent 诊断」（grok inspect）。
 */

/** Grok 会当作项目指令读取的顶层文件名，顺序与文档一致。 */
export const AGENTS_FILE_NAMES = [
  "Agents.md",
  "Claude.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENT.md",
  "AGENTS.md",
] as const;

export type RuleScope = "project" | "user";

/** 规则来自谁的约定；决定界面上的来源标签。 */
export type RuleVendor = "grok" | "claude" | "cursor";

export interface RuleFileView {
  /** 绝对路径；也是打开与去重的键。 */
  path: string;
  /** 展示名：项目级用相对仓库根的路径，用户级用「目录名/文件名」。 */
  label: string;
  scope: RuleScope;
  vendor: RuleVendor;
  /** `agents` 为顶层指令文件，`rule` 为 rules 目录里的 *.md。 */
  kind: "agents" | "rule";
  sizeBytes: number;
  /** 与 grok inspect 同一口径的近似 token 数，用来判断规则是不是吃掉了太多上下文。 */
  approxTokens: number;
}

/** 一个待扫描的位置。`file` 直接判断存在，`dir` 列出其中的 *.md。 */
export interface RuleScanTarget {
  kind: "file" | "dir";
  path: string;
  scope: RuleScope;
  vendor: RuleVendor;
  /** dir 目标下的文件按 `rule` 计，file 目标按 `agents` 计。 */
  fileKind: "agents" | "rule";
  /** 展示用的根：项目级传仓库根，用户级传上一级目录。 */
  labelRoot: string;
}

export interface RuleScanInput {
  /** 当前活动仓库根；没有仓库时只扫用户级。 */
  workspaceRoot?: string;
  /** 托管 GROK_HOME；它下面的 rules/ 是「用户级、对所有项目生效」。 */
  grokHome: string;
  /** 本机用户目录，用于 ~/.grok、~/.cursor、~/.claude。 */
  homeDir: string;
}

/**
 * 列出要扫描的位置。
 *
 * 顺序即界面顺序：先项目（离手最近、最常改），再用户级。
 * 托管 GROK_HOME 与本机 ~/.grok 可能是同一个目录（用户关掉托管时），去重后只出现一次。
 */
export function ruleScanTargets(input: RuleScanInput): RuleScanTarget[] {
  const targets: RuleScanTarget[] = [];
  const root = input.workspaceRoot?.trim();

  if (root) {
    for (const name of AGENTS_FILE_NAMES) {
      targets.push({
        kind: "file",
        path: path.join(root, name),
        scope: "project",
        vendor: name.toLowerCase().startsWith("claude") ? "claude" : "grok",
        fileKind: "agents",
        labelRoot: root,
      });
    }
    targets.push(
      { kind: "dir", path: path.join(root, ".grok", "rules"), scope: "project", vendor: "grok", fileKind: "rule", labelRoot: root },
      { kind: "dir", path: path.join(root, ".cursor", "rules"), scope: "project", vendor: "cursor", fileKind: "rule", labelRoot: root },
      { kind: "dir", path: path.join(root, ".claude", "rules"), scope: "project", vendor: "claude", fileKind: "rule", labelRoot: root },
    );
  }

  const userDirs: Array<{ dir: string; vendor: RuleVendor }> = [
    { dir: path.join(input.grokHome, "rules"), vendor: "grok" },
    { dir: path.join(input.homeDir, ".grok", "rules"), vendor: "grok" },
    { dir: path.join(input.homeDir, ".cursor", "rules"), vendor: "cursor" },
    { dir: path.join(input.homeDir, ".claude", "rules"), vendor: "claude" },
  ];
  const seen = new Set<string>();
  for (const item of userDirs) {
    const key = path.resolve(item.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      kind: "dir",
      path: item.dir,
      scope: "user",
      vendor: item.vendor,
      fileKind: "rule",
      labelRoot: path.dirname(item.dir),
    });
  }
  return targets;
}

/** grok inspect 报的是「字节数 / 4」这个量级；这里保持同一口径，免得两处数字对不上。 */
export function approxTokens(sizeBytes: number): number {
  return Math.max(0, Math.round(sizeBytes / 4));
}

export function ruleLabel(target: RuleScanTarget, absolutePath: string): string {
  const relative = path.relative(target.labelRoot, absolutePath);
  const shown = relative && !relative.startsWith("..") ? relative : absolutePath;
  return shown.replace(/\\/g, "/");
}

/** 只有 *.md 会被 Grok 当规则加载；Cursor 的 *.mdc 不在其列，列出来只会误导。 */
export function isRuleMarkdown(fileName: string): boolean {
  return /\.md$/i.test(fileName);
}

/** 文件名清洗：只保留可安全落盘的字符，空名回退成 rule。 */
export function sanitizeRuleFileName(name: string): string {
  const base = name.trim().replace(/\.md$/i, "");
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${cleaned || "rule"}.md`;
}

/**
 * 新建 AGENTS.md 的模板。
 *
 * 写成待填的骨架而不是一堆示例规则：项目规则会进每一轮的系统提示，
 * 塞满与本项目无关的漂亮话只是白烧上下文。
 */
export const AGENTS_TEMPLATE = `# 项目规则

Grok 每轮都会读这个文件，写具体、可执行的约定，别写成 README。

## 命令

- 构建：
- 类型检查：
- 单元测试：

## 约定

-

## 边界

- 不要改动：
`;

export function newRuleTemplate(title: string): string {
  const heading = title.trim() || "规则";
  return `# ${heading}\n\n- \n`;
}
