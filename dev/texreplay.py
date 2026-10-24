# -*- coding: utf-8 -*-
"""Build a LONG PAGE out of a REAL screen capture, then cut known frames from it (R63).

    python dev/texreplay.py build --src screen.png --out <dir> --mode scroll|anim|dup|gap
           [--width 660] [--height 520] [--shift 237] [--frames 10] [--seed 7]
    python dev/texreplay.py compare --a out.png --b page.png --max-y 2653 [--drop-cols 360,620]

WHY THIS EXISTS
    Every stitcher test so far used a fixture painted with COLOUR BANDS (dev/longshot-backdrop.ps1
    and the synthetic cases mentioned in py/stitch.py's header). Bands are the friendly case: most
    rows carry no ink at all, the overlap landscape is smooth, and a seam that is off by a few
    pixels still scores ~0. Real pages are the opposite -- every row is dense anti-aliased text, so
    the residual rises everywhere and the search has to pick the right minimum out of many similar
    ones. R61 shipped the ROBUST fallback (trimmed_score) on band fixtures only, and its own
    handoff says "real page texture is much denser, worth a replay-style check". This is that.

    The page is NOT drawn: it is cut out of a real capture (the DSH window is a real, dense,
    anti-aliased UI), so the texture is genuine font AA and real UI chrome. The LAYOUT is ours, and
    that is the point -- it gives exact ground truth:
      * page    = one distinct 660 px wide crop per source slice, concatenated. No region repeats,
                  so a wrong offset cannot score ~0 by coincidence.
      * frame k = page.crop(0, ys[k], width, ys[k]+height)  -> the true shift of a pair is exactly
                  ys[k]-ys[k-1].
    A stitcher that lands every offset exactly reproduces the page PIXEL FOR PIXEL, which is a much
    stronger assertion than "each colour band is 79 px".

MODES (the four things the product has to do with dense texture)
    scroll  plain scrolling, nothing animated   -> no pair may need the robust fallback
    anim    one 220x130 patch at a FIXED screen position repaints every frame (video / spinner)
            -> plain scoring must fail at the true shift, the robust pass must recover it exactly
    dup     like `anim` plus one last frame where NOTHING scrolled and only the patch changed
            -> that frame must be skipped (offset 0, skipped+1), never stitched in
    gap     two frames farther apart than one frame height (the capture jumped)
            -> must be refused (exit 3, no output file), never guessed into a picture

OUTPUT
    <dir>/page.png            ground truth page
    <dir>/frames/f00.png ...  the frames (what the product would have captured)
    <dir>/truth.json          {mode,width,height,shift,offsets[],total,frames[],page,density}
    One JSON line on stdout (build / compare). ASCII only -- the console is GBK.

    Exit codes: 0 ok / 2 usage or bad args / 4 the SOURCE cannot serve as a fixture, with
      {"error":"flat-source"}      (nothing to read: locked desktop, capture while minimised)
      {"error":"repetitive-source"} (dense but self-similar: the slices are the same picture, so the
                                     stitcher correctly calls the frames duplicates -- see
                                     MIN_SEPARATION; measured 15.8 on a locked logon screen).
    A caller should report exit 4 as ENV-BLOCKED, not as a failed product check.

The patch is deterministic per (seed, k): pseudo random grey levels, i.e. it stands in for anything
that REPAINTS. Measured on this machine: it puts the plain residual at ~12.9 (over MATCH_TOL 8.0,
so the fallback is really exercised) while the trimmed score at the true shift is ~6.4 -- the ratio
DYN_KEEP=0.7 in the product was designed for.
"""
from __future__ import annotations

import json
import os
import random
import sys

from PIL import Image, ImageChops, ImageStat


def row_variance(im):
    """How much the rows of a candidate crop differ from each other (a density proxy).

    Downscaled first: the question is "is this slice of the screen dense at all", not a precise
    statistic, and a full 660x1080 python loop per candidate would cost more than it is worth.
    """
    small = im.convert("L").resize((64, 96), Image.BILINEAR)
    px = list(small.getdata())
    n = float(len(px)) or 1.0
    mean = sum(px) / n
    return sum((v - mean) ** 2 for v in px) / n


def pick_crops(src, width, need, min_gap=None):
    """Choose distinct x offsets whose crops are the densest part of the capture.

    Two requirements, both measured rather than assumed (R63 first run):
      * dense  -- a crop of empty desktop would make the replay look easy and prove nothing;
      * distinct -- the two failure classes are separated by `min_gap`:
            min_gap = width  (distinct): slices never overlap, so the page holds no near-duplicate
                     region. This is the fair fixture: it asks "does dense texture break the
                     stitcher", nothing else.
            min_gap = 160    (overlap):  the old accident, kept on purpose. Two 660 px wide crops
                     taken 240 px apart contain nearly the SAME windows, so the page has a
                     near-duplicate region and a wrong offset can beat the true one. That is the
                     ambiguous-content case, and the product must then either land the true offset
                     or refuse -- never emit a plausible wrong seam (R58 principle).
    """
    sw, sh = src.size
    gap = width if min_gap is None else min_gap
    if sw < width + 80:
        return []
    scored = []
    for x in range(40, sw - width - 40 + 1, 20):
        scored.append((row_variance(src.crop((x, 0, x + width, sh))), x))
    scored.sort(reverse=True)
    picks = []
    for _var, x in scored:
        if any(abs(x - p) < gap for p in picks):
            continue
        picks.append(x)
        if len(picks) >= need:
            break
    picks.sort()
    return picks


