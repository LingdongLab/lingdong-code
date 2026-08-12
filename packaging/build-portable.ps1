<#
.SYNOPSIS
  Assemble the Lingdong Code portable (green) zip from Code-OSS source artifacts.

.DESCRIPTION
  吃 desktop/out/win32-x64（由 desktop/scripts/build-win32.ps1 产出），补上编译产物里
  没有的那几样东西，然后压成一个解压即用的包。

  这些步骤原本是手工做的，漏一步的后果都不显眼：
    - 忘了 grok.exe        -> 界面正常打开，一发消息就报找不到运行时
    - 忘了 watcher 预编译  -> 文件监视器反复崩溃，编辑器感知不到磁盘变化
  所以末尾有一段自检，缺任何一样直接失败，不出包。

  用户数据默认落在 %APPDATA%\Lingdong（换包不丢模型/工作区）。
  包内不再预置 data/：一旦带上空 data/，解压到新目录就会每次都像「重装」。

.PARAMETER AppVersion
  写进文件名的版本号。

.PARAMETER SkipZip
  只组装暂存目录，不压缩。用于本地试跑。
#>

[CmdletBinding()]
param(
  [string]$AppVersion = "0.1.0",
  [switch]$SkipZip
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceOut = Join-Path $repoRoot "desktop\out\win32-x64"
$stageRoot = Join-Path $repoRoot ".build\stage\portable"
$stageDir = Join-Path $stageRoot "Lingdong"
$outputDir = Join-Path $repoRoot ".build\out"
$templateDir = Join-Path $repoRoot "desktop\product\user-data-template"

function Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not (Test-Path (Join-Path $sourceOut "Lingdong.exe"))) {
  throw "Missing $sourceOut\Lingdong.exe. Run desktop/scripts/build-win32.ps1 first."
}

$running = Get-Process -Name "Lingdong" -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($stageRoot, [StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw "Lingdong still running from stage (pid $($running.Id -join ', ')). Close it first." }

Step "Stage from $sourceOut"
if (Test-Path -LiteralPath $stageDir) { Remove-Item -Recurse -Force -LiteralPath $stageDir }
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $sourceOut "*") $stageDir

# 安装包才需要这个提示目录（Inno Setup 装完后据此铺默认用户数据）；
# 便携包自带 data/，留着只会让用户多看见一个不知道干嘛的文件夹。
$installerHint = Join-Path $stageDir "lingdong-default-userdata"
if (Test-Path $installerHint) { Remove-Item -Recurse -Force $installerHint }

Step "Bundle grok.exe"
$grokSource = Join-Path $repoRoot "grok\bin\grok.exe"
if (-not (Test-Path -LiteralPath $grokSource)) { throw "Missing $grokSource" }
$grokTarget = Join-Path $stageDir "resources\grok\bin"
New-Item -ItemType Directory -Force -Path $grokTarget | Out-Null
Copy-Item -LiteralPath $grokSource -Destination (Join-Path $grokTarget "grok.exe") -Force

Step "Stable user-data defaults (AppData, not package-local data/)"
# 不再预置 data/。存在 data/ 时 Code-OSS 会启用便携模式，配置写在包内；
# 用户每次解压新包等于空配置，模型 Key 和工作区都要重来——这是反馈里「换包极费劲」的根因。
# 默认改为 %APPDATA%\Lingdong；真正要 U 盘便携时再手动建空 data/ 即可。
$defaultsDir = Join-Path $stageDir "defaults"
New-Item -ItemType Directory -Force -Path $defaultsDir | Out-Null
$argvTemplate = Join-Path $templateDir "argv.json"
$localeTemplate = Join-Path $templateDir "locale.json"
if (-not (Test-Path $argvTemplate)) { throw "Missing $argvTemplate" }
Copy-Item -LiteralPath $argvTemplate -Destination (Join-Path $defaultsDir "argv.json") -Force
if (Test-Path $localeTemplate) {
  Copy-Item -LiteralPath $localeTemplate -Destination (Join-Path $defaultsDir "locale.json") -Force
}

$portableAssets = Join-Path $PSScriptRoot "portable-assets"
foreach ($name in @("使用说明.txt", "启动灵动Code.cmd", "迁移旧配置.cmd")) {
  $from = Join-Path $portableAssets $name
  if (-not (Test-Path $from)) { throw "Missing $from" }
  Copy-Item -LiteralPath $from -Destination (Join-Path $stageDir $name) -Force
}

# 若上游产物里残留空 data/，删掉，避免又走包内便携模式。
$staleData = Join-Path $stageDir "data"
if (Test-Path -LiteralPath $staleData) {
  Remove-Item -Recurse -Force -LiteralPath $staleData
  Write-Host "    已移除产物中的 data/（改用 AppData 持久配置）"
}

# 注意这里刻意不预置 security.workspace.trust.enabled。
# 该默认值已经由 desktop/scripts/apply-workspace-trust-default.ps1 直接改在
# Code-OSS 源码的注册点上，同一个行为不要留两套实现——改了一边忘另一边就是下一个 bug。
# 下面的自检会验证编译产物里确实是 false。

