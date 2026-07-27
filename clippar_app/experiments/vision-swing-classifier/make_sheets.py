#!/usr/bin/env python3
"""
make_sheets.py — build human-verifiable contact sheets from swing_time.py output.

The point of this file is that an accuracy number nobody has eyeballed is worth
very little. For every clip we pull the exact frame the detector called the top
of the backswing, label it with the clip name and timestamp, and tile them. One
glance tells you whether the detector is right, and the timestamp lets you scrub
to that moment in the original clip to confirm.

  sheets/<label>_topN.jpg     the detected top-of-swing frame per clip
  strips/<clip>.jpg           8-frame filmstrip spanning the detected top
"""
import argparse, json, subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def font(size):
    for f in FONT_CANDIDATES:
        if Path(f).exists():
            try:
                return ImageFont.truetype(f, size)
            except Exception:
                pass
    return ImageFont.load_default()


def grab(path, t, width=360):
    """Single frame at time t as a PIL image."""
    cmd = ["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox",
           "-ss", f"{max(0, t):.3f}", "-i", str(path), "-frames:v", "1",
           "-vf", f"scale={width}:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-"]
    buf = subprocess.run(cmd, capture_output=True).stdout
    if not buf:
        return None
    import io
    try:
        return Image.open(io.BytesIO(buf)).convert("RGB")
    except Exception:
        return None


def label(img, text, sub=None):
    d = ImageDraw.Draw(img)
    h = 34 if sub else 22
    d.rectangle([0, 0, img.width, h], fill=(0, 0, 0))
    d.text((5, 2), text, fill=(255, 255, 255), font=font(15))
    if sub:
        d.text((5, 18), sub, fill=(120, 255, 160), font=font(13))
    return img


def sheet(cells, cols=4, pad=6):
    if not cells:
        return None
    w = max(c.width for c in cells)
    h = max(c.height for c in cells)
    rows = (len(cells) + cols - 1) // cols
    out = Image.new("RGB", (cols * w + pad * (cols + 1), rows * h + pad * (rows + 1)),
                    (28, 28, 30))
    for i, c in enumerate(cells):
        r, q = divmod(i, cols)
        out.paste(c, (pad + q * (w + pad), pad + r * (h + pad)))
    return out


def strip(path, t, out_path, n=8, span=0.40, width=260):
    """Filmstrip centred on t, so you can see the club reverse direction."""
    start = max(0, t - span / 2)
    fps = n / span
    cmd = ["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox",
           "-ss", f"{start:.3f}", "-i", str(path), "-t", f"{span:.3f}",
           "-vf", f"fps={fps:.2f},scale={width}:-2,tile={n}x1:margin=3:padding=3:color=white",
           "-frames:v", "1", "-y", str(out_path)]
    subprocess.run(cmd, capture_output=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("results", nargs="+")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--per-sheet", type=int, default=12)
    ap.add_argument("--strips", action="store_true")
    a = ap.parse_args()
    out = Path(a.outdir)
    (out / "sheets").mkdir(parents=True, exist_ok=True)
    if a.strips:
        (out / "strips").mkdir(parents=True, exist_ok=True)

    # Group by the clip's source folder (its label), not by which worker's
    # result file it happened to land in.
    buckets = {}
    for rf in a.results:
        for r in json.loads(Path(rf).read_text()):
            # tune.py emits ranked candidates; swing_time.py emits a decision.
            # Normalise both to the same shape so the sheets work either way.
            if "cands" in r and "t_top" not in r:
                c = r["cands"][0] if r["cands"] else None
                r = dict(r, decision="SWING" if c else "NO_SWING",
                         t_top=c["t_top"] if c else None,
                         t_impact=c["t_impact"] if c else None,
                         swing_margin=c["norm"] if c else 0.0)
            buckets.setdefault(r.get("label") or Path(r["path"]).parent.name, []).append(r)

    for name, rows in sorted(buckets.items()):
        rows.sort(key=lambda r: r["file"])
        cells = []
        for r in rows:
            if r.get("decision") == "SWING":
                t = r["t_top"]
                img = grab(r["path"], t)
                if img is None:
                    continue
                cells.append(label(img, f'{r["file"]}',
                                   f'TOP {t:.2f}s  imp {r["t_impact"]:.2f}s  '
                                   f'm{r.get("swing_margin", r.get("swing", 0)):+.3f}'))
                if a.strips:
                    strip(r["path"], t, out / "strips" / f'{Path(r["file"]).stem}.jpg')
            else:
                # Show the middle of the clip so a wrong rejection is obvious.
                img = grab(r["path"], (r.get("dur") or 2) / 2)
                if img is None:
                    continue
                cells.append(label(img, f'{r["file"]}',
                                   f'{r["decision"]}  m{r.get("swing_margin", r.get("swing", 0) or 0):+.3f}'))
        for i in range(0, len(cells), a.per_sheet):
            s = sheet(cells[i:i + a.per_sheet], cols=a.cols)
            if s:
                p = out / "sheets" / f"{name}_{i // a.per_sheet + 1:02d}.jpg"
                s.save(p, quality=88)
                print("wrote", p)
