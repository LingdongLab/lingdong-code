<#
.SYNOPSIS
  把 releases\ 下的绿色包挂到 GitHub Release（大文件不要推进 git）。

.PARAMETER Tag
  Release 标签，例如 v0.1.0

.PARAMETER Title
  Release 标题；默认与 Tag 相同。

.PARAMETER ZipPath
  要上传的 zip；默认 releases\LingdongCode-0.1.0-oss-portable.zip
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,
  [string]$Title,
  [string]$ZipPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Title) { $Title = $Tag }
if (-not $ZipPath) {
  $ZipPath = Join-Path $repoRoot "releases\LingdongCode-0.1.0-oss-portable.zip"
}
if (-not (Test-Path -LiteralPath $ZipPath)) {
  throw "找不到绿色包: $ZipPath 。请先 packaging\build-portable.ps1 或拷贝到 releases\。"
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "未找到 gh（GitHub CLI）。安装：https://cli.github.com/ 然后 gh auth login"
}

Push-Location $repoRoot
try {
  $remote = git remote get-url origin 2>$null
  if (-not $remote) { throw "未配置 git remote origin。先添加 GitHub 仓库地址再发布。" }

  Write-Host "==> Release $Tag  <-  $ZipPath" -ForegroundColor Cyan
  $notes = @"
## 灵动 Code $Tag

解压即用的 Windows x64 绿色包。

1. 解压 zip
2. 运行 ``Lingdong.exe`` 或 ``启动灵动Code.cmd``
3. 在设置里配置模型 API Key 后即可对话

源码与 DIY / 自行编译说明见仓库 ``README.md`` 与 ``docs/给大模型的构建与 DIY 指南.md``。
"@

  # 若 tag 已存在则只上传资产；否则创建 release
  $existing = gh release view $Tag 2>$null
  if ($LASTEXITCODE -ne 0) {
    gh release create $Tag $ZipPath --title $Title --notes $notes
  } else {
    gh release upload $Tag $ZipPath --clobber
  }
  Write-Host "完成。在 GitHub 仓库 Releases 页面即可下载。" -ForegroundColor Green
} finally {
  Pop-Location
}
