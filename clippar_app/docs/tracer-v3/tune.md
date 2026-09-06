# tune — raising the tracer's hit rate on real footage

**Owner:** agent `tune`. **Files owned:**
`clippar_app/modules/shot-detector/ios/TracerDetect.swift`,
`clippar_app/modules/shot-detector/ios/TracerDetectCore.swift`,
`clippar_app/lib/tracerV3.ts`, and this document.
The bench (`docs/tracer-v3/bench/`) is another agent's and is **not** edited here.

Written incrementally. **Nothing here has run on a phone.**

---

## The short version

**Two changes to `lib/tracerV3.ts`. Measured on the bench's own 121 clips, at the
app's own impact, under imported-clip conditions:**

```
HIT RATE   full_swing   15/51  29.4%  ->  21/51  41.2%
FALSE DRAW putt+none     1/49   2.0%  ->   0/49   0.0%
chips drawn             10/21          ->  11/21
lab regression set       5/15  33.3%  ->   9/15  60.0%
CEILING (true impact)   13/26  50.0%  ->  17/26  65.4%
```

1. **`poor_fit` had a length conjunct and a golf trolley walked through it.** It
   refused `rms > 4 px @1080p` only at `nPoints >= 10`. `IMG_0323` — a phone
   strapped to a trolley being wheeled down a fairway — fitted three moving blobs
   at 5.6 px and drew an arc. The conjunct is gone; the threshold is unchanged.
   Nothing else in the corpus is above the bar, so it cost zero clips and removed
   the only false draw.

2. **The camera pitch was one guess, and the guess was deciding the answer.** An
   import carries no CoreMotion pitch, so the ladder assumes 4 deg. On `IMG_3660`
   — 43 detections at 0.53 px rms — that assumption fits a driver as a ball
   rolling along the ground (`apex 0.27 m`) and refuses it; the same detections at
   0 deg fit apex 1.84 m and draw, at -6 deg apex 8.9 m, and **the pixel residual
   is 0.45-0.54 px at every one of them.** `traceClip` now runs the fit at six
   assumed pitches and **draws only where at least two of them agree**, which is a
   new refusal (`pitch_unstable`) as much as it is a rescue.

**Nothing shipped in the Swift detector.** Four tracker knobs were exposed so the
obvious detector fix could be tested; it was, over all 18 clips it would touch,
and **2.5x the tracker's patience bought zero traces and two junk tracks** (§9).

**Everything left is detector work at 1080p30**, where the ball is under two
pixels within four frames of impact. 4K60 clips draw at 64.3%; 1080p30 at 33.3%
(§4).

Both numbers were then re-measured **from a cold detector cache** — every
detection in the corpus recomputed — and came back identical. The impact-error
sweep was re-run too: **every impact offset from -3 s to +2 s improved by 11.5 to
19.2 points, with 0 false draws at every one** (§3), so the gain is not an
artefact of the impact this corpus happened to be given. `selfcheck.py` exits 0.

---

## 0. The baseline, reproduced before anything was changed

`selfcheck.py` passed on arrival (results measured with the current detector hash
`2ca30f5e58e2`), and `report.py` over the cached `results-app.json` reproduces
`bench.md`'s headline exactly:

```
HIT RATE   full_swing   15/51  =  29.4%    henry 10/25 | lab 5/15 | unseen 0/11
FALSE DRAW putt+none     1/49  =   2.0%    IMG_0323 (camera on a golf trolley)
chips drawn             10/21  =  47.6%
```

Ranked full-swing misses at the app's own impact (36 of them):

| clips | refusal |
|---:|---|
| 18 | `detector_found_no_address_ball` |
| 8 | `track_not_ballistic` |
| 6 | `not_a_flight` |
| 2 | `putt` (the app classified a full swing as a putt) |
| 1 | `implausible_flight` |
| 1 | `poor_fit` |

---

## 1. The false draw: `poor_fit` had a length conjunct, and a golf trolley walked through it

`IMG_0323` is a phone strapped to a golf trolley being wheeled down a fairway.
No golfer, no club, no ball. It **drew an arc**. Probed:

```
K=3   rms 11.18 px on a 2160-wide frame  = 5.59 px @1080p
hCamM 0.224 m       (the calibration puts the camera 22 cm off the ground)
address r 18.68 -> 8.57, 7.57, 10.88     (the "ball" gets BIGGER while flying away)
sigma_v0 = 128% of v0
```

Every gate let it past. The one that should have caught it is `poor_fit`, and it
read `nPoints >= POOR_FIT_MIN_K (10) && rms > 4 px @1080p`. **The length conjunct
is why.** Three points and a 5.6 px residual is not a flight at any track length,
and the file's own `LOOSE_RMS_PX_1080` comment already names the hole — "5-8
frame tracks with an rms between 4 and 8 px, which draw carrying only a
`large_pixel_residual` flag nobody reads" — but it closed it **only for the
number**, not for the arc.

