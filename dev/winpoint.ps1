# dsh-screenshot / dev/winpoint.ps1 -- what windows live at one screen point (dev ruler).
#
# Prints one JSON line: the LEAF window under the point, its ROOT (top-level) ancestor, and the
# whole chain between them (class + title each). Used to ask "who would a wheel message have to
# be addressed to?" before deciding whether the product should post to the root or to the leaf.
#
#   pwsh -NoProfile -File winpoint.ps1 -X 900 -Y 500
#
# ASCII only (the console is GBK; PowerShell 5.1 eats BOM-less UTF-8).
param([int]$X = 0, [int]$Y = 0)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class DshWinPoint {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static string Cls(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassNameW(h, sb, 256);
    return sb.ToString();
  }
  public static string Txt(IntPtr h) {
    var sb = new StringBuilder(256);
    GetWindowTextW(h, sb, 256);
    return sb.ToString();
  }
  public static string Chain(IntPtr leaf) {
    var parts = new List<string>();
    IntPtr cur = leaf;
    int guard = 0;
    while (cur != IntPtr.Zero && guard < 12) {
      parts.Add(cur.ToInt64().ToString() + ":" + Cls(cur));
      IntPtr up = GetParent(cur);
      if (up == IntPtr.Zero) break;
      cur = up;
      guard++;
    }
    return string.Join(" <- ", parts.ToArray());
  }
}
"@

try { [void][DshWinPoint]::SetProcessDPIAware() } catch {}

$p = New-Object DshWinPoint+POINT
$p.X = $X
$p.Y = $Y
$leaf = [DshWinPoint]::WindowFromPoint($p)
$root = if ($leaf -eq [IntPtr]::Zero) { [IntPtr]::Zero } else { [DshWinPoint]::GetAncestor($leaf, 2) }
if ($root -eq [IntPtr]::Zero) { $root = $leaf }

Write-Output (([ordered]@{
  ok = [bool]($leaf -ne [IntPtr]::Zero)
  x = $X
  y = $Y
  leaf = [long]$leaf
  leafClass = $(if ($leaf -eq [IntPtr]::Zero) { '' } else { [DshWinPoint]::Cls($leaf) })
  root = [long]$root
  rootClass = $(if ($root -eq [IntPtr]::Zero) { '' } else { [DshWinPoint]::Cls($root) })
  rootTitle = $(if ($root -eq [IntPtr]::Zero) { '' } else { [DshWinPoint]::Txt($root) })
  chain = $(if ($leaf -eq [IntPtr]::Zero) { '' } else { [DshWinPoint]::Chain($leaf) })
}) | ConvertTo-Json -Compress)
exit 0
