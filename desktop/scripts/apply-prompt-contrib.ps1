<#
.SYNOPSIS
  Copy Lingdong Prompt workbench contribution into Code-OSS and register import.
#>
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$patchRoot = Join-Path $desktopRoot "patches\lingdongPrompt"
$destRoot = Join-Path $vscodeRoot "src\vs\workbench\contrib\lingdongPrompt"

if (-not (Test-Path $vscodeRoot)) { throw "Run setup-vscode.ps1 first" }
if (-not (Test-Path $patchRoot)) { throw "Missing patches/lingdongPrompt" }

New-Item -ItemType Directory -Force -Path $destRoot | Out-Null
Copy-Item -Recurse -Force (Join-Path $patchRoot "*") $destRoot
Write-Host "Copied contrib to $destRoot"

$candidates = @(
  (Join-Path $vscodeRoot "src\vs\workbench\workbench.common.main.ts")
)
$marker = "lingdongPrompt.contribution"
$importLine = "import './contrib/lingdongPrompt/browser/lingdongPrompt.contribution.js';"

$patched = $false
foreach ($file in $candidates) {
  if (-not (Test-Path $file)) { continue }
  $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8
  if ($text -match [regex]::Escape($marker)) {
    Write-Host "Import already present: $file"
    $patched = $true
    break
  }
  $trimmed = $text.TrimEnd()
  $next = $trimmed + "`n`n// Lingdong Prompt (first-party)`n" + $importLine + "`n"
  [System.IO.File]::WriteAllText($file, $next, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Wrote import to $file" -ForegroundColor Green
  $patched = $true
  break
}

if (-not $patched) {
  Write-Warning "workbench.common.main.ts not found; add import manually."
}

$note = Join-Path $destRoot "README.lingdong.md"
@(
  "# lingdongPrompt",
  "",
  "First-party workbench contribution synced by desktop/scripts/apply-prompt-contrib.ps1.",
  "If compile fails on .js import suffixes, adjust imports to match upstream style."
) | Set-Content -Encoding UTF8 $note
