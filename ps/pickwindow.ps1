# DSH screenshot plugin - full-screen window picker (hover to highlight, click to select).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File pickwindow.ps1 `
#       [-OutJson <path>] [-TimeoutSec 120] [-Accent #4c8dff] [-Probe] [-ProbeSec 6]
#       [-ChildOfPoint] [-ExtFrame] [-ProbeIntervalMs 200] [-DimPercent 45]
#
# What it is: the QQ/WeChat-style picker. A borderless topmost form covers the whole virtual
# desktop, everything is dimmed by ~45%, the window under the cursor is punched back through
# undimmed with a 3px accent frame, and an info bar next to the cursor names it. Left click
# selects, right click / Esc cancels. Nothing is copied into DSH here - the script only
# reports WHICH window the user chose; the host captures it afterwards.
#
#   -OutJson <path>   also write the result JSON to this file (UTF-8, no BOM). The host reads
#                     that file, or the last line of stdout; both carry the same text.
#   -TimeoutSec <n>   auto-cancel after n seconds (default 120).
#   -Accent <color>   highlight color, "#rrggbb" (default #4c8dff).
#   -Probe            no GUI. Watch the window under the cursor for -ProbeSec seconds and print
#                     one JSON line per distinct window, then a summary line. This is how the
#                     hit test gets verified without a human moving the mouse.
#   -ProbeSec <n>     probe duration in seconds (default 6).
#   -ProbeIntervalMs  probe sampling interval (default 200).
#   -ChildOfPoint     start in "deepest child window" mode, the same thing holding Ctrl does at
#                     runtime; the reported window then carries "child":1. Useful for driving
#                     the picker from automation, which cannot hold Ctrl.
#   -ExtFrame         report DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) instead of
#                     GetWindowRect. See the coordinate note below - the DEFAULT is deliberately
#                     GetWindowRect, which is what ps/windows.ps1 reports.
#   -DimPercent <n>   dim strength, 0-90 (default 45).
#
# JSON - selection:
#   {"ok":true,"hwnd":1234567,"title":"...","class":"Chrome_WidgetWin_1","pid":1234,
#    "x":100,"y":50,"w":1600,"h":900,"child":0,"frame":"window","via":"walk","ms":3456}
# JSON - cancelled: {"ok":false,"cancelled":true,"reason":"escape|right-click|timeout|no-target|closed"}
# JSON - failure:   {"ok":false,"error":"..."}            (exit code 2; cancel/select exit 0)
#
# Field notes
#   x,y,w,h  PHYSICAL screen pixels of the window frame. frame says which source produced it:
#            "window"   = GetWindowRect. On Windows 10/11 this INCLUDES the invisible resize
#                         border (roughly 7px per side on Win10 at 100%), so the box sits a few
#                         px OUTSIDE the visible pixels. This is the default because
#                         ps/windows.ps1 reports exactly the same rectangle, and a picker whose
#                         numbers disagree with the list the user just clicked is a bug.
#            "extended" = DWMWA_EXTENDED_FRAME_BOUNDS, i.e. the visible frame (-ExtFrame).
#            If the DWM call fails under -ExtFrame the code silently uses GetWindowRect and
#            says "window", so the field always describes what actually happened.
#   child    1 when the user held Ctrl (or passed -ChildOfPoint), i.e. the deepest child window
#            under the cursor was selected instead of its top-level root. 0 means the root.
#   via      "hit"  = WindowFromPoint answered directly (exact hit test, used by -Probe).
#            "walk" = our own overlay was in the way, so the z-order walk below resolved it.
#   ms       milliseconds since the process started.
#
# Design notes / measured facts (all re-verified on this machine, PS 5.1, 1920x1080 @125%)
#   * ASCII only, on purpose. The console is GBK and Windows PowerShell 5.1 decodes a BOM-less
#     UTF-8 .ps1 as ANSI, which mis-decodes non-ASCII comment bytes and swallows the newlines
#     after them (capture.ps1 lost a } that way). Window titles are DATA, not source, so they
#     may be Chinese: they survive because [Console]::OutputEncoding is UTF-8 from line one and
#     nothing is ever Write-Host'ed.
#   * stdout carries JSON and nothing else; diagnostics go to stderr.
#   * DPI first, form second. SetProcessDpiAwarenessContext(-4) = PER_MONITOR_AWARE_V2 (Win10
#     1703+), then SetProcessDPIAware() as the fallback. Measured: without it, at 125% scaling a
#     form asked for logical 300,300 opens somewhere else entirely and every rect is virtualised,
#     so the highlight would drift away from the cursor. A 125% display is the normal case here.
#   * Finding the window UNDER the overlay is the whole trick, and the obvious idea does not
#     work. Measured: WindowFromPoint() returns OUR OWN form while it is on screen, and setting
#     WS_EX_TRANSPARENT (bit verified set afterwards) does NOT change that. Hiding the overlay
#     to peek flickers the desktop. So: ResolveAt() first asks WindowFromPoint - correct and
#     exact whenever the answer is not us (that is how -Probe works) - and when the answer IS
#     us it walks the z-order with GetTopWindow/GetWindow(GW_HWNDNEXT), returning the first
#     visible, non-minimised, non-cloaked, non-shell window whose rect holds the point. Lab
#     check: walk == ChildWindowFromPointEx+CWP_SKIPTRANSPARENT == WindowFromPoint-with-overlay-
#     hidden, all three agreeing on the target. The walk touches no window styles, so it cannot
#     flicker or reset our own form.
#   * Only the changed strips are repainted. The old highlight/bar rects and the new ones are
#     united, each side grown by the frame thickness and the bar, and Invalidate(rect) is called
#     with that; OnPaint narrows itself to e.ClipRectangle. A full-screen Invalidate() per mouse
#     move repaints 2M pixels and visibly lags on a 4K desktop.
#   * The overlay shows the FROZEN desktop: one CopyFromScreen snapshot taken before the form is
#     shown, then dimmed in place. If that snapshot fails (huge virtual desktop, session without
#     a compositor) the picker degrades to a flat background instead of crashing, and the accent
#     frame still works.
#   * Every exit path closes the form once, and the form dies with the process, so a stray
#     overlay can never outlive the picker. On a successful pick the form is hidden and given
#     150ms to disappear BEFORE the JSON is written, because the host captures the selected
#     window as soon as it reads that JSON - a still-visible overlay would be in the picture.

