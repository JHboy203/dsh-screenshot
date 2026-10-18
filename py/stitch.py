# -*- coding: utf-8 -*-
"""Stitch a scrolling (long) screenshot from overlapping frames.

    python py/stitch.py --out long.png [--overlap-min 40] [--scale-width 160] frame1.png frame2.png ...

How it works
    Each frame is the same screen region after one wheel scroll, so frame[i+1]'s top
    row equals frame[i]'s row `s` for some shift `s`. We search `s` by minimising the
    mean absolute difference of the overlap, then append rows [s, H) of each frame.

Speed note
    The search runs on width-downscaled grayscale images and uses
    ImageChops.difference + histogram (both C loops) instead of pixel loops in
    Python: ~400 candidate shifts cost a fraction of a second. No numpy needed.

Prints one JSON line: {"width":W,"height":H,"frames":N,"offsets":[...]}
ASCII only (console is GBK).
"""
from __future__ import annotations

import json
import sys

from PIL import Image, ImageChops

SCALE_WIDTH = 160
OVERLAP_MIN = 40


def signature(path, scale_width):
    """Grayscale, width-downscaled copy for the overlap search."""
    im = Image.open(path).convert("L")
    w, h = im.size
    if w > scale_width:
        im = im.resize((scale_width, max(1, int(round(h * scale_width / float(w))))), Image.BILINEAR)
    return im


def mean_abs_diff(a, b):
    """Mean absolute difference of two same-size grayscale images (C speed)."""
    diff = ImageChops.difference(a, b)
    hist = diff.histogram()
    total = 0
    count = 0
    for value, n in enumerate(hist):
        if n:
            total += value * n
            count += n
    return float(total) / float(count or 1)


def find_shift(prev, cur, overlap_min):
    """How far the content moved up between two frames (in downscaled pixels)."""
    w, h = prev.size
    best = None
    for s in range(overlap_min, max(overlap_min + 1, h - 8)):
        a = prev.crop((0, s, w, h))
        b = cur.crop((0, 0, w, h - s))
        if a.size[1] < 8:
            break
        score = mean_abs_diff(a, b)
        if best is None or score < best[1]:
            best = (s, score)
    if best is None:
        return h
    return best[0]


def main(argv):
    out = None
    overlap_min = OVERLAP_MIN
    scale_width = SCALE_WIDTH
    files = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            i += 1
            out = argv[i]
        elif a == "--overlap-min":
            i += 1
            overlap_min = int(argv[i])
        elif a == "--scale-width":
            i += 1
            scale_width = int(argv[i])
        else:
            files.append(a)
        i += 1

    if out is None or len(files) < 2:
        print("usage: stitch.py --out long.png [--overlap-min 40] a.png b.png ...", file=sys.stderr)
        return 2

    frames = [Image.open(f).convert("RGB") for f in files]
    width, height = frames[0].size
    sigs = [signature(f, scale_width) for f in files]
    ratio = float(height) / float(sigs[0].size[1]) if sigs[0].size[1] else 1.0

    # offsets[k] = 第 k+1 帧相对第 k 帧**上移了多少像素**（= find_shift 的约定，
    # 也是 JSON 里报出去的那个数）。于是：
    #   重叠行数 = height - s   ← 第 k+1 帧开头这 (height-s) 行已经画过了，丢掉
    #   新增行数 = s            ← 接在画布后面的就是这么多
    # ⚠️ 这两个量以前被写反了（把 s 当重叠用）：结果高度多算 2*(height-2s)，画面上
    #    中间多出一条重复带。400x300、滚动 120 的三帧拼出来是 660（应为 540）。
    #    合成用例见 .tmp-vision/mkstitch.py + .tools/dsh-stitch-check.py。
    offsets = []
    for k in range(1, len(frames)):
        s_small = find_shift(sigs[k - 1], sigs[k], max(4, int(round(overlap_min / ratio))))
        s = int(round(s_small * ratio))
        s = max(1, min(height - 1, s))
        offsets.append(s)

    total = height + sum(offsets)
    canvas = Image.new("RGB", (width, total))
    y = 0
    canvas.paste(frames[0], (0, 0))
    y += height
    for k, s in enumerate(offsets):
        part = frames[k + 1].crop((0, height - s, width, height))
        canvas.paste(part, (0, y))
        y += s

    canvas.save(out)
    print(json.dumps({"width": width, "height": total, "frames": len(frames), "offsets": offsets}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
