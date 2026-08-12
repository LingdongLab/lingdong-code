/**
 * 统一风险分类。所有等级都由 Runtime 依据真实操作重新计算，
 * 不采用 Webview 或模型自己提交的 risk 字段。
 */
export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type OperationKind =
  | "read_file"
  | "list_dir"
  | "search_code"
  | "write_file"
  | "create_file"
  | "rename_file"
  | "delete_file"
  | "run_command"
  | "install_dependency"
  | "git_write"
  | "network_access"
  | "long_running_service"
  | "modify_config"
  | "modify_environment"
  | "access_outside_workspace"
  | "read_credentials"
  | "system_administration"
  | "unknown";

export interface RiskVerdict {
  risk: RiskLevel;
  kind: OperationKind;
  reason: string;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, blocked: 3 };

export function worstRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}

export function isAtLeast(level: RiskLevel, floor: RiskLevel): boolean {
  return RISK_ORDER[level] >= RISK_ORDER[floor];
}

/** 凭据、密钥与浏览器密码位置；命中即 blocked，任何模式都不放行。 */
export const SENSITIVE_TARGET =
  /(?:^|[\\/'"=(])(?:\.env(?:\.|$)|\.ssh|\.aws|\.azure|\.gnupg|\.git-credentials|credentials?|secrets?|id_rsa|id_ed25519|Login Data|Cookies)(?:[\\/]|$)|\.(?:pem|key|pfx|p12|jks|keystore)$/i;

/** 项目清单与配置文件：工作区内修改属于 medium。 */
const MANIFEST_TARGET =
  /(?:^|[\\/])(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|Cargo\.toml|Cargo\.lock|go\.mod|tsconfig[^\\/]*\.json|\.npmrc|\.grok[\\/]config\.toml|\.claude[\\/]settings[^\\/]*\.json|Dockerfile|docker-compose\.ya?ml|\.github[\\/])/i;

interface CommandRule {
  pattern: RegExp;
  risk: RiskLevel;
  kind: OperationKind;
  reason: string;
}

// 顺序即优先级：先命中的规则生效，因此 blocked 规则必须排在同类 high/medium 之前。
const COMMAND_RULES: readonly CommandRule[] = [
  // ---- blocked：提权、系统配置、系统级安装、破坏性磁盘操作、强制推送 ----
  { pattern: /^(?:sudo|doas|runas)\b/i, risk: "blocked", kind: "system_administration", reason: "命令请求管理员提权" },
  { pattern: /\bStart-Process\b[^\n]*-Verb\s+RunAs\b/i, risk: "blocked", kind: "system_administration", reason: "命令请求以管理员身份启动进程" },
  { pattern: /^(?:reg|regedit|reg\.exe)\b/i, risk: "blocked", kind: "system_administration", reason: "命令修改 Windows 注册表" },
  { pattern: /\b(?:Set-ItemProperty|New-ItemProperty|Remove-ItemProperty)\b[^\n]*\bHK(?:LM|CU|CR|U|CC)\b/i, risk: "blocked", kind: "system_administration", reason: "命令修改 Windows 注册表" },
  { pattern: /^(?:sc|sc\.exe)\b|\b(?:Set-Service|New-Service|Stop-Service|Restart-Service)\b/i, risk: "blocked", kind: "system_administration", reason: "命令修改系统服务" },
  // format 后面不能跟连字符，否则 PowerShell 的 Format-Table / Format-List 会被当成磁盘格式化
  // 而硬拒——它们是最常用的输出整形 cmdlet，误判成 blocked 连人工批准都救不回来。
  { pattern: /^(?:format(?![-\w])|diskpart|mkfs[^\s]*|fdisk)\b/i, risk: "blocked", kind: "system_administration", reason: "命令涉及磁盘格式化或分区" },
  { pattern: /^(?:shutdown|Restart-Computer|Stop-Computer)\b/i, risk: "blocked", kind: "system_administration", reason: "命令关闭或重启计算机" },
  { pattern: /^(?:winget|choco|scoop|msiexec|brew)\b|\bapt(?:-get)?\s+install\b|\bInstall-(?:Module|Package|WindowsFeature)\b/i, risk: "blocked", kind: "system_administration", reason: "命令执行系统级软件安装" },
  { pattern: /\bgit\b[^\n]*\bpush\b[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-f(?:\s|$))/i, risk: "blocked", kind: "git_write", reason: "命令执行 Git 强制推送" },
  { pattern: /^setx\b/i, risk: "blocked", kind: "modify_environment", reason: "命令持久化修改系统环境变量" },

  // ---- low：明确的只读与本地校验命令（放在 high 删除规则之前不冲突） ----
  { pattern: /^git\s+(?:status|diff|log|show|branch|ls-files|rev-parse|remote(?:\s+-v)?)\b/i, risk: "low", kind: "run_command", reason: "Git 只读查询" },
  { pattern: /^(?:pwd|Get-Location|cd)\b/i, risk: "low", kind: "list_dir", reason: "查看当前目录" },
  { pattern: /^(?:ls|dir|Get-ChildItem|tree)\b/i, risk: "low", kind: "list_dir", reason: "列出目录内容" },
  { pattern: /^(?:cat|type|Get-Content|head|tail|wc|sort|uniq|cut)\b/i, risk: "low", kind: "read_file", reason: "读取文件内容" },
  { pattern: /^(?:grep|rg|ripgrep|Select-String|findstr)\b/i, risk: "low", kind: "search_code", reason: "搜索代码" },
  // PowerShell 的整形与格式化 cmdlet。Windows 上模型几乎必然用它们截断输出，
  // 少了这一条，`curl ... | Select-Object -First 20` 会因为管道尾巴认不出来而整条升成 high。
  // 只收不接受脚本块、也不写文件的：Out-File / Tee-Object 会落盘，仍归 medium 写入。
  {
    pattern: /^(?:Select-Object|select|Sort-Object|Measure-Object|measure|Group-Object|group|Compare-Object|Get-Member|gm|Get-Unique|Format-Table|ft|Format-List|fl|Format-Wide|fw|Format-Custom|Out-String|Out-Host|oh|Out-Null|Out-Default|Out-GridView|ConvertFrom-Json|ConvertTo-Json|ConvertFrom-Csv|ConvertTo-Csv|ConvertFrom-StringData|Write-Host|more|less)\b/i,
    risk: "low", kind: "run_command", reason: "只对管道内容做筛选、排序或格式化",
  },
  { pattern: /^(?:node|npm|pnpm|yarn|python|python3|git|tsc|cargo|go)\s+--version\b|^(?:node|npm|git)\s+-v\b/i, risk: "low", kind: "run_command", reason: "查询工具版本" },
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|format)(?::\S+)?\b/i, risk: "low", kind: "run_command", reason: "运行项目测试、lint、类型检查或格式化" },
  { pattern: /^(?:npx\s+)?(?:jest|vitest|mocha|pytest|eslint|prettier|ruff|flake8|black|gofmt|rustfmt)\b/i, risk: "low", kind: "run_command", reason: "运行测试或格式化工具" },
  { pattern: /^tsc\b[^\n]*--noEmit\b|^tsc\s*$/i, risk: "low", kind: "run_command", reason: "TypeScript 类型检查" },
  { pattern: /^cargo\s+(?:test|fmt|clippy|check)\b/i, risk: "low", kind: "run_command", reason: "Rust 测试或检查" },

  // ---- high：删除、历史回退、环境变量、未知脚本 ----
  { pattern: /^(?:rm|del|erase|rmdir|rd|unlink|Remove-Item)\b/i, risk: "high", kind: "delete_file", reason: "命令删除文件或目录" },
  { pattern: /^git\s+(?:reset|clean|restore|revert)\b/i, risk: "high", kind: "git_write", reason: "Git 回退或清理会覆盖工作区内容" },
  { pattern: /^git\s+checkout\b[^\n]*(?:--\s|\.\s*$)/i, risk: "high", kind: "git_write", reason: "Git checkout 会覆盖本地文件" },
  { pattern: /^git\s+push\b/i, risk: "high", kind: "git_write", reason: "Git 推送会写入远端仓库" },
  { pattern: /\$env:[A-Za-z_][A-Za-z0-9_]*\s*=|^export\s+[A-Za-z_][A-Za-z0-9_]*=|^Set-Item\s+Env:/i, risk: "high", kind: "modify_environment", reason: "命令修改环境变量" },
  { pattern: /^(?:bash|sh|zsh|powershell|pwsh|cmd)\b[^\n]*-(?:c|Command)\b|\.(?:ps1|bat|cmd|sh)\b/i, risk: "high", kind: "run_command", reason: "命令执行内联脚本或脚本文件" },
  { pattern: /\b(?:alter|drop|truncate)\s+(?:table|database|schema)\b|\bmigrate\b[^\n]*\b(?:down|reset)\b/i, risk: "high", kind: "run_command", reason: "命令修改数据库结构" },

  // ---- medium：依赖安装、构建、提交、网络、长期运行服务 ----
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|uninstall|remove|ci)\b/i, risk: "medium", kind: "install_dependency", reason: "命令安装或移除项目依赖" },
  { pattern: /^(?:pip|pip3|poetry|uv)\s+(?:install|add|remove|sync)\b|^cargo\s+(?:add|install)\b|^go\s+get\b/i, risk: "medium", kind: "install_dependency", reason: "命令安装或移除项目依赖" },
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b|^(?:vite|next|nodemon|http-server)\b|^python3?\s+-m\s+http\.server\b/i, risk: "medium", kind: "long_running_service", reason: "命令启动长期运行的服务或监听端口" },
  { pattern: /^git\s+(?:commit|add|merge|rebase|tag|stash|switch|branch\s+-[dD])\b/i, risk: "medium", kind: "git_write", reason: "Git 写操作会改变仓库状态" },
  { pattern: /^(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)\b/i, risk: "medium", kind: "network_access", reason: "命令访问网络" },
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|^cargo\s+build\b|^go\s+build\b/i, risk: "medium", kind: "run_command", reason: "构建命令会执行项目脚本并产生构建产物" },
  { pattern: /^(?:npm\s+)?(?:npx|pnpx|bunx)\b/i, risk: "medium", kind: "install_dependency", reason: "命令会下载并执行外部包" },
  { pattern: /^(?:mkdir|New-Item|touch|cp|copy|Copy-Item|mv|move|Move-Item|Rename-Item)\b/i, risk: "medium", kind: "write_file", reason: "命令创建、复制或移动文件" },
  { pattern: /^(?:echo|Write-Output|Set-Content|Add-Content|Out-File|tee)\b/i, risk: "medium", kind: "write_file", reason: "命令可能写入文件" },
];