param(
  [string]$OutJson = '',
  [int]$TimeoutSec = 120,
  [string]$Accent = '#4c8dff',
  [switch]$Probe,
  [int]$ProbeSec = 6,
  [int]$ProbeIntervalMs = 200,
  [switch]$ChildOfPoint,
  [switch]$ExtFrame,
  [int]$DimPercent = 45
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Version-suffixed type name: Add-Type is per-process, so if a later edit adds a helper the
# suffix must be bumped or an already-loaded session silently keeps using the old type.
if (-not ('DshPick1' -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class DshPick1 {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public const uint GW_HWNDNEXT = 2;
  public const uint GA_ROOT = 2;
  public const uint CWP_SKIPINVISIBLE = 1;
  public const uint CWP_SKIPDISABLED = 2;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  public const int DWMWA_CLOAKED = 14;

  public class Win {
    public long Hwnd;
    public string Title = "";
    public string Cls = "";
    public int Pid;
    public int X, Y, W, H;
    public bool Child;
    public string Frame = "window";
    public string Via = "hit";
  }

  // 0 = nothing tried, -4 = per-monitor v2, -3 = per-monitor v1, -99 = system aware, -98 = shcore.
  public static int MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return -4; } catch (Exception) { }
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-3))) return -3; } catch (Exception) { }
    try { if (SetProcessDPIAware()) return -99; } catch (Exception) { }
    try { SetProcessDpiAwareness(2); return -98; } catch (Exception) { }
    return 0;
  }

  public static int CursorX() { POINT p; if (!GetCursorPos(out p)) return -1; return p.X; }
  public static int CursorY() { POINT p; if (!GetCursorPos(out p)) return -1; return p.Y; }

  // GetAsyncKeyState high bit = currently down. Polled instead of using KeyDown/MouseDown so the
  // picker keeps working even when another process owns the foreground, and so no click can leak
  // through to the window being picked.
  public static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(1024);
    GetWindowTextW(h, sb, 1024);
    return sb.ToString();
  }
  public static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassNameW(h, sb, 256);
    return sb.ToString();
  }
  public static int PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return (int)p; }

  public static bool Cloaked(IntPtr h) {
    try { int v; return DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, sizeof(int)) == 0 && v != 0; }
    catch (Exception) { return false; }
  }

  // The desktop shell owns no pixels a user can "pick": highlighting the wallpaper or the
  // taskbar and then handing the host an unpickable handle is worse than saying "Desktop".
  public static bool IsShellClass(string c) {
    return c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "SysShadow" ||
           c == "Shell_SecondaryTrayWnd";
  }

  public static bool Holds(IntPtr h, int x, int y) {
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    return x >= r.L && x < r.R && y >= r.T && y < r.B;
  }

  // First window in z-order (topmost band first) that owns the point and is a plausible pick.
  // This is what sees past our own full-screen overlay; see the header note.
  public static IntPtr Walk(IntPtr self, int x, int y) {
    IntPtr h = GetTopWindow(IntPtr.Zero);
    int guard = 0;
    while (h != IntPtr.Zero && guard < 5000) {
      guard++;
      IntPtr cur = h;
      h = GetWindow(h, GW_HWNDNEXT);
      if (cur == self) continue;
      if (!IsWindowVisible(cur)) continue;
      if (IsIconic(cur)) continue;
      if (Cloaked(cur)) continue;
      if (IsShellClass(ClassOf(cur))) continue;
      if (!Holds(cur, x, y)) continue;
      return cur;
    }
    return IntPtr.Zero;
  }

  // Deepest child of root that holds the point (Ctrl / -ChildOfPoint mode).
  public static IntPtr Descend(IntPtr root, int x, int y) {
    IntPtr cur = root;
    for (int i = 0; i < 24; i++) {
      POINT pt; pt.X = x; pt.Y = y;
      IntPtr child = ChildWindowFromPointEx(cur, pt, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED);
      if (child == IntPtr.Zero || child == cur) break;
      cur = child;
    }
    return cur;
  }

  public static Win Describe(IntPtr h, bool extFrame, bool child) {
    if (h == IntPtr.Zero) return null;
    if (!IsWindowVisible(h)) return null;
    if (IsIconic(h)) return null;
    if (Cloaked(h)) return null;
    string cls = ClassOf(h);
    if (IsShellClass(cls)) return null;
    // RECT must be default-initialised: the DWM branch assigns it inside a try, and the
    // short-circuit below then skips GetWindowRect, which the definite-assignment rules of C#
    // cannot see through ("use of possibly unassigned field 'R'").
    RECT r = new RECT();
    string used = "window";
    bool got = false;
    if (extFrame) {
      try { got = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0; }
      catch (Exception) { got = false; }
      if (got) used = "extended";
    }
    if (!got) { if (!GetWindowRect(h, out r)) return null; }
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0) return null;
    Win o = new Win();
    o.Hwnd = h.ToInt64();
    o.Title = Title(h);
    o.Cls = cls;
    o.Pid = PidOf(h);
    o.X = r.L; o.Y = r.T; o.W = w; o.H = hh;
    o.Child = child;
    o.Frame = used;
    return o;
  }

  // The one entry point. selfHwnd is our overlay (0 when there is none, e.g. -Probe).
  public static Win ResolveAt(long selfHwnd, int x, int y, bool childMode, bool extFrame) {
    IntPtr self = new IntPtr(selfHwnd);
    POINT pt; pt.X = x; pt.Y = y;
    string via = "hit";
    IntPtr h = WindowFromPoint(pt);
    if (h == IntPtr.Zero || h == self) {
      h = Walk(self, x, y);
      via = "walk";
    }
    if (h == IntPtr.Zero) return null;
    IntPtr target;
    if (childMode) {
      target = (via == "hit") ? h : Descend(h, x, y);
    } else {
      target = GetAncestor(h, GA_ROOT);
      if (target == IntPtr.Zero) target = h;
    }
    if (target == IntPtr.Zero || target == self) return null;
    Win o = Describe(target, extFrame, childMode);
    if (o == null) return null;
    o.Via = via;
    return o;
  }
}
"@
}