**The change is the deletion of `usedFit.nPoints >= POOR_FIT_MIN_K &&`.** The
threshold (4 px @1080p) is untouched.

Measured over all 121 clips before changing it — the rms of everything that draws
today, in 1080-equivalent px:

| rank | clip | class | K | rms @1080 |
|---|---|---|---:|---:|
| 1 | **IMG_0323** | **not_a_shot** | 3 | **5.59** |
| 2 | IMG_0592_2 | chip | 39 | 3.03 |
| 3 | IMG_0546_2 | chip | 6 | 2.48 |
| 4 | IMG_0552_2 | full_swing | 41 | 2.58 |
| … | every other drawing clip | | | ≤ 2.35 |

So the bar sits in a gap: the only thing above 4 px is the trolley. Measured
effect on the corpus, everything else held: **FALSE DRAW 1/49 -> 0/49, HIT RATE
15/51 unchanged, chips 10/21 unchanged.** It can only ever turn a draw into a
refusal, which is the safe direction.

## 2. The camera pitch was a single guess, and the guess decides the answer

### The mechanism, on `IMG_3660`

4K60, 43 detections, a driver. At the shipped assumed pitch of **4 deg** the fit
lands at **rms 0.53 px** — as clean as anything in the corpus — and reports
`v0 69.4 m/s, apex 0.27 m, hang 1.60 s`. A ball leaving the face at 69 m/s does
not stay 27 cm off the ground, so the ladder correctly calls it `not_a_flight`.

The same detections, the same code, only the assumed pitch moved:

| assumed pitch | rms px | v0 | apex | carry | outcome |
|---:|---:|---:|---:|---:|---|
| -6 | 0.50 | 48.3 | **8.86 m** | 129.9 | draws |
| -2 | 0.50 | 55.3 | 4.20 m | 129.1 | draws |
| 0 | 0.53 | 58.3 | 1.84 m | 113.8 | draws |
| **+4 (shipped)** | **0.53** | **69.4** | **0.27 m** | 90.2 | **refused `not_a_flight`** |
| +9 | 0.54 | 87.8 | 0.38 m | 116.5 | draws |

**The pixel residual is flat and the physics is not.** The apex moves by a factor
of thirty across a range of camera angles no one measured. `not_a_flight` is
testing the *fitted world flight* — apex, hang, v0 — and on an imported clip
those are a consequence of the guess, not of the evidence.

### Why the existing pitch nuisance cannot fix it

`chooseModel` already frees `dPitchDeg` when the pitch is assumed, and
`ASSUMED_PITCH_SIGMA_DEG` widens its prior to 12 deg. Two things stop that
working:

1. `lib/tracerFit.ts` bounds `dPitchDeg` to **±5 deg** — narrower than the 12 deg
   prior it is given, so the optimiser cannot reach a camera the prior says is
   perfectly likely.
2. Worse, the 13-seed multistart ranks its basins in **stage 1 with `dPitchDeg`
   held at 0** (`free1` drops it). The basin is therefore chosen at the *guessed*
   pitch, and the nuisance can only polish inside it. On IMG_3660 every start
   from +2 upward converges to an effective 6.47 deg and the rolling-ball basin;
   every start at 0 or below lands in the airborne one.

Both of those are in `lib/tracerFit.ts`, which this agent does not own. The fix
is expressed at the caller instead, where it is also the more honest place: the
pitch is not a nuisance to be polished, it is an unknown to be searched.

### The evidence for where to search: the lab measured eight real setups

`tracer-lab/experiments/camera/report.md` calibrated the camera on eight clips of
the same phone clamp — pitch **-3.00 to +6.43 deg**, camera height 0.86–1.63 m.
Restated at this code's f_px (6 % larger than the lab's, so the same horizon row
implies a slightly smaller pitch) that is **-2.8 to +6.1 deg**. **The shipped
prior of +4 sits near the top of that range**, which is why every sweep below is
one-sided.

### Corpus sweep: one fixed pitch at a time, all 121 clips

*(Measured BEFORE §1's `poor_fit` change, so the false-draw column is the old one:
`IMG_0323` at every pitch from +2 up, and a putt at -4. §1 removes `IMG_0323`
everywhere; the hit-rate column is unaffected by it.)*

| assumed pitch | full-swing hits | false draws |
|---:|---|---|
| -6 | 19/51 37.3% | 0 |
| -4 | 20/51 39.2% | 1 (a putt) |
| -2 | 16/51 31.4% | 0 |
| 0 | 19/51 37.3% | 0 |
| +2 | 18/51 35.3% | 1 (IMG_0323) |
| **+4 (shipped)** | **15/51 29.4%** | 1 (IMG_0323) |
| +6 | 13/51 25.5% | 1 |
| +8 | 12/51 23.5% | 1 |
| +10 | 10/51 19.6% | 1 |

