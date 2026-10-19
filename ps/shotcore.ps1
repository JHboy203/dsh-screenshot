# DSH screenshot plugin - the capture CORE, shared by two callers.
#
#   * ps/capture.ps1  - the one-shot CLI (a fresh powershell.exe per call). Unchanged contract.
#   * ps/shooter.ps1  - the resident helper (one long-lived process, a request file per call).
#
# Why this file exists: a one-shot capture costs ~1.9s of which only ~150ms is the actual
# BitBlt+PNG work. The rest is process start (~500ms) + Add-Type -AssemblyName System.Drawing
# (~260ms) + compiling the C# below (~390ms) + parsing/binding the script - all of it paid
# AGAIN on every single call. Extracting the body into a function lets the resident helper pay
# that once and then serve each request for ~200-300ms. Two implementations of "how do we
# capture" would drift, so both callers use this one.
#
# Contract: Invoke-DshCapture NEVER writes to the pipeline except its single return value, and
# NEVER calls `exit` (the CLI keeps its exit codes in the wrapper; a resident process must
# survive a bad request). Errors come back as { ok = $false; error; exitCode }.
#
# ASCII only: the console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8, so a
# non-ASCII comment here could swallow a code line (this file bit capture.ps1 once already).
#
# Design notes for the capture itself live with the code below. Nothing here is new: the body
# was moved verbatim out of capture.ps1.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('DshShot' -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshShot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  // [return: MarshalAs(UnmanagedType.Bool)] is REQUIRED, not decoration: Win32 BOOL is a
  // 4-byte int, and the default marshaller reads only the low byte of EAX/RAX. When the upper
  // bytes hold leftovers, IsWindow() returns garbage-false for a perfectly valid handle, and
  // the caller then silently falls back to the title match (capturing the wrong window).
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // --- hit test (used by the resident helper so the scroll loop does not spawn hitwin.ps1
  //     once per tick; hitwin.ps1 itself stays as the fallback path) ---
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  // GA_ROOT = 2. WindowFromPoint only ever returns a leaf (the Electron render widget, say);
  // callers want the top-level window, so walk up exactly once.
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  // --- synthetic wheel (R25): the AUTO long-screenshot sends one wheel per frame, and
  //     spawning ps/wheel.ps1 for each one was the last per-frame process cost in the loop
  //     (~600-900ms of process start for ~1ms of mouse_event). Same P/Invokes as wheel.ps1,
  //     same order, same waits - wheel.ps1 stays as the fallback path.
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  public const uint MouseWheel = 0x0800;

  public static bool CursorIsAt(int x, int y) {
    POINT p;
    if (!GetCursorPos(out p)) return false;
    return p.X == x && p.Y == y;
  }

  // Returns "the cursor really is on that point" - NOT "I called SetCursorPos".
  // A low-integrity caller (the DSH tool sandbox) gets SetCursorPos accepted and then
  // SILENTLY DROPPED by UIPI, so trusting the return value would scroll whatever window the
  // user's pointer happened to be over. Waiting for the position to change keeps it honest.
  public static bool WheelAt(int x, int y, int delta) {
    SetCursorPos(x, y);
    int waited = 0;
    while (waited < 120) {
      if (CursorIsAt(x, y)) return true;
      System.Threading.Thread.Sleep(4);
      waited += 4;
    }
    // Cursor never arrived. Do NOT send the wheel: it would land on a different window.
    return false;
  }

  public static void Wheel(int delta) {
    mouse_event(MouseWheel, 0, 0, delta, UIntPtr.Zero);
  }

  public static IntPtr HitTestRoot(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr leaf = WindowFromPoint(p);
    if (leaf == IntPtr.Zero) return IntPtr.Zero;
    IntPtr root = GetAncestor(leaf, 2);
    return root == IntPtr.Zero ? leaf : root;
  }

  public static void MakeDpiAware() {
    try { SetProcessDpiAwareness(2); } catch { }   // PROCESS_PER_MONITOR_DPI_AWARE
    try { SetProcessDPIAware(); } catch { }        // fallback (Win7+)
  }
  public static List<IntPtr> Windows(string needle) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    return sb.ToString();
  }
  public static IntPtr FindWindow(string needle) {
    IntPtr fallback = IntPtr.Zero;
    foreach (var h in Windows(needle)) {
      if (fallback == IntPtr.Zero) fallback = h;
      if (IsWindowVisible(h) && !IsIconic(h)) return h;
    }
    return fallback;
  }
}
"@
}

