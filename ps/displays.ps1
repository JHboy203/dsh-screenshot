# dsh-screenshot - monitor / DPI / virtual-screen probe (read-only, R26).
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File displays.ps1
#
# Why this exists: the whole screenshot path is written against the VIRTUAL SCREEN
# (SM_X/Y/CX/CYVIRTUALSCREEN) and in PHYSICAL pixels. On a single 125% display that is
# impossible to get wrong by accident, so it stayed "written that way, never proven".
# The three cases that actually break it are:
#   * a second monitor at a NEGATIVE origin (left / above the primary),
#   * mixed DPI (one screen 100%, another 150%),
#   * a window that spans two monitors.
# This script reports the facts those cases change: virtual-screen rect, every monitor's
# rect + effective DPI, and the foreground window's rect + the live cursor, all in the
# same coordinate space the overlay/capture code uses (physical px, per-monitor aware).
#
# Output: one JSON line (project convention). Nothing here writes anything.
#
# ASCII only: the console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.
param()

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshDisplays {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool MonitorEnumProc(IntPtr h, IntPtr hdc, ref RECT r, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  // MDT_EFFECTIVE_DPI = 0. Returns 0 (S_OK) on Win8.1+; older Windows returns an error and
  // dpiX/dpiY stay 0 - reported as dpiHr so the caller can tell "96 default" from "unknown".
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  public static void MakeDpiAware() {
    try { SetProcessDpiAwareness(2); } catch { }   // PROCESS_PER_MONITOR_DPI_AWARE
    try { SetProcessDPIAware(); } catch { }        // fallback (Win7+)
  }

  // One JSON array, built inside C# because the HMONITOR only exists inside the callback.
  public static string MonitorJson() {
    var sb = new StringBuilder("[");
    bool first = true;
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr h, IntPtr hdc, ref RECT r, IntPtr d) {
      uint dx = 0; uint dy = 0;
      int hr = GetDpiForMonitor(h, 0, out dx, out dy);
      if (!first) sb.Append(",");
      first = false;
      sb.Append("{\"l\":" + r.L + ",\"t\":" + r.T + ",\"r\":" + r.R + ",\"b\":" + r.B +
                ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) +
                ",\"dpiX\":" + dx + ",\"dpiY\":" + dy + ",\"dpiHr\":" + hr + "}");
      return true;
    }, IntPtr.Zero);
    sb.Append("]");
    return sb.ToString();
  }

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    return sb.ToString();
  }
}
"@

# Must be declared BEFORE any coordinate is read (see MakeDpiAware).
[DshDisplays]::MakeDpiAware()

$cursor = New-Object DshDisplays+POINT
$cursorOk = [DshDisplays]::GetCursorPos([ref]$cursor)

$fg = [DshDisplays]::GetForegroundWindow()
$fgRect = New-Object DshDisplays+RECT
$fgOk = $false
if ($fg -ne [IntPtr]::Zero) { $fgOk = [DshDisplays]::GetWindowRect($fg, [ref]$fgRect) }
$fgTitle = ''
if ($fg -ne [IntPtr]::Zero) { $fgTitle = [DshDisplays]::Title($fg) }

$mons = [DshDisplays]::MonitorJson() | ConvertFrom-Json
$vLeft = [DshDisplays]::GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
$vTop = [DshDisplays]::GetSystemMetrics(77)    # SM_YVIRTUALSCREEN
$vWide = [DshDisplays]::GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
$vHigh = [DshDisplays]::GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN

# "negative origin" is THE multi-monitor signal: on a single primary display the virtual
# screen starts at 0,0, so a left/above monitor is the only way these go negative.
$negativeOrigin = ($vLeft -lt 0) -or ($vTop -lt 0)
$mixedDpi = $false
$seenDpi = @{}
foreach ($m in $mons) { if ($m.dpiX -gt 0) { $seenDpi[[string]$m.dpiX] = 1 } }
if ($seenDpi.Keys.Count -gt 1) { $mixedDpi = $true }

$out = [ordered]@{
  ok = $true
  virtual = [ordered]@{ left = $vLeft; top = $vTop; width = $vWide; height = $vHigh }
  monitorCount = @($mons).Count
  monitors = $mons
  negativeOrigin = [bool]$negativeOrigin
  mixedDpi = [bool]$mixedDpi
  cursor = [ordered]@{ ok = [bool]$cursorOk; x = [int]$cursor.X; y = [int]$cursor.Y }
  foreground = [ordered]@{
    ok = [bool]$fgOk
    hwnd = [long]$fg
    title = $fgTitle
    x = [int]$fgRect.L; y = [int]$fgRect.T
    w = [int]($fgRect.R - $fgRect.L); h = [int]($fgRect.B - $fgRect.T)
  }
  psVersion = $PSVersionTable.PSVersion.ToString()
}
Write-Output ($out | ConvertTo-Json -Compress -Depth 6)
exit 0
