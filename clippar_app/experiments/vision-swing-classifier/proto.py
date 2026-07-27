#!/usr/bin/env python3
"""
proto.py — replace text prompts with IMAGE PROTOTYPES built from verified frames.

Text prompts are too blunt for this. Measured on IMG_0541 the motion stage found
a textbook bunker swing (club up, sand flying) as its #1 candidate and the text
gate rejected it at -0.041; meanwhile a golfer standing still scored higher on
other clips. Describing "a golfer at the top of the backswing" in words simply
does not separate these.

So: take the frames that were VISUALLY VERIFIED as correct tops, embed them
(already cached), and score candidates by similarity to those real examples.

HONESTY ABOUT EVALUATION
------------------------
The positive labels come from my own detections that I then checked by eye. That
is legitimate supervision, but scoring a clip using a prototype that contains
that same clip's frame would be circular and would inflate the result. So every
evaluation here is LEAVE-ONE-CLIP-OUT: a clip is always scored by a prototype
built only from OTHER clips. The reported numbers are what a genuinely unseen
clip would get.
"""
import argparse, json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from tune import analyse_cached  # noqa: E402

# Tops verified frame-by-frame from the contact sheets (iteration 2).
VERIFIED_TOPS = {
    "IMG_0523.MOV": 4.08, "IMG_0524.MOV": 11.08, "IMG_0527.MOV": 10.88,
    "IMG_0530.MOV": 12.34, "IMG_0534.MOV": 10.01, "IMG_0540.MOV": 9.66,
    "IMG_0545.MOV": 9.22, "IMG_0546.MOV": 8.91, "IMG_0550.MOV": 10.12,
    "IMG_0551.MOV": 7.42, "IMG_0552.MOV": 6.82, "IMG_0559.MOV": 9.12,
    "IMG_0560.MOV": 6.88, "IMG_0561.MOV": 6.55, "IMG_0562.MOV": 4.25,
    "IMG_0565.MOV": 7.82, "IMG_0568.MOV": 9.35, "IMG_0569.MOV": 7.02,
    "IMG_0578.MOV": 7.48, "IMG_0588.MOV": 9.48, "IMG_0591.MOV": 8.92,
    "IMG_0596.MOV": 4.88, "IMG_0599.MOV": 6.58, "IMG_0600.MOV": 8.98,
    "IMG_0601.MOV": 5.42,
    # Verified from the candidate inspection: motion found it, text gate wrongly
    # rejected it. Exactly the case image prototypes should fix.
    "IMG_0541.MOV": 5.91,
}

# Putting strokes verified from the candidate grids (cand_grid.py).
#
# These need their OWN prototype. A putt legitimately looks nothing like a full
# swing — no club above the head, body bent over the ball — so genuine putt
# frames score NEGATIVE against the swing prototype (measured -0.03 to -0.13 on
# IMG_0538, 0548, 0549), and a single gate rejects them. Scoring against
# max(swing, putt) is what lets one threshold serve both.
PUTT_TOPS = {
    "IMG_0526.MOV": 4.22, "IMG_0528.MOV": 6.04, "IMG_0529.MOV": 5.06,
    "IMG_0536.MOV": 4.69, "IMG_0537.MOV": 4.49, "IMG_0538.MOV": 1.16,
    "IMG_0548.MOV": 4.76, "IMG_0549.MOV": 5.17, "IMG_0553.MOV": 3.68,
    "IMG_0557.MOV": 5.32, "IMG_0558.MOV": 2.85, "IMG_0563.MOV": 9.48,
    "IMG_0566.MOV": 4.55, "IMG_0570.MOV": 4.32,
}

# How far from the verified top a frame must be to count as a NEGATIVE from the
# same clip (address, walking, waggling, watching the ball).
NEG_EXCLUDE = 2.0
POS_SPREAD = 0.10   # +/- this many seconds around the top also counts positive


