# dsh-screenshot - render KNOWN text images for the OCR end-to-end probe (dev/ocr-probe.mjs).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File dev/ocr-fixture.ps1 -Spec spec.json
#
# WHY A SEPARATE RENDERER
#   ps/ocr_selftest.ps1 already renders one image and runs the CLI -- but it runs INSIDE PowerShell
#   as a child process, which DSH's file sandbox refuses ("could not launch a child PowerShell").
#   So the only place the OCR chain could be exercised was a human's terminal, and the gate never
#   ran it. This script only RENDERS; the probe (node, in the host) calls lib/shot.mjs#ocr() on the
#   PNGs, which is the exact path a user's screenshot takes. Rendering here is the part that needs
#   Windows' GDI+ and a real CJK font, so it cannot move into node.
#
# SPEC (written by the probe as UTF-8 JSON; ASCII-only source, no CJK literals in here -- this
# console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8, so text always travels
# through a file that is read explicitly as UTF-8):
#   {
#     "out": "D:\\...\\dir",
#     "cases": [
#       { "name": "light", "width": 900, "height": 240, "background": "#FFFFFF", "foreground": "#000000",
#         "lines": [ { "text": "<any unicode>", "px": 28 }, { "text": "DSH 2026", "px": 20 } ] },
#       { "name": "blank", "width": 400, "height": 120, "background": "#FFFFFF" }
#     ]
#   }
#
# Prints ONE JSON line on stdout: { ok, out, cases: [{ name, png, width, height, font, lines }], spec }.
# Exit 0 = all rendered, 2 = bad spec / nothing rendered, 3 = cannot render here (no GDI+ / no font).
#
# Notes that cost real time elsewhere:
#   * AntiAliasGridFit, not ClearType: sub-pixel fringes are noise to the OCR engine (measured).
#   * [Console]::OutputEncoding is forced to UTF-8 so the JSON line survives a GBK console.
#   * The PNG path is echoed back, so the probe never has to guess a filename.

param(
  [Parameter(Mandatory = $true)][string]$Spec
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Fail([int]$code, [string]$message) {
  $payload = [pscustomobject]@{ ok = $false; error = $message }
  Write-Output ($payload | ConvertTo-Json -Depth 4 -Compress)
  [Console]::Error.WriteLine('ocr-fixture: ' + $message)
  exit $code
}

if (-not (Test-Path -LiteralPath $Spec)) { Fail 2 ('spec not found: ' + $Spec) }

try {
  Add-Type -AssemblyName System.Drawing
} catch {
  Fail 3 ('System.Drawing unavailable: ' + $_.Exception.Message)
}

$raw = [System.IO.File]::ReadAllText($Spec, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($raw)) { Fail 2 'spec is empty' }
try { $cfg = $raw | ConvertFrom-Json } catch { Fail 2 ('spec is not JSON: ' + $_.Exception.Message) }

$out = [string]$cfg.out
if ([string]::IsNullOrWhiteSpace($out)) { $out = [System.IO.Path]::GetTempPath() }
if (-not (Test-Path -LiteralPath $out)) { New-Item -ItemType Directory -Path $out -Force | Out-Null }

function ConvertTo-Color([string]$text, [System.Drawing.Color]$fallback) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $fallback }
  try { return [System.Drawing.ColorTranslator]::FromHtml($text) } catch { return $fallback }
}

function Resolve-Font([single]$px) {
  $names = @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name })
  foreach ($want in @('Microsoft YaHei', 'SimSun', 'Arial')) {
    if ($names -contains $want) {
      return [System.Drawing.Font]::new($want, $px, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    }
  }
  return [System.Drawing.Font]::new([System.Drawing.FontFamily]::GenericSansSerif, $px, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
}

$cases = @()
$rendered = 0
foreach ($case in @($cfg.cases)) {
  if ($null -eq $case) { continue }
  $name = [string]$case.name
  if ([string]::IsNullOrWhiteSpace($name)) { Fail 2 'a case has no name' }
  $w = [int]$case.width; if ($w -le 0) { $w = 900 }
  $h = [int]$case.height; if ($h -le 0) { $h = 240 }
  $bg = ConvertTo-Color ([string]$case.background) ([System.Drawing.Color]::White)
  $fg = ConvertTo-Color ([string]$case.foreground) ([System.Drawing.Color]::Black)

  $png = [System.IO.Path]::Combine($out, ($name + '.png'))
  $bmp = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $fonts = @()
  $lines = @()
  try {
    $g.Clear($bg)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $brush = [System.Drawing.SolidBrush]::new($fg)
    $y = 12.0
    foreach ($line in @($case.lines)) {
      if ($null -eq $line) { continue }
      $text = [string]$line.text
      if ([string]::IsNullOrEmpty($text)) { continue }
      $px = [single]$line.px; if ($px -le 0) { $px = 24 }
      $font = Resolve-Font $px
      $fonts += $font
      $g.DrawString($text, $font, $brush, [System.Drawing.PointF]::new(20.0, [single]$y))
      $y = $y + [Math]::Ceiling($font.GetHeight($g)) + 6
      $lines += [pscustomobject]@{ text = $text; px = [int]$px; y = [int]$y }
    }
    $brush.Dispose()
  } finally {
    $g.Dispose()
  }
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  foreach ($f in $fonts) { $f.Dispose() }
  $rendered++
  $cases += [pscustomobject]@{ name = $name; png = $png; width = $w; height = $h; font = 'Microsoft YaHei|SimSun|Arial'; lines = @($lines) }
}

if ($rendered -eq 0) { Fail 2 'no case rendered' }

$payload = [pscustomobject]@{ ok = $true; out = $out; cases = @($cases); spec = $Spec }
Write-Output ($payload | ConvertTo-Json -Depth 8 -Compress)
exit 0
