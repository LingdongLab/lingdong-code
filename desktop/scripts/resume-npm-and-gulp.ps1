<#
.SYNOPSIS
  Resume npm install + gulp using local npm / Spectre-patched node-gyp / vcvars.
#>
[CmdletBinding()]
param([switch]$ForceReinstall)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$toolsDir = Join-Path $desktopRoot ".tools"
$localNpmCli = Join-Path $toolsDir "node_modules\npm\bin\npm-cli.js"
$localNodeGyp = Join-Path $toolsDir "node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"

if (-not (Test-Path $localNpmCli)) { throw "Missing local npm. Run build-win32.ps1 once to bootstrap .tools" }
& (Join-Path $PSScriptRoot "patch-node-gyp-spectre.ps1")

$env:npm_config_node_gyp = $localNodeGyp
$env:ForceImportBeforeCppTargets = Join-Path $PSScriptRoot "disable-spectre.props"
$gypBin = Join-Path $toolsDir "bin"
$shim = Join-Path $gypBin "node-gyp.cmd"
New-Item -ItemType Directory -Force -Path $gypBin | Out-Null
@(
  '@echo off',
  'node "%~dp0..\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js" %*'
) | Set-Content -Encoding ASCII -Path $shim
$env:npm_config_python = @(
  "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

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
# vcvars overwrites PATH; restore shim. Unset VCINSTALLDIR so node-gyp 10.x won't pin+reject VS18.
Remove-Item Env:VCINSTALLDIR -ErrorAction SilentlyContinue
Remove-Item Env:VCToolsInstallDir -ErrorAction SilentlyContinue
$env:Path = "$gypBin;$env:Path"
Write-Host "PATH node-gyp shim: $shim"

function Ensure-NodeGypNpmrc([string]$Dir) {
  $npmrc = Join-Path $Dir ".npmrc"
  $line = "node-gyp=$($localNodeGyp -replace '\\','\\')"
  # npm on Windows accepts forward slashes
  $line = "node-gyp=$(($localNodeGyp -replace '\\','/'))"
  if (Test-Path $npmrc) {
    $content = Get-Content -LiteralPath $npmrc
    if ($content -notmatch '^\s*node-gyp=') {
      Add-Content -LiteralPath $npmrc -Value $line
      Write-Host "Added node-gyp to $npmrc"
    }
  } else {
    Set-Content -LiteralPath $npmrc -Value $line -Encoding ASCII
    Write-Host "Wrote $npmrc"
  }
}

Push-Location $vscodeRoot
try {
  Ensure-NodeGypNpmrc $vscodeRoot
  Ensure-NodeGypNpmrc (Join-Path $vscodeRoot "build")

  $nm = Join-Path $vscodeRoot "node_modules"
  if ($ForceReinstall -and (Test-Path $nm)) {
    Write-Host "Removing node_modules ..."
    Remove-Item -LiteralPath $nm -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $nm) { cmd.exe /c "rmdir /s /q `"$nm`"" }
  }

  Write-Host "==> npm install"
  & node $localNpmCli install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

  # AFTER npm: recreate type shims (npm prunes orphans) and quarantine parent @types/vscode.
  & (Join-Path $PSScriptRoot "ensure-local-vscode-types.ps1")

  Write-Host "==> gulp vscode-win32-x64"
  try {
    & node $localNpmCli run gulp -- vscode-win32-x64
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Retrying vscode-win32-x64-min ..."
      & node $localNpmCli run gulp -- vscode-win32-x64-min
      if ($LASTEXITCODE -ne 0) { throw "gulp failed" }
    }
    Write-Host "npm + gulp OK" -ForegroundColor Green
  } finally {
    & (Join-Path $PSScriptRoot "restore-parent-vscode-types.ps1")
  }
} finally { Pop-Location }
