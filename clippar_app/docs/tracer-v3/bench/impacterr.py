#!/usr/bin/env python3
"""
impacterr.py — how wrong is the app's own impact, against the confirmed truth?

This is the single most useful number for the tuning agent, because everything
the detector reads is anchored to the impact it is handed: the background stack,
the three address frames, the departure scan and the launch search.

  python3 impacterr.py [--full]

Only the clips in truth.json can appear here — 26 of 121 — so this is a
distribution over confirmed full swings, not over the whole corpus.
"""
import json
import os
import statistics
import sys

W = os.environ.get("BENCH_WORK", os.path.expanduser("~/.cache/clippar-tracer-bench"))
imp = json.load(open(os.path.join(W, "impacts.json")))
tru = json.load(open(os.path.join(W, "truth.json")))
man = {c["id"]: c for c in json.load(open(os.path.join(W, "manifest.json")))["clips"]}

rows = []
for cid, t in sorted(tru.items()):
    r = imp.get(cid)
    if not r:
        rows.append((cid, None, "not-run", None))
        continue
    ms = r.get("appImpactMs")
    rows.append((cid, None if ms is None else round(ms / 1000.0 - t, 3),
                 r.get("appImpactSource"), r.get("appShotType")))

if "--full" in sys.argv:
    print(f"{'clip':<13}{'corpus':<8}{'err (s)':>9}  {'source':<13}{'app says'}")
    for cid, err, src, st in sorted(rows, key=lambda x: (x[1] is None, abs(x[1] or 0))):
        print(f"{cid:<13}{man.get(cid, {}).get('corpus', '?'):<8}"
              f"{('  none' if err is None else f'{err:+.2f}'):>9}  {src:<13}{st or ''}")

errs = [abs(e) for _, e, _, _ in rows if e is not None]
if not errs:
    sys.exit("no overlap between impacts.json and truth.json yet")

print(f"\nAPP IMPACT ERROR vs confirmed truth — {len(errs)} clips")
print(f"  median |error|   {statistics.median(errs):.2f} s")
print(f"  mean   |error|   {statistics.mean(errs):.2f} s")
print(f"  worst            {max(errs):.2f} s")
for b in (0.25, 0.5, 1.0, 2.0, 3.0):
    n = sum(1 for e in errs if e <= b)
    print(f"  within +-{b:<4}   {n:3d}/{len(errs):<3d} = {100.0*n/len(errs):5.1f}%")
signed = [e for _, e, _, _ in rows if e is not None]
print(f"  median SIGNED error {statistics.median(signed):+.2f} s "
      f"(negative = the app thinks impact is EARLIER than it is)")
src = {}
for _, e, s, _ in rows:
    src.setdefault(s, []).append(e)
print("\n  by source:")
for s, es in src.items():
    got = [abs(x) for x in es if x is not None]
    print(f"    {s:<13} {len(es):3d} clips" +
          (f"  median |err| {statistics.median(got):.2f} s" if got else ""))
puttish = [(c, e) for c, e, _, st in rows if st == "putt" and e is not None]
if puttish:
    print(f"\n  {len(puttish)} of these confirmed FULL SWINGS were classified 'putt' by the app: "
          + ", ".join(c for c, _ in puttish))
