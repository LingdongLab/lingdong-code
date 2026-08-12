<#
.SYNOPSIS
  Check Code-OSS build prerequisites (read-only).
#>
$ErrorActionPreference = "Continue"
$ok = $true

function Show([string]$name, [bool]$pass, [string]$detail) {
  $mark = if ($pass) { "OK  " } else { "FAIL" }
  if (-not $pass) { $script:ok = $false }
  Write-Host ("[{0}] {1}: {2}" -f $mark, $name, $detail)
}

Write-Host "==> Code-OSS environment check" -ForegroundColor Cyan

$node = (node -v 2>$null)
$nodeOk = $node -match '^v(2[0-9]|[3-9])\.'
Show "Node.js" $nodeOk "$(if ($node) { $node } else { 'missing' }) (need 20+)"

$pyCmd = Get-Command python -ErrorAction SilentlyContinue
$pyCandidates = @(
  "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe"
)
if ($pyCmd) { $pyCandidates += $pyCmd.Source }
$pyCandidates = $pyCandidates | Where-Object { $_ -and (Test-Path $_) }
$pyPath = $pyCandidates | Select-Object -First 1
$pyVer = $null
if ($pyPath) { $pyVer = & $pyPath --version 2>&1 | Out-String }
$pyOk = $pyVer -match 'Python 3\.(1[0-9]|[2-9]\d)'
Show "Python" $pyOk "$(if ($pyVer) { $pyVer.Trim() + ' @ ' + $pyPath } else { 'need 3.10+' })"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = $null
if (Test-Path $vswhere) {
  $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
}
Show "VS2022 C++" ([bool]$vsPath) $(if ($vsPath) { $vsPath } else { "Install Build Tools + Desktop C++ workload" })

$git = (git --version 2>$null)
Show "Git" ([bool]$git) $(if ($git) { $git } else { "missing" })

$freeGb = [math]::Round((Get-PSDrive E -ErrorAction SilentlyContinue).Free / 1GB, 1)
Show "E: free space" ($freeGb -ge 40) "$(if ($freeGb) { "$freeGb GB" } else { 'unknown' }) (recommend >=40GB)"

$npm = Get-Command npm -ErrorAction SilentlyContinue
Show "npm on PATH" ([bool]$npm) $(if ($npm) { $npm.Source } else { "need Node.js npm (vscode 1.96+ uses npm, not yarn)" })

$vscode = Test-Path (Join-Path (Split-Path -Parent $PSScriptRoot) "vscode\package.json")
Show "desktop/vscode" $vscode $(if ($vscode) { "present" } else { "run setup-vscode.ps1" })

if ($ok) {
  Write-Host "Environment OK." -ForegroundColor Green
  exit 0
}
Write-Host "Gaps found. See docs/code-oss-build.md" -ForegroundColor Yellow
exit 1
