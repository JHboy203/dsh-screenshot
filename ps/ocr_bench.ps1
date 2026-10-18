# dsh-screenshot - offline OCR benchmark harness (synthetic truth + real screenshot regions).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ps/ocr_bench.ps1
#       [-Out <dir>] [-Ocr <script>] [-Variants a,b,c] [-Filter <regex>] [-Kind syn|real|all]
#       [-NoRender] [-Image <png>] [-Capture] [-Repeat n] [-Show <variant>] [-List] [-Json] [-Quiet]
#
# WHY THIS EXISTS
#   "Extract text" has to get measurably better, not merely different. This harness renders
#   screenshots whose exact text is known, OCRs them through the REAL production CLI (a child
#   powershell.exe running ps/ocr_region.ps1 -Json, exactly what lib/shot.mjs#ocr spawns), and
#   reports CER / exact-match / token-hit-rate per image and per variant, plus a JSON report.
#
# METRICS
#   cer     Levenshtein(truth, got) / len(truth); both sides are WHITESPACE-STRIPPED first, so a
#           different line/word split is not punished - only wrong characters are. Counted in
#           UTF-16 code units (BMP only here, so that equals Unicode code points). 0 == perfect.
#   exact   1 when the whitespace-stripped OCR text equals the truth exactly.
#   tok     real set only: fraction of expected substrings found in the whitespace-stripped text.
#           That is what proves a 2-char UI label came back AS that label instead of as two of its
#           radicals - the failure mode this benchmark exists to catch.
#   eq      per case, the normalized text hash. Two variants whose hashes agree on EVERY case are
#           reported as indistinguishable - that is the evidence for "this knob does nothing".
#
# WHY THE TRUTH IS CODE-POINT ARRAYS
#   This file must stay pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code
#   page (see the note in capture.ps1) and this console is GBK, so Chinese literals would be
#   mangled before they ever reach the renderer. Every string below was generated from a real
#   literal at authoring time (never typed from memory), same trick as ocr_selftest.ps1.
#
# WHAT THE SYNTHETIC SET COVERS
#   12 images: 11/13/16/20 px text, light (#ffffff) and dark (#1e1e1e) themes, Microsoft YaHei /
#   SimSun / Consolas, plus one mixed-font image (CJK in YaHei, Latin in Consolas inside the same
#   line, the way a real editor renders it). Light images are drawn with ClearType sub-pixel AA
#   and dark ones with grey AA, which is what those themes actually look like on screen.
#   The 11 px light/dark pair (S01/S02) is the case this benchmark exists for.
#
# THE REAL SET
#   Four regions of one pinned capture of the DSH window (ps/capture.ps1 -Json), with known
#   labels: sidebar buttons, the conversation list (11 px grey timestamps included), the chat
#   header tabs and the composer row. The fixture is PINNED on purpose - the truth only describes
#   that one capture. -Capture refreshes the fixture from the live screen and will invalidate the
#   expected substrings, so re-check them by eye whenever you use it.
#
# RUNNING NOTES
#   * Idempotent: renders are rewritten under <Out>\renders, reports are stamped and appended,
#     nothing else on disk is touched.
#   * Writes only under <Out> (default <workspace>\.tmp-shot-lab\ocr, env DSH_OCR_LAB wins); if
#     that is not writable it falls back to %TEMP%\dsh-ocr-lab.
#   * Cost: one child powershell + one OCR call per case/variant, ~0.6-1.2 s each. Use -Variants
#     and -Filter to iterate on a subset.
#   * [Console]::OutputEncoding is forced to UTF-8 for the same reason ocr_selftest.ps1 does it:
#     the child writes UTF-8 JSON and this parent would otherwise decode it in CP936 -> mojibake.

param(
  [string]$Out = '',
  [string]$Ocr = '',
  [string]$Variants = '',
  [string]$Filter = '',
  [ValidateSet('all', 'syn', 'real')][string]$Kind = 'all',
  [switch]$NoRender,
  [string]$Image = '',
  [switch]$Capture,
  [int]$Repeat = 1,
  [string]$Show = '',
  [switch]$List,
  [switch]$Json,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# ---------------------------------------------------------------- helpers ----

# NOT named "CP": PowerShell's alias "cp" (Copy-Item) wins over a function of that name, and the
# first run died with "Cannot find path ...\32487" - the code point list was taken as a path.
function CPText([int[]]$cp) { return (-join ($cp | ForEach-Object { [char]$_ })) }

# Same idea, packed four hex digits per character. Used for the long fixtures below, where the
# CPText @(0x00xx,...) form costs 7 characters per code point instead of 4.
function UH([string]$hex) {
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i + 4 -le $hex.Length; $i += 4) {
    [void]$sb.Append([char][Convert]::ToInt32($hex.Substring($i, 4), 16))
  }
  return $sb.ToString()
}

function Get-Norm([string]$s) {
  if ($null -eq $s) { return '' }
  return ($s -replace '\s+', '')
}

function Test-CjkCp([int]$cp) {
  return (($cp -ge 0x2E80 -and $cp -le 0x303F) -or
          ($cp -ge 0x3040 -and $cp -le 0x33FF) -or
          ($cp -ge 0x3400 -and $cp -le 0x4DBF) -or
          ($cp -ge 0x4E00 -and $cp -le 0x9FFF) -or
          ($cp -ge 0xF900 -and $cp -le 0xFAFF) -or
          ($cp -ge 0xFE30 -and $cp -le 0xFE4F) -or
          ($cp -ge 0xFF00 -and $cp -le 0xFFEF))
}

function Get-Levenshtein([int[]]$a, [int[]]$b) {
  $n = $a.Length
  $m = $b.Length
  if ($n -eq 0) { return $m }
  if ($m -eq 0) { return $n }
  $prev = New-Object int[] ($m + 1)
  $cur = New-Object int[] ($m + 1)
  for ($j = 0; $j -le $m; $j++) { $prev[$j] = $j }
  for ($i = 1; $i -le $n; $i++) {
    $cur[0] = $i
    $ai = $a[$i - 1]
    for ($j = 1; $j -le $m; $j++) {
      $cost = 1
      if ($ai -eq $b[$j - 1]) { $cost = 0 }
      $d = $prev[$j] + 1
      if (($cur[$j - 1] + 1) -lt $d) { $d = $cur[$j - 1] + 1 }
      if (($prev[$j - 1] + $cost) -lt $d) { $d = $prev[$j - 1] + $cost }
      $cur[$j] = $d
    }
    $swap = $prev; $prev = $cur; $cur = $swap
  }
  return $prev[$m]
}

function Get-Cer([string]$truth, [string]$got) {
  $t = Get-Norm $truth
  $g = Get-Norm $got
  if ($t.Length -eq 0) { if ($g.Length -eq 0) { return 0.0 } else { return 1.0 } }
  $d = Get-Levenshtein ([int[]][char[]]$t) ([int[]][char[]]$g)
  return ([double]$d / [double]$t.Length)
}

