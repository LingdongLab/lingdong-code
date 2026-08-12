<#
.SYNOPSIS
  Rebuild Code-OSS native node modules against Electron headers (from desktop/vscode/.npmrc).
#>
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$toolsDir = Join-Path $desktopRoot ".tools"
$localNpmCli = Join-Path $toolsDir "node_modules\npm\bin\npm-cli.js"
$localNodeGyp = Join-Path $toolsDir "node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"

if (-not (Test-Path $localNpmCli)) { throw "Missing local npm at $localNpmCli" }
& (Join-Path $PSScriptRoot "patch-node-gyp-spectre.ps1")

$env:npm_config_node_gyp = $localNodeGyp
$env:ForceImportBeforeCppTargets = Join-Path $PSScriptRoot "disable-spectre.props"
$gypBin = Join-Path $toolsDir "bin"
New-Item -ItemType Directory -Force -Path $gypBin | Out-Null
@(
  '@echo off',
  'node "%~dp0..\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js" %*'
) | Set-Content -Encoding ASCII -Path (Join-Path $gypBin "node-gyp.cmd")

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$foundVs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
if ($foundVs) {
  $foundVs = $foundVs.Trim()
  $env:vs2022_install = $foundVs
  $env:vs2026_install = $foundVs
  $vcvars = Join-Path $foundVs "VC\Auxiliary\Build\vcvars64.bat"
  if (Test-Path $vcvars) {
    Write-Host "Importing $vcvars"
    $cmdLine = '"' + $vcvars + '" >nul 2>&1 && set'
    cmd.exe /c $cmdLine | ForEach-Object {
      if ($_ -match '^(.*?)=(.*)$') {
        Set-Item -LiteralPath "Env:$($matches[1])" -Value $matches[2]
      }
    }
  }
}
# Keep vcvars-derived PATH, but do not pin VCINSTALLDIR (node-gyp VS2026 detection).
Remove-Item Env:VCINSTALLDIR -ErrorAction SilentlyContinue
Remove-Item Env:VCToolsInstallDir -ErrorAction SilentlyContinue
$env:Path = "$gypBin;$env:Path"
# BuildTools path says 2022, product is VS 2026 — node-gyp 12 labels it "2026".
$env:npm_config_msvs_version = "2026"
$env:GYP_MSVS_VERSION = "2026"

# Align with desktop/vscode/.npmrc
$env:npm_config_disturl = "https://electronjs.org/headers"
$env:npm_config_target = "32.2.6"
$env:npm_config_runtime = "electron"
$env:npm_config_build_from_source = "true"
$env:npm_config_arch = "x64"

# Skip @parcel/watcher: win32 prebuild already present; build_from_source forces a needless compile.
$modules = @(
  "@vscode/policy-watcher",
  "@vscode/spdlog",
  "@vscode/sqlite3",
  "@vscode/windows-mutex",
  "@vscode/windows-process-tree",
  "@vscode/windows-registry",
  "@vscode/windows-ca-certs",
  "@vscode/deviceid",
  "node-pty",
  "native-keymap",
  "native-watchdog",
  "kerberos",
  "windows-foreground-love",
  "native-is-elevated"
)

Push-Location $vscodeRoot
try {
  Write-Host "==> npm rebuild $($modules -join ' ')"
  & node $localNpmCli rebuild @modules --foreground-scripts
  if ($LASTEXITCODE -ne 0) { throw "npm rebuild failed" }

  Write-Host "==> Built .node files:"
  Get-ChildItem -Path (Join-Path $vscodeRoot "node_modules") -Recurse -Filter "*.node" |
    Where-Object { $_.FullName -notmatch '\\prebuilds\\(darwin|linux)' } |
    ForEach-Object { $_.FullName.Replace($vscodeRoot + '\', '') }
} finally {
  Pop-Location
}
