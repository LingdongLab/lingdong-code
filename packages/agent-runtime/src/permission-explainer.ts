import path from "node:path";
import {
  classifyCommandSegment,
  splitCommandSegments,
  stripCommandWrappers,
  type OperationKind,
  type RiskLevel,
} from "./risk-policy.js";

/**
 * 把待批准的操作翻译成人话。
 *
 * 为什么不让模型来写这段说明：权限卡是安全边界上最后一道人工关卡，卡上「这条命令要干什么」
 * 必须由本地依据命令原文推导。把解释权交给被审批的一方，等于允许它用一句编得好听的说明
 * 换到一次点击 —— 模型写错和模型撒谎在卡片上长得一模一样。何况卡片必须立刻出现，
 * 这里等不起一次模型往返。
 *
 * 所以这里只做静态推导：规则认得出的就说清楚，认不出的就明说认不出，绝不猜。
 */

export type ExplainOperation = "read" | "write" | "delete" | "execute";

export interface ExplainedStep {
  /** 命令原段落；链式命令按 shell 分隔符拆开，文件类操作为空串。 */
  command: string;
  /** 这一段用人话说是在做什么。 */
  action: string;
}

export interface OperationExplanation {
  /** 一句话总述，供折叠行、通知与日志使用。 */
  summary: string;
  /** 逐段说明，顺序即执行顺序。 */
  steps: ExplainedStep[];
  /** 后果提示，每条都是完整句子，最要紧的排在前面。 */
  notes: string[];
}

export interface ExplainInput {
  operation: ExplainOperation;
  operationKind: OperationKind;
  risk: RiskLevel;
  /** 已解析为绝对路径的操作目标。 */
  targets: readonly string[];
  command: string;
}

/** 说明里嵌入的路径、URL 等片段的长度上限，超出截断，避免一行撑爆卡片。 */
const MAX_OPERAND = 60;

/** 链式命令最多逐段说明这么多步，再长就只报总数。 */
const MAX_STEPS = 8;

/** 一张卡上最多列这么多条后果提示；再多用户就不看了。 */
const MAX_NOTES = 3;

interface ExplainRule {
  pattern: RegExp;
  describe: string | ((match: RegExpExecArray) => string);
}

/** 按空白拆词，引号内的空白不拆，引号本身剥掉。 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") out.push(current);
  return out;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_OPERAND ? `${trimmed.slice(0, MAX_OPERAND)}…` : trimmed;
}

/** 取出所有不是选项的参数，也就是命令真正作用的对象。 */
function operands(rest: string | undefined): string[] {
  return tokenize(rest ?? "")
    .filter((token) => !token.startsWith("-"))
    .map((token) => clip(token))
    .filter((token) => token !== "");
}

function firstOperand(rest: string | undefined): string {
  return operands(rest)[0] ?? "";
}

/** 「删除 dist」/「删除文件或目录」——目标认得出就点名，认不出就说类别。 */
function withTarget(prefix: string, target: string, fallback: string): string {
  return target ? `${prefix} ${target}` : fallback;
}

function hasFlag(rest: string | undefined, pattern: RegExp): boolean {
  return tokenize(rest ?? "").some((token) => token.startsWith("-") && pattern.test(token));
}