function Get-TextHash([string]$s) {
  $sha = [System.Security.Cryptography.SHA1]::Create()
  try {
    $bytes = $sha.ComputeHash($Utf8NoBom.GetBytes($s))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
  } finally { $sha.Dispose() }
}

function Split-TextRuns([string]$s, [bool]$split) {
  if ((-not $split) -or $s.Length -eq 0) {
    return @([pscustomobject]@{ text = $s; latin = $false })
  }
  $out = @()
  $cur = ''
  $curLatin = -not (Test-CjkCp ([int][char]$s[0]))
  foreach ($ch in $s.ToCharArray()) {
    if ($ch -eq ' ') { $cur += $ch; continue }
    $isLatin = -not (Test-CjkCp ([int]$ch))
    if ($isLatin -eq $curLatin) { $cur += $ch }
    else {
      if ($cur -ne '') { $out += [pscustomobject]@{ text = $cur; latin = $curLatin } }
      $cur = [string]$ch
      $curLatin = $isLatin
    }
  }
  if ($cur -ne '') { $out += [pscustomobject]@{ text = $cur; latin = $curLatin } }
  return $out
}

# ------------------------------------------------------------- test data ----

# ---- generated code points (regenerate from the plain literals, never retype) ----
$p01 = CPText @(0x7EE7,0x7EED,0x4F18,0x5316,0x63D0,0x53D6,0x6587,0x5B57,0x529F,0x80FD)
$p02 = CPText @(0x8FD8,0x662F,0x6709,0x4E9B,0x4E0D,0x51C6)
$p03 = CPText @(0x8BC6,0x522B,0x8BED,0x8A00,0x0020,0x7B80,0x4F53,0x4E2D,0x6587)
$p04 = CPText @(0x63D2,0x4EF6,0x0020,0x004D,0x0043,0x0020,0x6A21,0x578B,0x6E32,0x67D3)
$p05 = CPText @(0x65B0,0x4F1A,0x8BDD,0x0020,0x5DE5,0x4F5C,0x533A,0x0020,0x7B80,0x4ECB)
$p06 = CPText @(0x622A,0x56FE,0x0020,0x6846,0x9009,0x0020,0x6807,0x6CE8,0x0020,0x63D0,0x53D6,
  0x6587,0x5B57)
$p07 = CPText @(0x0044,0x0053,0x0048,0x0020,0x0073,0x0063,0x0072,0x0065,0x0065,0x006E,0x0073,
  0x0068,0x006F,0x0074,0x0020,0x004F,0x0043,0x0052,0x0020,0x0070,0x006C,0x0075,0x0067,0x0069,
  0x006E)
$p08 = CPText @(0x0032,0x0030,0x0032,0x0036,0x002D,0x0031,0x0030,0x002D,0x0031,0x0036,0x0020,
  0x0075,0x0070,0x0073,0x0063,0x0061,0x006C,0x0065,0x003D,0x0033,0x0020,0x0070,0x0072,0x0065,
  0x0070,0x0072,0x006F,0x0063,0x0065,0x0073,0x0073,0x003D,0x006E,0x006F,0x006E,0x0065)
$p09 = CPText @(0x007A,0x0068,0x002D,0x0048,0x0061,0x006E,0x0073,0x002D,0x0043,0x004E,0x0020,
  0x006A,0x0061,0x0020,0x006B,0x006F,0x0020,0x0065,0x006E)
$p10 = CPText @(0x672C,0x5730,0x79BB,0x7EBF,0x8BC6,0x522B,0x0020,0x4E0D,0x51FA,0x672C,0x673A)
$p11 = CPText @(0x8BBE,0x7F6E,0x0020,0x5173,0x4E8E,0x0020,0x5FEB,0x6377,0x952E,0x0020,0x66F4,
  0x65B0,0x65E5,0x5FD7)
$p12 = CPText @(0x672A,0x8BFB,0x6D88,0x606F,0x0033,0x6761,0x0020,0x5F85,0x5904,0x7406)
$p13 = CPText @(0x0069,0x006E,0x0064,0x0065,0x0078,0x002E,0x006A,0x0073,0x0020,0x006F,0x0063,
  0x0072,0x005F,0x0072,0x0065,0x0067,0x0069,0x006F,0x006E,0x002E,0x0070,0x0073,0x0031,0x0020,
  0x0073,0x0068,0x006F,0x0074,0x002E,0x006D,0x006A,0x0073)
$p14 = CPText @(0x004D,0x0043,0x0020,0x6A21,0x578B,0x6E32,0x67D3,0x0020,0x8D34,0x56FE,0x0020,
  0x5F55,0x5C4F)
$p15 = CPText @(0x6587,0x4EF6,0x0020,0x7F16,0x8F91,0x0020,0x89C6,0x56FE,0x0020,0x5E2E,0x52A9)
$p16 = CPText @(0x0031,0x8F6E,0x0020,0x0031,0x0035,0x0034,0x6B65,0x0020,0x0032,0x0030,0x0033,
  0x0020,0x0074,0x006F,0x006B,0x002F,0x0073)
