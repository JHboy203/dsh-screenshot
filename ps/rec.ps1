# DSH screenshot plugin - recording post-processing helper (host side).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ps/rec.ps1 -Action <verb> [options] [-OutJson <path>]
#
# Actions
#   info     -In <mp4>                                        -> {ok,duration,width,height,fps,bytes}
#   frame    -In <mp4> -Time <sec> -Out <png> [-Width <px>]    -> {ok,path,width,height,bytes}
#   strip    -In <mp4> [-Count 12] [-Width 320] -OutDir <dir>  -> {ok,frames:[{t,path}],count}
#   trim     -In <mp4> -Start <sec> -End <sec> -Out <mp4>      -> {ok,path,duration,bytes,method}
#   clip     -In <mp4>                                        -> {ok,path,bytes}   (CF_HDROP into the clipboard)
#   open     -In <mp4>                                        -> {ok,path,pid,via} (default player, no block)
#   keep     -In <mp4> [-Name <name>]                         -> {ok,path,bytes,dir}
#   discard  -In <mp4> [-CacheDir <dir>]                      -> {ok,deleted:true,path}
#
# Output contract (the host reads stdout with lib/shot.mjs#lastJsonLine)
#   * The LAST stdout line is one JSON object. Everything else - progress, ffmpeg
#     stderr, warnings - goes to stderr through [Console]::Error.
#   * exit 0 <=> ok:true, exit 1 <=> ok:false. An unknown action is exit 1 with
#     {"ok":false,"error":"unknown action"} - never a silent success.
#   * -OutJson <path> additionally writes the same JSON to a file, so the host can
#     read either channel (stdout redirection has bitten this project before).
#
# Deliberate choices
#   * ASCII source only: the console is GBK and Windows PowerShell 5.1 mis-decodes
#     BOM-less UTF-8. Paths are DATA - they are passed as separate argv elements,
#     never concatenated into a command string, so spaces and CJK survive as-is.
#   * PowerShell names are case-insensitive. Every local is named unlike every
#     parameter: this project once had [string]$Rect silently stringify a local $rect.
#   * ffmpeg candidates mirror lib/shot.mjs#findFfmpeg() and skip anything under
#     "mise" (the Cherry Studio shim exists but exits 127 - it never worked).
#     -Ffmpeg <path> overrides. `-version` is really executed: a dead ffmpeg is an
#     explicit error, never an empty-but-ok result.
#   * -ss goes BEFORE -i (input seek). ffmpeg seeks to the keyframe before the
#     timestamp and decodes+discards up to it (accurate_seek is on by default), so
#     the frame is exact while the cost is O(keyframe distance), not O(timestamp).
#   * trim tries -c copy first and falls back to a re-encode when the copy is not
#     acceptable. Measured on ffmpeg 9.0.1: a copy of [0.5,2.0] out of a clip whose
#     only keyframe is at 0 starts on exactly the right frame but ends ~0.5 s late
#     (whole packets are copied past the limit), so the duration check tolerates
#     lateness proportionally and rejects earliness strictly. The method actually
#     used, plus fallbackFrom/fallbackReason, is always reported.
#   * keep walks [<MyPictures>\DSH<U+622A><U+56FE>, <cache>\keep] and accepts the first
#     directory that passes a real FILE write probe. Creating that folder is allowed
#     while writing a file inside it is not (measured 2026-10-16), so a Test-Path
#     check would happily pick a destination that cannot receive the file. The
#     landing directory and a fallbackReason are reported.
#   * clip: the file is put on the clipboard as CF_HDROP (the same thing Explorer's
#     Copy does), then read back and compared - "copied" is a measurement, not a hope.
#   * discard only deletes inside the plugin cache dir or the temp dirs; anything
#     else is refused by name ("refuse: outside cache dir").
#   * No internal timeout: every ffmpeg call here is bounded by -frames:v 1 or an
#     explicit -t. The host's spawn timeout stays the outer guard.
#
# NOTE: do not add Chinese characters or emoji to this file - the console is GBK.

param(
  # No Mandatory= anywhere: a missing mandatory parameter makes powershell.exe PROMPT
  # on the console and the host would hang instead of getting an error line.
  [string]$Action = '',
  [string]$In = '',
  [double]$Time = 0,
  [string]$Out = '',
  [int]$Width = 0,
  [int]$Count = 12,
  [string]$OutDir = '',
  [double]$Start = -1,
  [double]$End = -1,
  [string]$Name = '',
  [string]$CacheDir = '',
  [string]$Ffmpeg = '',
  [string]$OutJson = '',
  # trim: strict bound on how far the copied duration may run EARLY. Running late is
  # bounded by max(this, 2% of the requested length) - see the note in Invoke-Trim.
  [double]$Tolerance = 0.35
)

$ErrorActionPreference = 'Stop'
# Project convention: UTF8 without BOM (a BOM would corrupt the first stdout line).
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:Tag = '[rec:' + $Action + '] '
function Write-Log {
  param([string]$Text)
  [Console]::Error.WriteLine($script:Tag + $Text)
}