function hostOf(text: string): string {
  const match = /https?:\/\/([^\s/'"]+)/i.exec(text);
  return match?.[1] ?? "";
}

/** npm / yarn / pnpm 的常用脚本名 → 人话。脚本名以外的走通用「跑 X 脚本」。 */
const SCRIPT_ACTIONS: Record<string, string> = {
  test: "跑项目的测试",
  lint: "跑代码风格检查",
  typecheck: "跑类型检查",
  format: "按格式化规则重排代码，会改写源文件",
  build: "跑构建，产出 dist 之类的构建产物",
  dev: "启动开发服务器，会一直挂在后台占用端口",
  start: "启动服务，会一直挂在后台占用端口",
  serve: "启动本地服务，会一直挂在后台占用端口",
  preview: "启动预览服务，会一直挂在后台占用端口",
  watch: "启动监听模式，会一直挂在后台",
};

// 顺序即优先级：具体规则必须排在同族的通用规则之前，
// 否则 `git branch -d x` 会被 `git branch` 抢先解释成「列出分支」。
const EXPLAIN_RULES: readonly ExplainRule[] = [
  // ---- Git 只读 ----
  { pattern: /^git\s+status\b/i, describe: "看一下工作区里哪些文件被改过" },
  {
    pattern: /^git\s+diff\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("看", firstOperand(m[1]), "看所有改动具体改了哪些行"),
  },
  { pattern: /^git\s+log\b/i, describe: "翻看提交历史" },
  { pattern: /^git\s+show\b/i, describe: "看某次提交的具体内容" },
  { pattern: /^git\s+(?:ls-files|rev-parse|remote)\b/i, describe: "查询 Git 仓库的基本信息" },

  // ---- Git 写入 ----
  {
    pattern: /^git\s+branch\s+-[dD]\s*([\s\S]*)$/i,
    describe: (m) => withTarget("删掉分支", firstOperand(m[1]), "删掉一个分支"),
  },
  { pattern: /^git\s+branch\b/i, describe: "列出或新建分支" },
  {
    pattern: /^git\s+add\b\s*([\s\S]*)$/i,
    describe: (m) => {
      const target = firstOperand(m[1]);
      return target && target !== "." ? `把 ${target} 加进待提交列表` : "把所有改动加进待提交列表";
    },
  },
  {
    pattern: /^git\s+commit\b\s*([\s\S]*)$/i,
    describe: (m) => {
      const message = /-m\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(m[1] ?? "");
      const text = message?.[2] ?? message?.[3] ?? message?.[4] ?? "";
      return text
        ? `把待提交的改动提交到本地仓库，说明写「${clip(text)}」`
        : "把待提交的改动提交到本地仓库";
    },
  },
  { pattern: /^git\s+push\b/i, describe: "把本地提交推到远端仓库，别人也会看到" },
  { pattern: /^git\s+(?:pull|fetch)\b/i, describe: "从远端拉取最新提交" },
  { pattern: /^git\s+clone\b/i, describe: "把一个远端仓库整份克隆到本地" },
  {
    pattern: /^git\s+(?:checkout|switch)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("切换到", firstOperand(m[1]), "切换分支或还原文件"),
  },
  { pattern: /^git\s+reset\b/i, describe: "把 Git 记录往回退，工作区里没提交的改动可能一起丢掉" },
  { pattern: /^git\s+clean\b/i, describe: "删掉所有没被 Git 跟踪的文件" },
  {
    pattern: /^git\s+restore\b\s*([\s\S]*)$/i,
    describe: (m) =>
      withTarget("把", firstOperand(m[1]), "把文件") + " 还原成上次提交的样子，本地改动会丢",
  },
  { pattern: /^git\s+revert\b/i, describe: "生成一个反向提交来抵消之前的改动" },
  { pattern: /^git\s+stash\b/i, describe: "把当前改动先收进暂存区备用" },
  {
    pattern: /^git\s+merge\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("把", firstOperand(m[1]), "把另一个分支") + " 合并进当前分支",
  },
  { pattern: /^git\s+rebase\b/i, describe: "把当前分支的提交挪到新基点上，提交历史会被重写" },
  { pattern: /^git\s+tag\b/i, describe: "给某次提交打标签" },

  // ---- 包管理器：先认具体脚本，再认通用 run ----
  {
    pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|lint|typecheck|format|build|dev|start|serve|preview|watch)(?::\S+)?\b/i,
    describe: (m) => SCRIPT_ACTIONS[(m[1] ?? "").toLowerCase()] ?? "跑项目里的脚本",
  },
  {
    pattern: /^(?:npm|pnpm|yarn|bun)\s+run\s+(\S+)/i,
    describe: (m) => `跑 package.json 里的 ${clip(m[1] ?? "")} 脚本`,
  },
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+ci\b/i, describe: "按 lock 文件重装全部依赖，会先清掉 node_modules" },
  {
    pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b\s*([\s\S]*)$/i,
    describe: (m) => {
      const names = operands(m[1]);
      return names.length > 0
        ? `装上 ${names.join("、")}，并记进 package.json`
        : "按 package.json 把依赖装进 node_modules";
    },
  },
  {
    pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("卸掉依赖", operands(m[1]).join("、"), "卸掉项目依赖"),
  },
  {
    pattern: /^(?:npm\s+)?(?:npx|pnpx|bunx)\s+([\s\S]*)$/i,
    describe: (m) => withTarget("临时下载并运行", firstOperand(m[1]), "临时下载并运行一个外部包"),
  },
  {
    pattern: /^(?:pip3?|poetry|uv)\s+(?:install|add|sync)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("装 Python 包", operands(m[1]).join("、"), "装 Python 依赖"),
  },
  {
    pattern: /^(?:pip3?|poetry|uv)\s+(?:uninstall|remove)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("卸掉 Python 包", operands(m[1]).join("、"), "卸掉 Python 依赖"),
  },

  // ---- 版本查询要排在各语言工具的通用规则之前 ----
  { pattern: /^\S+\s+(?:--version|-v|-V)\b/i, describe: "查一下版本号" },

  // ---- 测试与格式化工具 ----
  { pattern: /^(?:npx\s+)?(?:jest|vitest|mocha|pytest)\b/i, describe: "跑测试" },
  { pattern: /^(?:npx\s+)?(?:eslint|ruff|flake8)\b/i, describe: "检查代码风格" },
  { pattern: /^(?:npx\s+)?(?:prettier|black|gofmt|rustfmt)\b/i, describe: "重排代码格式，会改写源文件" },
  { pattern: /^tsc\b/i, describe: "跑 TypeScript 类型检查" },

  // ---- Rust / Go ----
  { pattern: /^cargo\s+(?:test|check|clippy)\b/i, describe: "跑 Rust 的测试或静态检查" },
  { pattern: /^cargo\s+fmt\b/i, describe: "重排 Rust 代码格式，会改写源文件" },
  { pattern: /^cargo\s+build\b/i, describe: "编译这个 Rust 项目" },
  {
    pattern: /^cargo\s+(?:add|install)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("装 Rust 依赖", operands(m[1]).join("、"), "装 Rust 依赖"),
  },
  { pattern: /^go\s+test\b/i, describe: "跑 Go 的测试" },
  { pattern: /^go\s+build\b/i, describe: "编译这个 Go 项目" },
  { pattern: /^go\s+get\b/i, describe: "下载并记录 Go 依赖" },

  // ---- 目录与文件读取 ----
  {
    pattern: /^(?:ls|dir|Get-ChildItem|gci)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("列出", firstOperand(m[1]), "列出当前目录里有哪些文件") + " 里有哪些文件",
  },
  { pattern: /^tree\b/i, describe: "按树形列出目录结构" },
  { pattern: /^(?:pwd|Get-Location)\b/i, describe: "看一下当前在哪个目录" },
  {
    pattern: /^cd\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("切换到目录", firstOperand(m[1]), "切换工作目录"),
  },
  {
    pattern: /^(?:cat|type|Get-Content|gc)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("读取", firstOperand(m[1]), "读取文件内容") + " 的内容",
  },
  { pattern: /^(?:head|tail)\b/i, describe: "读取文件开头或末尾几行" },
  {
    pattern: /^(?:grep|rg|ripgrep|Select-String|findstr)\b\s*([\s\S]*)$/i,
    describe: (m) => {
      const keyword = firstOperand(m[1]);
      return keyword ? `在文件里搜「${keyword}」` : "在文件里搜关键字";
    },
  },
  { pattern: /^(?:wc|sort|uniq|cut)\b/i, describe: "对文本做统计、排序或截取" },

  // ---- 文件写入与删除 ----
  {
    pattern: /^(?:rm|del|erase|rmdir|rd|unlink|Remove-Item)\b\s*([\s\S]*)$/i,
    describe: (m) => {
      const target = operands(m[1]).join("、");
      const recursive = hasFlag(m[1], /^-(?:[a-z]*r[a-z]*|-recurse|-recursive)$/i);
      const head = withTarget("删除", target, "删除文件或目录");
      return recursive ? `${head}，连里面的内容一起删` : head;
    },
  },
  {
    pattern: /^(?:mkdir|md|New-Item)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("新建", firstOperand(m[1]), "新建文件或目录"),
  },
  {
    pattern: /^touch\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("建一个空文件", firstOperand(m[1]), "建一个空文件"),
  },
  {
    pattern: /^(?:cp|copy|Copy-Item)\b\s*([\s\S]*)$/i,
    describe: (m) => {
      const [from, to] = operands(m[1]);
      if (from && to) return `把 ${from} 复制到 ${to}`;
      return withTarget("复制", from ?? "", "复制文件或目录");
    },
  },
  {
    pattern: /^(?:mv|move|Move-Item|Rename-Item|ren)\b\s*([\s\S]*)$/i,
    describe: (m) => {
      const [from, to] = operands(m[1]);
      if (from && to) return `把 ${from} 移成 ${to}`;
      return withTarget("移动或重命名", from ?? "", "移动或重命名文件");
    },
  },
  {
    pattern: /^(?:echo|Write-Output|Write-Host)\b([\s\S]*)$/i,
    describe: (m) => (/[>]/.test(m[1] ?? "") ? "把一段文本写进文件" : "把一段文本打到终端上"),
  },
  {
    pattern: /^(?:Set-Content|Add-Content|Out-File|tee)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("把内容写进", firstOperand(m[1]), "把内容写进文件"),
  },

  // ---- 网络 ----
  {
    pattern: /^(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)\b([\s\S]*)$/i,
    describe: (m) => {
      const host = hostOf(m[1] ?? "");
      return host ? `从 ${clip(host)} 下载内容` : "访问一个网络地址";
    },
  },

  // ---- 脚本与解释器：内联代码要排在「跑某个文件」之前 ----
  { pattern: /^(?:python3?|py)\s+(?:-[A-Za-z]+\s+)*-c\b/i, describe: "跑一段直接写在命令里的 Python 代码" },
  { pattern: /^(?:node|nodejs)\s+(?:--?[A-Za-z-]+\s+)*?(?:-e|-p|--eval|--print)\b/i, describe: "跑一段直接写在命令里的 JavaScript 代码" },
  {
    pattern: /^(?:python3?|py)\s+([\s\S]*)$/i,
    describe: (m) => withTarget("用 Python 跑", firstOperand(m[1]), "用 Python 跑一段代码"),
  },
  {
    pattern: /^(?:node|nodejs)\s+([\s\S]*)$/i,
    describe: (m) => withTarget("用 Node 跑", firstOperand(m[1]), "用 Node 跑一段代码"),
  },
  {
    pattern: /^(?:bash|sh|zsh)\b\s*([\s\S]*)$/i,
    describe: (m) => withTarget("用 shell 跑脚本", firstOperand(m[1]), "跑一段 shell 脚本"),
  },
  { pattern: /^(?:powershell|pwsh)\b/i, describe: "跑一段 PowerShell 脚本" },
  { pattern: /^cmd\b/i, describe: "跑一段 cmd 脚本" },
  {
    pattern: /^\S*\.(?:ps1|bat|cmd|sh)\b/i,
    describe: "运行一个脚本文件",
  },
  {
    pattern: /^docker\s+(\S+)/i,
    describe: (m) => `执行 Docker 的 ${clip(m[1] ?? "")} 操作`,
  },

  // ---- 系统级：即使会被硬拒也要说清是什么，用户才知道模型想干什么 ----
  { pattern: /^(?:sudo|doas|runas)\b/i, describe: "以管理员身份运行命令" },
  { pattern: /^(?:winget|choco|scoop|brew|msiexec)\b|\bapt(?:-get)?\s+install\b/i, describe: "在系统层面安装软件" },
  { pattern: /^(?:shutdown|Restart-Computer|Stop-Computer)\b/i, describe: "关机或重启这台电脑" },
  { pattern: /^(?:reg|regedit)\b/i, describe: "改动 Windows 注册表" },
  { pattern: /^setx\b/i, describe: "永久改掉系统环境变量" },
  { pattern: /^(?:sc)\b|\b(?:Set-Service|New-Service|Stop-Service|Restart-Service)\b/i, describe: "改动系统服务" },
  { pattern: /^(?:format(?![-\w])|diskpart|mkfs\S*|fdisk)\b/i, describe: "格式化磁盘或改动分区" },
  { pattern: /\$env:[A-Za-z_]|^export\s+[A-Za-z_][A-Za-z0-9_]*=|^Set-Item\s+Env:/i, describe: "改掉环境变量" },

  // ---- PowerShell 管道 ----
  {
    pattern: /^(?:ForEach-Object|foreach|Where-Object|where)\b|^[%?]\s/i,
    describe: "对上一步输出的每一项挨个处理",
  },
  {
    pattern: /^(?:Select-Object|select|Sort-Object|Measure-Object|measure|Group-Object|group|Compare-Object|Get-Member|gm|Get-Unique|Format-Table|ft|Format-List|fl|Format-Wide|fw|Format-Custom|Out-String|Out-Host|oh|Out-Null|Out-Default|ConvertFrom-Json|ConvertTo-Json|ConvertFrom-Csv|ConvertTo-Csv|more|less)\b/i,
    describe: "对上一步的输出做筛选或排版",
  },
];

