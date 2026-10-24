# recspawn.ps1 - start ffmpeg on node's behalf, then stop it the ONLY way that keeps
# the mp4 playable: write "q" into its stdin.
#
# Why this file exists
# --------------------
# shot.mjs normally spawns ffmpeg straight from node (stdin pipe + stderr pipe). In a
# restricted environment the DSH file sandbox denies CreatePipe for node's spawn, so
# that call dies with EPERM before ffmpeg ever starts. .NET's pipes are NOT affected
# (measured), so this wrapper opens the stdin pipe itself and writes the "q" when the
# host drops a signal file.
#
# Why "q" and not just killing the process: a hard kill leaves a plain mp4 whose moov
# atom was never written -> "moov atom not found", the whole recording is lost
# (measured: 262 KB of H.264 with no index is unplayable). "q" is the graceful stop.
#
# ASCII ONLY: the console here is GBK, and Windows PowerShell 5.1 reads a BOM-less
# .ps1 as GBK -- a single Chinese comment then eats the NEXT line of code and the
# script silently parses ZERO arguments (this file shipped that bug once; the check is
#   grep -cP '[\x80-\xFF]' recspawn.ps1   ->  must be 0
# ). Keep every byte below 0x80, and test with BOTH pwsh 7 and powershell.exe 5.1.
#
#   pwsh -File recspawn.ps1 -Exe <ffmpeg.exe> -ArgsFile <utf8 json array> -Quit <flag file>
#
# stdout/stderr are NOT redirected here on purpose: ffmpeg inherits whatever the caller
# gave this process, so the host can point them at real files and read the log later
# (a redirected stderr pipe would fill up and freeze ffmpeg).

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$ArgsFile,
  [Parameter(Mandatory = $true)][string]$Quit,
  # R54: optional. When given, this wrapper writes {"pid":<ffmpeg pid>} here as soon as ffmpeg is
  # started. The host cannot learn that pid any other way -- child.pid on this path is THIS
  # PowerShell process, and the orphan reaper must know the real ffmpeg to protect it.
  [string]$PidFile = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Exe)) {
  Write-Error ("ffmpeg not found: " + $Exe)
  exit 3
}
if (-not (Test-Path -LiteralPath $ArgsFile)) {
  Write-Error ("args file not found: " + $ArgsFile)
  exit 3
}

$argv = @()
# Read with .NET, not Get-Content: UTF8Encoding($false) never writes a BOM and ReadAllText
# strips one that is already there. Both matter, because the BOM is the nastiest trap on
# this path: ConvertFrom-Json does NOT throw on a leading U+FEFF, it just turns the whole
# JSON text into ONE string -- so ffmpeg receives the entire JSON line as its first
# argument, prints "Unrecognized option" and dies. The caller sees "it started" while the
# recording is empty. A silent wrong answer is worse than an error, hence three gates:
# strip the BOM -> must be a JSON array -> every element must be a string.
$raw = ''
try {
  $raw = [System.IO.File]::ReadAllText($ArgsFile, (New-Object System.Text.UTF8Encoding($false)))
} catch {
  [Console]::Error.WriteLine('recspawn: cannot read args file: ' + $_.Exception.Message)
  exit 3
}
if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
$raw = $raw.Trim()
if (-not $raw.StartsWith('[')) {
  [Console]::Error.WriteLine('recspawn: args file is not a JSON array (must start with [)')
  exit 3
}
$parsed = $null
try {
  $parsed = ConvertFrom-Json -InputObject $raw
} catch {
  [Console]::Error.WriteLine('recspawn: cannot parse args file: ' + $_.Exception.Message)
  exit 3
}
# A one-element array can be unrolled into a scalar by ConvertFrom-Json, so wrap it in @()
# before trusting the count. NOTE: this line must stay valid under Windows PowerShell 5.1
# too - see the ASCII-ONLY rule below, which this file once broke.
$argv = @($parsed)
if ($argv.Count -eq 0) {
  [Console]::Error.WriteLine('recspawn: args file is an empty array')
  exit 3
}
$bad = 0
foreach ($item in $argv) { if (-not ($item -is [string])) { $bad++ } }
if ($bad -gt 0) {
  [Console]::Error.WriteLine(('recspawn: args file has {0} non-string element(s); ffmpeg args must all be strings' -f $bad))
  exit 3
}
# Leave a trace of WHAT was parsed (stdout and stderr are the same file inside the host).
[Console]::Error.WriteLine(('recspawn: {0} args for {1}' -f $argv.Count, $Exe))

# One argv element -> one command-line token, quoted per the standard Windows rules
# (backslashes that precede a quote must be doubled; a trailing run of backslashes too).
function ConvertTo-ArgToken([string]$a) {
  if ($null -eq $a) { return '""' }
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $s = $a -replace '(\\*)"', '$1$1\"'
  $s = $s -replace '(\\+)$', '$1$1'
  return '"' + $s + '"'
}

$line = ($argv | ForEach-Object { ConvertTo-ArgToken ([string]$_) }) -join ' '

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.Arguments = $line
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError = $false

$proc = [System.Diagnostics.Process]::Start($psi)
if ($null -eq $proc) {
  Write-Error 'failed to start ffmpeg'
  exit 3
}

# R54: tell the host which pid to protect. Written immediately -- the host polls for this file
# (60 ms steps, 6 s budget) and stores the pid in rec/current.json, which is the only thing the
# orphan reaper can see. Without it a host crash during this path leaves an ffmpeg that keeps
# gdigrab-ing forever. The file is removed by the host after reading.
if ($PidFile -ne '') {
  try {
    $json = '{"pid":' + $proc.Id + '}'
    [System.IO.File]::WriteAllText($PidFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    [Console]::Error.WriteLine('recspawn: cannot write pid file: ' + $_.Exception.Message)
  }
}

# Poll for the quit flag. ffmpeg must keep running until then, so this loop owns the
# process lifetime; the host can also just kill us (the mp4 is then lost, which is why
# the host always tries the flag first).
try { Remove-Item -LiteralPath $Quit -Force -ErrorAction SilentlyContinue } catch {}

while (-not $proc.HasExited) {
  if (Test-Path -LiteralPath $Quit) { break }
  Start-Sleep -Milliseconds 120
}

if (-not $proc.HasExited) {
  try {
    $proc.StandardInput.Write('q')
    $proc.StandardInput.Flush()
  } catch {
    # stdin already gone: nothing graceful left to try.
  }
  if (-not $proc.WaitForExit(8000)) {
    try { $proc.Kill() } catch {}
    Write-Error 'ffmpeg did not exit after q'
    exit 4
  }
}

exit $proc.ExitCode
