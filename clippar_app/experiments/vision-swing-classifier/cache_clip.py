#!/usr/bin/env python3
"""
cache_clip.py — embed every clip densely with MobileCLIP2, ONCE.

Re-ranking candidates by "is a golfer mid-swing here?" is the remaining tuning
knob, and re-running inference per iteration costs ~55s/clip. Embedding the whole
clip once at a fixed rate turns every later experiment into an array slice: a
candidate window is just an index range into the cached (N, 512) matrix.

The crop is motion-guided and clip-level (from the cached gray frames): a golfer
40m away is a handful of pixels in a 4K frame, and cropping to where the motion
is makes them fill the model's 256px input. Clip-level rather than per-candidate
so it can be cached; the pad is generous to tolerate the golfer moving.

MobileCLIP2 preprocessing is IDENTITY normalization on [0,1] — do NOT apply the
OpenAI CLIP mean/std.
"""
import argparse, subprocess
from pathlib import Path
import numpy as np
import torch, open_clip

MODEL, PRETRAIN = "MobileCLIP2-S2", "dfndr2b"
EMBED_FPS = 10.0
SIZE = 256

_model = None
# Apple GPU is 16x faster than CPU for this model (measured: 306 -> 19 ms/frame),
# which is the difference between a 13-minute cache build and a 3-hour one.
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


def load_model():
    global _model
    if _model is None:
        _model, _, _ = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAIN)
        _model.eval()
        _model = _model.to(DEVICE)
    return _model


def golfer_box(heat, src_w, src_h, pad=2.6):
    h, w = heat.shape
    m = heat - np.percentile(heat, 75)
    m[m < 0] = 0
    if m.sum() <= 0:
        m = np.ones_like(heat)
    ys, xs = np.mgrid[0:h, 0:w]
    tot = m.sum()
    cx, cy = (m * xs).sum() / tot, (m * ys).sum() / tot
    sx = np.sqrt((m * (xs - cx) ** 2).sum() / tot)
    sy = np.sqrt((m * (ys - cy) ** 2).sum() / tot)
    half = max(max(sx, sy) * pad, min(w, h) * 0.22)
    fx, fy = src_w / w, src_h / h
    halfs = min(half * max(fx, fy), min(src_w, src_h) / 2)
    side = int(2 * halfs) // 2 * 2
    x0 = int(np.clip(cx * fx - halfs, 0, max(0, src_w - side)))
    y0 = int(np.clip(cy * fy - halfs, 0, max(0, src_h - side)))
    return max(0, x0), max(0, y0), max(2, side)


def decode_rgb(path, fps, box, size=SIZE):
    x0, y0, side = box
    cmd = ["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox", "-i", str(path),
           "-vf", f"fps={fps},crop={side}:{side}:{x0}:{y0},scale={size}:{size}",
           "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    buf = subprocess.run(cmd, capture_output=True).stdout
    n = len(buf) // (size * size * 3)
    if n == 0:
        return np.zeros((0, size, size, 3), np.uint8)
    return np.frombuffer(buf, np.uint8)[: n * size * size * 3].reshape(n, size, size, 3)


@torch.no_grad()
def embed(frames, batch=64):
    model = load_model()
    out = []
    for i in range(0, len(frames), batch):
        x = torch.from_numpy(frames[i:i + batch].copy()).float().div_(255.0).permute(0, 3, 1, 2)
        e = model.encode_image(x.to(DEVICE))
        out.append(torch.nn.functional.normalize(e, dim=-1).cpu())
    return torch.cat(out).numpy().astype(np.float16) if out else np.zeros((0, 512), np.float16)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--motion-cache", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", nargs="*", default=None, help="limit to these stems")
    a = ap.parse_args()
    dst_dir = Path(a.out)
    dst_dir.mkdir(parents=True, exist_ok=True)

    for npz in sorted(Path(a.motion_cache).glob("*.npz")):
        if a.only and npz.stem not in a.only:
            continue
        dst = dst_dir / (npz.stem + ".npz")
        if dst.exists():
            print("skip", dst.name, flush=True)
            continue
        d = np.load(npz, allow_pickle=True)
        gray = d["gray"]
        if len(gray) < 4:
            print("empty", npz.name, flush=True)
            continue
        heat = np.abs(np.diff(gray.astype(np.float32), axis=0)).mean(axis=0)
        box = golfer_box(heat, int(d["src_w"]), int(d["src_h"]))
        frames = decode_rgb(str(d["path"]), EMBED_FPS, box)
        e = embed(frames)
        np.savez_compressed(dst, emb=e, fps=EMBED_FPS, box=np.array(box),
                            path=str(d["path"]), label=str(d["label"]))
        print(f"embedded {dst.name}  {len(e)} frames  crop {box}", flush=True)