# real-set expected tokens (substring membership tests)
$R1 = @(
  CPText @(0x65B0,0x4F1A,0x8BDD)
  CPText @(0x63D2,0x4EF6)
  CPText @(0x004D,0x0043,0x6A21,0x578B,0x6E32,0x67D3)
)
$R2 = @(
  CPText @(0x0054,0x004B,0x0053,0x540E,0x53F0,0x0031,0x0036)
  CPText @(0x0054,0x004B,0x0053,0x540E,0x53F0,0x0031,0x0035)
  CPText @(0x9006,0x5411,0x5DE5,0x7A0B,0x62C6,0x89E3)
  CPText @(0x5C55,0x5F00,0x5176,0x4F59)
  CPText @(0x0041,0x0049,0x5DE5,0x4F5C,0x533A)
  CPText @(0x0044,0x0053,0x0048,0x63D2,0x4EF6,0x7814,0x7A76,0x0036)
  CPText @(0x0056,0x0065,0x0078,0x4EA4,0x63A5,0x6587,0x6863,0x95EE,0x9898,0x4FEE,0x590D)
  CPText @(0x0044,0x0053,0x0048,0x63D2,0x4EF6,0x7814,0x7A76,0x0035)
  CPText @(0x0031,0x0037,0x5C0F,0x65F6)
  CPText @(0x0032,0x0031,0x5C0F,0x65F6)
  CPText @(0x0031,0x0031,0x5206,0x949F)
  CPText @(0x0033,0x0033,0x5206,0x949F)
  CPText @(0x0034,0x0039,0x5206,0x949F)
)
$R3 = @(
  CPText @(0x53D1,0x6D88,0x606F,0x6216,0x521B,0x5EFA,0x4EFB,0x52A1)
  CPText @(0x8C03,0x7528,0x6307,0x4EE4)
  CPText @(0x6587,0x4EF6,0x6216,0x5BF9,0x8BDD)
  CPText @(0x5DE5,0x4F5C,0x533A,0x5185,0x4FEE,0x6539)
  CPText @(0x8BC6,0x56FE)
  CPText @(0x0044,0x0065,0x0065,0x0070,0x0053,0x0065,0x0065,0x006B,0x002D,0x0056,0x0034,0x0031,
    0x002D,0x0046,0x006C,0x0061,0x0073,0x0068)
  CPText @(0x004D,0x0061,0x0078)
)
$R4 = @(
  CPText @(0x0056,0x0065,0x0078,0x4EA4,0x63A5,0x6587,0x6863,0x95EE,0x9898,0x4FEE,0x590D)
  CPText @(0x5B50,0x667A,0x80FD,0x4F53)
  CPText @(0x521B,0x9020,0x6A21,0x5F0F)
  CPText @(0x5BF9,0x8BDD)
  CPText @(0x8F68,0x8FF9)
  CPText @(0x7528,0x91CF,0x4E0E,0x6D88,0x8017)
)
# hand transcription of the two clean real regions (icons excluded by the crop)
$RT1 = CPText @(0x65B0,0x4F1A,0x8BDD,0x63D2,0x4EF6,0x004D,0x0043,0x6A21,0x578B,0x6E32,0x67D3)
$RT2 = CPText @(0x0054,0x004B,0x0053,0x540E,0x53F0,0x0031,0x0036,0x0031,0x0037,0x5C0F,0x65F6,
  0x0054,0x004B,0x0053,0x540E,0x53F0,0x0031,0x0035,0x0031,0x5929,0x9006,0x5411,0x5DE5,0x7A0B,
  0x62C6,0x89E3,0x0032,0x0031,0x5C0F,0x65F6,0x5C55,0x5F00,0x5176,0x4F59,0x0033,0x0033,0x4E2A,
  0x4F1A,0x8BDD,0x0041,0x0049,0x5DE5,0x4F5C,0x533A,0x0044,0x0053,0x0048,0x63D2,0x4EF6,0x7814,
  0x7A76,0x0036,0x0031,0x0031,0x5206,0x949F,0x0056,0x0065,0x0078,0x4EA4,0x63A5,0x6587,0x6863,
  0x95EE,0x9898,0x4FEE,0x590D,0x0033,0x0033,0x5206,0x949F,0x0044,0x0053,0x0048,0x63D2,0x4EF6,
  0x7814,0x7A76,0x0035,0x0034,0x0039,0x5206,0x949F)

# --- cases added when the real set grew past the DSH window (whitespace pre-stripped: CER
#     normalises both sides anyway, so storing the stripped form is exactly equivalent and
#     keeps this block readable). K* = regions of real/dsh-real.png, W* = real/web.png, a
#     browser-rendered fixture so the truth can be exact while the rasteriser is Chromium's.
  $K1 = UH '00740068006500640069007300700061007400630068006800610073006E006F0073007500630068006200720061006E00630068002E004C00650074006D00650066006900780074006800650070006C007500670069006E003A'
  $K2 = UH '4F46662F592790E852064EBA8D7052308FD94E006B655C3153EA80FD91CD88C57CFB7EDF'
  $K3 = UH '4EFB52A100345DF25B8C621000B700318FDB884C4E2D00B700315F8559047406'
  $KT1 = UH '004100495DE54F5C533A00B70032003000320036002D00310030002D0031003600B796058BFB00335206949F628A622A56FE91CC768465875B5763D051FA6765FF0C7B2C4E006B654E0D662F8C0353C26570FF0C800C662F514867094E00628A5C3A5B5030026CA16709771F503C76844F18531653EA662F63624E864E0079CD95196CD5FF0C770B8D7767656BCF6B2190FD4E0D4E006837FF0C51765B9E6CA1670953D8597D3002005400680065006D006500610073007500720065006400730065007400680061007300740077006F00680061006C007600650073003A00730079006E0074006800650074006900630069006D006100670065007300770068006F0073006500650078006100630074007400650078007400690073006B006E006F0077006E002C0061006E0064007200650061006C00730063007200650065006E00730068006F00740073007700690074006800680061006E0064002D0063006800650063006B006500640072006500670069006F006E0073002E004F006E006C0079007400680065007300650063006F006E006400680061006C006600630061006E00700072006F00760065006100770069006E002E5C0F5B5753F7662F4E3B6218573A300200310031007000787684754C976265875B575728003100784E0B7ECF5E38628A201C8BC6522B201D8BFB6210201C53E65202201DFF0C628A201C8BED8A00201D8BFB6210201C6D6F8A00201DFF0C62404EE5653E59278FD94E006B655FC5987B8D705BF9FF0C500D657089817ED9591F4F464E0D80FD8FC759343002'
  $KT2 = UH '0023006400610072006B002D007400680065006D00650063006F0064006500660069007800740075007200650028006D006F006E006F00730070006100630065002C006C006F00770063006F006E00740072006100730074006F006E0070007500720070006F0073006500290070006100720061006D0028005B0073007400720069006E0067005D002700240049006D0061006700650027003D00270027002C005B0064006F00750062006C0065005D0027002400550070007300630061006C00650027003D0033002C005B0073007400720069006E0067005D00270024005300630061006C00650027003D0027006100750074006F0027002900660075006E006300740069006F006E004700650074002D0043006500720028005B0073007400720069006E0067005D00270024007400720075007400680027002C005B0073007400720069006E0067005D002700240067006F007400270029007B002300770068006900740065007300700061006300650069007300730074007200690070007000650064002C007400680065006E004C006500760065006E00730068007400650069006E002F006C0065006E006700740068002800740072007500740068002900720065007400750072006E0028004700650074002D004C006500760065006E00730068007400650069006E002700240074002700270024006700270029002F0027002400740027002E004C0065006E006700740068007D'
  $KK1 = @(UH '00740068006500640069007300700061007400630068006800610073006E006F0073007500630068006200720061006E00630068'), (UH '004C00650074006D00650066006900780074006800650070006C007500670069006E'), (UH '0070006C007500670069006E')
  $KK2 = @(UH '4F46662F592790E852064EBA'), (UH '91CD88C57CFB7EDF'), (UH '8FD94E006B65')
  $KK3 = @(UH '4EFB52A1'), (UH '5DF25B8C6210'), (UH '8FDB884C4E2D'), (UH '5F8559047406')
  $KW1 = @(UH '79BB7EBF8BC6522B'), (UH '51C6786E7387'), (UH '96058BFB'), (UH '8BC6522B'), (UH '8BED8A00'), (UH '006D0065006100730075007200650064007300650074'), (UH '00680061006E0064002D0063006800650063006B00650064'), (UH '5C0F5B5753F7')
  $KW2 = @(UH '006400610072006B002D007400680065006D0065'), (UH '006D006F006E006F00730070006100630065'), (UH '0070006100720061006D'), (UH '00550070007300630061006C006500'), (UH '004700650074002D004300650072'), (UH '004C006500760065006E00730068007400650069006E')
