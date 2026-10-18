# DSH screenshot plugin - one-shot capture CLI (the FALLBACK path).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -Mode desktop|window -Out <png> [options]
#
#   -Mode desktop   capture the whole virtual screen (all monitors)
#   -Mode window    capture only one window: -Hwnd <n> if given, else the -Target title substring
#   -Hwnd           window handle from windows.ps1 (0 = ignore, match by title instead)
#   -HideSelf       hide the captured window before capturing, restore right after
#   -Out            output PNG path (required)
#   -Target         window title substring, default "DeepSeek Harness"
#   -Json           print a single JSON line to stdout (mode/hwnd/left/top/width/height/...)
#
# This file is only the CLI shell: it parses the arguments, hands them to Invoke-DshCapture
# (ps/shotcore.ps1) and prints the same JSON line / human line / exit codes it always has.
#
# Why the split: everything below the parameter block costs ~1.9s per process (process start
# ~500ms, Add-Type -AssemblyName System.Drawing ~260ms, compiling the C# interop ~390ms,
# parsing/binding this script) while the actual BitBlt+PNG work is only ~150ms. ps/shooter.ps1
# keeps ONE process alive and pays that once, then serves each capture in ~200-300ms. Both
# callers use the same core so the resident helper can never drift from this fallback.
#
# ASCII only: the console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.
param(
  [Parameter(Mandatory=$true)][ValidateSet('desktop','window')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Target = 'DeepSeek Harness',
  [long]$Hwnd = 0,
  [switch]$HideSelf,
  [switch]$Json,
  [int]$HideDelayMs = 260,
  # Explicit screen rectangle "x,y,w,h" in PHYSICAL pixels, overriding whatever Mode resolved to.
  # This is what makes "AI captures a region with zero window stealing" possible: no foreground
  # window is needed, and the region is authoritative. -Mode still decides the reporting label.
  [string]$Rect = '',
  # Restore a minimized target instead of failing. Default ON for the picker (a user picking a
  # minimized window means "give me that window"), OFF for AI calls (never move the user's windows).
  [switch]$NoRestore,
  # Raise the target window before a SCREEN grab. Correct for "the user picked this window"
  # (a covered window would otherwise contribute the OCCLUDER's pixels at the right geometry,
  # which looks exactly like success). Wrong for AI grabs - it moves the user's windows.
  [switch]$BringToFront,
  # window mode only: 'screen' grabs the screen region (fast, but shows whatever
  # is on top), 'print' asks the window to render itself into a DC (works even
  # when the window is covered or off-screen; Electron/Chromium needs
  # PW_RENDERFULLCONTENT or it returns a black frame).
  [ValidateSet('screen','print')][string]$Method = 'screen'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'shotcore.ps1')

$res = Invoke-DshCapture `
  -Mode $Mode -Out $Out -Target $Target -Hwnd $Hwnd `
  -HideSelf:([bool]$HideSelf) -HideDelayMs $HideDelayMs -Rect $Rect `
  -NoRestore:([bool]$NoRestore) -BringToFront:([bool]$BringToFront) -Method $Method

# Same failure shape as before: the message on stderr, a non-zero exit code. (With
# $ErrorActionPreference = 'Stop' the Write-Error below is itself terminating, exactly like the
# old inline Write-Errors were - which is why the observed exit code has always been 1.)
if (-not $res.ok) {
  Write-Error $res.error
  exit $res.exitCode
}

$info = $res.info
if ($Json) {
  Write-Output ($info | ConvertTo-Json -Compress)
} else {
  $note = ''
  if ($info.PSObject.Properties['fallback']) { $note = " [$($info.fallback)]" }
  Write-Output ("captured {0}/{1} {2}x{3} at {4},{5} hwnd={6} -> {7}{8}" -f $info.mode, $info.method, $info.width, $info.height, $info.left, $info.top, $info.hwnd, $info.path, $note)
}