Step "Self-check"
$problems = @()

$exe = Join-Path $stageDir "Lingdong.exe"
if (-not (Test-Path $exe)) { $problems += "缺 Lingdong.exe" }

if (-not (Test-Path (Join-Path $stageDir "resources\grok\bin\grok.exe"))) {
  $problems += "缺 grok.exe（Agent 会启动失败）"
}

$watcher = Join-Path $stageDir "resources\app\node_modules\@parcel\watcher\prebuilds\win32-x64"
$watcherNode = if (Test-Path $watcher) { Get-ChildItem $watcher -Filter "*.node" -ErrorAction SilentlyContinue } else { $null }
if (-not $watcherNode) { $problems += "缺 @parcel/watcher 预编译 .node（文件监视器会反复崩溃）" }

$agentPkg = Join-Path $stageDir "resources\app\extensions\lingdong-agent\package.json"
if (-not (Test-Path $agentPkg)) {
  $problems += "缺内置 lingdong-agent 扩展"
} else {
  $pkg = Get-Content -LiteralPath $agentPkg -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "    内置扩展: $($pkg.displayName) v$($pkg.version)"
}

$langPack = Join-Path $stageDir "resources\app\extensions\ms-ceintl.vscode-language-pack-zh-hans"
if (-not (Test-Path $langPack)) { $problems += "缺中文语言包" }

if (-not (Test-Path (Join-Path $defaultsDir "argv.json"))) { $problems += "缺 defaults\argv.json（中文 locale 种子）" }
if (-not (Test-Path (Join-Path $stageDir "迁移旧配置.cmd"))) { $problems += "缺 迁移旧配置.cmd" }
if (-not (Test-Path (Join-Path $stageDir "启动灵动Code.cmd"))) { $problems += "缺 启动灵动Code.cmd" }
if (Test-Path (Join-Path $stageDir "data")) { $problems += "不应再带 data/（会迫使包内便携、换包丢配置）" }

# 工作区信任必须在基座里就是关的，否则用户打开文件夹后 Agent 直接消失。
$workbench = Get-ChildItem (Join-Path $stageDir "resources\app\out\vs\workbench") -Filter "workbench.desktop.main.js" -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $workbench) {
  $problems += "找不到 workbench.desktop.main.js，无法确认工作区信任默认值"
} else {
  # 产物是压缩过的：设置键被提成了变量（形如 var $hCb = "security.workspace.trust.enabled"），
  # 注册处引用的是那个变量而不是原字符串。所以先把变量名取出来，再拿它去定位 default。
  $text = [System.IO.File]::ReadAllText($workbench.FullName)
  $keyVar = [regex]::Match($text, '([\$\w]+)\s*=\s*"security\.workspace\.trust\.enabled"')
  if (-not $keyVar.Success) {
    $problems += "产物里找不到 security.workspace.trust.enabled，锚点失效"
  } else {
    $escaped = [regex]::Escape($keyVar.Groups[1].Value)
    $enabledDefault = [regex]::Match($text, "$escaped\]\s*:\s*\{[^}]*?default\s*:\s*(!0|!1|true|false)")
    if (-not $enabledDefault.Success) {
      $problems += "找到了信任设置键但读不到它的 default，锚点可能随上游改动失效"
    } elseif ($enabledDefault.Groups[1].Value -in @("!0", "true")) {
      $problems += "工作区信任默认仍是开启（用户打开文件夹后 Agent 会消失）"
    } else {
      Write-Host "    工作区信任默认: 关闭"
    }
  }
}

# 别把测试痕迹发出去（若上游又拷进了 data）。
foreach ($junk in @("data\user-data\logs", "data\user-data\CachedData", "data\user-data\workspaceStorage")) {
  $p = Join-Path $stageDir $junk
  if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "    清理测试痕迹: $junk" }
}

if ($problems.Count -gt 0) {
  Write-Host ""
  foreach ($p in $problems) { Write-Host "  [缺陷] $p" -ForegroundColor Red }
  throw "自检未通过，共 $($problems.Count) 项。不出包。"
}
Write-Host "    自检通过" -ForegroundColor Green

$stageSize = [math]::Round((Get-ChildItem -LiteralPath $stageDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Step "Stage ready: $stageDir ($stageSize MB)"

if ($SkipZip) {
  Write-Host "Skipped zip. Try: `"$stageDir\Lingdong.exe`"" -ForegroundColor Yellow
  exit 0
}

Step "Compress"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$zipPath = Join-Path $outputDir "LingdongCode-$AppVersion-oss-portable.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -Force -LiteralPath $zipPath }

# tar.exe 是 Windows 10 自带的，比 Compress-Archive 快得多，也不会撞 2GB 上限。
Push-Location $stageRoot
try {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & tar.exe -a -c -f $zipPath "Lingdong"
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($code -ne 0) { throw "tar failed with exit code $code" }
} finally { Pop-Location }

$zip = Get-Item -LiteralPath $zipPath
Write-Host "Portable: $($zip.FullName) ($([math]::Round($zip.Length / 1MB, 1)) MB)" -ForegroundColor Green
