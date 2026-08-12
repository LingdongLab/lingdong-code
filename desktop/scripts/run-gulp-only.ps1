<#
.SYNOPSIS
  Run vscode-win32-x64 gulp with type isolation (assumes node_modules already installed).
#>
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$toolsDir = Join-Path $desktopRoot ".tools"
$localNpmCli = Join-Path $toolsDir "node_modules\npm\bin\npm-cli.js"
$localNodeGyp = Join-Path $toolsDir "node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"

if (-not (Test-Path $localNpmCli)) { throw "Missing local npm" }
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

Push-Location $vscodeRoot
try {
  Write-Host "==> gulp vscode-win32-x64"
  & node $localNpmCli run gulp -- vscode-win32-x64
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Retrying vscode-win32-x64-min ..."
    & node $localNpmCli run gulp -- vscode-win32-x64-min
    if ($LASTEXITCODE -ne 0) { throw "gulp failed" }
  }
  Write-Host "npm + gulp OK" -ForegroundColor Green
} finally {
  Pop-Location
  & (Join-Path $PSScriptRoot "restore-parent-vscode-types.ps1")
}
