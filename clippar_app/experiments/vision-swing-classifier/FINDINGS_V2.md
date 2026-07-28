# Swing LOCALIZATION — what works, what doesn't

Measured on Henry's 79 labelled clips (`~/clippar-training-clips/`), 2026-07-27.
This supersedes the shot-TYPE classifier for the question that matters for
trimming: **at what second did the golfer swing?**

## Headline (final)

| | result |
|---|---|
| Full swings, correct time (±0.15s) | **27 / 28 real swings** |
| Full swings, wrong time | 0 |
| Full swings, unverified | 1 (IMG_0584 — golfer tiny and distant) |
| `nothing/` false positives | 1 / 25 |
| Putts, correct within ±0.15s of my label | 9 / 14 |
| Putts landing on genuine putting posture | ~13 / 15 inspected |

IMG_0592 is FIXED (see the edge guard below). The putt figure has an important
caveat: a putt clip usually contains several putting-posture moments (practice
strokes, the stroke, a tap-in), so the strict +/-0.15s metric penalises the
detector for choosing a *different valid* stroke than the one I labelled. On
IMG_0526 I labelled 4.22s and it chose 2.78s; both are the golfer putting. The
visual count is the fairer read, the strict count is the conservative one.

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

**Motion decides, the prototype breaks ties** (`rank=motion_tie`, TIE_REL=0.50).
Ranking purely by prototype is worse — it peaks on the held finish and moved
IMG_0541 from the verified-correct 5.91s to 14.29s. Ranking purely by motion
loses genuine ties arbitrarily. The tie window matters a lot and differs by shot
type: at 0.10 putts get 7/14, at 0.50 they get 9/14 with swings still 26/26, and
at 0.80 swings break (24/26). A putting stroke is NOT the largest motion in its
clip, so the prototype needs latitude to overrule motion there; on a full swing
motion genuinely is the best evidence.

## Text prompts lose to image prototypes

Text prompts rejected a textbook bunker swing (IMG_0541, club up, sand flying) at
margin −0.041 while scoring a stationary golfer higher elsewhere. Replacing them
with prototypes averaged from 26 visually-verified top-of-swing frames fixed it.

**Evaluation is leave-one-clip-out** — a clip is never scored by a prototype
containing its own frame — so the numbers reflect an unseen clip. Note the 26
verified timestamps were themselves produced by motion-ranked runs, so the
"26/26 timing" figure proves the config does not *regress* from what was checked
by eye; it is not independent evidence.

## Putts — from ~1 in 3 to usable

Putts were originally ~1 in 3 correct: the detector landed on picking the ball
out of the hole, standing on the green or walking, while missing real strokes.

Cause: a putting stroke moves a putter head slowly over ~30cm. Playing partners
walking, and the golfer bending to retrieve the ball, are far larger motion
events in the same clip. Measured peaks: full swings ~100, putts 14–49.

**What fixed it — a SEPARATE putt prototype.** A putt legitimately looks nothing
like a full swing (no club above the head, body bent over the ball), so genuine
putt frames scored NEGATIVE against the swing prototype (measured -0.03 to -0.13
on IMG_0538, 0548, 0549) and one gate rejected them all. Scoring each frame
against `max(swing_proto, putt_proto)` lets a single threshold serve both.
Detection went 20/25 -> 24/25 and the picked frames now show putting posture.

**Rejected hypothesis:** that a putt is "small object moves while body stays
still", separable by moving-pixel spread. Measured compactness overlaps
completely — real putts 0.21–0.35, wrong picks 0.14–0.27. Not shipped.

**Remaining ambiguity:** a putt clip usually holds several putting-posture
moments (practice strokes, the stroke, a tap-in). "Correct" is genuinely
ill-defined there, which is why the strict and visual counts differ.

## A note on the negative set

`nothing/` is all non-golf (a gym, a lake, fireworks, a laptop, tacos) so it only
tests the easy case. Every false positive that actually bit was
**golf-course-but-no-swing**: standing in a bunker (IMG_0560), climbing out of one
(IMG_0592), at address (IMG_0525), walking in the distance (IMG_0584). Those
non-swing seconds ARE used as hard negatives when building the prototypes.

The single surviving false positive, IMG_9704, is exactly this case: a golf green
with a flag and a panning camera, no swing. Its prototype score (+0.020) sits
just above the swing floor (+0.013) while every other `nothing` clip tops out at
-0.057 — so one clip breaks an otherwise clean margin.

**Rejected fix:** reject camera pans by fraction-of-frame-in-motion. The false
positive measures 0.208 and a REAL swing (IMG_0551) measures 0.189; a threshold
in that 0.019 gap would be fitted to a single clip. Not shipped.

