#!/usr/bin/env python3
"""
impacts.py — compute, for every clip, THE IMPACT THE APP WOULD HAND THE TRACER.

This is the whole point of the exercise. Henry asked to be tested "under the same
conditions", and the condition that matters most is that the impact instant is
not a human's and not an audio detector's — it is the app's own guess.

THE APP'S RULE, read out of the code, not assumed
  hooks/useEditorState.ts (both import call sites, lines ~846 and ~1080):
      const result = (await visionDetectAndTrim(...)) ?? (await detectAndTrim(...));
  lib/visionTrim.ts: visionDetectAndTrim returns null ONLY when
  config.detection.swingVision is false, the module is missing, the native call
  rejects, or `decision !== 'SWING'`. Otherwise it answers, and
  `impactTimeMs = Math.round(r.tImpact * 1000)`.
  constants/config.ts has `detection.swingVision: true`.
So:
    decision == SWING  ->  app impact = round(tImpact * 1000)      [swing-vision]
    decision != SWING  ->  app impact = detectAndTrim.impactTimeMs [shot-detector,
                           which is the raw pick + the 300 ms field calibration]
    neither found      ->  no impact; the tracer batch skips the clip outright
                           (useEditorState `rowSkip('no-impact')`).

Also records the AUDIO impact where the lab table has exactly one strong
transient, as a candidate TRUE impact — candidate, because a strong transient is
not always the strike. confirm.py is what promotes one to truth.

  python3 impacts.py [--jobs N] [--all-fallback] [ids...]
Writes $BENCH_WORK/impacts.json, incrementally — safe to interrupt and re-run.
"""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
WORK = os.environ.get("BENCH_WORK", os.path.join(HOME, ".cache/clippar-tracer-bench"))
SV = os.path.join(WORK, "svharness", "svharness")
SD = os.path.join(WORK, "sdharness", "sdharness")
OUT = os.path.join(WORK, "impacts.json")


def _hash(p):
    try:
        return open(p).read().strip()
    except OSError:
        return "?"


SV_HASH = _hash(os.path.join(WORK, "svharness.hash"))
SD_HASH = _hash(os.path.join(WORK, "sdharness.hash"))


def run_sv(path):
    t0 = time.time()
    try:
        r = subprocess.run([SV, path], capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    line = (r.stdout or "").strip().splitlines()
    if not line:
        return {"error": f"no output (rc={r.returncode}) {(r.stderr or '')[:160]}"}
    try:
        d = json.loads(line[-1])
    except json.JSONDecodeError:
        return {"error": f"unparseable: {line[-1][:160]}"}
    d["wallSec"] = round(time.time() - t0, 2)
    return d


def run_sd(path):
    """The simulator target. `simctl spawn` prints the module's own os_log noise
    on stdout too, so the payload is tagged @@JSON@@ by main.swift."""
    t0 = time.time()
    try:
        r = subprocess.run(["xcrun", "simctl", "spawn", "booted", SD, path],
                           capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    for ln in (r.stdout or "").splitlines():
        if ln.startswith("@@JSON@@"):
            try:
                d = json.loads(ln[len("@@JSON@@"):])
            except json.JSONDecodeError:
                return {"error": "unparseable payload"}
            d["wallSec"] = round(time.time() - t0, 2)
            return d
    return {"error": f"no payload (rc={r.returncode}) {(r.stderr or '')[:160]}"}


def app_impact(sv, sd):
    """The exact rule the app applies. Returns (impactMs|None, source, shotType)."""
    if sv and sv.get("decision") == "SWING" and isinstance(sv.get("tImpact"), (int, float)):
        return round(sv["tImpact"] * 1000), "swingVision", sv.get("strokeType") or "swing"
    if sd and sd.get("found") and isinstance(sd.get("impactTimeMs"), (int, float)):
        return round(sd["impactTimeMs"]), "shotDetector", sd.get("shotType") or "swing"
    return None, "none", None


def main():
    argv = sys.argv[1:]
    jobs = 6
    all_fallback = "--all-fallback" in argv
    if all_fallback:
        argv.remove("--all-fallback")
    if "--jobs" in argv:
        i = argv.index("--jobs")
        jobs = int(argv[i + 1]); del argv[i:i + 2]
    clips = json.load(open(os.path.join(WORK, "manifest.json")))["clips"]
    if argv:
        clips = [c for c in clips if c["id"] in set(argv)]

    cache = {}
    if os.path.exists(OUT):
        cache = json.load(open(OUT))

    todo = [c for c in clips
            if cache.get(c["id"], {}).get("svHash") != SV_HASH
            or cache.get(c["id"], {}).get("sdHash") != SD_HASH]
    print(f"[impacts] {len(todo)} to run of {len(clips)}", flush=True)

    def work(c):
        sv = run_sv(c.get("stagedPath") or c["path"])
        # THE APP ONLY ASKS SHOT-DETECTOR WHEN SWING-VISION ABSTAINS, and so does
        # this by default. It is not only faithfulness: on the simulator
        # detectAndTrim costs 30-230 s a clip (it runs Vision pose over the WHOLE
        # clip and then exports a trim), against 5 s for swing-vision on macOS, so
        # asking it for every clip triples the run for data the app never uses.
        # `--all-fallback` asks it anyway, for when the fallback itself is what
        # is being tuned.
        sd = {}
        if all_fallback or not (sv.get("decision") == "SWING"
                                and isinstance(sv.get("tImpact"), (int, float))):
            sd = run_sd(c.get("stagedPath") or c["path"])
        ms, src, st = app_impact(sv, sd)
        return c["id"], {
            "id": c["id"], "path": c["path"], "corpus": c["corpus"],
            "durationSec": c.get("durationSec"),
            "swingVision": sv, "shotDetector": sd,
            "appImpactMs": ms, "appImpactSource": src, "appShotType": st,
            "svHash": SV_HASH, "sdHash": SD_HASH,
        }

    done = 0
    with ThreadPoolExecutor(max_workers=jobs) as ex:
        for cid, rec in ex.map(work, todo):
            cache[cid] = rec
            done += 1
            if done % 5 == 0 or done == len(todo):
                with open(OUT, "w") as f:
                    json.dump(cache, f, indent=1)
                print(f"[impacts] {done}/{len(todo)}", flush=True)
    with open(OUT, "w") as f:
        json.dump(cache, f, indent=1)

    n_sv = sum(1 for r in cache.values() if r.get("appImpactSource") == "swingVision")
    n_sd = sum(1 for r in cache.values() if r.get("appImpactSource") == "shotDetector")
    n_no = sum(1 for r in cache.values() if r.get("appImpactSource") == "none")
    print(f"[impacts] app impact from swing-vision {n_sv}, shot-detector {n_sd}, none {n_no}")


if __name__ == "__main__":
    main()
