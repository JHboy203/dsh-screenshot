# recframe.ps1 -- draw a thin border around the area being recorded.
#
# WHY
#   A region recording has no visible boundary once the selection overlay closes.
#   If the user switches to the window he is recording, nothing on screen says
#   "these pixels and no others" -- the only hint lives in the DSH window, which is
#   usually behind the application being recorded. Every recorder draws a frame for
#   exactly this reason.
#
# THE TWO RULES THAT MATTER
#   1. The border must be OUTSIDE the captured rectangle. gdigrab grabs exactly
#      (x,y,w,h); a frame drawn inside it would be encoded into the video. So the
#      window sits at (x-t, y-t) with size (w+2t, h+2t): its inner edge lines up with
#      the captured edge and not one pixel of the frame is inside.
#   2. The interior must not exist AT ALL. This is a WINDOW REGION, not a
#      transparency trick: the form's region is the union of the four bars, so the
#      interior is not part of the window -- the desktop shows through and clicks
#      pass through, by construction.
#
#      MEASURED (R32, this is why the region route exists): the first version used
#      BackColor = TransparencyKey = magenta with the bars filled in OnPaint. The
#      window reported Visible=true, the stop file closed it cleanly, and the screen
#      showed NOTHING -- a fully transparent window, with no error anywhere. A pixel
#      probe caught it (0 border pixels, interior unchanged). Do not go back to
#      TransparencyKey for this.
#
# WHY IT IS FAIL-OPEN
#   The frame is a nicety. If it cannot be created (no desktop, no Add-Type, a stale
#   instance), recording must still work -- the caller ignores our exit code and never
#   waits for us.
#
# DOES NOT STEAL FOCUS
#   WS_EX_NOACTIVATE + ShowWithoutActivation: showing this window must not pull focus
#   away from the application the user is about to record.
#
# STOP CONTRACT
#   -StopFile is polled every 250ms; the caller writes it when recording stops. The
#   caller may also just kill this process -- there is nothing to flush.
#
# ASCII ONLY. PS 5.1 decodes a BOM-less UTF-8 file as ANSI and can swallow code
# lines, so this file must not contain a single non-ASCII byte (see the plugin's
# pitfall list).

param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [int]$Thickness = 2,
  [string]$StopFile = '',
  [int]$MaxMinutes = 480,
  # Optional: write the window's OWN idea of its geometry here, once shown. The caller needs this
  # because "the border is somewhere else than I think" and "the border is not drawn" look
  # identical from the outside (both = zero border pixels in the expected band).
  [string]$Info = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public class DshRecFrameDpi {
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  // R54: the window is WS_EX_NOACTIVATE, so it can never become the foreground window -- and a
  // TopMost window that IS the foreground one paints above it no matter which was created later.
  // Measured 2026-10-24 (probe fixture as backdrop): the frame existed, reported its geometry and
  // painted, yet the capture saw 0/0/0/0 border pixels. Explicitly moving to the top of the
  // topmost band -- without activating -- is the only reliable answer.
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}

public class DshRecFrame : Form {
  public Color Border = Color.FromArgb(255, 235, 64, 52);
  public int T = 2;

  public DshRecFrame() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    TopMost = true;
    SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.Opaque, true);
    SetStyle(ControlStyles.Selectable, false);
  }

  protected override bool ShowWithoutActivation { get { return true; } }

  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000;   // WS_EX_NOACTIVATE  -- never take focus
      cp.ExStyle |= 0x00000080;   // WS_EX_TOOLWINDOW  -- stay out of alt-tab
      return cp;
    }
  }

  protected override void OnPaintBackground(PaintEventArgs e) { /* Opaque: nothing to erase */ }

  protected override void OnPaint(PaintEventArgs e) {
    // The window region already excludes the interior, so painting the whole client
    // rectangle with the border colour is enough -- no per-bar maths to get wrong.
    e.Graphics.Clear(Border);
  }

  /**
   * Clip the window down to the four bars. Everything else about the form (focus,
   * hit-testing, capture) then behaves as if the window were not there.
   */
  public void ClipToBars(int w, int h, int t) {
    T = t;
    using (GraphicsPath path = new GraphicsPath()) {
      path.AddRectangle(new Rectangle(0, 0, w, t));                 // top
      path.AddRectangle(new Rectangle(0, h - t, w, t));             // bottom
      path.AddRectangle(new Rectangle(0, t, t, h - 2 * t));         // left
      path.AddRectangle(new Rectangle(w - t, t, t, h - 2 * t));     // right
      Region = new Region(path);
    }
  }
}
'@ -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'

# Physical pixels: the caller speaks gdigrab coordinates, which are physical. Without
# this the frame would drift on a scaled display (this machine runs 125%).
$dpi = 'none'
try { if ([DshRecFrameDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $dpi = 'per-monitor-v2' } } catch { }
if ($dpi -eq 'none') { try { if ([DshRecFrameDpi]::SetProcessDPIAware()) { $dpi = 'system' } } catch { } }

$t = [Math]::Max(1, [Math]::Min(8, $Thickness))
$fw = $W + 2 * $t
$fh = $H + 2 * $t
$f = New-Object DshRecFrame
$f.Bounds = New-Object System.Drawing.Rectangle(($X - $t), ($Y - $t), $fw, $fh)
$f.ClipToBars($fw, $fh, $t)

# Poll the stop file from a WinForms timer (never from a background thread: it would
# touch the form from the wrong thread).
$script:stopWhen = (Get-Date).AddMinutes([Math]::Max(1, $MaxMinutes))
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  $due = $false
  if ($StopFile -ne '' -and (Test-Path -LiteralPath $StopFile)) { $due = $true }
  if ((Get-Date) -gt $script:stopWhen) { $due = $true }
  if ($due) { $timer.Stop(); $f.Close() }
})

$f.Add_Shown({
  # R54: raise ourselves to the TOP of the topmost band. "Created later" is not enough: a TopMost
  # window that is also the foreground window wins the z-order, and this frame is WS_EX_NOACTIVATE
  # by design (it must never take focus from what is being recorded). SWP_NOSIZE|NOMOVE|NOACTIVATE|
  # SHOWWINDOW + HWND_TOPMOST = lift without stealing focus, and without changing the geometry the
  # caller just computed.
  try { [void][DshRecFrameDpi]::SetWindowPos($f.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040) } catch {}
  $timer.Start()
  if ($Info -ne '') {
    try {
      $r = $f.RectangleToScreen($f.ClientRectangle)
      $payload = @{ ok = $true; hwnd = [int]$f.Handle; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height; dpi = $dpi; t = $t }
      [System.IO.File]::WriteAllText($Info, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    } catch {
      try { [System.IO.File]::WriteAllText($Info, ('{"ok":false,"error":"' + ($_ -replace '[\r\n"]', ' ') + '"}'), (New-Object System.Text.UTF8Encoding($false))) } catch {}
    }
  }
})
[void]$f.ShowDialog()

# One line of ground truth for the caller (harmless if nobody reads it).
Write-Output ("closed x={0} y={1} w={2} h={3} t={4} dpi={5}" -f $X, $Y, $W, $H, $t, $dpi)