# --- result plumbing -------------------------------------------------------------------------

function Format-WinFields($w, [long]$ms) {
  # String composition, not ConvertTo-Json on the whole object: PS 5.1 has no -AsArray and
  # collapses a 1-element array to a bare object. Only the two text fields need real escaping.
  $t = [string]$w.Title | ConvertTo-Json -Compress
  $c = [string]$w.Cls | ConvertTo-Json -Compress
  $f = [string]$w.Frame | ConvertTo-Json -Compress
  $v = [string]$w.Via | ConvertTo-Json -Compress
  $ch = if ($w.Child) { 1 } else { 0 }
  return '"hwnd":' + ([long]$w.Hwnd) + ',"title":' + $t + ',"class":' + $c +
         ',"pid":' + ([int]$w.Pid) + ',"x":' + ([int]$w.X) + ',"y":' + ([int]$w.Y) +
         ',"w":' + ([int]$w.W) + ',"h":' + ([int]$w.H) + ',"child":' + $ch +
         ',"frame":' + $f + ',"via":' + $v + ',"ms":' + $ms
}

function Format-WinJson($w, [long]$ms) { return '{' + (Format-WinFields $w $ms) + '}' }

function Write-ResultJson([string]$line) {
  if ($OutJson -and $OutJson.Length -gt 0) {
    try {
      $dir = [System.IO.Path]::GetDirectoryName($OutJson)
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      [System.IO.File]::WriteAllText($OutJson, $line + "`n", [System.Text.UTF8Encoding]::new($false))
    } catch {
      [Console]::Error.WriteLine('pickwindow: could not write -OutJson: ' + $_.Exception.Message)
    }
  }
  Write-Output $line
}

