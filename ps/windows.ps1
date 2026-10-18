# DSH screenshot plugin - host-side window enumerator (the window picker's data source).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File windows.ps1 [-Json] [options]
#
#   -Json                 print ONE compressed JSON line to stdout
#   -ExcludeTitle <str>   skip titles containing this substring (default "DeepSeek Harness")
#   -MinWidth  <int>      drop windows narrower than this (default 120)
#   -MinHeight <int>      drop windows shorter than this (default 90)
#   -Limit     <int>      at most this many entries, topmost first (default 60)
#
# JSON: {"ok":true,"count":N,"windows":[{"hwnd":123,"title":"..","class":"..","pid":1,
#        "x":0,"y":0,"w":1600,"h":900,"min":false,"z":0}, ...]}
#   Every field is always present and always the same type (never undefined/null), because the
#   host parses this with JSON.parse and feeds a picker: a missing key there is a blank row.
#   hwnd is a JS-safe integer (window handles are 32-bit values, well under 2^53).
#   "windows" is ALWAYS a JSON array, including when it holds 0 or 1 entry - see the note
#   about ConvertTo-Json below, that is not what PS 5.1 does by default.
#
# Design notes
#   * ASCII only: the console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.
#     Real window titles are usually non-ASCII - they survive because we print via
#     [Console]::OutputEncoding = UTF8, not because they are escaped. Never Write-Host a title.
#   * No WinRT here, so pwsh 7 and powershell.exe both work.
#   * DPI: without MakeDpiAware() a non-aware caller gets *virtualised* rects, and the picker
#     would draw its highlight boxes scaled on a 125%/150% display. Set awareness first.
param(
  [switch]$Json,
  [string]$ExcludeTitle = 'DeepSeek Harness',
  # List DSH itself too. Why a switch instead of letting the caller pass -ExcludeTitle '':
  # measured, `powershell.exe -File windows.ps1 -ExcludeTitle ''` FAILS TO BIND
  # ("Missing an argument for parameter 'ExcludeTitle'") - Windows argv parsing strips the
  # quotes, so the exe receives a valueless parameter. Inside the script
  # [string]::IsNullOrEmpty already treats '' as "no filter", but that branch is unreachable
  # from the command line. The window picker must be able to offer the DSH window, so it gets
  # a switch that survives argv.
  [switch]$KeepSelf,
  [int]$MinWidth = 120,
  [int]$MinHeight = 90,
  [int]$Limit = 60
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Version-suffixed class name: if a *future* edit adds a helper, bump this suffix so a session
# that already loaded the old type does not silently keep using it (Add-Type is per-process).
if (-not ('DshWinEnum2' -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshWinEnum2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const uint GW_OWNER = 4;
  public const int DWMWA_CLOAKED = 14;

  public class Win {
    public long Hwnd;
    public string Title;
    public string Cls;
    public int Pid;
    public int X, Y, W, H;
    public bool Min;
  }

  public static void MakeDpiAware() {
    try { SetProcessDpiAwareness(2); } catch { }   // PROCESS_PER_MONITOR_DPI_AWARE
    try { SetProcessDPIAware(); } catch { }        // fallback (Win7+)
  }
  public static int ExStyle(IntPtr h) { return GetWindowLong(h, GWL_EXSTYLE); }
  public static bool IsToolWindow(IntPtr h) { return (ExStyle(h) & WS_EX_TOOLWINDOW) != 0; }
  public static IntPtr Owner(IntPtr h) { return GetWindow(h, GW_OWNER); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }

  // DWM_CLOAKED_*: a window the compositor has hidden while the HWND stays "visible".
  // UWP suspends apps into this state, and they are the single biggest source of
  // picker rows that cannot be captured. 0 (or a failure) means not cloaked.
  public static bool Cloaked(IntPtr h) {
    try { int v; return DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, sizeof(int)) == 0 && v != 0; }
    catch { return false; }
  }
  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    return sb.ToString();
  }
  public static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassNameW(h, sb, 256);
    return sb.ToString();
  }
  public static bool Rect(IntPtr h, out int x, out int y, out int w, out int hh) {
    RECT r; x = 0; y = 0; w = 0; hh = 0;
    if (!GetWindowRect(h, out r)) return false;
    x = r.L; y = r.T; w = r.R - r.L; hh = r.B - r.T;
    return true;
  }

  // Snapshot of every top-level window that passes the cheap filters, in EnumWindows order.
  // The C# side keeps the index because PowerShell scriptblock closures do NOT share a
  // counter with the enclosing scope: `$z++` inside the callback increments a copy that is
  // thrown away on return, so a PowerShell-side counter silently stays 0 for every row.
  public static List<Win> Snapshot(string exclude, int minW, int minH) {
    var all = new List<Win>();
    int i = -1;
    EnumWindows((h, l) => {
      i++;
      if (!IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t == null || t.Length == 0) return true;
      if (IsToolWindow(h)) return true;
      if (Cloaked(h)) return true;
      if (exclude != null && exclude.Length > 0 &&
          t.IndexOf(exclude, StringComparison.OrdinalIgnoreCase) >= 0) return true;
      int x, y, w, hh;
      if (!Rect(h, out x, out y, out w, out hh)) return true;
      if (w < minW || hh < minH) return true;
      var e = new Win();
      e.Hwnd = h.ToInt64(); e.Title = t; e.Cls = ClassOf(h); e.Pid = (int)Pid(h);
      e.X = x; e.Y = y; e.W = w; e.H = hh; e.Min = IsIconic(h);
      all.Add(e);
      return true;
    }, IntPtr.Zero);
    return all;
  }
}
"@
}

