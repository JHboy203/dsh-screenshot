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
#
# R61 solved that by scoring "the best 70 % of ROWS" (trimmed_score) and it held up on the colour
# band fixture. On REAL page texture it does not (R63, dev/texreplay.py): trimming can always throw
# disagreements away, so a row-trimmed landscape is drawn to the SMALLEST overlap -- with few rows
# left, the flat ones dominate and the score goes to ~3 at a wrong offset. Measured on dense UI
# texture (660 px wide region): truth 237 px; the row-trimmed best was 397 px / 386 px / 509 px,
# and one seam of +160 px was accepted silently (residual 3.17 vs 4.10 at the true shift).
#
# What survives real texture is not a better average but a structural question -- see covered_change:
# an animation is ONE compact region repainting in place, a wrong shift disagrees all over. Row
# trimming therefore keeps only ONE job now: the bottom-of-page duplicate test, where its 30 %
# margin is exactly what R61 measured.
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

    ⚠️ NOT used to find a shift any more (R63: on dense texture it picks the smallest overlap).
    It is the "same place, only something animating in it" test for the bottom of a page, where
    the pair's shift is 0 and the only thing left to check is whether the residual really is one
    animating band rather than a bad match.
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


# R63: what the animated-content fallback actually keys on.
# The question is not "how big is the average residual" (an animation can own a fifth of the
# picture and blow any average) but "WHERE is the disagreement": an animating block is ONE compact
# region, while a wrong shift disagrees everywhere glyphs moved. Measured on dense UI texture
# (dev/texreplay.py, 480x520 region, truth 237 px, a 220x130 block repainting every frame):
#     true shift    disagreement bbox 0.36 of the overlap, 100 % of it inside the box  (the block)
#     wrong shift   disagreement bbox 0.97 of the overlap                              (every glyph)
#     no overlap    ~1.00                                                             (nothing agrees)
# Both halves matter: the box alone would let a scattering of glyph noise through (a box drawn
# around scattered pixels covers the picture but is nearly empty), the fill alone cannot tell a
# big animation from a poor match.
COVER_TOL = 24
COVER_MAX_AREA = 0.6
COVER_MIN_FILL = 0.3
# How much of the frame must stay in the overlap before a match on it counts as evidence.
# With a sliver of overlap, a handful of rows can agree by accident: measured on dense texture
# (R63, dev/stitch-tex-probe.mjs) 27 rows of a 520 px frame gave a mean residual of 2.37 at a
# 493 px shift where the truth was 237, and the stitcher silently doubled 256 rows. A sliver can
# only prove a seam when it matches EXACTLY (residual <= DUP_TOL): the band fixture really does
# scroll 75 % of the frame per step and its content really is identical, so refusing every narrow
# overlap would break honest captures. Anything less exact than that goes to the structural
# fallback, which insists on this share; if that finds nothing, the refusal is honest.
MIN_OVERLAP_SHARE = 0.35


def covered_change(a, b, tol=COVER_TOL, max_area=COVER_MAX_AREA, min_fill=COVER_MIN_FILL):
    """True when the two frames agree EXCEPT inside one compact region (an animating block).

    `a` and `b` are the overlapping crops of two frames at one candidate shift, so "they agree"
    means "this shift is right". A wrong shift fails both ways: its disagreement box covers the
    overlap AND most pixels inside that box disagree.
    """
    mask = ImageChops.difference(a, b).point(lambda v: 255 if v > tol else 0)
    box = mask.getbbox()
    if box is None:
        return True
    area = (box[2] - box[0]) * (box[3] - box[1])
    if area > max_area * (a.size[0] * a.size[1]):
        return False
    # A pixel over `tol` maps to 255, so the histogram's last bucket is the count of them.
    return mask.histogram()[-1] >= min_fill * area


