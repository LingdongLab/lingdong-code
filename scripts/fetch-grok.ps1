<#
.SYNOPSIS
  把 Grok Build 可执行文件放到本仓库的 grok\bin\grok.exe（开源方案 A：仓库不携带二进制）。

.DESCRIPTION
  优先级：
    1) -FromPath：直接复制你指定的 grok.exe / xai-grok-pager.exe
    2) -InstallOfficial：下载并执行官方 https://x.ai/cli/install.ps1，再从常见安装位置拷贝
    3) 默认：在 PATH 与常见目录里查找已安装的 grok.exe 并复制

  不会提交任何 API Key，也不会写入 grok\data（运行时数据目录由本机自行生成）。

.PARAMETER FromPath
  已有可执行文件的完整路径。

.PARAMETER InstallOfficial
  允许脚本下载并调用官方安装脚本（需要外网）。

.PARAMETER Force
  目标已存在时覆盖。
#>

[CmdletBinding()]
param(
  [string]$FromPath,
  [switch]$InstallOfficial,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $repoRoot "grok\bin"
$dest = Join-Path $destDir "grok.exe"

function Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }

function Find-InstalledGrok {
  $candidates = @()
  $cmd = Get-Command grok.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }

  $candidates += @(
    (Join-Path $env:LOCALAPPDATA "grok\grok.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\grok\grok.exe"),
    (Join-Path $env:USERPROFILE ".local\bin\grok.exe"),
    (Join-Path $env:USERPROFILE ".grok\bin\grok.exe"),
    (Join-Path ${env:ProgramFiles} "grok\grok.exe")
  )

  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return (Resolve-Path -LiteralPath $path).Path }
  }
  return $null
}

function Copy-Grok([string]$source) {
  if (-not (Test-Path -LiteralPath $source)) { throw "找不到源文件: $source" }
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  if ((Test-Path -LiteralPath $dest) -and -not $Force) {
    throw "已存在 $dest 。若要覆盖请加 -Force。"
  }
  Copy-Item -LiteralPath $source -Destination $dest -Force
  Write-Host "已写入: $dest" -ForegroundColor Green
  & $dest --version
}

Step "目标: $dest"

if ($FromPath) {
  Copy-Grok $FromPath
  exit 0
}

if ($InstallOfficial) {
  Step "下载官方安装脚本 https://x.ai/cli/install.ps1"
  $tmp = Join-Path $env:TEMP ("lingdong-fetch-grok-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $scriptPath = Join-Path $tmp "install.ps1"
    Invoke-WebRequest -Uri "https://x.ai/cli/install.ps1" -OutFile $scriptPath -UseBasicParsing
    Step "执行官方安装脚本（安装到用户环境，随后复制进本仓库）"
    # 官方脚本会改用户 PATH；我们只借用它落盘的二进制。
    & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath
    if ($LASTEXITCODE -ne 0) { throw "官方安装脚本退出码 $LASTEXITCODE" }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

$found = Find-InstalledGrok
if (-not $found) {
  Write-Host @"

未找到 grok.exe。请任选其一：

  1) 官方安装后再跑本脚本（不加参数即可复制进来）：
       irm https://x.ai/cli/install.ps1 | iex
       powershell -NoProfile -File scripts\fetch-grok.ps1 -Force

  2) 让本脚本代为调用官方安装：
       powershell -NoProfile -File scripts\fetch-grok.ps1 -InstallOfficial -Force

  3) 你已有自建/备份二进制：
       powershell -NoProfile -File scripts\fetch-grok.ps1 -FromPath C:\path\to\grok.exe -Force

  4) 从源码编译：见 docs\grok-源码构建.md，产物改名为 grok.exe 后用 -FromPath。

"@ -ForegroundColor Yellow
  exit 1
}

Step "发现已安装: $found"
Copy-Grok $found