def choose_geometry(src, need_px, preferred=(660, 600, 540, 480, 420, 360), min_gap=None):
    """Widest region width that still yields enough distinct slices.

    1920 px of screen does not hold many 660 px wide non-overlapping crops; narrowing the region
    is free here (the stitcher is width-agnostic: the edge margin is a fraction of the width) and
    keeps the frame count -- and therefore the number of seams under test -- the same.
    """
    n_slices = int(need_px / float(src.size[1])) + 1
    for width in preferred:
        picks = pick_crops(src, width, n_slices, min_gap)
        if len(picks) >= n_slices:
            return width, picks
    return 0, []


def mean_abs_diff(a, b):
    """Mean absolute grey difference of two same-size images (C speed)."""
    diff = ImageChops.difference(a.convert('L'), b.convert('L'))
    return float(ImageStat.Stat(diff).mean[0])


# How different two neighbouring page slices must be, or the fixture is not about the stitcher.
# Measured: a LOCKED Windows session gives 15.4 / 15.8 (dark logon screen: the slices are the same
# wallpaper), a real desktop with windows gives 39.1 / 60.8. On a near-repeating page the stitcher
# correctly decides the frames are duplicates, and the arm then fails for a reason that says
# nothing about the product -- so this is an environment gate (exit 4), not a red.
MIN_SEPARATION = 20.0


