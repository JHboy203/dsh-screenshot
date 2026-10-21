# dsh-screenshot · DSH screenshot plugin

[中文](README.md)


[English](README.en.md)


Screenshot, same as QQ: the button hangs **next to the "voice" button of the chat input box** (`conversation.input.left` slot, order `-90`).

## Capabilities

| Menu item | Description |
|---|---|
| ✂ Screenshot | **Always select a region in the native overlay** (a real full-screen window in a separate process, so it can cover other applications) → annotate → **paste into the input box + copy to the clipboard** |
| ⏺ Record screen | Recording with ffmpeg gdigrab (H.264 + faststart). **By default you first select a region, then record** (see below); a red frame on screen marks the boundary, and clicking "stop" on the timer pill at the top right finishes it. Audio can be enabled from the menu (R41, off by default) |
| Aa Extract text | **Offline OCR** after selecting a region (Windows built-in engine, nothing leaves the machine), producing a text panel that can be copied / pasted into the input box |
| 译 Translate screen | After OCR, the text (with a translation-instruction prefix) is pasted into the input box and handed to DSH's own model to translate |
| ⇕ Long screenshot | Select a region → the host scrolls one screen and captures a frame → align and stitch the overlapping area → the long image returns to the annotation UI |
| ☐ Hide the DSH UI while capturing | The native overlay hides the DSH window **before freezing the desktop** (same as QQ); after selecting or cancelling, it is restored and brought back to the foreground; off by default, tick it in "More settings" |

> **As of R33 the four items "Range / Pick a window to capture / Select the range yourself / Window capture method" were removed**, along with the whole mechanism that rendered a desktop screenshot inside the DSH window
> (canvas + DOM overlay). It could only cover DSH's own window, and at 125% scaling it could only select a patch in the top-left corner of the screen — keeping it means "it looks like it works, but you can't select what you want". The only entry point now is the native
> overlay; when it is unavailable it **says so** ("restart DSH once") and no longer silently swaps in a degraded UI. The old
> `range/method/pickHwnd/pickTitle/nativeOverlay` settings are cleared once by the `prefsVer` migration.

Annotation tools: rectangle / ellipse / arrow / pen / text / mosaic, eight colours + a thickness slider, undo and redo (cursor model),
Enter to finish, Esc to cancel, Ctrl+Z/Y, Ctrl+C, Ctrl+S, Ctrl+A to select all, double-click for full screen.
There is also **pinning an image** (pinned onto the UI, drag to move, Ctrl+wheel to zoom).

Hotkeys: `Ctrl+Alt+A` screenshot, `Ctrl+Alt+O` extract text.

## Why screen capture must live on the host side

The renderer process **cannot get the screen**: the official main session has no `setDisplayMediaRequestHandler`, and the permission handler only allows
the microphone (verified file by file in `/lib/main.js`), so `getDisplayMedia()` gets no source at all.
That is why the host side uses PowerShell/.NET:

- `System.Drawing.Graphics.CopyFromScreen` → whole screen (automatically covers the multi-monitor virtual screen)
- `PrintWindow(PW_RENDERFULLCONTENT)` → a single window, captured even when covered by other windows
- `Windows.Media.Ocr` → offline OCR
- `ffmpeg -f gdigrab` → screen recording
- Synthetic wheel `mouse_event(WHEEL)` + Python/PIL overlap alignment → long screenshot

## Three pitfalls you must remember

1. **DPI**: without calling `SetProcessDPIAware()` first, the process gets virtualized coordinates — at 125% scaling on this machine the same window
   comes out 1295×823 instead of 1619×1029 (blurry screenshots).
2. **Low-integrity processes cannot do window operations**: the DSH tool sandbox is Low integrity, so `ShowWindow` /
   `SetForegroundWindow` / `PrintWindow` are **silently rejected** by UIPI (no error, the window does not move at all).
   So "hide window" and "window self-drawing" only work in a pwsh started inside the **plugin host process**;
   verifying them in a tool shell is bound to fail — this is not a bug.
3. **A .ps1 containing Chinese must have a UTF-8 BOM**: Windows PowerShell 5.1 decodes a .ps1 without a BOM as GBK,
   so Chinese comments get shredded, and it can even **swallow the following code lines** (the symptom is a baffling `LockBits`/argument-type error).

## Host tools (8)

