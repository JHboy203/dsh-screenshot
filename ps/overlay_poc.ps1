# overlay_poc.ps1 -- PROOF OF CONCEPT. Not product code, not wired into the plugin.
#
# QUESTION THIS ANSWERS (and nothing else):
#   Can a process on this machine put a borderless, topmost, full-virtual-desktop
#   window ON TOP OF the real desktop -- other applications included, DSH not
#   required to be visible or foreground -- show a FROZEN frame, let a human drag
#   a rectangle, hand that rectangle to the clipboard, and get out with Esc?
#
# WHY A SEPARATE PROCESS:
#   The DSH renderer can only draw inside its own window (a DOM plane), so a
#   selection made there can never sit on top of another application. Anything
#   that must cover the desktop has to own a real HWND. This is the same route
#   ps/pickwindow.ps1 already takes for window picking.
#
# DELIBERATELY NOT DONE HERE (one-off PoC, per the agreed scope):
#   * no resident helper -> pays the PowerShell cold start (~3-4s) every run
#   * no annotation, no OCR, no long shot, no pinning, no window picking
#   * nothing is wired into client.js / lib/*.mjs / index.js
#
# REUSED FROM ps/pickwindow.ps1 (measured there, re-verified here):
#   * DPI awareness must be set BEFORE the form is created, otherwise a 125%
#     display virtualises every rect and the overlay lands in the wrong place.
#   * the frozen frame is captured BEFORE the form is shown, otherwise the
#     overlay ends up inside its own picture.
#   * on success the form is hidden and given time to disappear before the
#     result is written, so a follow-up capture cannot include the overlay.
#
# OUTPUT: exactly one JSON object on stdout; diagnostics on stderr.
#   { ok, mode, x, y, w, h, screen:{x,y,w,h}, dpi, captureMs, clip, png, ms, error }
#   x/y/w/h are REAL screen pixels in virtual-desktop coordinates (may be negative).
#
# NOTE: file is ASCII only on purpose. The console is GBK and Windows PowerShell
# 5.1 decodes a BOM-less UTF-8 .ps1 as ANSI, which swallows code lines.
#
# EXAMPLES
#   powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File ps\overlay_poc.ps1 `
#       -OutJson .cache\poc.json -OutPng .cache\poc.png -TimeoutSec 45
#   powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File ps\overlay_poc.ps1 `
#       -SelfTest -OutJson .cache\poc-selftest.json -OutPng .cache\poc-selftest.png

