# dsh-screenshot · DSH Screenshot Plugin

[中文](README.md)


QQ-style screenshot; the button sits **next to the Voice button of the chat input box** (`conversation.input.left` slot, order `-90`).

## Capabilities

| Menu item | Description |
|---|---|
| ✂ Screenshot | **Always select the region in the native overlay** (a real full-screen window in its own process that can cover other apps) → annotate → **paste into the input box + copy to the clipboard** |
| ⏺ Record | ffmpeg gdigrab recording (H.264 + faststart). **By default you select a region first, then record** (see below); a red frame marks the boundary on screen, and you click Stop in the timer capsule at the top-right corner to finish |
| Aa Extract text | after selecting a region, **offline OCR** (the engine built into Windows, nothing leaves this machine) produces a text panel you can copy from / paste into the input box |
| 译 Screen translation | after OCR, the text (with a translation instruction prefix) is pasted into the input box and handed to DSH's own model to translate |
| ⇕ Long screenshot | select a region → the host scrolls one screen and grabs one frame → overlapping areas are aligned and stitched → the long image returns to the annotation UI |
| ☐ Hide DSH UI while capturing | the native overlay hides the DSH window **before freezing the desktop** (same as QQ), and after you finish or cancel it is restored and brought back to the foreground; off by default, tick it in "More settings" |

> **R33 removed the four items "Range / Pick a window to capture / Select your own region / Capture method"**, along with the whole scheme of rendering desktop screenshots inside the DSH window (canvas + DOM overlay). It could only cover DSH's own window, and at 125% scaling it could only select a patch in the top-left corner of the screen — keeping it around meant "it looks like it works, but you can't select what you want". The only entry point now is the native overlay; when it is unavailable the plugin **says so** ("restart DSH once") instead of quietly falling back to the degraded UI. The old
> `range/method/pickHwnd/pickTitle/nativeOverlay` settings are cleared once by the `prefsVer` migration.

Annotation tools: rectangle / ellipse / arrow / pen / text / mosaic, eight colors + thickness slider, undo/redo (cursor model),
Enter to finish, Esc to cancel, Ctrl+Z/Y, Ctrl+C, Ctrl+S, Ctrl+A select all, double-click for full screen.
There is also **pinning** (pins the image onto the UI; drag to move, Ctrl+wheel to zoom).

Hotkeys: `Ctrl+Alt+A` screenshot, `Ctrl+Alt+O` extract text.

## Why screen capture always has to live on the host side

The renderer process **cannot get the screen**: the official main session has no `setDisplayMediaRequestHandler`, and the permission handler only allows
the microphone (verified file by file in `/lib/main.js`), so `getDisplayMedia()` gets no source at all.
That is why the host side uses PowerShell/.NET:

- `System.Drawing.Graphics.CopyFromScreen` → whole screen (automatically covers the multi-monitor virtual