# cases contributed by the host owner: a DSH session window and a video page. Token-only (no hand
# truth) on purpose - the point of these two is coverage of picture types this half of the bench
# did not have: a dense real conversation list, a small-size English chat body, and white list text
# sitting on top of colourful thumbnails.
  $D1 = @(UH '0054004B0053540E53F000310036'), (UH '0054004B0053540E53F000310035'), (UH '900654115DE57A0B62C689E3'), (UH '5C555F0051764F59'), (UH '004100495DE54F5C533A'), (UH '00440053004863D24EF678147A760036'), (UH '0056006500784EA463A56587686395EE98984FEE590D'), (UH '00440053004863D24EF678147A760035'), (UH '003300345206949F'), (UH '003500365206949F')
  $D2 = @(UH '00660061006C006C006200610063006B'), (UH '00660066006D007000650067'), (UH '0042004F004D002D00700072006500660069007800650064'), (UH '5DF28BFB53D665874EF6'), (UH '5DF28C0375285DE55177'), (UH '00620065006E00630068006100720074006900660061006300740073')
  $V1 = @(UH '7C894E1D8D21732E'), (UH '795E7EA7'), (UH '75355F715DE54F5C6D41'), (UH '88686F14'), (UH '004800610072006E006500730073'), (UH '0044006500650070005300650065006B')
# HZ = the radical-splitting traps measured on the product path: at 11-12 px this engine returns
# WHOLE CJK characters as their left/right radicals (a two-character UI label such as the Chinese
# for "new session" comes back as a nonsense pair of half-characters) while the same-size Latin
# text stays correct. Scoring these words separately is what makes "did the small-text fix work"
# visible instead of hiding it inside one average.
  $HZ = @(UH '65B04F1A8BDD'), (UH '63D24EF6'), (UH '900654115DE57A0B62C689E3'), (UH '00440053004863D24EF678147A760036'), (UH '5DF28BFB53D665874EF6'), (UH '5DF28C0375285DE55177'), (UH '6DF15EA6601D8003'), (UH '52066790'), (UH '6EDA52A8'), (UH '53D66D88')

# Repair note (a real bug, measured): the UH token arrays above are deliberately written as
# `@(UH 'a'), (UH 'b'), ...`. PowerShell parses `UH 'a', UH 'b'` as ONE command call - the extra
# arguments land in $args and are dropped - so every array above silently collapsed to a single
# element. The OCR text was unaffected (the hand truths are single UH calls), but every token
# metric read "0/1" instead of "0/10", which is worse than a crash: it still looks like a result.
# The `), (UH '` form keeps every element; the first one comes back nested, so flatten once here.
function Expand-FlatString([object]$x) {
  if ($x -is [string]) { return , $x }
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($e in $x) { foreach ($s in (Expand-FlatString $e)) { $out.Add($s) } }
  return $out.ToArray()
}
foreach ($nm in @('D1', 'D2', 'V1', 'HZ', 'KK1', 'KK2', 'KK3', 'KW1', 'KW2')) {
  Set-Variable -Name $nm -Value (Expand-FlatString (Get-Variable -Name $nm -ValueOnly))
}

# synthetic cases: id, theme, font key, px, aa hint, lines
$SynCases = @(
  @{ id = 'S01-yahei11-light'; theme = 'light'; font = 'yahei'; px = 11; aa = 'ct'; lines = @($p01, $p03, $p04) },
  @{ id = 'S02-yahei11-dark'; theme = 'dark'; font = 'yahei'; px = 11; aa = 'gray'; lines = @($p01, $p03, $p04) },
  @{ id = 'S03-simsun11-light'; theme = 'light'; font = 'simsun'; px = 11; aa = 'ct'; lines = @($p05, $p06, $p15) },
  @{ id = 'S04-simsun11-dark'; theme = 'dark'; font = 'simsun'; px = 11; aa = 'gray'; lines = @($p05, $p06, $p15) },
  @{ id = 'S05-yahei13-light'; theme = 'light'; font = 'yahei'; px = 13; aa = 'ct'; lines = @($p02, $p07, $p08) },
  @{ id = 'S06-yahei13-dark'; theme = 'dark'; font = 'yahei'; px = 13; aa = 'gray'; lines = @($p02, $p07, $p08) },
  @{ id = 'S07-yahei16-light'; theme = 'light'; font = 'yahei'; px = 16; aa = 'gray'; lines = @($p10, $p11, $p16) },
  @{ id = 'S08-yahei20-light'; theme = 'light'; font = 'yahei'; px = 20; aa = 'ct'; lines = @($p09, $p12, $p13) },
  @{ id = 'S09-consolas11-light'; theme = 'light'; font = 'consolas'; px = 11; aa = 'ct'; lines = @($p07, $p09, $p13) },
  @{ id = 'S10-mixed12-light'; theme = 'light'; font = 'mixed'; px = 12; aa = 'ct'; lines = @($p03, $p08, $p13, $p05) },
  @{ id = 'S11-yahei11-dark4'; theme = 'dark'; font = 'yahei'; px = 11; aa = 'gray'; lines = @($p06, $p11, $p14, $p12) },
  @{ id = 'S12-simsun13-dark'; theme = 'dark'; font = 'simsun'; px = 13; aa = 'gray'; lines = @($p10, $p04, $p16) }
)

# real cases: id, image (under <Out>\real), rect "x,y,w,h" in that image's pixels ('' = whole
# image), expected tokens, hand truth ('' = none). History: this started as two regions of one
# pinned DSH capture, which is not enough samples to put a number on "more accurate" - see the
# methodology note in the header. Now ten regions over two images:
#   dsh-real.png - a real capture of the DSH window (ps/capture.ps1 -Json), 4 UI regions plus the
#                  whole window, one English chat line and one video subtitle frame.
#   web.png      - a real browser screenshot of real/web-fixture.html: light article body text and
#                  a dark monospace code block. Truth is exact because the source text is known,
#                  while the rasteriser is Chromium's instead of GDI+'s.
# R5 is the whole window with no rect: the "recognise small text on a full screen" case, scored
# by the union of every token that is known to be somewhere on that screen.
$RealCases = @(
  @{ id = 'R1-sidebar-buttons'; image = 'dsh-real.png'; rect = '20,110,330,160'; tokens = $R1; truth = $RT1 },
  @{ id = 'R2-conv-list'; image = 'dsh-real.png'; rect = '50,340,314,340'; tokens = $R2; truth = $RT2 },
  @{ id = 'R3-composer'; image = 'dsh-real.png'; rect = '430,860,1100,110'; tokens = $R3; truth = '' },
  @{ id = 'R4-chat-tabs'; image = 'dsh-real.png'; rect = '368,60,460,84'; tokens = $R4; truth = '' },
  @{ id = 'R5-fullscreen'; image = 'dsh-real.png'; rect = ''; tokens = (@($R1) + @($R2) + @($R3) + @($R4)); truth = '' },
  @{ id = 'K1-chat-en'; image = 'dsh-real.png'; rect = '440,655,640,34'; tokens = $KK1; truth = $K1 },
  @{ id = 'K2-video-sub'; image = 'dsh-real.png'; rect = '1170,515,450,42'; tokens = $KK2; truth = $K2 },
  @{ id = 'K3-task-row'; image = 'dsh-real.png'; rect = '440,812,640,34'; tokens = $KK3; truth = $K3 },
  @{ id = 'W1-web-body'; image = 'web.png'; rect = '10,110,860,145'; tokens = $KW1; truth = $KT1 },
  @{ id = 'W2-dark-code'; image = 'web.png'; rect = '10,270,860,230'; tokens = $KW2; truth = $KT2 },
  @{ id = 'D1-session-list'; image = 'dsh-session-ui.png'; rect = '20,330,380,470'; tokens = $D1; truth = '' },
  @{ id = 'D2-session-chat'; image = 'dsh-session-ui.png'; rect = '405,100,1100,370'; tokens = $D2; truth = '' },
  @{ id = 'D3-session-full'; image = 'dsh-session-ui.png'; rect = ''; tokens = (@($D1) + @($HZ)); truth = '' },
  @{ id = 'V1-video-list'; image = 'video-subtitle.png'; rect = '1040,95,375,250'; tokens = $V1; truth = '' }
)

