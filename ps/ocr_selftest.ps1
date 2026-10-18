# dsh-screenshot - offline OCR self-test: render a KNOWN Chinese image, OCR it, prove the chain.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ps/ocr_selftest.ps1
#
# Prints ONE JSON line on stdout, then exits 0 (pass) / 1 (fail). No external input image needed:
# the image is drawn here with System.Drawing, so the test also works on a bare machine.
#
# pass rule
#   got contains >= 6 of the 14 distinct characters of line 1
#   AND the ASCII line came back with both "DSH" and "2026".
#   'ok' is the weaker pipeline fact: the OCR child ran with exit 0 and printed parseable JSON.
#
# ASCII-only source, deliberately: this console is GBK and Windows PowerShell 5.1 mis-decodes
# BOM-less UTF-8, so the test strings are rebuilt from code points instead of being written as
# literals (those code points were dumped from the real literals, not typed from memory).
# [Console]::OutputEncoding is forced to UTF-8 for the same reason capture.ps1 does it - PS 5.1's
# ConvertTo-Json does NOT escape non-ASCII, so the Chinese in this payload is raw UTF-8 and would
# otherwise be written as GBK and be undecodable by whoever reads this line.
#
# The child is spawned exactly the way the host spawns it (lib/shot.mjs): powershell.exe with
# -NoProfile -ExecutionPolicy Bypass -File <ps>/ocr_region.ps1 -Image <png> -Language auto -Json.
# Dot-sourcing is not an option: ocr_region.ps1 calls exit, which would kill this test.
# Start-Process is not an option either: under the DSH sandbox it fails with "Access is denied"
# even for a bare "cmd /c exit 7", while the call operator works and leaves the code in
# $LASTEXITCODE. $ErrorActionPreference is relaxed around the call so that a child writing to
# stderr (e.g. the exit-3 "no language pack" path) cannot abort the test.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing

function ConvertFrom-CodePoints([int[]]$cp) { -join ($cp | ForEach-Object { [char]$_ }) }

# line 1: "shen du qiu suo / jie tu cha jian / zhong wen shi bie ce shi"
$line1 = ConvertFrom-CodePoints @(0x6DF1, 0x5EA6, 0x6C42, 0x7D22, 0x0020, 0x622A, 0x56FE, 0x63D2, 0x4EF6, 0x0020, 0x4E2D, 0x6587, 0x8BC6, 0x522B, 0x6D4B, 0x8BD5)
$line2 = 'DSH screenshot OCR 2026'
# line 3: "ma sai ke / chang jie tu / lu ping / tie tu"
$line3 = ConvertFrom-CodePoints @(0x9A6C, 0x8D5B, 0x514B, 0x0020, 0x957F, 0x622A, 0x56FE, 0x0020, 0x5F55, 0x5C4F, 0x0020, 0x8D34, 0x56FE)

# the 14 distinct characters of line 1 - the CJK part of the pass rule
$cjkPool = @(0x6DF1, 0x5EA6, 0x6C42, 0x7D22, 0x622A, 0x56FE, 0x63D2, 0x4EF6, 0x4E2D, 0x6587, 0x8BC6, 0x522B, 0x6D4B, 0x8BD5) |
  ForEach-Object { [char]$_ }
$asciiMust = @('DSH', '2026')
$asciiAny = @('DSH', 'screenshot', 'OCR', '2026')

