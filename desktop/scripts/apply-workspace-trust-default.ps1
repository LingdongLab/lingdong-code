<#
.SYNOPSIS
  Default security.workspace.trust.enabled to false in the Code-OSS source tree.

.DESCRIPTION
  信任机制的做法是在未信任的文件夹里禁用扩展，而灵动 Agent 整个产品就是那个扩展
  （package.json 里声明了 untrustedWorkspaces.supported: false）。默认开着的话，
  用户打开文件夹只会看到一个没有 Agent 的空壳，还得自己发现顶部黄条并点「信任」
  才能开始用——实测日志里连视图注册都不会发生。

  命令执行这件事我们自己有一整套按风险分级的审批系统在卡，安全边界没有消失，
  只是从 VS Code 那层挪到了我们这层。设置项本身还在，用户想开回来可以在设置里改。

  早先那条 VSCodium 路线是在压缩产物里反查变量名做替换，改完还得重算完整性校验和。
  源码构建有源码，直接改注册点即可，不用跟压缩后的变量名赛跑。

  幂等：已经是 false 就直接跳过。找不到锚点就报错——基座升级后默默改不到位，
  比直接失败更糟。
#>
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$target = Join-Path $vscodeRoot "src\vs\workbench\contrib\workspace\browser\workspace.contribution.ts"

if (-not (Test-Path $vscodeRoot)) { throw "Run setup-vscode.ps1 first" }
if (-not (Test-Path $target)) { throw "Missing $target" }

$text = [System.IO.File]::ReadAllText($target)

# 只认 WORKSPACE_TRUST_ENABLED 这一块的 default，别误伤下面 startupPrompt / banner 等条目。
$pattern = "(?s)(\[WORKSPACE_TRUST_ENABLED\]:\s*\{\s*type:\s*'boolean',\s*default:\s*)true(,)"

if ($text -match "(?s)\[WORKSPACE_TRUST_ENABLED\]:\s*\{\s*type:\s*'boolean',\s*default:\s*false,") {
  Write-Host "Workspace trust default already false; nothing to do."
  exit 0
}

# 别用 $matches 当变量名：那是 -match 的自动变量，赋值会被覆盖掉。
$hits = [regex]::Matches($text, $pattern)
if ($hits.Count -ne 1) {
  throw "Expected exactly 1 WORKSPACE_TRUST_ENABLED default registration, found $($hits.Count). Base upgraded? Re-anchor this patch."
}

$next = [regex]::Replace($text, $pattern, '${1}false${2}')
[System.IO.File]::WriteAllText($target, $next, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Workspace trust default set to false in $target" -ForegroundColor Green
