#!/usr/bin/env python3
"""
eval_timing.py — score TIMING, not just detection.

Detection rate is the easy half and it is misleading on its own: a config can
"detect" every clip and still point at the wrong second. Now that 26 tops have
been verified frame-by-frame, timing correctness is measurable directly, which
closes the tuning loop without re-inspecting contact sheets every iteration.

A prediction counts as correct when it lands within TOL of the verified top.
TOL = 0.15s is roughly the length of the transition itself, so anything inside
it is genuinely "at the top" rather than at address or at the finish.

Every number is leave-one-clip-out (see proto.py) — a clip is never scored using
a prototype containing its own frame.
"""
import argparse, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import proto  # noqa: E402

TOL = 0.15


def timing_score(res, tol=TOL):
    hit = miss = missing = 0
    wrong = []
    for r in res:
        t_ver = proto.VERIFIED_TOPS.get(r["file"])
        if t_ver is None:
            continue
        if r["decision"] != "SWING":
            missing += 1
            wrong.append((r["file"], None, t_ver))
            continue
        if abs(r["t_top"] - t_ver) <= tol:
            hit += 1
        else:
            miss += 1
            wrong.append((r["file"], round(r["t_top"], 2), t_ver))
    return hit, miss, missing, wrong


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--motion-cache", required=True)
    ap.add_argument("--emb-cache", required=True)
    ap.add_argument("--detail", action="store_true")
    a = ap.parse_args()

    rows = proto.load_all(a.motion_cache, a.emb_cache)
    n_ver = len(proto.VERIFIED_TOPS)
    print(f"{n_ver} verified tops; tolerance +/-{TOL}s; leave-one-clip-out\n")
    print(f"{'rank':<9}{'min':>6}{'timing':>10}{'wrong':>7}{'no-call':>9}"
          f"{'putt':>7}{'FP':>5}")
    print("-" * 54)
    best = None
    for rank in ("motion", "proto", "product"):
        for ms in (-0.02, 0.0, 0.01, 0.02, 0.03):
            res = proto.evaluate(rows, "mean", ms, rank=rank)
            hit, miss, missing, wrong = timing_score(res)
            g = proto.summarise(res)
            putt = g.get("putt", (0, 0))[0]
            fp = g.get("nothing", (0, 0))[0]
            print(f"{rank:<9}{ms:>6.2f}{hit:>7}/{n_ver}{miss:>7}{missing:>9}"
                  f"{putt:>5}/25{fp:>4}")
            key = (hit, -fp, putt)
            if best is None or key > best[0]:
                best = (key, rank, ms, wrong)
    print(f"\nBEST: rank={best[1]} min_score={best[2]}  -> {best[0][0]}/{n_ver} timing")
    if a.detail and best[3]:
        print("\nremaining timing failures (predicted vs verified):")
        for f, p, v in best[3]:
            print(f"  {f:<16} pred {str(p):>7}   verified {v}")