param(
  [string]$OutJson = '',
  [string]$OutPng = '',
  [int]$TimeoutSec = 45,
  [int]$DimPercent = 55,
  [switch]$SelfTest,
  [int]$TestX = 200,
  [int]$TestY = 200,
  [int]$TestW = 320,
  [int]$TestH = 240
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Log([string]$m) { [Console]::Error.WriteLine('[overlay_poc] ' + $m) }

if (-not $OutJson) { $OutJson = Join-Path $env:TEMP ('overlay_poc_' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json') }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# ---------------------------------------------------------------- 1. DPI first
# Everything below measures pixels, so awareness has to be declared before any
# measurement. Measured in ps/pickwindow.ps1: without this, at 125% scaling a
# form asked for logical 300,300 opens somewhere else entirely.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PocDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
$script:dpiMode = 'none'
try { if ([PocDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $script:dpiMode = 'per-monitor-v2' } } catch { }
if ($script:dpiMode -eq 'none') { try { if ([PocDpi]::SetProcessDpiAwarenessContext([IntPtr](-3))) { $script:dpiMode = 'per-monitor' } } catch { } }
if ($script:dpiMode -eq 'none') { try { if ([PocDpi]::SetProcessDPIAware()) { $script:dpiMode = 'system-aware' } } catch { } }
Log ('dpi=' + $script:dpiMode)

# ------------------------------------------------------- 2. freeze the desktop
# One snapshot of the WHOLE virtual desktop (all monitors, negative origins OK),
# taken now, before any window of ours exists.
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
Log ('virtualscreen=' + $vs.X + ',' + $vs.Y + ' ' + $vs.Width + 'x' + $vs.Height)
if ($vs.Width -le 0 -or $vs.Height -le 0) { throw 'virtual screen has no area' }

$capStart = $sw.ElapsedMilliseconds
$script:frozenRaw = New-Object System.Drawing.Bitmap -ArgumentList $vs.Width, $vs.Height
$g0 = [System.Drawing.Graphics]::FromImage($script:frozenRaw)
try {
  $g0.CopyFromScreen($vs.X, $vs.Y, 0, 0, (New-Object System.Drawing.Size -ArgumentList $vs.Width, $vs.Height), [System.Drawing.CopyPixelOperation]::SourceCopy)
} catch {
  Log ('CopyFromScreen failed: ' + $_.Exception.Message)
  throw
} finally { $g0.Dispose() }
$script:captureMs = $sw.ElapsedMilliseconds - $capStart
Log ('capture=' + $script:captureMs + 'ms')

# Dimmed copy shown outside the selection: the desktop stays visible but clearly
# inactive, which is the visual cue that the overlay owns the screen right now.
$script:frozenDim = New-Object System.Drawing.Bitmap -ArgumentList $vs.Width, $vs.Height
$gd = [System.Drawing.Graphics]::FromImage($script:frozenDim)
$gd.DrawImage($script:frozenRaw, 0, 0, $vs.Width, $vs.Height)
$alpha = [int]([math]::Round(255.0 * $DimPercent / 100.0))
$dimBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb($alpha, 0, 0, 0))
$gd.FillRectangle($dimBrush, 0, 0, $vs.Width, $vs.Height)
$gd.Dispose()
$dimBrush.Dispose()

# ------------------------------------------------------------------ 3. the form
$script:selStart = $null
$script:selEnd = $null
$script:done = $false
$script:cancelled = $false
$script:result = $null
$script:ticksLeft = $TimeoutSec * 2

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Bounds = New-Object System.Drawing.Rectangle -ArgumentList $vs.X, $vs.Y, $vs.Width, $vs.Height
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.KeyPreview = $true
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.BackColor = [System.Drawing.Color]::Black
$form.Text = 'overlay_poc'
try { $form.DoubleBuffered = $true } catch { }

$accent = [System.Drawing.Color]::FromArgb(255, 76, 141, 255)
$font = New-Object System.Drawing.Font -ArgumentList 'Consolas', 11

function Get-SelectionRect {
  if ($null -eq $script:selStart -or $null -eq $script:selEnd) { return $null }
  $x1 = [math]::Min($script:selStart.X, $script:selEnd.X)
  $y1 = [math]::Min($script:selStart.Y, $script:selEnd.Y)
  $w = [math]::Abs($script:selEnd.X - $script:selStart.X)
  $h = [math]::Abs($script:selEnd.Y - $script:selStart.Y)
  return (New-Object System.Drawing.Rectangle -ArgumentList $x1, $y1, $w, $h)
}

# Crop -> clipboard -> PNG -> JSON. Shared by the drag path and -SelfTest so the
# verifiable half does not depend on a human being able to move the mouse.
function Complete-Selection {
  param([System.Drawing.Rectangle]$rect)
  if ($script:done) { return }
  $script:done = $true
  $ok = $false
  $err = ''
  $clipOk = $false
  $pngPath = ''
  try {
    if ($rect.Width -lt 2 -or $rect.Height -lt 2) { throw 'selection too small' }
    $crop = New-Object System.Drawing.Bitmap -ArgumentList $rect.Width, $rect.Height
    $cg = [System.Drawing.Graphics]::FromImage($crop)
    $dst = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $rect.Width, $rect.Height
    $cg.DrawImage($script:frozenRaw, $dst, $rect, [System.Drawing.GraphicsUnit]::Pixel)
    $cg.Dispose()
    try { [System.Windows.Forms.Clipboard]::SetImage($crop); $clipOk = $true } catch { Log ('clipboard: ' + $_.Exception.Message) }
    if ($OutPng) {
      $crop.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
      $pngPath = $OutPng
    }
    $crop.Dispose()
    $ok = $true
  } catch {
    $err = $_.Exception.Message
    Log ('complete failed: ' + $err)
  }
  $script:result = @{
    ok        = $ok
    mode      = 'drag'
    x         = ($vs.X + $rect.X)
    y         = ($vs.Y + $rect.Y)
    w         = $rect.Width
    h         = $rect.Height
    screenX   = $vs.X
    screenY   = $vs.Y
    screenW   = $vs.Width
    screenH   = $vs.Height
    dpi       = $script:dpiMode
    captureMs = $script:captureMs
    clip      = $clipOk
    png       = $pngPath
    error     = $err
  }
  # Hide first, and give the compositor a moment: a still-visible overlay would
  # be in the very next screen capture (same lesson as ps/pickwindow.ps1).
  try {
    $form.Hide()
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 150
  } catch { }
  $script:result.ms = $sw.ElapsedMilliseconds
  $json = $script:result | ConvertTo-Json -Compress
  try {
    $dir = Split-Path -Parent $OutJson
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($OutJson, $json, [System.Text.UTF8Encoding]::new($false))
  } catch { Log ('write json failed: ' + $_.Exception.Message) }
  [Console]::Out.WriteLine($json)
  try { $form.Close() } catch { }
}

$form.Add_Paint({
  param($sender, $e)
  $e.Graphics.DrawImage($script:frozenDim, 0, 0)
  $r = Get-SelectionRect
  if ($null -ne $r -and $r.Width -gt 1 -and $r.Height -gt 1) {
    $state = $e.Graphics.Save()
    $e.Graphics.SetClip($r, [System.Drawing.Drawing2D.CombineMode]::Replace)
    $e.Graphics.DrawImage($script:frozenRaw, 0, 0)
    $e.Graphics.Restore($state)
    $pen = New-Object System.Drawing.Pen -ArgumentList $accent, 2
    $e.Graphics.DrawRectangle($pen, $r.X, $r.Y, $r.Width, $r.Height)
    $pen.Dispose()
    $label = '' + $r.Width + ' x ' + $r.Height
    $e.Graphics.DrawString($label, $font, [System.Drawing.Brushes]::White, ($r.X + 4), ($r.Y + $r.Height + 4))
  }
})

$form.Add_MouseDown({
  param($sender, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  $script:selStart = $e.Location
  $script:selEnd = $e.Location
  $form.Invalidate()
})

$form.Add_MouseMove({
  param($sender, $e)
  if ($null -eq $script:selStart) { return }
  $script:selEnd = $e.Location
  $form.Invalidate()
})

$form.Add_MouseUp({
  param($sender, $e)
  if ($null -eq $script:selStart) { return }
  $script:selEnd = $e.Location
  $r = Get-SelectionRect
  if ($null -eq $r -or $r.Width -lt 2 -or $r.Height -lt 2) {
    $script:selStart = $null
    $script:selEnd = $null
    $form.Invalidate()
    return
  }
  Complete-Selection -rect $r
})

$form.Add_KeyDown({
  param($sender, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
    $script:cancelled = $true
    $script:result = @{ ok = $false; mode = 'esc'; error = 'cancelled'; ms = $sw.ElapsedMilliseconds }
    try { $form.Close() } catch { }
  }
})

# Hard timeout: the PoC must never be able to outlive its own demo.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  $script:ticksLeft = $script:ticksLeft - 1
  if ($script:ticksLeft -le 0 -and -not $script:done) {
    $script:done = $true
    $script:result = @{ ok = $false; mode = 'timeout'; error = 'timeout'; ms = $sw.ElapsedMilliseconds }
    try { $form.Close() } catch { }
  }
})

if ($SelfTest) {
  $timer2 = New-Object System.Windows.Forms.Timer
  $timer2.Interval = 1500
  $timer2.Add_Tick({
    $timer2.Stop()
    $r = New-Object System.Drawing.Rectangle -ArgumentList $TestX, $TestY, $TestW, $TestH
    $script:selStart = New-Object System.Drawing.Point -ArgumentList $TestX, $TestY
    $script:selEnd = New-Object System.Drawing.Point -ArgumentList ($TestX + $TestW), ($TestY + $TestH)
    $form.Invalidate()
    [System.Windows.Forms.Application]::DoEvents()
    Complete-Selection -rect $r
  })
  $script:selfTestTimer = $timer2
  $form.Add_Shown({ $script:selfTestTimer.Start() })
}

$form.Add_Shown({ $timer.Start() })

try {
  [void]$form.ShowDialog()
} catch {
  Log ('showdialog failed: ' + $_.Exception.Message)
  if ($null -eq $script:result) {
    $script:result = @{ ok = $false; mode = 'error'; error = $_.Exception.Message; ms = $sw.ElapsedMilliseconds }
    $json2 = $script:result | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($OutJson, $json2, [System.Text.UTF8Encoding]::new($false))
    [Console]::Out.WriteLine($json2)
  }
}

$timer.Dispose()
if ($null -ne $script:selfTestTimer) { try { $script:selfTestTimer.Dispose() } catch { } }
try { $form.Dispose() } catch { }
try { $script:frozenRaw.Dispose() } catch { }
try { $script:frozenDim.Dispose() } catch { }
Log 'done'
