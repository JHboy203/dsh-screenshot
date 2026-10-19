# dsh-screenshot - image toolbox (crop / scale / info / stats), .NET System.Drawing only.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File imgtool.ps1 -Op crop  -In a.png -Out b.png -Rect 10,20,300,200
#   powershell ... -File imgtool.ps1 -Op scale -In a.png -Out b.jpg -MaxWidth 2560 -Quality 92
#   powershell ... -File imgtool.ps1 -Op info  -In a.png            (prints JSON)
#   powershell ... -File imgtool.ps1 -Op stats -In a.png            (mean luma + black ratio)
#
# Why `stats`: "the capture came out black" is the classic SILENT failure of CopyFromScreen
# (an off-screen / clamped source quietly yields black). Geometry alone cannot tell you that,
# so the clamp probe in tools.js asks for this number instead of trusting the size.
#
# ASCII only: the console is GBK. Never prints Chinese.
param(
  [Parameter(Mandatory=$true)][ValidateSet('crop','scale','info','stats')][string]$Op,
  [Parameter(Mandatory=$true)][string]$In,
  [string]$Out = '',
  [string]$Rect = '',
  [int]$MaxWidth = 0,
  [int]$Quality = 92
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile([System.IO.Path]::GetFullPath($In))
try {
  if ($Op -eq 'info') {
    Write-Output ("{{""width"":{0},""height"":{1}}}" -f $src.Width, $src.Height)
    return
  }

  if ($Op -eq 'stats') {
    # Sample every Nth pixel on a fixed grid: a 1920x1080 frame is ~2M pixels and GetPixel is
    # slow (~1us each), so 32x32 samples is plenty to answer "is this whole image black".
    $stepX = [Math]::Max(1, [int][Math]::Floor($src.Width / 32))
    $stepY = [Math]::Max(1, [int][Math]::Floor($src.Height / 32))
    $n = 0
    $sum = 0.0
    $dark = 0
    $minL = 255.0
    $maxL = 0.0
    for ($y = 0; $y -lt $src.Height; $y += $stepY) {
      for ($x = 0; $x -lt $src.Width; $x += $stepX) {
        $c = $src.GetPixel($x, $y)
        $l = (($c.R * 299) + ($c.G * 587) + ($c.B * 114)) / 1000.0
        $sum += $l
        if ($l -lt 8) { $dark += 1 }
        if ($l -lt $minL) { $minL = $l }
        if ($l -gt $maxL) { $maxL = $l }
        $n += 1
      }
    }
    $mean = 0.0
    if ($n -gt 0) { $mean = $sum / $n }
    $blackPct = 0.0
    if ($n -gt 0) { $blackPct = [Math]::Round(100.0 * $dark / $n, 2) }
    Write-Output ("{{""width"":{0},""height"":{1},""samples"":{2},""meanLuma"":{3},""minLuma"":{4},""maxLuma"":{5},""blackPct"":{6}}}" -f `
      $src.Width, $src.Height, $n, [Math]::Round($mean, 2), [Math]::Round($minL, 2), [Math]::Round($maxL, 2), $blackPct)
    return
  }

  if ($Op -eq 'crop') {
    if ($Rect -eq '') { throw 'crop needs -Rect x,y,w,h' }
    $p = $Rect.Split(',') | ForEach-Object { [int]$_ }
    if ($p.Count -ne 4) { throw 'Rect must be x,y,w,h' }
    $x = [Math]::Max(0, [Math]::Min($src.Width - 1, $p[0]))
    $y = [Math]::Max(0, [Math]::Min($src.Height - 1, $p[1]))
    $w = [Math]::Max(1, [Math]::Min($src.Width - $x, $p[2]))
    $h = [Math]::Max(1, [Math]::Min($src.Height - $y, $p[3]))
    $r = New-Object System.Drawing.Rectangle $x, $y, $w, $h
    $crop = $src.Clone($r, $src.PixelFormat)
    try { $crop.Save([System.IO.Path]::GetFullPath($Out), [System.Drawing.Imaging.ImageFormat]::Png) }
    finally { $crop.Dispose() }
    Write-Output ("cropped {0}x{1} -> {2}" -f $w, $h, $Out)
    return
  }

  if ($Op -eq 'scale') {
    if ($Out -eq '') { throw 'scale needs -Out' }
    $tw = $src.Width; $th = $src.Height
    if ($MaxWidth -gt 0 -and $src.Width -gt $MaxWidth) {
      $tw = $MaxWidth
      $th = [int][Math]::Round($src.Height * ($MaxWidth / $src.Width))
    }
    $dst = New-Object System.Drawing.Bitmap $tw, $th, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($dst)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($src, 0, 0, $tw, $th)
    } finally { $g.Dispose() }

    $full = [System.IO.Path]::GetFullPath($Out)
    $ext = [System.IO.Path]::GetExtension($full).ToLower()
    if ($ext -eq '.jpg' -or $ext -eq '.jpeg') {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $ps = New-Object System.Drawing.Imaging.EncoderParameters 1
      $ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([int64]$Quality)
      try { $dst.Save($full, $codec, $ps) } finally { $ps.Dispose() }
    } else {
      $dst.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $dst.Dispose()
    Write-Output ("scaled {0}x{1} -> {2}x{3} {4}" -f $src.Width, $src.Height, $tw, $th, $Out)
    return
  }
} finally {
  $src.Dispose()
}
