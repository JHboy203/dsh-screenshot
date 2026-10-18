# dsh-screenshot - image toolbox (crop / scale / info), .NET System.Drawing only.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File imgtool.ps1 -Op crop  -In a.png -Out b.png -Rect 10,20,300,200
#   powershell ... -File imgtool.ps1 -Op scale -In a.png -Out b.jpg -MaxWidth 2560 -Quality 92
#   powershell ... -File imgtool.ps1 -Op info  -In a.png            (prints JSON)
#
# ASCII only: the console is GBK. Never prints Chinese.
param(
  [Parameter(Mandatory=$true)][ValidateSet('crop','scale','info')][string]$Op,
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