/** 同一类后果只说一遍：这三种读取动作共用一句，靠文案相同天然去重。 */
const READ_ONLY_NOTE = "只读取信息，不会改动任何文件。";

const KIND_NOTE: Partial<Record<OperationKind, string>> = {
  read_file: READ_ONLY_NOTE,
  list_dir: READ_ONLY_NOTE,
  search_code: READ_ONLY_NOTE,
  write_file: "会新建或改写文件。",
  create_file: "会新建文件。",
  rename_file: "会移动或重命名文件。",
  delete_file: "会删除文件，删掉之后没法自动找回。",
  install_dependency: "会联网下载依赖包，包自带的安装脚本也会在你机器上跑起来。",
  git_write: "会改动 Git 仓库的状态。",
  network_access: "会联网访问外部地址。",
  long_running_service: "会一直挂在后台占用端口，需要你自己停掉。",
  modify_config: "会改动项目的配置或清单文件。",
  modify_environment: "会改动环境变量，后面的命令都可能受影响。",
  access_outside_workspace: "目标在当前工作区之外。",
  read_credentials: "涉及凭据、密钥或密码存放的位置。",
  system_administration: "会改动系统级设置，影响范围超出这个项目。",
  unknown: "认不出这条命令具体会做什么，后果无法预判。",
};

