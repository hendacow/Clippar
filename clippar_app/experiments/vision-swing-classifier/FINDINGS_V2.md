# Swing LOCALIZATION — what works, what doesn't

Measured on Henry's 79 labelled clips (`~/clippar-training-clips/`), 2026-07-27.
This supersedes the shot-TYPE classifier for the question that matters for
trimming: **at what second did the golfer swing?**

## Headline

| | result |
|---|---|
| Full swings, correct time (±0.15s) | **27 / 28 real swings** |
| Full swings, wrong time | 1 (IMG_0592) |
| `nothing/` false positives | 1 / 25 |
| Putts, correct time | **~1 in 3 — NOT SOLVED** |

`full_swing/` holds 29 clips but **IMG_0525 contains no swing** — verified: the
only motion above threshold in the whole 18.7s is at 0.02–0.92s (the camera
settling as the phone is placed), and a 19-frame scan of the clip shows the
golfer setting up and never swinging. It is excluded from the denominator rather
than counted as a miss.

## Why localization works where classification failed

Shot-type classification needs **absolute, cross-clip** thresholds ("is this a
putt or a drive, in general?") which drift with lighting, distance and angle.
Localization is a **within-clip** question — same golfer, same camera, same
light across every candidate — so systematic bias cancels.

## The signal: a valley between two peaks

Per-frame motion energy (99.5th percentile of |frame diff| on 160x90 gray) has an
unmistakable golf signature:

```
IMG_0523    3.75s:  86   backswing — club travelling up
            4.08s:  28   DIP — club stops to reverse  =  TOP OF SWING
            4.28s: 107   SPIKE — downswing, fastest motion in the clip
```

The dip→spike gap was 0.18–0.28s on **every** detection across all 29 clips —
textbook downswing duration, and strong evidence the detector locks onto one
real physical event rather than noise.

Two scoring rules were tried:

* `peak_after - floor` — **WRONG.** Rewards any transition out of stillness, so
  it locks onto ADDRESS (perfectly still, floor ~0, followed by the takeaway).
  IMG_0568 was called at 8.62s where the golfer is motionless until 8.80s.
* `min(peak_before, peak_after) - floor` — **RIGHT.** Requires motion on BOTH
  sides, which is what physically distinguishes the top of a backswing. Fixed
  IMG_0568 and recovered the chip and bunker shots.

Energy must use a high percentile, not a mean: a golfer is a small fraction of
the frame, so a mean is swamped by static grass.

## What CLIP is for (and what it must never do)

CLIP **cannot** find the instant. Asked for "top of the backswing" it reliably
returns the FINISH pose ~0.3s after impact, because the finish is held ~1s (many
sampled frames) and also has the club above the head, while the true top lasts
~0.05s. Its jobs are:

1. **Reject non-golf** — measured golf 0.31–0.34 raw cosine, non-golf 0.06–0.13.
2. **Re-rank candidates** — raw motion cannot tell a swing from a person walking:
   `nothing/` clips score a median valley of 0.71 vs 0.68 for real swings,
   completely overlapping.

Ranking must stay on **motion**; CLIP only gates. Ranking by CLIP score moved
IMG_0541 from the verified-correct 5.91s to 14.29s, because the prototype score
peaks on the held finish rather than the transition.

## Text prompts lose to image prototypes

Text prompts rejected a textbook bunker swing (IMG_0541, club up, sand flying) at
margin −0.041 while scoring a stationary golfer higher elsewhere. Replacing them
with prototypes averaged from 26 visually-verified top-of-swing frames fixed it.

**Evaluation is leave-one-clip-out** — a clip is never scored by a prototype
containing its own frame — so the numbers reflect an unseen clip. Note the 26
verified timestamps were themselves produced by motion-ranked runs, so the
"26/26 timing" figure proves the config does not *regress* from what was checked
by eye; it is not independent evidence.

## Putts are NOT solved

~1 in 3 correct. Failures are systematic: the detector lands on picking the ball
out of the hole (IMG_0563), standing on the green (IMG_0566, IMG_0570) or walking
(IMG_0536), while genuinely missing real strokes (IMG_0528, 0537, 0538, 0548).

Cause: a putting stroke moves a putter head slowly over ~30cm. Playing partners
walking, and the golfer bending to retrieve the ball, are far larger motion
events in the same clip. Measured peaks: full swings ~100, putts 14–49.

**Rejected hypothesis:** that a putt is "small object moves while body stays
still" and could be separated by moving-pixel spread. Measured compactness
overlaps completely — real putts 0.21–0.35, wrong picks 0.14–0.27.

**Next step if putts need solving:** build putt-specific image prototypes from
~15 hand-verified putt frames (the tooling for this — `inspect_cands.py` —
already exists). Worth noting first that the product may not need it: the stated
requirement is that a putt is left untrimmed, which is a classification, not a
localization.

## A note on the negative set

`nothing/` is all non-golf (a gym, a lake, fireworks, a laptop, tacos) so it only
tests the easy case. Every false positive that actually bit was
**golf-course-but-no-swing**: standing in a bunker (IMG_0560), climbing out of one
(IMG_0592), at address (IMG_0525), walking in the distance (IMG_0584). A useful
hard-negative set can be built from the non-swing seconds of the swing clips.

## Cost on device

The precise part is the cheap part:

| pass | rate | cost | job |
|---|---|---|---|
| motion | **every frame** | pixel subtract on 160x90 gray | the exact instant |
| CLIP | 10fps, ~6 windows | neural inference | is this golf / which candidate |

Running CLIP on every frame is what would drain the battery, and it is also the
part that cannot find the instant.

## Tooling

    cache_motion.py   decode every clip once to 160x90 gray  (~3s/clip)
    cache_clip.py     dense MobileCLIP2 embeddings, Apple GPU (19ms/frame; CPU is 306ms)
    tune.py           re-score cached motion — full 79-clip pass in 4.5s
    rank.py           text-prompt gating + candidate re-ranking
    proto.py          image-prototype scoring, leave-one-clip-out
    eval_timing.py    timing accuracy against verified tops (not just detection)
    make_sheets.py    contact sheets — the detected frame per clip, labelled
    inspect_cands.py  one frame per candidate: is the right moment even present?

Caching motion took an iteration from 50 minutes to 4.5 seconds; the GPU move
took the embedding build from ~3 hours to ~13 minutes. Neither changed a result,
but without them this could not have been iterated to convergence.
