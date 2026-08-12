<#
.SYNOPSIS
  Merge branding via Node (UTF-8 safe).
#>
$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "sync-product.mjs"
node $script
if ($LASTEXITCODE -ne 0) { throw "sync-product.mjs failed" }
