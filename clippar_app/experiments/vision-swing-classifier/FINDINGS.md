# On-device vision swing classifier — feasibility spike

**Branch:** `experiment/vision-swing-classifier` (experimental; does NOT touch the
live shot-detector). **Status:** desktop feasibility verified; on-device port not
yet built.

## The question

Can a small **on-device** vision model tell, from a few sampled frames of a
Clippar clip:

1. a **full swing happening** (club up / mid-swing) vs
2. **standing over the ball** (address) vs
3. **posing after** the shot (finish) vs
4. a **putt/chip** (short stroke) vs
5. **no shot** (empty course)?

— without any training, cheaply enough to not hurt battery.

## What we ran

Zero-shot CLIP (no training, averaged text prompts per class) over real Clippar
footage: `demo_raw.mp4` (full swing) and `step2_swing.mp4` (chip/pitch), sampled
at ~2 fps. Two models:

- **ViT-B/32 (2021, ~150M)** — a deliberately conservative *floor*.
- **MobileCLIP2-S2 (2025, `dfndr2b`)** — Apple's actual on-device model, the
  fair proxy for what FastVLM/MobileCLIP2 would run on an iPhone.

`zeroshot_eval.py` reproduces it (needs `torch open_clip_torch pillow`; point it
at a folder of frames).

## Result — MobileCLIP2-S2 (the on-device model)

The distinction the founder asked about — **swinging vs standing over the ball**
— is cleanly separated on the SWING axis:

| Frame (chip clip) | SWING score | note |
|---|---|---|
| address over ball | **3–5%** | correctly NOT a swing |
| actual stroke motion (club up) | **52%** | correctly a swing |
| empty / no golfer | NO-SHOT high, everything else ~0 | reliable |

Key reads:
- **"Club up / mid-swing" is well separated:** swing frames >50% vs non-swing
  <11% on the SWING axis. This is the exact "is he swinging or just standing
  over it" signal.
- **"No shot / empty course" is near-zero** whenever a golfer is present — a
  reliable gate.
- **Address vs putt/chip blur together** (~40% each) — but that's *harmless*:
  both mean "not a full driver swing." Clippar separates them by whether ANY
  frame in the clip shows a club-up/finish.
- ViT-B/32 (the floor) got the gross distinctions but with thin margins and
  occasional confident errors on cropped/overlay frames — i.e. the *cheapest*
  model is borderline; the *on-device* model is clearly usable.

## Honest limits

- This is **single-frame, naive-prompt, no tuning.** Production should
  **sample ~8 frames and max-pool the swing/finish evidence** across the clip
  (the finish pose is held ~1 s, so it's easy to catch), and **tune the
  prompts**. Both sharpen the margins further.
- Vision **cannot pin the exact impact millisecond** — contact is sub-frame.
  Audio remains the impact clock. Vision answers *what* (swing/putt/none);
  audio answers *when*.
- Desktop MobileCLIP2 ≈ on-device MobileCLIP2, but the true device latency /
  battery still needs measuring in an EAS build before enabling.

## Recommended architecture (additive; fuses, never replaces)

1. Reuse the frames the detector already decodes; sample ~8 across the clip.
2. Run MobileCLIP2 (Core ML) zero-shot on each → per-frame class scores.
3. Clip-level decision by max-pooling: any strong SWING/FINISH → full swing;
   else PUTT/CHIP dominant → putt; else NO-SHOT → discard.
4. Feed this as an extra **vote** alongside the existing pose + audio, behind a
   config flag, A/B against current behaviour. Never the sole signal.