/**
 * 后果和操作类别对不上的少数命令，单独补一句。
 *
 * 起因：`git commit` 和 `git push` 同属 git_write，按类别只能说出「会改动 Git 仓库的状态」——
 * 可 push 是 high、commit 是 medium，卡上标着「有风险」而提示轻描淡写，
 * 用户就又回到了「只知道危险、不知道危险在哪」。covers 用来顶掉被它说清楚的那条类别提示。
 */
const COMMAND_NOTES: readonly { pattern: RegExp; note: string; covers: OperationKind }[] = [
  {
    pattern: /^git\s+push\b/i,
    note: "会把提交推到远端仓库，推上去别人就能拉到，要收回得另做一次提交。",
    covers: "git_write",
  },
  {
    pattern: /^git\s+(?:reset|clean|restore|checkout)\b/i,
    note: "会用 Git 里的版本覆盖工作区，还没提交的改动会直接丢掉。",
    covers: "git_write",
  },
  {
    pattern: /^git\s+rebase\b/i,
    note: "会重写提交历史，已经推送过的分支会和远端分叉。",
    covers: "git_write",
  },
];

/** 提示的排序：最要紧的排前面，卡片只留前几条。 */
const NOTE_ORDER: readonly OperationKind[] = [
  "read_credentials",
  "system_administration",
  "access_outside_workspace",
  "delete_file",
  "modify_environment",
  "unknown",
  "install_dependency",
  "network_access",
  "git_write",
  "modify_config",
  "write_file",
  "create_file",
  "rename_file",
  "long_running_service",
  "run_command",
  "read_file",
  "list_dir",
  "search_code",
];