## The edge guard — what fixed IMG_0592

Recordings start before the golfer sets up and end with walking away or picking
the phone up, so both ends of every clip contain phone handling. On IMG_0592 the
golfer climbing out of the bunker at 18.65s (2.05s from the end of a 20.7s clip)
beat the real swing at 7.28s on BOTH motion and prototype — no ranking rule could
have saved it. Excluding candidates within 2.5s of either edge fixes it.

Empirically safe: across all 26 verified tops the closest a real swing comes to
an edge is 4.08s, a 1.6x margin. The guard is capped at 20% of duration per side
because putt clips run 4-9s and a flat 2.5s removed every candidate from
IMG_0538 and IMG_0554. CAVEAT: 2.5s is set from 26 clips — the rationale
generalises, the exact value has a small sample behind it.

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
    cand_grid.py      clips x candidates grid — how the putts were labelled

Caching motion took an iteration from 50 minutes to 4.5 seconds; the GPU move
took the embedding build from ~3 hours to ~13 minutes. Neither changed a result,
but without them this could not have been iterated to convergence.

## Generalization to golfers we have never seen

16 free-licensed clips from mixkit (`~/clippar-test-web/`) — children, women,
tropical courses, professional cinematography, driving ranges and indoor VR golf.
Nothing like the training set, which is one golfer at one club on a phone.

Scored with prototypes built entirely from Henry's clips: 14/16 detected.

**What transferred.** The motion stage found real swing moments on body types
nothing like the training data — a child at the top of the backswing (2033
@15.21s), a kid mid-swing (2038 @8.47s), putting posture on several (2029, 2030,
2036), and an indoor VR swing (43566 @5.73s). The hands-only VR clips (43544,
43553) were correctly rejected.

**What did not.** The gate is measurably weaker off-distribution:
* 22564 is pure scenery — a pond and a building, no golfer — and returned SWING
  at 19.90s. A clear false positive.
* 20870 / 20871 are driving ranges with dozens of tiny distant figures; both got
  confident timestamps that cannot be verified and should not be trusted.

This is the split predicted before the test: motion is physics and travels;
the prototypes are fitted to one golfer and travel less well. The honest read is
that on-device accuracy for a NEW user will sit below the 27/28 measured here,
and the failure mode will be false positives on golf scenery rather than
mistimed swings.

Cheapest fix if that proves to matter: add exemplars from other golfers to the
prototype banks. The banks are averages, so this is additive and needs no
retraining — `export_prototypes.py` rebuilds the shipped JSON in seconds.

## Stroke type (trim vs leave whole) — motion again, not appearance

The trim decision hangs on `strokeType`, and it was NEVER measured until Henry
asked whether putts actually stayed untrimmed. They did not: the original rule —
majority vote of "which prototype wins" over the winning candidate's best three
frames — got 40/53, trimming 9 of 24 putts that should have been left whole.

Measured on the 53 detected swing/putt clips:

| rule | correct |
|---|---|
| per-frame prototype voting (original) | 40/53 |
| pooled appearance margin (putt vs swing prototype) | 45/53 |
| **motion valley depth alone** | **48/53** |
| both combined | 49/53 |

Motion wins because a putt is a physically smaller event: valley depth median
**0.21** versus **0.68** for a full swing. The combined rule buys one extra clip
for a second tuned parameter on 53 samples, which is how you overfit — so the
shipped rule is the single threshold `norm < 0.45`.

End-to-end after the change:
* putts left whole  **21/24** (was 15/24)
* swings trimmed    **26/29** (was 25/29)

The classes genuinely overlap — a distant golfer's full swing can be as small as
a near putt (full_swing norm ranges 0.11–1.60, putt 0.05–0.55) — so ~9% will
still be called wrong, and no threshold fixes that. Separating those needs a cue
that is not amplitude, e.g. the club going above the head.

## Why a human reads these frames and the model cannot

Two experiments, both aimed at "why can you tell it's a putt and the model can't".

**1. The information is not in the golfer crop.** A trained linear probe on the
MobileCLIP2 embedding at the chosen moment (leave-one-clip-out, n=53):

| features | accuracy |
|---|---|
| tight golfer crop (what ships) | 34/53 (64%) |
| **whole frame (the scene)** | **41/53 (77%)** |
| whole frame + motion | 48/53 |
| motion threshold alone | 48/53 |

