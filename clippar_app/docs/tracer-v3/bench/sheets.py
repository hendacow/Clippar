#!/usr/bin/env python3
"""
sheets.py — contact sheets, so a human (or a model with eyes) can classify what
is actually in each clip.

A clip that contains no golf shot must not count against the hit rate, and a putt
that correctly refuses is not a failure. Neither of those can be decided from a
filename, so: six frames per clip, evenly spaced, one row per clip, five clips per
sheet, clip id burned into the frame.

  python3 sheets.py            # all clips missing a sheet
  python3 sheets.py IMG_0601   # just these ids

Writes $BENCH_WORK/sheets/sheet_NNN.jpg and prints the ids on each sheet.
"""
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
WORK = os.environ.get("BENCH_WORK", os.path.join(HOME, ".cache/clippar-tracer-bench"))
SHEETS = os.path.join(WORK, "sheets")
ROWS = os.path.join(WORK, "sheets", "rows")
FRACS = [0.08, 0.24, 0.40, 0.56, 0.72, 0.88]
ROW_H = 300
PER_SHEET = 5


def row_for(rec):
    out = os.path.join(ROWS, f"{rec['id']}.jpg")
    if os.path.exists(out):
        return out
    dur = rec.get("durationSec") or 0
    if dur <= 0:
        return None
    tiles = []
    for i, fr in enumerate(FRACS):
        t = max(0.0, min(dur - 0.05, dur * fr))
        tile = os.path.join(ROWS, f".{rec['id']}_{i}.jpg")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", rec["path"],
             "-frames:v", "1", "-vf", f"scale=-2:{ROW_H}",
             "-q:v", "4", tile],
            capture_output=True, timeout=120)
        if os.path.exists(tile):
            tiles.append(tile)
    if not tiles:
        return None
    label = f"{rec['id']}  {rec['corpus']}  {dur:.1f}s  {rec.get('width')}x{rec.get('height')}"
    subprocess.run(
        ["montage", *tiles, "-tile", f"{len(tiles)}x1", "-geometry", "+2+2",
         "-background", "black", "-label", label, "-pointsize", "22",
         "-fill", "white", out],
        capture_output=True, timeout=180)
    for t in tiles:
        os.remove(t)
    return out if os.path.exists(out) else None


def main():
    os.makedirs(ROWS, exist_ok=True)
    clips = json.load(open(os.path.join(WORK, "manifest.json")))["clips"]
    want = set(sys.argv[1:])
    if want:
        clips = [c for c in clips if c["id"] in want]
    with ThreadPoolExecutor(max_workers=6) as ex:
        rows = list(ex.map(row_for, clips))
    pairs = [(c, r) for c, r in zip(clips, rows) if r]
    for n in range(0, len(pairs), PER_SHEET):
        chunk = pairs[n:n + PER_SHEET]
        sheet = os.path.join(SHEETS, f"sheet_{n // PER_SHEET:03d}.jpg")
        subprocess.run(
            ["montage", *[r for _, r in chunk], "-tile", "1x", "-geometry", "+4+4",
             "-background", "#111111", "-quality", "82", sheet],
            capture_output=True, timeout=300)
        print(f"{sheet}  " + " ".join(c["id"] for c, _ in chunk))


if __name__ == "__main__":
    main()