# DPI awareness is per PROCESS, so this must run once per process - not once per capture.
# Without it a non-aware process gets *virtualised* coordinates and the capture comes out
# scaled/blurry on a 125%/150% display.
[DshShot]::MakeDpiAware()

# Handles are carried as [long] and converted to IntPtr only at the P/Invoke boundary.
#
# Why: on Windows PowerShell 5.1 (CLR 4.0.30319) `[IntPtr]::Zero` does NOT stay an IntPtr -
# PowerShell coerces it to System.Int64 0. Any value that then reaches a P/Invoke whose
# parameter is IntPtr silently mis-marshals, IsWindow() answers false for a valid handle, and
# `-Hwnd <n>` quietly loses to the title match (capturing the wrong window). [long] is exact
# for window handles and survives a parameter, a comparison and ConvertTo-Json unchanged.
function ConvertTo-Win32Ptr([long]$value) { return [IntPtr]::new($value) }

# A failure that the CLI turns into `Write-Error <error>; exit <exitCode>` and the helper turns
# into { ok:false, error } - i.e. the same strings the one-shot script always produced.
function New-DshCaptureFailure([string]$ErrorText, [int]$ExitCode) {
  return [pscustomobject]@{ ok = $false; error = $ErrorText; exitCode = $ExitCode; info = $null }
}

<#
.SYNOPSIS
  Capture the desktop / a window / an explicit rectangle to a PNG and describe the result.
.DESCRIPTION
  Returns { ok; error; exitCode; info }. `info` is the same object capture.ps1 has always
  printed as its JSON line (mode/left/top/width/height/hwnd/virtual*/hidden/method/path plus
  the optional fallback / broughtToFront members) - the CLI and the resident helper therefore
  report identical metadata.