[DshWinEnum2]::MakeDpiAware()

$exclude = if ($KeepSelf -or [string]::IsNullOrEmpty($ExcludeTitle)) { $null } else { $ExcludeTitle }
$all = [DshWinEnum2]::Snapshot($exclude, $MinWidth, $MinHeight)

# Z-ORDER. EnumWindows walks bottom-to-top, so $all[last] is the frontmost window. The picker
# wants topmost first, so walk it backwards and number z from 0 = frontmost.
#
# Owner rule: a WS_POPUP window owned by another window we are already listing (an owned
# dialog, the floating half of a split UI) sits right next to its owner and is usually
# transient; listing both makes the picker noisy and offers the same pixels twice. Skip those.
# An owner we did NOT list (hidden helper HWND, tray proxy) is not a reason to skip - Qt, WPF
# and Electron routinely park a real window on an invisible owner, and dropping those would
# empty the picker.
$items = New-Object 'System.Collections.Generic.List[object]'
$kept = New-Object 'System.Collections.Generic.HashSet[long]'
for ($i = $all.Count - 1; $i -ge 0; $i--) {
  $e = $all[$i]
  $owner = [DshWinEnum2]::Owner([IntPtr]::new($e.Hwnd))
  if ($owner -ne [IntPtr]::Zero -and $kept.Contains($owner.ToInt64())) { continue }
  # Every value is explicitly typed: ConvertTo-Json must never emit null (JSON.parse turns
  # that into null and the picker renders a blank cell), and never a string where a number
  # is expected.
  $items.Add([pscustomobject]@{
    hwnd  = [long]$e.Hwnd
    title = [string]$e.Title
    class = [string]$e.Cls
    pid   = [int]$e.Pid
    x     = [int]$e.X
    y     = [int]$e.Y
    w     = [int]$e.W
    h     = [int]$e.H
    min   = [bool]$e.Min
    z     = [int]($all.Count - 1 - $i)
  })
  [void]$kept.Add($e.Hwnd)
}

$limited = if ($Limit -gt 0 -and $items.Count -gt $Limit) { $items.GetRange(0, $Limit) } else { $items }
# @(...) is load-bearing: $limited can be a bare PSCustomObject (never a List) when exactly one
# window survives, and .Count on a bare PSCustomObject is $null -> "count":, in the JSON.
# Forcing array coercion makes 0/1/N all report the right number.
$count = @($limited).Count

if ($Json) {
  # The JSON is composed as TEXT, on purpose, and only the two string fields per window go
  # through ConvertTo-Json (to get correct escaping of quotes/backslashes/CJK).
  #
  # Why not just ConvertTo-Json the whole object: Windows PowerShell 5.1 has no -AsArray and
  # collapses an array down to a bare object when it holds exactly one element, so a user with
  # a single open window would get  {"windows":{...}}  and the picker would do windows.map()
  # on an object. String composition makes "windows" an array by construction, in both
  # editions, for 0, 1 and N rows alike. (Write-Output -NoEnumerate was tried here and does
  # NOT work: it keeps the array wrapped and the result stringifies as an object reference.)
  #
  # Numbers and booleans are emitted from explicitly-typed values, so the host always sees
  # real JSON numbers/booleans - never a quoted number, never null.
  $parts = New-Object 'System.Collections.Generic.List[string]'
  foreach ($it in $limited) {
    $t = [string]$it.title | ConvertTo-Json -Compress   # -> a quoted, escaped JSON string
    $c = [string]$it.class | ConvertTo-Json -Compress
    $min = if ($it.min) { 'true' } else { 'false' }
    $parts.Add(('{"hwnd":' + $it.hwnd + ',"title":' + $t + ',"class":' + $c + ',"pid":' + $it.pid +
                ',"x":' + $it.x + ',"y":' + $it.y + ',"w":' + $it.w + ',"h":' + $it.h +
                ',"min":' + $min + ',"z":' + $it.z + '}'))
  }
  Write-Output ('{"ok":true,"count":' + $count + ',"windows":[' + [string]::Join(',', $parts) + ']}')
} else {
  # Human-readable path. Titles are real (often non-ASCII) text, so never Write-Host them -
  # that goes through the GBK console code page and mangles them.
  Write-Output ("{0} window(s)" -f $count)
  foreach ($it in $limited) {
    Write-Output ("  hwnd={0} z={1} pid={2} {3}x{4} at {5},{6} min={7} class={8} title={9}" -f `
      $it.hwnd, $it.z, $it.pid, $it.w, $it.h, $it.x, $it.y, $it.min, $it.class, $it.title)
  }
}
