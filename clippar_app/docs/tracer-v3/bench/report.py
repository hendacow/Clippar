#!/usr/bin/env python3
"""
report.py — turn a results JSON into a table a human can read honestly.

  python3 report.py $BENCH_WORK/results-app.json [--full]

THE NUMBERS IT PRINTS, and why each denominator is what it is:

  HIT RATE is over full_swing clips ONLY. Those are the clips where a golfer
  expects an arc. Putts, chips and not-a-shot clips are not in that denominator,
  because counting a correct refusal as a miss would make refusing look like a
  bug — and refusing is the product rule.

  FALSE DRAW is over putt + not_a_shot clips. This is the number that must stay
  at zero. Henry's rule outranks hit rate: it may skip, but it must never draw an
  arc over something that is not a golf shot. Any nonzero value here is a
  regression however good the hit rate looks.

  CHIPS are reported separately and belong to neither. A chip that refuses is
  acceptable; a chip that draws is a bonus. Folding them either way would move
  the headline number without anything changing.
"""
import collections
import json
import sys

CLASSES = ["full_swing", "chip", "putt", "not_a_shot"]


def pct(n, d):
    return "  n/a" if not d else f"{100.0 * n / d:5.1f}%"


def summarise(rows, title):
    print(f"\n{title}")
    print("-" * len(title))
    by = collections.defaultdict(list)
    for r in rows:
        by[r["class"]].append(r)

    fs = by.get("full_swing", [])
    drew_fs = [r for r in fs if r["drew"]]
    refuse_pool = by.get("putt", []) + by.get("not_a_shot", [])
    false_draw = [r for r in refuse_pool if r["drew"]]
    chips = by.get("chip", [])

    print(f"  HIT RATE   full_swing  {len(drew_fs):3d}/{len(fs):<3d} = {pct(len(drew_fs), len(fs))}")
    print(f"  FALSE DRAW putt+none   {len(false_draw):3d}/{len(refuse_pool):<3d} = "
          f"{pct(len(false_draw), len(refuse_pool))}   (MUST be 0)")
    print(f"  chips drawn            {sum(1 for r in chips if r['drew']):3d}/{len(chips):<3d} = "
          f"{pct(sum(1 for r in chips if r['drew']), len(chips))}   (neither credited nor charged)")
    if false_draw:
        print("    false draws: " + ", ".join(f"{r['id']}({r['class']})" for r in false_draw))

    # by corpus, on full_swing only
    print("\n  full_swing hit rate by corpus")
    cb = collections.defaultdict(lambda: [0, 0])
    for r in fs:
        cb[r["corpus"]][1] += 1
        cb[r["corpus"]][0] += 1 if r["drew"] else 0
    for k in sorted(cb):
        d, n = cb[k]
        print(f"    {k:8s} {d:3d}/{n:<3d} = {pct(d, n)}")

    # low-confidence labels, stated rather than hidden
    low = [r for r in fs if r.get("classConf") == "low"]
    if low:
        print(f"    ({len(low)} of the {len(fs)} full_swing labels are low-confidence: "
              + ", ".join(r["id"] for r in low) + ")")

    # ranked failure reasons over the clips that SHOULD have drawn
    misses = [r for r in fs if not r["drew"]]
    if misses:
        print(f"\n  why the {len(misses)} full_swing misses failed, ranked by clips cost")
        cnt = collections.Counter((r["reason"] or r["decision"] or "?") for r in misses)
        for reason, n in cnt.most_common():
            ids = [r["id"] for r in misses if (r["reason"] or r["decision"]) == reason][:6]
            print(f"    {n:3d}  {reason[:66]:<66} {' '.join(ids)}")


def main():
    path = sys.argv[1]
    full = "--full" in sys.argv
    d = json.load(open(path))
    rows = d["rows"]
    mode = d.get("mode")

    print(f"\n=== tracer bench — mode={mode}  detHash={d.get('detHash')}  "
          f"{d.get('generated')}  {d.get('wallSec')}s wall ===")

    if mode == "sweep":
        print("\nHIT RATE AS A FUNCTION OF IMPACT ERROR (full_swing clips with a "
              "confirmed true impact)")
        print("  offset      drew / clips            false draws")
        byoff = collections.defaultdict(list)
        for r in rows:
            byoff[r["offsetMs"]].append(r)
        for off in sorted(byoff, key=lambda x: (x is None, x)):
            rs = byoff[off]
            fs = [r for r in rs if r["class"] == "full_swing"]
            fd = [r for r in rs if r["class"] in ("putt", "not_a_shot") and r["drew"]]
            n = sum(1 for r in fs if r["drew"])
            bar = "#" * int(round(20 * n / max(len(fs), 1)))
            print(f"  {str(off):>7} ms  {n:3d}/{len(fs):<3d} {pct(n, len(fs))} {bar:<20}  {len(fd)}")
        return

    order = {c: i for i, c in enumerate(CLASSES)}
    if full:
        print(f"\n{'clip':<14}{'corp':<7}{'class':<11}{'dur':>6} {'impMs':>7} {'src':<13}"
              f"{'':<4}{'K':>3}{'nDet':>5}{'rms':>6}  reason / pill")
        for r in sorted(rows, key=lambda r: (order.get(r["class"], 9), r["corpus"], r["id"])):
            mark = "DREW" if r["drew"] else "   ."
            rms = f"{r['rmsPx']:.1f}" if isinstance(r["rmsPx"], (int, float)) else "  -"
            tail = r["pill"] if r["drew"] else (r["reason"] or r["decision"] or "")
            print(f"{r['id']:<14}{r['corpus']:<7}{r['class']:<11}{r['durationSec'] or 0:6.1f} "
                  f"{str(r['impactMs']):>7} {(r['impactSource'] or ''):<13}{mark:<4}"
                  f"{r['K']:>3}{r['nDet']:>5}{rms:>6}  {str(tail)[:58]}")

    summarise(rows, "ALL CORPORA")
    for corpus in ("henry", "lab", "unseen"):
        sub = [r for r in rows if r["corpus"] == corpus]
        if sub:
            summarise(sub, f"CORPUS: {corpus}  ({len(sub)} clips)")

    # cost ranking across EVERY clip that did not draw, whatever its class —
    # this is the list the tuning agent works down, so it is not filtered.
    print("\nEVERY REFUSAL REASON, ALL CLASSES, RANKED BY CLIPS")
    cnt = collections.Counter()
    cls = collections.defaultdict(collections.Counter)
    for r in rows:
        if r["drew"]:
            continue
        k = r["reason"] or r["decision"] or "?"
        cnt[k] += 1
        cls[k][r["class"]] += 1
    for reason, n in cnt.most_common():
        breakdown = " ".join(f"{c}:{v}" for c, v in cls[reason].most_common())
        print(f"  {n:3d}  {reason[:60]:<60} {breakdown}")

    det = [r["detWallSec"] for r in rows if r.get("detWallSec")]
    if det:
        det.sort()
        print(f"\nWALL TIME  detector median {det[len(det)//2]:.1f}s  max {det[-1]:.1f}s "
              f"(0.0 means served from cache)")


if __name__ == "__main__":
    main()