#>
function Invoke-DshCapture {
  param(
    [ValidateSet('desktop', 'window')][string]$Mode = 'desktop',
    [string]$Out = '',
    [string]$Target = 'DeepSeek Harness',
    [long]$Hwnd = 0,
    [bool]$HideSelf = $false,
    [int]$HideDelayMs = 260,
    [string]$Rect = '',
    [bool]$NoRestore = $false,
    [bool]$BringToFront = $false,
    [ValidateSet('screen', 'print')][string]$Method = 'screen'
  )

  if ([string]::IsNullOrEmpty($Out)) { return (New-DshCaptureFailure 'missing -Out (output png path)' 2) }

  # virtual screen covers every monitor; SM_* returns virtualised-but-real pixels once DPI aware
  $vx = [DshShot]::GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
  $vy = [DshShot]::GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
  $vw = [DshShot]::GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
  $vh = [DshShot]::GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN
  if ($vw -le 0 -or $vh -le 0) {
    $vw = [DshShot]::GetSystemMetrics(0); $vh = [DshShot]::GetSystemMetrics(1); $vx = 0; $vy = 0
  }

  $fallback = ''
  $hwndv = [long]0
  if ($Mode -eq 'window' -and $Hwnd -gt 0) {
    # A handle from the picker. IsWindow() is the cheap validity test; if the handle is stale we
    # fall through to the title match rather than failing, and record why in the JSON.
    if ([DshShot]::IsWindow((ConvertTo-Win32Ptr $Hwnd))) {
      $hwndv = [long]$Hwnd
    } else {
      $fallback = 'hwnd-not-found'
    }
  }
  if ($Mode -eq 'window' -and $hwndv -eq 0) {
    $hwndv = [long][DshShot]::FindWindow($Target)
    if ($hwndv -eq 0) {
      if ($fallback) { return (New-DshCaptureFailure "$fallback (hwnd $Hwnd) and no window matching '$Target'" 2) }
      else { return (New-DshCaptureFailure "no window matching '$Target'" 2) }
    }
  }
  $hwnd = ConvertTo-Win32Ptr $hwndv

  $x = $vx; $y = $vy; $w = $vw; $h = $vh
  if ($Mode -eq 'window') {
    # A minimized window reports the sentinel rect -32000,-32000 (the old Windows convention);
    # grabbing that region would produce a meaningless image. Restore it first, then measure.
    #
    # ShowWindow needs medium integrity - a low-integrity caller is silently refused by UIPI, so
    # the restore MUST be re-checked. If it did not take, fail loudly: never return a
    # plausible-looking wrong picture.
    if ([DshShot]::IsIconic($hwnd)) {
      if ($NoRestore) {
        return (New-DshCaptureFailure 'target window is minimized (pass without -NoRestore to allow restoring it)' 4)
      }
      [DshShot]::ShowWindow($hwnd, 9) | Out-Null     # SW_RESTORE
      Start-Sleep -Milliseconds 280
      if ([DshShot]::IsIconic($hwnd)) {
        return (New-DshCaptureFailure 'target window is minimized and could not be restored (low-integrity caller?)' 4)
      }
    }
    $r = New-Object DshShot+RECT
    [DshShot]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $x = $r.L; $y = $r.T; $w = $r.R - $r.L; $h = $r.B - $r.T
    if ($w -le 0 -or $h -le 0 -or $x -le -30000 -or $y -le -30000) {
      return (New-DshCaptureFailure "invalid window rect ${x},${y} ${w}x${h}" 2)
    }
  }

  # An explicit -Rect wins over everything above. Callers that pass it are either the overlay
  # (which already knows the rectangle the user drew) or an AI doing a headless grab; neither
  # wants a foreground window involved. Clamp to the virtual screen: GDI's CopyFromScreen with
  # an off-screen source silently yields black, which is far worse than a slightly smaller image.
  if ($Rect -ne '') {
    $parts = $Rect -split ','
    if ($parts.Count -ne 4) { return (New-DshCaptureFailure "invalid -Rect '$Rect' (want x,y,w,h)" 2) }
    $rx = 0; $ry = 0; $rw = 0; $rh = 0
    if (-not [int]::TryParse($parts[0].Trim(), [ref]$rx) -or
        -not [int]::TryParse($parts[1].Trim(), [ref]$ry) -or
        -not [int]::TryParse($parts[2].Trim(), [ref]$rw) -or
        -not [int]::TryParse($parts[3].Trim(), [ref]$rh)) {
      return (New-DshCaptureFailure "invalid -Rect '$Rect' (want integers)" 2)
    }
    if ($rw -le 0 -or $rh -le 0) { return (New-DshCaptureFailure "invalid -Rect '$Rect' (empty)" 2) }
    $cl = [Math]::Max($rx, $vx); $ct = [Math]::Max($ry, $vy)
    $cr = [Math]::Min($rx + $rw, $vx + $vw); $cb = [Math]::Min($ry + $rh, $vy + $vh)
    if ($cr -le $cl -or $cb -le $ct) { return (New-DshCaptureFailure "-Rect '$Rect' is outside the virtual screen" 2) }
    $x = $cl; $y = $ct; $w = $cr - $cl; $h = $cb - $ct
  }

  $hidden = $false
  $printFailed = $false
  $bringFailed = $false
  if ($HideSelf -and $hwnd -ne [IntPtr]::Zero) {
    # SW_HIDE=0 (no taskbar flicker), restore with SW_SHOW=5 / SW_RESTORE=9
    $wasIconic = [DshShot]::IsIconic($hwnd)
    [DshShot]::ShowWindow($hwnd, 0) | Out-Null
    $hidden = $true
    Start-Sleep -Milliseconds $HideDelayMs
  }

  # Bring the target to the front before a SCREEN grab.
  #
  # Why this exists: measured on this machine, PrintWindow(PW_RENDERFULLCONTENT) currently returns
  # False with 0.0% non-black coverage for EVERY window (Chrome, UWP, even Progman) while a live
  # BitBlt of the screen works fine. When the print path falls back to screen, we grab whatever
  # OCCLUDES the target - at exactly the right size and geometry, so the result is
  # indistinguishable from a correct capture. Raising the window first is the only way the screen
  # grab can be trusted. SetForegroundWindow is refused unless the caller is already foreground,
  # so this is best effort; when it does not take, `fallback` says so.
  #
  # It is opt-in because it moves the user's windows - correct for "user picked this window",
  # wrong for an AI headless grab.
  if ($BringToFront -and $hwnd -ne [IntPtr]::Zero) {
    [DshShot]::ShowWindow($hwnd, 9) | Out-Null     # SW_RESTORE (no-op if already normal)
    [DshShot]::BringWindowToTop($hwnd) | Out-Null
    [DshShot]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 220
    $fg = [DshShot]::GetForegroundWindow()
    if ($fg -ne $hwnd) { $bringFailed = $true }
  }

  try {
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $usedMethod = 'screen'
    try {
      if ($Mode -eq 'window' -and $Method -eq 'print') {
        # PW_RENDERFULLCONTENT (0x2) is what makes Chromium/Electron windows render
        # instead of returning a black frame.
        $hdc = $g.GetHdc()
        try {
          $ok = [DshShot]::PrintWindow($hwnd, $hdc, 2)
        } finally {
          $g.ReleaseHdc($hdc)
        }
        if ($ok) { $usedMethod = 'print' } else { $printFailed = $true }
      }
      if ($usedMethod -eq 'screen') {
        $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
      }
    } finally { $g.Dispose() }

    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally {
    if ($hidden) {
      [DshShot]::ShowWindow($hwnd, 5) | Out-Null     # SW_SHOW
      [DshShot]::ShowWindow($hwnd, 9) | Out-Null     # SW_RESTORE (no-op if already normal)
      [DshShot]::SetForegroundWindow($hwnd) | Out-Null
    }
  }

  # hwnd is always reported (0 when nothing was resolved, i.e. desktop mode) so the host can
  # close the picker loop: "this PNG is of that row". $hwndv is already the exact [long], so no
  # method call is needed - and calling .ToInt64() would throw, since $Hwnd is a plain Int64.
  $hwndOut = [long]$hwndv
  $info = [pscustomobject]@{
    mode = $Mode; left = $x; top = $y; width = $w; height = $h
    hwnd = $hwndOut
    virtualLeft = $vx; virtualTop = $vy; virtualWidth = $vw; virtualHeight = $vh
    hidden = $hidden; method = $usedMethod; path = (Resolve-Path -LiteralPath $Out).Path
  }
  # Only present when the requested handle was dead - the host surfaces it as a toast.
  if ($fallback) { $info | Add-Member -NotePropertyName fallback -NotePropertyValue $fallback }
  elseif ($printFailed) { $info | Add-Member -NotePropertyName fallback -NotePropertyValue 'print-failed' }
  if ($bringFailed) { $info | Add-Member -NotePropertyName broughtToFront -NotePropertyValue $false }
  elseif ($BringToFront) { $info | Add-Member -NotePropertyName broughtToFront -NotePropertyValue $true }

  return [pscustomobject]@{ ok = $true; error = ''; exitCode = 0; info = $info }
}
