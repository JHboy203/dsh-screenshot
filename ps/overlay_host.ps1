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
#   node writes   <Dir>\ovlreq-<callTag>.json   { timeoutSec, dim, png, tag }
#   we read it, delete it, run the picker, then write
#                 <Dir>\ovlres-<callTag>.json   { ok, cancelled, x, y, w, h, clip,
#                                                 png, ms, dpi, screenW, screenH,
#                                                 capMs, repaint, shapes, reason,
#                                                 error }
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

  private const int BtnW = 64;
  private const int BtnH = 26;
  private const int BtnGap = 6;

  private Rectangle sel = Rectangle.Empty;
  private Rectangle prevSel = Rectangle.Empty;
  private int phase = 0;                       // 0 = selecting, 1 = annotating
  private int tool = 0;                        // 0 rect, 1 arrow, 2 pen, 3 mosaic, 4 number
  private int nextNum = 1;
  private List<DshShape> shapes = new List<DshShape>();
  private DshShape cur = null;
  private Point downPt;
  private bool dragging = false;
  private readonly Font uiFont = new Font("Microsoft YaHei UI", 9f);
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

  // Opaque + AllPaintingInWmPaint already skip this; the background fill is exactly
  // what produced the flicker, so keep it a hard no-op.
  protected override void OnPaintBackground(PaintEventArgs e) { }

  private static Rectangle Grow(Rectangle r) {
    if (r.Width <= 0 || r.Height <= 0) return Rectangle.Empty;
    return Rectangle.Inflate(r, 8, 40);        // 2px border + the toolbar strip
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
  }

  private Rectangle ToolbarRect() {
    if (sel.Width < 2 || sel.Height < 2) return Rectangle.Empty;
    int tw = BtnW * 9 + BtnGap * 8;
    int ty = sel.Bottom + 10;
    if (ty + BtnH > this.ClientSize.Height - 6) ty = sel.Top - BtnH - 10;
    if (ty < 6) ty = 6;
    int tx = sel.X;
    if (tx + tw > this.ClientSize.Width - 6) tx = this.ClientSize.Width - tw - 6;
    if (tx < 6) tx = 6;
    return new Rectangle(tx, ty, tw, BtnH);
  }

  private Rectangle BtnRect(int i) {
    Rectangle tb = ToolbarRect();
    return new Rectangle(tb.X + i * (BtnW + BtnGap), tb.Y, BtnW, BtnH);
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
    return new Rectangle(mx, my, mw, mh + 22);
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
    Rectangle dst = new Rectangle(box.X, box.Y, mw, mh);
    GraphicsState st = g.Save();
    InterpolationMode om = g.InterpolationMode;
    PixelOffsetMode op = g.PixelOffsetMode;
    g.InterpolationMode = InterpolationMode.NearestNeighbor;
    g.PixelOffsetMode = PixelOffsetMode.Half;
    g.DrawImage(RawBmp, dst, new Rectangle(sx, sy, srcW, srcH), GraphicsUnit.Pixel);
    g.InterpolationMode = om;
    g.PixelOffsetMode = op;
    g.Restore(st);
    using (Pen border = new Pen(Color.White, 1f)) g.DrawRectangle(border, dst);
    using (Pen cross = new Pen(Color.FromArgb(210, 240, 68, 56), 1f)) {
      g.DrawLine(cross, dst.X + mw / 2, dst.Y + 8, dst.X + mw / 2, dst.Y + mh - 8);
      g.DrawLine(cross, dst.X + 8, dst.Y + mh / 2, dst.X + mw - 8, dst.Y + mh / 2);
    }
    string lbl = cursor.X + ", " + cursor.Y;
    using (SolidBrush bg = new SolidBrush(Color.FromArgb(220, 0, 0, 0))) {
      g.FillRectangle(bg, box.X, box.Y + mh, box.Width, 20);
    }
    g.DrawString(lbl, uiFont, Brushes.White, box.X + 4, box.Y + mh + 2);
  }

  private void DrawToolbar(Graphics g) {
    for (int i = 0; i < 9; i++) {
      Rectangle r = BtnRect(i);
      bool active = (i < 7 && i == tool);
      Color bg = active ? Accent : Color.FromArgb(235, 38, 38, 44);
      using (SolidBrush b = new SolidBrush(bg)) g.FillRectangle(b, r);
      using (Pen p = new Pen(Color.FromArgb(255, 96, 96, 108), 1f)) g.DrawRectangle(p, r.X, r.Y, r.Width - 1, r.Height - 1);
      if (i == 7) {
        // colour swatch: shows the colour the next stroke will use
        using (SolidBrush sw = new SolidBrush(palette[colorIdx])) {
          g.FillEllipse(sw, r.X + r.Width / 2 - 9, r.Y + r.Height / 2 - 9, 18, 18);
        }
        using (Pen ring = new Pen(Color.White, 1f)) {
          g.DrawEllipse(ring, r.X + r.Width / 2 - 9, r.Y + r.Height / 2 - 9, 18, 18);
        }
        continue;
      }
      string label = BtnLabel(i);
      SizeF sz = g.MeasureString(label, uiFont);
      using (SolidBrush fg = new SolidBrush(active && IsLight(Accent) ? Color.Black : Color.White)) {
        g.DrawString(label, uiFont, fg, r.X + (r.Width - sz.Width) / 2f, r.Y + (r.Height - sz.Height) / 2f);
      }
    }
    Rectangle tb = ToolbarRect();
    g.DrawString((Hint != null && Hint.Length > 0) ? Hint : "Enter copy   P pin   Esc back   Ctrl+Z undo   X width   C colour", uiFont, Brushes.White, tb.X, tb.Bottom + 4);
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

      string label = sel.Width + " x " + sel.Height;
      float ly = sel.Y - 22;
      if (ly < 2) ly = sel.Y + 4;
      g.DrawString(label, labelFont, Brushes.White, sel.X + 4, ly);

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
            Invalidate(ToolbarRect());
          } else {
            tool = i;
            Invalidate(ToolbarRect());
          }
          return;
        }
      }
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
      if (e.KeyCode == Keys.D1 || e.KeyCode == Keys.NumPad1) { tool = 0; Invalidate(ToolbarRect()); }
      else if (e.KeyCode == Keys.D2 || e.KeyCode == Keys.NumPad2) { tool = 1; Invalidate(ToolbarRect()); }
      else if (e.KeyCode == Keys.D3 || e.KeyCode == Keys.NumPad3) { tool = 2; Invalidate(ToolbarRect()); }
      else if (e.KeyCode == Keys.D4 || e.KeyCode == Keys.NumPad4) { tool = 3; Invalidate(ToolbarRect()); }
      else if (e.KeyCode == Keys.D5 || e.KeyCode == Keys.NumPad5) { tool = 4; Invalidate(ToolbarRect()); }
      else if (e.KeyCode == Keys.D6 || e.KeyCode == Keys.NumPad6) { tool = 5; Invalidate(ToolbarRect()); }
      else if (e.KeyCode == Keys.D7 || e.KeyCode == Keys.NumPad7) { tool = 6; Invalidate(ToolbarRect()); }
      else if (e.KeyCode == Keys.C) { CycleColor(); Invalidate(ToolbarRect()); }
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