def slice_separation(src, width, picks):
    """Median mean-abs-diff between consecutive slices of the page (self-similarity proxy)."""
    vals = []
    for i in range(1, len(picks)):
        a = src.crop((picks[i - 1], 0, picks[i - 1] + width, src.size[1]))
        b = src.crop((picks[i], 0, picks[i] + width, src.size[1]))
        vals.append(mean_abs_diff(a, b))
    if not vals:
        return 0.0
    vals.sort()
    return vals[len(vals) // 2]



def build_page(src, width, need_px, picks):
    """Concatenate one crop per pick; None when the source cannot cover need_px."""
    page_h = len(picks) * src.size[1]
    if page_h < need_px:
        return None
    page = Image.new("RGB", (width, page_h))
    y = 0
    for x in picks:
        page.paste(src.crop((x, 0, x + width, src.size[1])), (0, y))
        y += src.size[1]
    return page


def paint_patch(frame, rng, patch):
    """Repaint the fixed-position patch with fresh pseudo random grey levels."""
    w, h = patch["w"], patch["h"]
    px = Image.new("RGB", (w, h))
    px.putdata([(v, v, v) for v in [rng.randrange(256) for _ in range(w * h)]])
    frame.paste(px, (patch["x"], patch["y"]))
    return frame


def frame_positions(mode, n, height, shift):
    """Absolute y of every frame inside the page (the ground truth)."""
    ys = []
    for k in range(n):
        if mode == "gap":
            ys.append(0 if k == 0 else height + shift)
        elif mode == "dup" and k == n - 1:
            ys.append(ys[k - 1])
        else:
            ys.append(k * shift)
    return ys


def cmd_build(argv):
    args = {
        "src": "",
        "out": "",
        "mode": "scroll",
        "width": 660,
        "height": 520,
        "shift": 237,
        "frames": 10,
        "seed": 7,
        "slices": "distinct",
    }
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            key = a[2:].replace("-", "_")
            if key in ("width", "height", "shift", "frames", "seed"):
                i += 1
                args[key] = int(argv[i])
            elif key in ("src", "out", "mode", "slices"):
                i += 1
                args[key] = argv[i]
            else:
                print(json.dumps({"ok": False, "error": "unknown option " + a}))
                return 2
        i += 1
    if args["src"] == "" or args["out"] == "" or not os.path.isfile(args["src"]):
        print(json.dumps({"ok": False, "error": "need --src <png> --out <dir>"}))
        return 2

    width = args["width"]
    height, shift, seed, mode = args["height"], args["shift"], args["seed"], args["mode"]
    if mode not in ("scroll", "anim", "dup", "gap"):
        print(json.dumps({"ok": False, "error": "bad mode " + mode}))
        return 2
    n = 2 if mode == "gap" else args["frames"]
    if n < 2:
        print(json.dumps({"ok": False, "error": "need --frames >= 2"}))
        return 2

    src = Image.open(args["src"]).convert("RGB")
    ys = frame_positions(mode, n, height, shift)
    need_px = max(ys) + height + 240
    if args["slices"] not in ("distinct", "overlap"):
        print(json.dumps({"ok": False, "error": "bad --slices " + args["slices"]}))
        return 2
    min_gap = None if args["slices"] == "distinct" else 160
    preferred = [width] + [w for w in (660, 600, 540, 480, 420, 360) if w < width]
    width, picks = choose_geometry(src, need_px, tuple(preferred), min_gap)
    if not picks:
        print(json.dumps({"ok": False, "error": "source too narrow for a %d px page" % need_px}))
        return 2
    # Density gate: an empty/black screen (locked desktop, capture taken while minimized) must not
    # be reported as "dense texture handled" -- it is dense texture or nothing.
    density = 0.0
    for x in picks:
        density = max(density, row_variance(src.crop((x, 0, x + width, src.size[1]))))
    if density < 120.0:
        print(json.dumps({"ok": False, "error": "flat-source", "density": round(density, 1)}))
        return 4
    # Self-similarity gate. Density alone is not enough: a LOCKED session is dense enough (15.4
    # slice separation measured on the dark logon screen) but its slices are the same wallpaper,
    # so the page is near-repeating and the stitcher correctly calls the frames duplicates -- the
    # arm would then go red for a reason that says nothing about the product. See MIN_SEPARATION.
    separation = slice_separation(src, width, picks)
    if separation < MIN_SEPARATION:
        print(json.dumps({"ok": False, "error": "repetitive-source", "separation": round(separation, 1)}))
        return 4

    page = build_page(src, width, need_px, picks)
    if page is None:
        print(json.dumps({"ok": False, "error": "page too short", "picks": picks, "need": need_px}))
        return 2

    frames_dir = os.path.join(args["out"], "frames")
    if not os.path.isdir(frames_dir):
        os.makedirs(frames_dir)
    page_path = os.path.join(args["out"], "page.png")
    page.save(page_path)

    patch = {"x": max(20, min(380, width - 240)), "y": 250, "w": 220, "h": 130}
    animated = mode in ("anim", "dup") or (mode == "gap" and True)
    files = []
    for k in range(n):
        frame = page.crop((0, ys[k], width, ys[k] + height)).copy()
        if animated:
            # A separate RNG per (seed, k): deterministic, and different frames really differ.
            paint_patch(frame, random.Random(seed * 1000 + k), patch)
        path = os.path.join(frames_dir, "f%02d.png" % k)
        frame.save(path)
        files.append(path)

    offsets = [ys[k] - ys[k - 1] for k in range(1, n)]
    truth = {
        "ok": True,
        "mode": mode,
        "width": width,
        "height": height,
        "shift": shift,
        "offsets": offsets,
        "total": height + sum(offsets),
        "frames": files,
        "page": page_path,
        "patch": patch,
        "src": args["src"],
        "picks": picks,
        "slices": args["slices"],
        "density": round(density, 1),
    }
    with open(os.path.join(args["out"], "truth.json"), "w") as fh:
        fh.write(json.dumps(truth))
    print(json.dumps({k: v for k, v in truth.items() if k != "frames"}))
    return 0


def cmd_compare(argv):
    a_path, b_path, max_y, drop = "", "", 0, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--a", "--b", "--max-y", "--drop-cols"):
            i += 1
            v = argv[i]
            if a == "--a":
                a_path = v
            elif a == "--b":
                b_path = v
            elif a == "--max-y":
                max_y = int(v)
            else:
                lo, hi = v.split(",")
                drop = (int(lo), int(hi))
        i += 1
    if a_path == "" or b_path == "" or not os.path.isfile(a_path) or not os.path.isfile(b_path):
        print(json.dumps({"ok": False, "error": "need --a <png> --b <png> --max-y <rows>"}))
        return 2
    a_img = Image.open(a_path).convert("RGB")
    b_img = Image.open(b_path).convert("RGB")
    rows = min(max_y if max_y > 0 else a_img.size[1], a_img.size[1], b_img.size[1])
    w = min(a_img.size[0], b_img.size[0])
    diff = ImageChops.difference(a_img.crop((0, 0, w, rows)), b_img.crop((0, 0, w, rows)))
    if drop is not None:
        # Columns painted by the animated patch are the ONE allowed difference: the product is not
        # asked to invent content under something that repaints. Zeroing them makes them "match".
        diff.paste(Image.new("RGB", (drop[1] - drop[0], rows), (0, 0, 0)), (drop[0], 0))
    hist = diff.convert("L").histogram()
    diff_px = sum(hist[1:])
    max_diff = 0
    for v in range(255, 0, -1):
        if hist[v]:
            max_diff = v
            break
    print(json.dumps({
        "ok": True,
        "same": diff_px == 0,
        "diffPixels": diff_px,
        "totalPixels": w * rows,
        "maxDiff": max_diff,
        "width": w,
        "rows": rows,
    }))
    return 0


def main(argv):
    if len(argv) < 1:
        print("usage: texreplay.py build|compare ...", file=sys.stderr)
        return 2
    cmd = argv[0]
    if cmd == "build":
        return cmd_build(argv[1:])
    if cmd == "compare":
        return cmd_compare(argv[1:])
    print(json.dumps({"ok": False, "error": "unknown command " + cmd}))
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