| Tool | What it does |
|---|---|
| `screenshot` / `screenshot_windows` | The AI captures an image itself (no overlay, no stealing the foreground, no touching windows), returns the file path |
| `shot_health` | **The first command in a new session**: answers **whether you need to restart**, based on "file time vs process/instance time" |
| **`shot_preflight`** | **Verify the on-disk host half before restarting** (R40): default = probe-library selftest + full gate; name `probe-selftest` / `gate-full` / `all-probes` / `hosttest`. Verdicts come from the **conclusion line**; no conclusion line = failure. Every item runs in its own child process (those scripts call `process.exit`) |
| **`shot_land`** | **Close the round in one call** (R40): selftests → `git add -A` → commit (message via stdin, so Chinese survives) → push → read the sha back. **dryRun by default**, refuses to commit on red selftests, rejects an empty title |
| `shot_gate` | Runs the whole gate with one command: default = static contract + overlay end-to-end; **`full:true` = the pre-delivery set** (adds one-shot cost + probe aggregate, ≈2.5–5 min); `host:true` adds the full host suite (≈10 min, **never inside `full`**) |
| `shot_bridge` | Drives the **running** client (state / eval / click / menu / dome / longshot) |
| `shot_displays` | Monitor / DPI / negative-coordinate health check + measured out-of-bounds cropping |
| **`shot_pixels`** | **Pixel facts** (R34): capture on the spot with `rect` or read an image with `path` → black-image criteria (meanLuma/blackPct), the pixel count of a colour and its **bounding box**, and the **difference ratio** against another image (optionally restricted to the inside with `region`) |
| **`shot_probe`** | **Runs any dev probe with one command**: `probe:"<name>"` runs one; `probe:"all"` **runs everything and aggregates** (the heavy `hosttest` is not run by default; it only runs when `includeHeavy` is given, and it goes last); `probe:"list"` only lists them (no spawn). Criteria: a timeout / **zero checks** (exit code 0 but not a single PASS/FAIL line printed) / a non-zero exit all **count as failure, faithfully**; **exit code 2 = env** (blocked by the environment, see below) |

> These two are **the handover surface when you switch sessions**: the hardest part of verifying this plugin is not writing code, it is "how do you prove what actually happened on screen".
> The former turns pixel criteria into a single call; the latter freezes the hurdle of "must run inside the host, each with its own arguments" into one table.

### Probe list auto-discovery + run-all aggregation (R35) · explicit args + a measured "no" to parallelism (R36)

- **Declare arguments in the header (R36)**: if a probe takes command-line arguments, add one line to
  its header comments — `// args: -Hwnd <handle> (required)`. `probe:"list"` then lists **arguments**
  separately from **dependencies** (pyqt / JDK), and the "not run" reason in `all` carries the real
  arguments. Without that line the catalogue can only tell you a probe exists, not how to run it.
- **`all` stays serial — measured, not an unoptimised default (R36)**: `dev/probe-concurrency.mjs`
  runs the same pair serially and then in parallel. Parallel is 36 % faster (101 s → 65 s) but
  `wheel-app-qt` drops from **5 PASS to 2 PASS**: both fixtures fight over the same real cursor and
  foreground, so each becomes the other's "environment". Real speed-up would require probes to stop
  sharing those resources (per-fixture injection channel / separate virtual desktop).
- **Auto-discovery**: `dev/*-probe.mjs` are collected into the list automatically (no need to edit `lib/probes.mjs`).
  But they **do not go into `all` by default** — measured, both `dev/auto-wheel-probe.mjs` and `dev/postwheel-probe.mjs` **need
  command-line arguments**, and running them with no arguments only produces meaningless results. Discovery ≠ knowing how to run it, so: they appear in `probe:"list"`, can be run by name, and
  only go into `all` with `includeAuto:true`. Scripts already covered by the explicit table are not registered again (otherwise the same script would run twice).
- **The default set of `all`** = the 5 non-heavy ones in the explicit table (`recframe` / `wheel-target` / `hide-self` /
  `wheel-app-qt` / `wheel-app-java`), one round takes **about 3–5 minutes** (longer when the machine is cold/busy: the fixture's PowerShell
  and the overlay helper can both take >20 s to cold start).
- **env is a third state**: the fixture is covered by another window, or the window cannot get onto the screen → the probe **exits 2**, `shot_probe` reports
  `reason:"env"`, and the aggregate marks it `ENV` separately and gives handling wording. It counts neither as a pass nor as a product regression —
  lumping it into one red would send people looking in the wrong direction (measured this round: with QQ / DSH covering the fixture, all 4 items of `wheel-target` went red,
  all false reds).

## Self-check

