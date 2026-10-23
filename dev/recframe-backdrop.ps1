# recframe-backdrop.ps1 -- FIXTURE: a window whose pixels are KNOWN, used as the ground truth
# under the recording frame (ps/recframe.ps1).
#
# WHY THIS FILE EXISTS (R53)
#   The frame probe used to prove "the frame did not paint over the interior" by capturing the
#   desktop twice and comparing. That made the verdict depend on the DESKTOP, not on the frame:
#
#     R35  the hard-coded bottom-right corner was covered by QQ; QQ animating moved the interior
#          from 100% to 71.9% unchanged -- read as "the frame painted into the picture";
#     R48  the candidate at 1677,757 sat on the DSH window's right edge while DSH was streaming;
#     R49  grid-search for "least covered + static" was the mitigation, not a fix;
#     2026-10-24 (measured on this machine): DSH 1619x1029@150,0 + Settings 1920x1020 +
#          Explorer 1268x759 left exactly one static slot -- 120x90 at (8,968). The SAME code then
#          gave 12/12 on one run and 11/12 in the aggregate, i.e. shot_gate({full:true}) sat at
#          3/4 for reasons that had nothing to do with the product.
#
#   This window removes the search step: it paints a checkerboard whose colours and cell size are
#   known, so the assertion becomes "at screen position (x,y) the expected colour is still there".
#   No timing, no desktop state, no other window's animations.
#
#   It is TOPMOST and takes the foreground once (AttachThreadInput first -- the foreground lock
#   refuses a plain SetForegroundWindow), because sitting under a maximized DSH is the normal case
#   here. The frame is created afterwards, which puts it above this window.
#
# ASCII ONLY. PS 5.1 decodes a BOM-less UTF-8 file as ANSI and can swallow code lines.
# Self-closing: -Seconds is a hard cap, so a crashed probe cannot leave it on screen forever.
param(
  [int]$X = 16,
  [int]$Y = 800,
  [int]$W = 360,
  [int]$H = 260,
  [int]$Cell = 30,
  [int]$Seconds = 180,
  [string]$Info = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshBackdropDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@

# Physical pixels BEFORE measuring anything (the probe speaks gdigrab coordinates).
$dpi = 'none'
try {
  if ([DshBackdropDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $dpi = 'per-monitor-v2' }
} catch { }
if ($dpi -eq 'none') {
  try { if ([DshBackdropDpi]::SetProcessDPIAware()) { $dpi = 'system' } } catch { }
}

$script:cell = [Math]::Max(4, $Cell)
$script:dark = [System.Drawing.Color]::FromArgb(255, 30, 36, 48)
$script:light = [System.Drawing.Color]::FromArgb(255, 216, 222, 233)
$script:brDark = New-Object System.Drawing.SolidBrush($script:dark)
$script:brLight = New-Object System.Drawing.SolidBrush($script:light)

$f = New-Object System.Windows.Forms.Form
$f.Text = 'DSH-RECFRAME-BACKDROP'
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.Bounds = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$f.TopMost = $true
$f.ShowInTaskbar = $false
$f.BackColor = $script:dark
$script:form = $f

# Checkerboard anchored at the CLIENT origin, so the probe can compute the expected colour from a
# screen position: cell index = floor((screen - clientOrigin) / cell).
$f.Add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.Clear($script:dark)
  $cw = $script:form.ClientSize.Width
  $ch = $script:form.ClientSize.Height
  $cs = $script:cell
  for ($cy = 0; $cy -lt $ch; $cy += $cs) {
    $iy = [int][Math]::Floor($cy / $cs)
    for ($cx = 0; $cx -lt $cw; $cx += $cs) {
      $ix = [int][Math]::Floor($cx / $cs)
      if ((($ix + $iy) % 2) -eq 1) {
        $g.FillRectangle($script:brLight, $cx, $cy, $cs, $cs)
      }
    }
  }
})

$f.Add_Shown({
  # TopMost alone cannot beat a topmost window that is also the ACTIVE one (measured with the
  # canary in R35): attach to the foreground thread, then raise.
  try {
    $fg = [DshBackdropDpi]::GetForegroundWindow()
    $tid = [DshBackdropDpi]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $my = [DshBackdropDpi]::GetCurrentThreadId()
    $attached = $false
    if ($tid -ne 0 -and $tid -ne $my) { $attached = [DshBackdropDpi]::AttachThreadInput($tid, $my, $true) }
    try {
      [void][DshBackdropDpi]::BringWindowToTop($script:form.Handle)
      [void][DshBackdropDpi]::SetForegroundWindow($script:form.Handle)
      $script:form.Activate()
    } finally {
      if ($attached) { [void][DshBackdropDpi]::AttachThreadInput($tid, $my, $false) }
    }
  } catch { }
  try {
    $r = $script:form.RectangleToScreen($script:form.ClientRectangle)
    $payload = @{
      ok    = $true
      hwnd  = [int]$script:form.Handle
      x     = $r.X
      y     = $r.Y
      w     = $r.Width
      h     = $r.Height
      cell  = $script:cell
      dark  = '30,36,48'
      light = '216,222,233'
      dpi   = $dpi
      fg    = ([int][DshBackdropDpi]::GetForegroundWindow() -eq [int]$script:form.Handle)
    }
    if ($Info -ne '') {
      [System.IO.File]::WriteAllText($Info, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    }
  } catch { }
  $t = New-Object System.Windows.Forms.Timer
  $t.Interval = [Math]::Max(1000, $Seconds * 1000)
  $t.Add_Tick({ $t.Stop(); $script:form.Close() })
  $t.Start()
})

[void]$f.ShowDialog()
