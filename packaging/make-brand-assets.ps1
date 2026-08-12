<#
.SYNOPSIS
  从设计稿 PNG 生成品牌图标：packaging/brand/lingdong.ico 与扩展清单用的 icon-128.png。

.DESCRIPTION
  取代原来那份用代码画形状的 make-brand-assets.mjs —— 现在形状来自设计稿，
  脚本负责的是把设计稿变成 Windows 能用的图标，而不是画图。

  必须做的两件事，缺一个图标就会出问题：

  1. 抠透明。设计稿常见的形式是"深色底 + 居中的圆角方块"，那圈底色是**不透明**的。
     直接转 ico 的话，任务栏和窗口左上角会出现一个黑方块，因为系统不会把黑色当背景。
  2. 裁到内容。macOS 风格的图标四周留白很多，Windows 图标习惯占满画布；
     不裁的话在任务栏里会明显比邻居小一圈。

  抠图用逐行扫描而不是漫水填充：圆角方块是凸形，每一行的内容必然是连续的一段，
  所以"第一个内容像素之前、最后一个之后"就是背景，判定精确且不会误伤图形内部的深色部分。

.PARAMETER Source
  设计稿 PNG。

.PARAMETER Threshold
  判定背景的亮度阈值。纯黑底留 24 足够容忍编码噪点。

.PARAMETER PreviewOnly
  只生成预览图，不覆盖仓库里的图标。先看小尺寸效果再决定。
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$MarkSource,
  [int]$Threshold = 24,
  [switch]$PreviewOnly
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$icoTarget = Join-Path $repoRoot "packaging\brand\lingdong.ico"
$pngTarget = Join-Path $repoRoot "vscode-extension\lingdong-agent\media\icon-128.png"
# 窗口标题栏左上角那个小图标。基座用 CSS 背景图引用 out/media/code-icon.svg，
# 和 exe 的图标是两套资源 —— 只刷 exe 的话，任务栏换了、标题栏还是旧的。
$titlebarTarget = Join-Path $repoRoot "packaging\brand\code-icon.svg"
$previewDir = Join-Path $repoRoot ".build\shots"

# 16 是任务栏和资源管理器列表要用的最小尺寸，必须带上。
$icoSizes = @(16, 24, 32, 48, 64, 128, 256)

function Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }

# —— 读入并抠出不透明区域 ——

Step "Read $Source"
if (-not (Test-Path -LiteralPath $Source)) { throw "Missing $Source" }
$srcBmp = New-Object System.Drawing.Bitmap($Source)
$w = $srcBmp.Width
$h = $srcBmp.Height
Write-Host "    源图 ${w}x${h} ($($srcBmp.PixelFormat))"

$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$data = $srcBmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$px = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length)
$srcBmp.UnlockBits($data)
$srcBmp.Dispose()

Step "Detect content (threshold $Threshold)"
# alpha[y*w+x]：255 = 内容，0 = 背景
$alpha = New-Object byte[] ($w * $h)
$minX = $w; $maxX = -1; $minY = $h; $maxY = -1
for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $stride
  $first = -1; $last = -1
  for ($x = 0; $x -lt $w; $x++) {
    $o = $row + $x * 4
    if ($px[$o] -gt $Threshold -or $px[$o + 1] -gt $Threshold -or $px[$o + 2] -gt $Threshold) {
      if ($first -lt 0) { $first = $x }
      $last = $x
    }
  }
  if ($first -lt 0) { continue }
  $base = $y * $w
  for ($x = $first; $x -le $last; $x++) { $alpha[$base + $x] = 255 }
  if ($first -lt $minX) { $minX = $first }
  if ($last -gt $maxX) { $maxX = $last }
  if ($y -lt $minY) { $minY = $y }
  if ($y -gt $maxY) { $maxY = $y }
}
if ($maxX -lt 0) { throw "整张图都低于阈值，没有可用内容。" }

# 裁成正方形：以内容包围盒的中心为准，边长取长边，避免拉伸变形。
$bw = $maxX - $minX + 1
$bh = $maxY - $minY + 1
$side = [Math]::Max($bw, $bh)
$cx = [int](($minX + $maxX) / 2)
$cy = [int](($minY + $maxY) / 2)
$cropX = [Math]::Max(0, $cx - [int]($side / 2))
$cropY = [Math]::Max(0, $cy - [int]($side / 2))
if ($cropX + $side -gt $w) { $cropX = $w - $side }
if ($cropY + $side -gt $h) { $cropY = $h - $side }
Write-Host "    内容 ${bw}x${bh} @ ($minX,$minY)，裁为 ${side}x${side} @ ($cropX,$cropY)"

