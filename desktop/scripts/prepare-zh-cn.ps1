<#
.SYNOPSIS
  Prepare default zh-cn locale template and optional language pack under extensions.
#>
[CmdletBinding()]
param(
  [string]$LanguagePackVersion = "1.96.0"
)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
if (-not (Test-Path $vscodeRoot)) { throw "Run setup-vscode.ps1 first" }

$localeSrc = Join-Path $desktopRoot "product\locale.json"
$localeTemplateDir = Join-Path $desktopRoot "product\user-data-template"
New-Item -ItemType Directory -Force -Path $localeTemplateDir | Out-Null
Copy-Item -Force $localeSrc (Join-Path $localeTemplateDir "locale.json")

# VS Code 1.96+ 真正生效的是 ~/.lingdong-code/argv.json 里的 locale，不是 locale.json。
$argvTemplate = Join-Path $localeTemplateDir "argv.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($argvTemplate, "{`n`t`"locale`": `"zh-cn`"`n}`n", $utf8NoBom)

$extId = "ms-ceintl.vscode-language-pack-zh-hans"
$extDir = Join-Path $vscodeRoot "extensions\$extId"
$dlRoot = Join-Path $desktopRoot ".cache\langpack"
New-Item -ItemType Directory -Force -Path $dlRoot | Out-Null
$vsix = Join-Path $dlRoot "$extId-$LanguagePackVersion.vsix"

if (-not (Test-Path $extDir)) {
  if (-not (Test-Path $vsix)) {
    $url = "https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-zh-hans/$LanguagePackVersion/file/MS-CEINTL.vscode-language-pack-zh-hans-$LanguagePackVersion.vsix"
    Write-Host "==> Downloading Chinese language pack $LanguagePackVersion"
    curl.exe -L --retry 3 -o $vsix $url
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $vsix)) {
      Write-Warning "Language pack download failed. locale.json template is ready; user can install pack manually."
      Write-Host "locale template: $localeTemplateDir\locale.json"
      exit 0
    }
  }
  $unpack = Join-Path $dlRoot "unpacked"
  if (Test-Path $unpack) { Remove-Item -Recurse -Force $unpack }
  New-Item -ItemType Directory -Force -Path $unpack | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($vsix, $unpack)
  $from = Join-Path $unpack "extension"
  if (-not (Test-Path $from)) { throw "vsix missing extension/ folder" }
  New-Item -ItemType Directory -Force -Path (Split-Path $extDir) | Out-Null
  Copy-Item -Recurse -Force $from $extDir
  Write-Host "Language pack installed at $extDir" -ForegroundColor Green
} else {
  Write-Host "Language pack already present: $extDir"
}

Write-Host "Default locale template ready: $localeTemplateDir\locale.json" -ForegroundColor Green