**One command before delivery (R37)**: `shot_gate({full:true})` (static + overlay + one-shot cost +
probe aggregate ≈2.5–5 min); add `host:true` for the full host suite (≈10 min).
Before restarting DSH (the tool table is read at startup) run **`shot_preflight({})`** (R40): the
default set is the probe-library selftest + the full gate, and you can name
`probe-selftest` (≈1.5 s) / `gate-full` / `all-probes` / `hosttest`. Verdicts are parsed from the
**conclusion line**, and **no conclusion line counts as a failure**; each item runs in its own
child process because those scripts call `process.exit()`.

**Closing the round**: `shot_land({message:'Rxx: …'})` shows a plan first (**dryRun by default**);
`{dryRun:false}` really commits and pushes. It refuses to commit when the selftests are red.

```bash
node .tools/dsh-shot-smoke.mjs          # 496 项：文件/清单/两端契约/覆盖层/接线/PowerShell 静态体检/宿主可加载
node .tools/dsh-shot-smoke.mjs --live   # 再加真抓屏 + 真 OCR（沙箱里会 SKIP，见坑 2）
```

Regression of the host side + real windows (**must run inside the host process**; messages cannot be injected from the sandbox):

```
host_selfcheck({plugin:'dsh-screenshot'})                                        # 全量，77 项 / FAIL 必须 0
host_selfcheck({plugin:'dsh-screenshot', script:'dev/all-probes-hostrun.mjs'})    # 真 runner 跑一遍聚合（改完 lib/probes.mjs、重启前用）
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-target-probe.mjs'})    # 6 项：投递滚轮投给谁
host_selfcheck({plugin:'dsh-screenshot', script:'dev/hide-self-probe.mjs'})        # 11 项：真藏一次 + 还原 + 几何不变
```

> ⚠️ **"Guessed waits" are the biggest source of false reds in this project's probes** (R35 closed three of them at once):
> the overlay helper takes **~10 s** to cold start (measured `readyMs:10205`), the recording frame's canary has to wait for the window to write Info itself,
> and the wheel fixture has to grab the foreground so DSH does not cover it. All three were changed to **wait for a measured readiness signal** (`overlayStatus().ready` /
> `waitForFile(info)` / `AttachThreadInput` and then `SetForegroundWindow`); fixed sleeps are always unreliable.


`hide-self-probe` **really hides the DSH window for about 1.5 seconds** (the overlay is covering the screen at that moment, so it is invisible),
to verify both halves, "hide" and "restore"; it also proves that restoring **does not change the window's placement** (using `SW_RESTORE` quietly turns
a maximized window back into a normal-sized one).

```
host_selfcheck({plugin:'dsh-screenshot', script:'dev/recframe-probe.mjs'})         # 12 项：录屏框在屏幕上的像素级证据
host_selfcheck({plugin:'dsh-screenshot', script:'dev/probe-selftest.mjs'})         # 33 项：像素库/探针库自检（1 秒，确定性）
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-App','qt']})                                              # Qt 认不认投递滚轮
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-App','java']})                                            # Java(Swing) 认不认
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-Title','记事本']})                                        # 任何已开着的应用
```

## Orphaned DOM after a client hot reload (R38)

When the client half is hot-reloaded, **the old module is gone** — the nodes it appended to
`body` (overlay root, colour palette, recording pill, panels, menus, pinned images) are never
collected, and after a few reloads the page shows "clicks do nothing / something covers it".
The only cure used to be refreshing the page.

Now every load gets a **generation**; all long-lived nodes go through `mountBody` and carry
`data-dshot-gen`, and a load **sweeps every other generation** (that attribute only — official
DOM is never touched). `__dshotDebug` exposes `gen` / `swept` / `sweep()`, so it can be verified
live through the bridge; smoke also runs a **fake-DOM behavioural test** (stale removed, current
kept, untagged untouched), so the logic is not protected by substring checks alone.

## Region recording (R32)

**By default the user is asked to select a region**, rather than recording the whole screen: recording something that should not be recorded costs more, and "select a region" used to be hidden
on the tenth-something line of the right-click menu, where almost nobody knew it existed. "Recording range: select a region each time / whole desktop" in the menu switches it back,
and the choice is remembered.

Four things that are easy to overlook but each make this feature "look broken":

1. **Odd width/height kills ffmpeg on the spot** (`width not divisible by 2`, leaving a 0-byte file).
   Drag-selecting by hand very easily yields 801×601, so the host **rounds the width and height down to even numbers** and **reports the actual recorded size in the receipt** —
   the client shows the real 800×600 being recorded, not the number the user dragged.