# lib/shot.mjs#CACHE_DIR: DSH_SHOT_CACHE > <plugin root>/.cache
$script:CacheRoot = if ($CacheDir -ne '') {
  [IO.Path]::GetFullPath($CacheDir)
} elseif ($env:DSH_SHOT_CACHE) {
  [IO.Path]::GetFullPath($env:DSH_SHOT_CACHE)
} else {
  Join-Path (Split-Path -Parent $PSScriptRoot) '.cache'
}

# --------------------------------------------------------------------------- utils

function Format-Seconds {
  # Invariant culture: ffmpeg wants "1.5", never "1,5" (comma-decimal locales).
  param([double]$Value)
  return $Value.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
}

function Resolve-Tool {
  # Same candidate order as lib/shot.mjs#findFfmpeg(), plus $env:PATH as a last
  # resort. Anything that looks like a mise shim is skipped: those shims are dead
  # shells ("error while loading shared libraries", exit 127).
  param([string]$Override, [string]$ExeName)
  if ($Override -ne '') { return $Override }
  $cands = New-Object System.Collections.Generic.List[string]
  $cands.Add((Join-Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links') $ExeName))
  $cands.Add((Join-Path (Join-Path $env:ProgramFiles 'ffmpeg\bin') $ExeName))
  $onPath = Get-Command $ExeName -ErrorAction SilentlyContinue
  if ($onPath -ne $null -and $onPath.Source) { $cands.Add([string]$onPath.Source) }
  foreach ($c in $cands) {
    if ([string]::IsNullOrEmpty($c)) { continue }
    if ($c -match 'mise') { continue }
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $ExeName
}

function Test-Tool {
  # Really run "<exe> -version": exit 0 AND a version line, or it is unusable.
  # A dead candidate (the mise shim exits 127, a missing file throws) must never
  # be mistaken for "ffmpeg works but produced nothing".
  param([string]$Exe, [string]$Tag)
  $r = Invoke-Native -Exe $Exe -ArgList @('-version')
  if ($r.thrown -ne '') {
    $why = $r.thrown
    if ($why -match 'not recognized') { $why = 'not found or not executable' }
    return [ordered]@{ ok = $false; code = -1; version = ''; error = ($Exe + ': ' + $why) }
  }
  if ($r.code -ne 0) {
    return [ordered]@{ ok = $false; code = $r.code; version = ''; error = ($Exe + ' -version exited ' + $r.code + ': ' + (Get-FirstLine $r.err)) }
  }
  $raw = [string]$r.out
  if ($raw -notmatch $Tag) {
    return [ordered]@{ ok = $false; code = $r.code; version = ''; error = ($Exe + " -version did not print '" + $Tag + "'") }
  }
  return [ordered]@{ ok = $true; code = 0; version = (Get-FirstLine $raw); error = '' }
}

function Invoke-Native {
  # Run a native exe with stdout/stderr redirected to FILES (never pipes: this
  # project's sandbox blocks CreatePipe for children, and node-side code already
  # settled on temp files for the same reason).
  #
  # $ErrorActionPreference is dropped to 'Continue' for the duration: in Windows
  # PowerShell 5.1 a native process writing to stderr while EAP=Stop turns that
  # output into a TERMINATING error, which would abort a perfectly normal ffmpeg
  # failure and hide its message. Exit codes are read explicitly instead.
  param([string]$Exe, [string[]]$ArgList)
  $stamp = [guid]::NewGuid().ToString('N').Substring(0, 10)
  $tmpRoot = [IO.Path]::GetTempPath()
  $outFile = Join-Path $tmpRoot ('dshrec-' + $stamp + '.out')
  $errFile = Join-Path $tmpRoot ('dshrec-' + $stamp + '.err')
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $code = -1
  $thrown = ''
  try {
    & $Exe @ArgList > $outFile 2> $errFile
    $code = $LASTEXITCODE
  } catch {
    $thrown = $_.Exception.Message
  } finally {
    $ErrorActionPreference = $old
  }
  $outText = ''
  $errText = ''
  foreach ($f in @($outFile, $errFile)) {
    if (-not (Test-Path -LiteralPath $f)) { continue }
    $body = ''
    try { $body = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) } catch { $body = '' }
    if ($f -eq $outFile) { $outText = $body } else { $errText = $body }
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  }
  return [ordered]@{ code = $code; out = $outText; err = $errText; thrown = $thrown }
}

function Get-FirstLine {
  param([string]$Text)
  foreach ($ln in ([string]$Text -split "`r?`n")) {
    if ($ln.Trim() -ne '') { return $ln.Trim() }
  }
  return ''
}

function Get-ExistingFile {
  param([string]$Path, [string]$What)
  if ([string]::IsNullOrEmpty($Path)) { throw ($What + ' required') }
  $full = [IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw ('input not found: ' + $full) }
  return $full
}

function Format-Fps {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return 0.0 }
  if ($Text -match '^(\d+)\s*/\s*(\d+)$') {
    $num = [double]$Matches[1]
    $den = [double]$Matches[2]
    if ($den -le 0) { return 0.0 }
    return [math]::Round($num / $den, 3)
  }
  $val = 0.0
  if ([double]::TryParse($Text, [ref]$val)) { return [math]::Round($val, 3) }
  return 0.0
}

# ------------------------------------------------------------------------ probing

function Get-MediaInfo {
  # ffprobe JSON when available; otherwise parse `ffmpeg -i` (which writes the
  # metadata to stderr and exits 1 - that is normal, not a failure).
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path
  # audio / acodec (R41): the recording side can now capture a microphone, and "did the sound
  # actually make it into the file" can only be answered by looking at the streams. Same pass,
  # no extra process: ffprobe already reads format+streams, an audio stream is one more filter.
  $meta = [ordered]@{ duration = 0.0; width = 0; height = 0; fps = 0.0; bytes = [int64]$item.Length; audio = $false; acodec = ''; source = '' }
  if ($script:ProbeExe -ne '') {
    $probeArgs = @('-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', $Path)
    $r = Invoke-Native -Exe $script:ProbeExe -ArgList $probeArgs
    $raw = [string]$r.out
    if ($r.code -eq 0 -and $raw.Trim() -ne '') {
      try {
        $doc = $raw | ConvertFrom-Json
        $auds = @($doc.streams | Where-Object { $_.codec_type -eq 'audio' })
        if ($auds.Count -gt 0) {
          $meta.audio = $true
          $meta.acodec = [string]$auds[0].codec_name
        }
        $vids = @($doc.streams | Where-Object { $_.codec_type -eq 'video' })
        if ($vids.Count -gt 0) {
          $vs = $vids[0]
          $meta.width = [int]$vs.width
          $meta.height = [int]$vs.height
          $meta.fps = Format-Fps ([string]$vs.avg_frame_rate)
          if ($meta.fps -le 0) { $meta.fps = Format-Fps ([string]$vs.r_frame_rate) }
          $sd = 0.0
          if ($vs.duration -ne $null -and [double]::TryParse([string]$vs.duration, [ref]$sd)) {
            $meta.duration = [math]::Round($sd, 3)
          }
        }
        $fd = 0.0
        if ($doc.format -ne $null -and $doc.format.duration -ne $null -and [double]::TryParse([string]$doc.format.duration, [ref]$fd)) {
          if ($fd -gt 0) { $meta.duration = [math]::Round($fd, 3) }
        }
        $meta.source = 'ffprobe'
        return $meta
      } catch {
        Write-Log ('ffprobe json parse failed: ' + $_.Exception.Message)
      }
    } else {
      Write-Log ('ffprobe unusable (exit ' + $r.code + '): ' + (Get-FirstLine $r.err))
    }
  }
  $ffArgs = @('-hide_banner', '-nostdin', '-i', $Path)
  $r2 = Invoke-Native -Exe $script:FfExe -ArgList $ffArgs
  $raw2 = [string]$r2.err
  if ($raw2 -match 'Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)') {
    $meta.duration = [math]::Round(([double]$Matches[1] * 3600.0 + [double]$Matches[2] * 60.0 + [double]$Matches[3]), 3)
  }
  if ($raw2 -match 'Video:.*?(\d{2,5})x(\d{2,5})') {
    $meta.width = [int]$Matches[1]
    $meta.height = [int]$Matches[2]
  }
  if ($raw2 -match 'Video:.*?(\d+(?:\.\d+)?)\s*fps') {
    $meta.fps = [double]$Matches[1]
  }
  # Fallback path (no ffprobe): `ffmpeg -i` prints "  Stream #0:1: Audio: aac (LC), 48000 Hz, ...".
  if ($raw2 -match 'Stream #\d+:\d+(?:\([^)]*\))?: Audio:\s*([A-Za-z0-9_]+)') {
    $meta.audio = $true
    $meta.acodec = [string]$Matches[1]
  }
  $meta.source = 'ffmpeg -i'
  if ($meta.duration -le 0 -and $meta.width -le 0) {
    throw ('cannot read media info: ' + (Get-FirstLine $raw2))
  }
  return $meta
}

# ------------------------------------------------------------------------ imaging

function Get-ImageSize {
  param([string]$Path)
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($Path)
  try {
    return [ordered]@{ width = [int]$img.Width; height = [int]$img.Height }
  } finally {
    $img.Dispose()
  }
}

function Invoke-FrameGrab {
  # One PNG at one timestamp. -ss BEFORE -i = input seek (accurate_seek default on):
  # frame exact, cost O(keyframe distance) instead of O(timestamp).
  # -FromEnd > 0 switches to `-sseof -<n>`: "n seconds before the end of the file". Needed because
  # a plain -ss at/after the last frame silently produces nothing (exit code 0, no output file).
  param([string]$Source, [double]$At, [string]$Dest, [int]$ScaleWidth, [double]$FromEnd = 0)
  $ffArgs = New-Object System.Collections.Generic.List[string]
  foreach ($a in @('-hide_banner', '-nostdin', '-loglevel', 'error')) { $ffArgs.Add($a) }
  if ($FromEnd -gt 0) {
    $ffArgs.Add('-sseof')
    $ffArgs.Add('-' + (Format-Seconds $FromEnd))
  } else {
    $ffArgs.Add('-ss')
    $ffArgs.Add((Format-Seconds $At))
  }
  foreach ($a in @('-i', $Source, '-frames:v', '1')) { $ffArgs.Add($a) }
  if ($ScaleWidth -gt 0) {
    $ffArgs.Add('-vf')
    $ffArgs.Add('scale=' + $ScaleWidth + ':-2')
  }
  $ffArgs.Add('-y')
  $ffArgs.Add($Dest)
  return Invoke-Native -Exe $script:FfExe -ArgList $ffArgs.ToArray()
}

function Invoke-FfmpegFile {
  # ffmpeg call that must produce a file: any nonzero exit is a hard error.
  param([string[]]$ArgList, [string]$What)
  $r = Invoke-Native -Exe $script:FfExe -ArgList $ArgList
  if ($r.code -ne 0) {
    throw ($What + ' failed (ffmpeg exit ' + $r.code + '): ' + (Get-FirstLine $r.err))
  }
  return $r
}

# ------------------------------------------------------------------------ actions

function Invoke-Info {
  $srcPath = Get-ExistingFile -Path $In -What '-In'
  $meta = Get-MediaInfo -Path $srcPath
  return [ordered]@{
    ok       = $true
    duration = [double]$meta.duration
    width    = [int]$meta.width
    height   = [int]$meta.height
    fps      = [double]$meta.fps
    bytes    = [int64]$meta.bytes
    # R41: whether the file really carries an audio stream (and which codec). Ordered
    # dictionary, so this lands after bytes in the JSON - the node side reads it by name.
    audio    = [bool]$meta.audio
    acodec   = [string]$meta.acodec
    source   = [string]$meta.source
  }
}

function Invoke-Frame {
  $srcPath = Get-ExistingFile -Path $In -What '-In'
  if ([string]::IsNullOrEmpty($Out)) { throw '-Out required' }
  if ($Time -lt 0) { throw '-Time must be >= 0' }
  $dstPath = [IO.Path]::GetFullPath($Out)
  $dstDir = Split-Path -Parent $dstPath
  if ($dstDir -ne '' -and -not (Test-Path -LiteralPath $dstDir)) {
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  }
  if (Test-Path -LiteralPath $dstPath) { Remove-Item -LiteralPath $dstPath -Force }
  $grab = Invoke-FrameGrab -Source $srcPath -At $Time -Dest $dstPath -ScaleWidth $Width
  if ($grab.code -ne 0) {
    throw ('frame failed (ffmpeg exit ' + $grab.code + '): ' + (Get-FirstLine $grab.err))
  }
  # MEASURED (R33): `-ss <t>` with t at (or past) the last frame exits with code 0 and writes
  # NOTHING. The caller then reports "frame produced no file" -- which reads like a broken
  # recording, while the recording is fine and the timestamp was simply the end of the file.
  # That is exactly what the result panel did: it asked for `duration - 0.05` using WALL-CLOCK
  # seconds, which is often a hair past the file's real end.
  #
  # So: treat "no file" as "that timestamp has no frame", and walk back. `-sseof -0.4` asks for
  # "0.4s before the end", which is the reliable way to name the last decodable frame without
  # knowing the exact duration.
  if (-not (Test-Path -LiteralPath $dstPath)) {
    $back = Invoke-FrameGrab -Source $srcPath -At $Time -Dest $dstPath -ScaleWidth $Width -FromEnd 0.4
    if ($back.code -ne 0) {
      throw ('frame failed (ffmpeg exit ' + $back.code + '): ' + (Get-FirstLine $back.err))
    }
  }
  if (-not (Test-Path -LiteralPath $dstPath)) {
    $first = Invoke-FrameGrab -Source $srcPath -At 0 -Dest $dstPath -ScaleWidth $Width
    if ($first.code -ne 0) {
      throw ('frame failed (ffmpeg exit ' + $first.code + '): ' + (Get-FirstLine $first.err))
    }
  }
  if (-not (Test-Path -LiteralPath $dstPath)) { throw 'frame produced no file' }
  $box = Get-ImageSize -Path $dstPath
  $item = Get-Item -LiteralPath $dstPath
  return [ordered]@{
    ok     = $true
    path   = $dstPath
    width  = [int]$box.width
    height = [int]$box.height
    bytes  = [int64]$item.Length
    t      = [double]$Time
  }
}

function Invoke-Strip {
  # Uniform sample of N small PNGs - the filmstrip the user picks a frame from.
  # Slots are sampled at their MIDPOINT ((i+0.5)*dur/N) so the last grab never
  # lands past the final frame.
  $srcPath = Get-ExistingFile -Path $In -What '-In'
  if ([string]::IsNullOrEmpty($OutDir)) { throw '-OutDir required' }
  $stripDir = [IO.Path]::GetFullPath($OutDir)
  $want = [int]$Count
  if ($want -lt 1) { $want = 1 }
  if ($want -gt 60) { $want = 60 }
  $scaleW = [int]$Width
  if ($scaleW -le 0) { $scaleW = 320 }
  if (-not (Test-Path -LiteralPath $stripDir)) {
    New-Item -ItemType Directory -Force -Path $stripDir | Out-Null
  }
  $meta = Get-MediaInfo -Path $srcPath
  if ([double]$meta.duration -le 0) { throw 'cannot sample: unknown duration' }
  $rows = New-Object System.Collections.Generic.List[object]
  $failed = New-Object System.Collections.Generic.List[string]
  for ($slot = 0; $slot -lt $want; $slot++) {
    $at = [math]::Round((([double]$slot + 0.5) * [double]$meta.duration) / $want, 3)
    $png = Join-Path $stripDir ('f{0:D2}.png' -f $slot)
    if (Test-Path -LiteralPath $png) { Remove-Item -LiteralPath $png -Force }
    $grab = Invoke-FrameGrab -Source $srcPath -At $at -Dest $png -ScaleWidth $scaleW
    if ($grab.code -ne 0 -or -not (Test-Path -LiteralPath $png)) {
      $failed.Add(('slot=' + $slot + ' t=' + (Format-Seconds $at) + ' exit=' + $grab.code + ' ' + (Get-FirstLine $grab.err)))
      continue
    }
    $rows.Add([ordered]@{ t = [double]$at; path = $png })
  }
  if ($failed.Count -gt 0) {
    # Partial filmstrips are reported as failures WITH the frames that did work,
    # so the host never shows "12 frames" when only 11 exist.
    return [ordered]@{
      ok     = $false
      error  = ('strip: ' + $failed.Count + ' of ' + $want + ' frames failed (first: ' + $failed[0] + ')')
      frames = $rows.ToArray()
      count  = $rows.Count
      dir    = $stripDir
    }
  }
  return [ordered]@{
    ok       = $true
    frames   = $rows.ToArray()
    count    = $rows.Count
    dir      = $stripDir
    width    = $scaleW
    duration = [double]$meta.duration
  }
}

function Invoke-Trim {
  # Head/tail trim. Copy first (fast, keyframe aligned); if the copy is missing,
  # empty or off the requested duration by more than -Tolerance, delete it and
  # re-encode. Whatever actually produced the file is what "method" says.
  $srcPath = Get-ExistingFile -Path $In -What '-In'
  if ([string]::IsNullOrEmpty($Out)) { throw '-Out required' }
  if ($Start -lt 0) { throw '-Start must be >= 0' }
  if ($End -le $Start) { throw '-End must be greater than -Start' }
  $dstPath = [IO.Path]::GetFullPath($Out)
  if ($dstPath -eq $srcPath) { throw '-Out must differ from -In' }
  $dstDir = Split-Path -Parent $dstPath
  if ($dstDir -ne '' -and -not (Test-Path -LiteralPath $dstDir)) {
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  }
  $want = [math]::Round($End - $Start, 3)
  $actual = 0.0
  $fallback = ''
  if (Test-Path -LiteralPath $dstPath) { Remove-Item -LiteralPath $dstPath -Force }
  $copyArgs = @(
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', (Format-Seconds $Start), '-i', $srcPath, '-t', (Format-Seconds $want),
    '-c', 'copy', '-movflags', '+faststart', '-y', $dstPath
  )
  $copyRun = Invoke-Native -Exe $script:FfExe -ArgList $copyArgs
  if ($copyRun.code -ne 0) {
    $fallback = ('copy failed (ffmpeg exit ' + $copyRun.code + '): ' + (Get-FirstLine $copyRun.err))
  } elseif (-not (Test-Path -LiteralPath $dstPath)) {
    $fallback = 'copy produced no file'
  } else {
    try { $actual = [double](Get-MediaInfo -Path $dstPath).duration } catch { $actual = 0.0 }
    # Measured on a 3 s / 10 fps gdigrab clip (ffmpeg 9.0.1): -c copy starts exactly
    # on the requested frame, but the TAIL overshoots (2.00 s for a requested 1.50 s,
    # 1.20 s for 1.00 s) because whole packets are copied until the limit is passed.
    # So being late is expected and tolerated proportionally on long clips (0.5 s is
    # invisible in a 5 min recording, and it keeps the fast path useful there), while
    # being early means content was dropped and is held to the strict -Tolerance.
    $lateOk = [math]::Max($Tolerance, $want * 0.02)
    $drift = $actual - $want
    if ($actual -le 0) {
      $fallback = 'copy produced an unreadable file'
    } elseif ($drift -lt (0 - $Tolerance) -or $drift -gt $lateOk) {
      $fallback = ('copy is keyframe aligned: got ' + (Format-Seconds $actual) + 's, wanted ' + (Format-Seconds $want) + 's')
    }
  }
  $method = 'copy'
  if ($fallback -ne '') {
    Write-Log ('re-encoding instead: ' + $fallback)
    $method = 'reencode'
    if (Test-Path -LiteralPath $dstPath) { Remove-Item -LiteralPath $dstPath -Force }
    $encArgs = @(
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-ss', (Format-Seconds $Start), '-i', $srcPath, '-t', (Format-Seconds $want),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', $dstPath
    )
    Invoke-FfmpegFile -ArgList $encArgs -What 'trim(reencode)' | Out-Null
  }
  if (-not (Test-Path -LiteralPath $dstPath)) { throw 'trim produced no file' }
  $after = Get-MediaInfo -Path $dstPath
  $item = Get-Item -LiteralPath $dstPath
  if ([int64]$item.Length -le 0) { throw 'trim produced an empty file' }
  $res = [ordered]@{
    ok        = $true
    path      = $dstPath
    duration  = [double]$after.duration
    bytes     = [int64]$item.Length
    method    = $method
    requested = [double]$want
    start     = [double]$Start
    end       = [double]$End
  }
  if ($fallback -ne '') {
    $res['fallbackFrom'] = 'copy'
    $res['fallbackReason'] = $fallback
  }
  return $res
}

function Invoke-Clip {
  # Put the FILE on the clipboard as CF_HDROP - the same thing Explorer's Copy
  # does, so it pastes into a chat input as an attachment. Then read the clipboard
  # back and compare: "it is on the clipboard" is measured, not assumed.
  $srcPath = Get-ExistingFile -Path $In -What '-In'
  Add-Type -AssemblyName System.Windows.Forms
  $apt = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString()
  if ($apt -ne 'STA') {
    # powershell.exe 5.1 is STA by default; pwsh -MTA would silently no-op here.
    throw ('clipboard requires an STA thread, this one is ' + $apt)
  }
  $col = New-Object System.Collections.Specialized.StringCollection
  [void]$col.Add($srcPath)
  $lastErr = ''
  $written = $false
  for ($try = 0; $try -lt 5 -and -not $written; $try++) {
    try {
      [System.Windows.Forms.Clipboard]::SetFileDropList($col)
      $written = $true
    } catch {
      # another process can hold the clipboard open for a few ms
      $lastErr = $_.Exception.Message
      Start-Sleep -Milliseconds 200
    }
  }
  if (-not $written) { throw ('clipboard write failed: ' + $lastErr) }
  $back = New-Object System.Collections.Generic.List[string]
  try {
    $rd = [System.Windows.Forms.Clipboard]::GetFileDropList()
    foreach ($entry in $rd) { $back.Add([string]$entry) }
  } catch {
    throw ('clipboard read-back failed: ' + $_.Exception.Message)
  }
  $hit = $false
  foreach ($entry in $back) {
    if ([string]::Equals($entry, $srcPath, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true }
  }
  if (-not $hit) {
    throw ('clipboard read-back mismatch: wanted ' + $srcPath + ' got [' + ($back -join '; ') + ']')
  }
  $item = Get-Item -LiteralPath $srcPath
  return [ordered]@{
    ok        = $true
    path      = $srcPath
    bytes     = [int64]$item.Length
    sta       = $apt
    verified  = $true
    clipboard = $back.ToArray()
  }
}

function Get-AssocOpenCommand {
  # "exe + args with %1" for a file, the way Explorer resolves it: the per-user
  # FileExts UserChoice first, the HKCR default after. Returns '' when nothing is
  # registered. Only used as the FALLBACK for open.
  param([string]$Path)
  $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($ext -eq '') { return '' }
  $progId = ''
  try {
    $choice = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext + '\UserChoice') -ErrorAction SilentlyContinue
    if ($choice -ne $null -and $choice.ProgId) { $progId = [string]$choice.ProgId }
  } catch { $progId = '' }
  if ($progId -eq '') {
    try {
      $root = Get-ItemProperty ('Registry::HKEY_CLASSES_ROOT\' + $ext) -ErrorAction SilentlyContinue
      if ($root -ne $null -and $root.'(default)') { $progId = [string]$root.'(default)' }
    } catch { $progId = '' }
  }
  if ($progId -eq '') { return '' }
  try {
    $cmdKey = Get-ItemProperty ('Registry::HKEY_CLASSES_ROOT\' + $progId + '\shell\open\command') -ErrorAction SilentlyContinue
    if ($cmdKey -eq $null) { return '' }
    return ([string]$cmdKey.'(default)').Trim()
  } catch {
    return ''
  }
}

function Invoke-Open {
  # System default player, non-blocking. $PID is a read-only automatic variable,
  # hence $procId.
  #
  # Why a second mechanism: ShellExecute (Start-Process on the FILE, which is what
  # honours the user's per-extension choice) is denied under the DSH file sandbox -
  # "This command cannot be run due to the error: Access is denied" - while starting
  # an EXE directly is allowed. So when the shell route throws, the registered
  # handler is resolved from the registry and started as a plain process instead.
  # "via" says which route actually launched it.
  $srcPath = Get-ExistingFile -Path $In -What '-In'
  $via = 'shellexecute'
  $shellErr = ''
  $procId = 0
  try {
    $proc = Start-Process -FilePath $srcPath -PassThru
    if ($proc -ne $null) { $procId = [int]$proc.Id }
  } catch {
    $shellErr = $_.Exception.Message
    $via = ''
  }
  if ($via -eq '') {
    $openCmd = Get-AssocOpenCommand -Path $srcPath
    if ($openCmd -eq '') {
      throw ('open failed: ' + $shellErr + ' (and no registered handler for ' + [IO.Path]::GetExtension($srcPath) + ')')
    }
    $exePath = ''
    $rest = ''
    if ($openCmd -match '^\s*"([^"]+)"') {
      $exePath = $Matches[1]
      $rest = $openCmd.Substring($Matches[0].Length).Trim()
    } elseif ($openCmd -match '^\s*(\S+)') {
      $exePath = $Matches[1]
      $rest = $openCmd.Substring($Matches[0].Length).Trim()
    }
    if ($exePath -eq '' -or -not (Test-Path -LiteralPath $exePath)) {
      throw ('open failed: ' + $shellErr + ' (handler not found in "' + $openCmd + '")')
    }
    $argsText = $rest.Replace('%1', $srcPath).Replace('%L', $srcPath).Replace('%*', $srcPath)
    if ($argsText -eq $rest) { $argsText = (('"' + $srcPath + '"') + ' ' + $rest).Trim() }
    $proc2 = Start-Process -FilePath $exePath -ArgumentList $argsText -PassThru
    if ($proc2 -ne $null) { $procId = [int]$proc2.Id }
    $via = 'association'
    Write-Log ('ShellExecute denied, launched the registered handler directly: ' + $exePath)
  }
  return [ordered]@{ ok = $true; path = $srcPath; pid = $procId; via = $via }
}

function Test-DirWritable {
  # Creating a directory and writing a file inside it are DIFFERENT permissions in
  # this sandbox: <MyPictures>\DSH<U+622A><U+56FE> can be created while every file write in it
  # fails with UnauthorizedAccessException (measured 2026-10-16). So the probe is a
  # real file, created and removed - never Test-Path on the directory.
  param([string]$DirPath)
  $probe = Join-Path $DirPath ('.dsh-rec-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp')
  try {
    [IO.File]::WriteAllText($probe, 'probe')
    Remove-Item -LiteralPath $probe -Force
    return ''
  } catch {
    return ($_.Exception.GetType().Name + ': ' + $_.Exception.Message)
  }
}

function Invoke-Keep {
  # Move the recording into the user's picture folder. The candidate list is tried
  # in order and each one must pass a real write probe; the last candidate is the
  # plugin cache, which is where a sandboxed host can always write (lib/shot.mjs#save
  # walks the same order for the same reason). "The user said keep it" must not fail
  # because of where the file is allowed to live - but it must SAY where it landed.
  $srcPath = Get-ExistingFile -Path $In -What '-In'
  $ext = [IO.Path]::GetExtension($srcPath)
  if ([string]::IsNullOrEmpty($ext)) { $ext = '.mp4' }
  $base = ''
  if (-not [string]::IsNullOrEmpty($Name)) {
    $base = ([regex]::Replace($Name, '[\\/:*?"<>|]', '_')).Trim()
    $base = [regex]::Replace($base, '\.(mp4|mkv|mov|webm|avi)$', '', 'IgnoreCase')
    if ($base.Length -gt 60) { $base = $base.Substring(0, 60) }
  }
  if ([string]::IsNullOrEmpty($base)) {
    $base = 'rec-' + (Get-Date).ToString('yyyyMMdd-HHmmss')
  }
  $picRoot = [Environment]::GetFolderPath('MyPictures')
  # The picture folder name is CJK. It is built from code points instead of being
  # typed here because this file must stay pure ASCII: Windows PowerShell 5.1 reads
  # a BOM-less .ps1 as ANSI/GBK, so a UTF-8 CJK literal would come out as mojibake
  # and the recording would land in a garbage directory.
  # U+622A U+56FE = the same "DSH screenshots" folder lib/shot.mjs#save() uses.
  $shotDirName = [string][char]0x622A + [string][char]0x56FE
  $primary = ''
  if (-not [string]::IsNullOrEmpty($picRoot)) { $primary = Join-Path $picRoot ('DSH' + $shotDirName) }
  $cands = New-Object System.Collections.Generic.List[string]
  if ($primary -ne '') { $cands.Add($primary) }
  $cands.Add((Join-Path $script:CacheRoot 'keep'))
  $destDir = ''
  $why = ''
  foreach ($cand in $cands) {
    $stepErr = ''
    try {
      New-Item -ItemType Directory -Force -Path $cand | Out-Null
    } catch {
      $stepErr = ('mkdir: ' + $_.Exception.Message)
    }
    if ($stepErr -eq '') { $stepErr = Test-DirWritable -DirPath $cand }
    if ($stepErr -eq '') {
      $destDir = $cand
      break
    }
    $why = ($cand + ' -> ' + $stepErr)
    Write-Log ('keep candidate rejected: ' + $why)
  }
  if ($destDir -eq '') { throw ('cannot find a writable keep dir (last tried: ' + $why + ')') }
  $destPath = Join-Path $destDir ($base + $ext)
  $n = 1
  while (Test-Path -LiteralPath $destPath) {
    $destPath = Join-Path $destDir ($base + '-' + $n + $ext)
    $n++
  }
  try {
    Move-Item -LiteralPath $srcPath -Destination $destPath
  } catch {
    throw ('keep: move failed (' + $srcPath + ' -> ' + $destPath + '): ' + $_.Exception.Message)
  }
  if (-not (Test-Path -LiteralPath $destPath)) { throw ('keep: file did not arrive at ' + $destPath) }
  $item = Get-Item -LiteralPath $destPath
  $res = [ordered]@{
    ok       = $true
    path     = $destPath
    bytes    = [int64]$item.Length
    dir      = $destDir
    fallback = [bool]($destDir -ne $primary)
  }
  if ($res['fallback']) {
    $res['fallbackReason'] = ('not writable: ' + $why)
    Write-Log ('kept into the plugin cache instead of the picture folder: ' + $destPath)
  }
  return $res
}

function Test-UnderDir {
  # Boundary aware on purpose: "C:\cache-evil\x.mp4" must NOT pass as living under
  # "C:\cache". A bare StartsWith on strings is the classic way to lose a guard.
  param([string]$Child, [string]$Parent)
  if ([string]::IsNullOrEmpty($Parent)) { return $false }
  $kid = [IO.Path]::GetFullPath($Child).TrimEnd('\')
  $root = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if ($kid -eq $root) { return $false }
  return $kid.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Discard {
  $srcPath = Get-ExistingFile -Path $In -What '-In'
  $allowed = New-Object System.Collections.Generic.List[string]
  $allowed.Add($script:CacheRoot)
  foreach ($tmp in @([IO.Path]::GetTempPath(), $env:TEMP, $env:TMP)) {
    if (-not [string]::IsNullOrEmpty($tmp)) { $allowed.Add([string]$tmp) }
  }
  $mayDelete = $false
  foreach ($root in $allowed) {
    if (Test-UnderDir -Child $srcPath -Parent $root) { $mayDelete = $true; break }
  }
  if (-not $mayDelete) {
    Write-Log ('refusing to delete ' + $srcPath + ' - not under: ' + ($allowed -join ' | '))
    throw 'refuse: outside cache dir'
  }
  Remove-Item -LiteralPath $srcPath -Force
  if (Test-Path -LiteralPath $srcPath) { throw ('discard failed, file still present: ' + $srcPath) }
  return [ordered]@{ ok = $true; deleted = $true; path = $srcPath; cacheDir = $script:CacheRoot }
}

# ----------------------------------------------------------------------- dispatch

# ffmpeg / ffprobe resolution. findFfmpeg()'s two candidates first, $env:PATH after,
# mise shims skipped, -Ffmpeg wins outright.
$script:FfExe = Resolve-Tool -Override $Ffmpeg -ExeName 'ffmpeg.exe'
$script:ProbeExe = ''
if ($Ffmpeg -ne '') {
  $sibDir = Split-Path -Parent $Ffmpeg
  if (-not [string]::IsNullOrEmpty($sibDir)) {
    $sibProbe = Join-Path $sibDir 'ffprobe.exe'
    if (Test-Path -LiteralPath $sibProbe) { $script:ProbeExe = $sibProbe }
  }
}
if ($script:ProbeExe -eq '') { $script:ProbeExe = Resolve-Tool -Override '' -ExeName 'ffprobe.exe' }

$payload = $null
try {
  # Only the actions that actually shell out to ffmpeg pay for the version probes
  # (two of them cost ~0.7 s, which is very visible on clip/keep - the "copy this
  # recording" flow the user waits on).
  if (@('info', 'frame', 'strip', 'trim') -contains $Action) {
    $ffCheck = Test-Tool -Exe $script:FfExe -Tag 'ffmpeg version'
    if (-not $ffCheck.ok) { throw ('ffmpeg unusable: ' + $ffCheck.error) }
    Write-Log ('ffmpeg: ' + $script:FfExe)
    Write-Log ('version: ' + $ffCheck.version)
    if ($script:ProbeExe -ne '') {
      $prCheck = Test-Tool -Exe $script:ProbeExe -Tag 'ffprobe version'
      if ($prCheck.ok) {
        Write-Log ('ffprobe: ' + $script:ProbeExe)
      } else {
        Write-Log ('ffprobe unusable, falling back to "ffmpeg -i": ' + $prCheck.error)
        $script:ProbeExe = ''
      }
    } else {
      Write-Log 'no ffprobe found, falling back to "ffmpeg -i"'
    }
  }
  switch ($Action) {
    'info'    { $payload = Invoke-Info }
    'frame'   { $payload = Invoke-Frame }
    'strip'   { $payload = Invoke-Strip }
    'trim'    { $payload = Invoke-Trim }
    'clip'    { $payload = Invoke-Clip }
    'open'    { $payload = Invoke-Open }
    'keep'    { $payload = Invoke-Keep }
    'discard' { $payload = Invoke-Discard }
    default   { throw 'unknown action' }
  }
} catch {
  $payload = [ordered]@{ ok = $false; error = $_.Exception.Message }
}

if ($script:FfExe -ne '' -and -not $payload.Contains('ffmpeg')) {
  $payload['ffmpeg'] = [string]$script:FfExe
}

$jsonText = $payload | ConvertTo-Json -Depth 8 -Compress

if (-not [string]::IsNullOrEmpty($OutJson)) {
  try {
    $jsonPath = [IO.Path]::GetFullPath($OutJson)
    $jsonDir = Split-Path -Parent $jsonPath
    if ($jsonDir -ne '' -and -not (Test-Path -LiteralPath $jsonDir)) {
      New-Item -ItemType Directory -Force -Path $jsonDir | Out-Null
    }
    [IO.File]::WriteAllText($jsonPath, $jsonText, [System.Text.UTF8Encoding]::new($false))
  } catch {
    Write-Log ('OutJson write failed: ' + $_.Exception.Message)
    $payload['outJsonError'] = $_.Exception.Message
    $jsonText = $payload | ConvertTo-Json -Depth 8 -Compress
  }
}

[Console]::Out.WriteLine($jsonText)
[Console]::Out.Flush()
if ($payload['ok'] -eq $true) { exit 0 }
exit 1
