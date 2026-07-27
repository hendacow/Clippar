#!/usr/bin/env python3
"""
inspect_cands.py — render one frame per motion candidate for a clip.

When a clip is called wrong, this answers the only question that matters: is the
correct moment even in the candidate list? If yes the fix belongs in ranking; if
no it belongs in candidate generation. Guessing between those two wastes far
more time than rendering eight thumbnails.
"""
import argparse, json, subprocess, io, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from make_sheets import grab, font, sheet  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--files", nargs="+", required=True, help="clip filenames")
    ap.add_argument("--outdir", required=True)
    a = ap.parse_args()
    rows = {r["file"]: r for r in json.loads(Path(a.results).read_text())}
    out = Path(a.outdir)
    out.mkdir(parents=True, exist_ok=True)

    for f in a.files:
        r = rows.get(f)
        if not r:
            print("no row for", f)
            continue
        cells = []
        chosen = r.get("t_top")
        for i, c in enumerate(r.get("cands", [])):
            img = grab(r["path"], c["t_top"], width=300)
            if img is None:
                continue
            picked = chosen is not None and abs(c["t_top"] - chosen) < 1e-6
            d = ImageDraw.Draw(img)
            d.rectangle([0, 0, img.width, 34], fill=(0, 90, 0) if picked else (0, 0, 0))
            d.text((5, 2), f'#{i+1} {"<= PICKED" if picked else ""}',
                   fill=(255, 255, 255), font=font(15))
            d.text((5, 18), f't {c["t_top"]:.2f}s  norm {c["norm"]:.2f}  '
                            f'sw {c.get("swing", 0):+.3f}  golf {c.get("golf", 0):.2f}',
                   fill=(140, 255, 170), font=font(12))
            cells.append(img)
        s = sheet(cells, cols=len(cells) or 1)
        if s:
            p = out / f'{Path(f).stem}_cands.jpg'
            s.save(p, quality=88)
            print("wrote", p, f'({len(cells)} candidates, decision={r["decision"]})')


if __name__ == "__main__":
    main()
