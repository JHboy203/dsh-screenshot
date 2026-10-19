# dsh-screenshot - post ONE mouse-wheel message to a window directly (probe, R27).
#
#   pwsh ... -File postwheel.ps1 -Hwnd 12345 -Delta -360 [-X 900 -Y 500] [-Times 3] [-Mode post|send]
#
# Why this exists: the AUTO long screenshot currently scrolls by moving the REAL cursor into the
# region and calling mouse_event. That (a) takes the user's mouse away for the duration and
# (b) simply fails when the user is also using the mouse (the cursor gets pulled off the point,
# and we then refuse to scroll rather than scroll somebody else's window).
# A wheel message addressed straight at the target window would avoid both - IF applications
# honour a posted/sent wheel. That is an empirical question per toolkit (WinForms routes the
# wheel by the REAL cursor position; Chromium's behaviour is what we actually care about), so
# this script exists to ask the question instead of assuming the answer.
#
# Prints one JSON line. Does not touch the cursor, does not focus anything.
#
# ASCII only: the console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.
param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [int]$Delta = -120,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Times = 1,
  [ValidateSet('post','send')][string]$Mode = 'post'
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshPostWheel {
  // WM_MOUSEWHEEL = 0x020A. wParam = (delta << 16) | keys, lParam = (y << 16) | (x & 0xFFFF)
  // in SCREEN coordinates (the message is normally sent to the focus window, but the point is
  // what apps use to decide which control / scroll container gets it).
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
}
"@

$h = [IntPtr]::new($Hwnd)
$okWindow = [DshPostWheel]::IsWindow($h)
$wp = [IntPtr]::new([int64]([int]($Delta * 65536)))
$lp = [IntPtr]::new([int64](((($Y -band 0xFFFF) -shl 16) -bor ($X -band 0xFFFF))))

$sent = 0
for ($i = 0; $i -lt [Math]::Max(1, $Times); $i++) {
  if ($Mode -eq 'send') {
    [void][DshPostWheel]::SendMessage($h, 0x020A, $wp, $lp)
    $sent += 1
  } else {
    if ([DshPostWheel]::PostMessage($h, 0x020A, $wp, $lp)) { $sent += 1 }
  }
  Start-Sleep -Milliseconds 40
}

Write-Output (([ordered]@{
  ok = [bool]($okWindow -and $sent -gt 0)
  hwnd = [long]$Hwnd
  mode = $Mode
  delta = $Delta
  x = $X
  y = $Y
  times = $Times
  sent = $sent
  windowValid = [bool]$okWindow
}) | ConvertTo-Json -Compress)
exit 0