**The shipped value is the worst of the useful range**, and above it the rate
falls monotonically. But no single value is right either — the 16–20 wobble
between -6 and 0 is the optimiser changing basins, not a real optimum. Two other
single-guess ideas were tried and **did not work, and are recorded because they
looked good on paper**:

* **Solve the pitch from an assumed camera HEIGHT** (the address ball's size
  gives its range; its depression below the horizon then fixes hCam/range, so
  fixing hCam fixes the pitch). Against the six labelled clips whose true pitch
  is known this is better on five and much worse on one — mean |error| 2.2 deg
  against 3.7 deg for the flat +4 assumption. Over the corpus it is **no better**:
  15–19/51 depending on the assumed height, and at h=1.0 m it adds a false draw.
* **Pick the pitch that minimises the residual.** It does not work at all. On
  IMG_3631 the rms is 0.893–0.895 px for every pitch from -12 to +7 while the
  apex moves from 49 m to 7 m; on IMG_3629 the argmin is at -8 deg when the lab
  measured +1.2. **The residual cannot see the pitch on these tracks.**

### What shipped: a ladder with a quorum

`traceClip` is now a thin wrapper. With a measured CoreMotion pitch it is exactly
what it was. With a **guessed** pitch it runs the fit at
**`prior + [0, -2, -4, -6, -8, -10]`** — six rungs, the prior first — and:

* **draws only if at least TWO rungs produce a drawable spec**, using the rung
  nearest the prior;
* **refuses `pitch_unstable` if exactly one does**, naming the pitch that agreed
  and every pitch tried;
* otherwise returns the prior rung's own refusal, unchanged.

The quorum is the load-bearing half and it is a **refusal, not a rescue**. A real
flight survives the camera moving inside its own uncertainty — it reinterprets
(a different apex at every rung) but it keeps fitting. A track that is a flight
at one isolated camera and at none of its neighbours is a coincidence of the
optimiser. Measured on the corpus:

| rungs required | full swings drawn | putt / not-a-shot drawn |
|---:|---|---|
| 1 | 24/51 | 1 — `IMG_0596_2`, a putt |
| **2** | **21/51** | **0** |
| 3 | 18/51 | 0 |

(measured with §1's `poor_fit` change already in; before it, the same three rows
read 24/51 with **two** false draws, 22/51 with one, and 18/51 with none — the
extra full swing at quorum 2 was `IMG_3623`, whose only other agreeing rung fitted
at 6.3 px @1080p and is now correctly refused.)

`IMG_0596_2` is a putt on a green whose seven detections fit at 3.1 px at exactly
one rung (-4 deg) and at 11.6–22.5 px at the other five. That is the shape the
quorum is for. **The price is named rather than hidden:** `IMG_0578_2` and
`IMG_0598_2` are real full swings that also pass at exactly one rung and are
refused with it.

Ladder shape, measured (all with the quorum at 2):

| deltas from the prior | hits | false |
|---|---|---|
| `[0,-2,-4,-6]` | 19/51 | 0 |
| **`[0,-2,-4,-6,-8,-10]`** | **21/51** | **0** |
| `[0,-2,-4,-6,-8,-10,-12,-14]` | 21/51 | 0 |
| `[0,+2,-2,-4,-6,-8]` | 20/51 | 0 |
| `[0,-3,-6,-9]` | 20/51 | 0 |
| `[0,-1,-2,…,-10]` (1 deg steps) | 24/51 | **1** |

The 1 deg ladder is the honest counter-example to the quorum: sample the camera
finely enough and a coincidence gets two adjacent rungs to agree with it. 2 deg
steps are what keeps the quorum meaningful.

**Cost**, timed per clip on this Mac (best of three, `Date.now()` around
`traceClip`, no I/O in the loop):

| | n | median | max | median rungs run |
|---|---:|---:|---:|---:|
| clips that draw | 32 | **61 ms** | 575 ms (`IMG_7873`, 44 points, 6 rungs) | 2 |
| clips the ladder refuses | 89 | 0 ms | 510 ms | 5 |

A clip that passes at the prior costs **two** fits, not six — the loop stops as
soon as the quorum is met, and stops early once the remaining rungs cannot reach
it. The 0 ms median on the refusal side is the clips with no detections, which
never reach a fit at all. The whole 121-clip corpus takes 3.8 s of node against
~1 s single-pitch.

**This is arithmetic, not Core ML and not decode**, so it should not behave like
the detector does on a phone — but that is an expectation. **Nothing here has run
on a phone**, and a 575 ms worst case on an M-series Mac is worth someone
measuring on device before it ships.

