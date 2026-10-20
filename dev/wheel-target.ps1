# dsh-screenshot / dev/wheel-target.ps1 -- the "does this app honour a wheel message" fixture.
#
# WHAT IT IS: a real WinForms window whose scroll area is a multiline TextBox. It is a FIXTURE,
# not a product file: the AUTO long screenshot posts WM_MOUSEWHEEL at the target instead of
# moving the real cursor (R27), and whether an application acts on that is APP-SPECIFIC.
# Chromium was measured to honour it (DSH's own session list scrollTop 180 -> 0). WinForms was
# only ever ASSERTED in a comment ("WinForms routes by the REAL cursor position").
#
# WHY A TEXTBOX AND NOT A PANEL: a bare WinForms Panel is not selectable, so it never takes
# focus, and a ScrollableControl ignores the wheel while nothing inside it is focused (the
# classic "click the list before the wheel works"). The first version of this fixture used a
# Panel and answered "nothing scrolls" -- including for a REAL wheel, which proved the fixture
# was broken, not the hypothesis. A TextBox is focusable, scrolls on a real wheel, and its
# scroll position is readable from outside via EM_GETFIRSTVISIBLELINE (0xCE), so "did it really
# scroll" is a number and not an opinion.
#
# WHAT IT LOGS (one JSON object per line, appended to -Log):
#   * 'shown'  handles + geometry + dpi + the real cursor position at startup
#   * 'focus'  whether the editor really took focus (a failed focus must never look like a
#              verdict about wheel messages)
#   * 'wheel'  a WM_MOUSEWHEEL actually REACHED a control (form / editor), with the REAL cursor
#              position at that instant -- that is the number deciding whether WinForms routes
#              by lParam or by Cursor.Position
#   * 'line'   the first visible line CHANGED (the scroll really happened)
#   * 'cmd'    a command from -Control was obeyed ('top' reset)
#
# The node half is dev/wheel-target-probe.mjs. RUN IT FROM THE HOST: a low-integrity sandbox
# shell cannot post a message any medium-integrity app will act on.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File wheel-target.ps1 -Log <path> -Info <path> -Control <path>
#
# ASCII ONLY. Windows PowerShell 5.1 mis-decodes BOM-less UTF-8 as GBK and eats code lines.
param(
  [int]$Seconds = 60,
  [int]$X = 560,
  [int]$Y = 140,
  [int]$W = 660,
  [int]$H = 500,
  [int]$Lines = 300,
  [string]$Log = '',
  [string]$Info = '',
  [string]$Control = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# DPI first, window second -- without this the bounds we report are virtualised and the centre
# we hand back would not be the screen pixel the wheel message must carry.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshWheelTarget {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$script:dpiMode = 'none'
try { if ([DshWheelTarget]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $script:dpiMode = 'per-monitor-v2' } } catch {}
if ($script:dpiMode -eq 'none') { try { if ([DshWheelTarget]::SetProcessDPIAware()) { $script:dpiMode = 'system' } } catch {} }
$script:screenW = [DshWheelTarget]::GetSystemMetrics(0)
$script:screenH = [DshWheelTarget]::GetSystemMetrics(1)

if ($Log -eq '') { $Log = Join-Path $env:TEMP 'dsh-wheel-target.log' }
$script:logPath = $Log
Set-Content -Path $script:logPath -Value '' -Encoding UTF8

function Log($obj) {
  $line = if ($obj -is [string]) { $obj } else { $obj | ConvertTo-Json -Compress }
  [System.IO.File]::AppendAllText($script:logPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH-WHEEL-TARGET'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.FormBorderStyle = 'None'
$form.ClientSize = New-Object System.Drawing.Size($W, $H)
$form.TopMost = $true

$editor = New-Object System.Windows.Forms.TextBox
$editor.Multiline = $true
$editor.Dock = 'Fill'
$editor.ScrollBars = 'Vertical'
$editor.WordWrap = $false
$editor.ReadOnly = $true
$editor.Font = New-Object System.Drawing.Font('Consolas', 16, [System.Drawing.FontStyle]::Bold)
$editor.BackColor = [System.Drawing.Color]::FromArgb(8, 8, 10)
$editor.ForeColor = [System.Drawing.Color]::FromArgb(235, 235, 240)
$sb = New-Object System.Text.StringBuilder
$i = 1
while ($i -le $Lines) {
  [void]$sb.AppendLine(('BAND {0:D3} ----------------------------' -f $i))
  $i += 1
}
$editor.Text = $sb.ToString()
$form.Controls.Add($editor)

$script:wheelBy = @{}
$script:lastLine = -1

function FirstVisibleLine {
  # EM_GETFIRSTVISIBLELINE = 0x00CE. Works for any multiline EDIT / TextBox, from any thread.
  try {
    $r = [DshWheelTarget]::SendMessage($editor.Handle, 0x00CE, [IntPtr]::Zero, [IntPtr]::Zero)
    return [int]$r.ToInt64()
  } catch { return -1 }
}

$form.add_MouseWheel({
  param($s, $e)
  try {
    $c = [System.Windows.Forms.Cursor]::Position
    $script:wheelBy['form'] = 1 + [int]$script:wheelBy['form']
    Log @{ ok = $true; ev = 'wheel'; on = 'form'; delta = $e.Delta; x = $e.X; y = $e.Y; cx = $c.X; cy = $c.Y }
  } catch { Log @{ ok = $false; ev = 'wheel'; on = 'form'; error = "$_" } }
})
$editor.add_MouseWheel({
  param($s, $e)
  try {
    $c = [System.Windows.Forms.Cursor]::Position
    $script:wheelBy['editor'] = 1 + [int]$script:wheelBy['editor']
    Log @{ ok = $true; ev = 'wheel'; on = 'editor'; delta = $e.Delta; x = $e.X; y = $e.Y; cx = $c.X; cy = $c.Y }
  } catch { Log @{ ok = $false; ev = 'wheel'; on = 'editor'; error = "$_" } }
})
# vScroll / key presses are how a TextBox scrolls without the wheel; logging them makes "the
# content moved because of something else" visible instead of silently credited to the wheel.
$editor.add_KeyUp({ try { Log @{ ok = $true; ev = 'key'; line = (FirstVisibleLine) } } catch {} })

$form.add_Shown({
  try {
    $cr = $form.RectangleToScreen($form.ClientRectangle)
    $er = $editor.RectangleToScreen($editor.ClientRectangle)
    $centre = New-Object System.Drawing.Point(($er.X + [int]($er.Width / 2)), ($er.Y + [int]($er.Height / 2)))
    $c = [System.Windows.Forms.Cursor]::Position
    $payload = @{
      ok = $true; ev = 'shown'
      hwnd = [int]$form.Handle
      ehwnd = [int]$editor.Handle
      x = $cr.X; y = $cr.Y; w = $cr.Width; h = $cr.Height
      ex = $er.X; ey = $er.Y; ew = $er.Width; eh = $er.Height
      cx = $centre.X; cy = $centre.Y
      cursorX = $c.X; cursorY = $c.Y
      dpi = $script:dpiMode; screen = "$($script:screenW)x$($script:screenH)"
      lines = $Lines
    }
    if ($Info -ne '') {
      [System.IO.File]::WriteAllText($Info, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    }
    Log $payload
    # Focus the scroll area. A TextBox can take focus; if it does not, every later "did not
    # scroll" is unattributable, so the state is logged instead of assumed.
    try {
      $form.Activate()
      [void]$editor.Focus()
      Log @{ ok = $true; ev = 'focus'; editor = [bool]$editor.Focused; form = [bool]$form.Focused; line = (FirstVisibleLine) }
    } catch { Log @{ ok = $false; ev = 'focus'; error = "$_" } }
    $script:lastLine = FirstVisibleLine
  } catch { Log @{ ok = $false; ev = 'shown'; error = "$_" } }
})

# Poll the real scroll position: this is the ground truth, and reading it does not depend on
# any event arriving in a particular order.
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

# Control channel: node writes a command, we obey. 'top' must NOT use a wheel -- a reset that
# scrolls would itself prove the thing under test.
if ($Control -ne '') {
  $tick = New-Object System.Windows.Forms.Timer
  $tick.Interval = 120
  $tick.add_Tick({
    try {
      if (-not (Test-Path $Control)) { return }
      $body = ([System.IO.File]::ReadAllText($Control)).Trim()
      if ($body -eq 'q') {
        $tick.Stop()
        Log @{ ok = $true; ev = 'close'; wheelBy = $script:wheelBy }
        $form.Close()
        return
      }
      if ($body -eq 'top') {
        $editor.SelectionStart = 0
        $editor.SelectionLength = 0
        $editor.ScrollToCaret()
        $script:lastLine = FirstVisibleLine
        Log @{ ok = $true; ev = 'cmd'; cmd = 'top'; line = $script:lastLine }
        [System.IO.File]::WriteAllText($Control, '', (New-Object System.Text.UTF8Encoding($false)))
      }
    } catch {}
  })
  $tick.Start()
}

$close = New-Object System.Windows.Forms.Timer
$close.Interval = [Math]::Max(1000, $Seconds * 1000)
$close.add_Tick({
  try {
    $close.Stop()
    Log @{ ok = $true; ev = 'close'; reason = 'timeout'; wheelBy = $script:wheelBy }
    $form.Close()
  } catch {}
})
$close.Start()

[void]$form.ShowDialog()
Log @{ ok = $true; ev = 'exit'; wheelBy = $script:wheelBy }
