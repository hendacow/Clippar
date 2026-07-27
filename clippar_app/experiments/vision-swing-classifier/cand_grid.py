#!/usr/bin/env python3
"""
cand_grid.py — one ROW per clip, one COLUMN per motion candidate.

Labelling putts needs the correct moment picked out of each clip's candidate
list. Rendering a separate image per clip means 25 images to review; a grid puts
5 clips (30 candidates) on one sheet, which is the difference between a
reviewable set and an unreviewable one.

The picked candidate is tinted green so a wrong pick is obvious at a glance.
"""
import argparse, json, sys
from pathlib import Path
from PIL import ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from make_sheets import grab, font, sheet  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--label", required=True, help="only clips with this label")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--cols", type=int, default=6, help="candidates per clip")
    ap.add_argument("--rows", type=int, default=5, help="clips per sheet")
    ap.add_argument("--width", type=int, default=230)
    a = ap.parse_args()

    rows = [r for r in json.loads(Path(a.results).read_text()) if r.get("label") == a.label]
    rows.sort(key=lambda r: r["file"])
    out = Path(a.outdir)
    out.mkdir(parents=True, exist_ok=True)

    cells, n_sheet = [], 0
    for idx, r in enumerate(rows):
        chosen = r.get("t_top")
        cands = (r.get("cands") or [])[: a.cols]
        # A clip can legitimately have zero candidates (the edge guard can remove
        # them all on a short clip), so the filler must not depend on a previous
        # cell existing.
        def blank():
            from PIL import Image
            ref = next((c for c in cells if c), None)
            size = (ref.width, ref.height) if ref else (a.width, int(a.width * 16 / 9))
            return Image.new("RGB", size, (18, 18, 20))

        for j in range(a.cols):
            if j >= len(cands):
                cells.append(blank())
                continue
            c = cands[j]
            img = grab(r["path"], c["t_top"], width=a.width)
            if img is None:
                cells.append(blank())
                continue
            picked = chosen is not None and abs(c["t_top"] - chosen) < 1e-6
            d = ImageDraw.Draw(img)
            d.rectangle([0, 0, img.width, 32], fill=(0, 95, 0) if picked else (0, 0, 0))
            d.text((4, 1), f'{r["file"]}  #{j+1}{"  PICKED" if picked else ""}',
                   fill=(255, 255, 255), font=font(13))
            d.text((4, 16), f't {c["t_top"]:.2f}s  n {c["norm"]:.2f}  '
                            f'p {c.get("proto", 0):+.3f}',
                   fill=(150, 255, 180), font=font(12))
            cells.append(img)
        if (idx + 1) % a.rows == 0 or idx == len(rows) - 1:
            n_sheet += 1
            s = sheet(cells, cols=a.cols)
            if s:
                p = out / f"{a.label}_grid_{n_sheet:02d}.jpg"
                s.save(p, quality=85)
                print("wrote", p)
            cells = []


if __name__ == "__main__":
    main()