def find_shift(prev, cur, overlap_min):
    """How far the content moved up between two frames (downscaled px) + the residual.

    Returns (shift, score). `score` is the mean abs difference of the best overlap: a real
    overlap scores near 0, a pair with no overlap scores high -- that is what lets the caller
    tell "found it" from "guessed something".
    """
    w, h = prev.size
    best = None
    best_score = None
    for s in range(max(2, overlap_min), max(3, h - 1)):
        a = prev.crop((0, s, w, h))
        b = cur.crop((0, 0, w, h - s))
        if a.size[1] < 8:
            break
        score = mean_abs_diff(a, b)
        if best_score is None or score < best_score:
            best = s
            best_score = score
    if best is None:
        return h, float("inf")
    return best, float(best_score)


def find_covered_shift(prev_l, cur_l, overlap_min):
    """The animated-content fallback, at FULL resolution (R63).

    Returns (shift, plain residual) of the best candidate whose disagreement is one compact
    region (covered_change), or (height, inf) when no shift qualifies -- "nothing matched", which
    includes both a genuine jump and a page where too large an area animates.

    Why full resolution and not the 2.6:1 signature the plain pass uses: an animated patch
    repaints with fresh content, and a downscale SMEARS it across the whole width, so on the
    signature every candidate disagrees everywhere (measured: the true shift scored 28.90 coarse
    while a wrong shift scored 18.10 -- the structural test cannot see anything there). At full
    resolution the same pair is unambiguous: the disagreement is exactly the patch (area 0.48 of
    the overlap, 49 % of it over the 24-level threshold) and every neighbouring shift covers 1.00.

    The residual it returns is NOT an acceptance test (it stays above MATCH_TOL at a correct
    shift); covered_change already did the accepting. It is only the ranking among qualifiers.
    Cost measured at 660x520: 0.17-0.26 s for 472 candidates, and it only runs when the plain
    pass said "no overlap".

    It needs MORE overlap than the plain pass to be trustworthy: the structural test asks "does
    everything except one block agree", which at a 2 % overlap (11 rows of 520) is trivially true
    and immediately wrong -- measured on the animated fixture, the fallback happily returned 509
    px (truth 237) because 11 rows of dense text satisfied covered_change. Both passes therefore
    stop at MIN_OVERLAP_SHARE.
    """
    w, h = prev_l.size
    lo = max(2, overlap_min)
    # Overlap = h - s, so the share is a limit on the LARGEST shift, not the smallest one.
    hi = min(h - 8, int(round((1.0 - MIN_OVERLAP_SHARE) * h)))
    best = None
    best_score = None
    for s in range(lo, max(lo + 1, hi)):
        a = prev_l.crop((0, s, w, h))
        b = cur_l.crop((0, 0, w, h - s))
        if not covered_change(a, b):
            continue
        score = mean_abs_diff(a, b)
        if best_score is None or score < best_score:
            best = s
            best_score = score
    if best is None:
        return h, float("inf")
    return best, float(best_score)


