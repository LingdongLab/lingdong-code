<#
.SYNOPSIS
  Restore parent monorepo @types/vscode after Code-OSS gulp (if quarantined).
#>
$ErrorActionPreference = "Continue"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $desktopRoot
$parentTypes = Join-Path $repoRoot "node_modules\@types\vscode"
$legacyBak = Join-Path $repoRoot "node_modules\@types\vscode.lingdong-bak"
$quarantineTypes = Join-Path $repoRoot "node_modules\.lingdong-quarantine\types-vscode"

if ((Test-Path $quarantineTypes) -and -not (Test-Path $parentTypes)) {
  $typesDir = Join-Path $repoRoot "node_modules\@types"
  New-Item -ItemType Directory -Force -Path $typesDir | Out-Null
  Move-Item -LiteralPath $quarantineTypes -Destination $parentTypes
  Write-Host "Restored parent @types/vscode"
} elseif ((Test-Path $legacyBak) -and -not (Test-Path $parentTypes)) {
  Rename-Item -LiteralPath $legacyBak -NewName "vscode"
  Write-Host "Restored parent @types/vscode from legacy bak name"
}
