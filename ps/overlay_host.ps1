# overlay_host.ps1 -- RESIDENT overlay helper (M1 selection + M2 annotation).
#
# WHY THIS EXISTS
#   The DSH renderer can only draw inside its own window (a DOM plane), so a region
#   picked there can never sit on top of another application. Anything that must
#   cover the real desktop has to own a real HWND. ps/pickwindow.ps1 proved the
#   route; ps/overlay_poc.ps1 proved it end to end (a human dragged a rectangle on
#   the real desktop and the crop reached the clipboard).
#
# WHY RESIDENT
#   A cold powershell.exe costs ~4.2s on this machine (measured). Spawning one per
#   screenshot makes the native overlay slower than the DOM one it replaces. So:
#   start once at plugin init, warm up Add-Type + DPI, then serve requests forever.
#
# WHY THE FORM IS A C# SUBCLASS
#   The first version painted from a PowerShell Paint handler and called a full
#   Invalidate() on every mouse move. That is the classic WinForms recipe for
#   flicker: each frame WinForms first fills the dirty area with BackColor (BLACK)
#   and only then asks us to draw the frame on top, so the black shows through --
#   and a 1920x1080 repaint per mouse move is ~2M pixels, which lags as well.
#   ps/pickwindow.ps1 hit the same wall and recorded the lesson ("only the changed
#   strips are repainted"). Here the fix is structural, inside the form class:
#     * ControlStyles.Opaque | AllPaintingInWmPaint | UserPaint | OptimizedDoubleBuffer
#       -> everything is drawn into an off-screen buffer and blitted, so no black
#          frame can reach the screen; OnPaintBackground is a no-op.
#     * only the union of the old and new rect is invalidated -> a drag repaints a
#       few thousand pixels per move instead of two million.
#     * OnPaint draws just e.ClipRectangle.
#
# M2 (this version): annotation lives in the window layer too.
#   Two phases, one window:
#     phase 0  drag a rectangle       (the M1 behaviour)
#     phase 1  draw on it             Rect / Arrow / Pen, Undo, Ctrl+Z
#              Enter = copy, Esc = back to phase 0, Esc again = cancel
#   Toolbar labels are ASCII on purpose: this file must stay ASCII-only (the console
#   is GBK, and PS 5.1 decodes a BOM-less UTF-8 .ps1 as ANSI, swallowing code lines).
#   The form renders the final image itself (RenderResult) so the annotation model
#   never has to leave C#.
#
# PROTOCOL (file based -- this sandbox forbids CreatePipe, so no pipes anywhere)
#   node writes   <Dir>\ovlreq-<callTag>.json   { timeoutSec, dim, png, tag,
#                                                 hideSelf?, hideTitle? }
#   we read it, delete it, run the picker, then write
#                 <Dir>\ovlres-<callTag>.json   { ok, cancelled, x, y, w, h, clip,
#                                                 png, ms, dpi, screenW, screenH,
#                                                 capMs, repaint, shapes, reason,
#                                                 hidden, error }
#   hideSelf: hide the window whose title contains hideTitle for the duration of the
#   freeze (so the caller's own UI is not in the picture), put it back the moment the
#   overlay is up. `hidden` in the result says whether a window was actually hidden.
#   ready handshake: <Dir>\ready-<Tag>.json      written once Add-Type + DPI are done
#   shutdown:        <Dir>/stop-<Tag>.flag       we see it, delete ready, exit
#   <Tag> identifies THIS generation of the helper (never the same twice).
#
# RULES CARRIED OVER FROM pickwindow.ps1 / overlay_poc.ps1 (all measured):
#   * DPI awareness must be declared BEFORE anything measures pixels.
#   * the frozen frame is captured BEFORE the form is shown.
#   * on success the form is hidden, given ~150ms, and only then is the result
#     written -- node may capture the screen right after reading it.
#   * ASCII only.   * MUST be started with -STA.
#
# A failed pick must NEVER kill the helper: every per-request body is wrapped, the
# error is reported in the result file, and the loop keeps serving.

param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Tag,
  [int]$DimPercent = 55
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Log([string]$m) { [Console]::Error.WriteLine('[overlay_host ' + $Tag + '] ' + $m) }

if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
$readyFile = Join-Path $Dir ('ready-' + $Tag + '.json')
$stopFile = Join-Path $Dir ('stop-' + $Tag + '.flag')

