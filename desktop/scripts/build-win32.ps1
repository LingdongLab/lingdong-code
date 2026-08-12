<#
.SYNOPSIS
  Build Windows x64 Lingdong shell from desktop/vscode into desktop/out/win32-x64.
#>
[CmdletBinding()]
param(
  [switch]$SkipEnvCheck,
  [switch]$SkipSync,
  # 复用上一次 gulp 已经产出的 VSCode-win32-x64，只跑后面的收尾步骤。
  # 用途：收尾步骤（拷贝、补原生模块）挂掉时，不必为了重跑这几秒再等一小时编译。
  # 代价：产物是不是当前源码编译的，得你自己负责，脚本的新鲜度校验会被跳过。
  [switch]$UseExistingBuild
)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $desktopRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$outRoot = Join-Path $desktopRoot "out\win32-x64"

# 留出一点余量：文件时间戳的精度和时钟抖动都可能让刚写出的文件看着比"现在"早一点点。
$script:LingdongBuildStartedAt = (Get-Date).AddMinutes(-1)

if (-not $SkipEnvCheck) {
  & (Join-Path $PSScriptRoot "check-env.ps1")
  if ($LASTEXITCODE -ne 0) { throw "Environment check failed. See docs/code-oss-build.md" }
}

if (-not (Test-Path (Join-Path $vscodeRoot "package.json"))) {
  throw "Missing desktop/vscode. Run desktop/scripts/setup-vscode.ps1 first."
}

$env:npm_config_python = @(
  "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($env:npm_config_python) {
  Write-Host "Using Python: $($env:npm_config_python)"
}

# System npm often ships node-gyp <12.1 which cannot detect VS Build Tools 2026 (18.x).
# Prefer a workspace-local npm@>=11.6.3 (bundles node-gyp 12.1+).
$toolsDir = Join-Path $desktopRoot ".tools"
$localNpmCli = Join-Path $toolsDir "node_modules\npm\bin\npm-cli.js"
$localNodeGyp = Join-Path $toolsDir "node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"
if (-not (Test-Path $localNpmCli) -or -not (Test-Path $localNodeGyp)) {
  Write-Host "==> Installing npm@11.6.4 into desktop/.tools (VS2026 node-gyp)" -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  Push-Location $toolsDir
  try {
    npm.cmd install npm@11.6.4 --no-save --prefix .
    if ($LASTEXITCODE -ne 0) { throw "Failed to install local npm@11.6.4" }
  } finally { Pop-Location }
}
if (-not (Test-Path $localNpmCli)) { throw "Missing $localNpmCli" }
if (-not (Test-Path $localNodeGyp)) { throw "Missing $localNodeGyp (need node-gyp>=12.1 for VS2026)" }
& (Join-Path $PSScriptRoot "patch-node-gyp-spectre.ps1")
# Nested vscode build/ installs often invoke system npm's node-gyp (10.x); patch it for VS2026.
try {
  node (Join-Path $PSScriptRoot "patch-system-node-gyp-vs2026.mjs")
} catch {
  Write-Warning "Could not patch system node-gyp: $_"
}

function Invoke-LingdongNpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs)
  # Out-Host 这一步不能省。
  #
  # PowerShell 函数的返回值是"所有没被消费掉的输出"的集合，所以 & node 的 stdout 会和
  # return 的退出码拼成一个数组交给调用方。调用方写 `if ($code -ne 0)` 时，数组比较的
  # 语义是"筛出不等于 0 的元素"，只要 gulp 打过任何一行日志，结果就非空即真 ——
  # 一次成功的构建会被判成失败，同时全部日志被吞进变量、终端上什么都看不到。
  # 实测因此白烧过一小时，且现场看起来像"gulp 无声失败"，极难定位。
  & node $localNpmCli @NpmArgs | Out-Host
  return $LASTEXITCODE
}

$env:npm_config_node_gyp = $localNodeGyp
# Avoid MSB8040 when Spectre-mitigated CRT/ATL libs are not installed.
$disableSpectre = Join-Path $PSScriptRoot "disable-spectre.props"
if (Test-Path $disableSpectre) {
  $env:ForceImportBeforeCppTargets = $disableSpectre
  Write-Host "SpectreMitigation disabled via $disableSpectre"
}
$gypBin = Join-Path $toolsDir "bin"
New-Item -ItemType Directory -Force -Path $gypBin | Out-Null
$shim = Join-Path $gypBin "node-gyp.cmd"
@(
  '@echo off',
  'node "%~dp0..\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js" %*'
) | Set-Content -Encoding ASCII -Path $shim
Write-Host "Using local npm + node-gyp: $localNpmCli"

