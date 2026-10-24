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

Prints one JSON line: {"width":W,"height":H,"frames":N,"offsets":[...],"scores":[...],"skipped":N}
On a frame pair that does NOT overlap it prints an error JSON line to stderr and exits 3 --
it must never emit a plausible-looking wrong picture (R58 measured exactly that: +479 px of
duplicated content, silently, from frames that never overlapped).

ASCII only (console is GBK).
"""
from __future__ import annotations

import json
import os
import sys

from PIL import Image, ImageChops

SCALE_WIDTH = 160
OVERLAP_MIN = 40
# Two frames this similar are the SAME picture: a blinking caret, a ticking clock, a cursor.
# Measured on the R58 fixture: an identical frame pair scores 0.00, a real scroll scores > 20.
DUP_TOL = 1.0
# Best-overlap residual above this = "these frames do not overlap at all", not a bad match.
MATCH_TOL = 8.0
# Edge chrome (R59): a scrollbar THUMB, a resize grip or a fixed overlay sitting on the edge of
# the captured region MOVES (or re-renders) between frames, so those columns never match -- and
# the overlap search then fails or lands on a wrong offset. Measured on the R58 fixture with the
# scrollbar visible: 131 of 283 rows differed even at the TRUE shift, and the coarse match picked
# 475 px for a pair that truly moved 237 px. The signature therefore ignores the outer edge.
MARGIN_FRAC = 0.06
MARGIN_MIN = 6
MARGIN_MAX = 40
# ⚠️ Two "clever" robustifiers were tried here and BOTH are wrong -- do not rebuild them:
#   ① trim the worst 10 % of PIXELS: on the luma-band fixture a 6 px wrong offset only mismatches
#      the ~2 % of pixels near band boundaries, so the score read 0.00 at 230 px AND at 237 px;
#      the argmin then returned the smallest offset of that plateau (231 px per seam, not 237).
#   ② trim the worst 25 % of COLUMNS: same idea, and PIL cannot even give exact column means
#      cheaply -- `resize((1, h), BOX)` at a 286:1 reduction SAMPLES instead of averaging (an
#      all-zero diff with 7344 non-zero pixels reduces to 0), so the score silently went flat.
# Keeping the plain mean over edge-trimmed columns is the version that stays sharp: measured
# 0.00 at the true shift vs 0.36 at +3 px and 0.75 at -6 px on the synthetic case.


def margins(width):
    """How many columns to ignore on each side of the captured region."""
    m = int(round(width * MARGIN_FRAC))
    m = max(MARGIN_MIN, min(MARGIN_MAX, m))
    if width - 2 * m < 24:
        m = max(0, (width - 24) // 2)
    return m


def signature(path, scale_width, margin=0):
    """Grayscale, width-downscaled copy for the overlap search (edge columns dropped)."""
    im = Image.open(path).convert("L")
    w, h = im.size
    if margin > 0 and w - 2 * margin >= 16:
        im = im.crop((margin, 0, w - margin, h))
        w = im.size[0]
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


# Dynamic content INSIDE the region (R61): a video, a spinner, a ticking clock. It stays at the
# same SCREEN position while the content scrolls under it, so at the TRUE shift that band of rows
# disagrees forever and the residual ("do these frames overlap at all?") blows past MATCH_TOL --
# measured on the fixture with a 220x130 block repainting every 90 ms: residual 12.60 > 8.00, i.e.
# a perfectly good long capture was refused even though ~92 % of the picture matched.
# What works: score the mean of the BEST 70 % of ROWS (trimmed_score). On the real animated pair
# that is 3.54 at the true shift vs 5.35 / 5.72 one step either side, and at full resolution
# 2.70 at 237 px vs 3.31 / 3.35 at 236 / 238 -- sharp enough to keep the seams exact.
# ⚠️ Two other attempts measured worse and were dropped:
#   ① subtract a BBOX of the disagreeing pixels: the box is only valid for the shift it was
#      measured at, and on a small overlap it leaves too little to score (best masked score 14.87
#      at a WRONG shift looked better than 12.60 at the true one);
#   ② subtract row bands found at ZERO shift: those are "where the content moved", not "where
#      something animates", so on a scrolling page the band covers the whole overlap (the mask
#      then eats ~half the picture and the landscape goes flat).
# Trimming PIXELS or COLUMNS (R59) is also wrong -- it flattens the landscape. Rows are fine.
DYN_KEEP = 0.7


def row_means(diff, scale=8):
    """Mean difference of every ROW (one NUMBER per row, C speed).

    PIL's resize to width 1 uses the BOX filter, which TRUNCATES: a row whose mean is 0.8 comes
    back as 0 (that is what made an earlier attempt look like "an all-zero diff with 7344
    non-zero pixels"). Multiplying first keeps integers large enough; divide afterwards.
    """
    boosted = diff.point(lambda v: 255 if v * scale > 255 else v * scale)
    col = boosted.resize((1, diff.size[1]), Image.BOX)
    return [v / float(scale) for v in col.getdata()]


def trimmed_score(a, b, keep=DYN_KEEP):
    """Mean abs diff over the BEST `keep` share of rows (drop the worst ones).

    An animated band of rows disagrees at every candidate shift; dropping the worst 30 % of rows
    keeps it out of the score, and on real content the landscape stays sharp to +-1 px.
    """
    means = row_means(ImageChops.difference(a, b))
    if not means:
        return float("inf")
    means.sort()
    n = int(len(means) * keep)
    if n < 4:
        n = len(means)
    return sum(means[:n]) / float(n)


def localized_change(a, b, tol=16, max_frac=0.35):
    """True when the two frames differ only in a SMALL area (an animated block), False otherwise.

    Used for one decision only (R61): a pair that the overlap search cannot match (because the
    only difference left is something animating in place, at the very bottom of a page) may be
    reported as "no new content" instead of failing the whole capture -- but that is only safe
    when the change really is localized. On flat content (colour bands) a scrolled pair also
    matches at several offsets, so the bounding box of the difference spans the picture and this
    returns False; the pair then has to fit the normal rules.
    """
    diff = ImageChops.difference(a, b).point(lambda v: 255 if v > tol else 0)
    box = diff.getbbox()
    if box is None:
        return True
    area = (box[2] - box[0]) * (box[3] - box[1])
    return area <= max_frac * (a.size[0] * a.size[1])


def find_shift(prev, cur, overlap_min, robust=False):
    """How far the content moved up between two frames (downscaled px) + the residual.

    Returns (shift, score). `score` is the mean abs difference of the best overlap: a real
    overlap scores near 0, a pair with no overlap scores high -- that is what lets the caller
    tell "found it" from "guessed something".

    `robust` (R61) swaps in the trimmed score. It is only used as a SECOND pass when the plain
    score says "no overlap": trimming hides an animated band, but on content that is mostly flat
    (uniform padding, colour bands) it can be ~0 at several wrong offsets and then the search
    under-counts shifts (measured: a 3840 px page stitched 480 px short).
    """
    w, h = prev.size
    best = None
    best_score = None
    for s in range(max(2, overlap_min), max(3, h - 1)):
        a = prev.crop((0, s, w, h))
        b = cur.crop((0, 0, w, h - s))
        if a.size[1] < 8:
            break
        score = trimmed_score(a, b) if robust else mean_abs_diff(a, b)
        if best_score is None or score < best_score:
            best = s
            best_score = score
    if best is None:
        return h, float("inf")
    return best, float(best_score)


def refine_shift(prev_l, cur_l, guess, radius, robust=False):
    """Refine a downscaled estimate at FULL resolution (R58).

    The signature is width-downscaled, so one downscaled pixel is `ratio` real pixels (~4.1 for
    a 660 px wide region): a coarse match of 57 downscaled pixels rounds to 235 real pixels when
    the true shift is 237. That is a 2 px wrong seam per frame -- invisible on screen, but it
    duplicates/drops 2 px of content per seam and it makes "exact" assertions impossible. One
    full-resolution pass inside +-radius of the coarse guess costs ~10 crops and removes it.
    `robust` = the same trimmed-score second pass as find_shift (R61).
    """
    w, h = prev_l.size
    best = None
    best_score = None
    lo = max(2, int(guess) - int(radius))
    hi = min(h - 1, int(guess) + int(radius))
    for s in range(lo, hi + 1):
        a = prev_l.crop((0, s, w, h))
        b = cur_l.crop((0, 0, w, h - s))
        if a.size[1] < 8:
            continue
        score = trimmed_score(a, b) if robust else mean_abs_diff(a, b)
        if best_score is None or score < best_score:
            best = s
            best_score = score
    if best is None:
        return int(guess), float("inf")
    return best, float(best_score)


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
    # R59: ignore the outer edge on BOTH passes (coarse signature and full-resolution refine).
    # A scrollbar thumb / resize grip / edge overlay moves between frames and would otherwise
    # poison every candidate shift.
    margin = margins(width)
    sigs = [signature(f, scale_width, margin) for f in files]
    # Full-resolution grayscale copies, used only by the refinement pass.
    if margin > 0 and width - 2 * margin >= 16:
        loupe = [f.convert("L").crop((margin, 0, width - margin, height)) for f in frames]
    else:
        loupe = [f.convert("L") for f in frames]
    ratio = float(height) / float(sigs[0].size[1]) if sigs[0].size[1] else 1.0

    # offsets[k] = 第 k+1 帧相对第 k 帧**上移了多少像素**（= find_shift 的约定，
    # 也是 JSON 里报出去的那个数）。于是：
    #   重叠行数 = height - s   ← 第 k+1 帧开头这 (height-s) 行已经画过了，丢掉
    #   新增行数 = s            ← 接在画布后面的就是这么多
    # ⚠️ 这两个量以前被写反了（把 s 当重叠用）：结果高度多算 2*(height-2s)，画面上
    #    中间多出一条重复带。400x300、滚动 120 的三帧拼出来是 660（应为 540）。
    #    合成用例见 .tmp-vision/mkstitch.py + .tools/dsh-stitch-check.py。
    offsets = []
    scores = []
    skipped = 0
    smin = max(4, int(round(overlap_min / ratio)))
    debug = os.environ.get("DSH_STITCH_DEBUG") == "1"
    for k in range(1, len(frames)):
        prev_sig, cur_sig = sigs[k - 1], sigs[k]
        same = mean_abs_diff(prev_sig, cur_sig)
        if same <= DUP_TOL:
            # Same picture (caret blink / clock / cursor): it carries NO new rows. Appending
            # anything for it duplicates content, and inventing a shift for it is exactly how
            # R58 measured +479 px of extra height on a picture that looked plausible.
            offsets.append(0)
            scores.append(round(same, 2))
            skipped += 1
            continue
        s_small, score = find_shift(prev_sig, cur_sig, smin)
        # R61: plain scoring keeps seams exact on flat content, so it goes FIRST. Only when it
        # says "no overlap" do we re-run with the trimmed score -- that is the case an animated
        # region creates (measured: 12.60 > 8.00 on a pair that matched everywhere else).
        robust = False
        if score > MATCH_TOL:
            s2, score2 = find_shift(prev_sig, cur_sig, smin, robust=True)
            if score2 <= MATCH_TOL:
                s_small, score = s2, score2
                robust = True
        if debug:
            print("dbg k=%d sig=%s s0=%d score=%.2f robust=%s" % (k, cur_sig.size, s_small, score, robust), file=sys.stderr)
        # A best-in-range shift is NOT evidence of an overlap: when the content jumped farther
        # than one frame there is nothing to match and the minimiser still returns something.
        # The residual is what separates "found the seam" (near 0) from "guessed" (high).
        if score > MATCH_TOL:
            # R61: the pair may simply be "the same place with something animating in it" (the
            # bottom of a page, where only a video/spinner still changes). That is a duplicate,
            # not a broken capture -- but only when the difference really is localized.
            zero = trimmed_score(prev_sig, cur_sig)
            if zero <= MATCH_TOL and localized_change(prev_sig, cur_sig):
                offsets.append(0)
                scores.append(round(zero, 2))
                skipped += 1
                continue
            print(
                "stitch: frames %d and %d do not overlap (best match residual %.2f > %.2f). "
                "The content scrolled farther than one frame height between the two captures; "
                "scroll in smaller steps and retry." % (k, k + 1, score, MATCH_TOL),
                file=sys.stderr,
            )
            print(json.dumps({
                "error": "no-overlap",
                "frame": k + 1,
                "frames": len(frames),
                "score": round(score, 2),
                "tolerance": MATCH_TOL,
            }), file=sys.stderr)
            return 3
        guess = int(round(s_small * ratio))
        s, precise = refine_shift(loupe[k - 1], loupe[k], guess, int(round(ratio)) + 2, robust=robust)
        if robust and precise > MATCH_TOL:
            # 粗搜用 robust 了，精修却不达标：退回普通精修，别让"鲁棒"把一个好接缝判死。
            s, precise = refine_shift(loupe[k - 1], loupe[k], guess, int(round(ratio)) + 2)
        # R61: a pair whose best match is AT the lower search bound means "these two frames barely
        # move relative to each other" -- the bottom of the page where only something animating
        # still changes. Treat it as a duplicate (no new rows) instead of failing the capture.
        if s <= max(3, int(round(8.0 / ratio))) and precise <= MATCH_TOL:
            offsets.append(0)
            scores.append(round(precise, 2))
            skipped += 1
            continue
            offsets.append(0)
            scores.append(round(precise, 2))
            skipped += 1
            continue
        if precise > MATCH_TOL:
            print(
                "stitch: frames %d and %d do not overlap at full resolution "
                "(residual %.2f > %.2f around a %d px guess)."
                % (k, k + 1, precise, MATCH_TOL, guess),
                file=sys.stderr,
            )
            print(json.dumps({
                "error": "no-overlap",
                "frame": k + 1,
                "frames": len(frames),
                "score": round(precise, 2),
                "tolerance": MATCH_TOL,
            }), file=sys.stderr)
            return 3
        s = max(1, min(height - 1, s))
        offsets.append(s)
        scores.append(round(precise, 2))

    total = height + sum(offsets)
    canvas = Image.new("RGB", (width, total))
    y = 0
    canvas.paste(frames[0], (0, 0))
    y += height
    for k, s in enumerate(offsets):
        if s <= 0:
            continue
        part = frames[k + 1].crop((0, height - s, width, height))
        canvas.paste(part, (0, y))
        y += s

    canvas.save(out)
    print(json.dumps({
        "width": width,
        "height": total,
        "frames": len(frames),
        "offsets": offsets,
        "scores": scores,
        "skipped": skipped,
        "margin": margin,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