/** 内联解释器命令：python -c、node -e/-p，以及只读的 python -m 解析模块。 */
const INLINE_PYTHON = /^(?:python3?|py)\s+(?:-[A-Za-z]+\s+)*-c\s+([\s\S]+)$/i;
const INLINE_NODE = /^(?:node|nodejs)\s+(?:--?[A-Za-z-]+\s+)*?(?:-e|-p|--eval|--print)\s+([\s\S]+)$/i;
const INLINE_PY_MODULE = /^(?:python3?|py)\s+-m\s+(?:json\.tool|ast|tokenize|py_compile|pydoc)\b([\s\S]*)$/i;

/** 内联脚本长度上限：超过就认为无法静态判读，按高风险处理。 */
const MAX_INLINE_CODE = 2_000;

/** 读写标准流不算接触文件系统，先剔除避免误判。 */
const STANDARD_STREAM = /(?:sys|process)\.(?:stdout|stderr|stdin)\.[A-Za-z_]+\s*\(/gi;

interface InlineRule {
  pattern: RegExp;
  risk: RiskLevel;
  kind: OperationKind;
  reason: string;
}

// 顺序即优先级：先命中的副作用规则生效。
const INLINE_RULES: readonly InlineRule[] = [
  {
    pattern: /\b(?:subprocess|os\.system|os\.popen|os\.exec[a-z]*|os\.spawn[a-z]*|pty\.spawn|child_process|execSync|spawnSync)\b/i,
    risk: "high", kind: "run_command", reason: "内联脚本会启动子进程或执行系统命令",
  },
  {
    pattern: /\b(?:socket|requests|httpx|aiohttp|urllib|urlopen|http\.client|https?:\/\/)\b|\bfetch\s*\(/i,
    risk: "high", kind: "network_access", reason: "内联脚本会访问网络",
  },
  {
    pattern: /os\.environ\s*\[[^\]]*\]\s*=|os\.environ\.(?:update|setdefault|pop)|\bputenv\b|process\.env\.[A-Za-z_][A-Za-z0-9_]*\s*=/i,
    risk: "high", kind: "modify_environment", reason: "内联脚本会修改环境变量",
  },
  {
    pattern: /\b(?:os\.remove|os\.unlink|os\.rmdir|os\.removedirs|shutil\.rmtree|shutil\.move|shutil\.copy[a-z]*|unlinkSync|rmSync|rmdirSync)\b|\.unlink\s*\(|fs\.(?:rm|unlink)/i,
    risk: "high", kind: "delete_file", reason: "内联脚本会删除或移动文件",
  },
  {
    // 写模式只认独立的模式参数（open(path, "w")），否则 open('index.html') 会因为文件名里的 x 被误判。
    pattern: /open\s*\([^)]*,\s*['"][rwaxbt+]*[wax+][rwaxbt+]*['"]|\bwrite_text\b|\bwrite_bytes\b|\bwritelines\b|\.write\s*\(|writeFileSync|appendFileSync|fs\.(?:write|append|mkdir|rename|copy)|\bos\.rename\b|\bos\.replace\b|\bos\.makedirs?\b|\bos\.mkdir\b|mkdirSync|renameSync/i,
    risk: "high", kind: "write_file", reason: "内联脚本会写入文件",
  },
  {
    pattern: /\bexec\s*\(|\beval\s*\(|__import__|\bcompile\s*\(|\bbase64\b|codecs\.decode|\bpip\s+install\b|\bensurepip\b/i,
    risk: "high", kind: "unknown", reason: "内联脚本包含动态执行或无法静态判读的内容",
  },
];

/** 只读但会打开工作区文件的迹象：判定为 medium。 */
const INLINE_READ =
  /open\s*\(|\bread_text\b|\bread_bytes\b|\bPath\s*\(|\breadlines\b|\breadFileSync\b|fs\.read|\bos\.listdir\b|\bos\.walk\b|\bos\.scandir\b|\bglob\b|\bsys\.argv\b|\.read\s*\(/i;

function stripCodeQuotes(code: string): string {
  const text = code.trim();
  const first = text[0];
  if ((first === '"' || first === "'") && text.endsWith(first) && text.length >= 2) {
    return text.slice(1, -1);
  }
  return text;
}

function inlineCode(segment: string): string | undefined {
  for (const pattern of [INLINE_PYTHON, INLINE_NODE]) {
    const match = pattern.exec(segment);
    if (match) return stripCodeQuotes(match[1] ?? "");
  }
  return undefined;
}

/**
 * 内联解释器命令的风险判定。
 * 只读解析（HTML / JSON / AST）可以落到 low 或 medium，
 * 但一旦出现写文件、删除、网络、子进程或环境变量修改，仍按 high 处理。
 * 返回 undefined 表示该命令段不是内联解释器命令。
 */
export function classifyInlineScript(segment: string): RiskVerdict | undefined {
  const text = segment.trim();
  const moduleMatch = INLINE_PY_MODULE.exec(text);
  if (moduleMatch) {
    return (moduleMatch[1] ?? "").trim()
      ? { risk: "medium", kind: "read_file", reason: "只读解析指定文件" }
      : { risk: "low", kind: "run_command", reason: "只读解析标准输入" };
  }

  const code = inlineCode(text);
  if (code === undefined) return undefined;
  if (code.length > MAX_INLINE_CODE) {
    return { risk: "high", kind: "unknown", reason: "内联脚本过长，无法静态判读，按高风险处理" };
  }

  const scanned = code.replace(STANDARD_STREAM, "print(");
  for (const rule of INLINE_RULES) {
    if (rule.pattern.test(scanned)) {
      return { risk: rule.risk, kind: rule.kind, reason: rule.reason };
    }
  }
  if (INLINE_READ.test(scanned)) {
    return { risk: "medium", kind: "read_file", reason: "内联脚本只读取并解析文件内容" };
  }
  return { risk: "low", kind: "run_command", reason: "内联脚本只做只读解析，不接触文件系统" };
}

/**
 * 按 shell 分隔符拆分链式命令，逐段判定后取最严重结果。
 * 引号内的分隔符不拆分，否则 `python -c "a; b"` 会被切成两段并被当成未知命令。
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;

  const flush = (): void => {
    const text = current.trim();
    if (text.length > 0) segments.push(text);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      flush();
      continue;
    }
    if (char === "\r") continue;
    if (char === "|") {
      flush();
      if (command[index + 1] === "|") index += 1;
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      flush();
      index += 1;
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

/** 剥离环境变量前缀与无害包装器；`sudo` 等提权包装器故意不剥离。 */
export function stripCommandWrappers(segment: string): string {
  let current = segment.trim();
  for (;;) {
    const next = current
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)/, "")
      .replace(/^(?:timeout|nice|ionice|chrt|stdbuf)\s+(?:-\S+\s+)*/i, "")
      .trim();
    if (next === current) return current;
    current = next;
  }
}

/**
 * 脚本块里常见的纯表达式：`$_.Name`、`$_.Length -gt 100`、`-not $_.Hidden`。
 *
 * 它们不是命令调用，落到「无法识别」按 high 处理会把整条管道无谓地顶成高风险。
 * 但子表达式 `$(...)`、调用操作符 `&` 和 Invoke-Expression 会真的执行命令，必须排除；
 * 引号或括号开头的段也不收，`"C:\tool.exe"` 在 cmd 下就是一次调用。
 */
function looksLikeExpressionOnly(segment: string): boolean {
  const text = segment.replace(/^\$[A-Za-z_]\w*\s*=\s*/, "").trim();
  if (text === "") return false;
  if (/\$\(|`|&|\biex\b|\bInvoke-(?:Expression|Command)\b/i.test(text)) return false;
  return /^(?:\$[\w{]|-|\d)/.test(text);
}

/** ForEach-Object / Where-Object 及其别名；`%` 与 `?` 后面不能要 \b，它们本身不是单词字符。 */
const SCRIPT_BLOCK_CMDLET =
  /^(?:(?:ForEach-Object|foreach|Where-Object|where)\b|%|\?)\s*([\s\S]*)$/i;

/** 脚本块嵌套上限。超过就不再往里看，按无法判读处理。 */
const MAX_BLOCK_DEPTH = 5;

/**
 * ForEach-Object / Where-Object 的判定。
 *
 * 这两个 cmdlet 自身只是遍历和过滤，但花括号里可以塞任意命令：
 * `... | ForEach-Object { Remove-Item $_ }` 删起文件来和直接 rm 没有区别。
 * 所以把脚本块掏出来按普通命令判一遍取最严重的；没有脚本块的比较式
 * （`Where-Object Name -eq foo`）才算只读。
 */
function classifyScriptBlockCmdlet(segment: string, depth: number): RiskVerdict | undefined {
  const match = SCRIPT_BLOCK_CMDLET.exec(segment);
  if (!match) return undefined;
  if (depth >= MAX_BLOCK_DEPTH) {
    return { risk: "high", kind: "unknown", reason: "脚本块嵌套过深，无法静态判读，按高风险处理" };
  }

  const rest = match[1] ?? "";
  const open = rest.indexOf("{");
  if (open < 0) return { risk: "low", kind: "run_command", reason: "只按属性过滤管道内容" };

  const close = rest.lastIndexOf("}");
  const body = close > open ? rest.slice(open + 1, close) : rest.slice(open + 1);
  let verdict: RiskVerdict = { risk: "low", kind: "run_command", reason: "脚本块内只做只读处理" };
  for (const inner of splitCommandSegments(body)) {
    const next = classifySegment(inner, depth + 1);
    if (worstRisk(verdict.risk, next.risk) === next.risk && next.risk !== verdict.risk) verdict = next;
  }
  return verdict;
}

function classifySegment(segment: string, depth = 0): RiskVerdict {
  const normalized = stripCommandWrappers(segment);
  if (normalized === "") return { risk: "low", kind: "run_command", reason: "空命令段" };
  // blocked 规则优先于内联脚本分析，提权与系统级操作不因为包在解释器里就降级。
  for (const rule of COMMAND_RULES) {
    if (rule.risk !== "blocked") continue;
    if (rule.pattern.test(normalized)) {
      return { risk: rule.risk, kind: rule.kind, reason: rule.reason };
    }
  }
  const inline = classifyInlineScript(normalized);
  if (inline) return inline;
  // 脚本块要在普通规则之前判：里面的删除命令必须能把整段顶成 high。
  const block = classifyScriptBlockCmdlet(normalized, depth);
  if (block) return block;
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(normalized)) {
      return { risk: rule.risk, kind: rule.kind, reason: rule.reason };
    }
  }
  // 放在所有规则之后：`$env:X=1` 这类仍由前面的 high 规则接住，这里只兜取值与比较。
  if (looksLikeExpressionOnly(normalized)) {
    return { risk: "low", kind: "run_command", reason: "只是取值或比较的表达式，没有调用命令" };
  }
  return { risk: "high", kind: "unknown", reason: "无法识别的命令，按高风险处理" };
}

/**
 * 单个命令段的判定。解释器要逐段收集操作类别，才能让
 * `curl x | Set-Content y` 同时提示「会联网」和「会写文件」——
 * 整条命令的判定只保留最严重的那一段，另一段的后果就说不出来了。
 *
 * 不暴露 depth：那是脚本块递归的内部状态，外部传值只会绕过嵌套上限。
 */
export function classifyCommandSegment(segment: string): RiskVerdict {
  return classifySegment(segment);
}

/**
 * 命令风险分类。链式命令逐段判定，取最严重的一段；
 * 命令文本中出现凭据或密钥路径时直接 blocked。
 */
export function classifyCommand(command: string): RiskVerdict {
  const text = command.trim();
  if (text === "") return { risk: "high", kind: "unknown", reason: "命令为空，按高风险处理" };
  if (SENSITIVE_TARGET.test(text)) {
    return { risk: "blocked", kind: "read_credentials", reason: "命令涉及凭据、密钥或浏览器密码位置" };
  }

  const segments = splitCommandSegments(text);
  if (segments.length === 0) return { risk: "high", kind: "unknown", reason: "命令无法拆分，按高风险处理" };

  let verdict = classifySegment(segments[0] ?? "");
  for (const segment of segments.slice(1)) {
    const next = classifySegment(segment);
    if (worstRisk(verdict.risk, next.risk) === next.risk && next.risk !== verdict.risk) verdict = next;
  }
  return verdict;
}

export function isSensitivePath(candidate: string): boolean {
  return SENSITIVE_TARGET.test(candidate);
}

export function isManifestPath(candidate: string): boolean {
  return MANIFEST_TARGET.test(candidate);
}

/** 工作区内写入类操作的风险：普通源文件 low，清单与配置 medium。 */
export function classifyWriteTarget(targets: readonly string[]): RiskVerdict {
  if (targets.some((target) => isManifestPath(target))) {
    return { risk: "medium", kind: "modify_config", reason: "修改项目清单或配置文件" };
  }
  return { risk: "low", kind: "write_file", reason: "修改工作区内普通源文件" };
}
