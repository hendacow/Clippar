#!/usr/bin/env python3
"""
rank.py — combine cached motion candidates with cached CLIP embeddings.

Motion says WHEN precisely but cannot say IF: measured on the 79-clip set, the
`nothing/` clips score a median valley of 0.71 versus 0.68 for real swings —
completely overlapping. Someone walking, raking a bunker or climbing out of one
produces the same dip-then-spike shape as a downswing.

So CLIP RE-RANKS the candidates rather than merely gating the top one. On
IMG_0560 the real swing (6.88s) was in the candidate list but ranked below the
golfer standing in the bunker; promoting by swing evidence is what recovers it.

Everything here reads from caches, so a full sweep over all 79 clips takes
seconds and the decision rule can be iterated to convergence.
"""
import argparse, json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from tune import analyse_cached  # noqa: E402

SWING_PROMPTS = [
    "a golfer at the top of the backswing with the club raised above their head",
    "a golfer striking the golf ball, club head at the ball",
    "a golfer in the follow-through finish position, club over their shoulder",
    "a golfer swinging a golf club hard",
    "a golfer making a putting stroke on the green, putter moving",
]
STILL_PROMPTS = [
    "a golfer standing still, not swinging",
    "a person walking on a golf course",
    "a person bending down to pick up a golf ball",
    "an empty golf course with nobody on it",
    "a person standing in a bunker raking sand",
    "grass and sky, no people",
]

# Window around a candidate to judge "is a golfer swinging here": a little
# before the top through the finish.
WIN_BEFORE, WIN_AFTER = 0.4, 0.9


def text_embeddings(cache_path):
    """Compute once, reuse forever — avoids a 20s model load per sweep."""
    p = Path(cache_path)
    if p.exists():
        d = np.load(p)
        return d["swing"], d["still"]
    import torch, open_clip
    model, _, _ = open_clip.create_model_and_transforms("MobileCLIP2-S2", pretrained="dfndr2b")
    model.eval()
    tok = open_clip.get_tokenizer("MobileCLIP2-S2")
    with torch.no_grad():
        sw = torch.nn.functional.normalize(model.encode_text(tok(SWING_PROMPTS)), dim=-1).numpy()
        st = torch.nn.functional.normalize(model.encode_text(tok(STILL_PROMPTS)), dim=-1).numpy()
    np.savez(p, swing=sw.astype(np.float32), still=st.astype(np.float32))
    return sw.astype(np.float32), st.astype(np.float32)


def score_candidates(cands, emb, fps, sw_t, st_t, topk=3):
    """Attach CLIP evidence to each motion candidate."""
    if len(emb) == 0:
        return cands
    s_sw = emb @ sw_t.T           # (N, n_swing)
    s_st = emb @ st_t.T
    best_sw, best_st = s_sw.max(1), s_st.max(1)
    margin = best_sw - best_st
    golf = np.maximum(best_sw, best_st)
    for c in cands:
        i0 = max(0, int((c["t_top"] - WIN_BEFORE) * fps))
        i1 = min(len(emb), int((c["t_top"] + WIN_AFTER) * fps) + 1)
        if i1 <= i0:
            c["swing"], c["golf"] = -1.0, 0.0
            continue
        w = margin[i0:i1]
        # Only a few frames of the window are the swing itself, so judge on the
        # best few rather than the mean.
        c["swing"] = float(np.sort(w)[-topk:].mean())
        c["golf"] = float(golf[i0:i1].max())

    # The single most golf-swing-looking MOMENT in the clip, regardless of
    # motion. Used by rank="region": CLIP is reliable at finding WHERE in time
    # the action is (that was true even in the first experiment) but cannot
    # resolve the instant, so it selects the region and motion picks the frame.
    k = max(1, int(0.3 * fps))
    sm = np.convolve(margin, np.ones(k) / k, mode="same")
    t_focus = float(np.argmax(sm) / fps)
    return cands, t_focus, float(sm.max())