A trained classifier on the crop does WORSE than one motion threshold, so the
earlier rule was not merely crude — the signal is absent. Embedding the whole
frame recovers a lot of it, which identifies the cause: a human calling a putt is
reading the GREEN, the FLAG and the crouching playing partners, and the crop
deliberately deletes all of that to zoom on the golfer. But it still adds nothing
on top of motion, so it is not worth doubling the Core ML cost. NOT SHIPPED.

**2. Pose is a different kind of signal, and it does pay.** Wrist height relative
to the shoulders, normalised by torso length (Apple Vision, no model to ship):

* pose alone            38/40
* motion alone          37/39
* **motion AND pose     38/39**

The reason to want it is not that +1. Motion amplitude is DISTANCE-DEPENDENT — a
full swing at 40m moves fewer pixels than a putt at 3m, which is exactly the
"any angle, any distance" complaint. Pose is normalised by the golfer's own
torso, so it is invariant to distance and to which way they face. The two fail
differently, which is why requiring both to agree beats either.

Pose locked on for 40/40 clips, including distant golfers — better than expected.

**Two wrong hypotheses on the way, both killed by looking:**
* "Vision picked the wrong person" — picking the largest body changed nothing.
* "A wide window caught post-shot movement" — narrowing it changed nothing.
The actual bug was NORMALISATION: dividing by the VERTICAL shoulder-hip distance
explodes when a golfer is bent over a putt, because shoulders and hips are then
at nearly the same height. Using true Euclidean torso length fixed it (37/40 ->
38/40).

**Remaining limit.** IMG_0558 has two golfers overlapping and Vision returns a
blended skeleton — wrists apparently above the shoulders during a putt. No
threshold repairs that. "Any angle, any perspective, always" is not reachable:
when the golfer is a few dozen pixels tall the information is not in the frame
for anyone.

---

## Chips (2026-07-28) — and a measurement error that hid them

Henry reported chips coming back as putts, so untrimmed. Two things turned out
to be wrong, and the second was worse than the first.

**1. The `full_swing` set was contaminated with chips.** Eight of the ten clips
in his `chip/` folder are byte-identical duplicates of clips labelled
`full_swing` here. Every "full swing" accuracy figure above was computed over a
set that silently mixed the two classes. It also explains the bimodal wrist
heights noted earlier — the low cluster was never a measurement artifact, it
was the chips.

**2. The evaluation scored with a different function than the device runs.**
`proto.score_frames(mode="knn")` votes over individual exemplars.
`SwingVisionModule` ships three AVERAGED prototypes and scores a frame as
`max(dot(swing), dot(putt)) - dot(negative)`. Those are not the same function
and they choose different candidates: on IMG_0592 the k-NN path picks 7.28s
(the real bunker shot) and the device path picks 17.02s. Since pose is measured
AT the chosen instant, a threshold tuned on k-NN instants is tuned on moments
the phone never looks at. Everything below is re-measured on the device path.

**The structural bug.** Motion decided the stroke type and pose was only allowed
to DEMOTE a swing to a putt. A chip's motion amplitude looks like a putt's, so
motion called it a putt and pose — the one signal that gets chips right — was
never consulted. No threshold could have fixed this; the wiring was wrong.

Wrist height separates the classes cleanly once measured at the right instant:

| class | range | n |
|---|---|---|
| putt | -0.82 .. -0.53 | 22 of 25 |
| chip | -0.21 .. +0.28 | 9 of 10 |
| full swing | -0.44 .. +0.69 | 21 |

Putts top out at -0.532, shots bottom out at -0.438, so the bar sits at -0.485.
Note chips are nowhere near full swings on this scale — the class that has to be
separated is putt-vs-everything, not chip-vs-swing.

**Result** (56 clips: 25 putts, 21 full swings, 10 chips):

| rule | overall | chips | swings | putts |
|---|---|---|---|---|
| motion decides, pose demotes | 49/56 | 6/10 | 20/21 | 23/25 |
| pose decides, motion falls back | 52/56 | 9/10 | 21/21 | 22/25 |

**What is still wrong.**
* IMG_0592 — the localizer picks 17.02s, which is not the shot. A stroke-type
  problem only in appearance; the instant is wrong upstream.
* IMG_0558 — overlapping golfers, unchanged from before.
* IMG_0582, IMG_0579 — putts reading too high. Tightening the bar to -0.22
  rescues 0579 but loses IMG_0596, a real swing at -0.438. Net zero, and it
  trades a putt for a swing, which is the worse direction.

**The motion fallback is untested.** Pose locked on for 56/56 clips, so that
branch never ran. `puttFallbackNormMax = 0.60` has no evidence behind it beyond
the argument that a wrongly trimmed putt costs more than a wrongly untrimmed
shot. The clips that would exercise it are the ones this set does not contain.