### Measured, both changes together

```
                     before        after
HIT RATE full_swing  15/51 29.4%   21/51 41.2%
FALSE DRAW           1/49  2.0%    0/49  0.0%
chips drawn          10/21         11/21
  henry              10/25         10/25
  lab                 5/15          9/15
  unseen              0/11          2/11
```

---

## 3. Verified through the bench itself, not my own driver

Both changes are ladder-only, so the detector cache is untouched and
`bench.py --mode app` re-runs the whole corpus in **3.7 s**. `selfcheck.py` passes
and the results still carry detector hash `2ca30f5e58e2`.

```
=== tracer bench — mode=app  detHash=2ca30f5e58e2  3.7s wall ===
  HIT RATE   full_swing   21/51  =  41.2%
  FALSE DRAW putt+none     0/49  =   0.0%
  chips drawn             11/21  =  52.4%
    henry     10/25  =  40.0%
    lab        9/15  =  60.0%
    unseen     2/11  =  18.2%
```

**The lab regression set went UP, 5/15 -> 9/15.** That is the set the ladder was
originally fitted against, so it is the one a change like this could most easily
have broken.

Ceiling, `--mode truth` (the 26 clips with a hand-confirmed impact):
**13/26 = 50.0% -> 17/26 = 65.4%.**

`selfcheck.py` exits 0 with all three results files — app, truth and sweep — at
the current detector hash.

### The impact-error sweep, re-run: the gain is not a lucky impact

`bench.py --mode sweep` displaces the impact deliberately and moves the trim
window with it, 26 confirmed full swings x 11 offsets, 286 detector runs, 3 254 s.
Re-run at the new detector hash:

| impact offset | before | **after** | false draws |
|---:|---|---|---:|
| -3 000 ms | 13/26 50.0 % | **17/26 65.4 %** | 0 |
| -2 000 | 14/26 53.8 % | **18/26 69.2 %** | 0 |
| -1 000 | 11/26 42.3 % | **16/26 61.5 %** | 0 |
| -500 | 12/26 46.2 % | **16/26 61.5 %** | 0 |
| -250 | 11/26 42.3 % | **16/26 61.5 %** | 0 |
| 0 | 13/26 50.0 % | **17/26 65.4 %** | 0 |
| +250 | 15/26 57.7 % | **18/26 69.2 %** | 0 |
| +500 | 12/26 46.2 % | 15/26 57.7 % | 0 |
| +1 000 | 11/26 42.3 % | **16/26 61.5 %** | 0 |
| +2 000 | 13/26 50.0 % | **17/26 65.4 %** | 0 |
| +3 000 | 1/26 3.8 % | 1/26 3.8 % | 0 |

**Every offset from -3 s to +2 s improved, by 11.5 to 19.2 points, and the false
draw count stays 0 at every one.** So the gain is a property of the ladder, not of
the impact the app happened to produce — which is what I would want to see before
believing a 12-point improvement measured at one impact per clip.

The +3 s column is unchanged and is not a detection failure: it is
`bench.md`'s trim-window collapse (`render_spec: animStartSec out of range`), the
app trimming 2.5 s before / 1.5 s after **its own** impact so a 3 s error puts the
shot outside the clip the golfer is shown. Nothing in `lib/tracerV3.ts` reaches it.

### The arcs, checked as arcs and not just as verdicts

The bench does not call the renderer, so I checked the spec geometry directly on
all **32** clips that now draw:

* **0 of 32 traces end above the horizon** (`meta.landingCheck.aboveHorizon`).
* **32 of 32 start exactly at the address ball** — the first spec sample is
  0.0 px from `detection.address` on every one.
* Two carry the pre-existing `landing_depression_off` diagnostic (`IMG_3624`, a
  chip, and `IMG_3652`, which already drew before this change). Neither is new.
* **32 of 32 pills read `no distance / camera unknown`.** Not one number is
  stated on an imported clip, before or after.

---

## 4. What is left, and how much of it can ever work

30 full swings still miss. Ranked, at the app's own impact:

| clips | refusal | where it lives |
|---:|---|---|
| **18** | `detector_found_no_address_ball` | the Swift detector |
| 7 | `track_not_ballistic` | fit, or detections that are not all the ball |
| 2 | `putt` — the app classified a full swing as a putt | `swing-vision`, not this code |
| 2 | `pitch_unstable` | the quorum's own price (§2) |
| 1 | `implausible_flight` | ladder gate |

`detector_found_no_address_ball` is now more than half of everything left, and it
is one ladder message covering **three different detector outcomes**:

| clips | detector's own note | what it means |
|---:|---|---|
| 9 | `track of 1 (or 2) detection(s) … suppressed` | the ball WAS found, for one or two frames, then lost |
| 6 | `no first detection within 4 frames of launch fN` | the departure was found, the ball in the air was not |
| 3 | `address refused: weak contrast and outside the pose ROI` | the ball at rest was never found |

**Relaxing `minTrackEmit` would buy nothing.** The nine one- and two-detection
clips would still refuse one rung later: `chooseModel` needs `MIN_FIT` = 3 points
and returns `too_few_detections_no_carry` below that. The detector has to find
more of the ball, not be allowed to emit less of it.

### The strongest single predictor is the capture FORMAT, and it is not a threshold

| format | full swings drawn |
|---|---|
| **2160x3840 @ 60** | **9 / 14 = 64.3 %** |
| 1080x1920 @ 30 | 12 / 36 = 33.3 % |

Zero-detection clips split the same way: **13 of the 36 1080p30 full swings, 2 of
the 14 4K clips.** The arithmetic behind it is not subtle. A golf ball is 42.7 mm.
At this code's f_px a ball at 20 m is **3.4 px across at 1080p** and 6.8 px at 4K,
and `minRadius` stops the tracker at 0.7 px @1080p. A driver leaves at ~60 m/s, so
at 30 fps it is past 20 m within four frames of impact and past 40 m within eight
— by which point at 1080p it is under two pixels, sampled half as often.

Looked at directly on `IMG_6150` (six frames at 1080p30 from the launch frame,
cropped 560x900): the ball is a **2–3 px dot crossing a dark tree line** by the
second frame after impact. It is there. It is at the edge of what a DoG blob
detector can hold on to.

### A hypothesis I had and then killed

