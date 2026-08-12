<#
.SYNOPSIS
  Package Lingdong Code Windows installer from Code-OSS source artifacts.

.DESCRIPTION
  Takes desktop/out/win32-x64 (produced by desktop/scripts/build-win32.ps1),
  bundles grok.exe and the default locale, then runs ISCC.

  以前这里还有一条 VSCodium 兜底路线：下载官方 zip，在压缩产物里反查变量名替换品牌，
  再把 Agent 当 VSIX 塞进去。源码构建跑通后它就只剩负担了——同一件事两种实现，
  改了一边忘另一边，而且改压缩产物要跟着重算完整性校验和。已删除。
  它当年独有的那几件事现在的归属：
    品牌字符串   -> desktop/product/product.lingdong.json（sync-product.mjs 合并）
    工作区信任   -> desktop/scripts/apply-workspace-trust-default.ps1（改源码注册点）
    欢迎页       -> 扩展自己的 contributes.configurationDefaults
    校验和重算   -> 不再需要，源码构建不动产物

.PARAMETER SkipInstaller
  Stage only; do not run ISCC.
#>

[CmdletBinding()]
param(
  [string]$AppVersion = "0.1.0",
  [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $repoRoot ".build"
$stageDir = Join-Path $buildRoot "stage\Lingdong"
$outputDir = Join-Path $buildRoot "out"
$brandIcon = Join-Path $PSScriptRoot "brand\lingdong.ico"
$iscc = Join-Path $buildRoot "tools\InnoSetup\ISCC.exe"
$sourceOut = Join-Path $repoRoot "desktop\out\win32-x64"

function Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }

<#
.SYNOPSIS
  跑一个外部命令，只按退出码判定成败。
.DESCRIPTION
  npm / curl / ISCC 都会把进度和 notice 写进 stderr。ErrorActionPreference=Stop 下
  PowerShell 会把外部命令的 stderr 当成致命错误中断整个脚本，哪怕命令本身成功了。
#>
function Invoke-Native([string]$FailureMessage, [scriptblock]$Command) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Command
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Copy-GrokIntoStage {
  Step "Bundle grok.exe"
  $grokSource = Join-Path $repoRoot "grok\bin\grok.exe"
  if (-not (Test-Path -LiteralPath $grokSource)) { throw "Missing $grokSource" }
  $grokTarget = Join-Path $stageDir "resources\grok\bin"
  New-Item -ItemType Directory -Force -Path $grokTarget | Out-Null
  Copy-Item -LiteralPath $grokSource -Destination (Join-Path $grokTarget "grok.exe") -Force
}

function Install-LocaleDefault {
  $localeSrc = Join-Path $repoRoot "desktop\product\user-data-template\locale.json"
  if (-not (Test-Path $localeSrc)) {
    $localeSrc = Join-Path $repoRoot "desktop\product\locale.json"
  }
  if (-not (Test-Path $localeSrc)) { return }
  $hint = Join-Path $stageDir "lingdong-default-userdata"
  New-Item -ItemType Directory -Force -Path $hint | Out-Null
  Copy-Item -Force $localeSrc (Join-Path $hint "locale.json")
}

function Finish-Installer {
  $stageSize = [math]::Round((Get-ChildItem -LiteralPath $stageDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
  Step "Stage ready: $stageDir ($stageSize MB)"

  if ($SkipInstaller) {
    Write-Host "Skipped ISCC. Try: `"$stageDir\Lingdong.exe`"" -ForegroundColor Yellow
    exit 0
  }
  if (-not (Test-Path -LiteralPath $iscc)) {
    throw "Missing ISCC.exe ($iscc). Install Inno Setup 6 under .build\tools\InnoSetup."
  }
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
  Step "Compile installer"
  $issPath = Join-Path $PSScriptRoot "lingdong.iss"
  Invoke-Native "ISCC failed" {
    & $iscc `
      "/DAppVersion=$AppVersion" `
      "/DStageDir=$stageDir" `
      "/DOutputDir=$outputDir" `
      "/DBrandIcon=$brandIcon" `
      $issPath
  }
  $setup = Get-ChildItem -LiteralPath $outputDir -Filter "LingdongCodeSetup-*.exe" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  Write-Host "Installer: $($setup.FullName) ($([math]::Round($setup.Length / 1MB, 1)) MB)" -ForegroundColor Green
}

if (-not (Test-Path (Join-Path $sourceOut "Lingdong.exe")) -and -not (Test-Path (Join-Path $sourceOut "Code - OSS.exe"))) {
  throw "No usable artifacts under $sourceOut. Run desktop/scripts/build-win32.ps1 first."
}

Step "Source-build path: $sourceOut"
$running = Get-Process -Name "Lingdong" -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($stageDir, [StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw "Lingdong still running from stage (pid $($running.Id -join ', ')). Close it first." }

if (Test-Path -LiteralPath $stageDir) { Remove-Item -Recurse -Force -LiteralPath $stageDir }
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $sourceOut "*") $stageDir

if (-not (Test-Path (Join-Path $stageDir "Lingdong.exe"))) {
  $oss = Join-Path $stageDir "Code - OSS.exe"
  if (Test-Path $oss) { Rename-Item -LiteralPath $oss -NewName "Lingdong.exe" }
}

# Agent should already be built-in under resources/app/extensions/lingdong-agent.
# If missing (partial build), sync from repo.
$builtin = Join-Path $stageDir "resources\app\extensions\lingdong-agent"
if (-not (Test-Path $builtin)) {
  Step "Builtin agent missing in stage; syncing from vscode-extension"
  & (Join-Path $repoRoot "desktop\scripts\sync-builtin-agent.ps1")
  $from = Join-Path $repoRoot "desktop\vscode\extensions\lingdong-agent"
  if (-not (Test-Path $from)) { throw "Failed to materialize builtin agent" }
  New-Item -ItemType Directory -Force -Path $builtin | Out-Null
  Copy-Item -Recurse -Force (Join-Path $from "*") $builtin
}

Copy-GrokIntoStage
Install-LocaleDefault
Finish-Installer
