# dsh-screenshot - post ONE mouse-wheel message at a window's control (probe / fallback, R27/R29).
#
#   pwsh ... -File postwheel.ps1 -Hwnd 12345 -Delta -360 [-X 900 -Y 500] [-Times 3] [-Mode post|send] [-Resolve leaf|root]
#
# Why this exists: the AUTO long screenshot used to scroll by moving the REAL cursor into the
# region and calling mouse_event. That (a) takes the user's mouse away for the duration and
# (b) simply fails when the user is also using the mouse. A wheel message needs neither.
#
# WHO TO ADDRESS IT TO is the whole point of -Resolve (R29):
#   * leaf (default) - the control under (X,Y) via WindowFromPoint, i.e. the same window a real
#     wheel would land on. MEASURED: a WinForms TextBox scrolls for a leaf-addressed message and
#     does NOT scroll for one addressed to the top-level form.
#   * root - the old R27 behaviour (post at -Hwnd itself), kept so the two can be compared.
# With leaf, the message is only posted when that leaf still belongs to -Hwnd; otherwise it is
# REFUSED (`reason=point-moved`) rather than scrolling whatever window now happens to be there.
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
  [ValidateSet('post','send')][string]$Mode = 'post',
  [ValidateSet('leaf','root')][string]$Resolve = 'leaf'
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
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static IntPtr LeafAt(int x, int y) { POINT p; p.X = x; p.Y = y; return WindowFromPoint(p); }
  public static IntPtr RootOf(IntPtr h) { return h == IntPtr.Zero ? IntPtr.Zero : GetAncestor(h, 2); }
}
"@

$h = [IntPtr]::new($Hwnd)
$okWindow = [DshPostWheel]::IsWindow($h)
$overTarget = $true
$target = $h
if ($Resolve -eq 'leaf') {
  $leaf = [DshPostWheel]::LeafAt($X, $Y)
  $root = [DshPostWheel]::RootOf($leaf)
  if ($root -ne $h) {
    # The point is no longer over the window we were asked to scroll. Post nothing.
    $overTarget = $false
    $target = [IntPtr]::Zero
  } else {
    $target = $leaf
  }
}

$wp = [IntPtr]::new([int64]([int]($Delta * 65536)))
$lp = [IntPtr]::new([int64](((($Y -band 0xFFFF) -shl 16) -bor ($X -band 0xFFFF))))

$sent = 0
if ($target -ne [IntPtr]::Zero) {
  for ($i = 0; $i -lt [Math]::Max(1, $Times); $i++) {
    if ($Mode -eq 'send') {
      [void][DshPostWheel]::SendMessage($target, 0x020A, $wp, $lp)
      $sent += 1
    } else {
      if ([DshPostWheel]::PostMessage($target, 0x020A, $wp, $lp)) { $sent += 1 }
    }
    Start-Sleep -Milliseconds 40
  }
}

$reason = ''
if ($sent -le 0) { $reason = $(if (-not $overTarget) { 'point-moved' } else { 'rejected' }) }

Write-Output (([ordered]@{
  ok = [bool]($okWindow -and $sent -gt 0)
  hwnd = [long]$Hwnd
  target = [long]$target
  overTarget = [bool]$overTarget
  resolve = $Resolve
  mode = $Mode
  delta = $Delta
  x = $X
  y = $Y
  times = $Times
  sent = $sent
  windowValid = [bool]$okWindow
  reason = $reason
}) | ConvertTo-Json -Compress)
exit 0
