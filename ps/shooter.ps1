# DSH screenshot plugin - the RESIDENT capture helper (one process, many captures).
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File shooter.ps1 -Dir <dir> -Tag <tag> [-ParentPid <n>]
#
# The problem it solves (all numbers measured on this machine, 1920x1080, one capture):
#   process start                     ~500ms
#   Add-Type -AssemblyName Drawing    ~260ms
#   compiling the C# interop          ~390ms
#   parsing + binding capture.ps1     ~250ms
#   ----------------------------------------
#   actual BitBlt + PNG encode        ~150ms      <- the ONLY part that is real work
# Every one-shot call pays all of it. This process pays it once, then serves each capture for
# ~200-300ms, which is what makes the overlay appear instantly instead of "after a few seconds".
#
# Protocol - THE FILESYSTEM IS THE ONLY CHANNEL. No pipes: the DSH file sandbox forbids
# CreatePipe, so `node.spawn` with a pipe is an instant EPERM, and the event-file pattern is
# already how ps/hotkey.ps1 talks to its Node half.
#
#   node  ->  req-<tag>.json    {"seq":N,"op":"cap","mode":..,"out":..,"hideSelf":.., ...}
#   this  ->  res-<tag>.json    {"seq":N,"ok":true,<the same fields capture.ps1's -Json prints>}
#   this  ->  ready-<tag>.json  written once Add-Type/DPI are done = "I can serve now"
#   node  ->  stop-<tag>.flag   graceful quit (node also kills the process if it does not leave)
#   this  ->  stderr            goes to a real file handle (see hotkey.mjs for why)
#
# <tag> is unique per Node start, so a daemon left over from a previous DSH process can never
# answer the new one's requests, and the parent-pid watchdog below makes it exit within ~2s
# anyway (a helper that outlives its host would keep a PowerShell + .NET process alive forever).
#
# ASCII only: the console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.
param(
  [Parameter(Mandatory=$true)][string]$Dir,
  [string]$Tag = 'default',
  # The Node process that spawned us. 0 = do not watch (self-test / manual runs).
  [int]$ParentPid = 0,
  # Absolute lifetime cap, in case the parent check is defeated by pid reuse.
  [int]$MaxMinutes = 720,
  # Poll cadence. Idle is deliberately slower than hot: a capture bursts (long-screenshot loops
  # ask once per ~300ms) and then nothing happens for minutes.
  [int]$HotMs = 8,
  [int]$IdleMs = 40,
  [int]$HotSeconds = 4
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
$reqPath = Join-Path $Dir ("req-" + $Tag + ".json")
$resPath = Join-Path $Dir ("res-" + $Tag + ".json")
$readyPath = Join-Path $Dir ("ready-" + $Tag + ".json")
$stopPath = Join-Path $Dir ("stop-" + $Tag + ".flag")
$utf8 = [System.Text.UTF8Encoding]::new($false)

# Load the capture core exactly once. This is where the ~650ms of Add-Type goes, and it is the
# reason the helper answers fast: the type is in the AppDomain for every later request.
. (Join-Path $PSScriptRoot 'shotcore.ps1')

# Warm-up: the FIRST capture in a fresh process costs ~600ms while every later one costs ~230ms
# (measured, 1920x1080). That extra ~350ms is JIT + first-time GDI/PNG-encoder setup, not
# per-request work - and it is exactly the difference between "the overlay is instant" and "the
# overlay takes half a second". Paying it HERE is free: the user has not clicked yet, and the
# one thing this process must never do is make the first click slow. Failures are irrelevant
# (locked workstation, headless session, ...) and must never stop the helper from going ready.
$warmPath = Join-Path $Dir ("warmup-" + $Tag + ".png")
try { $null = Invoke-DshCapture -Mode 'desktop' -Out $warmPath } catch { }
if ([System.IO.File]::Exists($warmPath)) { Remove-Item -LiteralPath $warmPath -Force -ErrorAction SilentlyContinue }

function Write-JsonFile([string]$Path, [string]$Text) {
  # Write-then-rename: the reader polls for the file and must never see half a JSON document.
  $tmp = $Path + '.tmp'
  [System.IO.File]::WriteAllText($tmp, $Text, $utf8)
  if ([System.IO.File]::Exists($Path)) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Test-TargetAlive([int]$TargetPid, [long]$StartTicks) {
  # "Cannot determine" counts as ALIVE: a daemon that exits spuriously would send every capture
  # back down the 1.9s one-shot path. The MaxMinutes cap bounds the damage either way.
  if ($TargetPid -le 0) { return $true }
  try {
    $proc = [System.Diagnostics.Process]::GetProcessById($TargetPid)
    # pid reuse is NOT hypothetical: a dead Node pid is handed to an unrelated process within
    # minutes on a busy machine, GetProcessById then SUCCEEDS and this helper would believe its
    # host is alive for the whole MaxMinutes cap (measured: a stray helper survived 20+ minutes
    # after its Node had exited). The parent's start time is the cheap, reliable discriminator.
    if ($StartTicks -gt 0) {
      try { if ($proc.StartTime.Ticks -ne $StartTicks) { return $false } } catch { }
    }
    return $true
  } catch {
    $msg = [string]$_.Exception.Message
    if ($msg -match 'not running|Cannot find|No process is associated') { return $false }
    return $true
  }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# The parent's start time, sampled once. See Test-TargetAlive for why the pid alone is not enough.
$parentTicks = 0
if ($ParentPid -gt 0) {
  try { $parentTicks = [System.Diagnostics.Process]::GetProcessById($ParentPid).StartTime.Ticks } catch { $parentTicks = 0 }
}

# Handshake: everything expensive (System.Drawing, the C# interop, DPI awareness, the warm-up) is
# done by now, so from this moment a request is served in a couple hundred milliseconds.
Write-JsonFile $readyPath (([ordered]@{
  ok = $true; stage = 'ready'; pid = $PID; tag = $Tag; parentPid = $ParentPid; parentTicks = $parentTicks
  psVersion = $PSVersionTable.PSVersion.ToString(); at = (Get-Date).ToString('o')
}) | ConvertTo-Json -Compress)

$hotUntil = $sw.ElapsedMilliseconds + ($HotSeconds * 1000)
$lastWatch = 0
$served = 0
$reason = 'stop-flag'

while ($true) {
  if ([System.IO.File]::Exists($stopPath)) { $reason = 'stop-flag'; break }

  if (-not [System.IO.File]::Exists($reqPath)) {
    # Nothing to do. [System.IO.File]::Exists is a direct .NET call (~microseconds), unlike the
    # Test-Path cmdlet, so polling this often costs no measurable CPU.
    if ($sw.ElapsedMilliseconds -lt $hotUntil) { [System.Threading.Thread]::Sleep($HotMs) }
    else { [System.Threading.Thread]::Sleep($IdleMs) }
  } else {
    $hotUntil = $sw.ElapsedMilliseconds + ($HotSeconds * 1000)
    $startedReq = $sw.ElapsedMilliseconds

    $body = ''
    try { $body = [System.IO.File]::ReadAllText($reqPath) } catch { $body = '' }
    # Consume the request immediately: a second read of the same request must never happen.
    Remove-Item -LiteralPath $reqPath -Force -ErrorAction SilentlyContinue

    $req = $null
    try { if ($body.Trim().Length -gt 0) { $req = $body | ConvertFrom-Json } } catch { $req = $null }

    if ($null -eq $req) {
      # Unparseable/empty request (a crash between write and rename, say). Nothing to answer.
      continue
    }

    $seq = 0
    try { $seq = [int]$req.seq } catch { $seq = 0 }

    $out = [ordered]@{ seq = $seq; ok = $false; error = ''; exitCode = 0; ms = 0 }
    try {
      $mode = 'desktop'
      if ([string]$req.mode -eq 'window') { $mode = 'window' }
      $method = 'screen'
      if ([string]$req.method -eq 'print') { $method = 'print' }
      $target = [string]$req.target
      if ([string]::IsNullOrEmpty($target)) { $target = 'DeepSeek Harness' }
      $hwnd = 0
      try { $hwnd = [long]$req.hwnd } catch { $hwnd = 0 }

      $r = Invoke-DshCapture -Mode $mode -Out ([string]$req.out) -Target $target -Hwnd $hwnd `
        -HideSelf:([bool]$req.hideSelf) -Rect ([string]$req.rect) `
        -NoRestore:([bool]$req.noRestore) -Method $method

      if ($r.ok) {
        foreach ($prop in $r.info.PSObject.Properties) { $out[$prop.Name] = $prop.Value }
        $out['ok'] = $true
        $out['error'] = ''
      } else {
        $out['ok'] = $false
        $out['error'] = [string]$r.error
        $out['exitCode'] = [int]$r.exitCode
      }
    } catch {
      # One bad request must never take the helper down - the Node side would then fall back to
      # the slow path for the rest of the session.
      $out['ok'] = $false
      $out['error'] = 'helper: ' + [string]$_.Exception.Message
      $out['exitCode'] = 1
    }

    $out['ms'] = [int]($sw.ElapsedMilliseconds - $startedReq)
    $served = $served + 1
    try { Write-JsonFile $resPath ($out | ConvertTo-Json -Compress) } catch { }
  }

  # Parent watchdog, checked roughly every 2 seconds (the same idea as ps/hotkey.ps1): if DSH is
  # force-killed its dispose never runs, and without this the helper would linger indefinitely.
  if (($sw.ElapsedMilliseconds - $lastWatch) -ge 2000) {
    $lastWatch = $sw.ElapsedMilliseconds
    if (-not (Test-TargetAlive $ParentPid $parentTicks)) { $reason = 'parent-gone'; break }
    if ($MaxMinutes -gt 0 -and $sw.ElapsedMilliseconds -gt ([long]$MaxMinutes * 60000)) { $reason = 'max-minutes'; break }
  }
}

# Leave nothing behind that a later reader could mistake for a live helper.
foreach ($f in @($readyPath, $reqPath, $stopPath)) {
  if ([System.IO.File]::Exists($f)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
}
Write-Output ("shooter exited reason=" + $reason + " served=" + $served + " uptimeMs=" + $sw.ElapsedMilliseconds)
exit 0