function Write-Json([string]$path, $obj) {
  $tmp = $path + '.tmp'
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# ---- DPI first, before anything measures pixels -------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OvlDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
$script:dpiMode = 'none'
try { if ([OvlDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $script:dpiMode = 'per-monitor-v2' } } catch { }
if ($script:dpiMode -eq 'none') { try { if ([OvlDpi]::SetProcessDpiAwarenessContext([IntPtr](-3))) { $script:dpiMode = 'per-monitor' } } catch { } }
if ($script:dpiMode -eq 'none') { try { if ([OvlDpi]::SetProcessDPIAware()) { $script:dpiMode = 'system-aware' } } catch { } }
Log ('dpi=' + $script:dpiMode)

# ---- hiding the caller's own window before the freeze ("hide self", R30) ---------
# Why it has to happen HERE and not in the overlay UI: the frame is frozen BEFORE the overlay
# window exists, so a toggle drawn on the overlay would be too late -- the picture already
# contains the caller. QQ behaves the same way: its main window is gone by the time you drag.
#
# Matching is by title (substring, case-insensitive) because that is how the rest of the plugin
# finds DSH too (capture.ps1 -Target 'DeepSeek Harness'). A title that matches nothing is NOT an
# error: hiding is a convenience, the capture itself must still work.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OvlWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static IntPtr FindVisible(string needle) {
    if (needle == null || needle.Length == 0) return IntPtr.Zero;
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# Still-hidden bookkeeping lives in script scope so the form's event handlers and the finally
# block can all see it. Invariant: DSH must NEVER be left hidden by a failed capture.
$script:selfHwnd = [IntPtr]::Zero
$script:selfWasIconic = $false
$script:selfHiddenNow = $false

function Hide-SelfWindow([string]$needle) {
  if ([string]::IsNullOrEmpty($needle)) { return $false }
  $h = [OvlWin]::FindVisible($needle)
  if ($h -eq [IntPtr]::Zero) { Log ('hide-self: no visible window matching "' + $needle + '"'); return $false }
  $script:selfHwnd = $h
  $script:selfWasIconic = [bool][OvlWin]::IsIconic($h)
  [void][OvlWin]::ShowWindow($h, 0)     # SW_HIDE
  $script:selfHiddenNow = $true
  # Give the desktop a beat to repaint behind it: freezing immediately can catch a half-faded
  # copy of the very window we just hid, which looks like a ghost rather than like "gone".
  Start-Sleep -Milliseconds 260
  Log ('hide-self: hid hwnd=' + $h.ToInt64() + ' iconic=' + $script:selfWasIconic)
  return $true
}

# -ToFront is only safe AFTER the overlay closes: SetForegroundWindow while the overlay owns the
# keyboard focus would steal it from the overlay, and Enter/Esc would stop working mid-annotation.
function Restore-SelfWindow([switch]$ToFront) {
  $h = $script:selfHwnd
  if ($h -eq [IntPtr]::Zero) { return }
  if ($script:selfHiddenNow) {
    try {
      if ($script:selfWasIconic) { [void][OvlWin]::ShowWindow($h, 6) }   # SW_MINIMIZE (it was iconic)
      else { [void][OvlWin]::ShowWindow($h, 5) }                        # SW_SHOW (current placement)
    } catch { }
    $script:selfHiddenNow = $false
    Log 'hide-self: restored'
  }
  if ($ToFront) { try { [void][OvlWin]::SetForegroundWindow($h) } catch { } }
}

# ---- the double-buffered, clip-aware form (see header for why it is C#) --------
# NOTE: Add-Type in PS 5.1 compiles with the C# 5 compiler -- no string interpolation,
# no expression-bodied members, no ?. , no out var. Keep this file C# 5 clean.
Add-Type -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public class DshShape {
  public int Tool;                  // 0 rect, 1 arrow, 2 pen, 3 mosaic, 4 number
  public Point A;
  public Point B;
  public string Text = "";
  public Color Col = Color.FromArgb(255, 76, 141, 255);
  public float W = 2f;
  public List<Point> Pts = new List<Point>();

  public DshShape(int tool) { Tool = tool; }

  public Rectangle Bounds {
    get {
      if (Tool == 4) {
        return new Rectangle(A.X - 16, A.Y - 16, 32, 32);
      }
      if (Tool == 5) {
        return new Rectangle(A.X - 4, A.Y - 4, Math.Max(80, Text.Length * 18), 34);
      }
      if (Tool == 2 && Pts.Count > 1) {
        int x1 = Pts[0].X, y1 = Pts[0].Y, x2 = Pts[0].X, y2 = Pts[0].Y;
        for (int i = 1; i < Pts.Count; i++) {
          if (Pts[i].X < x1) x1 = Pts[i].X;
          if (Pts[i].Y < y1) y1 = Pts[i].Y;
          if (Pts[i].X > x2) x2 = Pts[i].X;
          if (Pts[i].Y > y2) y2 = Pts[i].Y;
        }
        return new Rectangle(x1, y1, Math.Max(1, x2 - x1), Math.Max(1, y2 - y1));
      }
      int rx = Math.Min(A.X, B.X), ry = Math.Min(A.Y, B.Y);
      return new Rectangle(rx, ry, Math.Max(1, Math.Abs(B.X - A.X)), Math.Max(1, Math.Abs(B.Y - A.Y)));
    }
  }
}

public class DshOverlayForm : Form {
  public Bitmap RawBmp;
  public Bitmap DimBmp;
  public Color Accent = Color.FromArgb(255, 76, 141, 255);
  // Each shape remembers the colour it was drawn with, so cycling later does not
  // repaint earlier strokes.
  private Color[] palette = new Color[] {
    Color.FromArgb(255, 76, 141, 255),
    Color.FromArgb(255, 240, 68, 56),
    Color.FromArgb(255, 255, 193, 7),
    Color.FromArgb(255, 76, 175, 80),
    Color.FromArgb(255, 255, 255, 255)
  };
  private int colorIdx = 0;
  // Stroke weight, cycled with X. Stored per shape (like the colour) so changing it
  // never re-strokes what is already on screen.
  private float[] widths = new float[] { 2f, 4f, 6f, 8f };
  private int widthIdx = 0;
  private float lineWidth = 2f;
  public bool Confirmed = false;
  public bool Cancelled = false;
  public bool Pinned = false;
  public long Repaints = 0;

  // RegionOnly: the caller wants the rectangle and nothing else (long screenshot / OCR /
  // translate all start with "frame a piece of the screen"). No annotate phase, no
  // clipboard write, no PNG -- pressing Enter on a picture nobody asked for is just waste.
  // Flipped by FinishSelection() the same way a normal drag flips into phase 1, so the
  // path being exercised is the real one.
  public bool RegionOnly = false;
  public bool RegionPicked = false;

  // ---- toolbar skin (R66) ----------------------------------------------------
  // Before: nine 64x26 flat rectangles with text labels and no state of their own.
  // That read like a debug strip (the user asked for a cosmetic pass), and it was
  // 624 px wide so it covered whatever it floated over. Now it is one rounded card:
  //   [icon + caption] x9, with a hover state, a filled pill for the active tool,
  //   group separators, and the shortcut line INSIDE the card (it used to be a
  //   floating white string under the bar, which was the ugliest part).
  // 44x46 keeps the three-glyph CJK captions (ma-sai-ke) on one line at 8 pt; icons
  // are drawn on a 20x20 grid so a DPI change only scales the box, not the design.
  // NOTE: no CJK in this file -- it must stay ASCII (PS 5.1 decodes BOM-less UTF-8
  // as ANSI and swallows code lines); captions arrive from the client as Labels.
  private const int BtnW = 44;
  private const int BtnH = 46;
  private const int BtnGap = 4;
  private const int BarPad = 6;
  private const int SepSlot = 9;      // slot reserved for a group separator
  private const int IconBox = 20;
  private const int HintRow = 20;

  private int hoverBtn = -1;
  // Last card rectangle actually painted: the card sits 10..92 px outside the
  // selection, so invalidating only Grow(sel) would leave trails when the selection
  // moves. Union of old + new is what repaints it.
  private Rectangle lastCard = Rectangle.Empty;

  private readonly Font capFont = new Font("Microsoft YaHei UI", 8.5f);
  private readonly Font capFontMin = new Font("Microsoft YaHei UI", 7f);
  private readonly Font hintFont = new Font("Microsoft YaHei UI", 8.5f);
  private readonly Font hintFontMin = new Font("Microsoft YaHei UI", 7.5f);
  private static readonly Color CardBg = Color.FromArgb(243, 28, 28, 34);
  private static readonly Color CardEdge = Color.FromArgb(40, 255, 255, 255);
  private static readonly Color InkDim = Color.FromArgb(150, 255, 255, 255);
  private static readonly Color HoverFill = Color.FromArgb(28, 255, 255, 255);
  private static readonly Color SepInk = Color.FromArgb(30, 255, 255, 255);

  private Rectangle sel = Rectangle.Empty;
  private Rectangle prevSel = Rectangle.Empty;
  private int phase = 0;                       // 0 = selecting, 1 = annotating
  private int tool = 0;                        // 0 rect, 1 arrow, 2 pen, 3 mosaic, 4 number
  private int nextNum = 1;
  private List<DshShape> shapes = new List<DshShape>();
  private DshShape cur = null;
  private Point downPt;
  private bool dragging = false;
  private readonly Font labelFont = new Font("Consolas", 11f);
  private readonly Font textFont = new Font("Microsoft YaHei UI", 16f);

  // Toolbar captions. Null = the ASCII defaults baked into BtnLabel(); the client can
  // pass Chinese through the request opts, because this .ps1 file itself must stay
  // ASCII-only (PS 5.1 mis-decodes BOM-less UTF-8 and swallows code lines).
  public string[] Labels = null;
  // The keyboard hint under the toolbar. Same reason as Labels: this file is ASCII only,
  // so any Chinese has to arrive with the request.
  public string Hint = "";

  // A real TextBox, not a hand-rolled key buffer: only a real edit control receives
  // IME composition, so only a real TextBox can take Chinese input.
  private TextBox editor = null;
  private Point editAnchor;
  // Magnifier state (selecting phase only).
  private Point cursor = new Point(-1, -1);
  // Test hook: when set, RunSelfTest dumps the whole overlay (toolbar + loupe) to a PNG.
  public string FormShotPath = "";

  public DshOverlayForm() {
    SetStyle(ControlStyles.Opaque | ControlStyles.AllPaintingInWmPaint |
             ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    TopMost = true;
    ShowInTaskbar = false;
    Cursor = Cursors.Cross;
    BackColor = Color.Black;
    KeyPreview = true;
  }

  public Rectangle Selection { get { return sel; } }
  public int Phase { get { return phase; } }
  public int ShapeCount { get { return shapes.Count; } }
  // R66: what the self test's "selection near the bottom" dump measured, so the layout rule
  // ("no room below -> the card goes above the selection") is assertable, not just viewable.
  public Rectangle FlipBar = Rectangle.Empty;
  public bool FlipAbove = false;
  public int BarWidthPublic { get { return BarWidth(); } }
  public int BarHeightPublic { get { return BarHeight(); } }

  // Opaque + AllPaintingInWmPaint already skip this; the background fill is exactly
  // what produced the flicker, so keep it a hard no-op.
  protected override void OnPaintBackground(PaintEventArgs e) { }

  private static Rectangle Grow(Rectangle r) {
    if (r.Width <= 0 || r.Height <= 0) return Rectangle.Empty;
    // 2px border + the size badge. The toolbar card is NOT inside this margin any more
    // (it can sit ~96 px below the selection and is 458 px wide), so it is invalidated
    // through InvalidateToolbar() instead -- see SetSel below.
    return Rectangle.Inflate(r, 8, 40);
  }

  private void InvalidateUnion(Rectangle a, Rectangle b) {
    Rectangle u = Rectangle.Union(Grow(a), Grow(b));
    if (u.Width > 0 && u.Height > 0) Invalidate(u);
    else Invalidate();
  }

  public void SetSel(Rectangle r) {
    prevSel = sel;
    sel = r;
    InvalidateUnion(prevSel, r);
    // The card follows the selection; without this it leaves a trail behind while the
    // selection is being dragged (measured: the old card stayed painted at its old spot).
    InvalidateToolbar();
  }

  // Total width of the card: pad + nine buttons + eight gaps + two separator slots.
  private int BarWidth() { return BarPad * 2 + BtnW * 9 + BtnGap * 8 + SepSlot * 2; }
  // Height: pad + button row + divider gap + shortcut row + pad.
  private int BarHeight() { return BarPad * 2 + BtnH + HintRow + 4; }

  // Left edge of button i inside the card. The separator slots sit before the colour
  // swatch (i == 7) and before undo (i == 8), which is the only grouping that matters:
  // tools | colour | undo.
  private int BtnX(int i) {
    int x = BarPad + i * (BtnW + BtnGap);
    if (i >= 7) x += SepSlot;
    if (i >= 8) x += SepSlot;
    return x;
  }

  private Rectangle ToolbarRect() {
    if (sel.Width < 2 || sel.Height < 2) return Rectangle.Empty;
    int tw = BarWidth();
    int th = BarHeight();
    int ty = sel.Bottom + 10;
    if (ty + th > this.ClientSize.Height - 6) ty = sel.Top - th - 10;
    if (ty < 6) ty = 6;
    int tx = sel.X;
    if (tx + tw > this.ClientSize.Width - 6) tx = this.ClientSize.Width - tw - 6;
    if (tx < 6) tx = 6;
    return new Rectangle(tx, ty, tw, th);
  }

  private Rectangle BtnRect(int i) {
    Rectangle tb = ToolbarRect();
    return new Rectangle(tb.X + BtnX(i), tb.Y + BarPad, BtnW, BtnH);
  }

  // The card plus the room its shadow needs. Used for invalidation only.
  private Rectangle CardArea() {
    Rectangle tb = ToolbarRect();
    if (tb.Width <= 0 || tb.Height <= 0) return Rectangle.Empty;
    return Rectangle.Inflate(tb, 12, 12);
  }

  private void InvalidateToolbar() {
    Rectangle now = CardArea();
    Rectangle u = Rectangle.Union(now, lastCard);
    lastCard = now;
    if (u.Width > 0 && u.Height > 0) Invalidate(u);
  }

  // Rounded rectangle path. GDI+ has no rounded-rect primitive, and the whole card,
  // every button pill and the selection size badge are rounded -- one helper, one look.
  private static GraphicsPath RoundRect(Rectangle r, int radius) {
    GraphicsPath p = new GraphicsPath();
    int d = radius * 2;
    if (r.Width <= d || r.Height <= d) { p.AddRectangle(r); return p; }
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }

  private string BtnLabel(int i) {
    if (Labels != null && i < Labels.Length && Labels[i] != null && Labels[i].Length > 0) return Labels[i];
    if (i == 0) return "Rect";
    if (i == 1) return "Arrow";
    if (i == 2) return "Pen";
    if (i == 3) return "Mosaic";
    if (i == 4) return "Number";
    if (i == 5) return "Text";
    if (i == 6) return "Ellipse";
    if (i == 7) return "";
    return "Undo";
  }

  private void DrawMosaic(Graphics g, Rectangle r, int block) {
    if (RawBmp == null || r.Width < 2 || r.Height < 2) return;
    int sw = Math.Max(1, r.Width / block);
    int sh = Math.Max(1, r.Height / block);
    using (Bitmap small = new Bitmap(sw, sh)) {
      using (Graphics sg = Graphics.FromImage(small)) {
        sg.InterpolationMode = InterpolationMode.HighQualityBilinear;
        sg.DrawImage(RawBmp, new Rectangle(0, 0, sw, sh), r, GraphicsUnit.Pixel);
      }
      InterpolationMode old = g.InterpolationMode;
      PixelOffsetMode oldOff = g.PixelOffsetMode;
      g.InterpolationMode = InterpolationMode.NearestNeighbor;
      g.PixelOffsetMode = PixelOffsetMode.Half;
      g.DrawImage(small, r);
      g.InterpolationMode = old;
      g.PixelOffsetMode = oldOff;
    }
  }

  private DshShape NewShape(int t) {
    DshShape s = new DshShape(t);
    s.Col = Accent;
    s.W = lineWidth;
    return s;
  }

  private void CycleWidth() {
    widthIdx = (widthIdx + 1) % widths.Length;
    lineWidth = widths[widthIdx];
  }

  private void CycleColor() {
    colorIdx = (colorIdx + 1) % palette.Length;
    Accent = palette[colorIdx];
    Invalidate();
  }

  // Light backgrounds need dark glyphs: without this, picking white as the colour makes
  // the number badge (white digit on a white disc) and the active toolbar button
  // (white label on a white fill) disappear entirely.
  private static bool IsLight(Color c) {
    return (c.R * 299 + c.G * 587 + c.B * 114) / 1000 > 150;
  }

  private void DrawShape(Graphics g, DshShape s, float w) {
    if (s.Tool == 5) {
      if (s.Text == null || s.Text.Length == 0) return;
      // dark halo first so the glyphs stay readable on any background, then the
      // shape's own colour on top (white is a colour choice, not a hard-coded default)
      using (SolidBrush halo = new SolidBrush(Color.FromArgb(200, 0, 0, 0))) {
        g.DrawString(s.Text, textFont, halo, s.A.X + 2, s.A.Y + 2);
        g.DrawString(s.Text, textFont, halo, s.A.X + 2, s.A.Y - 2);
      }
      using (SolidBrush fill = new SolidBrush(s.Col)) {
        g.DrawString(s.Text, textFont, fill, s.A.X + 2, s.A.Y);
      }
      return;
    }
    if (s.Tool == 3) {
      // real pixelation of the frozen frame underneath, not a flat box
      Rectangle mr = s.Bounds;
      DrawMosaic(g, mr, 9);
      using (Pen outline = new Pen(s.Col, 1f)) g.DrawRectangle(outline, mr.X, mr.Y, mr.Width, mr.Height);
      return;
    }
    if (s.Tool == 4) {
      int rad = 13;
      Rectangle cr = new Rectangle(s.A.X - rad, s.A.Y - rad, rad * 2, rad * 2);
      using (SolidBrush b = new SolidBrush(s.Col)) g.FillEllipse(b, cr);
      string t = s.Text.Length > 0 ? s.Text : "?";
      SizeF sz = g.MeasureString(t, labelFont);
      using (SolidBrush digit = new SolidBrush(IsLight(s.Col) ? Color.Black : Color.White)) {
        g.DrawString(t, labelFont, digit, cr.X + (cr.Width - sz.Width) / 2f, cr.Y + (cr.Height - sz.Height) / 2f);
      }
      return;
    }
    using (Pen pen = new Pen(s.Col, s.W)) {
      pen.StartCap = LineCap.Round;
      pen.EndCap = LineCap.Round;
      if (s.Tool == 0) {
        Rectangle r = s.Bounds;
        g.DrawRectangle(pen, r.X, r.Y, r.Width, r.Height);
      } else if (s.Tool == 6) {
        Rectangle r = s.Bounds;
        g.DrawEllipse(pen, r.X, r.Y, r.Width, r.Height);
      } else if (s.Tool == 1) {
        g.DrawLine(pen, s.A, s.B);
        double ang = Math.Atan2(s.B.Y - s.A.Y, s.B.X - s.A.X);
        double head = 16.0;
        for (int i = 0; i < 2; i++) {
          double d = ang + Math.PI + (i == 0 ? 0.45 : -0.45);
          Point p = new Point(s.B.X + (int)(Math.Cos(d) * head), s.B.Y + (int)(Math.Sin(d) * head));
          g.DrawLine(pen, s.B, p);
        }
      } else {
        if (s.Pts.Count > 1) g.DrawLines(pen, s.Pts.ToArray());
      }
    }
  }

  private void BeginText(Point p) {
    if (editor != null) CommitText();
    TextBox box = new TextBox();
    box.BorderStyle = BorderStyle.FixedSingle;
    // OPAQUE colour on purpose: TextBox throws "Control does not support transparent
    // background colors" for an alpha BackColor. That exception used to escape
    // OnMouseDown and take the whole overlay with it -- which is exactly how the text
    // tool broke. Caught by the self test, which drives the real editor path.
    box.BackColor = Color.FromArgb(30, 30, 36);
    box.ForeColor = Color.White;
    box.Font = new Font("Microsoft YaHei UI", 12f);
    box.Width = 240;
    int bx = Math.Min(p.X, this.ClientSize.Width - box.Width - 8);
    int by = Math.Min(p.Y, this.ClientSize.Height - 36);
    if (bx < 4) bx = 4;
    if (by < 4) by = 4;
    box.Location = new Point(bx, by);
    // Anchor the text where the BOX actually is, not where the mouse was: if the click
    // was near an edge the box gets nudged back on screen, and the text must follow it.
    editAnchor = new Point(bx, by);
    box.KeyDown += EditorKeyDown;
    box.LostFocus += EditorLostFocus;
    editor = box;
    this.Controls.Add(box);
    // Focusing straight from MouseDown loses the race with the mouse-up that follows,
    // so hand focus over once the current message has been dispatched.
    this.BeginInvoke((MethodInvoker)delegate { try { box.Focus(); } catch { } });
  }

  private void EditorKeyDown(object sender, KeyEventArgs e) {
    if (e.KeyCode == Keys.Enter) {
      e.SuppressKeyPress = true;
      CommitText();
    } else if (e.KeyCode == Keys.Escape) {
      e.SuppressKeyPress = true;
      CancelText();
    }
  }

  private void EditorLostFocus(object sender, EventArgs e) { CommitText(); }

  private void CommitText() {
    TextBox box = editor;
    if (box == null) return;
    editor = null;                       // set first: Remove() can re-enter through LostFocus
    string s = box.Text;
    Rectangle r = new Rectangle(box.Location, box.Size);
    this.Controls.Remove(box);
    box.Dispose();
    Invalidate(r);
    if (s != null && s.Trim().Length > 0) {
      DshShape t = NewShape(5);
      t.A = editAnchor;
      t.Text = s;
      shapes.Add(t);
      Invalidate();
    }
  }

  private void CancelText() {
    TextBox box = editor;
    if (box == null) return;
    editor = null;
    Rectangle r = new Rectangle(box.Location, box.Size);
    this.Controls.Remove(box);
    box.Dispose();
    Invalidate(r);
  }

  private void UndoLast() {
    if (shapes.Count == 0) return;
    DshShape last = shapes[shapes.Count - 1];
    shapes.RemoveAt(shapes.Count - 1);
    if (last.Tool == 4 && nextNum > 1) nextNum = nextNum - 1;
    Invalidate();
  }

  // Where the loupe sits for a given cursor position (also used to invalidate exactly
  // the pixels that changed, so following the mouse stays cheap).
  private Rectangle LoupeRect(Point p) {
    if (phase != 0 || p.X < 0) return Rectangle.Empty;
    int mw = 144, mh = 108;
    int mx = p.X + 24;
    int my = p.Y + 24;
    if (mx + mw > this.ClientSize.Width - 4) mx = p.X - 24 - mw;
    if (my + mh + 24 > this.ClientSize.Height - 4) my = p.Y - 24 - mh;
    if (mx < 4) mx = 4;
    if (my < 4) my = 4;
    return new Rectangle(mx, my, mw, mh + 24);
  }

  private void DrawMagnifier(Graphics g) {
    if (phase != 0 || cursor.X < 0 || RawBmp == null) return;
    int mw = 144, mh = 108, zoom = 4;
    int srcW = mw / zoom, srcH = mh / zoom;
    int sx = cursor.X - srcW / 2, sy = cursor.Y - srcH / 2;
    if (sx < 0) sx = 0;
    if (sy < 0) sy = 0;
    if (sx + srcW > RawBmp.Width) sx = Math.Max(0, RawBmp.Width - srcW);
    if (sy + srcH > RawBmp.Height) sy = Math.Max(0, RawBmp.Height - srcH);
    Rectangle box = LoupeRect(cursor);
    Rectangle dst = new Rectangle(box.X + 1, box.Y + 1, mw, mh);
    // R66: same card language as the toolbar -- rounded body, drop shadow, hairline edge,
    // and the coordinate readout INSIDE the card instead of a black strip nailed under it.
    SmoothingMode oldLSm = g.SmoothingMode;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    for (int k = 3; k >= 1; k--) {
      Rectangle sr = Rectangle.Inflate(box, k, k);
      sr.Offset(0, 1);
      using (GraphicsPath sp = RoundRect(sr, 8 + k))
      using (SolidBrush sb = new SolidBrush(Color.FromArgb(11, 0, 0, 0))) g.FillPath(sb, sp);
    }
    using (GraphicsPath cp = RoundRect(box, 8)) {
      using (SolidBrush cb = new SolidBrush(CardBg)) g.FillPath(cb, cp);
    }
    // The zoomed pixels are clipped to the card, so the corners really are rounded.
    using (GraphicsPath ip = RoundRect(dst, 7)) {
      GraphicsState st = g.Save();
      g.SetClip(ip, CombineMode.Intersect);
      InterpolationMode om = g.InterpolationMode;
      PixelOffsetMode op = g.PixelOffsetMode;
      g.InterpolationMode = InterpolationMode.NearestNeighbor;
      g.PixelOffsetMode = PixelOffsetMode.Half;
      GraphicsState st2 = g.Save();
      g.SetClip(new Rectangle(dst.X, dst.Y, dst.Width, dst.Height), CombineMode.Intersect);
      g.DrawImage(RawBmp, dst, new Rectangle(sx, sy, srcW, srcH), GraphicsUnit.Pixel);
      g.Restore(st2);
      using (Pen cross = new Pen(Color.FromArgb(210, 240, 68, 56), 1f)) {
        g.DrawLine(cross, dst.X + mw / 2, dst.Y + 8, dst.X + mw / 2, dst.Y + mh - 8);
        g.DrawLine(cross, dst.X + 8, dst.Y + mh / 2, dst.X + mw - 8, dst.Y + mh / 2);
      }
      g.InterpolationMode = om;
      g.PixelOffsetMode = op;
      g.Restore(st);
    }
    using (GraphicsPath cb2 = RoundRect(box, 8))
    using (Pen ce = new Pen(CardEdge, 1f)) g.DrawPath(ce, cb2);
    Rectangle ro = new Rectangle(box.X + 8, box.Y + 1 + mh, box.Width - 16, box.Height - mh - 2);
    TextRenderer.DrawText(g, cursor.X + ", " + cursor.Y, hintFont, ro, Color.FromArgb(232, 255, 255, 255),
      TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
      TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    g.SmoothingMode = oldLSm;
  }

  private void DrawToolbar(Graphics g) {
    Rectangle tb = ToolbarRect();
    if (tb.Width <= 0 || tb.Height <= 0) return;
    SmoothingMode oldSm = g.SmoothingMode;
    PixelOffsetMode oldPx = g.PixelOffsetMode;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    lastCard = CardArea();

    // Three stacked rounded rects, widest last: a soft drop shadow without blur support.
    for (int k = 3; k >= 1; k--) {
      Rectangle sr = Rectangle.Inflate(tb, k, k);
      sr.Offset(0, 2);
      using (GraphicsPath sp = RoundRect(sr, 10 + k))
      using (SolidBrush sb = new SolidBrush(Color.FromArgb(11, 0, 0, 0))) g.FillPath(sb, sp);
    }
    using (GraphicsPath cp = RoundRect(tb, 10)) {
      using (SolidBrush cb = new SolidBrush(CardBg)) g.FillPath(cb, cp);
      using (Pen ce = new Pen(CardEdge, 1f)) g.DrawPath(ce, cp);
    }
    // 1 px inner highlight: what separates a "dark slab" from a raised surface.
    Rectangle inner = Rectangle.Inflate(tb, -1, -1);
    using (GraphicsPath ip = RoundRect(inner, 9))
    using (Pen hl = new Pen(Color.FromArgb(15, 255, 255, 255), 1f)) g.DrawPath(hl, ip);

    for (int i = 0; i < 9; i++) DrawButton(g, i);

    // Group separators: tools | colour | undo. Drawn last so they sit on the card,
    // and short (10 px inset) so they read as dividers, not as borders.
    using (Pen sp = new Pen(SepInk, 1f)) {
      for (int k = 0; k < 2; k++) {
        int bi = k == 0 ? 6 : 7;
        float sx = tb.X + (BtnX(bi) + BtnW + BtnX(bi + 1)) / 2f;
        g.DrawLine(sp, sx, tb.Y + BarPad + 8, sx, tb.Y + BarPad + BtnH - 8);
      }
    }

    // The shortcut line lives INSIDE the card now (it used to be a floating white
    // string under the bar). A hairline divider makes the two rows read as one panel.
    float dy = tb.Y + BarPad + BtnH + 1;
    using (Pen dp = new Pen(SepInk, 1f)) g.DrawLine(dp, tb.X + 10, dy, tb.Right - 10, dy);
    string hint = (Hint != null && Hint.Length > 0) ? Hint : "Enter copy   P pin   Esc back   Ctrl+Z undo   X width   C colour";
    Rectangle hr = new Rectangle(tb.X + 10, tb.Y + BarPad + BtnH + 2, tb.Width - 20, HintRow - 2);
    // The hideSelf prefix ("window hidden") lengthens this line by ~90 px; shrink one step
    // so the tail (C colour) is not the thing that gets ellipsised away.
    Font hf = hintFont;
    Size hMeas = TextRenderer.MeasureText(hint, hf, new Size(4096, 40), TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
    if (hMeas.Width > hr.Width) hf = hintFontMin;
    TextRenderer.DrawText(g, hint, hf, hr, Color.FromArgb(118, 255, 255, 255),
      TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine |
      TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);

    g.PixelOffsetMode = oldPx;
    g.SmoothingMode = oldSm;
  }

  private void DrawButton(Graphics g, int i) {
    Rectangle r = BtnRect(i);
    if (r.Width <= 0 || r.Height <= 0) return;
    bool active = (i < 7 && i == tool);
    bool hot = (i == hoverBtn);
    Color ink = Color.FromArgb(236, 255, 255, 255);
    Color cap = InkDim;
    if (active) {
      // A filled pill, not a tinted one: at 20 px icon size a 40-level tint reads as
      // "slightly lighter", while a solid accent is unmistakable. Light accents get
      // dark glyphs (white-on-white was a real bug once -- see IsLight below).
      using (GraphicsPath pp = RoundRect(r, 9))
      using (SolidBrush pb = new SolidBrush(Accent)) g.FillPath(pb, pp);
      bool light = IsLight(Accent);
      ink = light ? Color.FromArgb(255, 22, 22, 26) : Color.White;
      cap = light ? Color.FromArgb(185, 22, 22, 26) : Color.FromArgb(215, 255, 255, 255);
    } else if (hot) {
      using (GraphicsPath pp = RoundRect(r, 9))
      using (SolidBrush pb = new SolidBrush(HoverFill)) g.FillPath(pb, pp);
      ink = Color.White;
      cap = Color.FromArgb(200, 255, 255, 255);
    }
    Rectangle ib = new Rectangle(r.X + (r.Width - IconBox) / 2, r.Y + 5, IconBox, IconBox);
    DrawIcon(g, i, ib, ink);
    string label = BtnLabel(i);
    if (label != null && label.Length > 0) {
      DrawCaption(g, label, new Rectangle(r.X + 1, r.Y + 27, r.Width - 2, 15), cap);
    }
  }

  private void DrawCaption(Graphics g, string text, Rectangle box, Color ink) {
    TextFormatFlags m = TextFormatFlags.HorizontalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding;
    Size raw = TextRenderer.MeasureText(text, capFont, new Size(4096, 40), m);
    Font f = raw.Width <= box.Width ? capFont : capFontMin;
    TextRenderer.DrawText(g, text, f, box, ink, m | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
  }

  // Icons are drawn, never bitmapped: the helper has to stay a single ASCII .ps1 with
  // no assets, and a vector glyph follows the 20 px box on any DPI.
  private void DrawIcon(Graphics g, int i, Rectangle b, Color c) {
    float x = b.X;
    float y = b.Y;
    if (i == 0) {
      using (Pen p = new Pen(c, 1.8f)) { p.LineJoin = LineJoin.Round; g.DrawRectangle(p, x + 2.5f, y + 4.5f, 15f, 11f); }
      return;
    }
    if (i == 1) {
      using (Pen p = new Pen(c, 1.8f)) {
        p.StartCap = LineCap.Round; p.EndCap = LineCap.Round; p.LineJoin = LineJoin.Round;
        g.DrawLine(p, x + 4f, y + 16f, x + 16f, y + 4f);
        g.DrawLine(p, x + 16f, y + 4f, x + 9.4f, y + 5.2f);
        g.DrawLine(p, x + 16f, y + 4f, x + 14.8f, y + 10.6f);
      }
      return;
    }
    if (i == 2) {
      // pencil: OUTLINED barrel + FILLED nib. A solid thick line just reads as a slash
      // (first attempt, seen in the render check); the outline gives it a body, and the
      // filled wedge is what makes the point obvious at 20 px.
      // Axis P0 (eraser) -> P1 (nib base), half width 2.0 on the diagonal.
      PointF p0 = new PointF(x + 16.2f, y + 4.4f);
      PointF p1 = new PointF(x + 9.4f, y + 11.2f);
      PointF u = new PointF(1.41f, 1.41f);           // perpendicular, unit-ish
      PointF[] body = new PointF[] {
        new PointF(p0.X + u.X, p0.Y + u.Y),
        new PointF(p1.X + u.X, p1.Y + u.Y),
        new PointF(p1.X - u.X, p1.Y - u.Y),
        new PointF(p0.X - u.X, p0.Y - u.Y)
      };
      using (Pen p = new Pen(c, 1.5f)) {
        p.LineJoin = LineJoin.Round;
        g.DrawPolygon(p, body);
      }
      // ferrule: short line across the barrel just below the eraser end
      PointF f = new PointF(p0.X - 1.7f, p0.Y + 1.7f);
      using (Pen p = new Pen(c, 1.3f)) g.DrawLine(p, f.X + u.X, f.Y + u.Y, f.X - u.X, f.Y - u.Y);
      PointF[] tip = new PointF[] {
        new PointF(p1.X + u.X, p1.Y + u.Y),
        new PointF(p1.X - u.X, p1.Y - u.Y),
        new PointF(p1.X - 3.3f, p1.Y + 3.3f)
      };
      using (SolidBrush bb = new SolidBrush(c)) g.FillPolygon(bb, tip);
      return;
    }
    if (i == 3) {
      for (int r = 0; r < 3; r++) {
        for (int q = 0; q < 3; q++) {
          float cx = x + 1.5f + q * 6f;
          float cy = y + 1.5f + r * 6f;
          if ((r + q) % 2 == 0) {
            using (SolidBrush bb = new SolidBrush(c)) g.FillRectangle(bb, cx, cy, 5.6f, 5.6f);
          } else {
            using (Pen p = new Pen(c, 1.1f)) g.DrawRectangle(p, cx, cy, 5.6f, 5.6f);
          }
        }
      }
      return;
    }
    if (i == 4) {
      using (SolidBrush bb = new SolidBrush(c)) g.FillEllipse(bb, x + 2.5f, y + 2.5f, 15f, 15f);
      using (Pen p = new Pen(CardBg, 1.9f)) {
        p.StartCap = LineCap.Round; p.EndCap = LineCap.Round;
        g.DrawLine(p, x + 10.6f, y + 6.4f, x + 10.6f, y + 13.8f);
        g.DrawLine(p, x + 10.6f, y + 6.4f, x + 7.6f, y + 8.9f);
      }
      return;
    }
    if (i == 5) {
      using (Pen p = new Pen(c, 1.9f)) {
        p.StartCap = LineCap.Round; p.EndCap = LineCap.Round; p.LineJoin = LineJoin.Round;
        g.DrawLine(p, x + 4.5f, y + 5f, x + 15.5f, y + 5f);
        g.DrawLine(p, x + 10f, y + 5f, x + 10f, y + 15.5f);
      }
      return;
    }
    if (i == 6) {
      using (Pen p = new Pen(c, 1.8f)) g.DrawEllipse(p, x + 2.5f, y + 4.5f, 15f, 11f);
      return;
    }
    if (i == 7) {
      // colour swatch: the actual next-stroke colour, on a dark ring so a white
      // palette entry still reads as a disc instead of vanishing into the card.
      using (Pen dark = new Pen(Color.FromArgb(90, 0, 0, 0), 1.2f)) g.DrawEllipse(dark, x + 1.6f, y + 1.6f, 16.8f, 16.8f);
      using (SolidBrush sw = new SolidBrush(palette[colorIdx])) g.FillEllipse(sw, x + 2.5f, y + 2.5f, 15f, 15f);
      using (Pen ring = new Pen(Color.FromArgb(240, 255, 255, 255), 1.4f)) g.DrawEllipse(ring, x + 2.5f, y + 2.5f, 15f, 15f);
      return;
    }
    // undo: "return" glyph -- top bar, right edge coming down, arrowhead on the left
    using (Pen p = new Pen(c, 1.8f)) {
      p.StartCap = LineCap.Round; p.EndCap = LineCap.Round; p.LineJoin = LineJoin.Round;
      g.DrawLine(p, x + 6.8f, y + 7.2f, x + 13.2f, y + 7.2f);
      g.DrawLine(p, x + 13.2f, y + 7.2f, x + 13.2f, y + 13f);
      g.DrawLine(p, x + 6.8f, y + 7.2f, x + 10f, y + 3.8f);
      g.DrawLine(p, x + 6.8f, y + 7.2f, x + 10f, y + 10.6f);
    }
  }

  protected override void OnPaint(PaintEventArgs e) {
    Repaints++;
    Graphics g = e.Graphics;
    Rectangle clip = e.ClipRectangle;
    if (clip.Width <= 0 || clip.Height <= 0) return;

    if (DimBmp != null) {
      g.DrawImage(DimBmp, clip, new Rectangle(clip.X, clip.Y, clip.Width, clip.Height), GraphicsUnit.Pixel);
    } else {
      using (SolidBrush b = new SolidBrush(Color.Black)) g.FillRectangle(b, clip);
    }

    if (sel.Width > 1 && sel.Height > 1) {
      GraphicsState st = g.Save();
      g.SetClip(sel, CombineMode.Replace);
      if (RawBmp != null) g.DrawImage(RawBmp, 0, 0);
      foreach (DshShape s in shapes) DrawShape(g, s, 2f);
      if (cur != null) DrawShape(g, cur, 2f);
      g.Restore(st);

      using (Pen pen = new Pen(Accent, 2)) g.DrawRectangle(pen, sel.X, sel.Y, sel.Width, sel.Height);

      // Size badge: a rounded pill with an accent hairline instead of raw white text.
      // Same numbers, but it now reads as an object rather than as stray glyphs.
      string label = sel.Width + " x " + sel.Height;
      Size lsz = TextRenderer.MeasureText(label, labelFont, new Size(4096, 40),
        TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
      int pw = lsz.Width + 14;
      int ph = lsz.Height + 5;
      int px = sel.X;
      int py = sel.Y - ph - 6;
      if (py < 2) py = sel.Y + 4;
      if (px + pw > this.ClientSize.Width - 4) px = this.ClientSize.Width - pw - 4;
      if (px < 2) px = 2;
      Rectangle pill = new Rectangle(px, py, pw, ph);
      SmoothingMode oldPillSm = g.SmoothingMode;
      g.SmoothingMode = SmoothingMode.AntiAlias;
      using (GraphicsPath pp = RoundRect(pill, 5)) {
        using (SolidBrush pb = new SolidBrush(Color.FromArgb(232, 20, 20, 24))) g.FillPath(pb, pp);
        using (Pen pn = new Pen(Color.FromArgb(150, Accent), 1f)) g.DrawPath(pn, pp);
      }
      g.SmoothingMode = oldPillSm;
      TextRenderer.DrawText(g, label, labelFont, pill, Color.White,
        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
        TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);

      if (phase == 1) DrawToolbar(g);
    }

    // Outside the selection block on purpose: the loupe has to show before any
    // selection exists, which is exactly when you are hunting for the right pixel.
    if (phase == 0) DrawMagnifier(g);
  }

  protected override void OnMouseDown(MouseEventArgs e) {
    base.OnMouseDown(e);
    if (e.Button != MouseButtons.Left) return;

    if (phase == 1) {
      for (int i = 0; i < 9; i++) {
        if (BtnRect(i).Contains(e.Location)) {
          if (i == 8) {
            UndoLast();
          } else if (i == 7) {
            CycleColor();
            InvalidateToolbar();
          } else {
            tool = i;
            InvalidateToolbar();
          }
          return;
        }
      }
      // R66: the card is 82 px tall now (it was 26), so the hint row and the padding are
      // a big accidental target -- a click there used to fall through to "start a new
      // selection" and silently throw away the current one. Consume it.
      if (ToolbarRect().Contains(e.Location)) return;
      if (tool == 5) {
        // Creating a control is the fragile step; never let it take the overlay down.
        try { BeginText(e.Location); } catch { }
        return;
      }
      if (tool == 4) {
        // a numbered badge is a click, not a drag
        DshShape num = NewShape(4);
        num.A = e.Location;
        num.Text = nextNum.ToString();
        nextNum = nextNum + 1;
        shapes.Add(num);
        Invalidate(Rectangle.Inflate(num.Bounds, 8, 8));
        return;
      }
      if (!sel.Contains(e.Location)) {
        // a drag outside the selection starts a new one (QQ behaves the same way)
        phase = 0;
        shapes.Clear();
        cur = null;
        dragging = true;
        downPt = e.Location;
        SetSel(new Rectangle(e.Location.X, e.Location.Y, 0, 0));
        return;
      }
      dragging = true;
      downPt = e.Location;
      cur = NewShape(tool);
      cur.A = e.Location;
      cur.B = e.Location;
      cur.Pts.Add(e.Location);
      return;
    }

    dragging = true;
    downPt = e.Location;
    SetSel(new Rectangle(e.Location.X, e.Location.Y, 0, 0));
  }

  protected override void OnMouseMove(MouseEventArgs e) {
    base.OnMouseMove(e);
    // Hover feedback for the card. Only repaint when the hovered button CHANGES --
    // repainting 458x82 on every mouse move would show up as lag while annotating.
    if (phase == 1 && !dragging) {
      int hb = -1;
      for (int i = 0; i < 9; i++) {
        if (BtnRect(i).Contains(e.Location)) { hb = i; break; }
      }
      if (hb != hoverBtn) {
        hoverBtn = hb;
        Rectangle ca = CardArea();
        if (ca.Width > 0 && ca.Height > 0) Invalidate(ca);
        try { this.Cursor = hb >= 0 ? Cursors.Hand : Cursors.Cross; } catch { }
      }
    }
    if (phase == 0) {
      // the loupe follows the cursor even when nothing is being dragged
      Rectangle oldL = LoupeRect(cursor);
      cursor = e.Location;
      Rectangle newL = LoupeRect(cursor);
      Invalidate(Rectangle.Inflate(Rectangle.Union(oldL, newL), 8, 8));
    }
    if (!dragging) return;
    if (phase == 0) {
      int x = Math.Min(downPt.X, e.Location.X);
      int y = Math.Min(downPt.Y, e.Location.Y);
      int w = Math.Abs(e.Location.X - downPt.X);
      int h = Math.Abs(e.Location.Y - downPt.Y);
      SetSel(new Rectangle(x, y, w, h));
      return;
    }
    if (cur == null) return;
    Rectangle old = cur.Bounds;
    cur.B = e.Location;
    if (cur.Tool == 2) cur.Pts.Add(e.Location);
    Invalidate(Rectangle.Union(Rectangle.Inflate(old, 24, 24), Rectangle.Inflate(cur.Bounds, 24, 24)));
  }

  protected override void OnMouseLeave(EventArgs e) {
    base.OnMouseLeave(e);
    if (hoverBtn != -1) {
      hoverBtn = -1;
      Rectangle ca = CardArea();
      if (ca.Width > 0 && ca.Height > 0) Invalidate(ca);
    }
    try { this.Cursor = Cursors.Cross; } catch { }
  }

  protected override void OnMouseUp(MouseEventArgs e) {
    base.OnMouseUp(e);
    if (!dragging) return;
    dragging = false;

    if (phase == 0) {
      FinishSelection();
      return;
    }

    if (cur == null) return;
    bool degenerate = false;
    if (cur.Tool == 2) {
      if (cur.Pts.Count < 2) degenerate = true;
    } else if (Math.Abs(cur.B.X - cur.A.X) < 4 && Math.Abs(cur.B.Y - cur.A.Y) < 4) {
      degenerate = true;
    }
    if (degenerate) { cur = null; Invalidate(); return; }
    shapes.Add(cur);
    cur = null;
    Invalidate();
  }

  protected override void OnKeyDown(KeyEventArgs e) {
    base.OnKeyDown(e);
    // While the text box is open it owns the keyboard. KeyPreview = true means this
    // handler sees every key FIRST -- without this guard, Enter would confirm the whole
    // overlay (copying a picture with no text) instead of committing the string, and
    // Esc would wipe the selection out from under the box. The box has its own
    // Enter/Esc handlers, and forwarding the key on (we do not set Handled) gets it there.
    if (editor != null) return;
    if (e.KeyCode == Keys.Escape) {
      if (phase == 1) {
        phase = 0;
        shapes.Clear();
        cur = null;
        SetSel(Rectangle.Empty);
        Invalidate();
      } else {
        Cancelled = true;
        Close();
      }
      e.Handled = true;
      return;
    }
    if (e.KeyCode == Keys.P) {
      // pin instead of copy: the picture stays on screen as its own window
      if (sel.Width > 1 && sel.Height > 1) {
        Pinned = true;
        Close();
      }
      e.Handled = true;
      return;
    }
    if (e.KeyCode == Keys.Enter) {
      if (sel.Width > 1 && sel.Height > 1) {
        Confirmed = true;
        Close();
      }
      e.Handled = true;
      return;
    }
    if (e.Control && e.KeyCode == Keys.Z) {
      UndoLast();
      e.Handled = true;
      return;
    }
    if (phase == 1) {
      if (e.KeyCode == Keys.D1 || e.KeyCode == Keys.NumPad1) { tool = 0; InvalidateToolbar(); }
      else if (e.KeyCode == Keys.D2 || e.KeyCode == Keys.NumPad2) { tool = 1; InvalidateToolbar(); }
      else if (e.KeyCode == Keys.D3 || e.KeyCode == Keys.NumPad3) { tool = 2; InvalidateToolbar(); }
      else if (e.KeyCode == Keys.D4 || e.KeyCode == Keys.NumPad4) { tool = 3; InvalidateToolbar(); }
      else if (e.KeyCode == Keys.D5 || e.KeyCode == Keys.NumPad5) { tool = 4; InvalidateToolbar(); }
      else if (e.KeyCode == Keys.D6 || e.KeyCode == Keys.NumPad6) { tool = 5; InvalidateToolbar(); }
      else if (e.KeyCode == Keys.D7 || e.KeyCode == Keys.NumPad7) { tool = 6; InvalidateToolbar(); }
      else if (e.KeyCode == Keys.C) { CycleColor(); InvalidateToolbar(); }
      else if (e.KeyCode == Keys.X) { CycleWidth(); }
    }
  }

  // Test hooks. A sandboxed shell cannot move the mouse, so the render path
  // (selection -> shapes -> undo -> crop) has to be exercisable without one.
  // The client never sets these flags; only _ovl-m2-test.mjs does.
  private void DumpForm(string suffix) {
    if (FormShotPath == null || FormShotPath.Length == 0) return;
    try {
      Invalidate();
      Application.DoEvents();
      using (Bitmap shot = new Bitmap(this.ClientSize.Width, this.ClientSize.Height)) {
        this.DrawToBitmap(shot, new Rectangle(0, 0, shot.Width, shot.Height));
        shot.Save(FormShotPath + suffix + ".png", System.Drawing.Imaging.ImageFormat.Png);
      }
    } catch { }
  }

  public void RunSelfTest() {
    // Two dumps: the selecting phase (loupe + coordinate readout) and the annotating
    // phase (toolbar + shapes). They are the only way to see what the user sees
    // without a mouse.
    if (FormShotPath != null && FormShotPath.Length > 0) {
      phase = 0;
      cursor = new Point(520, 420);
      DumpForm(".select");
    }
    // One known rectangle for every branch of the self test. It used to be 320x240 here;
    // the 10-30 edit made it 1040x690 while every assertion (regionOnly rect, pin width,
    // the 320x240 PNG) still said 320x240 -- so the gate had been red for two checks.
    // Restored: measurements are only comparable when the rectangle is the same one.
    SetSel(new Rectangle(200, 150, 320, 240));
    if (RegionOnly) {
      // Region-only requests never reach the annotate phase. Going through
      // FinishSelection() (not a hand-written Close) is the point: the test then proves
      // the SAME branch a real mouse-up takes.
      FinishSelection();
      return;
    }
    phase = 1;
    DshShape r = new DshShape(0);
    r.A = new Point(220, 170);
    r.B = new Point(420, 300);
    shapes.Add(r);
    DshShape a = new DshShape(1);
    a.A = new Point(240, 340);
    a.B = new Point(430, 340);
    shapes.Add(a);
    DshShape p = new DshShape(2);
    p.Pts.Add(new Point(250, 200));
    p.Pts.Add(new Point(290, 250));
    p.Pts.Add(new Point(340, 210));
    p.Pts.Add(new Point(390, 260));
    shapes.Add(p);
    DshShape m = new DshShape(3);    // deliberately laid OVER the pen strokes: pixelating a flat white area proves nothing.
    m.A = new Point(248, 193);
    m.B = new Point(348, 268);
    shapes.Add(m);
    DshShape n = new DshShape(4);
    n.A = new Point(255, 375);
    n.Text = "1";
    shapes.Add(n);
    // Exercise the REAL editor path (BeginText -> Text -> CommitText), not a
    // hand-built shape: that is where the focus / KeyPreview bugs live.
    BeginText(new Point(215, 168));
    if (editor != null) {
      editor.Text = "TEXT";
      CommitText();
    }
    // cycle the colour first, so the ellipse proves per-shape colour AND proves the
    // earlier strokes kept theirs
    CycleColor();
    CycleWidth();
    DshShape el = NewShape(6);
    el.A = new Point(360, 300);
    el.B = new Point(470, 372);
    shapes.Add(el);
    DumpForm(".annotate");
    // R66: the card grew from 624x26 to 458x82, so its two other placements have to be
    // seen, not assumed -- a mouse cannot reach either in a self test:
    //   .flip   selection near the bottom, so the card must flip ABOVE it
    //   .hover  same but with a hovered button (the state CSS would give us for free)
    if (FormShotPath != null && FormShotPath.Length > 0) {
      hoverBtn = 2;
      SetSel(new Rectangle(200, this.ClientSize.Height - 170, 320, 120));
      FlipBar = ToolbarRect();
      FlipAbove = FlipBar.Height > 0 && FlipBar.Bottom <= sel.Top;
      DumpForm(".flip");
      hoverBtn = -1;
      SetSel(new Rectangle(200, 150, 320, 240));
    }
    Invalidate();
  }

  // The one place a selection becomes "done". Both the real mouse-up and the self test
  // call it, so the test exercises the same transition the user does.
  public void FinishSelection() {
    if (sel.Width < 6 || sel.Height < 6) { SetSel(Rectangle.Empty); return; }
    if (RegionOnly) { RegionPicked = true; Close(); return; }
    phase = 1;
    Invalidate();
  }

  public void ConfirmNow() {
    Confirmed = true;
    Close();
  }

  public void PinNow() {
    Pinned = true;
    Close();
  }

  // The final image: the frozen pixels of the selection with the annotations baked in.
  public Bitmap RenderResult() {
    if (sel.Width < 2 || sel.Height < 2 || RawBmp == null) return null;
    Bitmap bmp = new Bitmap(sel.Width, sel.Height);
    Graphics g = Graphics.FromImage(bmp);
    g.DrawImage(RawBmp, new Rectangle(0, 0, sel.Width, sel.Height), sel, GraphicsUnit.Pixel);
    g.TranslateTransform(-sel.X, -sel.Y);
    foreach (DshShape s in shapes) DrawShape(g, s, 2f);
    g.Dispose();
    return bmp;
  }
}

// A pinned screenshot: borderless, topmost. Left drag moves it, the wheel scales it, the
// bottom-right grip resizes it, right click opens the action menu, double click / Esc / the
// menu's Close item closes it. It is NOT modal -- it has to outlive the overlay that produced
// it, so the helper's serve loop pumps messages (Application::DoEvents) to keep it alive.
//
// R67 -- user report "the pinned picture cannot be scaled, and it cannot reach the composer".
// Two changes, both measured by dev/ovl-selftest.mjs (no human can click a topmost window in
// this sandbox, so the scale math / the menu / the hand-off file are callable as Debug hooks):
//   * scale    -> wheel + grip, aspect ratio always kept, a size pill while it changes.
//   * composer -> the menu writes the PNG next to a one-line <HandoffFile> JSON and the host
//                 polls that file (lib/overlay.mjs#takePinHandoff) then hands the picture to
//                 the renderer, which attaches it to the composer. The helper owns no channel
//                 into the renderer, and the request that created this window was answered
//                 long ago -- a file is the only hand-off that survives that.
// Captions travel with the request because this file has to stay ASCII; the English strings
// below are only fallbacks for an old client that does not send any.
public class DshPinForm : Form {
  private Bitmap bmp;
  private Point dragOffset;
  private bool dragging = false;
  private bool sizing = false;
  private Rectangle sizeFrom;
  private Point sizeCursorFrom;
  private bool gripHot = false;
  private string[] menuLabels;
  private string[] toastLabels;
  private Timer pillTimer;
  private string pillText = "";
  private long pillUntilMs = 0;
  private const int GripPx = 14;
  public int LastPercent = 100;
  public string LastError = "";
  public string SavePath = "";
  public string SaveFallback = "";
  public string HandoffDir = "";
  public string HandoffFile = "";

  public DshPinForm(Bitmap b, Rectangle bounds) {
    bmp = b;
    SetStyle(ControlStyles.Opaque | ControlStyles.AllPaintingInWmPaint |
             ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    Bounds = bounds;
    TopMost = true;
    ShowInTaskbar = false;
    Cursor = Cursors.SizeAll;
    BackColor = Color.Black;
    pillTimer = new Timer();
    pillTimer.Interval = 150;
    pillTimer.Tick += new EventHandler(OnPillTick);
    LastPercent = 100;
  }

  // Set from PowerShell AFTER construction: New-Object -ArgumentList flattens array
  // arguments, so the caption arrays must not travel through the constructor.
  public string[] MenuLabels {
    get { return menuLabels; }
    set { menuLabels = value; }
  }
  public string[] ToastLabels {
    get { return toastLabels; }
    set { toastLabels = value; }
  }

  private string Pick(string[] arr, int i, string fallback) {
    if (arr == null || i < 0 || i >= arr.Length) return fallback;
    string s = arr[i];
    return (s == null || s.Length == 0) ? fallback : s;
  }
  private string MenuText(int i) {
    string[] fall = new string[] { "Send to input box", "Copy image", "Save as PNG", "Zoom in", "Zoom out", "Actual size", "Close" };
    string f = (i >= 0 && i < fall.Length) ? fall[i] : "?";
    return Pick(menuLabels, i, f);
  }
  // 0 sent / 1 send failed / 2 saved / 3 save failed / 4 copied / 5 copy failed /
  // 6 nobody took it (host half is old -> a DSH restart is what makes it work)
  private string ToastText(int i) {
    string[] fall = new string[] { "Sent to input box", "Send failed", "Saved", "Save failed", "Copied", "Copy failed", "Nobody took it yet - restart DSH" };
    string f = (i >= 0 && i < fall.Length) ? fall[i] : "?";
    return Pick(toastLabels, i, f);
  }

  private string ShortError(string s) {
    if (s == null) return "";
    s = s.Replace("\r", " ").Replace("\n", " ");
    return s.Length > 64 ? s.Substring(0, 64) : s;
  }

  private void ShowPill(string text) {
    pillText = text == null ? "" : text;
    pillUntilMs = DateTime.Now.Ticks / TimeSpan.TicksPerMillisecond + 1500;
    try { if (!pillTimer.Enabled) pillTimer.Start(); } catch { }
    try { Invalidate(); } catch { }
  }

  private void OnPillTick(object sender, EventArgs e) {
    long now = DateTime.Now.Ticks / TimeSpan.TicksPerMillisecond;
    if (now < pillUntilMs) return;
    try { pillTimer.Stop(); } catch { }
    if (pillText.Length == 0) return;
    pillText = "";
    try { Invalidate(); } catch { }
  }

  private bool InGrip(Point p) {
    return p.X >= this.ClientSize.Width - GripPx && p.Y >= this.ClientSize.Height - GripPx;
  }

  /**
   * One place that changes the size. Aspect ratio is ALWAYS kept: a stretched screenshot is
   * worse than one the user has to size twice. Clamped to 10%..400% of the captured pixels,
   * so a wheel slip can never shrink it into a 4 px sliver or blow it up past the screen.
   */
  private void ApplyWidth(int w, bool keepCenter) {
    if (bmp == null || bmp.Width <= 0 || bmp.Height <= 0) return;
    int minW = Math.Max(48, bmp.Width / 10);
    int maxW = Math.Max(minW, bmp.Width * 4);
    if (w < minW) w = minW;
    if (w > maxW) w = maxW;
    int h = (int)Math.Round((double)w * (double)bmp.Height / (double)bmp.Width);
    if (h < 24) h = 24;
    Rectangle b = this.Bounds;
    if (keepCenter) {
      int cx = b.X + b.Width / 2;
      int cy = b.Y + b.Height / 2;
      this.Bounds = new Rectangle(cx - w / 2, cy - h / 2, w, h);
    } else {
      this.Bounds = new Rectangle(b.X, b.Y, w, h);
    }
    LastPercent = (int)Math.Round(100.0 * (double)w / (double)bmp.Width);
    ShowPill(this.ClientSize.Width.ToString() + " x " + this.ClientSize.Height.ToString() +
             "   " + LastPercent.ToString() + "%");
  }

  protected override void OnPaintBackground(PaintEventArgs e) { }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    if (bmp != null) {
      // Enlarging a screenshot: nearest neighbour, so text stays readable instead of turning
      // into mush. Shrinking: bicubic, because dropping pixels looks ragged otherwise.
      g.InterpolationMode = (this.ClientSize.Width >= bmp.Width)
        ? InterpolationMode.NearestNeighbor
        : InterpolationMode.HighQualityBicubic;
      g.PixelOffsetMode = PixelOffsetMode.Half;
      g.DrawImage(bmp, new Rectangle(0, 0, this.ClientSize.Width, this.ClientSize.Height));
    }
    using (Pen p = new Pen(Color.FromArgb(110, 255, 255, 255), 1f)) {
      g.DrawRectangle(p, 0, 0, this.Width - 1, this.Height - 1);
    }
    if (this.ClientSize.Width > 48 && this.ClientSize.Height > 48) {
      // Two-tone grip: a screenshot can be any colour, so a single white stroke disappears
      // on a white page. Dark underneath + light on top reads on both.
      int alpha = gripHot ? 235 : 140;
      int x0 = this.ClientSize.Width - 4;
      int y0 = this.ClientSize.Height - 4;
      using (Pen shadow = new Pen(Color.FromArgb(alpha, 0, 0, 0), 1f))
      using (Pen light = new Pen(Color.FromArgb(alpha, 255, 255, 255), 1f)) {
        for (int k = 0; k < 3; k++) {
          int d = 4 + k * 4;
          g.DrawLine(shadow, x0 - d + 1, y0 + 1, x0 + 1, y0 - d + 1);
          g.DrawLine(light, x0 - d, y0, x0, y0 - d);
        }
      }
    }
    if (pillText.Length > 0) {
      using (Font f = new Font("Segoe UI", 8.5f)) {
        SizeF sz = g.MeasureString(pillText, f);
        int pw = (int)Math.Ceiling(sz.Width) + 14;
        int ph = (int)Math.Ceiling(sz.Height) + 6;
        using (SolidBrush bg = new SolidBrush(Color.FromArgb(205, 18, 18, 22))) {
          g.FillRectangle(bg, 6, 6, pw, ph);
        }
        using (Pen bp = new Pen(Color.FromArgb(120, 255, 255, 255), 1f)) {
          g.DrawRectangle(bp, 6, 6, pw, ph);
        }
        using (SolidBrush fg = new SolidBrush(Color.FromArgb(240, 255, 255, 255))) {
          g.DrawString(pillText, f, fg, 13, 9);
        }
      }
    }
  }

  protected override void OnMouseDown(MouseEventArgs e) {
    base.OnMouseDown(e);
    if (e.Button == MouseButtons.Right) {
      ShowMenu(e.Location);
      return;
    }
    if (e.Button != MouseButtons.Left) {
      Close();
      return;
    }
    if (InGrip(e.Location)) {
      sizing = true;
      sizeFrom = this.Bounds;
      sizeCursorFrom = PointToScreen(e.Location);
      return;
    }
    dragging = true;
    dragOffset = e.Location;
  }

  protected override void OnMouseMove(MouseEventArgs e) {
    base.OnMouseMove(e);
    if (sizing) {
      Point sp = PointToScreen(e.Location);
      ApplyWidth(sizeFrom.Width + (sp.X - sizeCursorFrom.X), false);
      return;
    }
    if (dragging) {
      Point p = PointToScreen(e.Location);
      Location = new Point(p.X - dragOffset.X, p.Y - dragOffset.Y);
      return;
    }
    bool hot = InGrip(e.Location);
    if (hot != gripHot) {
      gripHot = hot;
      Cursor = hot ? Cursors.SizeNWSE : Cursors.SizeAll;
      try { Invalidate(); } catch { }
    }
  }

  protected override void OnMouseUp(MouseEventArgs e) {
    base.OnMouseUp(e);
    sizing = false;
    dragging = false;
  }

  protected override void OnMouseWheel(MouseEventArgs e) {
    base.OnMouseWheel(e);
    double f = e.Delta > 0 ? 1.1 : (1.0 / 1.1);
    int w = (int)Math.Round((double)this.Width * f);
    if (w == this.Width) w += (e.Delta > 0 ? 1 : -1);
    ApplyWidth(w, true);
  }

  protected override void OnDoubleClick(EventArgs e) {
    base.OnDoubleClick(e);
    Close();
  }

  protected override void OnKeyDown(KeyEventArgs e) {
    base.OnKeyDown(e);
    if (e.KeyCode == Keys.Escape) Close();
  }

  protected override void OnFormClosed(FormClosedEventArgs e) {
    base.OnFormClosed(e);
    try { if (pillTimer != null) pillTimer.Dispose(); } catch { }
    try { if (sendCheck != null) sendCheck.Dispose(); } catch { }
    try { if (bmp != null) { bmp.Dispose(); bmp = null; } } catch { }
  }

  private void ShowMenu(Point at) {
    ContextMenuStrip m = new ContextMenuStrip();
    m.ShowImageMargin = false;
    m.ShowCheckMargin = false;
    m.Items.Add(MenuText(0)).Click += new EventHandler(delegate(object s, EventArgs e) { ActSend(); });
    m.Items.Add(new ToolStripSeparator());
    m.Items.Add(MenuText(1)).Click += new EventHandler(delegate(object s, EventArgs e) { ActCopy(); });
    m.Items.Add(MenuText(2)).Click += new EventHandler(delegate(object s, EventArgs e) { ActSave(); });
    m.Items.Add(new ToolStripSeparator());
    m.Items.Add(MenuText(3)).Click += new EventHandler(delegate(object s, EventArgs e) { ActZoom(1.25); });
    m.Items.Add(MenuText(4)).Click += new EventHandler(delegate(object s, EventArgs e) { ActZoom(0.8); });
    m.Items.Add(MenuText(5)).Click += new EventHandler(delegate(object s, EventArgs e) { ActActual(); });
    m.Items.Add(new ToolStripSeparator());
    m.Items.Add(MenuText(6)).Click += new EventHandler(delegate(object s, EventArgs e) { Close(); });
    m.Closed += new ToolStripDropDownClosedEventHandler(delegate(object s, ToolStripDropDownClosedEventArgs e) {
      try { ((ContextMenuStrip)s).Dispose(); } catch { }
    });
    m.Show(this, at);
  }

  private void ActZoom(double f) {
    ApplyWidth((int)Math.Round((double)this.Width * f), true);
  }

  private void ActActual() {
    if (bmp == null) return;
    ApplyWidth(bmp.Width, true);
  }

  private void ActCopy() {
    string err = "";
    for (int i = 0; i < 4; i++) {
      try {
        Clipboard.SetImage(bmp);
        ShowPill(ToastText(4));
        return;
      } catch (Exception ex) {
        err = ex.Message;
        System.Threading.Thread.Sleep(60);
      }
    }
    LastError = err;
    ShowPill(ToastText(5) + ": " + ShortError(err));
  }

  private string TrySave(string path) {
    if (path == null || path.Length == 0) return "";
    try {
      string dir = System.IO.Path.GetDirectoryName(path);
      if (dir != null && dir.Length > 0) System.IO.Directory.CreateDirectory(dir);
      string target = path;
      string stem = System.IO.Path.GetFileNameWithoutExtension(path);
      string ext = System.IO.Path.GetExtension(path);
      int n = 1;
      while (System.IO.File.Exists(target) && n < 100) {
        string cand = stem + "-" + n.ToString() + ext;
        target = (dir != null && dir.Length > 0) ? System.IO.Path.Combine(dir, cand) : cand;
        n++;
      }
      bmp.Save(target, System.Drawing.Imaging.ImageFormat.Png);
      return target;
    } catch (Exception ex) {
      LastError = ex.Message;
      return "";
    }
  }

  private void ActSave() {
    string used = TrySave(SavePath);
    if (used == "") used = TrySave(SaveFallback);
    if (used == "") {
      ShowPill(ToastText(3) + ": " + ShortError(LastError));
      return;
    }
    ShowPill(ToastText(2) + ": " + System.IO.Path.GetFileName(used));
  }

  private string JsonEsc(string s) {
    if (s == null) return "";
    return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
  }

  /**
   * The "send to the composer" half: PNG on disk + a tiny JSON marker the host polls.
   * Write the picture FIRST and the marker last (via .tmp + Move) so the host can never
   * see a marker that points at a half-written file.
   *
   * Honesty: on an old host nothing polls the mailbox, and the user would be told "sent"
   * forever. A 4 s timer re-reads the marker -- the host deletes it the moment it takes
   * it, so "still there with our own png in it" means nobody came. Say that instead.
   */
  private Timer sendCheck;
  private string sendPng = "";
  // Set when "send to input box" succeeded. The serve loop (PowerShell) picks it up and
  // brings DSH to the front, because two things need it: the user's next step is typing in
  // that box, and a pinned picture that covers the whole DSH window makes Chromium treat DSH
  // as occluded -> background throttling slows the heartbeat that is supposed to pick the
  // picture up (measured policy: 1/s, then 1/min). Raising DSH removes the occlusion.
  public bool WantFocus = false;

  private void ArmSendCheck(string png) {
    sendPng = png == null ? "" : png;
    try {
      if (sendCheck == null) {
        sendCheck = new Timer();
        sendCheck.Interval = 4000;
        sendCheck.Tick += new EventHandler(OnSendCheckTick);
      }
      sendCheck.Stop();
      sendCheck.Start();
    } catch { }
  }

  private void OnSendCheckTick(object sender, EventArgs e) {
    try { sendCheck.Stop(); } catch { }
    if (sendPng.Length == 0) return;
    string hf = HandoffFile;
    if (hf == null || hf.Length == 0) return;
    if (!System.IO.File.Exists(hf)) return;   // taken = success
    try {
      string txt = System.IO.File.ReadAllText(hf, new System.Text.UTF8Encoding(false));
      if (txt.IndexOf(JsonEsc(sendPng)) < 0) return;   // a newer send replaced it
    } catch {
      return;
    }
    ShowPill(ToastText(6));
  }

  /**
   * The "send to the composer" half: PNG on disk + a tiny JSON marker the host polls.
   * Write the picture FIRST and the marker last (via .tmp + Move) so the host can never
   * see a marker that points at a half-written file.
   */
  private string WriteHandoff() {
    LastError = "";
    try {
      if (bmp == null) { LastError = "no bitmap"; return ""; }
      string dir = HandoffDir;
      if (dir == null || dir.Length == 0) dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dsh-pin");
      System.IO.Directory.CreateDirectory(dir);
      string name = "pin-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png";
      string png = System.IO.Path.Combine(dir, name);
      bmp.Save(png, System.Drawing.Imaging.ImageFormat.Png);
      string hf = HandoffFile;
      if (hf == null || hf.Length == 0) {
        string up = System.IO.Path.GetDirectoryName(dir);
        hf = System.IO.Path.Combine(up == null ? dir : up, "pinout.json");
      }
      string at = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz");
      string json = "{\"ok\":true,\"action\":\"attach\",\"png\":\"" + JsonEsc(png) +
                    "\",\"name\":\"" + JsonEsc(name) +
                    "\",\"w\":" + bmp.Width.ToString() + ",\"h\":" + bmp.Height.ToString() +
                    ",\"at\":\"" + JsonEsc(at) + "\"}";
      string tmp = hf + ".tmp";
      System.IO.File.WriteAllText(tmp, json, new System.Text.UTF8Encoding(false));
      try { System.IO.File.Delete(hf); } catch { }
      System.IO.File.Move(tmp, hf);
      return png;
    } catch (Exception ex) {
      LastError = ex.Message;
      return "";
    }
  }

  private void ActSend() {
    string png = WriteHandoff();
    if (png == "") {
      ShowPill(ToastText(1) + ": " + ShortError(LastError));
      return;
    }
    ArmSendCheck(png);
    WantFocus = true;
    ShowPill(ToastText(0));
  }

  // Test hooks -- only dev/ovl-selftest.mjs calls these (see the header note). The client
  // never reaches them: every one of them is a plain public method, no request flag.
  public void DebugZoom(double f) {
    ActZoom(f);
    try { Application.DoEvents(); } catch { }
  }
  public string DebugMenu() {
    string s = "";
    for (int i = 0; i < 7; i++) {
      if (i > 0) s = s + "|";
      s = s + MenuText(i);
    }
    return s;
  }
  public string DebugSend() {
    string png = WriteHandoff();
    if (png.Length > 0) ArmSendCheck(png);
    return png;
  }
  // Runs the "did anybody take it" timer body right now (the real one fires after 4 s, and
  // the self test closes the pin before that). Returns the pill text it decided on.
  public string DebugSendCheckNow() {
    OnSendCheckTick(null, EventArgs.Empty);
    return pillText;
  }
  public string DebugSave() {
    ActSave();
    return SavePath;
  }
  public void DebugDump(string path) {
    if (path == null || path.Length == 0) return;
    try {
      Invalidate();
      Application.DoEvents();
      using (Bitmap shot = new Bitmap(this.ClientSize.Width, this.ClientSize.Height)) {
        this.DrawToBitmap(shot, new Rectangle(0, 0, shot.Width, shot.Height));
        shot.Save(path, System.Drawing.Imaging.ImageFormat.Png);
      }
    } catch { }
  }
}
'@
Log 'form class compiled (M2 annotation)'

# Warm the GDI+ stack once so the first real request is as fast as the rest.
try {
  $warm = New-Object System.Drawing.Bitmap -ArgumentList 8, 8
  $wg = [System.Drawing.Graphics]::FromImage($warm)
  $wg.Dispose()
  $warm.Dispose()
} catch { Log ('warmup failed: ' + $_.Exception.Message) }

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
Log ('virtualscreen=' + $vs.X + ',' + $vs.Y + ' ' + $vs.Width + 'x' + $vs.Height)

Write-Json $readyFile @{ ready = $true; pid = [System.Diagnostics.Process]::GetCurrentProcess().Id; dpi = $script:dpiMode; at = (Get-Date).ToString('o'); screenW = $vs.Width; screenH = $vs.Height; buffered = $true; annotate = $true }

# If this .ps1 is edited while the helper is running, exit so the next request
# respawns it with the new code. Node only re-reads the script when it spawns.
# Use ticks and require a real >1s delta: comparing DateTime objects directly
# tripped on the very first start (caught by the self test).
$scriptBornTicks = $null
try { $scriptBornTicks = [System.IO.File]::GetLastWriteTimeUtc($PSCommandPath).Ticks } catch { $scriptBornTicks = $null }
$lastScriptCheck = 0
# Live pin windows. The references must be kept, otherwise they are collected and the
# windows vanish with them.
$script:pins = @()

# The pin mailbox drops one PNG per "send to input box". The host deletes the one it
# consumed; this is the belt-and-braces sweep for the ones nobody consumed (DSH was closed
# before its next heartbeat). Keeps the overlay dir from growing without bound.
try {
  $pinMailDir = Join-Path $Dir 'pins'
  if (Test-Path -LiteralPath $pinMailDir) {
    $pinCut = (Get-Date).AddHours(-24)
    Get-ChildItem -LiteralPath $pinMailDir -Filter '*.png' -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt $pinCut } |
      ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch { } }
  }
} catch { }

# ================================ serve loop ===================================
while ($true) {
  if (Test-Path $stopFile) { Log 'stop flag seen'; break }
  $nowTicks = (Get-Date).Ticks
  if ($nowTicks - $lastScriptCheck -gt 20000000) {
    $lastScriptCheck = $nowTicks
    if ($null -ne $scriptBornTicks) {
      try {
        $nowScriptTicks = [System.IO.File]::GetLastWriteTimeUtc($PSCommandPath).Ticks
        if (($nowScriptTicks - $scriptBornTicks) -gt 10000000) { Log 'script changed -> exit for respawn'; break }
      } catch { }
    }
  }

  $reqFile = $null
  try {
    $reqFile = Get-ChildItem -LiteralPath $Dir -Filter 'ovlreq-*.json' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
  } catch { }
  if ($null -eq $reqFile) {
    # Pin windows are NON-MODAL, so this loop has to pump messages itself; otherwise
    # they never repaint and never react to the mouse.
    try { [System.Windows.Forms.Application]::DoEvents() } catch { }
    # Drop the windows the user already closed (Esc / double click / menu). Keeping the
    # references is what keeps the windows alive in the first place, so this list must be
    # pruned here or every pin ever shown would be held forever.
    if (@($script:pins).Length -gt 0) {
      foreach ($pp in @($script:pins)) {
        try {
          if ($pp -ne $null -and $pp.WantFocus -eq $true) {
            $pp.WantFocus = $false
            # Same title-based lookup as everything else here (capture.ps1 / hide-self).
            $hf = [OvlWin]::FindVisible('DeepSeek Harness')
            if ($hf -ne [IntPtr]::Zero) { [void][OvlWin]::SetForegroundWindow($hf) }
          }
        } catch { }
      }
      try { $script:pins = @($script:pins | Where-Object { -not $_.IsDisposed }) } catch { }
    }
    Start-Sleep -Milliseconds 60
    continue
  }

  $callTag = 'unknown'
  $req = $null
  try {
    $rawText = [System.IO.File]::ReadAllText($reqFile.FullName, [System.Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $reqFile.FullName -Force -ErrorAction SilentlyContinue
    $req = $rawText | ConvertFrom-Json
    if ($req.tag) { $callTag = [string]$req.tag }
  } catch {
    Log ('bad request file: ' + $_.Exception.Message)
    continue
  }

  $resFile = Join-Path $Dir ('ovlres-' + $callTag + '.json')
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $res = @{ ok = $false; cancelled = $false; x = 0; y = 0; w = 0; h = 0; clip = $false; png = ''; ms = 0; dpi = $script:dpiMode; screenW = $vs.Width; screenH = $vs.Height; capMs = 0; repaint = 0; shapes = 0; labelsCount = 0; pinned = $false; regionOnly = $false; hidden = $false; reason = ''; error = '' }

  $timeoutSec = 120
  if ($null -ne $req.timeoutSec) { $timeoutSec = [int]$req.timeoutSec }
  if ($timeoutSec -lt 3) { $timeoutSec = 3 }
  if ($timeoutSec -gt 600) { $timeoutSec = 600 }
  $dim = $DimPercent
  if ($null -ne $req.dim) { $dim = [int]$req.dim }
  if ($dim -lt 0) { $dim = 0 }
  if ($dim -gt 95) { $dim = 95 }
  $outPng = ''
  if ($null -ne $req.png) { $outPng = [string]$req.png }
  # Hide-self (R30): hide the caller's own window for the duration of the freeze. The client
  # sends its own window title; an empty title means "do not hide" (and is never an error).
  $hideSelf = ($req.hideSelf -eq $true)
  $hideTitle = ''
  if ($null -ne $req.hideTitle) { $hideTitle = [string]$req.hideTitle }

  $script:ovTicks = $timeoutSec * 2
  $script:ovForm = $null
  $raw = $null
  $dimBmp = $null
  $result = $null

  try {
    # ---- hide the caller BEFORE the freeze, otherwise the frame contains it ----
    if ($hideSelf) { $res.hidden = Hide-SelfWindow $hideTitle }

    # ---- freeze the whole virtual desktop BEFORE our window exists ----
    $capStart = $sw.ElapsedMilliseconds
    $raw = New-Object System.Drawing.Bitmap -ArgumentList $vs.Width, $vs.Height
    $g0 = [System.Drawing.Graphics]::FromImage($raw)
    try {
      $g0.CopyFromScreen($vs.X, $vs.Y, 0, 0, (New-Object System.Drawing.Size -ArgumentList $vs.Width, $vs.Height), [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally { $g0.Dispose() }
    $res.capMs = $sw.ElapsedMilliseconds - $capStart

    $dimBmp = New-Object System.Drawing.Bitmap -ArgumentList $vs.Width, $vs.Height
    $gd = [System.Drawing.Graphics]::FromImage($dimBmp)
    $gd.DrawImage($raw, 0, 0, $vs.Width, $vs.Height)
    $alpha = [int]([math]::Round(255.0 * $dim / 100.0))
    $db = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb($alpha, 0, 0, 0))
    $gd.FillRectangle($db, 0, 0, $vs.Width, $vs.Height)
    $db.Dispose()
    $gd.Dispose()

    $form = New-Object DshOverlayForm
    $script:ovForm = $form
    $form.RawBmp = $raw
    $form.DimBmp = $dimBmp
    # Toolbar captions travel with the request because this file has to stay ASCII.
    if ($null -ne $req.labels) {
      $arr = New-Object 'string[]' 9
      $n = 0
      foreach ($v in $req.labels) {
        if ($n -lt 9) { $arr[$n] = [string]$v; $n = $n + 1 }
      }
      $form.Labels = $arr
      $res.labelsCount = $n
    }
    if ($null -ne $req.formShot) { $form.FormShotPath = [string]$req.formShot }
    if ($null -ne $req.hint) { $form.Hint = [string]$req.hint }
    # Region-only: the rectangle is the whole deliverable (long screenshot / OCR / translate).
    if ($req.regionOnly -eq $true) { $form.RegionOnly = $true }
    $form.Bounds = New-Object System.Drawing.Rectangle -ArgumentList $vs.X, $vs.Y, $vs.Width, $vs.Height
    $form.Text = 'dsh-shot-overlay'

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 500
    $timer.Add_Tick({
      $script:ovTicks = $script:ovTicks - 1
      if ($script:ovTicks -le 0) { try { $script:ovForm.Close() } catch { } }
    })
    # The caller's window comes back the moment the overlay is on screen: the overlay covers
    # the whole desktop, so showing it BEHIND the overlay is invisible to the user and means
    # there is no window-missing gap at all. (Foreground is restored after the overlay closes.)
    $form.Add_Shown({ try { Restore-SelfWindow } catch { }; $timer.Start() })

    # Test channel: when the request carries selfTest, paint three annotations
    # programmatically and confirm -- so the selection -> annotate -> render ->
    # clipboard chain is verifiable in an environment that cannot move the mouse.
    # Keep this block ASCII only; see the header rule about BOM-less UTF-8.
    if ($req.selfTest -eq $true) {
      $stimer = New-Object System.Windows.Forms.Timer
      $stimer.Interval = 900
      $stimer.Add_Tick({
        $stimer.Stop()
        try {
          $script:ovForm.RunSelfTest()
          Start-Sleep -Milliseconds 200
          # Region-only closes the form from inside RunSelfTest (it drives the real
          # transition), so there is nothing left to confirm or pin.
          if ($req.regionOnly -ne $true) {
            if ($req.pinTest -eq $true) { $script:ovForm.PinNow() } else { $script:ovForm.ConfirmNow() }
          }
        } catch { Log ('selftest failed: ' + $_.Exception.Message) }
      })
      $script:ovSTimer = $stimer
      $form.Add_Shown({ $script:ovSTimer.Start() })
    }

    [void]$form.ShowDialog()
    $timer.Dispose()
    # Focus goes back to the window the user came from. Safe only now: while the overlay was
    # alive, this would have stolen the keyboard from it (see Restore-SelfWindow).
    Restore-SelfWindow -ToFront
    $res.repaint = [int]$form.Repaints
    $res.shapes = [int]$form.ShapeCount
    # R66: the self test leaves a "selection near the bottom" measurement behind, so the caller
    # can assert the layout RULE (card flips above the selection) instead of only eyeballing the
    # rendered PNG. Reported as numbers; 0/0 when no self test ran.
    $fb = $form.FlipBar
    $res.flipBar = @{ x = [int]$fb.X; y = [int]$fb.Y; w = [int]$fb.Width; h = [int]$fb.Height }
    $res.flipAbove = [bool]$form.FlipAbove
    $res.barSize = @{ w = [int]$form.BarWidthPublic; h = [int]$form.BarHeightPublic }

    if ($form.RegionPicked) {
      # Region-only: hand back the rectangle. Deliberately no Clipboard::SetImage and no
      # PNG -- the caller is about to grab this area itself, and a stray screenshot in the
      # clipboard would clobber whatever the user had copied.
      $selRect = $form.Selection
      $res.ok = $true
      $res.regionOnly = $true
      $res.reason = 'region'
      $res.x = ($vs.X + $selRect.X)
      $res.y = ($vs.Y + $selRect.Y)
      $res.w = $selRect.Width
      $res.h = $selRect.Height
      Log ('region ' + $selRect.Width + 'x' + $selRect.Height + ' at ' + $res.x + ',' + $res.y)
    } elseif ($form.Cancelled) {
      $res.cancelled = $true
      $res.reason = 'esc'
    } elseif ($form.Pinned) {
      # Pin: the picture is neither saved nor copied -- it becomes its own borderless
      # topmost window that stays on screen. Ownership of this Bitmap passes to the pin
      # form, so it must NOT be assigned to $result (the finally block would Dispose it).
      $pinBmp = $form.RenderResult()
      if ($null -eq $pinBmp) {
        $res.reason = 'too-small'
      } else {
        $selRect = $form.Selection
        $pinBounds = New-Object System.Drawing.Rectangle -ArgumentList ($vs.X + $selRect.X), ($vs.Y + $selRect.Y), $selRect.Width, $selRect.Height
        $pin = New-Object DshPinForm -ArgumentList $pinBmp, $pinBounds
        # R67: action menu captions + the two places the picture can go. Chinese text can
        # only come from the request (this file must stay ASCII); the C# defaults cover an
        # old client that sends nothing.
        if ($null -ne $req.pinMenu) {
          $pm = @()
          foreach ($v in $req.pinMenu) { $pm = @($pm) + @([string]$v) }
          $pin.MenuLabels = $pm
        }
        if ($null -ne $req.pinToast) {
          $pt2 = @()
          foreach ($v in $req.pinToast) { $pt2 = @($pt2) + @([string]$v) }
          $pin.ToastLabels = $pt2
        }
        $pin.SavePath = $outPng
        if ($null -ne $req.pngFallback) { $pin.SaveFallback = [string]$req.pngFallback }
        $pin.HandoffDir = Join-Path $Dir 'pins'
        $pin.HandoffFile = Join-Path $Dir 'pinout.json'
        $pin.Show()
        $script:pins = @($script:pins) + @($pin)
        # Test channel: no human can click a topmost window from a low-integrity shell, so the
        # scale math, the caption round-trip and the hand-off file are reported as numbers.
        if ($req.pinProbe -eq $true) {
          $w0 = $pin.Width
          $h0 = $pin.Height
          $pin.DebugZoom(1.5)
          $res.pinZoom = @{ w0 = $w0; h0 = $h0; w1 = $pin.Width; h1 = $pin.Height; pct = [int]$pin.LastPercent; srcW = $pinBmp.Width; srcH = $pinBmp.Height }
          $res.pinMenu = [string]$pin.DebugMenu()
          $hp = [string]$pin.DebugSend()
          $hb = 0
          if ($hp -ne '' -and (Test-Path -LiteralPath $hp)) { $hb = [int64](Get-Item -LiteralPath $hp).Length }
          $res.pinHandoff = @{ png = $hp; bytes = $hb; file = [string]$pin.HandoffFile; w = $pinBmp.Width; h = $pinBmp.Height }
          if ($null -ne $req.pinShot) { $pin.DebugDump([string]$req.pinShot) }
          # The marker is still sitting in the mailbox (nothing polls it here), so the
          # honesty branch must say "nobody took it" instead of pretending it was delivered.
          $res.pinSendWarn = [string]$pin.DebugSendCheckNow()
        }
        if ($req.pinTest -eq $true) {
          # test-only: close the pin after a moment so the self test leaves nothing behind
          $pt = New-Object System.Windows.Forms.Timer
          $pt.Interval = 1500
          $pt.Add_Tick({
            $pt.Stop()
            foreach ($pp in @($script:pins)) { try { $pp.Close() } catch { } }
            $script:pins = @()
          })
          $script:ovPinTimer = $pt
          $pt.Start()
        }
        $res.ok = $true
        $res.pinned = $true
        $res.reason = 'pinned'
        $res.x = ($vs.X + $selRect.X)
        $res.y = ($vs.Y + $selRect.Y)
        $res.w = $selRect.Width
        $res.h = $selRect.Height
        Log ('pinned ' + $selRect.Width + 'x' + $selRect.Height + ' (open pins: ' + @($script:pins).Length + ')')
      }
    } elseif ($form.Confirmed) {
      $result = $form.RenderResult()
      if ($null -eq $result) {
        $res.reason = 'too-small'
      } else {
        $selRect = $form.Selection
        # Clipboard isn't ours alone: another app can hold it open, and then OpenClipboard fails
        # ("the requested clipboard operation failed") -- measured in R30, and it is TRANSIENT
        # (a few dozen ms later it works). Retry instead of silently handing back an image the
        # user thinks they copied. `clip` must stay truthful either way: the client now says
        # "couldn't copy" instead of claiming success.
        $clipTries = 0
        $clipErr = ''
        while ($clipTries -lt 4 -and -not $res.clip) {
          $clipTries += 1
          try {
            [System.Windows.Forms.Clipboard]::SetImage($result)
            $res.clip = $true
          } catch {
            $clipErr = $_.Exception.Message
            Log ('clipboard attempt ' + $clipTries + ': ' + $clipErr)
            if ($clipTries -lt 4) { Start-Sleep -Milliseconds 90 }
          }
        }
        # Truthful reason when the copy did not happen: "the clipboard is held by another app" is
        # a condition the caller must be able to SEE (the client says it, and the self-checks
        # treat it as "resource busy", not as a product regression).
        $res.clipTries = $clipTries
        $res.clipError = $(if ($res.clip) { '' } else { $clipErr })
        if ($outPng) {
          try {
            $parent = Split-Path -Parent $outPng
            if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            $result.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
            $res.png = $outPng
          } catch { Log ('save png: ' + $_.Exception.Message) }
        }
        # If the pictures folder is not writable, fall back to the plugin cache --
        # same two-candidate idea as shot.mjs save(). A hard failure here would throw
        # away an otherwise complete pick, so it must never fail the request.
        if (-not $res.png -and $req.pngFallback) {
          $fb = [string]$req.pngFallback
          try {
            $fparent = Split-Path -Parent $fb
            if ($fparent -and -not (Test-Path $fparent)) { New-Item -ItemType Directory -Path $fparent -Force | Out-Null }
            $result.Save($fb, [System.Drawing.Imaging.ImageFormat]::Png)
            $res.png = $fb
            Log 'saved to fallback path'
          } catch { Log ('save fallback failed: ' + $_.Exception.Message) }
        }
        $res.ok = $true
        $res.reason = 'picked'
        $res.x = ($vs.X + $selRect.X)
        $res.y = ($vs.Y + $selRect.Y)
        $res.w = $selRect.Width
        $res.h = $selRect.Height
      }
    } else {
      $res.reason = 'timeout'
    }
  } catch {
    $res.error = $_.Exception.Message
    Log ('pick failed: ' + $res.error)
  } finally {
    # Last line of defence: a throw anywhere above must not leave the user's window hidden.
    try { Restore-SelfWindow } catch { }
    try { if ($null -ne $script:ovForm) { $script:ovForm.Hide(); [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 150 } } catch { }
    try { if ($null -ne $script:ovForm) { $script:ovForm.Dispose() } } catch { }
    $script:ovForm = $null
    try { if ($null -ne $result) { $result.Dispose() } } catch { }
    try { if ($null -ne $raw) { $raw.Dispose() } } catch { }
    try { if ($null -ne $dimBmp) { $dimBmp.Dispose() } } catch { }
    $res.ms = $sw.ElapsedMilliseconds
  }

  try { Write-Json $resFile $res } catch { Log ('write res failed: ' + $_.Exception.Message) }
  Log ('served ' + $callTag + ' ok=' + $res.ok + ' reason=' + $res.reason + ' shapes=' + $res.shapes + ' repaint=' + $res.repaint + ' ms=' + $res.ms)
}

try { Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue } catch { }
try { Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue } catch { }
Log 'bye'
exit 0
