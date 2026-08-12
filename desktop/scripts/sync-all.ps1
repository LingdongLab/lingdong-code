<#
.SYNOPSIS
  Run product sync, builtin agent, prompt contrib, and zh-cn prepare.
#>
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
& (Join-Path $here "sync-product.ps1")
& (Join-Path $here "sync-builtin-agent.ps1")
& (Join-Path $here "apply-prompt-contrib.ps1")
& (Join-Path $here "prepare-zh-cn.ps1")
Write-Host "sync-all done." -ForegroundColor Green