2. **A selected region smaller than 2×2 is an explicit error**, never "then record the whole screen" (that would record the entire desktop).
3. **A red frame is drawn on screen** (`ps/recframe.ps1`) showing which region is being recorded — once the selection overlay closes,
   nothing else on screen can indicate where the boundary is. The red frame is drawn **outside the capture rectangle**, so it never ends up in the video;
   internally it is **cut out with a window region** (the version using `TransparencyKey` measured zero pixels shown on screen).
   If the frame fails to come up, recording is unaffected.
4. **The frame must be torn down when recording ends**: `record('stop')` writes the stop signal first and then kills the process; a leftover red frame is worse than not drawing one at all.

## Recording audio (R41)

**Menu → more settings → "record audio"**. Off by default: capturing a microphone has privacy
implications, so a default-on switch would record the room without the user knowing. Turning it on
asks the host for the device table first — **with no microphone the switch refuses to turn on and
says why**; with one it names the device it will use (the pill shows `🎙 audio` / `muted`, the result
panel shows `audio` / `⚠ no audio (not captured)`).

Before R41 this feature was **dead code split across both halves**, and neither half reported anything:

| Half | Old code | Effect |
|---|---|---|
| `client.js` | hardcoded `record('start', {audio: false, …})` | never requested sound |
| `lib/shot.mjs` | hardcoded `-i audio=virtual-audio-capturer` | that virtual sound card does not exist here, so audio could never start |

The chain now: `listCaptureDevices()` (`ffmpeg -list_devices -f dshow`) → `resolveAudioDevice()`
(exact name / ASCII alternative match; **empty want = ranked auto**: microphone (narration) first,
then system audio `stereo mix / loopback`, else the first audio device — the ranking exists so the
choice does **not** depend on the order the OS happens to list devices in) →
`-i audio=<real device name>` + explicit `-map 0:v:0 -map 1:a:0` + `-c:a aac`.

Three **invariants**, proven live by `dev/record-audio-probe.mjs` (23 assertions):

1. **A mic present must mean a real audio stream**: `hasAudio` in `record('stop')` comes from
   `ffprobe` via `rec.ps1 info`, not from "the user asked for sound";
2. **A missing or misspelled device must never fail the recording**: it continues silently and the
   reply carries `audio:false` plus the `audioWarning` text, which the client must surface (a silent
   downgrade means the user discovers the whole take is mute afterwards);
3. **A device that cannot open (exclusive lock / driver hiccup) retries once without audio** — only
   `dshow|audio|device`-class errors downgrade; video-side errors such as a region off-screen must
   not be hidden behind "record it silently".

> Device enumeration is **not** judged by the exit code: `-list_devices` has no real input and exits 1
> even when nothing is found, so the only trustworthy signal is "devices were parsed". And `(none)`
> does not mean "no device" — ffmpeg on this machine uses it to tag **video** devices.

## Recording result panel: why "extracting a frame" fails (R33)

A user's field report: recorded 7.3 seconds, the panel showed **0 KB**, the "current frame" was blank, and it reported `moov atom not found`;
switching to a normal recording, the panel then reported `frame produced no file`. Two root causes:

1. **`ffmpeg -ss <t>` past the end = exit code 0 and no output file** (not an error!). The panel by default grabs the first preview frame at
   `duration - 0.05`, and the duration used is **wall-clock**, which is often a few tens of milliseconds past the file's real end.
   Now: duration prefers the file's own (`ffprobe`); when "no file was produced", `Invoke-Frame` falls back in turn to
   `-sseof -0.4` (0.4 seconds before the end of the file) and `t = 0` — if it can't get a frame near the end it takes a step back instead of declaring failure.
2. **A 0-byte recording used to be treated as success** (the file exists, `recordStop` returns ok), so the UI opened a
   panel that was "guaranteed to fail frame extraction", which looked like screenshot/recording was entirely broken. Now `recordStop` finds
   `bytes === 0` or a 0 duration and **errors out directly**, bringing out the tail of ffmpeg's stderr — that sentence is the clue
   that can be tracked down next time.

## Where posted wheel messages apply (measured in R32)

The auto long screenshot does not move the mouse; it does `PostMessage(WM_MOUSEWHEEL)` to **the leaf control under the point**. Measured:

| App type | Message sent to | Result |
|---|---|---|
| WinForms | leaf TextBox | ✅ first visible line 0 → 3 (R29) |
| Chromium (DSH itself) | leaf | ✅ scrollTop 180 → 349.6 (R29) |
| **Qt 5.15** | top level (Qt is one HWND per window) | ✅ scrollbar 0 → 9 |
| **Java Swing (JDK 17)** | top level (Swing is one HWND per window) | ✅ scrollbar 0 → 189 |