def decide(cands, min_golf, min_swing, rank, t_focus=None, focus_window=2.0):
    ok = [c for c in cands if c.get("golf", 0) >= min_golf and c.get("swing", -1) >= min_swing]
    if not ok:
        return None
    if rank == "motion":
        return max(ok, key=lambda c: c["norm"])
    if rank == "swing":
        return max(ok, key=lambda c: c["swing"])
    if rank == "region" and t_focus is not None:
        # Keep only candidates near where CLIP says the action is, then let
        # motion choose the exact instant. Falls back to the full set if the
        # region contains no candidate.
        near = [c for c in ok if abs(c["t_top"] - t_focus) <= focus_window]
        return max(near or ok, key=lambda c: c["norm"])
    return max(ok, key=lambda c: c["swing"] * c["norm"])   # product


def run(motion_cache, emb_cache, text_cache, min_golf, min_swing, rank):
    sw_t, st_t = text_embeddings(text_cache)
    rows = []
    for npz in sorted(Path(motion_cache).glob("*.npz")):
        e = Path(emb_cache) / npz.name
        r = analyse_cached(npz)
        if not e.exists():
            r["decision"] = "NO_EMBED"
            rows.append(r)
            continue
        d = np.load(e, allow_pickle=True)
        emb = d["emb"].astype(np.float32)
        cands, t_focus, focus_peak = score_candidates(
            r["cands"], emb, float(d["fps"]), sw_t, st_t)
        best = decide(cands, min_golf, min_swing, rank, t_focus)
        r["cands"] = cands
        r["t_focus"], r["focus_peak"] = t_focus, focus_peak
        if best:
            r.update(decision="SWING", t_top=best["t_top"], t_impact=best["t_impact"],
                     norm=best["norm"], swing=best["swing"], golf=best["golf"])
        else:
            r.update(decision="NO_SWING", t_top=None, t_impact=None,
                     swing=max((c.get("swing", -1) for c in cands), default=-1),
                     golf=max((c.get("golf", 0) for c in cands), default=0))
        rows.append(r)
    return rows


def report(rows):
    labels = sorted({r["label"] for r in rows})
    print(f"{'label':<12} {'n':>4} {'detected':>9} {'rate':>7}")
    print("-" * 40)
    out = {}
    for l in labels:
        sub = [r for r in rows if r["label"] == l]
        n = sum(1 for r in sub if r["decision"] == "SWING")
        out[l] = (n, len(sub))
        print(f"{l:<12} {len(sub):>4} {n:>9} {100*n/len(sub):>6.1f}%")
    if "nothing" in out:
        fp, tot = out["nothing"]
        print(f"\nfalse positives on 'nothing': {fp}/{tot}")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--motion-cache", required=True)
    ap.add_argument("--emb-cache", required=True)
    ap.add_argument("--text-cache", required=True)
    ap.add_argument("--min-golf", type=float, default=0.22)
    ap.add_argument("--min-swing", type=float, default=0.02)
    ap.add_argument("--rank", choices=["motion", "swing", "product", "region"],
                    default="region")
    ap.add_argument("--out", default=None)
    ap.add_argument("--sweep", action="store_true")
    a = ap.parse_args()

    if a.sweep:
        sw_t, st_t = text_embeddings(a.text_cache)
        print(f"{'rank':<8} {'min_swing':>9} {'full_swing':>11} {'putt':>7} {'nothing FP':>11}")
        print("-" * 52)
        for rank in ("motion", "swing", "product", "region"):
            for ms in (0.00, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06):
                rows = run(a.motion_cache, a.emb_cache, a.text_cache, a.min_golf, ms, rank)
                g = {l: sum(1 for r in rows if r["label"] == l and r["decision"] == "SWING")
                     for l in {r["label"] for r in rows}}
                print(f"{rank:<8} {ms:>9.2f} {g.get('full_swing',0):>7}/29 {g.get('putt',0):>4}/25"
                      f" {g.get('nothing',0):>8}/25")
        sys.exit(0)

    rows = run(a.motion_cache, a.emb_cache, a.text_cache, a.min_golf, a.min_swing, a.rank)
    report(rows)
    if a.out:
        Path(a.out).write_text(json.dumps(rows, indent=2))
        print(f"\nwrote {a.out}")
