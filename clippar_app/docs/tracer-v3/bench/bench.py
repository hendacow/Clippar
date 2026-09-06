#!/usr/bin/env python3
"""
bench.py — the one command. Runs detector -> ladder over the whole corpus under
imported-clip conditions and prints a table plus machine-readable JSON.

  ./bench.sh                     baseline: every clip at THE APP'S OWN IMPACT
  ./bench.sh --mode sweep        hit rate as a function of impact error
  ./bench.sh --mode truth        every clip at its confirmed true impact
  ./bench.sh --ids IMG_0601_2 …  just these

WHAT IS CACHED. Detector output is keyed by
(clip content hash, impact ms, tracerdet source hash), so a ladder-only change
re-uses every detection and the run takes seconds. Editing TracerDetect.swift or
TracerDetectCore.swift changes the source hash and invalidates the lot — you
cannot accidentally measure a stale detector.

WHAT IS NOT MEASURED HERE, and it matters: none of this runs on a phone. The
detector and the ladder are the shipped code, but they run on this Mac's Vision
and Core ML, and the RENDER is not exercised at all — "drew" means the ladder
returned a spec, not that an arc was ever drawn on a frame.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
WORK = os.environ.get("BENCH_WORK", os.path.join(HOME, ".cache/clippar-tracer-bench"))
APP = os.environ.get("APP", os.path.join(HOME, "projects/clippar/final_shipment/clippar_app"))
BENCH = os.path.join(APP, "docs/tracer-v3/bench")
DET = os.path.join(WORK, "tracerdet", "tracerdet")
CACHE = os.path.join(WORK, "detcache")

SWEEP_MS = [-3000, -2000, -1000, -500, -250, 0, 250, 500, 1000, 2000, 3000]

# The app's trim window default (Profile -> Trim settings; user-changeable).
PRE_ROLL_MS, POST_ROLL_MS = 2500, 1500


def det_hash():
    try:
        return open(os.path.join(WORK, "tracerdet.hash")).read().strip()
    except OSError:
        return "nohash"


DHASH = det_hash()


def load(name, default=None):
    p = os.path.join(WORK, name)
    if not os.path.exists(p):
        return default
    with open(p) as f:
        return json.load(f)


def run_detector(clip, impact_ms):
    """Cached. Returns (path_to_detection_json, wall_seconds, error|None)."""
    key = hashlib.sha256(
        f"{clip['contentKey']}|{int(impact_ms)}|{DHASH}".encode()).hexdigest()[:24]
    out = os.path.join(CACHE, key + ".json")
    if os.path.exists(out) and os.path.getsize(out) > 2:
        return out, 0.0, None
    os.makedirs(CACHE, exist_ok=True)
    t0 = time.time()
    try:
        r = subprocess.run([DET, clip.get("stagedPath") or clip["path"], str(int(impact_ms))],
                           capture_output=True, text=True, timeout=1200)
    except subprocess.TimeoutExpired:
        return None, time.time() - t0, "detector timeout"
    if r.returncode != 0 or not (r.stdout or "").strip():
        return None, time.time() - t0, f"detector rc={r.returncode} {(r.stderr or '')[:120]}"
    tmp = out + ".tmp"
    with open(tmp, "w") as f:
        f.write(r.stdout.strip().splitlines()[-1])
    os.replace(tmp, out)
    return out, time.time() - t0, None


def synth_plan(impact_sec, duration_sec):
    """The window the app WOULD build if its impact were exactly `impact_sec`.

    Used by --mode sweep/truth, where the impact is moved deliberately: the trim
    window has to move with it, because in the app both come from the same
    number. Same arithmetic as planHighlightTrim with the app's default window.
    """
    total = (PRE_ROLL_MS + POST_ROLL_MS) / 1000.0
    lead = min(PRE_ROLL_MS / 1000.0, total)
    if duration_sec <= total:
        return duration_sec, 0.0
    return total, min(max(impact_sec - lead, 0.0), duration_sec - total)


def trim_plan(imp, duration_sec):
    """The render window the app would produce, as (renderDurationSec, offsetSec).

    Mirrors modules/swing-vision/highlightTrim.planHighlightTrim for the
    swing-vision path, and detectAndTrim's own trimStart/trimEnd for the
    fallback. Both are read from the code, not guessed — see bench.md.
    """
    total = (PRE_ROLL_MS + POST_ROLL_MS) / 1000.0
    lead = min(PRE_ROLL_MS / 1000.0, total)
    src = imp.get("appImpactSource")
    if src == "swingVision":
        sv = imp.get("swingVision") or {}
        t = sv.get("tImpact")
        if (imp.get("appShotType") == "putt" or t is None or duration_sec <= total):
            return duration_sec, 0.0          # left whole
        start = min(max(t - lead, 0.0), duration_sec - total)
        return total, start
    if src == "shotDetector":
        sd = imp.get("shotDetector") or {}
        a, b = sd.get("trimStartMs"), sd.get("trimEndMs")
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and b > a:
            return (b - a) / 1000.0, a / 1000.0
    return duration_sec, 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="app", choices=["app", "sweep", "truth"])
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--out", default=None)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    clips = load("manifest.json", {"clips": []})["clips"]
    impacts = load("impacts.json", {})
    truth = load("truth.json", {})
    labels = json.load(open(os.path.join(BENCH, "classification.json")))["labels"]
    if args.ids:
        want = set(args.ids)
        clips = [c for c in clips if c["id"] in want]

    # ── build the (clip, impact) work list ────────────────────────────────────
    work = []          # (clip, impactMs, offsetMs|None, imprec)
    skipped = []       # rows the app itself would never trace
    for c in clips:
        imp = impacts.get(c["id"], {})
        dur = c.get("durationSec") or 0
        if args.mode == "app":
            ms = imp.get("appImpactMs")
            if ms is None:
                skipped.append((c, "no-impact (the app's own detectors found none)"))
                continue
            work.append((c, ms, None, imp))
        elif args.mode == "truth":
            t = truth.get(c["id"])
            if t is None:
                continue
            work.append((c, round(t * 1000), 0, imp))
        else:                                   # sweep
            t = truth.get(c["id"])
            if t is None:
                continue
            for off in SWEEP_MS:
                ms = round(t * 1000) + off
                if ms < 0 or ms > dur * 1000:
                    continue
                work.append((c, ms, off, imp))

    if not args.quiet:
        print(f"[bench] mode={args.mode}  {len(work)} detector runs "
              f"({len(skipped)} clips skipped before the detector)", flush=True)

    # ── detector, parallel across cores ───────────────────────────────────────
    t_start = time.time()
    done = [0]

    def do(item):
        c, ms, off, imp = item
        p, wall, err = run_detector(c, ms)
        done[0] += 1
        if not args.quiet and done[0] % 20 == 0:
            print(f"[bench] detector {done[0]}/{len(work)}  "
                  f"{time.time() - t_start:.0f}s", flush=True)
        return c, ms, off, imp, p, wall, err

    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        results = list(ex.map(do, work))

    # ── ladder, one node process for the whole batch ──────────────────────────
    jobs, meta = [], {}
    for c, ms, off, imp, p, wall, err in results:
        key = f"{c['id']}@{ms}"
        dur = c.get("durationSec") or 0
        if args.mode == "app":
            rdur, offs = trim_plan(imp, dur)
            st = "putt" if imp.get("appShotType") == "putt" else "swing"
        else:
            # SWEEP/TRUTH ISOLATE IMPACT ERROR, so the classifier is handed the
            # right answer (the human label) rather than the app's guess. Two
            # failure modes moving at once would make the curve unreadable — the
            # app's own classification is measured in --mode app, where it belongs.
            rdur, offs = synth_plan(ms / 1000.0, dur)
            st = "putt" if labels.get(c["id"], ["", ""])[0] == "putt" else "swing"
        meta[key] = dict(clip=c, impactMs=ms, offsetMs=off, detWallSec=round(wall, 2),
                         detErr=err, shotType=imp.get("appShotType"),
                         impactSource=imp.get("appImpactSource"))
        if p:
            jobs.append({"id": key, "detFile": p, "renderDurationSec": rdur,
                         "detectToRenderOffsetSec": offs, "shotType": st})

    lad = []
    if jobs:
        jf = os.path.join(WORK, "ladder_jobs.json")
        with open(jf, "w") as f:
            json.dump(jobs, f)
        t0 = time.time()
        r = subprocess.run(["node", "--import", "tsx", "docs/tracer-v3/bench/ladder.ts", jf],
                           cwd=APP, capture_output=True, text=True, timeout=3600)
        if r.returncode != 0:
            print(r.stderr[-3000:], file=sys.stderr)
            sys.exit("[bench] ladder failed")
        lad = json.loads(r.stdout)
        if not args.quiet:
            print(f"[bench] ladder {len(lad)} rows in {time.time() - t0:.1f}s", flush=True)
    by_key = {r["id"]: r for r in lad}

    # ── assemble ──────────────────────────────────────────────────────────────
    rows = []
    for key, m in meta.items():
        c = m["clip"]
        lr = by_key.get(key, {})
        rows.append({
            "id": c["id"], "corpus": c["corpus"],
            "class": labels.get(c["id"], ["?", "?"])[0],
            "classConf": labels.get(c["id"], ["?", "?"])[1],
            "durationSec": c.get("durationSec"),
            "impactMs": m["impactMs"], "offsetMs": m["offsetMs"],
            "impactSource": m["impactSource"], "appShotType": m["shotType"],
            "drew": bool(lr.get("drew")),
            "decision": lr.get("decision") or "detector-failed",
            "reason": lr.get("reason") or m["detErr"],
            "detReason": lr.get("detReason"),
            "detAddressPath": lr.get("detAddressPath"),
            "K": lr.get("K", 0), "nDet": lr.get("nDet", 0), "rmsPx": lr.get("rmsPx"),
            "pill": lr.get("pill"),
            "detWallSec": m["detWallSec"], "ladderMs": lr.get("ladderMs"),
            "flags": lr.get("flags", []),
        })
    for c, why in skipped:
        rows.append({
            "id": c["id"], "corpus": c["corpus"],
            "class": labels.get(c["id"], ["?", "?"])[0],
            "classConf": labels.get(c["id"], ["?", "?"])[1],
            "durationSec": c.get("durationSec"), "impactMs": None, "offsetMs": None,
            "impactSource": "none", "appShotType": None,
            "drew": False, "decision": "skip-before-detector", "reason": why,
            "detReason": None, "detAddressPath": None,
            "K": 0, "nDet": 0, "rmsPx": None, "pill": None,
            "detWallSec": 0.0, "ladderMs": 0, "flags": [],
        })

    out = args.out or os.path.join(WORK, f"results-{args.mode}.json")
    with open(out, "w") as f:
        json.dump({"mode": args.mode, "detHash": DHASH,
                   "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
                   "wallSec": round(time.time() - t_start, 1), "rows": rows}, f, indent=1)
    print(f"[bench] {len(rows)} rows -> {out}  ({time.time() - t_start:.0f}s wall)")
    subprocess.run([sys.executable, os.path.join(BENCH, "report.py"), out])


if __name__ == "__main__":
    main()