⚠️ The criterion for these two rows is **the scrollbar value recorded by the program under test itself**, not "did the picture change" — every row of
the fixture looks the same, so after scrolling the pixels hardly change (measured pixel diff 0.0%); looking only at the picture leads to the wrong conclusion "it did not scroll".

After changing `ps/*.ps1` you must **restart DSH**: the capture helper reads the script once at the moment it executes and never re-reads it afterwards.
(`host_selfcheck` runs in a separate node process, and the helper it starts dies with it, so it cannot replace the application's one —
`dev/refresh-shooter.mjs` can supply evidence of "which helper belongs to whom". **The overlay helper is the exception**: it watches its own
`.ps1` and exits and respawns itself after a change.)

Verify the annotation UI by really clicking and drawing in a browser:

```bash
node .tools/devserver.mjs 8934 "$DSH_WORKSPACE"
# 打开 http://127.0.0.1:8934/DSH-Plugin/dsh-screenshot/dev/harness.html
```

`dev/harness.html` **cuts the overlay part out of client.js and evals it** — so what is verified is exactly the code that really ships inside DSH.
(Why inline rather than import: the official client modules only serve declared chunks, so arbitrary paths cannot be fetched.)

## Wiring

```bash
node .tools/dsh-plugin-install.cjs install dsh-screenshot "$DSH_WORKSPACE\DSH-Plugin\dsh-screenshot"
# 沙箱下 symlink 会 EPERM，改用 cmd /c mklink /J + node .tools/_add-bundle.cjs
```

After changing the host side you **must restart DSH Desktop** (the Electron host does not consume `patchReload: live`).


## Applicable profile

This plugin targets DSH's `desktop` profile. It is already loaded under the `desktop` profile on this machine (`.dsh/profiles/desktop`). The plugin package itself contains no profile configuration; you can substitute your own profile name.

## Installation (DSH command line)

```bash
# <profile> 换成你的 profile 名，本机为 desktop
dsh plugin --profile desktop add <本目录或包名>
```

Equivalent offline way: append the `insert` line from this repo's `cordis.patch.yml` to your machine's profile
`cordis.patch.yml`. **After changing `cordis.patch.yml` you must restart DSH** (Desktop does not watch the patch layer).

## External dependencies and permissions

- Where it runs: the DSH host process (Node side) or the browser side, **requires local file read/write permission** (some tools read and write files inside the workspace).
- External commands: `powershell.exe` + .NET (screen capture is done on the host side)
- Environment variables (optional, used to override defaults; values are not written into the repo): `DSH_SHOT_DIR`, `DSH_SHOT_CACHE`, `DSH_OVERLAY_DIR`, `DSH_SHOT_HELPER`, `DSH_SHOT_HELPER_MS`, `DSH_SHOT_MAX_TOTAL_HEIGHT`, `DSH_SHOT_OVERLAY`
- Listening port: none

## Known limitations

- **Only measured on local Windows + the DSH `desktop` profile**; other platforms/versions are unverified.
- The auto mode of the long screenshot **prefers posting wheel messages** (without moving the cursor), and decides based on "did the next frame change". The message must go to
  **the control under the point**: when sent to the top-level window, Chromium honours it but **WinForms and other legacy applications do not**
  (measured: the top-level form only triggers its own MouseWheel and the content does not scroll; sending to the leaf from `WindowFromPoint` does scroll).
  When it is not honoured, it automatically degrades to moving the cursor. The self-drawn scroll containers of Qt / Java / Electron are **not yet measured one by one**.
- **The clipboard is an exclusive machine-wide resource**: if another program is holding it, copying a screenshot will fail (measured error: "the requested clipboard operation failed").
  The helper retries 4 times; if it still fails, **the client explicitly says "the copy did not succeed" and leaves diagnostics**; it will not pretend to have copied.
- "Hide the DSH UI while capturing" finds the window by **title** (`DeepSeek Harness` substring match); if the window title is changed beyond
  recognition, it simply does not hide (the screenshot proceeds as usual) and does not error.
- Private backup repo: `node_modules`, runtime caches, debug dumps and backup files are excluded per `.gitignore`; to reproduce a run, please `npm install` yourself (if there are dependencies).
- `$DSH_WORKSPACE`, `$TK_ROOT`, `%USERPROFILE%` and the like in the docs are **placeholders** and must be replaced with actual paths on your machine before use.

## License

MIT, see [LICENSE](LICENSE). The licences of third-party code, fonts, icons or data must be checked separately (see the notes in the repo).