# —— 合成带透明通道的母版 ——

Step "Compose master with alpha"
$master = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$mrect = New-Object System.Drawing.Rectangle(0, 0, $side, $side)
$mdata = $master.LockBits($mrect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$mstride = $mdata.Stride
$mpx = New-Object byte[] ($mstride * $side)

for ($y = 0; $y -lt $side; $y++) {
  $sy = $cropY + $y
  $mrow = $y * $mstride
  $srow = $sy * $stride
  $arow = $sy * $w
  for ($x = 0; $x -lt $side; $x++) {
    $sx = $cropX + $x
    $mo = $mrow + $x * 4
    $so = $srow + $sx * 4
    $a = $alpha[$arow + $sx]
    if ($a -eq 0) {
      # 透明像素的 RGB 也要清掉：留着原来的黑色，缩放时会被插值带进边缘，出现黑边。
      $mpx[$mo] = 0; $mpx[$mo + 1] = 0; $mpx[$mo + 2] = 0; $mpx[$mo + 3] = 0
    }
    else {
      $mpx[$mo] = $px[$so]; $mpx[$mo + 1] = $px[$so + 1]; $mpx[$mo + 2] = $px[$so + 2]; $mpx[$mo + 3] = 255
    }
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($mpx, 0, $mdata.Scan0, $mpx.Length)
$master.UnlockBits($mdata)

# —— 缩放 ——

function Resize-Icon([System.Drawing.Bitmap]$src, [int]$size) {
  $out = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  # 不给 ImageAttributes 设 WrapMode 的话，边缘会去采样画布外的像素，缩小后出现一圈毛边。
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $dest = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $g.DrawImage($src, $dest, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
  $g.Dispose(); $attr.Dispose()
  return $out
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  # 逗号不能去掉：PowerShell 会把 return 的数组拆成流，调用方拿到的就成了 Object[]，
  # BinaryWriter 认不出这个类型，结果是目录项写对了、图像数据一个字节都没写进去，
  # 生成一个 118 字节的"合法但全空"的 ico —— 不会报错，只有看文件大小才发现。
  return , $bytes
}

# —— 预览：把各尺寸并排画在一张图上，按真实像素大小看小尺寸够不够清楚 ——

Step "Preview sheet"
New-Item -ItemType Directory -Force -Path $previewDir | Out-Null
$previewSizes = @(16, 24, 32, 48, 64, 128, 256)
$pad = 16
$sheetW = ($previewSizes | Measure-Object -Sum).Sum + $pad * ($previewSizes.Count + 1)
$sheetH = 256 + $pad * 2 + 18
foreach ($bg in @(@{ name = "light"; color = [System.Drawing.Color]::FromArgb(255, 240, 240, 240) },
                  @{ name = "dark"; color = [System.Drawing.Color]::FromArgb(255, 32, 32, 32) })) {
  $sheet = New-Object System.Drawing.Bitmap($sheetW, $sheetH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $sg = [System.Drawing.Graphics]::FromImage($sheet)
  $sg.Clear($bg.color)
  $x = $pad
  foreach ($s in $previewSizes) {
    $icon = Resize-Icon $master $s
    $sg.DrawImage($icon, $x, $pad + (256 - $s), $s, $s)
    $icon.Dispose()
    $x += $s + $pad
  }
  $sg.Dispose()
  $p = Join-Path $previewDir "logo-preview-$($bg.name).png"
  $sheet.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $sheet.Dispose()
  Write-Host "    $p"
}

if ($PreviewOnly) {
  Step "PreviewOnly：未改动仓库图标"
  $master.Dispose()
  exit 0
}

# —— 产出 ——

Step "Write $pngTarget"
$png128 = Resize-Icon $master 128
$png128.Save($pngTarget, [System.Drawing.Imaging.ImageFormat]::Png)
$png128.Dispose()

Step "Write $titlebarTarget"
# 标记本身是三维折面，描成矢量既费事又在 16px 下看不出区别，所以内嵌一张位图。
# 外面套 svg 是因为引用方是 CSS background-image，给的是 .svg 这个路径。
$tb64 = Resize-Icon $master 64
$tbBytes = Get-PngBytes $tb64
$tb64.Dispose()
$tbSvg = @"
<!-- 由 packaging/make-brand-assets.ps1 从 lingdong-source.png 生成，勿手改。 -->
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <image width="64" height="64" href="data:image/png;base64,$([Convert]::ToBase64String($tbBytes))"/>
</svg>
"@
[System.IO.File]::WriteAllText($titlebarTarget, $tbSvg, (New-Object System.Text.UTF8Encoding($false)))

Step "Write $icoTarget"
# ICO 允许每个条目直接放一整份 PNG（Vista 起支持），省掉 BMP + AND 掩码那套。
# 目录项里宽高各占一个字节，256 用 0 表示。
$entries = @()
foreach ($s in $icoSizes) {
  $b = Resize-Icon $master $s
  $entries += [pscustomobject]@{ Size = $s; Png = (Get-PngBytes $b) }
  $b.Dispose()
}
$ms = New-Object System.IO.MemoryStream
$bw2 = New-Object System.IO.BinaryWriter($ms)
$bw2.Write([uint16]0)
$bw2.Write([uint16]1)
$bw2.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $bw2.Write([byte]$(if ($e.Size -ge 256) { 0 } else { $e.Size }))
  $bw2.Write([byte]$(if ($e.Size -ge 256) { 0 } else { $e.Size }))
  $bw2.Write([byte]0)
  $bw2.Write([byte]0)
  $bw2.Write([uint16]1)
  $bw2.Write([uint16]32)
  $bw2.Write([uint32]$e.Png.Length)
  $bw2.Write([uint32]$offset)
  $offset += $e.Png.Length
}
foreach ($e in $entries) { $bw2.Write([byte[]]$e.Png) }
$bw2.Flush()
[System.IO.File]::WriteAllBytes($icoTarget, $ms.ToArray())
$bw2.Dispose(); $ms.Dispose()
$master.Dispose()

# 自检：上面那个"空 ico"是静默失败 —— 文件结构合法、能打开，就是一张图都没有。
# 不能用 System.Drawing.Icon 来验：它不支持 PNG 压缩的帧，而 256 那帧正是 PNG，
# 拿它去解会抛异常，看着像图标坏了，其实是这个 API 的老限制（Windows 自 Vista 起支持）。
# 所以直接按 ICO 目录逐条核对偏移、长度和 PNG magic。
$icoBytes = [System.IO.File]::ReadAllBytes($icoTarget)
$icoLen = $icoBytes.Length
if ($icoLen -le 6 + 16 * $icoSizes.Count + 1024) { throw "生成的 ico 只有 $icoLen 字节，图像数据没写进去。" }
$count = [BitConverter]::ToUInt16($icoBytes, 4)
if ($count -ne $icoSizes.Count) { throw "ico 目录声明 $count 项，应为 $($icoSizes.Count) 项。" }
for ($i = 0; $i -lt $count; $i++) {
  $at = 6 + 16 * $i
  $len = [BitConverter]::ToUInt32($icoBytes, $at + 8)
  $off = [BitConverter]::ToUInt32($icoBytes, $at + 12)
  if ($len -eq 0) { throw "ico 第 $i 项长度为 0。" }
  if ($off + $len -gt $icoBytes.Length) { throw "ico 第 $i 项越界（offset=$off len=$len 文件=$($icoBytes.Length)）。" }
  $sig = $icoBytes[$off..($off + 7)]
  if ($sig[0] -ne 0x89 -or $sig[1] -ne 0x50 -or $sig[2] -ne 0x4E -or $sig[3] -ne 0x47) {
    throw "ico 第 $i 项不是 PNG 数据。"
  }
}
Write-Host "    自检通过：$count 帧，均为有效 PNG"

Write-Host "完成：$icoTarget（$($icoSizes -join '/')，$([math]::Round($icoLen / 1KB, 1)) KB）" -ForegroundColor Green

# —— 无底板标记：侧边栏标题旁的小图 ——

if ($MarkSource) {
  Step "Mark from $MarkSource"
  if (-not (Test-Path -LiteralPath $MarkSource)) { throw "Missing $MarkSource" }
  $markTarget = Join-Path $repoRoot "vscode-extension\lingdong-agent\media\mark.png"

  $kb = New-Object System.Drawing.Bitmap($MarkSource)
  $kw = $kb.Width; $kh = $kb.Height
  $kd = $kb.LockBits((New-Object System.Drawing.Rectangle(0, 0, $kw, $kh)), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $kp = New-Object byte[] ($kd.Stride * $kh)
  [System.Runtime.InteropServices.Marshal]::Copy($kd.Scan0, $kp, 0, $kp.Length)
  $kb.UnlockBits($kd)
  $kb.Dispose()

  # 这里不能用上面那套逐行填充：那套假设形状是凸的，而这个标记的 L 与 > 之间有缺口，
  # 按行填会把缺口一起填实，抠出来是一坨实心块。所以逐像素判定，并在 lo~hi 之间做软过渡当抗锯齿。
  $lo = 8.0; $hi = 18.0
  $ka = New-Object byte[] ($kw * $kh)
  $kMinX = $kw; $kMaxX = -1; $kMinY = $kh; $kMaxY = -1
  for ($y = 0; $y -lt $kh; $y++) {
    $row = $y * $kd.Stride
    for ($x = 0; $x -lt $kw; $x++) {
      $o = $row + $x * 4
      $lum = 0.299 * $kp[$o + 2] + 0.587 * $kp[$o + 1] + 0.114 * $kp[$o]
      if ($lum -le $lo) { continue }
      $a = if ($lum -ge $hi) { 255 } else { [int](255 * ($lum - $lo) / ($hi - $lo)) }
      $ka[$y * $kw + $x] = [byte]$a
      if ($a -gt 128) {
        if ($x -lt $kMinX) { $kMinX = $x }; if ($x -gt $kMaxX) { $kMaxX = $x }
        if ($y -lt $kMinY) { $kMinY = $y }; if ($y -gt $kMaxY) { $kMaxY = $y }
      }
    }
  }
  if ($kMaxX -lt 0) { throw "标记图里没有高于阈值的内容。" }

  $mw = $kMaxX - $kMinX + 1
  $mh = $kMaxY - $kMinY + 1
  $mSide = [Math]::Max($mw, $mh)
  $mOx = [int]($kMinX - ($mSide - $mw) / 2)
  $mOy = [int]($kMinY - ($mSide - $mh) / 2)
  Write-Host "    标记 ${mw}x${mh}，裁为 ${mSide}x${mSide}"

  $markMaster = New-Object System.Drawing.Bitmap($mSide, $mSide, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $mmd = $markMaster.LockBits((New-Object System.Drawing.Rectangle(0, 0, $mSide, $mSide)), [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $mmb = New-Object byte[] ($mmd.Stride * $mSide)
  for ($y = 0; $y -lt $mSide; $y++) {
    for ($x = 0; $x -lt $mSide; $x++) {
      $sx = $mOx + $x; $sy = $mOy + $y
      if ($sx -lt 0 -or $sy -lt 0 -or $sx -ge $kw -or $sy -ge $kh) { continue }
      $a = $ka[$sy * $kw + $sx]
      if ($a -eq 0) { continue }
      $so = $sy * $kd.Stride + $sx * 4
      $mo = $y * $mmd.Stride + $x * 4
      $mmb[$mo] = $kp[$so]; $mmb[$mo + 1] = $kp[$so + 1]; $mmb[$mo + 2] = $kp[$so + 2]; $mmb[$mo + 3] = $a
    }
  }
  [System.Runtime.InteropServices.Marshal]::Copy($mmb, 0, $mmd.Scan0, $mmb.Length)
  $markMaster.UnlockBits($mmd)

  # 展示尺寸 20px，出 80px 供 400% 缩放下仍不糊。
  $mark = Resize-Icon $markMaster 80
  $mark.Save($markTarget, [System.Drawing.Imaging.ImageFormat]::Png)
  $mark.Dispose(); $markMaster.Dispose()
  Write-Host "侧边栏标记: $markTarget（$([math]::Round((Get-Item $markTarget).Length / 1KB, 1)) KB）" -ForegroundColor Green
}