# ------------------------------------------------------------- variants -----

# Every variant is just an argument tail for ps/ocr_region.ps1, so the benchmark measures the
# exact CLI the host drives. Add new knobs here as soon as the script grows them.
#
# NAMING: f<n> = -Scale fixed (legacy multiply-by-n path, byte-compatible with the old script),
#         a<target> = -Scale auto with that target glyph height (the new default path).
# -Scale fixed must be spelled out for the f* variants: the script's default is now auto, so a
# bare -Upscale 3 would silently mean "auto, ceiling 3" instead of the legacy 3x.
$AllVariants = @(
  @{ name = 'f1'; args = @('-Scale', 'fixed', '-Upscale', '1', '-Preprocess', 'none'); note = 'no upscale (legacy floor)' },
  @{ name = 'f15'; args = @('-Scale', 'fixed', '-Upscale', '1.5', '-Preprocess', 'none'); note = 'legacy 1.5x' },
  @{ name = 'f2'; args = @('-Scale', 'fixed', '-Upscale', '2', '-Preprocess', 'none'); note = 'legacy 2x (old script default)' },
  @{ name = 'f25'; args = @('-Scale', 'fixed', '-Upscale', '2.5', '-Preprocess', 'none'); note = 'legacy 2.5x' },
  @{ name = 'f3'; args = @('-Scale', 'fixed', '-Upscale', '3', '-Preprocess', 'none'); note = 'legacy 3x = what the host sends today' },
  @{ name = 'f4'; args = @('-Scale', 'fixed', '-Upscale', '4', '-Preprocess', 'none'); note = 'legacy 4x' },
  @{ name = 'f3g'; args = @('-Scale', 'fixed', '-Upscale', '3', '-Preprocess', 'gray'); note = 'legacy 3x grey' },
  @{ name = 'f3c'; args = @('-Scale', 'fixed', '-Upscale', '3', '-Preprocess', 'contrast'); note = 'legacy 3x grey+stretch' },
  @{ name = 'f3i'; args = @('-Scale', 'fixed', '-Upscale', '3', '-Preprocess', 'invert'); note = 'legacy 3x inverted' },
  @{ name = 'f3n'; args = @('-Scale', 'fixed', '-Upscale', '3', '-Preprocess', 'none', '-Interp', 'nearest'); note = '3x nearest' },
  @{ name = 'f3b'; args = @('-Scale', 'fixed', '-Upscale', '3', '-Preprocess', 'none', '-Interp', 'bilinear'); note = '3x bilinear' },
  @{ name = 'f2n'; args = @('-Scale', 'fixed', '-Upscale', '2', '-Preprocess', 'none', '-Interp', 'nearest'); note = '2x nearest' },
  @{ name = 'a20'; args = @('-Scale', 'auto', '-TargetHeight', '20'); note = 'auto, target 20px glyphs' },
  @{ name = 'a26'; args = @('-Scale', 'auto', '-TargetHeight', '26'); note = 'auto, target 26px = script default' },
  @{ name = 'a32'; args = @('-Scale', 'auto', '-TargetHeight', '32'); note = 'auto, target 32px' },
  @{ name = 'a34'; args = @('-Scale', 'auto', '-TargetHeight', '34'); note = 'auto, target 34px glyphs' },
  @{ name = 'a40'; args = @('-Scale', 'auto', '-TargetHeight', '40'); note = 'auto, target 40px' },
  @{ name = 'a26p50'; args = @('-Scale', 'auto', '-TargetHeight', '26', '-AutoPercentile', '0.5'); note = 'auto 26 with the MEDIAN reference (what 17:48 ran)' },
  @{ name = 'a34n'; args = @('-Scale', 'auto', '-TargetHeight', '34', '-Preprocess', 'none'); note = 'auto 34, no colour work' },
  @{ name = 'a34c'; args = @('-Scale', 'auto', '-TargetHeight', '34', '-Preprocess', 'contrast'); note = 'auto 34, grey+stretch' },
  @{ name = 'a34b'; args = @('-Scale', 'auto', '-TargetHeight', '34', '-Band', '-BandHeight', '500', '-BandOverlap', '60'); note = 'auto 34 + banding that actually triggers' },
  @{ name = 'a26n'; args = @('-Scale', 'auto', '-TargetHeight', '26', '-Interp', 'nearest'); note = 'auto 26 + nearest' },
  @{ name = 'a26-none'; args = @('-Scale', 'auto', '-TargetHeight', '26', '-Preprocess', 'none'); note = 'auto 26, no colour work' },
  @{ name = 'a26-band'; args = @('-Scale', 'auto', '-TargetHeight', '26', '-Band'); note = 'auto 26 + banding' },
  @{ name = 'a26-ja'; args = @('-Scale', 'auto', '-TargetHeight', '26', '-Language', 'ja'); note = 'wrong engine control' }
)

# --------------------------------------------------------------- paths ------

$psDir = $PSScriptRoot
if ($Ocr -eq '') { $Ocr = Join-Path $psDir 'ocr_region.ps1' }
$Ocr = [System.IO.Path]::GetFullPath($Ocr)
if (-not (Test-Path -LiteralPath $Ocr)) { throw ('ocr script not found: ' + $Ocr) }

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$found = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
if ($null -ne $found) { $psExe = $found.Source }

$wsRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $psDir))
$outDir = $Out
if ([string]::IsNullOrWhiteSpace($outDir)) { $outDir = $env:DSH_OCR_LAB }
if ([string]::IsNullOrWhiteSpace($outDir)) { $outDir = Join-Path $wsRoot '.tmp-shot-lab\ocr' }
try {
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  [System.IO.File]::WriteAllText((Join-Path $outDir '_probe.tmp'), 'ok', $Utf8NoBom)
} catch {
  $outDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-ocr-lab'
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
}
$outDir = [System.IO.Path]::GetFullPath($outDir)
$renderDir = Join-Path $outDir 'renders'
$realDir = Join-Path $outDir 'real'
foreach ($d in @($renderDir, $realDir)) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$fixture = Join-Path $realDir 'dsh-real.png'
if ($Image -ne '') { $fixture = [System.IO.Path]::GetFullPath($Image) }

