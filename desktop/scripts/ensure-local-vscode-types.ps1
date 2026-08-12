<#
.SYNOPSIS
  Isolate parent-monorepo @types/vscode so Code-OSS 1.96.x compiles against its own vscode-dts.
  Must run AFTER npm install/ci (npm prunes orphan packages under node_modules).

  IMPORTANT: quarantine must leave @types/ entirely. Renaming to vscode.lingdong-bak under
  node_modules/@types still gets auto-included by TypeScript (all @types/* folders), which
  merges 1.125+ APIs into declare module 'vscode' and breaks extension webpack (ipynb, etc.).
#>
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$repoRoot = Split-Path -Parent $desktopRoot
$dts = Join-Path $vscodeRoot "src\vscode-dts\vscode.d.ts"
if (-not (Test-Path $dts)) {
  throw "Missing $dts"
}

$parentTypes = Join-Path $repoRoot "node_modules\@types\vscode"
$legacyBak = Join-Path $repoRoot "node_modules\@types\vscode.lingdong-bak"
$quarantineRoot = Join-Path $repoRoot "node_modules\.lingdong-quarantine"
$quarantineTypes = Join-Path $quarantineRoot "types-vscode"

function Move-ToQuarantine([string]$Source) {
  if (-not (Test-Path $Source)) { return $false }
  New-Item -ItemType Directory -Force -Path $quarantineRoot | Out-Null
  if (Test-Path $quarantineTypes) {
    Remove-Item -LiteralPath $quarantineTypes -Recurse -Force
  }
  Move-Item -LiteralPath $Source -Destination $quarantineTypes
  Write-Host "Quarantined $Source -> $quarantineTypes"
  return $true
}

# Prefer live @types/vscode; also migrate the old in-@types rename that TS still auto-loads.
if (Test-Path $parentTypes) {
  [void](Move-ToQuarantine $parentTypes)
} elseif (Test-Path $legacyBak) {
  [void](Move-ToQuarantine $legacyBak)
} elseif (Test-Path $quarantineTypes) {
  Write-Host "Parent @types/vscode already quarantined at $quarantineTypes"
} else {
  Write-Host "No parent @types/vscode to quarantine"
}

# Remove local @types/vscode shims. Extensions already include src/vscode-dts via tsconfig;
# a shim that re-points at the same declare-module file causes duplicate module merges.
foreach ($shim in @(
  (Join-Path $vscodeRoot "node_modules\@types\vscode"),
  (Join-Path $vscodeRoot "extensions\node_modules\@types\vscode")
)) {
  if (Test-Path $shim) {
    Remove-Item -LiteralPath $shim -Recurse -Force
    Write-Host "Removed duplicate shim: $shim"
  }
}

# Keep vscode source compile pinned to local dts (walk-up @types no longer has vscode).
$base = Join-Path $vscodeRoot "src\tsconfig.base.json"
node --input-type=module -e @"
import fs from 'fs';
const p = process.argv[1];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.compilerOptions = j.compilerOptions || {};
j.compilerOptions.paths = j.compilerOptions.paths || {};
j.compilerOptions.paths['vs/*'] = j.compilerOptions.paths['vs/*'] || ['./vs/*'];
j.compilerOptions.paths['vscode'] = ['./vscode-dts/vscode.d.ts'];
fs.writeFileSync(p, JSON.stringify(j, null, '\t') + '\n');
console.log('Pinned paths.vscode in', p);
"@ $base
