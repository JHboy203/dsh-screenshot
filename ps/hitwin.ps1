# dsh-screenshot - which top-level window sits under a screen point?
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ps/hitwin.ps1 -X 800 -Y 500 [-Json]
#
# stdout (the JSON line is ALWAYS the last one, with or without -Json):
#   {"ok":true,"hwnd":123,"title":"...","class":"...","pid":1,"x":0,"y":0,"w":100,"h":100}
#   {"ok":false,"error":"..."}
#
# Why it exists
#   The long-screenshot session captures one fixed screen rectangle over and over. The moment
#   the user clicks back into DSH (or anything else covers the region), the pixels under that
#   rectangle belong to a DIFFERENT window. Committing such a frame splices a foreign picture
#   into the middle of the long image - which is exactly what happens at the end of every
#   session, because "scroll, then come back and press done" is the normal workflow. One hit
#   test per tick is what keeps that out (the session pauses with paused='target-lost').
#
#   It is also how a session decides WHAT it is capturing: scrollBegin asks for the window under
#   the region centre and remembers it as the target for the whole session.
#
# ASCII only: the console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.
# DPI: per-monitor-v2 awareness first, SetProcessDPIAware() as the fallback. Without it
#   WindowFromPoint receives VIRTUALISED coordinates while the caller (capture.ps1, also aware)
#   speaks physical ones, so on a 125%/150% display the hit test points at the wrong window.
# Naming: no local variable may collide with a parameter name - PowerShell variable names are
#   case-insensitive, so a local `$x` silently overwrites the parameter `-X` (a `[string]$Rect`
#   parameter once turned a local `$rect` into a string this way).
param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [switch]$Json,
  # Report the immediate child window at the point instead of the top-level root.
  [switch]$Child
)

$ErrorActionPreference = 'Stop'
# UTF-8 on the way out: window titles are frequently Chinese and would otherwise be mangled
# by the GBK console encoding before node ever sees them.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not ('DshHitWin' -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshHitWin {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }

  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  // GA_ROOT = 2. WindowFromPoint only ever returns a leaf (the Electron render widget, a
  // button, ...), and a leaf's handle changes as the mouse moves across the UI - useless as a
  // session target. The root is the window the user thinks of as "that window".
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();

  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);

  // Wrapped in C# rather than done from PowerShell: new IntPtr(-4) has no portable PowerShell
  // spelling across 5.1/7 and a bad cast here is a silent no-op, not an error.
  public static int MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return -4; } catch {}
    try { if (SetProcessDPIAware()) return -1; } catch {}
    try { if (SetProcessDpiAwareness(2) == 0) return 2; } catch {}
    return 0;
  }

  public static string Text(IntPtr h) {
    StringBuilder sb = new StringBuilder(512);
    int n = GetWindowTextW(h, sb, sb.Capacity);
    return n > 0 ? sb.ToString() : "";
  }
  public static string Cls(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    int n = GetClassNameW(h, sb, sb.Capacity);
    return n > 0 ? sb.ToString() : "";
  }
}
"@
}

$dpiCode = [DshHitWin]::MakeDpiAware()

function Get-WinJson([int]$ptX, [int]$ptY, [bool]$wantChild) {
  $pt = New-Object DshHitWin+POINT
  $pt.X = $ptX
  $pt.Y = $ptY
  $leaf = [DshHitWin]::WindowFromPoint($pt)
  if ($leaf -eq [IntPtr]::Zero) {
    return '{"ok":false,"error":"no window at point"}'
  }
  # ChildWindowFromPoint/WindowFromPoint can hand back a handle that died between the call and
  # our use of it (a tooltip vanishing). Degrade to the desktop instead of reporting a ghost.
  $hit = $leaf
  if (-not $wantChild) {
    $root = [DshHitWin]::GetAncestor($leaf, 2)
    if ($root -ne [IntPtr]::Zero) { $hit = $root }
  }
  if (-not [DshHitWin]::IsWindow($hit)) {
    $hit = [DshHitWin]::GetDesktopWindow()
    if (-not [DshHitWin]::IsWindow($hit)) {
      return '{"ok":false,"error":"window handle is not valid"}'
    }
  }

  $r = New-Object DshHitWin+RECT
  [void][DshHitWin]::GetWindowRect($hit, [ref]$r)
  $procId = [uint32]0
  [void][DshHitWin]::GetWindowThreadProcessId($hit, [ref]$procId)

  $title = [DshHitWin]::Text($hit)
  $cls = [DshHitWin]::Cls($hit)
  # ConvertTo-Json on the two text fields only: it is the one escaping routine that is correct
  # in both 5.1 and 7 (quotes, backslashes, control chars). Everything else is numeric.
  $titleJs = [string]$title | ConvertTo-Json -Compress
  $clsJs = [string]$cls | ConvertTo-Json -Compress

  return '{"ok":true,"hwnd":' + ([long]$hit) + ',"title":' + $titleJs + ',"class":' + $clsJs +
         ',"pid":' + ([int]$procId) + ',"x":' + ([int]$r.L) + ',"y":' + ([int]$r.T) +
         ',"w":' + ([int]($r.R - $r.L)) + ',"h":' + ([int]($r.B - $r.T)) + '}'
}

$line = ''
try {
  $line = Get-WinJson $X $Y ([bool]$Child)
} catch {
  $msg = [string]$_.Exception.Message | ConvertTo-Json -Compress
  $line = '{"ok":false,"error":' + $msg + '}'
}

if (-not $Json) {
  Write-Output ("hitwin x={0} y={1} dpi={2}" -f $X, $Y, $dpiCode)
}
Write-Output $line
exit 0
