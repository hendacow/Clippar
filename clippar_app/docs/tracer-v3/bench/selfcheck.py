#!/usr/bin/env python3
"""
selfcheck.py — assertions about the BENCH's own data, so a future session finds
out the corpus drifted instead of quietly measuring the wrong thing.

  python3 selfcheck.py        # exits non-zero on any failure

It does not check the pipeline. It checks the things that can silently rot:
new clips appearing unlabelled, ids colliding, truth entries pointing at clips
that no longer exist, a truth time past the end of its clip, a hardlink that has
been replaced by a stale copy, and results measured with a stale detector.
"""
import json
import os
import sys

W = os.environ.get("BENCH_WORK", os.path.expanduser("~/.cache/clippar-tracer-bench"))
HERE = os.path.dirname(os.path.abspath(__file__))
fails = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def load(p, default=None):
    try:
        with open(p) as f:
            return json.load(f)
    except OSError:
        return default


man = load(os.path.join(W, "manifest.json"))
if man is None:
    sys.exit("no manifest.json — run manifest.py first")
clips = man["clips"]
ids = [c["id"] for c in clips]
labels = json.load(open(os.path.join(HERE, "classification.json")))["labels"]

print("manifest")
check(len(ids) == len(set(ids)), f"{len(ids)} clip ids are unique")
check(all(c.get("durationSec", 0) > 0 for c in clips),
      "every clip probed to a positive duration")
missing_stage = [c["id"] for c in clips if not os.path.exists(c.get("stagedPath") or "")]
check(not missing_stage, f"every clip is staged ({len(missing_stage)} missing)")
same = [c["id"] for c in clips
        if c.get("stagedPath") and os.path.exists(c["stagedPath"])
        and not os.path.samefile(c["stagedPath"], c["path"])]
check(not same, f"staged files are hardlinks to the originals, not stale copies "
                f"({len(same)} diverged: {same[:5]})")

print("classification")
unlabelled = sorted(set(ids) - set(labels))
check(not unlabelled,
      f"every clip is classified ({len(unlabelled)} new and unlabelled: {unlabelled[:8]})")
orphan = sorted(set(labels) - set(ids))
check(not orphan, f"no label points at a clip that is gone ({orphan[:8]})")
check(all(v[0] in ("full_swing", "chip", "putt", "not_a_shot") for v in labels.values()),
      "every class is one of the four")
check(all(v[1] in ("clear", "low") for v in labels.values()),
      "every confidence is clear|low")

print("truth")
truth = load(os.path.join(W, "truth.json"), {})
by_id = {c["id"]: c for c in clips}
check(all(k in by_id for k in truth),
      "every truth entry names a clip in the manifest")
bad_t = [k for k, t in truth.items()
         if k in by_id and not (0 < t < (by_id[k].get("durationSec") or 0))]
check(not bad_t, f"every truth impact is inside its clip ({bad_t})")
not_swing = [k for k in truth if labels.get(k, ["?"])[0] != "full_swing"]
check(not not_swing,
      f"truth only covers full swings ({not_swing}) — the sweep denominator "
      f"assumes it")

print("results")
dhash = open(os.path.join(W, "tracerdet.hash")).read().strip() \
    if os.path.exists(os.path.join(W, "tracerdet.hash")) else None
for mode in ("app", "truth", "sweep"):
    r = load(os.path.join(W, f"results-{mode}.json"))
    if r is None:
        print(f"  --   results-{mode}.json not present")
        continue
    check(r.get("detHash") == dhash,
          f"results-{mode}.json was measured with the CURRENT detector "
          f"({r.get('detHash')} vs {dhash})")

print()
if fails:
    print(f"{len(fails)} FAILED")
    sys.exit(1)
print("all checks passed")
