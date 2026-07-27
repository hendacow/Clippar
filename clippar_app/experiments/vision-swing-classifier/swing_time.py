#!/usr/bin/env python3
"""
swing_time.py — locate WHEN the swing happens in a golf clip.

This supersedes the shot-TYPE classifier for the question that actually matters
for trimming: at what second did the golfer swing? It is a strictly WITHIN-clip
question, which is why it works where cross-clip type classification did not.

======================================================================
THE SIGNAL
======================================================================
Per-frame motion energy (99.5th percentile of |frame diff| on 160x90 gray) has
an unmistakable golf signature:

    backswing   moderate, rising      club travelling up
    TOP         a sharp DIP           club momentarily stops to reverse
    downswing   the sharpest SPIKE    fastest motion anywhere in the clip
    finish      decays                club held over the shoulder

Measured on real clips, the dip→spike gap is ~0.20s every time (IMG_0523
4.08→4.28, IMG_0524 11.06→11.28, IMG_0525 10.75→10.95). That is textbook
downswing duration, and it is what we key on.

Energy uses a HIGH PERCENTILE, not the mean: a golfer is a small fraction of
the frame, so the mean is dominated by static grass and the swing barely
registers. The 99.5th percentile tracks the fastest-moving pixels — the club
and hands.

======================================================================
WHY CLIP IS STILL HERE (AND WHAT IT MUST NOT DO)
======================================================================
CLIP text prompts CANNOT find the precise instant. Asked for "top of the
backswing" they reliably return the FINISH pose ~0.3s after impact, because the
finish is held ~1s (many sampled frames) and also has the club above the head,
whereas the true top lasts ~0.05s and often isn't in the sample at all.

So CLIP does the two jobs it is actually good at:
  1. OPEN-SET GATE — is there golf here at all? (real golf ~0.31-0.34 raw
     cosine, non-golf ~0.06-0.13). Without this a pocket recording produces a
     confident nonsense answer.
  2. CANDIDATE RANKING — raw motion max is NOT impact; picking up or mounting
     the phone dominates it. We take several dip→spike candidates and keep the
     ones where a golfer is visibly swinging.

MobileCLIP2 preprocessing is IDENTITY normalization on [0,1] — do NOT apply the
OpenAI CLIP mean/std (that cost 0.69 in class probability previously).
"""
import argparse, json, subprocess
from pathlib import Path
import numpy as np
import torch, open_clip

MODEL, PRETRAIN = "MobileCLIP2-S2", "dfndr2b"

# Positive = a golfer mid-swing. Negative = golf scene but nobody swinging.
SWING_PROMPTS = [
    "a golfer at the top of the backswing with the club raised above their head",
    "a golfer striking the golf ball, club head at the ball",
    "a golfer in the follow-through finish position, club over their shoulder",
    "a golfer swinging a golf club",
]
STILL_PROMPTS = [
    "a golfer standing still over the ball at address, not moving",
    "an empty golf course with nobody on it",
    "a person walking on a golf course carrying a bag",
    "a close-up of grass and sky, no people",
]

# Downswing physics. A golfer's transition-to-impact is remarkably invariant.
UP_WINDOW = 0.34      # look this far ahead of a dip for the downswing spike (s)
BACK_WINDOW = 0.70    # look this far back for the backswing (s) — a real top has
                      # motion on BOTH sides; address and phone-pickup do not
NMS_GAP = 1.20        # min separation between candidates (s)
N_CANDIDATES = 6
MIN_GOLF_SIM = 0.22   # open-set gate; measured golf 0.31-0.34, non-golf 0.06-0.13
MIN_SWING_MARGIN = 0.025  # "a golfer is mid-swing here", not just "golf is in shot"

_model = _tok = None


