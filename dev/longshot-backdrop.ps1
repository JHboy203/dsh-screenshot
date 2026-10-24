# dsh-screenshot / dev/longshot-backdrop.ps1 -- the "did the long capture really stitch the
# right content" fixture.
#
# WHAT IT IS: a borderless WinForms window filled with a RichTextBox that holds N numbered
# bands, each band painted a DIFFERENT solid colour. It is a FIXTURE, not a product file.
#
# WHY IT EXISTS: until R58 the long capture (lib/scrollsession.mjs) had NO automated assertion
# about its OUTPUT. The probes we had prove wheel DELIVERY (dev/wheel-target-probe.mjs) and the
# recording frame, but nothing proved that the stitched .long.png contains the scrolled content
# in the right order. A stitcher that repeats a frame, drops a frame or seams at the wrong
# offset produces a plausible-looking picture and a correct-looking "height" number -- only
# reading the pixels back can tell. That is what this window makes possible: the colour under
# every row of the result is knowable in advance, so the probe can fold the image into runs and
# ask "are these bands 1,2,3,... in order, each exactly once".
#
# WHY A RichTextBox AND NOT A Panel: measured in dev/wheel-target.ps1 -- a bare WinForms Panel
# never takes focus, and a ScrollableControl ignores the wheel while nothing inside it is
# focused ("click the list before the wheel works"). A TextBox/RichTextBox is focusable and
# scrolls on a real wheel. The RichTextBox additionally allows a per-paragraph background
# colour (SelectionBackColor), which is the whole point here.
#
# WHAT IT LOGS (one JSON object per line, appended to -Log):
#   * 'shown'  hwnd + screen rect of the CLIENT area + per-band geometry/colour + dpi
#   * 'focus'  whether the editor really took focus (a failed focus must never look like a
#              verdict about wheel messages)
#   * 'wheel'  a WM_MOUSEWHEEL actually REACHED a control (form / editor)
#   * 'line'   the first visible line CHANGED (the scroll really happened -- ground truth)
#   * 'cmd'    a command from -Control was obeyed ('top' reset)
#
# The node half is dev/longshot-probe.mjs. RUN IT FROM THE HOST: a low-integrity sandbox shell
# cannot post a message any medium-integrity app will act on, and a window created there never
# reaches the interactive desktop.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File longshot-backdrop.ps1 `
#     -Info <path> -Log <path> -Control <path>
#
# ASCII ONLY. Windows PowerShell 5.1 mis-decodes BOM-less UTF-8 as GBK and eats code lines.
param(
  [int]$X = 560,
  [int]$Y = 140,
  [int]$W = 660,
  [int]$H = 520,
  [int]$Bands = 24,
  [int]$FontPt = 40,
  [int]$Spaces = 120,
  [int]$Seconds = 180,
  # 0 = hide the vertical scrollbar (clean content), 1 = keep it visible (the edge-chrome case
  # the stitcher has to survive: its thumb moves between frames).
  [int]$Scrollbar = 0,
  [string]$Log = '',
  [string]$Info = '',
  [string]$Control = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# DPI first, window second -- without this the bounds we report are virtualised and the rect we
# hand back would not be the screen pixels the capture must use.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshLongBackdrop {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool HideCaret(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowCaret(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowScrollBar(IntPtr h, int bar, bool show);
}
"@
$script:dpiMode = 'none'
try { if ([DshLongBackdrop]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $script:dpiMode = 'per-monitor-v2' } } catch {}
if ($script:dpiMode -eq 'none') { try { if ([DshLongBackdrop]::SetProcessDPIAware()) { $script:dpiMode = 'system' } } catch {} }
$script:screenW = [DshLongBackdrop]::GetSystemMetrics(0)
$script:screenH = [DshLongBackdrop]::GetSystemMetrics(1)

if ($Log -eq '') { $Log = Join-Path $env:TEMP 'dsh-longshot-backdrop.log' }
$script:logPath = $Log
Set-Content -Path $script:logPath -Value '' -Encoding UTF8

