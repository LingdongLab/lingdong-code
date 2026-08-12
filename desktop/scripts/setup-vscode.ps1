<#
.SYNOPSIS
  Shallow-clone microsoft/vscode into desktop/vscode at a pinned tag.
#>
[CmdletBinding()]
param(
  [string]$VscodeTag = "1.96.4",
  [string]$RepoUrl = "https://github.com/microsoft/vscode.git"
)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $desktopRoot "vscode"

Write-Host "==> target: $target" -ForegroundColor Cyan
Write-Host "==> tag: $VscodeTag"

if (Test-Path (Join-Path $target ".git")) {
  Push-Location $target
  try {
    Write-Host "Existing clone found. Fetch + checkout $VscodeTag ..."
    git fetch --depth 1 origin tag $VscodeTag
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
    git checkout -f FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }
  } finally {
    Pop-Location
  }
} else {
  if (Test-Path $target) {
    throw "Directory exists but is not a git repo: $target. Remove it and retry."
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  Write-Host "==> shallow clone (may take several minutes)..."
  git clone --depth 1 --branch $VscodeTag $RepoUrl $target
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

$metaPath = Join-Path $desktopRoot "vscode-pin.json"
$meta = @{
  tag = $VscodeTag
  url = $RepoUrl
  clonedAt = (Get-Date).ToString("o")
}
$meta | ConvertTo-Json | Set-Content -Encoding UTF8 $metaPath
Write-Host "Done. Wrote $metaPath" -ForegroundColor Green
