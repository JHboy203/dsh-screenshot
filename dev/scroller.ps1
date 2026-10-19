# dsh-scroller.ps1 - the test window that dev/hosttest.mjs drives for the long-capture groups.
#
# Contract (as consumed by dev/hosttest.mjs):
#   args   -X -Y -W -H  initial position (physical pixels)
#          -Control <file>  command file: "move x,y,w,h" | "<offset>" | "q"
#          -Info <file>     JSON {hwnd,x,y,w,h,offset} = CLIENT AREA in physical pixels
#          -Log <file>      one line per applied command (ground truth for the test)
#   the window shows a slice of a 12000px tall numbered bitmap; setting the offset moves the
#   slice by exactly that many pixels (that is what "scrolling" means to the capture path:
#   identical pixels stay identical, the rest changes).
#
# WHY IT LIVES IN dev/ (do not move it back into the lab dir): it is a hand-written FIXTURE,
# not an artifact. It used to sit in .tmp-shot-lab/host/, a cleanup pass deleted that folder,
# and host_selfcheck then died with "test window did not come up" while groups 3/4/7 quietly
# had nothing to run on. Fixtures belong next to the test that owns them.
#
# No C# in here on purpose: hosttest spawns this with **pwsh 7**, where Add-Type of inline
# C# does NOT get System.Windows.Forms on the reference list (5.1 implies it) and the compile
# fails with CS0234 -- and with stdio:'ignore' that failure is invisible. Pure PowerShell
# + a PictureBox has no such trap.
#
# Keep it ASCII-only: Windows PowerShell 5.1 decodes BOM-less UTF-8 as GBK and eats code lines.
param(
  [int]$X = 1798,
  [int]$Y = 130,
  [int]$W = 120,
  [int]$H = 880,
  [string]$Control = '',
  [string]$Info = '',
  [string]$Log = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# DPI must be declared BEFORE anything measures pixels: an unaware process reads a
# 1920x1080 screen as 1536x864 and every rectangle it writes back is wrong.
if (-not ('DshScrollDpi' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshScrollDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  public static void Make() {
    try { SetProcessDpiAwareness(2); } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
'@
}
[DshScrollDpi]::Make()

function Write-Log([string]$text) {
  if ($Log -eq '') { return }
  try {
    $stamp = (Get-Date).ToString('HH:mm:ss.fff')
    Add-Content -LiteralPath $Log -Value ("[" + $stamp + "] " + $text) -Encoding ascii
  } catch { }
}

# ---- the tall bitmap: 300 rows x 40px = 12000px of numbered, colour-cycling content ----
# Width is deliberately wider than any requested window: WinForms may hand back a
# ClientSize larger than the Bounds we asked for (default AutoScaleMode = Font), and
# a Clone() whose source rect is wider than the bitmap throws
# "An object could not be created, possibly due to a lack of memory" -- which an event
# handler swallows, so the symptom is "the test window never came up" with an empty log.
$RowH = 40
$Rows = 300
$TallPx = $RowH * $Rows
$BmpW = [Math]::Max(320, $W)
$bmp = New-Object System.Drawing.Bitmap -ArgumentList $BmpW, $TallPx
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Black)
$rowFont = New-Object System.Drawing.Font -ArgumentList 'Consolas', 11
for ($i = 0; $i -lt $Rows; $i++) {
  $rr = 40 + (($i * 53) % 180)
  $gg = 40 + (($i * 97) % 180)
  $bb = 40 + (($i * 31) % 180)
  $col = [System.Drawing.Color]::FromArgb(255, $rr, $gg, $bb)
  $br = New-Object System.Drawing.SolidBrush -ArgumentList $col
  $g.FillRectangle($br, 0, ($i * $RowH), $BmpW, ($RowH - 2))
  $br.Dispose()
  $g.DrawString(("ROW " + $i), $rowFont, [System.Drawing.Brushes]::White, 3, (($i * $RowH) + 9))
}
$g.Dispose()

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
# Take the requested rectangle literally: the default (Font) autoscale silently enlarges
# the window when it is shown, and then a slice of the requested width no longer fits.
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Text = 'dsh-scroller'
$form.BackColor = [System.Drawing.Color]::Black
$form.Bounds = New-Object System.Drawing.Rectangle -ArgumentList $X, $Y, $W, $H

$pic = New-Object System.Windows.Forms.PictureBox
$pic.Bounds = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $W, $H
$pic.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::StretchImage
$form.Controls.Add($pic)

$script:offset = 0
$script:current = $null

function Show-Slice() {
  $cw = [Math]::Max(1, $form.ClientSize.Width)
  $ch = [Math]::Max(1, $form.ClientSize.Height)
  # Clamp to the bitmap: a source rect wider/taller than the image makes Clone() throw,
  # and that throw happens inside an event handler where nobody sees it.
  if ($cw -gt $bmp.Width) { $cw = $bmp.Width }
  if ($ch -gt $bmp.Height) { $ch = $bmp.Height }
  $maxOff = [Math]::Max(0, $bmp.Height - $ch)
  if ($script:offset -lt 0) { $script:offset = 0 }
  if ($script:offset -gt $maxOff) { $script:offset = $maxOff }
  $rect = New-Object System.Drawing.Rectangle -ArgumentList 0, $script:offset, $cw, $ch
  $next = $bmp.Clone($rect, $bmp.PixelFormat)
  $old = $script:current
  $script:current = $next
  $pic.Image = $next
  $pic.Bounds = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $form.ClientSize.Width, $form.ClientSize.Height
  if ($null -ne $old) { try { $old.Dispose() } catch { } }
}

function Write-Info() {
  if ($Info -eq '') { return }
  try {
    $cr = $form.ClientRectangle
    $origin = $form.PointToScreen((New-Object System.Drawing.Point -ArgumentList 0, 0))
    $obj = [ordered]@{
      hwnd = [long]$form.Handle
      x = [int]$origin.X
      y = [int]$origin.Y
      w = [int]$cr.Width
      h = [int]$cr.Height
      offset = [int]$script:offset
    }
    Set-Content -LiteralPath $Info -Value ($obj | ConvertTo-Json -Compress) -Encoding ascii
  } catch { }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120
$timer.Add_Tick({
  $raw = ''
  try {
    if ($Control -ne '' -and (Test-Path -LiteralPath $Control)) {
      $raw = [string](Get-Content -LiteralPath $Control -Raw)
    }
  } catch { $raw = '' }
  if ($null -eq $raw) { return }
  $raw = $raw.Trim()
  if ($raw -eq '') { return }

  if ($raw -eq 'q') {
    $timer.Stop()
    Write-Log 'quit'
    try { $form.Close() } catch { }
    return
  }
  # 'h' / 's' = hide / show. hosttest 的遮挡守卫用例（3.1）靠它验"区域被盖住时必须暂停接帧"。
  if ($raw -eq 'h') {
    $form.Visible = $false
    Write-Info
    Write-Log 'hide'
    return
  }
  if ($raw -eq 's') {
    $form.Visible = $true
    Show-Slice
    Write-Info
    Write-Log 'show'
    return
  }
  if ($raw -match '^move\s+(-?\d+),(-?\d+),(\d+),(\d+)$') {
    $mx = [int]$matches[1]; $my = [int]$matches[2]
    $mw = [int]$matches[3]; $mh = [int]$matches[4]
    $form.Bounds = New-Object System.Drawing.Rectangle -ArgumentList $mx, $my, $mw, $mh
    Show-Slice
    Write-Info
    Write-Log ("move " + $mx + "," + $my + "," + $mw + "," + $mh)
    return
  }
  if ($raw -match '^(-?\d+)$') {
    $script:offset = [int]$matches[1]
    Show-Slice
    Write-Info
    Write-Log ("offset " + $script:offset)
    return
  }
})

$form.Add_Shown({
  Show-Slice
  Write-Info
  Write-Log ("shown " + $form.ClientSize.Width + "x" + $form.ClientSize.Height)
  $timer.Start()
})

[void]$form.ShowDialog()
$timer.Dispose()
try { if ($null -ne $script:current) { $script:current.Dispose() } } catch { }
try { $bmp.Dispose() } catch { }
Write-Log 'bye'
exit 0