def load_model():
    global _model, _tok
    if _model is None:
        _model, _, _ = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAIN)
        _model.eval()
        _tok = open_clip.get_tokenizer(MODEL)
    return _model, _tok


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True).stdout
    j = json.loads(out)
    st = j["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    dur = float(j["format"].get("duration") or 0)
    return dict(w=int(st["width"]), h=int(st["height"]),
                fps=float(num) / float(den), dur=dur)


def decode_gray(path, fps, w=160, h=90):
    cmd = ["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox", "-i", str(path),
           "-vf", f"fps={fps},scale={w}:{h}", "-pix_fmt", "gray",
           "-f", "rawvideo", "-"]
    buf = subprocess.run(cmd, capture_output=True).stdout
    n = len(buf) // (w * h)
    if n == 0:
        return np.zeros((0, h, w), np.float32)
    return np.frombuffer(buf, np.uint8)[: n * w * h].reshape(n, h, w).astype(np.float32)


def motion_energy(gray):
    if len(gray) < 2:
        return np.zeros(0), np.zeros(0, dtype=np.int64)
    d = np.abs(np.diff(gray, axis=0))
    e = np.percentile(d.reshape(len(d), -1), 99.5, axis=1)
    return e, d


def smooth(v, k=3):
    if len(v) < k:
        return v
    return np.convolve(v, np.ones(k) / k, mode="same")


def downswing_candidates(e, t, up_window=UP_WINDOW, back_window=BACK_WINDOW,
                         k=N_CANDIDATES, nms=NMS_GAP):
    """Find the VALLEY BETWEEN TWO PEAKS — backswing before, downswing after.

        score = min(peak_before, peak_after) - energy_here

    The naive `peak_after - energy_here` is wrong and was measured failing: it
    rewards any transition out of stillness, so it locks onto ADDRESS (perfectly
    still, floor ~0, followed by the takeaway) and onto the phone being picked
    up. IMG_0568 was called at 8.62s, where the golfer is still at address and
    doesn't start the takeaway until 8.80s.

    Requiring motion on BOTH sides encodes the actual physics: the club is
    swinging up before the top and swinging down after it. Address and phone
    handling have nothing before them, so they score ~0 and drop out."""
    if len(e) < 4:
        return []
    dt = t[1] - t[0] if len(t) > 1 else 1 / 30
    w_up = max(2, int(round(up_window / dt)))
    w_bk = max(2, int(round(back_window / dt)))
    scores, peaks = np.zeros(len(e)), np.zeros(len(e), dtype=int)
    for i in range(len(e)):
        after = e[i + 1: min(len(e), i + w_up + 1)]
        before = e[max(0, i - w_bk): i]
        if len(after) == 0 or len(before) == 0:
            continue
        pk = int(np.argmax(after))
        peaks[i] = i + 1 + pk
        scores[i] = min(before.max(), after[pk]) - e[i]

    out, used = [], np.zeros(len(e), bool)
    order = np.argsort(-scores)
    for i in order:
        if scores[i] <= 0 or used[i]:
            continue
        out.append(dict(i_top=int(i), t_top=float(t[i]),
                        i_impact=int(peaks[i]), t_impact=float(t[peaks[i]]),
                        rise=float(scores[i]), floor=float(e[i])))
        lo = max(0, int(i - nms / dt))
        hi = min(len(e), int(i + nms / dt))
        used[lo:hi] = True
        if len(out) >= k:
            break
    return out


def golfer_box(heat, src_w, src_h, pad=2.2):
    """Square crop centred on the motion centroid — that's the golfer. Lets a
    golfer who is 8% of a 4K frame fill the model's 256px input."""
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
    half = max(max(sx, sy) * pad, min(w, h) * 0.18)
    fx, fy = src_w / w, src_h / h
    cxs, cys = cx * fx, cy * fy
    halfs = min(half * max(fx, fy), min(src_w, src_h) / 2)
    side = int(2 * halfs) // 2 * 2
    x0 = int(np.clip(cxs - halfs, 0, max(0, src_w - side)))
    y0 = int(np.clip(cys - halfs, 0, max(0, src_h - side)))
    return max(0, x0), max(0, y0), max(2, side)


def decode_window_rgb(path, start, dur, fps, box, size=256):
    x0, y0, side = box
    cmd = ["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox",
           "-ss", f"{max(0, start):.3f}", "-i", str(path),
           "-t", f"{dur:.3f}",
           "-vf", f"fps={fps},crop={side}:{side}:{x0}:{y0},scale={size}:{size}",
           "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    buf = subprocess.run(cmd, capture_output=True).stdout
    n = len(buf) // (size * size * 3)
    if n == 0:
        return np.zeros((0, size, size, 3), np.uint8)
    return np.frombuffer(buf, np.uint8)[: n * size * size * 3].reshape(n, size, size, 3)


@torch.no_grad()
def embed_images(frames, batch=32):
    model, _ = load_model()
    out = []
    for i in range(0, len(frames), batch):
        x = torch.from_numpy(frames[i:i + batch].copy()).float().div_(255.0).permute(0, 3, 1, 2)
        out.append(torch.nn.functional.normalize(model.encode_image(x), dim=-1))
    return torch.cat(out) if out else torch.zeros(0, 512)


@torch.no_grad()
def prompt_matrix():
    model, tok = load_model()
    mats = []
    for group in (SWING_PROMPTS, STILL_PROMPTS):
        t = torch.nn.functional.normalize(model.encode_text(tok(group)), dim=-1)
        mats.append(t)
    return mats


def analyse(path, motion_fps=60.0, clip_fps=10.0):
    info = probe(path)
    mfps = min(info["fps"], motion_fps)
    gray = decode_gray(path, mfps, 160, 90)
    if len(gray) < 4:
        return dict(file=Path(path).name, decision="UNREADABLE")
    e_raw, diffs = motion_energy(gray)
    e = smooth(e_raw, 3)
    t = (np.arange(len(e)) + 0.5) / mfps

    cands = downswing_candidates(e, t)
    if not cands:
        return dict(file=Path(path).name, decision="NO_MOTION", dur=info["dur"])

    swing_p, still_p = prompt_matrix()
    scored = []
    for c in cands:
        # Local motion heat around this candidate → a tight crop on the golfer,
        # uncontaminated by phone handling elsewhere in the clip.
        lo = max(0, int((c["t_top"] - 1.0) * mfps))
        hi = min(len(diffs), int((c["t_top"] + 1.0) * mfps))
        heat = diffs[lo:hi].mean(axis=0) if hi > lo else diffs.mean(axis=0)
        box = golfer_box(heat, info["w"], info["h"])

        # Sample the swing arc: a little before the top through the finish.
        frames = decode_window_rgb(path, c["t_top"] - 0.5, 1.6, clip_fps, box)
        if len(frames) == 0:
            continue
        img = embed_images(frames)
        s_sw = (img @ swing_p.T).numpy()
        s_st = (img @ still_p.T).numpy()
        golf_sim = float(max(s_sw.max(), s_st.max()))
        # Best few frames decide: the swing is only a few frames of the window.
        margin = np.sort(s_sw.max(1) - s_st.max(1))[-3:].mean()
        c.update(box=box, golf_sim=golf_sim, swing_margin=float(margin))
        scored.append(c)

    if not scored:
        return dict(file=Path(path).name, decision="NO_FRAMES", dur=info["dur"])

    # Gate on SWING_MARGIN, not golf_sim. golf_sim only says "a golf course is
    # in shot", which is true of the phone-pickup frames at a clip's start too;
    # the margin says "a golfer is actually mid-swing here". Measured: correct
    # swing candidates ~+0.05, phone-handling candidates ~+0.01.
    in_domain = [c for c in scored
                 if c["golf_sim"] >= MIN_GOLF_SIM and c["swing_margin"] >= MIN_SWING_MARGIN]
    base = dict(file=Path(path).name, dur=info["dur"], src=f'{info["w"]}x{info["h"]}',
                candidates=scored)
    if not in_domain:
        best = max(scored, key=lambda c: c["swing_margin"])
        return dict(base, decision="NO_SWING", t_top=None, t_impact=None,
                    golf_sim=best["golf_sim"], swing_margin=best["swing_margin"])

    # Among candidates where a golfer really is swinging, trust the motion: the
    # biggest dip→spike is the swing.
    best = max(in_domain, key=lambda c: c["rise"])
    runner = sorted((c["rise"] for c in in_domain), reverse=True)
    sep = runner[0] / runner[1] if len(runner) > 1 and runner[1] > 0 else float("inf")
    return dict(
        base, decision="SWING", t_top=best["t_top"], t_impact=best["t_impact"],
        rise=best["rise"], floor=best["floor"], golf_sim=best["golf_sim"],
        swing_margin=best["swing_margin"], box=best["box"],
        n_candidates=len(scored), sep=float(min(sep, 99)),
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--out", default=None, help="write results JSON here")
    a = ap.parse_args()
    rows = []
    for c in a.clips:
        try:
            r = analyse(c)
        except Exception as ex:                      # keep the batch going
            r = dict(file=Path(c).name, decision="ERROR", error=str(ex))
        r["path"] = str(c)
        rows.append(r)
        if r.get("decision") == "SWING":
            print(f'{r["file"]:<44} {r["dur"]:5.1f}s  TOP {r["t_top"]:6.2f}s  '
                  f'IMPACT {r["t_impact"]:6.2f}s  rise {r["rise"]:5.1f}  '
                  f'golf {r["golf_sim"]:.3f}  margin {r["swing_margin"]:+.3f}', flush=True)
        else:
            print(f'{r["file"]:<44} {r.get("dur", 0):5.1f}s  {r["decision"]}'
                  f'  golf {r.get("golf_sim", 0):.3f}', flush=True)
    if a.out:
        Path(a.out).write_text(json.dumps(rows, indent=2))
