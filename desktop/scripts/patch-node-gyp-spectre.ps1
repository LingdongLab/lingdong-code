<#
.SYNOPSIS
  Patch desktop/.tools npm-bundled node-gyp to force SpectreMitigation=false on MSBuild.
#>
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$buildJs = Join-Path $desktopRoot ".tools\node_modules\npm\node_modules\node-gyp\lib\build.js"
if (-not (Test-Path $buildJs)) {
  throw "Missing $buildJs (install local npm@11.6.4 first)"
}
$text = Get-Content -LiteralPath $buildJs -Raw
$needle = "argv.push('/p:Configuration=' + buildType + ';Platform=' + p)"
$patched = "argv.push('/p:Configuration=' + buildType + ';Platform=' + p + ';SpectreMitigation=false')"
if ($text -match [regex]::Escape($patched)) {
  Write-Host "node-gyp Spectre patch already applied"
  exit 0
}
if ($text -notmatch [regex]::Escape($needle)) {
  throw "Could not locate MSBuild Configuration argv.push in $buildJs"
}
$newText = $text.Replace($needle, $patched)
Set-Content -LiteralPath $buildJs -Value $newText -Encoding UTF8 -NoNewline
Write-Host "Patched node-gyp for SpectreMitigation=false: $buildJs"
