# recframe-control.ps1 -- CANARY: can a window created by the probe actually reach the screen?
#
# WHY THIS FILE EXISTS
#   R32's frame probe asserted "the border is on screen" and got zero border pixels. The window
#   existed, was visible to Win32, painted, and closed cleanly on the stop file -- and the screen
#   showed nothing. Before blaming the frame's painting, we must know whether ANY window started
#   this way can be seen. This fixture is that question, and nothing else:
#
#     a plain, opaque, lime green window at a fixed place, with a title, that closes itself.
#
#   If the probe cannot find lime pixels here, the environment (not the frame code) is at fault and
#   every pixel assertion downstream is meaningless. That distinction cost a full round once.
#
# ASCII ONLY.
param(
  [int]$X = 40,
  [int]$Y = 40,
  [int]$W = 240,
  [int]$H = 120,
  [int]$Seconds = 25,
  [string]$Info = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshFrameCanary {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
try { [void][DshFrameCanary]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][DshFrameCanary]::SetProcessDPIAware() } catch {} }

$f = New-Object System.Windows.Forms.Form
$f.Text = 'DSH-RECFRAME-CANARY'
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.Bounds = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$f.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255, 0)
$f.TopMost = $true

$f.Add_Shown({
  try {
    $r = $f.Bounds
    $payload = @{ ok = $true; hwnd = [int]$f.Handle; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }
    if ($Info -ne '') {
      [System.IO.File]::WriteAllText($Info, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    }
  } catch {}
  $t = New-Object System.Windows.Forms.Timer
  $t.Interval = [Math]::Max(1000, $Seconds * 1000)
  $t.Add_Tick({ $t.Stop(); $f.Close() })
  $t.Start()
})

[void]$f.ShowDialog()