def refine_shift(prev_l, cur_l, guess, radius):
    """Refine a downscaled estimate at FULL resolution (R58).

    The signature is width-downscaled, so one downscaled pixel is `ratio` real pixels (~4.1 for
    a 660 px wide region): a coarse match of 57 downscaled pixels rounds to 235 real pixels when
    the true shift is 237. That is a 2 px wrong seam per frame -- invisible on screen, but it
    duplicates/drops 2 px of content per seam and it makes "exact" assertions impossible. One
    full-resolution pass inside +-radius of the coarse guess costs ~10 crops and removes it.
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
        score = mean_abs_diff(a, b)
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
    # Per pair: did the final shift come from the ROBUST second pass? Reported in the JSON because
    # "the trimmed score only when needed" is a behaviour, and a behaviour that cannot be observed
    # cannot be asserted (R63: the dense-texture replay probe reads this to prove that ordinary
    # page texture never needs the fallback).
    robustUsed = []
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
            robustUsed.append(False)
            skipped += 1
            continue
        s_small, score = find_shift(prev_sig, cur_sig, smin)
        # R61/R63: plain scoring keeps seams exact on ordinary content, so it goes FIRST.
        robust = False
        unverified = False
        if score <= MATCH_TOL:
            guess = int(round(s_small * ratio))
            s, precise = refine_shift(loupe[k - 1], loupe[k], guess, int(round(ratio)) + 2)
            # Two ways a plain match can still be worthless, both measured in R63:
            #   ① it only just fits (8.07 > 8.00 on an animated pair): the block at that moment was
            #      small, so the residual sat right on the line and a re-run either way decides it;
            #   ② it rests on a NARROW overlap (27 rows of dense text gave 2.37 at a wrong 493 px
            #      shift and the stitcher doubled 256 rows): a sliver proves a seam only when it
            #      matches EXACTLY, because the band fixture really does scroll 75 % per step.
            # Both are handed to the structural search instead of being trusted or refused outright.
            narrow = (height - s) < MIN_OVERLAP_SHARE * height and precise > DUP_TOL
            if precise > MATCH_TOL or narrow:
                s2, p2 = find_covered_shift(loupe[k - 1], loupe[k], overlap_min)
                if p2 != float("inf"):
                    s, precise, robust = s2, p2, True
                else:
                    unverified = True
        else:
            # Plain says "no overlap". Two explanations remain, and the ORDER matters:
            #
            # ① the page stopped scrolling and only something in it still repaints (video,
            #    spinner, clock). That is a duplicate: stitching it would append invented rows --
            #    measured on the band fixture in R63: the fallback below happily took it at 158 px
            #    and the finished picture grew by 158 px of doubled content. So this is decided
            #    first, by the R61 test (row-trimmed residual at ZERO shift + localized change).
            # ② the content did scroll, and a compact region is repainting in place. That is
            #    stitchable, but its residual stays above MATCH_TOL even at the true shift
            #    (measured 29.29 on dense texture, 12.60 on bands), so no residual can accept it --
            #    only the STRUCTURE of the disagreement can (covered_change).
            zero = trimmed_score(prev_sig, cur_sig)
            if zero <= MATCH_TOL and localized_change(prev_sig, cur_sig):
                offsets.append(0)
                scores.append(round(zero, 2))
                robustUsed.append(False)
                skipped += 1
                continue
            s, precise = find_covered_shift(loupe[k - 1], loupe[k], overlap_min)
            robust = precise != float("inf")
        if debug:
            print("dbg k=%d sig=%s s0=%d score=%.2f robust=%s" % (k, cur_sig.size, s_small, score, robust), file=sys.stderr)
        # A best-in-range shift is NOT evidence of an overlap: when the content jumped farther
        # than one frame there is nothing to match and the minimiser still returns something.
        # The residual is what separates "found the seam" (near 0) from "guessed" (high) -- and
        # when no covered_change candidate exists either, the pair is genuinely unmatched.
        if not robust and (score > MATCH_TOL or precise > MATCH_TOL or unverified):
            if score > MATCH_TOL:
                bad = score
                print(
                    "stitch: frames %d and %d do not overlap (best match residual %.2f > %.2f). "
                    "The content scrolled farther than one frame height between the two captures; "
                    "scroll in smaller steps and retry." % (k, k + 1, score, MATCH_TOL),
                    file=sys.stderr,
                )
            else:
                bad = precise
                print(
                    "stitch: frames %d and %d do not overlap at full resolution "
                    "(residual %.2f > %.2f around a %d px guess)."
                    % (k, k + 1, precise, MATCH_TOL, int(round(s_small * ratio))),
                    file=sys.stderr,
                )
            print(json.dumps({
                "error": "no-overlap",
                "frame": k + 1,
                "frames": len(frames),
                "score": round(bad, 2),
                "tolerance": MATCH_TOL,
            }), file=sys.stderr)
            return 3
        # R61: a pair whose best match is AT the lower search bound means "these two frames barely
        # move relative to each other" -- the bottom of the page where only something animating
        # still changes. Treat it as a duplicate (no new rows) instead of failing the capture.
        if not robust and s <= max(3, int(round(8.0 / ratio))) and precise <= MATCH_TOL:
            offsets.append(0)
            scores.append(round(precise, 2))
            robustUsed.append(False)
            skipped += 1
            continue
        s = max(1, min(height - 1, s))
        offsets.append(s)
        scores.append(round(precise, 2))
        robustUsed.append(robust)

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
        "robust": robustUsed,
        "skipped": skipped,
        "margin": margin,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