/** 命令直接落盘的类别。这些走终端而不是编辑工具，宿主没有机会先存快照。 */
const TOUCHES_DISK: ReadonlySet<OperationKind> = new Set([
  "write_file",
  "create_file",
  "rename_file",
  "delete_file",
  "modify_config",
]);

/** 规则都没命中时的兜底：按风险说一句实话，不编细节。 */
const RISK_FALLBACK: Record<RiskLevel, string> = {
  low: "按命令内容判断，这一步不会改动你的文件。",
  medium: "会真正执行程序，具体副作用取决于它自己。",
  high: "没法确认这条命令的全部后果。",
  blocked: "这类操作已被安全策略禁止。",
};

function describeSegment(segment: string): string {
  const normalized = stripCommandWrappers(segment);
  if (normalized === "") return "";
  for (const rule of EXPLAIN_RULES) {
    const match = rule.pattern.exec(normalized);
    if (!match) continue;
    const text = typeof rule.describe === "string" ? rule.describe : rule.describe(match);
    if (text !== "") return text;
  }
  const program = tokenize(normalized)[0] ?? "";
  return program ? `运行 ${clip(program)}` : "";
}

/**
 * 命令的逐段说明。链式命令按 shell 分隔符拆开，顺序即执行顺序。
 * 认不出的段落只说「运行 X」，不猜它做什么。
 */