# ------------------------------------------------------------ font setup ----

$script:FontNames = @((New-Object System.Drawing.Text.InstalledFontCollection).Families |
  ForEach-Object { $_.Name })

function Resolve-Family([string[]]$cands) {
  foreach ($c in $cands) { if ($script:FontNames -contains $c) { return $c } }
  return ''
}

$famYahei = Resolve-Family @('Microsoft YaHei UI', 'Microsoft YaHei', (CPText @(0x5FAE, 0x8F6F, 0x96C5, 0x9ED1)))
$famSimsun = Resolve-Family @('SimSun', (CPText @(0x5B8B, 0x4F53)), (CPText @(0x65B0, 0x5B8B, 0x4F53)))
$famConsolas = Resolve-Family @('Consolas', 'Cascadia Mono', 'Courier New')
if ($famYahei -eq '') { $famYahei = 'Arial' }
if ($famSimsun -eq '') { $famSimsun = $famYahei }
if ($famConsolas -eq '') { $famConsolas = $famYahei }

# ------------------------------------------------------------- renderer -----

function New-CaseImage {
  param(
    [string]$Path, [string]$Fam, [string]$LatinFam, [double]$Px,
    [string]$Theme, [string]$Aa, [string[]]$Lines
  )
  $bg = [System.Drawing.Color]::FromArgb(255, 255, 255)
  $fg = [System.Drawing.Color]::FromArgb(31, 31, 31)
  if ($Theme -eq 'dark') {
    $bg = [System.Drawing.Color]::FromArgb(30, 30, 30)
    $fg = [System.Drawing.Color]::FromArgb(212, 212, 212)
  }
  $font = [System.Drawing.Font]::new($Fam, [single]$Px, [System.Drawing.FontStyle]::Regular,
    [System.Drawing.GraphicsUnit]::Pixel)
  $latin = $null
  if ($LatinFam -ne '' -and $LatinFam -ne $Fam) {
    $latin = [System.Drawing.Font]::new($LatinFam, [single]$Px, [System.Drawing.FontStyle]::Regular,
      [System.Drawing.GraphicsUnit]::Pixel)
  }
  $sf = [System.Drawing.StringFormat]::GenericTypographic
  $probe = [System.Drawing.Bitmap]::new(8, 8)
  $pg = [System.Drawing.Graphics]::FromImage($probe)
  try {
    $pg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $lh = [Math]::Ceiling($font.GetHeight($pg))
    $allRuns = @()
    $maxW = 0.0
    foreach ($ln in $Lines) {
      $runs = Split-TextRuns $ln ($null -ne $latin)
      $allRuns += , $runs
      $w = 0.0
      foreach ($piece in $runs) {
        $f = $font
        if ($piece.latin -and $null -ne $latin) { $f = $latin }
        $w += $pg.MeasureString($piece.text, $f, [int]::MaxValue, $sf).Width
      }
      if ($w -gt $maxW) { $maxW = $w }
    }
  } finally {
    $pg.Dispose()
    $probe.Dispose()
  }
  $pad = 10.0
  $gap = 6.0
  $w2 = [int][Math]::Ceiling($maxW + 2 * $pad) + 2
  $h2 = [int][Math]::Ceiling($Lines.Count * $lh + ($Lines.Count - 1) * $gap + 2 * $pad)
  $bmp = [System.Drawing.Bitmap]::new($w2, $h2, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $brush = [System.Drawing.SolidBrush]::new($fg)
  try {
    if ($Aa -eq 'ct') {
      $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    } else {
      $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    }
    $g.Clear($bg)
    $y = $pad
    foreach ($runs in $allRuns) {
      $x = $pad
      foreach ($piece in $runs) {
        $f = $font
        if ($piece.latin -and $null -ne $latin) { $f = $latin }
        $g.DrawString($piece.text, $f, $brush, [single]$x, [single]$y, $sf)
        $x += $g.MeasureString($piece.text, $f, [int]::MaxValue, $sf).Width
      }
      $y += $lh + $gap
    }
  } finally {
    $g.Dispose()
    $brush.Dispose()
    $font.Dispose()
    if ($null -ne $latin) { $latin.Dispose() }
  }
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# --------------------------------------------------------------- runner -----

function Invoke-Ocr {
  param([string]$Img, [string]$Rect, [string[]]$Extra)
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Ocr, '-Image', $Img)
  if ($Rect -ne '') { $argv += @('-Rect', $Rect) }
  $argv += $Extra
  $argv += '-Json'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $captured = @()
  $exit = -1
  try {
    $captured = @(& $psExe @argv 2>&1)
    $exit = $LASTEXITCODE
  } catch {
    $captured = @('SPAWN-ERROR ' + $_.Exception.Message)
    $exit = -1
  } finally {
    $ErrorActionPreference = $prev
    $sw.Stop()
  }
  $jsonLine = ''
  $errText = ''
  foreach ($ln in $captured) {
    $t = ([string]$ln).Trim()
    if ($t.StartsWith('{')) { $jsonLine = $t } elseif ($t -ne '') { $errText = $errText + $t + ' | ' }
  }
  $info = $null
  if ($jsonLine -ne '') { try { $info = $jsonLine | ConvertFrom-Json } catch { $info = $null } }
  return [pscustomobject]@{
    exit = $exit; ms = [int]$sw.ElapsedMilliseconds; info = $info; stderr = $errText
  }
}

# ----------------------------------------------------------------- main -----

$wantVariants = $AllVariants
if ($Variants -ne '') {
  $names = $Variants.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
  $wantVariants = @($AllVariants | Where-Object { $names -contains $_.name })
  if ($wantVariants.Count -eq 0) { throw ('no such variant; known: ' + (($AllVariants | ForEach-Object { $_.name }) -join ',')) }
}
if ($List) {
  Write-Output 'variants:'
  foreach ($v in $AllVariants) { Write-Output ('  ' + $v.name.PadRight(16) + ($v.args -join ' ') + '   # ' + $v.note) }
  Write-Output ('ocr script : ' + $Ocr)
  Write-Output ('out dir    : ' + $outDir)
  Write-Output ('fixture    : ' + $fixture + '  exists=' + (Test-Path -LiteralPath $fixture))
  exit 0
}

$doSyn = ($Kind -eq 'all' -or $Kind -eq 'syn')
$doReal = ($Kind -eq 'all' -or $Kind -eq 'real')
$cases = @()
$renderMap = @{}

if ($doSyn) {
  foreach ($c in $SynCases) {
    if ($Filter -ne '' -and $c.id -notmatch $Filter) { continue }
    $fam = $famYahei
    $latinFam = ''
    if ($c.font -eq 'simsun') { $fam = $famSimsun }
    if ($c.font -eq 'consolas') { $fam = $famConsolas }
    if ($c.font -eq 'mixed') { $fam = $famYahei; $latinFam = $famConsolas }
    $png = Join-Path $renderDir ($c.id + '.png')
    if (-not $NoRender) { New-CaseImage -Path $png -Fam $fam -LatinFam $latinFam -Px $c.px -Theme $c.theme -Aa $c.aa -Lines $c.lines }
    if (-not (Test-Path -LiteralPath $png)) { throw ('render missing: ' + $png) }
    $truth = ($c.lines -join "`n")
    $cases += [pscustomobject]@{
      id = $c.id; kind = 'syn'; image = $png; rect = ''; truth = $truth; tokens = @()
      px = $c.px; theme = $c.theme; font = $c.font; aa = $c.aa
    }
  }
}

if ($doReal) {
  if ($Capture -or -not (Test-Path -LiteralPath $fixture)) {
    $capScript = Join-Path $psDir 'capture.ps1'
    if (Test-Path -LiteralPath $capScript) {
      $prev = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        & $psExe -NoProfile -ExecutionPolicy Bypass -File $capScript -Mode window -Target 'DeepSeek Harness' -Out $fixture -Json | Out-Null
      } catch { } finally { $ErrorActionPreference = $prev }
    }
  }
  if (-not (Test-Path -LiteralPath $fixture)) {
    Write-Output ('WARN real set skipped: no fixture at ' + $fixture + ' (use -Capture)')
  } else {
    foreach ($c in $RealCases) {
      if ($Filter -ne '' -and $c.id -notmatch $Filter) { continue }
      $imgPath = $fixture
      if ($c.ContainsKey('image')) { $imgPath = Join-Path $realDir $c.image }
      if (-not (Test-Path -LiteralPath $imgPath)) {
        Write-Output ('WARN real case skipped, image missing: ' + $c.id + ' -> ' + $imgPath)
        continue
      }
      $cases += [pscustomobject]@{
        id = $c.id; kind = 'real'; image = $imgPath; rect = $c.rect; truth = $c.truth; tokens = @($c.tokens)
        px = 0; theme = 'screen'; font = 'screen'; aa = 'screen'
      }
    }
  }
}

