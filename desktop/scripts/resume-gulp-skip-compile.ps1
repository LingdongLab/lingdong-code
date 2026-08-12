<#
.SYNOPSIS
  Resume vscode-win32-x64 WITHOUT clean/recompile of out-build (compile-src).

  Use after compile-src succeeded but a later step failed. Requires:
    desktop/vscode/out-build  (from a prior compile-build)

  Runs the same tail as upstream vscode-win32-x64:
    clean-extensions-build
    compile-non-native-extensions-build
    compile-extension-media-build
    bundle-vscode
    vscode-win32-x64-ci
#>
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$outBuild = Join-Path $vscodeRoot "out-build"
$toolsDir = Join-Path $desktopRoot ".tools"
$localNpmCli = Join-Path $toolsDir "node_modules\npm\bin\npm-cli.js"
$localNodeGyp = Join-Path $toolsDir "node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"

if (-not (Test-Path $localNpmCli)) { throw "Missing local npm" }
if (-not (Test-Path (Join-Path $outBuild "main.js"))) {
  throw "Missing $outBuild\main.js — cannot skip compile-src; run full gulp first."
}

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
Remove-Item Env:VCINSTALLDIR -ErrorAction SilentlyContinue
Remove-Item Env:VCToolsInstallDir -ErrorAction SilentlyContinue
$env:Path = "$gypBin;$env:Path"

& (Join-Path $PSScriptRoot "ensure-local-vscode-types.ps1")

$tasks = @(
  "clean-extensions-build",
  "compile-non-native-extensions-build",
  "compile-extension-media-build",
  "bundle-vscode",
  "vscode-win32-x64-ci"
)

Push-Location $vscodeRoot
try {
  Write-Host "==> gulp (skip compile-src) $($tasks -join ' ')"
  Write-Host "Reusing out-build: $outBuild"
  & node $localNpmCli run gulp -- @tasks
  if ($LASTEXITCODE -ne 0) { throw "gulp failed (skip-compile resume)" }
  Write-Host "npm + gulp OK" -ForegroundColor Green
} finally {
  Pop-Location
  & (Join-Path $PSScriptRoot "restore-parent-vscode-types.ps1")
}
