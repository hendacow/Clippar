#!/usr/bin/env python3
"""
truth.py — establish a TRUE impact instant for as many clips as possible, so
"will it work when the app's impact is off by X" has a measured answer.

TWO STAGES, and the second is the one that makes it truth rather than a guess.

  1. CANDIDATES from audio. The strike is a sharp broadband transient. This
     ranks the clip's onsets and keeps the top few. For the 36 lab clips the
     lab's own `impact_sounds.csv` is used as an extra candidate, so the two
     methods can disagree visibly instead of silently.

  2. CONFIRMATION BY EYE. `--strips` renders, for each candidate, five frames at
     t-0.30, t-0.10, t, t+0.13, t+0.30 s. At a real strike the club is at the
     ball at t and the golfer is into the follow-through 0.13 s later. A
     candidate that does not show that is a bag zip, a footstep, a voice or the
     NEXT player's shot — all of which are strong transients too.

Only a candidate that has been LOOKED AT goes into truth.json. Everything else
stays a candidate, and a clip with no confirmed impact is simply left out of the
sweep rather than being given an audio guess and called truth.

  python3 truth.py --candidates      -> $BENCH_WORK/candidates.json
  python3 truth.py --strips [ids...] -> $BENCH_WORK/strips/*.jpg
"""
import argparse
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

import numpy as np

HOME = os.path.expanduser("~")
WORK = os.environ.get("BENCH_WORK", os.path.join(HOME, ".cache/clippar-tracer-bench"))
STRIPS = os.path.join(WORK, "strips")
OFFSETS = [-0.30, -0.10, 0.0, 0.13, 0.30]


def onsets(path, top=3):
    """Ranked broadband onsets, seconds. Deliberately simple and deliberately
    NOT trusted on its own — stage 2 is what decides."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"],
        capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    if x.size < 22050:
        return []
    sr, hop = 22050, 256
    n = (x.size - hop) // hop
    e = np.abs(x[: n * hop].reshape(n, hop)).max(axis=1)
    d = np.maximum(0, e[2:] - e[:-2])
    t0 = int(0.5 * sr / hop)                 # ignore handling noise at the very start
    d[:t0] = 0
    peaks = []
    dd = d.copy()
    for _ in range(top):
        k = int(np.argmax(dd))
        if dd[k] <= 0:
            break
        peaks.append((round((k + 1) * hop / sr, 3), float(dd[k])))
        lo, hi = max(0, k - int(0.5 * sr / hop)), min(len(dd), k + int(0.5 * sr / hop))
        dd[lo:hi] = 0                        # suppress 0.5 s either side
    m = max((p[1] for p in peaks), default=1.0) or 1.0
    return [{"t": t, "score": round(s / m, 3)} for t, s in peaks]


def build_candidates():
    clips = json.load(open(os.path.join(WORK, "manifest.json")))["clips"]
    out = {}

    def work(c):
        cands = onsets(c.get("stagedPath") or c["path"])
        for a in c.get("audioImpacts", []):
            if not any(abs(a["t"] - x["t"]) < 0.25 for x in cands):
                cands.append({"t": round(a["t"], 3), "score": 0.0, "src": "lab-csv"})
        return c["id"], cands

    with ThreadPoolExecutor(max_workers=8) as ex:
        for cid, cands in ex.map(work, clips):
            out[cid] = cands
    with open(os.path.join(WORK, "candidates.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"[truth] candidates for {len(out)} clips -> {WORK}/candidates.json")


def strip(clip, cands):
    os.makedirs(STRIPS, exist_ok=True)
    rows = []
    for ci, cand in enumerate(cands):
        tiles = []
        for oi, off in enumerate(OFFSETS):
            t = max(0.0, cand["t"] + off)
            tile = os.path.join(STRIPS, f".{clip['id']}_{ci}_{oi}.jpg")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}",
                            "-i", clip.get("stagedPath") or clip["path"], "-frames:v", "1",
                            "-vf", "scale=-2:380", "-q:v", "3", tile],
                           capture_output=True, timeout=120)
            if os.path.exists(tile):
                tiles.append(tile)
        if not tiles:
            continue
        row = os.path.join(STRIPS, f".row_{clip['id']}_{ci}.jpg")
        subprocess.run(["montage", *tiles, "-tile", f"{len(tiles)}x1", "-geometry", "+2+2",
                        "-background", "#202020", row], capture_output=True, timeout=180)
        for t in tiles:
            os.remove(t)
        rows.append(row)
    if not rows:
        return None
    out = os.path.join(STRIPS, f"{clip['id']}.jpg")
    subprocess.run(["montage", *rows, "-tile", "1x", "-geometry", "+2+6",
                    "-background", "black", "-quality", "80", out], capture_output=True, timeout=300)
    for r in rows:
        os.remove(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", action="store_true")
    ap.add_argument("--strips", action="store_true")
    ap.add_argument("--per-sheet", type=int, default=3)
    ap.add_argument("ids", nargs="*")
    a = ap.parse_args()
    if a.candidates:
        build_candidates()
        return
    if not a.strips:
        ap.error("pass --candidates or --strips")

    clips = json.load(open(os.path.join(WORK, "manifest.json")))["clips"]
    cands = json.load(open(os.path.join(WORK, "candidates.json")))
    if a.ids:
        want = set(a.ids)
        clips = [c for c in clips if c["id"] in want]
    with ThreadPoolExecutor(max_workers=5) as ex:
        made = list(ex.map(lambda c: (c["id"], strip(c, cands.get(c["id"], [])[:3])), clips))
    made = [(i, p) for i, p in made if p]
    for n in range(0, len(made), a.per_sheet):
        chunk = made[n:n + a.per_sheet]
        sheet = os.path.join(STRIPS, f"strips_{n // a.per_sheet:03d}.jpg")
        subprocess.run(["montage", *[p for _, p in chunk], "-tile", "1x", "-geometry", "+3+10",
                        "-background", "#3a3a3a", "-quality", "80", sheet],
                       capture_output=True, timeout=300)
        print(sheet + "  " + "  ".join(
            f"{i}[" + ",".join(f"{c['t']:.2f}" for c in cands.get(i, [])[:3]) + "]"
            for i, _ in chunk))


if __name__ == "__main__":
    main()
