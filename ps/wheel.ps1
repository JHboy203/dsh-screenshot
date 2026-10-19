# dsh-screenshot - cursor helpers + synthetic wheel scroll (for the scrolling/long screenshot).
#
# Three modes (one file, because they all need the same Add-Type block):
#
#   1) read the cursor      : wheel.ps1 -GetPos
#   2) put the cursor back  : wheel.ps1 -SetPos "800,500"
#   3) scroll for real      : wheel.ps1 -X 800 -Y 500 -Delta -400 [-Times 1]
#   4) click a point (TEST) : wheel.ps1 -Click "800,500"
#
# Mode 4 was added so the AI verification bridge could complete a pickwindow.ps1 selection
# (which normally needs a human click) without troubling the user. MEASURED 2026-10-16: that
# does NOT work - a low-integrity caller (the DSH tool sandbox, i.e. anything the AI runs)
# has its SetCursorPos/mouse_event silently dropped by UIPI: `-SetPos "1200,600"` returned
# ok:false and `-GetPos` still reported the old position. So modes 3 and 4 only do anything
# when the caller is a normal-integrity process (the plugin host), and plugin runtime code
# must never call mode 4. Kept because the host *can* use it; do not mistake it for a tool
# the AI can drive.
#
# Mode 3 moves the real cursor to (X,Y) and posts mouse wheel events - this is what QQ's long
# screenshot does too. Auto-scroll uses it; the session saves the cursor with -GetPos before
# starting and puts it back with -SetPos when it ends, so the user's pointer is not left
# parked in the middle of the region.
#
# NOTE: from a LOW-integrity process UIPI silently drops these events. The DSH tool sandbox
# runs at low integrity; the plugin host process does not - that is why this lives host-side.
#
# Every mode prints one JSON line as the last line of stdout (project convention).
param(
  [int]$X = [int]::MinValue,
  [int]$Y = [int]::MinValue,
  [int]$Delta = -400,
  [int]$Times = 1,
  [switch]$GetPos,
  [string]$SetPos = '',
  [string]$Click = ''
)

$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshWheel {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  // DPI: everything this script touches is in PHYSICAL screen pixels (the overlay reports the
  // virtual screen in physical px). An unaware process gets a VIRTUALISED desktop (1920 -> 1536
  // at 125%) and SetCursorPos silently CLAMPS to it -- measured R25: asking for x=1858 landed
  // the cursor on x=1535, so the wheel scrolled whatever window happened to be there.
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  public const uint WHEEL = 0x0800;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public static void MakeDpiAware() {
    try { SetProcessDpiAwareness(2); } catch { }   // PROCESS_PER_MONITOR_DPI_AWARE
    try { SetProcessDPIAware(); } catch { }        // fallback (Win7+)
  }
  public static void Scroll(int dx) { mouse_event(WHEEL, 0, 0, dx, UIntPtr.Zero); }
  public static void Click() { mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero); mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero); }
}
"@

# Must happen before ANY pixel is read or written (see MakeDpiAware above).
[DshWheel]::MakeDpiAware()

function Write-Json($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress)
}

if ($GetPos) {
  $p = New-Object DshWheel+POINT
  $ok = [DshWheel]::GetCursorPos([ref]$p)
  Write-Json @{ ok = [bool]$ok; x = [int]$p.X; y = [int]$p.Y }
  exit 0
}

if ($SetPos -ne '') {
  $parts = $SetPos.Split(',')
  if ($parts.Length -lt 2) {
    Write-Json @{ ok = $false; error = 'SetPos expects "x,y"' }
    exit 1
  }
  $sx = 0; $sy = 0
  if (-not [int]::TryParse($parts[0].Trim(), [ref]$sx) -or -not [int]::TryParse($parts[1].Trim(), [ref]$sy)) {
    Write-Json @{ ok = $false; error = 'SetPos expects two integers' }
    exit 1
  }
  $ok = [DshWheel]::SetCursorPos($sx, $sy)
  Write-Json @{ ok = [bool]$ok; x = $sx; y = $sy }
  exit 0
}

if ($Click -ne '') {
  # TEST-ONLY: used by the AI verification bridge to click a point on the real desktop
  # (e.g. to complete a pickwindow.ps1 selection without asking the user to click).
  # The plugin runtime never calls this mode.
  $parts = $Click.Split(',')
  if ($parts.Length -lt 2) {
    Write-Json @{ ok = $false; error = 'Click expects "x,y"' }
    exit 1
  }
  $cx = 0; $cy = 0
  if (-not [int]::TryParse($parts[0].Trim(), [ref]$cx) -or -not [int]::TryParse($parts[1].Trim(), [ref]$cy)) {
    Write-Json @{ ok = $false; error = 'Click expects two integers' }
    exit 1
  }
  [DshWheel]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 70
  [DshWheel]::Click()
  Write-Json @{ ok = $true; x = $cx; y = $cy; clicked = $true }
  exit 0
}

if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) {
  Write-Json @{ ok = $false; error = 'need -X/-Y (scroll), -GetPos or -SetPos' }
  exit 1
}

[DshWheel]::SetCursorPos($X, $Y) | Out-Null
# Wait for the cursor to ACTUALLY arrive before sending the wheel.
#
# Why: the wheel goes to whatever window is under the cursor. If SetCursorPos is dropped
# (low-integrity caller / UIPI) or clamped (DPI-unaware process on a scaled screen), sending
# the wheel anyway would scroll a DIFFERENT window - silently, and the long screenshot just
# says "the page did not move". Report `moved` from what we observe, not from SetCursorPos's
# return value, and never scroll when it did not take.
$moved = $false
$waited = 0
while ($waited -lt 150) {
  $p0 = New-Object DshWheel+POINT
  if ([DshWheel]::GetCursorPos([ref]$p0) -and $p0.X -eq $X -and $p0.Y -eq $Y) { $moved = $true; break }
  Start-Sleep -Milliseconds 4
  $waited += 4
}
if (-not $moved) {
  Write-Json @{ ok = $true; moved = $false; x = $X; y = $Y; delta = $Delta; times = 0; error = 'cursor did not reach the point; wheel not sent' }
  exit 0
}
for ($i = 0; $i -lt [Math]::Max(1, $Times); $i++) {
  [DshWheel]::Scroll($Delta)
  Start-Sleep -Milliseconds 60
}
Write-Json @{ ok = $true; moved = $true; x = $X; y = $Y; delta = $Delta; times = $Times }
exit 0
