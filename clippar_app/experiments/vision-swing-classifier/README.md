# Experimental: on-device vision swing classifier

A zero-shot, on-device classifier that tells **full swing / address / putt-chip
/ no-shot** from a handful of sampled frames — using Apple's **MobileCLIP2**
image encoder + text embeddings baked offline. Proven on real Clippar footage
(see [FINDINGS.md](./FINDINGS.md)).

**This directory is inert.** Nothing here is imported by the app or wired into
the live `shot-detector`. It's a self-contained proof + scaffold on the
`experiment/vision-swing-classifier` branch, kept separate on purpose.

## Why this design

- **Vision answers *what* (swing vs putt vs nothing); audio answers *when*
  (exact impact).** They fuse — vision never replaces the existing pose/audio
  detector, it's an extra vote.
- **Only the image encoder ships.** Class prompts are fixed, so their text
  embeddings are computed once offline (`dump_embeds.py` →
  `class_text_embeddings.json`). No text tower, no tokenizer on device.
- **Decision policy is pure TS** (`swingVisionLogic.ts`, tested) so it stays
  off-device-testable, exactly like `lib/liveRecordingLogic.ts`.

## Files

| File | What |
|---|---|
| `FINDINGS.md` | The feasibility result (ViT-B/32 vs MobileCLIP2 on real clips) |
| `zeroshot_eval.py` | Reproduce the per-frame zero-shot scores |
| `dump_embeds.py` | Precompute the baked class text embeddings |
| `verify_pipeline.py` | End-to-end desktop proof: image enc → baked text → decision |
| `class_text_embeddings.json` | The baked 512-d class vectors (MobileCLIP2-S2) |
| `convert_mobileclip_to_coreml.py` | Produce `MobileCLIP2S2Image.mlpackage` |
| `SwingVisionClassifier.swift` | On-device Swift class (sample → encode → score) |
| `swingVisionLogic.ts` + `.test.ts` | Pooling + decision policy (pure, tested) |

## Reproduce the desktop proof

```bash
python3 -m venv env && source env/bin/activate
pip install torch open_clip_torch pillow
# extract frames from a clip with ffmpeg, then:
python3 verify_pipeline.py /path/to/frames
```

## To activate on-device later (a deliberate, reviewable step)

Only do this once you've decided the accuracy is worth it. None of it changes
existing detection behaviour unless the flag is turned on.

1. `python3 convert_mobileclip_to_coreml.py` → `MobileCLIP2S2Image.mlpackage`.
2. Move `SwingVisionClassifier.swift` into `modules/shot-detector/ios/`, and add
   `MobileCLIP2S2Image.mlpackage` + `class_text_embeddings.json` to the module
   bundle resources.
3. Register ONE new `AsyncFunction("classifySwingVision")` in
   `ShotDetectorModule.swift` that calls `SwingVisionClassifier.classify(...)`
   and returns the per-frame scores. (Additive — a new function, not a change
   to `detectAndTrim`/`classifyShotType`.)
4. Move `swingVisionLogic.ts` into `lib/`, add a config flag
   `visionClassifier.enabled = false`, and in the clip pipeline call the native
   function + `decideClip(...)` as an **extra vote** only when the flag is on.
5. Build with EAS, measure device latency/battery on 8 frames/clip, and A/B the
   fused decision against current behaviour before enabling for anyone.

## Honest status

- Desktop separability: **verified** on real footage — MobileCLIP2 cleanly
  splits "club up / swinging" (>50%) from "standing over the ball" (<11%) and
  "empty course" (~0).
- Decision policy: **tested** (mean-of-top-k pooling; a chip's single
  mini-swing frame does not masquerade as a full swing).
- On-device latency / battery / preprocessing-parity: **not yet measured** —
  needs an EAS device build (step 5).
