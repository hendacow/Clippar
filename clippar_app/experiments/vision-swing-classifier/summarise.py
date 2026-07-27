#!/usr/bin/env python3
"""
summarise.py — turn swing_time.py output into the numbers that decide whether
this ships.

Detection rate is per-folder because the correct answer differs by folder:
  full_swing/  → must be SWING (and the timestamp must be right)
  putt/        → should be SWING; a putting stroke is still a stroke to trim on
  nothing/     → must be NO_SWING; anything else is a false positive

Timestamp correctness cannot be scored here — there are no hand-labelled swing
times. Use make_sheets.py and look at the frames.
"""
import json, sys
from pathlib import Path
import statistics as st


def load(p):
    return json.loads(Path(p).read_text())


def pct(n, d):
    return f"{100 * n / d:5.1f}%" if d else "    —"


def group_by_label(paths):
    """Workers process a mixed slice of clips, so recover the label from each
    clip's parent folder rather than from which result file it landed in."""
    buckets = {}
    for p in paths:
        for r in load(p):
            lbl = Path(r["path"]).parent.name
            buckets.setdefault(lbl, []).append(r)
    return buckets


def main(paths):
    grand = {}
    for name, rows in sorted(group_by_label(paths).items()):
        sw = [r for r in rows if r.get("decision") == "SWING"]
        other = [r for r in rows if r.get("decision") != "SWING"]
        grand[name] = dict(total=len(rows), swing=len(sw), other=other)

        print(f"\n{'=' * 74}\n{name.upper()}   {len(rows)} clips\n{'=' * 74}")
        print(f"  detected SWING : {len(sw):3d}  ({pct(len(sw), len(rows))})")
        for d in sorted({r.get('decision') for r in other}):
            n = sum(1 for r in other if r.get("decision") == d)
            print(f"  {d:<15}: {n:3d}  ({pct(n, len(rows))})")

        if sw:
            m = [r["swing_margin"] for r in sw]
            g = [r["golf_sim"] for r in sw]
            ri = [r["rise"] for r in sw]
            gap = [r["t_impact"] - r["t_top"] for r in sw]
            print(f"\n  swing_margin  min {min(m):+.3f}  med {st.median(m):+.3f}  max {max(m):+.3f}")
            print(f"  golf_sim      min {min(g):.3f}  med {st.median(g):.3f}  max {max(g):.3f}")
            print(f"  rise          min {min(ri):5.1f}  med {st.median(ri):5.1f}  max {max(ri):5.1f}")
            print(f"  top→impact    min {min(gap):.3f}s med {st.median(gap):.3f}s max {max(gap):.3f}s"
                  f"   (downswing duration — expect ~0.20s)")
        if other:
            om = [r.get("swing_margin", 0) for r in other]
            if om:
                print(f"\n  rejected clips' best margin: min {min(om):+.3f}  "
                      f"med {st.median(om):+.3f}  max {max(om):+.3f}")

    # Separation between the classes we most need to tell apart.
    fs = grand.get("full_swing")
    no = grand.get("nothing")
    if fs and no:
        print(f"\n{'=' * 74}\nHEADLINE\n{'=' * 74}")
        print(f"  real swings found        : {fs['swing']}/{fs['total']}  "
              f"({pct(fs['swing'], fs['total'])})")
        fp = no["total"] - len(no["other"])
        print(f"  false swings on 'nothing': {fp}/{no['total']}  "
              f"({pct(fp, no['total'])})")


if __name__ == "__main__":
    main(sys.argv[1:])