function Log($obj) {
  $line = if ($obj -is [string]) { $obj } else { $obj | ConvertTo-Json -Compress -Depth 6 }
  [System.IO.File]::AppendAllText($script:logPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

# Palette: a LUMA RAMP, not hues. This matters and was measured the hard way (R58):
# the stitcher matches frames on a GRAYSCALE, width-downscaled signature, so 24 bands of equal
# HSL lightness all become the SAME GRAY -- the overlap search then has almost no signal and
# picks spurious shifts (measured: 475 px for a pair that truly moved 237 px). Every band here
# therefore gets its own luma, ~8 levels apart, which is unmistakable in grayscale.
$script:palette = @()
$i = 0
while ($i -lt $Bands) {
  $l = [int][Math]::Round(26 + ($i * (232.0 - 26.0) / [Math]::Max(1, $Bands - 1)))
  $script:palette += ,@($l, $l, $l)
  $i += 1
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH-LONGSHOT-BACKDROP'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.FormBorderStyle = 'None'
$form.ClientSize = New-Object System.Drawing.Size($W, $H)
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(8, 8, 10)

$rtb = New-Object System.Windows.Forms.RichTextBox
$rtb.Dock = 'Fill'
$rtb.BorderStyle = 'None'
$rtb.WordWrap = $false
$rtb.ScrollBars = 'Vertical'
$rtb.DetectUrls = $false
$rtb.Font = New-Object System.Drawing.Font('Consolas', $FontPt, [System.Drawing.FontStyle]::Bold)
$rtb.BackColor = [System.Drawing.Color]::FromArgb(8, 8, 10)
$rtb.ForeColor = [System.Drawing.Color]::FromArgb(255, 255, 255)
$form.Controls.Add($rtb)

# Text first, colours second, ReadOnly last: a ReadOnly RichTextBox refuses formatting changes.
$pad = ' ' * [Math]::Max(8, $Spaces)
$starts = @()
$lens = @()
$i = 0
while ($i -lt $Bands) {
  $line = ('BAND {0:D2} ' -f ($i + 1)) + $pad
  $starts += $rtb.TextLength
  $rtb.AppendText($line)
  $lens += $line.Length
  if ($i -lt ($Bands - 1)) { $rtb.AppendText("`n") }
  $i += 1
}
$i = 0
while ($i -lt $Bands) {
  $col = $script:palette[$i]
  $rtb.Select($starts[$i], $lens[$i])
  $rtb.SelectionBackColor = [System.Drawing.Color]::FromArgb($col[0], $col[1], $col[2])
  # Contrast follows the band luma: white text on the dark half, black on the light half. The
  # probe samples a column to the RIGHT of the label, so the text never enters its reading --
  # but a label nobody can read is a fixture nobody can eyeball either.
  if ($col[0] -lt 140) { $rtb.SelectionColor = [System.Drawing.Color]::FromArgb(250, 250, 250) }
  else { $rtb.SelectionColor = [System.Drawing.Color]::FromArgb(10, 10, 10) }
  $i += 1
}
$rtb.Select(0, 0)
$rtb.ReadOnly = $true

# Hide the vertical scrollbar but keep the wheel working: a scrollbar THUMB MOVES between
# frames, i.e. it is a real pixel difference that the overlap search has to ignore (measured
# R58: with the scrollbar visible, only the colour runs to its left matched; 131 of 283 rows
# differed). Real apps do have scrollbars, but this fixture exists to judge the STITCHER, so
# the chrome that is not content must not be in the picture. -Scrollbar 1 keeps it visible on
# purpose: that arm (R59) is about the stitcher surviving a thumb that moves between frames.
if ($Scrollbar -eq 0) {
  try { $rtb.Handle | Out-Null; [void][DshLongBackdrop]::ShowScrollBar($rtb.Handle, 1, $false) } catch { Log @{ ok = $false; ev = 'hidescroll'; error = "$_" } }
}

$script:wheelOn = @{}
$script:lastLine = -1

function FirstVisibleLine {
  # EM_GETFIRSTVISIBLELINE = 0x00CE. Ground truth for "the content really scrolled".
  try {
    $r = [DshLongBackdrop]::SendMessage($rtb.Handle, 0x00CE, [IntPtr]::Zero, [IntPtr]::Zero)
    return [int]$r.ToInt64()
  } catch { return -1 }
}

$form.add_MouseWheel({
  param($s, $e)
  try { $script:wheelOn['form'] = 1 + [int]$script:wheelOn['form']; Log @{ ok = $true; ev = 'wheel'; on = 'form'; delta = $e.Delta } } catch {}
})
$rtb.add_MouseWheel({
  param($s, $e)
  try { $script:wheelOn['rtb'] = 1 + [int]$script:wheelOn['rtb']; Log @{ ok = $true; ev = 'wheel'; on = 'rtb'; delta = $e.Delta } } catch {}
})

$form.add_Shown({
  try {
    $cr = $form.RectangleToScreen($form.ClientRectangle)
    $er = $rtb.RectangleToScreen($rtb.ClientRectangle)
    $bandsInfo = @()
    $lineH = [int][Math]::Round($rtb.Font.GetHeight())
    $i = 0
    while ($i -lt $Bands) {
      $pt = $rtb.GetPositionFromCharIndex($starts[$i])
      $y = [int]$pt.Y
      $h = $lineH
      if ($i -lt ($Bands - 1)) {
        $pt2 = $rtb.GetPositionFromCharIndex($starts[$i + 1])
        $h = [int]$pt2.Y - $y
      }
      $bandsInfo += @{ i = ($i + 1); y = $y; h = $h; rgb = $script:palette[$i] }
      $i += 1
    }
    $totalH = 0
    foreach ($b in $bandsInfo) { $totalH = $totalH + [int]$b.h }
    $payload = @{
      ok = $true; ev = 'shown'
      hwnd = [int]$form.Handle
      rhwnd = [int]$rtb.Handle
      x = $cr.X; y = $cr.Y; w = $cr.Width; h = $cr.Height
      ex = $er.X; ey = $er.Y; ew = $er.Width; eh = $er.Height
      dpi = $script:dpiMode; screen = "$($script:screenW)x$($script:screenH)"
      bands = $bandsInfo
      totalH = $totalH
      lineH = $lineH
      fontPt = $FontPt
      padChars = $lens[0]
      scrollbar = $Scrollbar
    }
    if ($Info -ne '') {
      [System.IO.File]::WriteAllText($Info, ($payload | ConvertTo-Json -Compress -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    }
    Log $payload
    # Raise + focus: TopMost alone is not enough when the focused window is the DSH GUI (itself
    # topmost and ACTIVE) -- measured in dev/wheel-target.ps1. Append to the foreground thread
    # first, otherwise SetForegroundWindow is refused by the foreground lock.
    try {
      $fg = [DshLongBackdrop]::GetForegroundWindow()
      $tid = [DshLongBackdrop]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
      $my = [DshLongBackdrop]::GetCurrentThreadId()
      $attached = $false
      if ($tid -ne 0 -and $tid -ne $my) { $attached = [DshLongBackdrop]::AttachThreadInput($tid, $my, $true) }
      try {
        [void][DshLongBackdrop]::BringWindowToTop($form.Handle)
        [void][DshLongBackdrop]::SetForegroundWindow($form.Handle)
        $form.Activate()
      } finally {
        if ($attached) { [void][DshLongBackdrop]::AttachThreadInput($tid, $my, $false) }
      }
    } catch { Log @{ ok = $false; ev = 'raise'; error = "$_" } }
    try {
      [void]$rtb.Focus()
      # A focused RichEdit blinks a CARET, and a caret is a real pixel change: the session's
      # sha1 fingerprint then commits a frame whose content did not move at all (R58 measured
      # exactly this -- 11 frames for 7 scroll positions). Real content can blink too, so the
      # stitcher now has to tolerate it; but the FIXTURE must not generate that noise itself,
      # otherwise "the bands are in order" would be measuring the caret as much as the stitching.
      [void][DshLongBackdrop]::HideCaret($rtb.Handle)
      Log @{ ok = $true; ev = 'focus'; rtb = [bool]$rtb.Focused; form = [bool]$form.Focused; line = (FirstVisibleLine); fg = ([int][DshLongBackdrop]::GetForegroundWindow() -eq [int]$form.Handle) }
    } catch { Log @{ ok = $false; ev = 'focus'; error = "$_" } }
    $script:lastLine = FirstVisibleLine
  } catch { Log @{ ok = $false; ev = 'shown'; error = "$_" } }
})

$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 120
$poll.add_Tick({
  try {
    $v = FirstVisibleLine
    if ($v -ne $script:lastLine) {
      $script:lastLine = $v
      Log @{ ok = $true; ev = 'line'; v = $v }
    }
  } catch {}
})
$poll.Start()

if ($Control -ne '') {
  $tick = New-Object System.Windows.Forms.Timer
  $tick.Interval = 120
  $tick.add_Tick({
    try {
      if (-not (Test-Path $Control)) { return }
      $body = ([System.IO.File]::ReadAllText($Control)).Trim()
      if ($body -eq 'q') {
        $tick.Stop()
        Log @{ ok = $true; ev = 'close'; wheelOn = $script:wheelOn; line = $script:lastLine }
        $form.Close()
        return
      }
      if ($body -eq 'top') {
        # Same reason as 'scrollto': ScrollToCaret is a no-op on a ReadOnly RichTextBox.
        # Do NOT pre-update $script:lastLine here: the poll timer logs the change as a 'line'
        # event, and that log is the probe's ground truth for "the content really moved".
        [void][DshLongBackdrop]::SendMessage($rtb.Handle, 0x00B6, [IntPtr]::Zero, [IntPtr](-10000))
        Log @{ ok = $true; ev = 'cmd'; cmd = 'top'; line = (FirstVisibleLine) }
        [System.IO.File]::WriteAllText($Control, '', (New-Object System.Text.UTF8Encoding($false)))
        return
      }
      if ($body.StartsWith('scrollto ')) {
        # Deterministic positioning for a MANUAL-mode arm: an external actor moves the content
        # to a known offset and the session must commit exactly the frames it is given.
        # EM_LINESCROLL (0x00B6) with a RELATIVE line delta -- NOT Select()+ScrollToCaret():
        # measured (R58) that a ReadOnly RichTextBox silently ignores ScrollToCaret, so the
        # fixture "scrolled" nothing and every manual frame was the same picture.
        $idx = [int]$body.Substring(9)
        if ($idx -lt 0) { $idx = 0 }
        if ($idx -ge $Bands) { $idx = $Bands - 1 }
        $want = $idx - (FirstVisibleLine)
        [void][DshLongBackdrop]::SendMessage($rtb.Handle, 0x00B6, [IntPtr]::Zero, [IntPtr]$want)
        Log @{ ok = $true; ev = 'cmd'; cmd = 'scrollto'; at = $idx; want = $want; line = (FirstVisibleLine) }
        [System.IO.File]::WriteAllText($Control, '', (New-Object System.Text.UTF8Encoding($false)))
        return
      }
    } catch { Log @{ ok = $false; ev = 'cmd'; error = "$_" } }
  })
  $tick.Start()
}

$close = New-Object System.Windows.Forms.Timer
$close.Interval = [Math]::Max(1000, $Seconds * 1000)
$close.add_Tick({
  try {
    $close.Stop()
    Log @{ ok = $true; ev = 'close'; reason = 'timeout'; wheelOn = $script:wheelOn }
    $form.Close()
  } catch {}
})
$close.Start()

[void]$form.ShowDialog()
Log @{ ok = $true; ev = 'exit'; wheelOn = $script:wheelOn; line = $script:lastLine }