I expected the misses to be **side-on captures** (camera perpendicular to the
target line, so the ball leaves across the frame rather than down the optical
axis, where `phiDeg`'s ±60 deg bound cannot follow it). Four of the
`track_not_ballistic` clips are exactly that. **But I then looked at all 51 full
swings, one frame each, drawn and missed side by side — and the drawn set is
just as side-on.** The hypothesis does not survive its own control and is
recorded as refuted rather than quietly dropped.

### Clips I believe genuinely cannot work, named

* **`IMG_0578_2` — a skied drive.** The frames show a pop-up: the ball climbs
  1 275 px up the image while its apparent radius barely changes (9.6 -> 3.7 px)
  and its image-x moves 21 px. That is a ball going nearly straight up, which is
  a real shot and not a flight the ballistic model can express at this camera.
  rms 74 px at every rung of the pitch ladder.
* **`IMG_8231`, `IMG_7721`, `IMG_7600`, `IMG_8175`** — indoor simulator and
  driving-range bays. Nets, mats and screens at 5–15 m; the ball is gone from the
  frame within a few frames of impact.
* **`IMG_3629` and `IMG_0566`** — the app's own classifier calls them putts, so
  the tracer never runs. That is `swing-vision`, upstream of everything here.

I am **not** claiming the other 22 are impossible. I am claiming they are detector
work at 1080p30 and that no threshold in `lib/tracerV3.ts` reaches them.

---

## 5. Things I measured and did NOT ship

Recorded because each one looked right before it was measured, and the next agent
should not spend the afternoon I spent.

**A corroboration quorum instead of a pass-count quorum.** Instead of "two rungs
must fully pass", accept a rung if its residual is corroborated by a second rung
within `max(k x best, best + 1 px @1080)`. It fixes the one clip the current rule
loses for a bad reason: `IMG_0598_2`'s rms is 5.4, 3.8, 5.4, 5.4, 5.4, 5.3 across
the ladder — perfectly stable, sitting on the wrong side of the 4 px `poor_fit`
bar at five rungs out of six, which is a threshold edge and not an instability.
Measured over the corpus:

| rule | hits | false draws |
|---|---|---|
| `pass >= 1` | 24/51 | 1 (a putt) |
| **`pass >= 2` (shipped)** | **21/51** | **0** |
| `pass >= 1 AND corroborated >= 2` (1.5x) | 21/51 | 0 |
| `pass >= 1 AND corroborated >= 2` (2.0x) | **22/51** | 0 |
| `pass >= 1 AND corroborated >= 3` (1.5x) | 20/51 | 0 |

**Worth one clip, for a second threshold I would be choosing from these 51 clips
and no others.** Not shipped. If someone later has a larger corpus, this is the
first thing to try again.

**Dropping the leading detections when they belong to a different object.**
`IMG_7948`'s first two detections jump 1 014 px and then the x moves 184 px in two
frames before settling into a smooth 30-frame run — a classic object switch, and
the ladder's single-outlier rung cannot remove two. But it is the ONLY clip in the
corpus with that shape, and the other six `track_not_ballistic` clips have an rms
that is **flat across the whole pitch ladder** (`IMG_0550_2` 37.5–37.7,
`IMG_0580` 16.9–17.0, `IMG_0600_3` 42.9–43.0, `IMG_7601` 13.5–13.6) — those
detections do not lie on a flight at ANY camera, so the refusal is right. A new
outlier-trimming mechanism for one clip is how a bench gets gamed.

**Relaxing `minTrackEmit`.** Gains nothing (§4).

---

## 6. Before and after — the whole corpus

Same 121 clips, same detector (hash `2ca30f5e58e2`), same cached detections, same
imported-clip conditions, same app-produced impact. Only `lib/tracerV3.ts` moved.

| | **before** | **after** |
|---|---|---|
| **HIT RATE** full_swing | **15/51 = 29.4 %** | **21/51 = 41.2 %** |
| **FALSE DRAW** putt + not_a_shot | **1/49 = 2.0 %** (`IMG_0323`) | **0/49 = 0.0 %** |
| chips drawn (counted neither way) | 10/21 | 11/21 |
| henry | 10/25 = 40.0 % | 10/25 = 40.0 % |
| lab (the regression set) | 5/15 = 33.3 % | **9/15 = 60.0 %** |
| unseen | 0/11 = 0.0 % | 2/11 = 18.2 % |
| CEILING, hand-confirmed impact | 13/26 = 50.0 % | **17/26 = 65.4 %** |
| traces ending above the horizon | 0 | **0 of 32** |
| traces starting away from the ball | 0 | **0 of 32** |
| pills stating a distance on an import | 0 | **0 of 32** |
| `npm run verify` | 886 tests, 0 fail | **897 tests, 0 fail, 0 skipped, 0 todo** |

Both "after" columns were then re-measured **from a cold detector cache** at
detector hash `85f273d0414b` (`./bench.sh --jobs 4`, 2 149.7 s; `--mode truth`,
209.5 s) and came back identical.

Clips that newly draw, all six of them full swings the ladder was refusing on the
strength of a guessed camera: `IMG_3622`, `IMG_3637`, `IMG_3645`, `IMG_3660`,
`IMG_6163`, `IMG_7873`.

Clips that stopped drawing: **`IMG_0323`** (the golf trolley — the point of the
exercise) and nothing else. No full swing and no chip that drew before stopped.

Ranked misses, before -> after:

| refusal | before | after |
|---|---:|---:|
| `detector_found_no_address_ball` | 18 | 18 |
| `track_not_ballistic` | 8 | 7 |
| `not_a_flight` | 6 | **0** |
| `putt` (upstream classifier) | 2 | 2 |
| `implausible_flight` | 1 | 1 |
| `poor_fit` | 1 | 0 |
| `pitch_unstable` (new) | — | 2 |

**`not_a_flight` is gone from the full-swing misses entirely.** Every one of those
six was a driver being fitted as a rolling ball at a camera angle nobody measured.

---

## 7. What changed, file by file

**`lib/tracerV3.ts`** — the only shipped behaviour change.

1. `poor_fit` lost its `nPoints >= POOR_FIT_MIN_K` conjunct; the constant is gone
   with it. The 4 px @1080p bar is unchanged. (§1)
2. The old `traceClip` body is now `traceOnce(input, assumedPitchOverrideDeg)`,
   and a new `traceClip` wraps it with the pitch ladder. With a measured pitch it
   calls `traceOnce(input, null)` and nothing else runs, so a live-capture clip is
   byte-for-byte what it was. (§2)
3. Two new constants, both documented at length in the file:
   `ASSUMED_PITCH_LADDER_DELTA_DEG` and `PITCH_LADDER_MIN_AGREE`.
4. New refusal `pitch_unstable:…`, new flag
   `pitch_ladder(used=…,agreed=n,tried=m,of=6,quorum=2)`, and `pitch_assumed(…)` now reports
   the pitch actually used rather than the configured prior.

**`modules/shot-detector/ios/TracerDetect.swift`** — no default changed. Four
tracker knobs are now readable from the options JSON so a bench can measure what
moving them costs without a native rebuild: `maxMissEarly`, `maxMissLate`,
`minRadius`, and `firstDetFrames` (which was the hard-coded `4` in
"no first detection within 4 frames of launch"). Every default is the shipped
value and every path with an empty options object is unchanged.

**`tests/tracerV3PitchLadder.test.ts`** — new, 11 tests.

**`tests/fixtures/tracerV3AxisFallback.ts`** and
**`tests/tracerV3Refusals.test.ts`** — the FG-3 reproduction had to move, and this
is the part of the change a reviewer should look at hardest.

That fixture's header said, approvingly, that it "slips both residual gates: rms
is 7.66 px @1080p, under MAX_RMS_PX = 8, and `poor_fit` needs nPoints >= 10 while
this track is 7". §1 closed exactly that hole, so the fixture's default launch is
now **refused** — correctly, for a fit that misses its own detections by 7.66 px
and does not converge (`ok: false`). With it refused, FG-3 had no reproduction
left and two tests went red.

I did **not** relax the gate to make them pass. I moved the fixture's default
launch to the nearest neighbouring geometry that still satisfies all three FG-3
conditions and converges — 35 deg / 2.0 deg azimuth instead of 45 / 3.0, rms
3.37 px @1080p, sigma(v0)/v0 12 %, GPS-drawn carry 28.7 m against a truth of
23.6 m (+21 %) — and rewrote the header to say so, including "do not restore the
old numbers". One further test (`FG-1: the label-sigma test is reachable on its
own`) relied on the old default at `frames: 5`; it now names its own launch
(10 m/s, 50 deg) so it cannot silently stop reaching its assertion again.

**Nothing in `lib/tracerFit.ts`, `lib/tracerPhysics.ts` or `lib/tracerCamera.ts`
was touched**, although §2 names two defects in `tracerFit.ts` — the ±5 deg
`dPitchDeg` bound against a 12 deg prior, and stage-1 basin ranking with the pitch
held at zero. The ladder works around both from the caller. Fixing them properly
is the better change and it belongs to whoever owns that file.

---

## 8. Honest limits

Everything in this list is a thing this document does NOT establish.

1. **Nothing ran on a phone.** The detector and the ladder are the shipped code
   compiled from the checked-in sources, but they executed on this Mac's Vision
   and Core ML. Not one number here has been reproduced on device.
2. **The renderer was never called.** "Drew" means `traceClip` returned a spec.
   The horizon, start-at-the-ball and pill checks in §3 read the SPEC — the
   polyline the renderer would be handed — not a rendered frame. Whether
   `TracerRenderV3.swift` draws that polyline correctly is a different bench.
3. **The pitch ladder's EXTENT is fitted to this corpus.** The lab's eight
   calibrated setups justify searching a range; they do not justify `[0, -2, -4,
   -6, -8, -10]` from a +4 prior specifically. The corpus sweep is what chose that,
   and 51 full swings is not many. The 2 deg STEP is likewise measured (a 1 deg
   ladder admits a false draw) rather than derived.
4. **`PITCH_LADDER_MIN_AGREE = 2` is a corpus number.** It is 0 false draws on 49
   negatives. 49 is not a large enough sample to say the rule holds in general,
   and it costs two real full swings that I have named.
5. **The classification is another agent's, and 4 of the 51 full-swing labels are
   marked low-confidence** (`IMG_3646`, `IMG_0552_2`, `IMG_0591`, `IMG_7948`). I
   did not re-label anything. A single clip is worth 2 points of hit rate.
6. **The 26-clip ceiling is a favourable subset**, for the reason `bench.md`
   gives: those are exactly the clips whose audio impact the frames confirmed.
7. **I did not test the pitch ladder against a MEASURED pitch on real footage**,
   because no clip in this corpus carries one. The code path is guarded
   (`isPitchAssumed`) and pinned by a test, but "a live-capture clip is
   unaffected" is an argument from the guard, not a measurement.
8. **Two `lib/tracerFit.ts` defects are worked around, not fixed** (§7).
9. **The unseen corpus is 11 full swings.** 0/11 -> 2/11 is a real improvement and
   it is two clips.

---

## 9. The detector experiment that failed, in full

All the remaining headroom is in the Swift detector (§4), so it was tested rather
than assumed. The four knobs added to `TracerDetect.swift`'s options parser exist
because of this run, and they are how anyone repeats it.

**The variant:** `{"maxMissEarly":6,"maxMissLate":8,"minRadius":0.5,"firstDetFrames":10}`
— against shipped defaults of 3, 5, 0.7 and 4. That is roughly **2.5x the
tracker's patience in every direction**: how many consecutive frames it may lose
the ball while the track is young and once it is established, how small a
predicted radius it will keep chasing, and how long after the launch frame the
sector search gets to find the ball at all.

Run over all 18 clips whose refusal is `detector_found_no_address_ball`, at each
clip's own app impact:

| outcome | clips |
|---|---:|
| unchanged | 9 |
| a `no first detection` clip became a 1–3 detection track, still suppressed | 5 of the 6 |
| **got WORSE** — a 2-detection track became a 1-detection one | 2 (`IMG_0523_2`, `IMG_0595`) |
| **reached 3 detections and emitted** | **2** — `IMG_0527`, `IMG_0591` |
| **drew an arc** | **0** |

`IMG_7600` is the one worth naming separately: it went from "no first detection"
to a 3-detection track at **mean confidence 0.26**, and `confFloor` (0.4) swallowed
it — the second half of the emission rule doing its job on exactly the material a
looser tracker produces. `IMG_8014` still fails at 10 frames as it did at 4.

And the two that emitted are exactly what `minTrackEmit` exists to swallow:

```
IMG_0527   3 detections, fit rms 150.6 px  -> implausible_flight: apex 92.0 m, hang 10.55 s
IMG_0591   3 detections, fit rms   5.4 px  -> not_a_flight: v0 7.6 m/s, apex 0.82 m
```

**So: 2.5x the tracker's patience buys zero traces and two junk tracks.** No
detector default was changed. The result is the strongest evidence in this
document for the ceiling claim in §4 — on these clips the ball is not being lost
by an impatient tracker, it is not detectable on more than one or two frames.

> **One cost, paid rather than passed on.** Adding those four knobs changes
> `TracerDetect.swift`, and the bench keys its detection cache on the detector's
> source hash — so the next `./bench.sh` would have re-run all 121 clips. **I
> re-ran it myself.** `./bench.sh --jobs 4` from a cold cache at the new hash
> `85f273d0414b` took **2 149.7 s** and returned **21/51, 0 false draws, 11/21
> chips — identical, clip for clip, to the run off the old cache.** That is also
> the proof that the four added knobs are behaviour-neutral: every detection in
> the corpus was recomputed by the modified detector and nothing moved.
> `--mode truth` was re-run the same way (209.5 s, **17/26**), and the sweep after
> it.

---

## 10. How to reproduce any of this

```bash
cd ~/projects/clippar/final_shipment/clippar_app/docs/tracer-v3/bench
python3 selfcheck.py                                   # ALWAYS first
./bench.sh --jobs 4                                    # the headline
./bench.sh --mode truth                                # the ceiling
python3 report.py $BENCH_WORK/results-app.json --full  # per clip
```

A ladder-only change re-runs the whole corpus in about 4 seconds, because
`bench.py` re-uses every cached detection. **A change to either
`TracerDetect*.swift` re-runs all 121 for real (~36 min at `--jobs 4`).**

The pitch experiments in §2 were run outside the bench, on the same cached
detections, by calling `traceClip` directly with the assumed pitch overridden —
which is a dozen lines and needs nothing from this repo but `lib/tracerV3.ts`,
`constants/config.ts` and a detection JSON out of `$BENCH_WORK/detcache/`.

The detector experiment in §9 needs a private copy of the harness so it does not
disturb the bench's cache:

```bash
mkdir -p /tmp/det && cd /tmp/det
cp ~/projects/clippar/final_shipment/clippar_app/modules/shot-detector/ios/TracerDetect*.swift .
cp ~/projects/clippar/final_shipment/clippar_app/docs/tracer-v3/bench/mainTracerDet.swift main.swift
mkdir -p ShotDetectorResources.bundle
cp -R "$BENCH_WORK/models/GolfBallDetector.mlmodelc" ShotDetectorResources.bundle/
xcrun swiftc -O TracerDetectCore.swift TracerDetect.swift main.swift -o tracerdet
./tracerdet <clip.MOV> <impactMs> '{"maxMissEarly":6,"maxMissLate":8,"minRadius":0.5,"firstDetFrames":10}'
```

Stage the clip out of `~/Downloads` first — `bench.md`'s Trap 2 is real, and the
`$BENCH_WORK/clips/` hardlinks are already there.

---

## 11. For whoever picks this up

1. **Check FALSE DRAW before HIT RATE, every time.** It is 0/49 now. A change that
   lifts the hit rate and puts one arc on a putt is a regression, whatever the
   headline says.
2. **The next real gain is in the detector, and it is not a threshold.** §9 tested
   the obvious relaxation across all 18 clips it could touch and it bought
   nothing. What would help is finding the ball when it is 1.5–3 px on a
   1080p30 frame — a different detector, a different scale in the DoG bank, or
   the model run on tiles at the predicted position. That is a project, not a
   constant.
3. **Fix `lib/tracerFit.ts` properly.** §2 works around two defects from the
   caller: `dPitchDeg` bounded to ±5 deg while its prior is 12 deg wide, and the
   multistart ranking its basins with the pitch pinned at zero. Freeing the pitch
   in stage 1 would make the six-rung ladder unnecessary, and would be cheaper.
4. **`config.tracer.v3.assumedPitchDownDeg` is still 4** and is still the ladder's
   first rung. The lab's eight calibrated setups average about +1.5 deg. Moving
   the prior is a one-line change that would reorder the ladder; I left it alone
   because the quorum makes the ordering matter much less than it did, and
   because moving a shipped default on 51 clips is not warranted.
5. **Do not re-label a clip to move a number.** `classification.json` is the only
   part of this bench not reproducible from code.