function Resolve-TestFont([single]$px) {
  $names = @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name })
  foreach ($want in @('Microsoft YaHei', 'SimSun', 'Arial')) {
    if ($names -contains $want) {
      return [System.Drawing.Font]::new($want, $px, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    }
  }
  return [System.Drawing.Font]::new([System.Drawing.FontFamily]::GenericSansSerif, $px, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
}

# Where to put the throwaway test PNG. Default is %TEMP%, but DSH's file sandbox DENIES writes
# under the user's temp directory (measured: UnauthorizedAccessException), so the self-test
# silently produced an unreadable input and reported pass=false with got="" - which looks
# exactly like "the OCR engine is broken". DSH_OCR_TMP lets a sandboxed caller point this at a
# writable directory; the plugin's own .cache is the natural choice there.
$tmpRoot = $env:DSH_OCR_TMP
if ([string]::IsNullOrWhiteSpace($tmpRoot)) { $tmpRoot = [System.IO.Path]::GetTempPath() }
if (-not (Test-Path -LiteralPath $tmpRoot)) { New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null }
$png = [System.IO.Path]::Combine($tmpRoot, ('dsh-ocr-selftest-' + [Guid]::NewGuid().ToString('N') + '.png'))

$exitCode = -1
$runError = ''
$raw = ''
$flat = ''
$lang = ''
$langs = @()
$cjkHits = 0
$asciiHits = 0
$mustOk = $false
$ok = $false
$pass = $false
$skipped = $false
$skipReason = ''
$info = $null

try {
  # -- step 1: render 900x220, white background, black text (see the header for the fonts) --
  $bmp = [System.Drawing.Bitmap]::new(900, 220, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $fonts = @()
  try {
    $g.Clear([System.Drawing.Color]::White)
    # Grey-scale anti-aliasing on purpose: ClearType sub-pixel fringes are noise to the engine.
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $f1 = Resolve-TestFont 28; $fonts += $f1
    $f2 = Resolve-TestFont 28; $fonts += $f2
    $f3 = Resolve-TestFont 20; $fonts += $f3
    $y = 12.0
    foreach ($pair in @(@($f1, $line1), @($f2, $line2), @($f3, $line3))) {
      $g.DrawString($pair[1], $pair[0], [System.Drawing.Brushes]::Black, [System.Drawing.PointF]::new(20.0, [single]$y))
      $y = $y + [Math]::Ceiling($pair[0].GetHeight($g)) + 6
    }
  } finally {
    $g.Dispose()
  }
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  foreach ($f in $fonts) { $f.Dispose() }

  # -- step 2: run the real OCR script the way the host runs it --
  $psExe = 'powershell.exe'
  $found = Get-Command $psExe -ErrorAction SilentlyContinue
  if ($null -ne $found) { $psExe = $found.Source }
  else { $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
  $ocrScript = Join-Path $PSScriptRoot 'ocr_region.ps1'

  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $captured = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File $ocrScript -Image $png -Language auto -Json 2>&1)
    $exitCode = $LASTEXITCODE
  } catch {
    $runError = $_.Exception.Message
    $exitCode = -1
  } finally {
    $ErrorActionPreference = $prevEap
  }
  $raw = (($captured | ForEach-Object { [string]$_ }) -join "`n")

  # -- step 2b: DID THE CHILD EVEN RUN? --
  #
  # Measured in DSH's file sandbox: a PowerShell process CANNOT spawn another PowerShell
  # process. The call operator returns instantly with no output and $LASTEXITCODE is never
  # set - so the script used to report pass=false, which reads as "the OCR engine is broken"
  # when in fact nothing was ever executed. Those are completely different facts and the
  # whole point of a self-test is to not confuse them. Report "skipped" instead, with a
  # distinct exit code (3) so a caller can tell the three states apart:
  #   0 = ran and passed   1 = ran and failed   3 = could not run here
  if ($raw.Trim() -eq '' -and $null -eq $exitCode) {
    $skipped = $true
    $skipReason = 'could not launch a child PowerShell from this shell (nested process creation is blocked in this sandbox); run the same check from node via lib/shot.mjs ocr(), or from an unrestricted shell'
  }

  # -- step 3: judge (the last line that starts with '{' is the payload) --
  $jsonLine = ''
  foreach ($ln in ($raw -split "`n")) {
    $t = $ln.Trim()
    if ($t.StartsWith('{')) { $jsonLine = $t }
  }
  if ($jsonLine -ne '') {
    try { $info = $jsonLine | ConvertFrom-Json } catch { $info = $null }
  }

  if ($null -ne $info) {
    if ($info.PSObject.Properties['text']) { $flat = (([string]$info.text) -replace '\s+', ' ').Trim() }
    if ($info.PSObject.Properties['lang']) { $lang = [string]$info.lang }
    if ($info.PSObject.Properties['langs']) { $langs = @($info.langs) }
  }

  $lower = $flat.ToLowerInvariant()
  foreach ($ch in $cjkPool) { if ($flat.IndexOf([string]$ch) -ge 0) { $cjkHits++ } }
  foreach ($t in $asciiAny) { if ($lower.IndexOf($t.ToLowerInvariant()) -ge 0) { $asciiHits++ } }
  $mustOk = $true
  foreach ($t in $asciiMust) { if ($lower.IndexOf($t.ToLowerInvariant()) -lt 0) { $mustOk = $false } }

  $ok = (($exitCode -eq 0) -and ($null -ne $info))
  $pass = ($ok -and ($cjkHits -ge 6) -and $mustOk)

  $payload = [pscustomobject]@{
    ok = $ok
    lang = $lang
    langs = @($langs)
    expected = ($line1 + ' | ' + $line2 + ' | ' + $line3)
    got = $flat
    cjkHits = $cjkHits
    asciiHits = $asciiHits
    pass = $pass
    # Three states: when skipped, pass is false but that does NOT mean OCR is broken -
    # it means this shell could not start a child process. Keep this comment ASCII.
    skipped = $skipped
    skipReason = $skipReason
  }

  Write-Output ($payload | ConvertTo-Json -Depth 6 -Compress)

  if ($skipped) {
    [Console]::Error.WriteLine('ocr_selftest SKIPPED (not a failure): ' + $skipReason)
  } elseif (-not $pass) {
    [Console]::Error.WriteLine('ocr_selftest FAIL: exit=' + $exitCode + ' cjkHits=' + $cjkHits +
      ' asciiHits=' + $asciiHits + ' mustAscii=' + $mustOk + ' jsonParsed=' + ($null -ne $info))
    if ($runError -ne '') { [Console]::Error.WriteLine('spawn: ' + $runError) }
    foreach ($ln in ($raw -split "`n")) {
      $t = $ln.Trim()
      if ($t -ne '' -and -not $t.StartsWith('{')) { [Console]::Error.WriteLine('child: ' + $t) }
    }
  }
} finally {
  Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
}

if ($pass) { exit 0 }
if ($skipped) { exit 3 }
exit 1