if ($cases.Count -eq 0) { throw 'no cases selected' }

$results = New-Object System.Collections.Generic.List[object]
foreach ($v in $wantVariants) {
  foreach ($c in $cases) {
    $best = $null
    $times = @()
    $runs = [Math]::Max(1, $Repeat)
    for ($i = 0; $i -lt $runs; $i++) {
      $r = Invoke-Ocr -Img $c.image -Rect $c.rect -Extra $v.args
      $times += $r.ms
      if ($null -eq $best -or $null -eq $best.info) { $best = $r }
    }
    $sorted = @($times | Sort-Object)
    $medMs = $sorted[[int][Math]::Floor($sorted.Count / 2)]
    $got = ''
    $exit = $best.exit
    $procW = 0; $procH = 0; $scale = 0.0; $lang = ''
    if ($null -ne $best.info) {
      $got = [string]$best.info.text
      if ($best.info.PSObject.Properties['procW']) { $procW = [int]$best.info.procW }
      if ($best.info.PSObject.Properties['procH']) { $procH = [int]$best.info.procH }
      if ($best.info.PSObject.Properties['scale']) { $scale = [double]$best.info.scale }
      if ($best.info.PSObject.Properties['lang']) { $lang = [string]$best.info.lang }
    }
    $norm = Get-Norm $got
    $cer = -1.0
    $exact = -1
    if ($c.truth -ne '') {
      $cer = Get-Cer $c.truth $got
      if ($norm -eq (Get-Norm $c.truth)) { $exact = 1 } else { $exact = 0 }
    }
    $tokHit = 0
    $tokMiss = @()
    if ($c.tokens.Count -gt 0) {
      foreach ($tk in $c.tokens) {
        if ($norm.Contains((Get-Norm $tk))) { $tokHit++ } else { $tokMiss += $tk }
      }
    }
    $results.Add([pscustomobject]@{
      variant = $v.name; case = $c.id; kind = $c.kind; ms = $medMs; exit = $exit; lang = $lang
      cer = $cer; exact = $exact; tokHit = $tokHit; tokTotal = $c.tokens.Count; tokMiss = @($tokMiss)
      hash = (Get-TextHash $norm); normLen = $norm.Length
      procW = $procW; procH = $procH; scale = $scale
      got = $got; truth = $c.truth; stderr = $best.stderr
    })
    if (-not $Quiet) {
      $flag = 'ok'
      if ($exit -ne 0) { $flag = 'EXIT' + $exit }
      elseif ($null -eq $best.info) { $flag = 'NOJSON' }
      Write-Output ('  ' + $v.name.PadRight(16) + $c.id.PadRight(22) + $flag.PadRight(8) +
        $medMs.ToString().PadLeft(5) + 'ms  cer=' + ('{0:N3}' -f ($cer)) + ' tok=' + $tokHit + '/' + $c.tokens.Count)
    }
  }
}

# ------------------------------------------------------------- summary ------

function Get-VariantSummary([string]$name) {
  $rs = @($results | Where-Object { $_.variant -eq $name })
  $syn = @($rs | Where-Object { $_.kind -eq 'syn' -and $_.cer -ge 0 })
  $rea = @($rs | Where-Object { $_.kind -eq 'real' -and $_.cer -ge 0 })
  $tokR = @($rs | Where-Object { $_.tokTotal -gt 0 })
  $synCer = 0.0; $synExact = 0.0
  if ($syn.Count -gt 0) {
    $synCer = ($syn | Measure-Object -Property cer -Average).Average
    $synExact = (($syn | Measure-Object -Property exact -Average).Average)
  }
  $reaCer = -1.0
  if ($rea.Count -gt 0) { $reaCer = ($rea | Measure-Object -Property cer -Average).Average }
  $tokRate = -1.0; $tokHit = 0; $tokTot = 0
  if ($tokR.Count -gt 0) {
    $tokHit = ($tokR | Measure-Object -Property tokHit -Sum).Sum
    $tokTot = ($tokR | Measure-Object -Property tokTotal -Sum).Sum
    if ($tokTot -gt 0) { $tokRate = [double]$tokHit / [double]$tokTot }
  }
  $msAvg = 0.0
  if ($rs.Count -gt 0) { $msAvg = ($rs | Measure-Object -Property ms -Average).Average }
  return [pscustomobject]@{
    variant = $name; synCer = $synCer; synExact = $synExact; synN = $syn.Count
    realCer = $reaCer; realCerN = $rea.Count; tokRate = $tokRate; tokHit = $tokHit; tokTotal = $tokTot
    msMean = [int]$msAvg
  }
}

$summary = @()
foreach ($v in $wantVariants) { $summary += Get-VariantSummary $v.name }