def load_all(motion_cache, emb_cache):
    rows = []
    for npz in sorted(Path(motion_cache).glob("*.npz")):
        e = Path(emb_cache) / npz.name
        if not e.exists():
            continue
        r = analyse_cached(npz)
        d = np.load(e, allow_pickle=True)
        r["emb"] = d["emb"].astype(np.float32)
        r["efps"] = float(d["fps"])
        rows.append(r)
    return rows


def norm(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-8 else v


def build_bank(rows, exclude_file=None):
    """Return (swing exemplars, putt exemplars, negative exemplars)."""
    pos, putt, neg = [], [], []
    for r in rows:
        emb, fps = r["emb"], r["efps"]
        if len(emb) == 0:
            continue
        if r["label"] == "nothing":
            # Whole clip is a negative, but subsample so 25 long clips don't
            # swamp the positives.
            neg.append(emb[::5])
            continue
        t_ver = VERIFIED_TOPS.get(r["file"])
        t_putt = PUTT_TOPS.get(r["file"])
        t_ref = t_ver if t_ver is not None else t_putt
        if t_ref is None:
            continue
        if r["file"] == exclude_file:      # leave-one-clip-out
            continue
        lo = max(0, int((t_ref - POS_SPREAD) * fps))
        hi = min(len(emb), int((t_ref + POS_SPREAD) * fps) + 1)
        if hi > lo:
            (pos if t_ver is not None else putt).append(emb[lo:hi])
        # Everything well away from the stroke in a golf clip is the HARD
        # negative set: same course, same golfer, same light — just not swinging.
        t = np.arange(len(emb)) / fps
        far = np.abs(t - t_ref) > NEG_EXCLUDE
        if far.any():
            neg.append(emb[far][::3])
    P = np.concatenate(pos) if pos else np.zeros((0, 512), np.float32)
    Q = np.concatenate(putt) if putt else np.zeros((0, 512), np.float32)
    N = np.concatenate(neg) if neg else np.zeros((0, 512), np.float32)
    return P, Q, N


def score_frames(emb, P, N, mode="knn", topk=5, Q=None):
    """Positive evidence minus negative evidence, per frame.

    With a putt bank Q, a frame is scored against whichever stroke prototype it
    resembles more — max(swing, putt). A putt does not look like a full swing, so
    without this a single threshold cannot serve both."""
    if len(emb) == 0 or len(P) == 0:
        return np.zeros(len(emb))
    if mode == "mean":
        p = norm(P.mean(0))
        n = norm(N.mean(0)) if len(N) else np.zeros(P.shape[1], np.float32)
        best_pos = emb @ p
        if Q is not None and len(Q):
            best_pos = np.maximum(best_pos, emb @ norm(Q.mean(0)))
        return best_pos - emb @ n
    # k-NN: a swing seen face-on and one seen down-the-line are far apart in
    # embedding space, so averaging them blurs both. Nearest-exemplar keeps them
    # distinct.
    sp = emb @ P.T
    kp = min(topk, sp.shape[1])
    pos = np.sort(sp, axis=1)[:, -kp:].mean(1)
    if len(N) == 0:
        return pos
    sn = emb @ N.T
    kn = min(topk, sn.shape[1])
    negs = np.sort(sn, axis=1)[:, -kn:].mean(1)
    return pos - negs


# Candidates within this fraction of the best motion score count as a "tie" and
# are decided by the prototype instead.
#
# 0.50 measured best: swings 26/26 and putts 9/14. A narrow window (0.10) gives
# putts 7/14 because a putting stroke is NOT the largest motion in its clip —
# walking and bending to retrieve the ball are bigger — so the prototype needs
# real latitude to overrule motion. Widening to 0.80 breaks swings (24/26),
# where motion genuinely is the best evidence. 0.50 is the point where the
# prototype can rescue putts without outvoting motion on swings.
TIE_REL = 0.50


def pick(ok, rank, tie_rel=None):
    # Read the module global at CALL time, not as a default bound at import —
    # otherwise sweeping TIE_REL silently does nothing.
    tie_rel = TIE_REL if tie_rel is None else tie_rel
    if rank == "motion":
        return max(ok, key=lambda c: c["norm"])
    if rank == "proto":
        return max(ok, key=lambda c: c["proto"])
    if rank == "motion_tie":
        # MOTION DECIDES, CLIP BREAKS TIES.
        # Ranking purely by motion loses exact ties arbitrarily: on IMG_0592 the
        # real bunker swing (7.28s) and a golfer climbing out of the bunker
        # (18.65s) both scored norm 0.33, and the wrong one won on list order.
        # Ranking purely by prototype is worse (it peaks on the held finish and
        # moved IMG_0541 from 5.91s to 14.29s), so the prototype only
        # adjudicates between candidates motion considers equally good.
        best = max(c["norm"] for c in ok)
        near = [c for c in ok if c["norm"] >= best * (1 - tie_rel)]
        return max(near, key=lambda c: c["proto"])
    return max(ok, key=lambda c: c["proto"] * max(c["norm"], 1e-6))


def evaluate(rows, mode, min_score, win_before=0.4, win_after=0.9, rank="proto"):
    out = []
    for r in rows:
        P, Q, N = build_bank(rows, exclude_file=r["file"])   # leave-one-clip-out
        s = score_frames(r["emb"], P, N, mode, Q=Q)
        fps = r["efps"]
        cands = []
        for c in r["cands"]:
            i0 = max(0, int((c["t_top"] - win_before) * fps))
            i1 = min(len(s), int((c["t_top"] + win_after) * fps) + 1)
            c = dict(c, proto=float(np.sort(s[i0:i1])[-3:].mean()) if i1 > i0 else -9)
            cands.append(c)
        ok = [c for c in cands if c["proto"] >= min_score]
        # Rank by the PROTOTYPE score, not motion. Ranking by motion made the
        # gate the only thing CLIP influenced: on IMG_0592 the real bunker swing
        # (7.28s) and a golfer climbing out of the bunker (18.65s) both scored
        # norm 0.33, so the tie broke arbitrarily and picked the wrong one.
        best = pick(ok, rank) if ok else None
        out.append(dict(file=r["file"], label=r["label"], path=r["path"],
                        cands=cands,
                        decision="SWING" if best else "NO_SWING",
                        t_top=best["t_top"] if best else None,
                        t_impact=best["t_impact"] if best else None,
                        proto=best["proto"] if best else max((c["proto"] for c in cands), default=-9)))
    return out


def summarise(res):
    g = {}
    for l in sorted({r["label"] for r in res}):
        sub = [r for r in res if r["label"] == l]
        g[l] = (sum(1 for r in sub if r["decision"] == "SWING"), len(sub))
    return g


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--motion-cache", required=True)
    ap.add_argument("--emb-cache", required=True)
    ap.add_argument("--mode", choices=["knn", "mean"], default="knn")
    ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--rank", choices=["motion","proto","product","motion_tie"], default="proto")
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    rows = load_all(a.motion_cache, a.emb_cache)
    print(f"loaded {len(rows)} clips; {len(VERIFIED_TOPS)} verified tops\n")

    if a.sweep:
        print(f"{'rank':<8} {'min':>7} {'full_swing':>11} {'putt':>8} {'nothing FP':>12}")
        print("-" * 52)
        for rank in ("motion", "motion_tie", "proto", "product"):
            for ms in (-0.02, 0.0, 0.01, 0.02, 0.03, 0.05):
                g = summarise(evaluate(rows, "mean", ms, rank=rank))
                print(f"{rank:<8} {ms:>7.2f} {g.get('full_swing',(0,0))[0]:>7}/29"
                      f" {g.get('putt',(0,0))[0]:>6}/25 {g.get('nothing',(0,0))[0]:>9}/25")
        sys.exit(0)

    res = evaluate(rows, a.mode, a.min_score, rank=a.rank)
    g = summarise(res)
    for l, (n, tot) in g.items():
        print(f"{l:<12} {n:>3}/{tot:<3} ({100*n/tot:5.1f}%)")
    if a.out:
        for r in res:
            r.pop("emb", None)
        Path(a.out).write_text(json.dumps(res, indent=2))
        print("\nwrote", a.out)
