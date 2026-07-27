#!/usr/bin/env python3
"""
tune.py — score the cached motion curves. Runs in seconds, so the detection rule
can be iterated to convergence instead of guessed at.

Scoring rule (see swing_time.py for the derivation):
  the top of the backswing is a VALLEY BETWEEN TWO PEAKS —
  backswing motion before it, downswing motion after it.

  raw   = min(peak_before, peak_after) - energy_here
  norm  = raw / clip motion scale        (comparable across clips: a golfer 40m
                                          away moves far fewer pixels than one
                                          at 5m, but the SHAPE is the same)

Normalising is what lets a single threshold work on both a close-up 1080p clip
and a distant 4K one.
"""
import argparse, json
from pathlib import Path
import numpy as np

UP_WINDOW = 0.34
BACK_WINDOW = 0.70
NMS_GAP = 1.20
N_CANDIDATES = 6


def energy_curve(gray):
    """99.5th percentile of |frame diff| — tracks the fastest-moving pixels (the
    club and hands). A mean would be swamped by static grass."""
    g = gray.astype(np.float32)
    d = np.abs(np.diff(g, axis=0))
    return np.percentile(d.reshape(len(d), -1), 99.5, axis=1), d


def smooth(v, k=3):
    return np.convolve(v, np.ones(k) / k, mode="same") if len(v) >= k else v


def candidates(e, t, up=UP_WINDOW, back=BACK_WINDOW, k=N_CANDIDATES, nms=NMS_GAP):
    if len(e) < 4:
        return []
    dt = t[1] - t[0] if len(t) > 1 else 1 / 30
    w_up, w_bk = max(2, int(round(up / dt))), max(2, int(round(back / dt)))
    scores = np.zeros(len(e))
    peaks = np.zeros(len(e), dtype=int)
    for i in range(len(e)):
        after = e[i + 1: min(len(e), i + w_up + 1)]
        before = e[max(0, i - w_bk): i]
        if len(after) == 0 or len(before) == 0:
            continue
        pk = int(np.argmax(after))
        peaks[i] = i + 1 + pk
        scores[i] = min(before.max(), after[pk]) - e[i]

    # Scale-free: a distant golfer moves fewer pixels but the shape is identical.
    scale = np.percentile(e, 95) - np.percentile(e, 5)
    scale = max(scale, 1e-3)

    out, used = [], np.zeros(len(e), bool)
    for i in np.argsort(-scores):
        if scores[i] <= 0 or used[i]:
            continue
        out.append(dict(
            t_top=float(t[i]), t_impact=float(t[peaks[i]]),
            raw=float(scores[i]), norm=float(scores[i] / scale),
            floor=float(e[i]), peak=float(e[peaks[i]]),
            gap=float(t[peaks[i]] - t[i]),
        ))
        lo, hi = max(0, int(i - nms / dt)), min(len(e), int(i + nms / dt))
        used[lo:hi] = True
        if len(out) >= k:
            break
    return out


def analyse_cached(npz_path, **kw):
    d = np.load(npz_path, allow_pickle=True)
    gray, fps = d["gray"], float(d["fps"])
    if len(gray) < 4:
        return dict(file=Path(str(d["path"])).name, label=str(d["label"]),
                    path=str(d["path"]), cands=[], decision="UNREADABLE")
    e_raw, diffs = energy_curve(gray)
    e = smooth(e_raw, 3)
    t = (np.arange(len(e)) + 0.5) / fps
    cs = candidates(e, t, **kw)
    return dict(file=Path(str(d["path"])).name, label=str(d["label"]),
                path=str(d["path"]), dur=float(d["dur"]),
                fps=fps, src_w=int(d["src_w"]), src_h=int(d["src_h"]),
                cands=cs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--up", type=float, default=UP_WINDOW)
    ap.add_argument("--back", type=float, default=BACK_WINDOW)
    a = ap.parse_args()

    rows = [analyse_cached(p, up=a.up, back=a.back)
            for p in sorted(Path(a.cache).glob("*.npz"))]
    if a.out:
        Path(a.out).write_text(json.dumps(rows, indent=2))

    # How separable are the labels on the motion signal alone?
    print(f"{'label':<12} {'n':>4}  best-norm distribution (top candidate)")
    print("-" * 72)
    for lbl in sorted({r["label"] for r in rows}):
        sub = [r for r in rows if r["label"] == lbl]
        best = [r["cands"][0]["norm"] if r["cands"] else 0.0 for r in sub]
        gaps = [r["cands"][0]["gap"] for r in sub if r["cands"]]
        best_sorted = np.sort(best)
        q = lambda p: best_sorted[min(len(best_sorted) - 1, int(p * len(best_sorted)))]
        print(f"{lbl:<12} {len(sub):>4}  min {best_sorted[0]:5.2f}  p25 {q(.25):5.2f}  "
              f"med {q(.5):5.2f}  p75 {q(.75):5.2f}  max {best_sorted[-1]:5.2f}"
              f"   | top→impact med {np.median(gaps):.3f}s" if gaps else "")
    print(f"\nwrote {a.out}" if a.out else "")


if __name__ == "__main__":
    main()