export function explainCommand(command: string): ExplainedStep[] {
  return splitCommandSegments(command.trim())
    .slice(0, MAX_STEPS)
    .map((segment) => ({ command: segment, action: describeSegment(segment) }))
    .filter((step) => step.action !== "");
}

/** 逐段收集类别，让链式命令的提示能同时覆盖「联网」和「写文件」。 */
function commandKinds(command: string): Set<OperationKind> {
  const kinds = new Set<OperationKind>();
  for (const segment of splitCommandSegments(command.trim())) {
    kinds.add(classifyCommandSegment(segment).kind);
  }
  return kinds;
}

function buildNotes(input: ExplainInput): string[] {
  const kinds = input.operation === "execute" ? commandKinds(input.command) : new Set<OperationKind>();
  // 整体判定一定要在：敏感路径、越界这类只有整体判定看得见。
  kinds.add(input.operationKind);

  const notes: string[] = [];
  const push = (text: string): void => {
    if (text !== "" && !notes.includes(text)) notes.push(text);
  };

  // 具体命令的提示比类别提示说得准，所以先说，并顶掉被它覆盖的类别。
  const covered = new Set<OperationKind>();
  if (input.operation === "execute") {
    for (const segment of splitCommandSegments(input.command.trim())) {
      const normalized = stripCommandWrappers(segment);
      for (const entry of COMMAND_NOTES) {
        if (!entry.pattern.test(normalized)) continue;
        push(entry.note);
        covered.add(entry.covers);
      }
    }
  }

  for (const kind of NOTE_ORDER) {
    if (kinds.has(kind) && !covered.has(kind)) push(KIND_NOTE[kind] ?? "");
  }
  if (notes.length === 0) push(RISK_FALLBACK[input.risk]);

  if (input.operation === "write") {
    push(
      input.targets.length === 0
        ? "没能确定具体要写哪个文件。"
        : "改动前会自动存一份快照，可以在「变更」面板里逐条撤销。",
    );
  }
  if (input.operation === "execute" && [...kinds].some((kind) => TOUCHES_DISK.has(kind))) {
    push("命令直接改磁盘，灵动 Code 不会替它存快照，改完没法一键还原。");
  }

  return notes.slice(0, MAX_NOTES);
}

function fileAction(input: ExplainInput): string {
  const name = input.targets[0] ? path.win32.basename(input.targets[0]) : "";
  const extra = input.targets.length > 1 ? `等 ${input.targets.length} 个文件` : "";
  switch (input.operation) {
    case "read":
      return withTarget("读取", name + extra, "读取工作区里的内容");
    case "write":
      return withTarget("改写", name + extra, "改写工作区里的文件");
    default:
      return withTarget("删除", name + extra, "删除工作区里的文件");
  }
}

/**
 * 组装一次操作的人话说明。
 * 命令类走规则表逐段解释；文件类直接按目标点名，不必绕规则。
 */
export function explainOperation(input: ExplainInput): OperationExplanation {
  const notes = buildNotes(input);
  if (input.operation !== "execute") {
    const action = fileAction(input);
    return { summary: action, steps: [{ command: "", action }], notes };
  }

  const steps = explainCommand(input.command);
  if (steps.length === 0) {
    const summary = "认不出这条命令要做什么";
    return { summary, steps: [{ command: input.command.trim(), action: summary }], notes };
  }
  // 两步以内直接连成一句话读起来最顺；更长了报总数，细节交给下面的列表。
  const summary = steps.length <= 2
    ? steps.map((step) => step.action).join("，然后")
    : `依次做 ${steps.length} 件事`;
  return { summary, steps, notes };
}