# vscode preinstall probes Program Files + vs*_install env; custom roots (e.g. E:) need the env.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$foundVs = $null
if (Test-Path $vswhere) {
  $foundVs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($foundVs) {
    $foundVs = $foundVs.Trim()
    Write-Host "Using VS: $foundVs"
    # Folder may be named 2022 even for VS 2026 Build Tools; preinstall only knows vs2022_install.
    if (-not $env:vs2022_install) { $env:vs2022_install = $foundVs }
    if (-not $env:vs2026_install) { $env:vs2026_install = $foundVs }
  }
}

# Import vcvars so link.exe finds delayimp.lib / Windows SDK libs (LNK1181 otherwise).
# IMPORTANT: vcvars overwrites PATH — re-prepend node-gyp shim afterwards.
function Import-VcVars64([string]$VsInstallPath) {
  if (-not $VsInstallPath) { return $false }
  $vcvars = Join-Path $VsInstallPath "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path $vcvars)) { return $false }
  Write-Host "Importing: $vcvars"
  $cmd = "`"$vcvars`" >nul 2>&1 && set"
  cmd.exe /c $cmd | ForEach-Object {
    if ($_ -match '^(.*?)=(.*)$') {
      Set-Item -LiteralPath "Env:$($matches[1])" -Value $matches[2]
    }
  }
  return $true
}
if (-not (Import-VcVars64 $foundVs)) {
  Write-Warning "vcvars64.bat not imported; native module link may fail (LNK1181)."
} else {
  Write-Host "INCLUDE/LIB ready for native builds"
}
# Drop VCINSTALLDIR so legacy node-gyp 10.x does not pin to VS18 and then reject it.
Remove-Item Env:VCINSTALLDIR -ErrorAction SilentlyContinue
Remove-Item Env:VCToolsInstallDir -ErrorAction SilentlyContinue
$env:Path = "$gypBin;$env:Path"
Write-Host "PATH node-gyp shim: $shim"

if (-not $SkipSync) {
  & (Join-Path $PSScriptRoot "sync-product.ps1")
  & (Join-Path $PSScriptRoot "sync-builtin-agent.ps1")
  & (Join-Path $PSScriptRoot "apply-prompt-contrib.ps1")
  & (Join-Path $PSScriptRoot "apply-workspace-trust-default.ps1")
  & (Join-Path $PSScriptRoot "prepare-zh-cn.ps1")

  # 标题栏左上角的图标。它走 CSS 背景图，和 rcedit 刷的 exe 图标是两套资源，
  # 漏掉这一步的表现是：任务栏已经是新 logo，标题栏还挂着上游那个蓝色的。
  $brandTitlebar = Join-Path $repoRoot "packaging\brand\code-icon.svg"
  $titlebarDst = Join-Path $vscodeRoot "src\vs\workbench\browser\media\code-icon.svg"
  if (Test-Path $brandTitlebar) {
    Copy-Item -Force $brandTitlebar $titlebarDst
    Write-Host "Branded titlebar icon: $titlebarDst"
  }
}

Push-Location $vscodeRoot
try {
  if ($UseExistingBuild) {
    Write-Warning "跳过 gulp，直接复用已有的 VSCode-win32-x64；不会校验它是否由当前源码编译。"
  }
  else {

  # Force nested npm (build/) to use VS2026-capable node-gyp.
  foreach ($dir in @($vscodeRoot, (Join-Path $vscodeRoot "build"))) {
    if (-not (Test-Path $dir)) { continue }
    $npmrc = Join-Path $dir ".npmrc"
    $line = "node-gyp=$(($localNodeGyp -replace '\\','/'))"
    if (Test-Path $npmrc) {
      $cur = Get-Content -LiteralPath $npmrc
      if ($cur -notmatch '^\s*node-gyp=') { Add-Content -LiteralPath $npmrc -Value $line }
    } else {
      Set-Content -LiteralPath $npmrc -Value $line -Encoding ASCII
    }
  }

  # vscode 1.96+ rejects yarn; use npm (lockfile present). Avoid root pnpm packageManager interference.
  Write-Host "==> npm ci (local npm 11.6+)" -ForegroundColor Cyan
  $nm = Join-Path $vscodeRoot "node_modules"
  if (-not (Test-Path $nm)) {
    $code = Invoke-LingdongNpm ci
    if ($code -ne 0) {
      Write-Host "npm ci failed; falling back to npm install ..." -ForegroundColor Yellow
      $code = Invoke-LingdongNpm install
      if ($code -ne 0) { throw "npm install failed" }
    }
  } else {
    Write-Host "node_modules present; skipping install (delete it to force reinstall)"
  }

  # AFTER npm: shims are pruned by install; quarantine parent @types/vscode for extension webpack.
  & (Join-Path $PSScriptRoot "ensure-local-vscode-types.ps1")

  # gulp 的 NLS 抽取跑在流水线最末端，参数写错要等一小时才报错。这里一秒钟就能判掉。
  Write-Host "==> Preflight: NLS literal check" -ForegroundColor Cyan
  & node (Join-Path $PSScriptRoot "check-nls-literals.mjs")
  if ($LASTEXITCODE -ne 0) { throw "NLS preflight failed; fix the localize calls above before building." }

  Write-Host "==> gulp vscode-win32-x64" -ForegroundColor Cyan
  try {
    $gulpStarted = Get-Date
    $code = Invoke-LingdongNpm run gulp -- vscode-win32-x64
    if ($code -ne 0) {
      # 只在"很快就挂"的时候才回退到 -min 变体。
      #
      # 这个回退是为了兜住任务名不存在、环境没准备好这类问题，那种失败都发生在头几分钟。
      # 反过来，跑满一小时才失败说明流水线本身是通的，挂在源码上——这时重试只是把同一个
      # 错误再花一小时复现一遍。实测踩过一次，别再踩。
      $elapsed = (Get-Date) - $gulpStarted
      if ($elapsed.TotalMinutes -ge 5) {
        throw ("gulp build failed after {0:N1} min; not retrying -min because the failure is almost certainly in the sources, not the task. See the error above." -f $elapsed.TotalMinutes)
      }
      Write-Host ("Failed after {0:N1} min; retrying vscode-win32-x64-min ..." -f $elapsed.TotalMinutes) -ForegroundColor Yellow
      $code = Invoke-LingdongNpm run gulp -- vscode-win32-x64-min
      if ($code -ne 0) { throw "gulp build failed" }
    }
  } finally {
    & (Join-Path $PSScriptRoot "restore-parent-vscode-types.ps1")
  }

  } # end: -not $UseExistingBuild
} finally { Pop-Location }

# 只认本次构建新生成的目录。
#
# 原来这里在找不到预期目录时会递归全盘搜 Lingdong.exe 兜底，于是 gulp 输出改名或没产出时，
# 它会捡到上一次留下的旧目录接着往下打包——安装包看着照常出炉，装出来却是上个版本，
# 而且没有任何一行日志提示。宁可在这里直接失败。
$buildStarted = if ($UseExistingBuild) { [datetime]::MinValue } else { $script:LingdongBuildStartedAt }
$candidates = @(
  (Join-Path $desktopRoot "VSCode-win32-x64"),
  (Join-Path $vscodeRoot "..\VSCode-win32-x64"),
  (Join-Path $vscodeRoot ".build\vscode-win32-x64"),
  (Join-Path $repoRoot "VSCode-win32-x64")
)

$built = $null
foreach ($dir in $candidates) {
  if (-not (Test-Path $dir)) { continue }
  $exe = @("Lingdong.exe", "Code - OSS.exe", "Code.exe") |
    ForEach-Object { Join-Path $dir $_ } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
  if (-not $exe) { continue }
  $stamp = (Get-Item -LiteralPath $exe).LastWriteTime
  if ($stamp -lt $buildStarted) {
    Write-Warning "忽略陈旧产物 $dir（可执行文件 $stamp 早于本次构建开始 $buildStarted）"
    continue
  }
  $built = $dir
  break
}

if (-not $built) {
  throw "Build finished but no freshly produced output dir found (checked: $($candidates -join '; ')). Check gulp log Destination."
}
Write-Host "==> Using build output: $built" -ForegroundColor Cyan

Write-Host "==> Copy artifacts to $outRoot"
if (Test-Path $outRoot) { Remove-Item -Recurse -Force $outRoot }
New-Item -ItemType Directory -Force -Path $outRoot | Out-Null
Copy-Item -Recurse -Force (Join-Path $built "*") $outRoot

if ($UseExistingBuild -and -not $SkipSync) {
  # 复用的 gulp 产物里，内置扩展停在上次编译那一刻。
  # 而扩展是纯文件复制进去的、不参与 workbench 的编译，所以这里按刚同步好的版本刷新一次，
  # 否则"跳过 gulp 只为省时间"会顺手把扩展和图标一起退回旧版 —— 且不会有任何提示。
  $agentSrc = Join-Path $vscodeRoot "extensions\lingdong-agent"
  $agentDst = Join-Path $outRoot "resources\app\extensions\lingdong-agent"
  if (Test-Path $agentSrc) {
    Remove-Item -Recurse -Force $agentDst -ErrorAction SilentlyContinue
    Copy-Item -Recurse -Force $agentSrc $agentDst
    Write-Host "Refreshed builtin lingdong-agent in $agentDst"
  }

  # 同理，标题栏图标在产物里是 out/media 下的一个独立文件，gulp 只是把它复制过去而已。
  $brandTitlebar = Join-Path $repoRoot "packaging\brand\code-icon.svg"
  $titlebarOut = Join-Path $outRoot "resources\app\out\media\code-icon.svg"
  if ((Test-Path $brandTitlebar) -and (Test-Path (Split-Path -Parent $titlebarOut))) {
    Copy-Item -Force $brandTitlebar $titlebarOut
    Write-Host "Refreshed titlebar icon in $titlebarOut"
  }
}

# gulp 打包 @parcel/watcher 时只带了 js，把 prebuilds/ 整个漏在源码树里。
# 结果是文件监视器子进程起来就退（ETERM，code 1），重试六次后彻底放弃：
# 编辑器感知不到磁盘变化，Agent 的变更追踪也跟着不准。
# 这个包发布的就是 prebuilds（见其 package.json 的 files 字段），补回去即可；
# N-API 预编译产物跨 Node/Electron ABI 稳定，不需要重新编译。
$watcherSrc = Join-Path $vscodeRoot "node_modules\@parcel\watcher\prebuilds"
$watcherDst = Join-Path $outRoot "resources\app\node_modules\@parcel\watcher\prebuilds"
if (Test-Path $watcherSrc) {
  if (-not (Test-Path (Join-Path $watcherDst "win32-x64"))) {
    New-Item -ItemType Directory -Force -Path $watcherDst | Out-Null
    Copy-Item -Recurse -Force (Join-Path $watcherSrc "*") $watcherDst
    Write-Host "Restored @parcel/watcher prebuilds into $watcherDst"
  }
} else {
  Write-Warning "Missing $watcherSrc; file watching will be broken in the build."
}

$lingdongExe = Join-Path $outRoot "Lingdong.exe"
foreach ($alt in @("Code - OSS.exe", "Code.exe", "灵动 Code.exe")) {
  $altPath = Join-Path $outRoot $alt
  if ((Test-Path $altPath) -and -not (Test-Path $lingdongExe)) {
    Rename-Item -LiteralPath $altPath -NewName "Lingdong.exe"
  }
}

$localeTemplate = Join-Path $desktopRoot "product\user-data-template\locale.json"
$argvTemplate = Join-Path $desktopRoot "product\user-data-template\argv.json"
$defaultData = Join-Path $outRoot "lingdong-default-userdata"
New-Item -ItemType Directory -Force -Path $defaultData | Out-Null
if (Test-Path $localeTemplate) {
  Copy-Item -Force $localeTemplate (Join-Path $defaultData "locale.json")
}
# 1.96+ 中文菜单依赖 ~/.lingdong-code/argv.json 的 locale 字段（不是 locale.json）
$userArgvDir = Join-Path $env:USERPROFILE ".lingdong-code"
New-Item -ItemType Directory -Force -Path $userArgvDir | Out-Null
if (Test-Path $argvTemplate) {
  Copy-Item -Force $argvTemplate (Join-Path $defaultData "argv.json")
  $destArgv = Join-Path $userArgvDir "argv.json"
  if (-not (Test-Path $destArgv)) {
    Copy-Item -Force $argvTemplate $destArgv
  } else {
    # 确保已有 argv 带 zh-cn，不覆盖其它字段
    node --input-type=module -e @"
import fs from 'fs';
const p = process.argv[1];
let j = {};
try { j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch {}
if (!j.locale) j.locale = 'zh-cn';
fs.writeFileSync(p, JSON.stringify(j, null, '\t') + '\n');
"@ $destArgv
  }
}

$rcedit = Join-Path $repoRoot "node_modules\rcedit\bin\rcedit-x64.exe"
$icon = Join-Path $repoRoot "packaging\brand\lingdong.ico"
if ((Test-Path $rcedit) -and (Test-Path $lingdongExe) -and (Test-Path $icon)) {
  & $rcedit $lingdongExe --set-icon $icon `
    --set-version-string "CompanyName" "Lingdong Code" `
    --set-version-string "FileDescription" "Lingdong Code" `
    --set-version-string "ProductName" "Lingdong Code" `
    --set-version-string "OriginalFilename" "Lingdong.exe"
}

Write-Host "Build complete: $outRoot" -ForegroundColor Green
if (Test-Path $lingdongExe) {
  Write-Host "Exe: $lingdongExe"
} else {
  Write-Warning "Lingdong.exe not found; inspect $outRoot"
}
