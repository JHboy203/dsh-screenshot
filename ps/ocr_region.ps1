# dsh-screenshot - offline OCR of a region, using the Windows built-in engine.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr_region.ps1 -Image shot.png
#              [-Rect x,y,w,h] [-Upscale 3] [-Language auto]
#              [-Preprocess none|gray|contrast|invert|auto] [-Scale auto|fixed]
#              [-TargetHeight 26] [-Interp bicubic|bilinear|nearest]
#              [-Band] [-BandHeight 1200] [-BandOverlap 80] [-Json] [-Diag]
#
# MUST run under Windows PowerShell 5.1 (powershell.exe): pwsh 7's WinRT interop is incomplete.
#
# Language selection ('auto' is the default, and why)
#   The thing being OCR'd is a Chinese UI, so the engine has to be chosen deliberately.
#   TryCreateFromUserProfileLanguages() follows the *profile* language, and this machine's
#   profile can be English or Japanese while the screen is Chinese - and a wrong engine does
#   not fail, it silently returns garbage. 'auto' therefore walks a fixed priority list:
#     zh-Hans-CN -> zh-Hant-TW -> any tag starting "zh" -> ja -> ko
#     -> TryCreateFromUserProfileLanguages() -> first installed pack
#   The JSON reports both the winner (lang) and every installed tag (langs).
#
# SCALE (the big knob, and what changed here)
#   -Scale fixed  : scale = -Upscale exactly. This is the LEGACY pixel path and stays
#                   byte-compatible with the old script.
#   -Scale auto   : DEFAULT. A cheap 1x probe pass measures the median word height of the text
#                   that is actually there, then the real pass runs at
#                   s = TargetHeight / glyphHeight, clamped to [1, Upscale]. -Upscale is
#                   therefore read as a CEILING in this mode, not as a multiplier.
#   Why: the engine's own line normalisation already resamples each text line to a fixed working
#   height, so pre-upscaling helps while the glyphs are too small for the DETECTOR and starts to
#   hurt once they are not - and "too small" depends on the region, not on the caller. Measured
#   on the pinned DSH capture: the 14 px sidebar labels lose characters at 2x/3x while the 11 px
#   grey timestamps in the conversation list need 2x. One fixed number cannot serve both, which
#   is exactly why the default is now adaptive. -Upscale 3 (what lib/shot.mjs sends) still works
#   and is still the ceiling; it is no longer a hard multiplier.
#   The probe is not wasted: when it lands within 0.25 of the ideal scale its own result is
#   returned and the second pass is skipped.
#
# BANDING (-Band, for whole-screen / tall regions)
#   A tall region is cut into overlapping horizontal bands (source height ~BandHeight, overlap
#   ~BandOverlap), each band is scaled and recognised on its own, then the lines are mapped back
#   to source coordinates and de-duplicated (a line whose box overlaps an accepted line by >50%
#   vertically and >50% horizontally is the same line; the version with more characters wins).
#   Engine ceiling to respect: OcrEngine.MaxImageDimension is 10000 on this machine; without
#   banding a 1920x1080 screenshot at 3x is 5760x3240 (18.6 Mpx) of needless work for the same
#   recognition, and a 4K screenshot at 3x would be clamped and lose the small text entirely.
#
# PREPROCESS (ColorMatrix during the DrawImage that was already happening; alpha preserved)
#   none | gray | contrast | invert | auto
#   'auto' (DEFAULT) measures the region's mean luminance by downscaling the crop to 4x4 (cheap,
#   one small DrawImage) and picks 'invert' for a dark region (light text on a dark ground - the
#   engine is trained on dark-on-light, and inverting a #1e1e1e panel measurably beats leaving it)
#   and 'gray' otherwise.
#   ColorMatrix layout (measured on this machine, not guessed): with GDI+'s convention
#   out.c = in.r*M0c + in.g*M1c + in.b*M2c + M4c, the code below writes the luminance rows so
#   that pure red maps to (76,76,76). The transpose is NOT grey - pure red came out (76,150,29).
#
# Stdout encoding
#   Forced to UTF-8 without BOM, exactly like capture.ps1. This matters because PS 5.1's
#   ConvertTo-Json does NOT escape non-ASCII (measured: this payload carries raw Chinese), so
#   whatever the child's stdout encoder produces is what lib/shot.mjs receives - and it decodes
#   as utf8. Measured on this machine: the console output code page is already 65001, so the
#   line changes no bytes HERE (the ANSI code page is still gb2312); it is kept as the guard for
#   a console sitting at CP936, where PS 5.1 would emit gb2312 bytes and every Chinese character
#   would arrive as mojibake.
#
# Why it reads pixels with .NET instead of Windows.Storage.StorageFile:
#   GetFileFromPathAsync throws UnauthorizedAccessException 0x80070005 when the caller is not a
#   packaged app (the WinRT broker only grants app-data / whitelisted locations). Handing the
#   pixels to WinRT through an IBuffer (SoftwareBitmap.CreateCopyFromBuffer) needs no file grant.
#
# Structure notes (learned the hard way)
#   * The crop/upscale step writes a TEMP PNG and the OCR step then loads it from disk, exactly
#     like the already-proven whole-image OCR path. Mixing Rectangle + LockBits in the same
#     nested try made PowerShell 5.1 wrap the struct in a PSObject ("Cannot convert argument
#     rect ... {X=0,Y=0,...}"), so the two steps are kept apart. Every tile goes through the
#     same two-step helper, so there is only one such place to get right.
#   * No local may be called $rect (it IS the [string]$Rect parameter - PS variable names are
#     case-insensitive) and none may be called $scale (that is the -Scale parameter). Both
#     mistakes were made here; the symptoms are unrelated and ugly (LockBits: "Cannot convert
#     argument rect"; parameter binding: a String cannot become the [string]$Scale value).
#
# JSON contract (lib/shot.mjs#ocr reads these; extra fields are additive and safe):
#   ok / text / lines[{text,raw,words[]}] / lang / langs / width / height
#   plus diagnostics: scale, procW, procH, tiles, glyphH, preprocess, ms.
param(
  [Parameter(Mandatory=$true)][string]$Image,
  [string]$Rect = '',
  # In -Scale auto this is the CEILING; in -Scale fixed it is the multiplier (legacy).
  [double]$Upscale = 3,
  [string]$Language = 'auto',
  [ValidateSet('none','gray','contrast','invert','auto')][string]$Preprocess = 'auto',
  [ValidateSet('auto','fixed')][string]$Scale = 'auto',
  # Glyph height (px, source space) the engine likes to be handed. Swept with ps/ocr_bench.ps1.
  [double]$TargetHeight = 26,
  # Which percentile of the measured word heights counts as "the glyph height". 0.5 = median.
  # NOT 0.5 by default: a UI screenshot mixes sizes, and the failure that actually hurts is the
  # SMALLEST text (sidebar 11 px next to a 16 px chat body), so the reference has to come from the
  # small end. Measured on the DSH session capture: the median asked for 1.53x and left the
  # sidebar near 17 px, which is exactly where this engine starts returning CJK characters as
  # their radicals (the left-hand part of a character coming back on its own); the 25th percentile
  # asks for ~2.0-2.4x and puts those glyphs where the engine wants them.
  [double]$AutoPercentile = 0.25,
  [ValidateSet('bicubic','bilinear','nearest')][string]$Interp = 'bicubic',
  [switch]$Band,
  [int]$BandHeight = 1200,
  [int]$BandOverlap = 80,
  # Hard ceiling on the scaled pixel count, so a 3x of a 4K region cannot blow up memory/time.
  [int]$MaxPixels = 14000000,
  [switch]$Json,
  # Extra diagnostics on STDERR (never stdout - the host reads the last stdout line as JSON).
  [switch]$Diag
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$swTotal = [System.Diagnostics.Stopwatch]::StartNew()

function Write-Diag([string]$msg) {
  if ($Diag) { [Console]::Error.WriteLine('[ocr] ' + $msg) }
}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                 $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, [Type]$resultType) {
  $m = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

# --- CJK de-spacing -------------------------------------------------------------------------
#
# Windows.Media.Ocr splits CJK text into ONE WORD PER CHARACTER and then joins them with
# spaces for OcrLine.Text. Feed that straight into the chat box and Chinese comes out with a
# space between every glyph, which reads as "the OCR cannot recognise Chinese" even though every
# character was recognised correctly. Rebuild every line from its words, inserting a space only
# when NEITHER side of the seam is CJK, so a mixed Latin/CJK line keeps its real word boundaries.
#
# Ranges are expressed as code points, never as literals: this file must stay pure ASCII
# (Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code page - see the note in
# capture.ps1 about what that does to non-ASCII bytes).
function Test-CjkCodePoint([int]$cp) {
  return (($cp -ge 0x2E80 -and $cp -le 0x303F) -or   # CJK radicals + CJK punctuation
          ($cp -ge 0x3040 -and $cp -le 0x33FF) -or   # kana, Bopomofo, CJK compat
          ($cp -ge 0x3400 -and $cp -le 0x4DBF) -or   # CJK ext A
          ($cp -ge 0x4E00 -and $cp -le 0x9FFF) -or   # CJK unified
          ($cp -ge 0xF900 -and $cp -le 0xFAFF) -or   # CJK compat ideographs
          ($cp -ge 0xFE30 -and $cp -le 0xFE4F) -or   # CJK compat forms
          ($cp -ge 0xFF00 -and $cp -le 0xFFEF))      # fullwidth forms
}

function Join-OcrWords($words) {
  $sb = New-Object System.Text.StringBuilder
  $first = $true
  $prevCjk = $false
  foreach ($wo in $words) {
    $t = [string]$wo.Text
    if ($t.Length -eq 0) { continue }
    $curCjk = Test-CjkCodePoint ([int][char]$t[0])
    # Only a Latin/Latin seam earns a space. A space typed by the user inside a word stays,
    # because it is part of $t itself.
    if ((-not $first) -and (-not $prevCjk) -and (-not $curCjk)) { [void]$sb.Append(' ') }
    [void]$sb.Append($t)
    $prevCjk = Test-CjkCodePoint ([int][char]$t[$t.Length - 1])
    $first = $false
  }
  return $sb.ToString()
}

[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null

# Create an engine for one tag. The Language object is taken from AvailableRecognizerLanguages
# itself when possible: that reuses an already-projected WinRT object instead of activating
# Windows.Globalization.Language through New-Object, which is the fragile part of this path.
function New-OcrEngineFor([string]$tag) {
  $known = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
    Where-Object { $_.LanguageTag -eq $tag })
  if ($known.Count -gt 0) {
    return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($known[0])
  }
  try {
    $lang = New-Object Windows.Globalization.Language $tag
    return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  } catch {
    return $null
  }
}

# Build the ColorMatrix used by -Preprocess. $null for 'none' so the legacy path calls the
# exact same DrawImage overload it always did (no ImageAttributes in the pipeline at all).
function Get-PreprocessAttributes([string]$mode) {
  if ($mode -eq 'none') { return $null }
  $k = 1.0
  if ($mode -eq 'contrast') { $k = 1.35 }
  $m = New-Object System.Drawing.Imaging.ColorMatrix
  if ($mode -eq 'invert') {
    # out = 1 - in, per channel (alpha untouched: the 4th column stays as the identity row 3).
    $m.Matrix00 = -1.0
    $m.Matrix11 = -1.0
    $m.Matrix22 = -1.0
    $m.Matrix33 = 1.0
    $m.Matrix40 = 1.0
    $m.Matrix41 = 1.0
    $m.Matrix42 = 1.0
  } else {
    $m.Matrix00 = 0.299 * $k; $m.Matrix01 = 0.299 * $k; $m.Matrix02 = 0.299 * $k
    $m.Matrix10 = 0.587 * $k; $m.Matrix11 = 0.587 * $k; $m.Matrix12 = 0.587 * $k
    $m.Matrix20 = 0.114 * $k; $m.Matrix21 = 0.114 * $k; $m.Matrix22 = 0.114 * $k
    $m.Matrix33 = 1
    $m.Matrix44 = 1
    if ($mode -eq 'contrast') {
      # out = (in - 0.5) * k + 0.5  ->  offset = 0.5 * (1 - k) = -0.175
      $off = 0.5 * (1 - $k)
      $m.Matrix40 = $off; $m.Matrix41 = $off; $m.Matrix42 = $off
    }
  }
  $ia = New-Object System.Drawing.Imaging.ImageAttributes
  $ia.SetColorMatrix($m)
  return $ia
}

function Get-InterpMode([string]$name) {
  if ($name -eq 'nearest') { return [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor }
  if ($name -eq 'bilinear') { return [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear }
  return [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
}

# --- pixel helpers --------------------------------------------------------------------------

# Mean luminance of the source rectangle, 0..1. Done by downscaling the crop into a 4x4 bitmap
# and averaging those 16 pixels: one small DrawImage instead of a per-pixel loop over the region
# (PowerShell loops are ~1M ops/s, so a 1.6 Mpx loop would cost seconds; this costs microseconds).
function Get-RegionLuma($src, [int]$rx, [int]$ry, [int]$rw, [int]$rh) {
  $sm = [System.Drawing.Bitmap]::new(4, 4, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($sm)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $destRect = [System.Drawing.Rectangle]::new(0, 0, 4, 4)
    $srcRect = [System.Drawing.Rectangle]::new($rx, $ry, $rw, $rh)
    $g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  } finally {
    $g.Dispose()
  }
  $sum = 0.0
  for ($y = 0; $y -lt 4; $y++) {
    for ($x = 0; $x -lt 4; $x++) {
      $c = $sm.GetPixel($x, $y)
      $sum += (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
    }
  }
  $sm.Dispose()
  return ($sum / (16.0 * 255.0))
}

# Crop + scale (+ optional ColorMatrix) into a PNG on disk. Returns @(width, height) of the
# written tile. This is the ONLY place that touches DrawImage, and it always writes a file - the
# struct-marshalling lesson in the header is why the pixels are handed to WinRT via a reload
# rather than through the same nested try.
function Save-ScaledTile($src, [int]$rx, [int]$ry, [int]$rw, [int]$rh, [double]$s, [string]$pp, [string]$interpName, [string]$outPath) {
  $w = [int][Math]::Round($rw * $s)
  $h = [int][Math]::Round($rh * $s)
  if ($w -lt 1) { $w = 1 }
  if ($h -lt 1) { $h = 1 }
  $attrs = Get-PreprocessAttributes $pp
  $dst = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  try {
    $g.InterpolationMode = Get-InterpMode $interpName
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $destRect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
    if ($null -eq $attrs) {
      $srcRect = [System.Drawing.Rectangle]::new($rx, $ry, $rw, $rh)
      $g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    } else {
      $g.DrawImage($src, $destRect, $rx, $ry, $rw, $rh, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    }
  } finally {
    $g.Dispose()
    if ($null -ne $attrs) { $attrs.Dispose() }
  }
  $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()
  return @($w, $h)
}

# --- engine selection ---------------------------------------------------------
$availLangs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
  ForEach-Object { $_.LanguageTag })

if ([string]::IsNullOrWhiteSpace($Language)) { $Language = 'auto' }

$engine = $null
if ($Language -eq 'auto') {
  $pick = ''
  foreach ($want in @('zh-Hans-CN', 'zh-Hant-TW')) {
    if ($availLangs -contains $want) { $pick = $want; break }
  }
  if ($pick -eq '') {
    $zh = @($availLangs | Where-Object { $_ -like 'zh*' })
    if ($zh.Count -gt 0) { $pick = $zh[0] }
  }
  if ($pick -eq '' -and ($availLangs -contains 'ja')) { $pick = 'ja' }
  if ($pick -eq '' -and ($availLangs -contains 'ko')) { $pick = 'ko' }
  if ($pick -ne '') { $engine = New-OcrEngineFor $pick }
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine -and $availLangs.Count -gt 0) { $engine = New-OcrEngineFor $availLangs[0] }
} else {
  $engine = New-OcrEngineFor $Language
}
if ($null -eq $engine) {
  $avail = $availLangs -join ','
  Write-Error ("no OCR language pack installed; available: " + $avail)
  exit 3
}

$maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension

# --- source, rect, effective preprocess --------------------------------------
$srcPath = [System.IO.Path]::GetFullPath($Image)
$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('dsh-ocr-' + [Guid]::NewGuid().ToString('N')))
$rx = 0; $ry = 0; $rw = 0; $rh = 0
$ppUse = $Preprocess
$glyphH = 0.0
$scaleUsed = 1.0
$procW = 0; $procH = 0
$tileCount = 0
$tempFiles = New-Object System.Collections.Generic.List[string]

try {
  $rx = 0; $ry = 0; $rw = $src.Width; $rh = $src.Height
  if ($Rect -ne '') {
    $p = $Rect.Split(',') | ForEach-Object { [int]$_ }
    if ($p.Count -eq 4) {
      $rx = [Math]::Max(0, [Math]::Min($src.Width - 1, $p[0]))
      $ry = [Math]::Max(0, [Math]::Min($src.Height - 1, $p[1]))
      $rw = [Math]::Max(1, [Math]::Min($src.Width - $rx, $p[2]))
      $rh = [Math]::Max(1, [Math]::Min($src.Height - $ry, $p[3]))
    }
  }

  if ($ppUse -eq 'auto') {
    $luma = Get-RegionLuma $src $rx $ry $rw $rh
    if ($luma -lt 0.5) { $ppUse = 'invert' } else { $ppUse = 'gray' }
    Write-Diag ('luma=' + [Math]::Round($luma, 3) + ' preprocess=' + $ppUse)
  }

  if (-not (Test-Path -LiteralPath $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

  # Load a written tile back from disk and hand its pixels to WinRT.
  function Invoke-RecognizeFile([string]$path) {
    $bmp = [System.Drawing.Bitmap]::FromFile($path)
    $w = $bmp.Width
    $h = $bmp.Height
    # NOTE: do not name this $rect. PowerShell variable names are case-insensitive, so $rect
    #       IS the [string]$Rect parameter; assigning a Rectangle to it stringifies the value
    #       and LockBits then fails with
    #       "Cannot convert argument rect ... {X=0 is not a valid value for Int32}".
    $lockRect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($lockRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bytes = New-Object byte[] ($data.Stride * $h)
    try {
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    } finally {
      $bmp.UnlockBits($data)
    }
    $bmp.Dispose()
    $buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
    $swbmp = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer(
      $buffer, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $w, $h)
    return Await ($engine.RecognizeAsync($swbmp)) ([Windows.Media.Ocr.OcrResult])
  }

  # One tile: scale a source rectangle, recognise it, return lines in SOURCE coordinates.
  # Each line carries its character count so the band merge can pick the better of two readings.
  function Invoke-Tile($srcBmp, [int]$tx, [int]$ty, [int]$tw, [int]$th, [double]$s, [string]$pp, [int]$tag) {
    $path = [System.IO.Path]::Combine($tempDir, ('t' + $tag + '.png'))
    $dim = Save-ScaledTile $srcBmp $tx $ty $tw $th $s $pp $Interp $path
    if (-not $tempFiles.Contains($path)) { $tempFiles.Add($path) }
    $script:procW = $dim[0]
    $script:procH = $dim[1]
    $swRec = [System.Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-RecognizeFile $path
    $swRec.Stop()
    Write-Diag ('tile#' + $tag + ' src=' + $tw + 'x' + $th + ' -> ' + $dim[0] + 'x' + $dim[1] +
      ' s=' + [Math]::Round($s, 3) + ' ' + $swRec.ElapsedMilliseconds + 'ms')
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($line in $result.Lines) {
      $words = @()
      $x0 = [double]::MaxValue; $y0 = [double]::MaxValue
      $x1 = [double]::MinValue; $y1 = [double]::MinValue
      foreach ($wo in $line.Words) {
        $br = $wo.BoundingRect
        $wx = $tx + $br.X / $s
        $wy = $ty + $br.Y / $s
        $ww = $br.Width / $s
        $wh = $br.Height / $s
        $words += [pscustomobject]@{
          text = $wo.Text
          x = [Math]::Round($wx, 1)
          y = [Math]::Round($wy, 1)
          w = [Math]::Round($ww, 1)
          h = [Math]::Round($wh, 1)
        }
        if ($wx -lt $x0) { $x0 = $wx }
        if ($wy -lt $y0) { $y0 = $wy }
        if (($wx + $ww) -gt $x1) { $x1 = $wx + $ww }
        if (($wy + $wh) -gt $y1) { $y1 = $wy + $wh }
      }
      if ($words.Count -eq 0) { continue }
      # Rebuilt from words, not taken from $line.Text - see Join-OcrWords for why.
      $clean = Join-OcrWords $line.Words
      $chars = ($clean -replace '\s+', '').Length
      $out.Add([pscustomobject]@{
        text = $clean; raw = $line.Text; words = $words; chars = $chars
        x0 = [Math]::Round($x0, 1); y0 = [Math]::Round($y0, 1)
        x1 = [Math]::Round($x1, 1); y1 = [Math]::Round($y1, 1)
        seam = 0.0
      })
    }
    return $out.ToArray()
  }

  # --- scale decision ---------------------------------------------------------
  $sUsed = $Upscale
  if ($sUsed -lt 1) { $sUsed = 1 }
  # Path bookkeeping. A silent fallback is the most expensive bug shape in this plugin: every
  # branch that gives up on the preferred route records itself in $used / $fallback and both go
  # out in the JSON, so a caller can tell "recognised single pass" from "degraded to legacy".
  $usedPath = 'single'
  $fallback = ''
  if ($Scale -eq 'auto') {
    # Probe at 1x: cheap, and the result is reusable whenever the ideal scale turns out to be 1.
    $probe = Invoke-Tile $src $rx $ry $rw $rh 1.0 $ppUse 0
    $tileCount++
    $hs = @($probe | ForEach-Object { $_.y1 - $_.y0 } | Where-Object { $_ -gt 1 })
    if ($hs.Count -gt 0) {
      $sorted = @($hs | Sort-Object)
      $idx = [int][Math]::Floor($sorted.Count * $AutoPercentile)
      if ($idx -lt 0) { $idx = 0 }
      if ($idx -ge $sorted.Count) { $idx = $sorted.Count - 1 }
      $glyphH = [double]$sorted[$idx]
    }
    Write-Diag ('probe glyphH=' + [Math]::Round($glyphH, 2) + ' p=' + $AutoPercentile + ' lines=' + $probe.Count)
    if ($glyphH -le 0.5) {
      # Nothing measurable (blank region, or the detector found nothing at 1x): honour -Upscale.
      $sUsed = $Upscale
      if ($sUsed -lt 1) { $sUsed = 1 }
      $probe = $null
      $usedPath = 'fallback-upscale'
      $fallback = 'probe-empty'
    } else {
      $sUsed = $TargetHeight / $glyphH
      if ($sUsed -gt $Upscale) { $sUsed = $Upscale }
      if ($sUsed -lt 1) { $sUsed = 1 }
      if ([Math]::Abs($sUsed - 1.0) -le 0.25) { $sUsed = 1.0; $usedPath = 'probe' } else { $probe = $null }
    }
  } else {
    $usedPath = 'fixed'
  }
  # Respect the engine ceiling and the pixel budget.
  $cap = [Math]::Min($maxDim / [double]$rw, $maxDim / [double]$rh)
  $budget = [Math]::Sqrt($MaxPixels / [double]($rw * $rh))
  if ($sUsed -gt $cap) { $sUsed = $cap; $fallback = 'clamped-maxdim' }
  if ($sUsed -gt $budget) { $sUsed = $budget; $fallback = 'clamped-pixels' }
  if ($sUsed -lt 1) { $sUsed = 1 }
  $scaleUsed = $sUsed
  Write-Diag ('scale=' + [Math]::Round($scaleUsed, 3) + ' cap=' + [Math]::Round($cap, 2) + ' budget=' + [Math]::Round($budget, 2) + ' used=' + $usedPath)

  # --- tiles ------------------------------------------------------------------
  $bands = @()
  if ($Band -and $rh -gt [int]($BandHeight * 1.2)) {
    $y = $ry
    $ov = [Math]::Max(0, [Math]::Min($BandOverlap, [int]($BandHeight / 2)))
    $step = $BandHeight - $ov
    if ($step -lt 1) { $step = 1 }
    while ($y -lt ($ry + $rh)) {
      $h = [Math]::Min($BandHeight, ($ry + $rh) - $y)
      $bands += , @($rx, $y, $rw, $h)
      if (($y + $h) -ge ($ry + $rh)) { break }
      # Progress guard: a step that does not advance would loop forever (a short tail band with a
      # big overlap is exactly the case that produces it).
      $next = $y + [Math]::Max(1, ($h - $ov))
      if ($next -le $y) { break }
      $y = $next
    }
  } else {
    $bands += , @($rx, $ry, $rw, $rh)
  }

  $lines = New-Object System.Collections.Generic.List[object]
  $tagN = 1
  foreach ($b in $bands) {
    $bx = $b[0]; $by = $b[1]; $bw = $b[2]; $bh = $b[3]
    if ($bh -lt 1) { continue }
    $tileLines = @()
    if ($null -ne $probe -and $tagN -eq 1 -and $bands.Count -eq 1) {
      $tileLines = $probe
    } else {
      $tileLines = Invoke-Tile $src $bx $by $bw $bh $scaleUsed $ppUse $tagN
      $tileCount++
    }
    $tagN++
    foreach ($ln in $tileLines) {
      if ($bands.Count -eq 1) { $lines.Add($ln); continue }
      # Band merge: is this the same text line as one already accepted?
      # Distance from this band's own top/bottom edge: a line sliced by the seam is less trusted.
      $seam = [Math]::Min($ln.y0 - $by, ($by + $bh) - $ln.y1)
      $ln.seam = $seam
      $dup = $null
      foreach ($prev in $lines) {
        $ovY = [Math]::Min($ln.y1, $prev.y1) - [Math]::Max($ln.y0, $prev.y0)
        $hMin = [Math]::Min(($ln.y1 - $ln.y0), ($prev.y1 - $prev.y0))
        $ovX = [Math]::Min($ln.x1, $prev.x1) - [Math]::Max($ln.x0, $prev.x0)
        $wMin = [Math]::Min(($ln.x1 - $ln.x0), ($prev.x1 - $prev.x0))
        if ($hMin -gt 0 -and $wMin -gt 0 -and ($ovY / $hMin) -gt 0.5 -and ($ovX / $wMin) -gt 0.5) {
          $dup = $prev
          break
        }
      }
      if ($null -eq $dup) {
        $lines.Add($ln)
      } elseif (($ln.chars -gt $dup.chars) -or
                (($ln.chars -eq $dup.chars) -and ($ln.seam -gt $dup.seam))) {
        # Replace the accepted copy with the better reading (more characters, then less seam cut).
        $lines.Remove($dup)
        $lines.Add($ln)
      }
    }
  }

  # Stable reading order: top to bottom, then left to right.
  $arr = $lines.ToArray()
  $ordered = @($arr | Sort-Object -Property @{ Expression = { [Math]::Round($_.y0, 0) } }, @{ Expression = { $_.x0 } })

  $outLines = @()
  $all = New-Object System.Collections.Generic.List[string]
  foreach ($ln in $ordered) {
    $all.Add($ln.text)
    $outLines += [pscustomobject]@{
      text = $ln.text
      raw = $ln.raw
      words = $ln.words
      x = $ln.x0
      y = $ln.y0
      w = [Math]::Round($ln.x1 - $ln.x0, 1)
      h = [Math]::Round($ln.y1 - $ln.y0, 1)
    }
  }

  $swTotal.Stop()
  if ($bands.Count -gt 1 -and $usedPath -ne 'probe') { $usedPath = 'banded' }
  if ($Json) {
    $payload = [pscustomobject]@{
      ok = $true
      lang = $engine.RecognizerLanguage.LanguageTag
      langs = @($availLangs)
      width = $rw
      height = $rh
      text = ($all -join "`n")
      lines = $outLines
      # diagnostics (additive; lib/shot.mjs ignores unknown fields)
      # used: which route actually produced this text - 'single' | 'fixed' | 'probe' | 'banded' |
      #       'fallback-upscale'. Never let a degraded run look like a normal one.
      used = $usedPath
      fallback = $fallback
      scale = [Math]::Round($scaleUsed, 3)
      scaleMode = $Scale
      autoPct = $AutoPercentile
      procW = $procW
      procH = $procH
      tiles = $tileCount
      glyphH = [Math]::Round($glyphH, 2)
      preprocess = $ppUse
      interp = $Interp
      band = [bool]$Band
      ms = [int]$swTotal.ElapsedMilliseconds
    }
    Write-Output ($payload | ConvertTo-Json -Depth 8 -Compress)
  } else {
    foreach ($l in $all) { Write-Output $l }
  }
} finally {
  $src.Dispose()
  foreach ($f in $tempFiles) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tempDir -Force -Recurse -ErrorAction SilentlyContinue
}