# TextRenderer (GDI) instead of Graphics.DrawString (GDI+): GDI does font linking, so a Chinese
# window title renders in a CJK face rather than as boxes.
#
# Measuring needs the FOUR-argument MeasureText. .NET Framework has no
# MeasureText(String, Font, TextFormatFlags) overload, and PowerShell then binds the flags value
# to the "proposedSize" parameter of MeasureText(String, Font, Size) and dies with
# 'Cannot convert argument "proposedSize" ... to type System.Drawing.Size' (measured - it killed
# the first GUI run at startup). A huge proposed box plus SingleLine measures the full string.
$measureBox = New-Object System.Drawing.Size -ArgumentList 10000, 200
$measureFlags = [System.Windows.Forms.TextFormatFlags]'NoPadding,SingleLine,Left,Top'

function Measure-Width([string]$text, $font) {
  if ([string]::IsNullOrEmpty($text)) { return 0 }
  return [System.Windows.Forms.TextRenderer]::MeasureText($text, $font, $measureBox, $measureFlags).Width
}

function Limit-Text([string]$text, $font, [int]$maxPx) {
  if ([string]::IsNullOrEmpty($text)) { return '' }
  if ((Measure-Width $text $font) -le $maxPx) { return $text }
  $t = $text
  while ($t.Length -gt 1) {
    $t = $t.Substring(0, $t.Length - 1)
    # never cut a surrogate pair in half - a lone surrogate renders as garbage
    if ($t.Length -gt 0 -and [char]::IsHighSurrogate($t[$t.Length - 1])) { $t = $t.Substring(0, $t.Length - 1) }
    if ((Measure-Width ($t + '...') $font) -le $maxPx) { break }
  }
  return $t + '...'
}

$dpiCode = [DshPick1]::MakeDpiAware()
[Console]::Error.WriteLine('pickwindow: dpiAwareness=' + $dpiCode + ' (want -4 = per-monitor v2)')

$startSw = [System.Diagnostics.Stopwatch]::StartNew()
$wantChild = [bool]$ChildOfPoint
$wantExt = [bool]$ExtFrame
$outLine = ''
$exitCode = 0

