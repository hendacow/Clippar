#!/usr/bin/env python3
"""
export_prototypes.py — bake the image prototypes into a JSON the app ships.

Replaces class_text_embeddings.json. Text prompts lost to image prototypes
decisively (they rejected a textbook bunker swing at -0.041), so the device
ships three 512-d unit vectors instead of four text embeddings:

    swing     averaged from the verified top-of-backswing frames
    putt      averaged from the verified putting-stroke frames
    negative  averaged from non-stroke frames — same courses, same golfers,
              same light, just not swinging — plus the non-golf clips

A frame scores  max(dot(f, swing), dot(f, putt)) - dot(f, negative).

Unlike the evaluation in proto.py this deliberately uses ALL verified clips with
no leave-one-out: leave-one-out exists to measure honestly, but the shipped
prototype should use every example available.

~6 KB total, versus the 69 MB Core ML model it is compared against.
"""
import argparse, json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import proto  # noqa: E402
import tune   # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--motion-cache", required=True)
    ap.add_argument("--emb-cache", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    rows = proto.load_all(a.motion_cache, a.emb_cache)
    P, Q, N = proto.build_bank(rows, exclude_file=None)   # ALL data, no LOO
    if len(P) == 0 or len(Q) == 0 or len(N) == 0:
        raise SystemExit(f"empty bank: swing={len(P)} putt={len(Q)} neg={len(N)}")

    swing = proto.norm(P.mean(0)).astype(float)
    putt = proto.norm(Q.mean(0)).astype(float)
    neg = proto.norm(N.mean(0)).astype(float)

    payload = {
        "version": 2,
        "model": "MobileCLIP2-S2",
        "dim": int(swing.shape[0]),
        "prototypes": {
            "swing": swing.tolist(),
            "putt": putt.tolist(),
            "negative": neg.tolist(),
        },
        # Every tuned constant travels WITH the vectors so the Swift and the
        # Python cannot silently drift apart.
        "params": {
            "minScore": -0.02,
            "tieRel": proto.TIE_REL,
            "edgeGuard": tune.EDGE_GUARD,
            "edgeGuardMaxFrac": 0.20,
            "upWindow": tune.UP_WINDOW,
            "backWindow": tune.BACK_WINDOW,
            "nmsGap": tune.NMS_GAP,
            "nCandidates": tune.N_CANDIDATES,
            "winBefore": 0.4,
            "winAfter": 0.9,
            "motionWidth": 160,
            "motionHeight": 90,
            "energyPercentile": 99.5,
            "embedFps": 10.0,
            # Stroke type is decided by POSE (SwingPose.shotMinWristHeight);
            # this bar only applies when Vision cannot lock on to a body.
            #
            # It is NOT the old 0.45. Appearance never worked here (prototype
            # voting 40/53), and motion alone tops out at 48/56 because a chip's
            # amplitude looks like a putt's. Pose-decides-motion-falls-back is
            # 53/56. Since the fallback now only runs on the hard clips, it is
            # biased toward leaving the clip whole: a wrongly trimmed putt loses
            # footage, a wrongly untrimmed shot merely loses the convenience.
            "puttFallbackNormMax": 0.60,
        },
        "counts": {
            "swingExemplars": int(len(P)),
            "puttExemplars": int(len(Q)),
            "negativeExemplars": int(len(N)),
            "swingClips": len(proto.VERIFIED_TOPS),
            "puttClips": len(proto.PUTT_TOPS),
        },
    }
    Path(a.out).write_text(json.dumps(payload))
    kb = Path(a.out).stat().st_size / 1024
    print(f"wrote {a.out}  ({kb:.1f} KB)")
    print(f"  swing  {len(P):5d} exemplars from {len(proto.VERIFIED_TOPS)} clips")
    print(f"  putt   {len(Q):5d} exemplars from {len(proto.PUTT_TOPS)} clips")
    print(f"  neg    {len(N):5d} exemplars")
    # Sanity: the three prototypes must actually be distinguishable.
    print(f"\n  cos(swing, putt)     {float(swing @ putt):+.3f}")
    print(f"  cos(swing, negative) {float(swing @ neg):+.3f}")
    print(f"  cos(putt,  negative) {float(putt @ neg):+.3f}")


if __name__ == "__main__":
    main()