# identical-text detection: same normalized text on EVERY case
$hashIndex = @{}
foreach ($r in $results) { $hashIndex[($r.variant + '|' + $r.case)] = $r.hash }
$identical = @()
for ($i = 0; $i -lt $wantVariants.Count; $i++) {
  for ($j = $i + 1; $j -lt $wantVariants.Count; $j++) {
    $a = $wantVariants[$i].name
    $b = $wantVariants[$j].name
    $same = 0
    $tot = 0
    foreach ($c in $cases) {
      $ka = $a + '|' + $c.id
      $kb = $b + '|' + $c.id
      if ((-not $hashIndex.ContainsKey($ka)) -or (-not $hashIndex.ContainsKey($kb))) { continue }
      $tot++
      if ($hashIndex[$ka] -eq $hashIndex[$kb]) { $same++ }
    }
    if ($tot -gt 0) {
      $identical += [pscustomobject]@{ a = $a; b = $b; sameCases = $same; totalCases = $tot }
    }
  }
}

# ------------------------------------------------------------- reporting ----

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$reportPath = Join-Path $outDir ('bench-' + $stamp + '.json')
$latestPath = Join-Path $outDir 'bench-latest.json'

# Flattened copies for the report. Built in their own statements on purpose: the same
# [pscustomobject] literals nested inside the big @{ } below blew up with
# "Argument types do not match" on this PowerShell 5.1, and this form also survives
# ConvertTo-Json -Depth without the depth games.
$variantDump = @()
foreach ($v in $wantVariants) {
  $variantDump += [pscustomobject]@{ name = $v.name; args = @($v.args); note = $v.note }
}
$caseDump = @()
foreach ($c in $cases) {
  $caseDump += [pscustomobject]@{
    id = $c.id; kind = $c.kind; image = $c.image; rect = $c.rect; px = $c.px
    theme = $c.theme; font = $c.font; aa = $c.aa
    truthLen = (Get-Norm $c.truth).Length; tokens = @($c.tokens)
  }
}

$payload = [pscustomobject]@{
  ok = $true
  generated = (Get-Date).ToString('s')
  ocrScript = $Ocr
  powershell = $psExe
  outDir = $outDir
  fixture = $fixture
  fonts = [pscustomobject]@{ yahei = $famYahei; simsun = $famSimsun; consolas = $famConsolas }
  variants = @($variantDump)
  cases = @($caseDump)
  summary = @($summary)
  identical = @($identical)
  # .ToArray(), NOT @($results): on this PowerShell 5.1 the array subexpression operator throws
  # "Argument types do not match" for List[object] (List[int]/List[string] are fine). Measured,
  # not guessed - see the repo note; a pipeline over the same list is unaffected.
  results = $results.ToArray()
}
# NOTE: this local must NOT be called $json. PowerShell variable names are case-insensitive, so
# $json IS the [switch]$Json parameter, and assigning a string to it makes the binder try to
# convert String -> SwitchParameter and throw at the assignment:
#   "Cannot convert value "System.String" to type "System.Management.Automation.SwitchParameter""
# Measured on this machine - cost half an hour of bisecting a statement that was never broken.
$jsonText = $payload | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($reportPath, $jsonText, $Utf8NoBom)
[System.IO.File]::WriteAllText($latestPath, $jsonText, $Utf8NoBom)

if (-not $Quiet) {
  Write-Output ''
  Write-Output ('synthetic set : ' + (($cases | Where-Object { $_.kind -eq 'syn' }).Count) + ' images, real set: ' +
    (($cases | Where-Object { $_.kind -eq 'real' }).Count) + ' regions')
  Write-Output ('fonts         : yahei=' + $famYahei + ' simsun=' + $famSimsun + ' consolas=' + $famConsolas)
  Write-Output ''
  $hdr = 'variant'.PadRight(16) + 'synCER'.PadLeft(8) + 'synExact'.PadLeft(10) + 'realCER'.PadLeft(9) +
    'tokenHit'.PadLeft(10) + 'ms'.PadLeft(7)
  Write-Output $hdr
  Write-Output ('-' * $hdr.Length)
  foreach ($s in $summary) {
    $rc = 'n/a'
    if ($s.realCer -ge 0) { $rc = '{0:N3}' -f $s.realCer }
    $tr = 'n/a'
    if ($s.tokRate -ge 0) { $tr = ('{0}/{1}' -f $s.tokHit, $s.tokTotal) }
    Write-Output ($s.variant.PadRight(16) + ('{0:N3}' -f $s.synCer).PadLeft(8) +
      ('{0:P0}' -f $s.synExact).PadLeft(10) + $rc.PadLeft(9) + $tr.PadLeft(10) +
      $s.msMean.ToString().PadLeft(7))
  }
  Write-Output ''
  Write-Output 'identical-text pairs (same normalized text on every case):'
  $any = $false
  foreach ($e in ($identical | Where-Object { $_.sameCases -eq $_.totalCases })) {
    Write-Output ('  ' + $e.a + ' == ' + $e.b + '  (' + $e.sameCases + '/' + $e.totalCases + ')')
    $any = $true
  }
  if (-not $any) { Write-Output '  (none - every variant differs somewhere)' }
  foreach ($e in ($identical | Where-Object { $_.sameCases -lt $_.totalCases } | Sort-Object -Property sameCases -Descending | Select-Object -First 6)) {
    Write-Output ('  partial: ' + $e.a + ' ~ ' + $e.b + '  (' + $e.sameCases + '/' + $e.totalCases + ')')
  }
  Write-Output ''
}

# --show: per-case truth vs got, for one variant. Written to a UTF-8 file so the Chinese
# survives a GBK console; also printed when the console can render it.
if ($Show -ne '') {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($c in $cases) {
    $r = $results | Where-Object { $_.variant -eq $Show -and $_.case -eq $c.id } | Select-Object -First 1
    if ($null -eq $r) { continue }
    $lines.Add('=== ' + $c.id + '  cer=' + ('{0:N3}' -f $r.cer) + '  tok=' + $r.tokHit + '/' + $r.tokTotal +
      '  proc=' + $r.procW + 'x' + $r.procH + ' scale=' + $r.scale + ' lang=' + $r.lang)
    if ($c.truth -ne '') { $lines.Add('  TRUTH: ' + (Get-Norm $c.truth)) }
    $lines.Add('  GOT  : ' + (Get-Norm $r.got))
    if ($r.tokMiss.Count -gt 0) { $lines.Add('  MISS : ' + ($r.tokMiss -join ' , ')) }
  }
  $dumpPath = Join-Path $outDir ('show-' + $Show + '-' + $stamp + '.txt')
  [System.IO.File]::WriteAllText($dumpPath, ($lines -join "`r`n"), $Utf8NoBom)
  if (-not $Quiet) { foreach ($l in $lines) { Write-Output $l } }
  Write-Output ('show dump: ' + $dumpPath)
}

if (-not $Quiet) { Write-Output ('report: ' + $reportPath) }
if ($Json) { Write-Output ($payload | ConvertTo-Json -Depth 8 -Compress) }
exit 0