// A pinned screenshot: borderless, topmost, drag to move, double-click / right-click /
// Esc to close. It is NOT modal -- it has to outlive the overlay that produced it, so
// the helper's serve loop pumps messages (Application::DoEvents) to keep it alive.
public class DshPinForm : Form {
  private Bitmap bmp;
  private Point dragOffset;
  private bool dragging = false;

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
  }

  protected override void OnPaintBackground(PaintEventArgs e) { }

  protected override void OnPaint(PaintEventArgs e) {
    if (bmp != null) e.Graphics.DrawImage(bmp, 0, 0);
    using (Pen p = new Pen(Color.FromArgb(110, 255, 255, 255), 1f)) {
      e.Graphics.DrawRectangle(p, 0, 0, this.Width - 1, this.Height - 1);
    }
  }

  protected override void OnMouseDown(MouseEventArgs e) {
    base.OnMouseDown(e);
    if (e.Button == MouseButtons.Left) {
      dragging = true;
      dragOffset = e.Location;
    } else {
      Close();
    }
  }

  protected override void OnMouseMove(MouseEventArgs e) {
    base.OnMouseMove(e);
    if (!dragging) return;
    Point p = PointToScreen(e.Location);
    Location = new Point(p.X - dragOffset.X, p.Y - dragOffset.Y);
  }

  protected override void OnMouseUp(MouseEventArgs e) {
    base.OnMouseUp(e);
    dragging = false;
  }

  protected override void OnDoubleClick(EventArgs e) {
    base.OnDoubleClick(e);
    Close();
  }

  protected override void OnKeyDown(KeyEventArgs e) {
    base.OnKeyDown(e);
    if (e.KeyCode == Keys.Escape) Close();
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
  $res = @{ ok = $false; cancelled = $false; x = 0; y = 0; w = 0; h = 0; clip = $false; png = ''; ms = 0; dpi = $script:dpiMode; screenW = $vs.Width; screenH = $vs.Height; capMs = 0; repaint = 0; shapes = 0; labelsCount = 0; pinned = $false; regionOnly = $false; reason = ''; error = '' }

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

  $script:ovTicks = $timeoutSec * 2
  $script:ovForm = $null
  $raw = $null
  $dimBmp = $null
  $result = $null

  try {
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
    $form.Add_Shown({ $timer.Start() })

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
    $res.repaint = [int]$form.Repaints
    $res.shapes = [int]$form.ShapeCount

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
        $pin.Show()
        $script:pins = @($script:pins) + @($pin)
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
        try { [System.Windows.Forms.Clipboard]::SetImage($result); $res.clip = $true } catch { Log ('clipboard: ' + $_.Exception.Message) }
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
