"""Measure the chunk-border seam in the screenshots from lunar-rift-seam-shots.mjs.

    python3 tools/lunar-rift-seam-measure.py <dir> <tag> [<tag2>]

For every view it pairs the plain render with the magenta-clear-colour render:

  BLEED  pixels that show the magenta background through the ground. These are
         holes in the world, so any count above zero is a defect. Reported with
         the longest continuous run, because a straight continuous run is what
         reads as a drawn line.
  CONTRAST  in the PLAIN render, the mean luma of those same pixels against the
         mean luma of the terrain immediately either side. This is the number
         the player actually sees: how far the line stands off the ground.

With two tags it prints a before/after table.
"""
import sys
import os
import glob
import numpy as np
from PIL import Image

MAGENTA_MIN = 90      # how much more R+B than G before a pixel counts as background
NEAR = 6              # px either side of a bleed pixel sampled as reference terrain


def luma(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def longest_run(mask):
    """Longest continuous run of columns (or rows) that contain a bleed pixel."""
    best = 0
    for axis in (0, 1):
        hit = mask.any(axis=axis)
        run = 0
        for v in hit:
            run = run + 1 if v else 0
            best = max(best, run)
    return best


def measure(plain_path, magenta_path):
    plain = np.asarray(Image.open(plain_path).convert("RGB")).astype(np.float64)
    mag = np.asarray(Image.open(magenta_path).convert("RGB")).astype(np.float64)
    # Background bleed: magenta in the magenta shot, and clearly different from
    # the plain shot there (so genuinely magenta-lit pixels, not pink rock).
    magenta_like = (mag[..., 0] - mag[..., 1] > MAGENTA_MIN) & (mag[..., 2] - mag[..., 1] > MAGENTA_MIN)
    changed = np.abs(mag - plain).max(axis=2) > 24
    bleed = magenta_like & changed
    # The sky region is background by design; only count bleed BELOW the highest
    # row that is fully covered by geometry in the plain shot, i.e. holes that
    # sit inside the ground rather than above the horizon.
    covered = ~magenta_like
    rows_fully_covered = np.flatnonzero(covered.all(axis=1))
    if rows_fully_covered.size:
        bleed[: rows_fully_covered[0], :] = False
    count = int(bleed.sum())
    result = {"bleed_px": count, "run_px": longest_run(bleed) if count else 0}
    if count == 0:
        result["on_luma"] = result["off_luma"] = result["contrast"] = 0.0
        return result
    lum = luma(plain)
    ys, xs = np.nonzero(bleed)
    on = lum[ys, xs]
    # Reference terrain: the same columns, NEAR rows above and below, excluding
    # anything that itself bleeds.
    ref = []
    h = lum.shape[0]
    for dy in (-NEAR, NEAR):
        yy = np.clip(ys + dy, 0, h - 1)
        keep = ~bleed[yy, xs]
        ref.append(lum[yy[keep], xs[keep]])
    ref = np.concatenate(ref) if ref else np.array([0.0])
    result["on_luma"] = float(on.mean())
    result["off_luma"] = float(ref.mean()) if ref.size else 0.0
    result["contrast"] = result["on_luma"] - result["off_luma"]
    return result


def views_for(directory, tag):
    out = {}
    for path in sorted(glob.glob(os.path.join(directory, f"{tag}_*_magenta.png"))):
        name = os.path.basename(path)[len(tag) + 1: -len("_magenta.png")]
        plain = os.path.join(directory, f"{tag}_{name}.png")
        if os.path.exists(plain):
            out[name] = measure(plain, path)
    return out


directory = sys.argv[1]
tags = sys.argv[2:]
if not tags:
    raise SystemExit("usage: lunar-rift-seam-measure.py <dir> <tag> [<tag2>]")

tables = {tag: views_for(directory, tag) for tag in tags}
names = sorted({n for t in tables.values() for n in t})

if len(tags) == 1:
    tag = tags[0]
    print(f"{'view':<18}{'bleed px':>10}{'longest run':>13}{'luma on':>10}{'luma off':>10}{'contrast':>10}")
    total = 0
    for name in names:
        r = tables[tag][name]
        total += r["bleed_px"]
        print(f"{name:<18}{r['bleed_px']:>10}{r['run_px']:>13}{r['on_luma']:>10.1f}{r['off_luma']:>10.1f}{r['contrast']:>+10.1f}")
    print(f"{'TOTAL':<18}{total:>10}")
else:
    a, b = tags[0], tags[1]
    print(f"{'view':<18}{'bleed px ' + a:>16}{'bleed px ' + b:>16}{'run ' + a:>12}{'run ' + b:>12}"
          f"{'contrast ' + a:>16}{'contrast ' + b:>16}")
    ta = tb = 0
    for name in names:
        ra = tables[a].get(name)
        rb = tables[b].get(name)
        if not ra or not rb:
            continue
        ta += ra["bleed_px"]
        tb += rb["bleed_px"]
        print(f"{name:<18}{ra['bleed_px']:>16}{rb['bleed_px']:>16}{ra['run_px']:>12}{rb['run_px']:>12}"
              f"{ra['contrast']:>+16.1f}{rb['contrast']:>+16.1f}")
    print(f"{'TOTAL':<18}{ta:>16}{tb:>16}")
