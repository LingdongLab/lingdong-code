<#
.SYNOPSIS
  Sync repo lingdong-agent into Code-OSS builtin extensions/lingdong-agent.
#>
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $desktopRoot
$vscodeRoot = Join-Path $desktopRoot "vscode"
$src = Join-Path $repoRoot "vscode-extension\lingdong-agent"
$dst = Join-Path $vscodeRoot "extensions\lingdong-agent"

if (-not (Test-Path $vscodeRoot)) { throw "Run setup-vscode.ps1 first" }
if (-not (Test-Path $src)) { throw "Missing agent sources: $src" }

Write-Host "==> Building lingdong-agent"
Push-Location $src
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "lingdong-agent build failed" }
} finally { Pop-Location }

if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Force -Path $dst | Out-Null

foreach ($name in @("package.json", "README.md", "LICENSE", "dist", "media")) {
  $from = Join-Path $src $name
  if (-not (Test-Path $from)) { continue }
  $to = Join-Path $dst $name
  if ((Get-Item $from).PSIsContainer) {
    Copy-Item -Recurse -Force $from $to
  } else {
    Copy-Item -Force $from $to
  }
}

# esbuild already bundles runtime deps; gulp's `npm list --production` fails if package.json
# still lists workspace packages (@lingdong/agent-runtime) that are not installed in-tree.
$pkgPath = Join-Path $dst "package.json"
node --input-type=module -e @"
import fs from 'fs';
const p = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.publisher = pkg.publisher || 'lingdong';
pkg.extensionKind = pkg.extensionKind || ['ui', 'workspace'];
pkg.dependencies = {};
delete pkg.devDependencies;
delete pkg.scripts;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
console.log('Stripped dependencies from builtin package.json');
"@ $pkgPath

Write-Host "Synced builtin agent to $dst" -ForegroundColor Green