try {
  if ($Probe) {
    # ---- probe: no GUI, just answer "which window is the cursor over" ------------------------
    $interval = [Math]::Max(50, $ProbeIntervalMs)
    $secs = [Math]::Max(1, $ProbeSec)
    $seen = New-Object 'System.Collections.Generic.List[string]'
    $seenIds = New-Object 'System.Collections.Generic.HashSet[long]'
    $lastX = -1; $lastY = -1
    while ($startSw.Elapsed.TotalSeconds -lt $secs) {
      $lastX = [DshPick1]::CursorX()
      $lastY = [DshPick1]::CursorY()
      $w = [DshPick1]::ResolveAt([long]0, $lastX, $lastY, $wantChild, $wantExt)
      if ($w -ne $null) {
        if (-not $seenIds.Contains([long]$w.Hwnd)) {
          [void]$seenIds.Add([long]$w.Hwnd)
          $entry = Format-WinJson $w ([long]$startSw.ElapsedMilliseconds)
          $seen.Add($entry)
          Write-Output $entry
        }
      }
      Start-Sleep -Milliseconds $interval
    }
    $outLine = '{"ok":true,"probeSec":' + $secs + ',"cursorX":' + $lastX + ',"cursorY":' + $lastY +
               ',"count":' + $seen.Count + ',"windows":[' + ($seen -join ',') + ']}'
    $exitCode = 0
  } else {
    # ---- GUI picker -------------------------------------------------------------------------
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $vx = $vs.X; $vy = $vs.Y; $vw = $vs.Width; $vh = $vs.Height
    if ($vw -le 0 -or $vh -le 0) { throw 'virtual screen has no size' }
    [Console]::Error.WriteLine('pickwindow: virtual screen ' + $vx + ',' + $vy + ' ' + $vw + 'x' + $vh)

    $accentColor = [System.Drawing.Color]::FromArgb(76, 141, 255)
    try {
      $hex = $Accent
      if (-not $hex.StartsWith('#')) { $hex = '#' + $hex }
      $accentColor = [System.Drawing.ColorTranslator]::FromHtml($hex)
    } catch { [Console]::Error.WriteLine('pickwindow: bad -Accent, using #4c8dff') }
    $dimAlpha = [int]([Math]::Round([Math]::Max(0, [Math]::Min(90, $DimPercent)) * 255 / 100))

    # One frozen snapshot of the whole virtual desktop, taken BEFORE the overlay exists (it would
    # otherwise photograph itself). Degrades to a flat background when this fails.
    $snap = $null
    try {
      $snap = New-Object System.Drawing.Bitmap -ArgumentList $vw, $vh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $gs = [System.Drawing.Graphics]::FromImage($snap)
      try { $gs.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size -ArgumentList $vw, $vh), [System.Drawing.CopyPixelOperation]::SourceCopy) }
      finally { $gs.Dispose() }
    } catch {
      [Console]::Error.WriteLine('pickwindow: snapshot failed, flat fallback: ' + $_.Exception.Message)
      if ($snap -ne $null) { $snap.Dispose(); $snap = $null }
    }

    # All scene state in one hashtable reachable from the Paint handler. A hashtable's properties
    # are mutated in place, so the handler never has to WRITE a script-scope variable (writing is
    # where PowerShell event-handler closures go wrong).
    $st = @{
      Vx = $vx; Vy = $vy; Vw = $vw; Vh = $vh
      Snap = $snap
      FlatBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 48, 48, 52))
      DimBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($dimAlpha, 0, 0, 0))
      AccentBrush = New-Object System.Drawing.SolidBrush $accentColor
      AccentDimBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, $accentColor.R, $accentColor.G, $accentColor.B))
      ShadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
      BarPen = New-Object System.Drawing.Pen $accentColor, 1
      Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 9
      Hl = [System.Drawing.Rectangle]::Empty
      Bar = [System.Drawing.Rectangle]::Empty
      BarTitle = ''
      BarDim = ''
      PaintLogged = $false
      LastX = -1; LastY = -1; LastCtrl = $false
    }
    $white = [System.Drawing.Color]::White
    $soft = [System.Drawing.Color]::FromArgb(255, 210, 214, 222)
    $tfL = [System.Windows.Forms.TextFormatFlags]'NoPadding,SingleLine,EndEllipsis,VerticalCenter,Left'
    $thick = 3

    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.TopMost = $true
    $form.ShowInTaskbar = $false
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.KeyPreview = $true
    $form.BackColor = [System.Drawing.Color]::Black
    $form.Text = 'DSH picker'
    $form.ClientSize = New-Object System.Drawing.Size -ArgumentList $vw, $vh
    $form.Location = New-Object System.Drawing.Point -ArgumentList $vx, $vy
    $form.Cursor = [System.Windows.Forms.Cursors]::Cross
    # Control.DoubleBuffered is protected, so the property is unreachable from PowerShell
    # ("cannot be found on this object" - measured); Control.SetStyle via reflection is not.
    try {
      $mi = [System.Windows.Forms.Control].GetMethod('SetStyle', [System.Reflection.BindingFlags]'Instance,NonPublic')
      $styleBits = [System.Windows.Forms.ControlStyles]'AllPaintingInWmPaint,UserPaint,OptimizedDoubleBuffer'
      $mi.Invoke($form, @([System.Windows.Forms.ControlStyles]$styleBits, $true)) | Out-Null
    } catch { [Console]::Error.WriteLine('pickwindow: double buffering unavailable: ' + $_.Exception.Message) }
    $selfHwnd = [long]$form.Handle

    $form.Add_Paint({
      param($sender, $e)
      try {
        $g = $e.Graphics
        $clip = $e.ClipRectangle
        if ($clip.Width -le 0 -or $clip.Height -le 0) { return }
        $g.SetClip($clip)
        # 1. the frozen desktop ...
        if ($st.Snap -ne $null) { $g.DrawImageUnscaled($st.Snap, 0, 0) }
        else { $g.FillRectangle($st.FlatBrush, $clip) }
        # 2. ... dimmed ...
        $g.FillRectangle($st.DimBrush, $clip)
        # 3. ... with the picked window punched back through undimmed ...
        $hl = $st.Hl
        if (-not $hl.IsEmpty -and $hl.IntersectsWith($clip)) {
          if ($st.Snap -ne $null) {
            $g.SetClip($hl, [System.Drawing.Drawing2D.CombineMode]::Intersect)
            $g.DrawImageUnscaled($st.Snap, 0, 0)
            $g.SetClip($clip)
          } else {
            $g.FillRectangle($st.FlatBrush, $hl)
          }
          # 4. ... and framed. Four filled strips instead of a Pen: a 3px Pen is centred on the
          #    geometric line and would bleed outside the window rect.
          $r = $hl
          if ($r.Width -ge (2 * $thick) -and $r.Height -ge (2 * $thick)) {
            $g.FillRectangle($st.AccentBrush, $r.X, $r.Y, $r.Width, $thick)
            $g.FillRectangle($st.AccentBrush, $r.X, ($r.Y + $r.Height - $thick), $r.Width, $thick)
            $g.FillRectangle($st.AccentBrush, $r.X, ($r.Y + $thick), $thick, ($r.Height - 2 * $thick))
            $g.FillRectangle($st.AccentBrush, ($r.X + $r.Width - $thick), ($r.Y + $thick), $thick, ($r.Height - 2 * $thick))
          } else {
            $g.DrawRectangle($st.BarPen, $r.X, $r.Y, ($r.Width - 1), ($r.Height - 1))
          }
        }
        # 5. the info bar
        $bar = $st.Bar
        if (-not $bar.IsEmpty -and $bar.IntersectsWith($clip)) {
          $g.FillRectangle($st.ShadowBrush, ($bar.X + 3), ($bar.Y + 3), $bar.Width, $bar.Height)
          $g.FillRectangle($st.DimBrush, $bar)
          $g.DrawRectangle($st.BarPen, $bar.X, $bar.Y, ($bar.Width - 1), ($bar.Height - 1))
          $pad = 8
          $lineH = [int]([Math]::Ceiling($st.Font.GetHeight()))
          $r1 = New-Object System.Drawing.Rectangle -ArgumentList ($bar.X + $pad), ($bar.Y + $pad), ($bar.Width - 2 * $pad), $lineH
          $r2 = New-Object System.Drawing.Rectangle -ArgumentList ($bar.X + $pad), ($bar.Y + $pad + $lineH), ($bar.Width - 2 * $pad), $lineH
          [System.Windows.Forms.TextRenderer]::DrawText($g, $st.BarTitle, $st.Font, $r1, $white, $tfL)
          if ($st.BarDim.Length -gt 0) {
            [System.Windows.Forms.TextRenderer]::DrawText($g, $st.BarDim, $st.Font, $r2, $soft, $tfL)
          }
        }
        $g.ResetClip()
      } catch {
        # A throw inside a WinForms callback would surface from DoEvents and kill the picker, so
        # a failed frame is swallowed - but never silently: the first one is logged, otherwise a
        # broken draw call looks exactly like "the overlay just does not paint".
        if (-not $st.PaintLogged) {
          $st.PaintLogged = $true
          [Console]::Error.WriteLine('pickwindow: paint failed: ' + $_.Exception.Message)
        }
      }
    })

    # Recompute target + bar for a cursor position and repaint ONLY the union of the old and new
    # decorated rectangles.
    function Update-Scene([int]$cx, [int]$cy, [bool]$child) {
      $w = [DshPick1]::ResolveAt($selfHwnd, $cx, $cy, $child, $wantExt)
      $newHl = [System.Drawing.Rectangle]::Empty
      $title = 'Desktop'
      $dims = ''
      if ($w -ne $null) {
        $title = if ([string]::IsNullOrEmpty($w.Title)) { [string]$w.Cls } else { [string]$w.Title }
        $dims = '' + ([int]$w.W) + 'x' + ([int]$w.H)
        if ($w.Child) { $dims = $dims + '  child' }
        $newHl = New-Object System.Drawing.Rectangle -ArgumentList ([int]$w.X - $st.Vx), ([int]$w.Y - $st.Vy), ([int]$w.W), ([int]$w.H)
        $newHl = [System.Drawing.Rectangle]::Intersect($newHl, (New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $st.Vw, $st.Vh))
      }
      $title = Limit-Text $title $st.Font 520
      $pad = 8
      $lineH = [int]([Math]::Ceiling($st.Font.GetHeight()))
      $tw = Measure-Width $title $st.Font
      $dw = Measure-Width $dims $st.Font
      $bw = [Math]::Max($tw, $dw) + 2 * $pad
      $bh = $pad * 2 + $lineH * 2
      $bx = $cx - $st.Vx + 18
      $by = $cy - $st.Vy + 22
      if ($bx + $bw -gt $st.Vw) { $bx = $cx - $st.Vx - $bw - 12 }
      if ($by + $bh -gt $st.Vh) { $by = $cy - $st.Vy - $bh - 12 }
      if ($bx -lt 0) { $bx = 0 }
      if ($by -lt 0) { $by = 0 }
      $newBar = New-Object System.Drawing.Rectangle -ArgumentList $bx, $by, $bw, $bh

      $grow = $thick + 5
      $dirty = [System.Drawing.Rectangle]::Empty
      if (-not $st.Hl.IsEmpty) { $dirty = [System.Drawing.Rectangle]::Intersect([System.Drawing.Rectangle]::Inflate($st.Hl, $grow, $grow), (New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $st.Vw, $st.Vh)) }
      if (-not $st.Bar.IsEmpty) {
        $ob = [System.Drawing.Rectangle]::Inflate($st.Bar, 6, 6)
        $dirty = if ($dirty.IsEmpty) { $ob } else { [System.Drawing.Rectangle]::Union($dirty, $ob) }
      }
      if (-not $newHl.IsEmpty) {
        $nb = [System.Drawing.Rectangle]::Intersect([System.Drawing.Rectangle]::Inflate($newHl, $grow, $grow), (New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $st.Vw, $st.Vh))
        $dirty = if ($dirty.IsEmpty) { $nb } else { [System.Drawing.Rectangle]::Union($dirty, $nb) }
      }
      $nbar = [System.Drawing.Rectangle]::Inflate($newBar, 6, 6)
      $dirty = if ($dirty.IsEmpty) { $nbar } else { [System.Drawing.Rectangle]::Union($dirty, $nbar) }

      $st.Hl = $newHl
      $st.Bar = $newBar
      $st.BarTitle = $title
      $st.BarDim = $dims
      if (-not $dirty.IsEmpty) { $form.Invalidate($dirty) }
      return $w
    }

    $form.Show()
    $form.Activate()
    [System.Windows.Forms.Application]::DoEvents()
    # First frame: the whole client area, plus a first target resolution at the current cursor.
    $form.Invalidate()
    [void](Update-Scene ([DshPick1]::CursorX()) ([DshPick1]::CursorY()) $wantChild)
    [System.Windows.Forms.Application]::DoEvents()

    # Arm after a short grace period so a click that was already in flight when the picker opened
    # (or a hotkey still being held) cannot select instantly.
    $armed = -not ([DshPick1]::Down(0x01) -or [DshPick1]::Down(0x02))
    $reason = ''
    $picked = $null

    while ($true) {
      [System.Windows.Forms.Application]::DoEvents()
      $elapsed = $startSw.Elapsed
      if ($elapsed.TotalSeconds -ge $TimeoutSec) { $reason = 'timeout'; break }
      if (-not $armed -and $elapsed.TotalMilliseconds -gt 350 -and -not [DshPick1]::Down(0x01) -and -not [DshPick1]::Down(0x02)) { $armed = $true }
      if ($form.IsDisposed -or -not $form.Visible) { $reason = 'closed'; break }

      $ctrl = [DshPick1]::Down(0x11)
      $child = $wantChild -or $ctrl
      $cx = [DshPick1]::CursorX()
      $cy = [DshPick1]::CursorY()
      if ($cx -ne $st.LastX -or $cy -ne $st.LastY -or $child -ne $st.LastCtrl) {
        $st.LastX = $cx; $st.LastY = $cy; $st.LastCtrl = $child
        [void](Update-Scene $cx $cy $child)
      }

      if ($armed) {
        if ([DshPick1]::Down(0x1B)) { $reason = 'escape'; break }
        if ([DshPick1]::Down(0x02)) { $reason = 'right-click'; break }
        if ([DshPick1]::Down(0x01)) {
          # Re-resolve at the click instant: the poll above may be up to one tick old.
          $picked = [DshPick1]::ResolveAt($selfHwnd, $cx, $cy, $child, $wantExt)
          if ($picked -eq $null) { $reason = 'no-target'; break }
          $reason = 'picked'
          break
        }
      }
      Start-Sleep -Milliseconds 12
    }

    # Hide FIRST and let the desktop settle: the host captures the chosen window the moment it
    # reads the JSON, and a visible overlay would be baked into that capture.
    try { $form.Hide() } catch { }
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 150

    if ($reason -eq 'picked') {
      $outLine = '{"ok":true,' + (Format-WinFields $picked ([long]$startSw.ElapsedMilliseconds)) + '}'
      $exitCode = 0
    } else {
      $outLine = '{"ok":false,"cancelled":true,"reason":"' + $reason + '"}'
      $exitCode = 0
    }
    foreach ($k in @('FlatBrush', 'DimBrush', 'AccentBrush', 'AccentDimBrush', 'ShadowBrush', 'BarPen', 'Font')) {
      if ($st[$k] -ne $null) { try { $st[$k].Dispose() } catch { } }
    }
    try { $form.Close() } catch { }
    try { $form.Dispose() } catch { }
    if ($st.Snap -ne $null) { try { $st.Snap.Dispose() } catch { } }
  }
} catch {
  $outLine = '{"ok":false,"error":' + (([string]$_.Exception.Message) | ConvertTo-Json -Compress) + '}'
  $exitCode = 2
}

Write-ResultJson $outLine
exit $exitCode
