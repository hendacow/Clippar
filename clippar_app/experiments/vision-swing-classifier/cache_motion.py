#!/usr/bin/env python3
"""
cache_motion.py — decode every clip ONCE into tiny grayscale frames.

Tuning the detector means re-scoring the same motion curves over and over. Video
decode is ~3s/clip and CLIP inference is ~55s/clip, so caching the cheap-but-
unavoidable part turns a 50-minute experiment into a 2-second one and lets the
scoring rule be iterated to convergence.

160x90 gray at up to 60fps is ~1MB/s of clip — trivial to store, and enough
resolution for both the motion energy curve and the golfer-locating heat map.
"""
import argparse, json, subprocess
from pathlib import Path
import numpy as np

W, H, MAX_FPS = 160, 90, 60.0


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True).stdout
    j = json.loads(out)
    st = j["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    return dict(w=int(st["width"]), h=int(st["height"]),
                fps=float(num) / float(den),
                dur=float(j["format"].get("duration") or 0))


def decode_gray(path, fps):
    cmd = ["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox", "-i", str(path),
           "-vf", f"fps={fps},scale={W}:{H}", "-pix_fmt", "gray",
           "-f", "rawvideo", "-"]
    buf = subprocess.run(cmd, capture_output=True).stdout
    n = len(buf) // (W * H)
    if n == 0:
        return np.zeros((0, H, W), np.uint8)
    return np.frombuffer(buf, np.uint8)[: n * W * H].reshape(n, H, W)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--cache", required=True)
    a = ap.parse_args()
    out = Path(a.cache)
    out.mkdir(parents=True, exist_ok=True)
    for c in a.clips:
        p = Path(c)
        dst = out / (p.parent.name + "__" + p.stem + ".npz")
        if dst.exists():
            print("skip", dst.name, flush=True)
            continue
        try:
            info = probe(p)
            fps = min(info["fps"], MAX_FPS)
            g = decode_gray(p, fps)
            np.savez_compressed(dst, gray=g, fps=fps, src_w=info["w"],
                                src_h=info["h"], dur=info["dur"],
                                path=str(p), label=p.parent.name)
            print(f"cached {dst.name}  {len(g)} frames @ {fps:.2f}fps", flush=True)
        except Exception as ex:
            print(f"FAIL {p.name}: {ex}", flush=True)
