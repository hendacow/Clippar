# tracer bench — measuring the v3 pipeline under app conditions

Owner: agent `bench`. Owns `docs/tracer-v3/bench/` and this file, nothing else.
Everything below was measured on 2026-09-06/07 with the code exactly as it stands.

---

## The baseline, in three numbers

Every clip in the corpus, through the **shipped Swift detector** and the **shipped
TypeScript ladder**, under **imported-clip conditions** (no CoreMotion pitch, no
lens or zoom, no GPS), at **the impact the app's own detector produces** — not an
audio impact, not a human's.

```
HIT RATE   full_swing   15/51 =  29.4%      henry 10/25 40.0% | lab 5/15 33.3% | unseen 0/11 0.0%
FALSE DRAW putt+none     1/49 =   2.0%      MUST BE 0  ->  IMG_0323
chips drawn             10/21 =  47.6%      neither credited nor charged
```

And the ceiling, the same pipeline given a **hand-confirmed correct impact** on
the 26 clips where one exists:

```
HIT RATE   full_swing   13/26 =  50.0%      henry 6/10 60.0% | lab 6/13 46.2% | unseen 1/3 33.3%
```

**Read those two together.** A perfect impact takes the hit rate from 29.4% to
50%, and no further. **The impact is worth roughly twenty points; the other fifty
are somewhere else.**

And the impact-error sweep (below) says even those twenty points are not really
about impact accuracy any more: the detector now relocates a deliberately wrong
impact back to within ~20 ms of truth anywhere in +-3 s. The 29% -> 50% gap is
mostly the app's *classification* (2 full swings called putts) and the trim
window, not the instant itself.

At a hand-confirmed impact the 13 remaining misses are
`detector_found_no_address_ball` 4, `not_a_flight` 4, `track_not_ballistic` 2,
`implausible_flight` 2, `poor_fit` 1 — i.e. **nine of the thirteen are the ladder
refusing evidence it already has.**

> **Nothing here ran on a phone.** The detector and the ladder are the shipped
> code compiled from the checked-in sources, but they execute on this Mac's
> Vision and Core ML (`sdharness` on the iOS Simulator). The renderer is never
> called: `drew` means the ladder returned a spec, not that an arc was drawn.

---

## The one thing to fix first

**Two clips drew an arc that must not have.** Both are in Henry's own footage.

| clip | what it is | K | rms | pill |
|---|---|---:|---:|---|
| `IMG_0323` | **the camera strapped to a golf trolley being pushed down a fairway.** No golfer, no club, no ball. | 3 | 11.2 px | "no distance / camera unknown" |
| `IMG_0596_2` | a putt on a green | 5 | 7.3 px | "no distance / camera unknown" |

Neither states a distance — `too_uncertain_no_distance` fires on both, so the
number half of the product rule holds. **The arc half does not.** Henry's rule is
that it may skip, and it may draw an arc with no distance, but it must never draw
over something that is not a golf shot, and a trolley being wheeled along is the
purest possible case of that.

Both carry the flag **`impact_corrected:true`** — these are `impactSearchOffsets`
retries. The stop-gap that exists to rescue a missed impact is, on these two
clips, **manufacturing a shot out of a clip that has none**: it sweeps ±3 s, finds
three or five moving blobs somewhere, and the ladder accepts a 3-point "track".
Any work on the impact search has to be measured against this number and not just
against the hit rate.

---

## What the failures actually are, ranked

Over the 36 full-swing misses at the app's own impact:

| clips | refusal | where it lives |
|---:|---|---|
| **18** | `detector_found_no_address_ball` | Swift detector |
| **8** | `track_not_ballistic` — rms 9.2–74 px against an 8/16 px gate | detector or fit |
| **6** | `not_a_flight` — "v0 59.5 m/s, **apex 0.03 m**, hang 0.87 s (a putt…)" | ladder fit |
| 2 | `putt` — the app classified a full swing as a putt (`IMG_3629`, `IMG_0566`) | swing-vision |
| 1 | `implausible_flight` — apex 60.9 m > the 48.8 m driver cap | ladder gate |
| 1 | `poor_fit` — rms 5.4 px > 4 px over 15 frames | ladder gate |

Across **all** 121 clips, whatever the class, the refusal that touches most clips
is the same one — and most of the clips it touches are ones that *should* be
refused:

```
59  detector_found_no_address_ball    putt:26  full_swing:18  not_a_shot:9  chip:6
14  putt                              putt:9   full_swing:2   not_a_shot:2  chip:1
```

That shape matters. **`detector_found_no_address_ball` is currently doing most of
the product's refusing.** 41 of the 59 clips it rejects are putts, chips or
not-a-shot — i.e. it is right for the wrong reason. Anyone who "fixes" the address
finder without watching FALSE DRAW at the same time will convert a large block of
correct refusals into arcs over putts. That is the single biggest trap this bench
exists to catch.

### The six `not_a_flight` misses are the cheapest thing to chase

```
IMG_3622  v0 59.5 m/s  apex 0.03 m  hang 0.87 s
IMG_3623  v0 33.7 m/s  apex 0.09 m  hang 0.42 s
IMG_3637  v0 60.0 m/s  apex 0.20 m  hang 1.50 s
IMG_3645  v0 57.9 m/s  apex 0.03 m  hang 0.88 s
IMG_3660  v0 69.4 m/s  apex 0.27 m  hang 1.60 s
IMG_6163  v0 62.4 m/s  apex 0.15 m  hang 1.38 s
```

A ball leaving the face at 59 m/s does not stay 3 cm off the ground. The evidence
is good — at a hand-confirmed impact `IMG_3622` gives nine detections at **0.5 px**
rms, as clean as several clips that drew — and the fit lands in a degenerate flat
corner and is then correctly refused as "a putt". **That is a fit problem, not a
detection problem and not an impact problem: worth 6 clips at the app's impact and
4 at a perfect one, and the cheapest thing on this list to chase, because the
evidence is already there and is being thrown away.**

---

## The app's own impact: better than assumed, but it never abstains

### It answers on 121 of 121 clips. The fallback detector never runs.

```
app impact from swing-vision 121, shot-detector 0, none 0
```

`constants/config.ts` has `detection.swingVision: true`, and both import call
sites in `hooks/useEditorState.ts` (~846 and ~1080) read
`(await visionDetectAndTrim(...)) ?? (await detectAndTrim(...))`.
`lib/visionTrim.ts` returns null only on `decision !== 'SWING'` — **and no clip in
this corpus returned that.** Not the trolley (`IMG_0323`, `IMG_0324`), not the
flooded lie (`IMG_8119`), not the empty green (`IMG_6151`).

So: `ShotDetectorModule.detectAndTrim` is dead code on this corpus, its own
`impactSearchOffsets` ladder is never reached through it, and **every refusal of a
not-a-shot clip has to come from the tracer ladder** — nothing upstream declines.

(The task brief named `detectAndTrim` as "the app's impact". The code says
swing-vision first. Both harnesses are built here; the fallback was measured on
the clips where it would have run, which turned out to be none of them.)

### Against a confirmed impact, it is accurate on the clips where truth exists

26 confirmed full swings:

```
median |error|   0.11 s        within +-0.25 s   22/26 = 84.6%
mean   |error|   0.37 s        within +-1.0  s   23/26 = 88.5%
worst            4.09 s        within +-2.0  s   25/26 = 96.2%
median SIGNED    -0.07 s       (the app reads slightly EARLY)
```

The distribution is bimodal, not noisy: 22 clips inside ±0.18 s, then `IMG_3640`
+0.86, `IMG_0534` +1.22, `IMG_3629` +1.34, `IMG_3626` **+4.09**.

**This is a favourable subset and must be quoted as one.** These 26 are exactly
the clips whose audio onset the frames confirmed. The other 25 full swings had no
candidate the frames supported, and a clip whose strike is hard to hear is
plausibly also a clip a motion+CLIP localizer struggles with. **84.6% is an upper
bound on the app's impact accuracy over the corpus, not an estimate of it.**

Two of these confirmed full swings — `IMG_3629`, `IMG_3661` — are classified
`putt` by the app, which refuses them before any fitting whatever the impact does.

---

## The sweep — The pipeline is now immune to impact error from -3 s to +2 s

`./bench.sh --mode sweep`: the same 26 confirmed full swings, run eleven times
each with the impact deliberately displaced. Both the detector's impact AND the
trim window move together, because in the app they come from the same number.

```
  offset      drew / clips            false draws
    -3000 ms   13/26   50.0% ##########            0
    -2000 ms   14/26   53.8% ###########           0
    -1000 ms   11/26   42.3% ########              0
     -500 ms   12/26   46.2% #########             0
     -250 ms   11/26   42.3% ########              0
        0 ms   13/26   50.0% ##########            0
      250 ms   15/26   57.7% ############          0
      500 ms   12/26   46.2% #########             0
     1000 ms   11/26   42.3% ########              0
     2000 ms   13/26   50.0% ##########            0
     3000 ms    1/26    3.8% #                     0
```

**Flat.** The +-4 point wobble between -3 s and +2 s is 26 clips of noise, not a
trend. **This contradicts the premise the project has been working from**, and it
is worth being precise about why.

### Because the impact scan has already landed, and it works

Between 23:45 and 00:21 tonight another agent shipped Henry's design into
`TracerDetect.swift` — the departure scan across the trim window, with
`impactSearchOffsets` demoted to a fallback. The detector now reports where it
*actually* found impact. Reading `notes.impactDerivedMs` out of the cached
detections and comparing it with `truth.json`:

| offset handed in | median &#124;shift the detector applied&#124; | median &#124;error AFTER correction&#124; | median tries |
|---:|---:|---:|---:|
| -3000 ms | 2990 ms | **0.018 s** | 1 |
| -1000 ms | 1001 ms | **0.020 s** | 1 |
|  -250 ms |  254 ms | **0.017 s** | 3 |
|     0 ms |   19 ms | **0.019 s** | 1 |
|  +250 ms |  267 ms | **0.019 s** | 1 |
| +1000 ms | 1017 ms | **0.022 s** | 1 |
| +3000 ms | 3013 ms | **0.018 s** | 1 |

**Whatever impact it is handed anywhere in +-3 s, the detector relocates it to
within about 20 ms of the hand-confirmed truth, usually on the first try.** The
17-pass offset ladder is reached on only 2–7 of 26 clips at any offset.

So the "half a second wrong is total failure" finding — which was real, and is
what motivated the work — describes the detector as it was, not as it is. **The
impact is no longer the binding constraint. The 50% ceiling is.**

### The +3 s column is a TRIM-WINDOW failure, not a detection one

At +3000 ms, 13 of the 26 refusals are
`render_spec: animStartSec -0.517 / animDurationSec 1.624 out of range`, and that
reason appears **zero** times at every other offset. The detector still found the
impact to within 18 ms; the ladder still fitted a flight. What broke is that the
app trims a 4 s window around *its own* impact, so a +3 s error puts the shot
outside the clip the golfer is shown, and the arc has nowhere to be drawn.

*Observed: the collapse is entirely render_spec, and it is one-sided — nothing at
-3000. My reading of why it is one-sided (the window is 2.5 s before impact and
1.5 s after, so a late impact clips the flight's start while an early one does
not) is an inference from the window arithmetic, not something I measured.*

The practical consequence is separate from the detector: **however good the impact
scan is, the app still trims around swing-vision's number.** Feeding the
detector's corrected `impactDerivedMs` back into the trim would remove this
column. Nobody has done that, and this bench does not test it.

---

## How to run it

```bash
cd ~/projects/clippar/final_shipment/clippar_app/docs/tracer-v3/bench

./bench.sh                          # build + manifest + baseline + report
./bench.sh --mode truth             # the ceiling: at the confirmed true impact
./bench.sh --mode sweep             # hit rate vs impact error
./bench.sh --ids IMG_0323 IMG_0596_2
python3 report.py $BENCH_WORK/results-app.json --full   # per-clip table
python3 impacterr.py --full         # the app's impact vs truth, per clip
python3 selfcheck.py                # invariants; non-zero exit on failure
```

Stages, if you want one on its own: `build.sh` (compile the harnesses),
`manifest.py` (re-glob and stage the corpus — run this after Henry adds clips),
`impacts.py` (the app's own impact for every clip; slow), `sheets.py` (contact
sheets for classifying new clips), `truth.py` (impact candidates + confirmation
strips), `bench.py` (the run itself).

Everything lives under `$BENCH_WORK`, default `~/.cache/clippar-tracer-bench`,
**outside the repo** so a stray `git add` in this shared checkout cannot sweep up
a compiled Core ML model or 3.8 GB of hardlinks.

### The cache, and why it cannot go stale on you

Detector output is keyed by `(clip content hash, impact ms, tracerdet source
hash)`. A ladder-only change re-uses every detection and the whole corpus re-runs
in about a second of ladder time. Editing `TracerDetect.swift` or
`TracerDetectCore.swift` changes the source hash and invalidates every entry, so
you cannot accidentally measure a stale detector against new ladder code.

### Wall time, and a warning about sharing the machine

One clip through `tracerdet` alone takes ~3 s. It does **not** degrade gracefully:
the Core ML model runs on the ANE/GPU, a single shared resource, so past about
four concurrent processes throughput stops improving and per-clip latency goes
from 3 s to 60–800 s. The 121-clip baseline above took **3195 s wall at `--jobs 4`**
(detector median 64.7 s, max 817 s) with other agents running their own Swift
harnesses on the same machine; load average peaked at **49**.

**Use `--jobs 4`, and check `uptime` before blaming the bench.**

---

## How to read it honestly

**HIT RATE is over `full_swing` clips only.** Those are the clips where a golfer
expects an arc. Putts, chips and not-a-shot clips are not in that denominator —
counting a correct refusal as a miss would make the product rule look like a bug.

**FALSE DRAW is over `putt` + `not_a_shot`, and it must be 0.** It may skip, and
it may draw an arc with no distance, but it must never draw over something that is
not a golf shot. A nonzero false-draw number is a regression however good the hit
rate looks. The report prints the offenders by name.

**CHIPS count neither way.** A chip that refuses is acceptable; a chip that draws
is a bonus. Folding them in either direction would move the headline number
without anything having changed.

**`drew` means the ladder returned a spec** — not that an arc was rendered.

---

## The corpus

De-duplicated by **content** — `(size, sha256 of the first 1 MiB, sha256 of the
last 1 MiB)` — not by name, so it catches a re-download under a new name as well
as the obvious `IMG_0601 2.MOV`.

| corpus | clips | what it is |
|---|---:|---|
| `henry` | 65 | `~/Downloads/IMG_0*.MOV` — Henry's own clips |
| `lab` | 36 | `final_shipment/inputs` — the regression set (8 hand-labelled) |
| `unseen` | 20 | `jobs/*/inputs` that are NOT already in the lab set |
| **total** | **121** | 55 duplicate FILES collapsed |

**The "~84 clips nobody tuned on" is not 84.** 28 of the 50 clips under
`jobs/*/inputs` are **byte-identical** to clips in `final_shipment/inputs` — the
lab set the ladder was fitted against. The manifest gives the lab set priority in
the tie, so `unseen` means genuinely-not-lab: **20 clips, and 11 full swings.**

That matters here, because the unseen full-swing hit rate is **0/11**. On a
corpus of 84 "unseen" clips that would have been diluted by lab clips scoring
33%.

### Classification: 121 clips, viewed

Six evenly spaced frames per clip, read as contact sheets (`sheets.py`). Labels
live in `bench/classification.json` and are made from pixels, never from a
detector's output.

| class | clips | how the bench counts it |
|---|---:|---|
| `full_swing` | 51 | **the hit-rate denominator.** An arc is expected. |
| `chip` | 21 | neither credited nor charged |
| `putt` | 36 | **must refuse.** A refusal is CORRECT, not a miss. |
| `not_a_shot` | 13 | **must refuse.** Excluded from every rate. |

22 of the 121 labels are `low` confidence — six frames can miss a swing between
samples. The report names the low-confidence ones inside each hit rate rather
than absorbing them (4 of the 51 full swings: `IMG_3646`, `IMG_0552_2`,
`IMG_0591`, `IMG_7948`).

`not_a_shot` is not hypothetical: `IMG_0323` / `IMG_0324` are the camera on a
golf trolley, `IMG_8119` is someone standing in a flooded lie, `IMG_6151` is two
people walking across a green, `IMG_6148` is raking a bunker.

---

## The harnesses, and two traps found the hard way

`build.sh` compiles the checked-in module sources **copied, never edited**. The
only added file is `ExpoShim.swift`, a stand-in for the ExpoModulesCore pod whose
declaration shapes are copied from the real `node_modules/expo-modules-core`
sources — in particular `typealias Module = AnyModule & BaseModule`, which is what
lets a module write `public func definition()` with no `override`, and what
carries `@ModuleDefinitionBuilder` onto the subclass by witness inference. Get
that shape wrong and you end up editing the file you were trying to measure.

| harness | what it is | runtime |
|---|---|---|
| `tracerdet` | `TracerDetect` + `TracerDetectCore` — the shipped tracer ball detector | macOS |
| `svharness` | `SwingVisionModule.localizeSwing` — the app's **primary** impact | macOS |
| `sdharness` | `ShotDetectorModule.detectAndTrim` — the app's **fallback** impact | iOS Simulator |

`sdharness` is built for the simulator rather than macOS because
`ShotDetectorModule.swift` imports UIKit and calls `os_proc_available_memory()`.
Shimming those would put a stand-in on the detection path; building for the
simulator does not — the file compiles against the real iOS SDK with zero edits.

Sanity check on the whole rig: `tracerdet` on `IMG_3629.MOV` at impact 5610 ms
lands the address ball at **(487.5, 1310.8)** against a hand-labelled truth of
(487.3, 1310.4) — the number already on record.

### Trap 1 — the simulator cannot run MobileCLIP, and does not say so

`svharness` was also built for the iOS Simulator, to cross-check macOS against the
iOS runtime. **It does not work there and it fails silently.**

```
E5RT encountered an STL exception. msg = Espresso exception: "Invalid state":
MpsGraph backend validation on incompatible OS.
```

Every prototype score comes back **0**, so the localizer's pick degenerates to the
highest raw motion peak — and it still prints `decision=SWING` with a
plausible-looking `tImpact`. On `IMG_3629` that gave 5.417 s instead of 6.917 s: a
*better* number, arrived at by the model not running. **That target is removed
from `build.sh`.** swing-vision is measured on macOS, where the prototype scores
are real and non-zero.

### Trap 2 — the simulator cannot read `~/Downloads`, and hangs

`xcrun simctl spawn` on a clip under `~/Downloads` **hangs forever** — macOS TCC
blocks the simulator process, and it does not error, it blocks at 0% CPU. A
parallel run just stops, with nothing in any log. Measured: the same clip
hardlinked into `$BENCH_WORK/clips/` finishes in 4.2 s; from `~/Downloads` it was
still hung at 90 s. The macOS-native harnesses are unaffected.

So `manifest.py` **stages every clip as a hardlink** into `$BENCH_WORK/clips/`
(zero disk, zero time — 3.8 GB of clips, 121 links) and every harness reads the
staged path. It also gets the space out of `IMG_0601 2.MOV`.

---

## Establishing a TRUE impact

Two stages, and the second is what makes it truth rather than a guess.

1. **Candidates from audio** (`truth.py --candidates`). The strike is a sharp
   broadband transient; the top three onsets per clip are kept. For the 36 lab
   clips the lab's own `impact_sounds.csv` is added as a further candidate, so
   the two methods disagree visibly instead of silently.
2. **Confirmation by eye** (`truth.py --strips`). Five frames per candidate at
   t-0.30, t-0.10, t, t+0.13, t+0.30 s. At a real strike the club is at the ball
   at `t` and the golfer is into the follow-through 0.13 s later.

Stage 2 is not a formality. **On `IMG_3622` the loudest transient (7.51 s) is a
waggle — every frame around it is still address. The strike is the second
candidate, 9.18 s, 1.67 s later.** The same is true of `IMG_0545`, `IMG_0598_2`
and `IMG_3640`. An audio-only "truth" would have been more than a second wrong on
four of the 26, and the sweep built on it would have read as a detector problem.

**26 of the 51 full-swing clips have a confirmed impact** (lab 13, henry 10,
unseen 3). The other 25 had no candidate the frames supported and are left out —
`truth.json` holds only what was looked at. The confirmed times are good to about
±0.05 s at 30 fps, which is fine against a sweep whose finest step is 0.25 s and
would not be fine for anything finer.

---

## What this bench does NOT measure

Stated plainly, because a bench that hides its own gaps is worse than no bench.

1. **Nothing here runs on a phone.** Shipped code, this Mac's silicon.
2. **The renderer is never called.** `drew` is a ladder verdict, not a picture.
   Arc geometry, horizon, and start-at-the-ball are a different bench's job.
3. **The impact-error sweep hands the ladder the correct shot type.** In `--mode
   sweep` the classifier is given the human label so the curve isolates impact
   error alone; the app's own classification is measured in `--mode app`.
4. **22 of the 121 class labels are low-confidence** and are named, not hidden.
5. **The 26 true impacts are a favourable subset** (see above).
6. **The `unseen` corpus is 11 full swings.** 0/11 is a real zero, but it is a
   zero out of eleven, and a single clip is worth 9 points.

---

## For the tuning agent

Work the ranked table down and re-run `./bench.sh` after each change — with the
detector untouched it costs seconds, because only `ladder.ts` re-runs.

1. **Check FALSE DRAW before HIT RATE.** It is 2/49 today and it should be 0. A
   change that lifts the hit rate and puts one more arc on a putt is a regression.
2. **`--mode truth` is your ceiling — 13/26.** If a change does not move that
   number it has not fixed a detection or fitting problem.
   **Do not spend more time on impact accuracy without re-reading the sweep.**
   From -3 s to +2 s the hit rate is flat, because the impact scan already
   recovers the instant to within 20 ms. The remaining impact-shaped failure is
   the *trim window* at +3 s, which is a different fix in a different file.
3. **`detector_found_no_address_ball` is doing most of the refusing.** 42 of the 62
   clips it rejects are putts, chips or not-a-shot. Loosening it without watching
   FALSE DRAW converts correct refusals into arcs over putts.
4. **Never re-label a clip to make a number move.** `classification.json` is the
   only part of this bench not reproducible from code, so it is the only part that
   can be quietly bent. If a label is wrong, say so and re-view the sheet.

---

## The files

| file | what it does |
|---|---|
| `bench.sh` | the one command: build + manifest + run + report |
| `build.sh` | compiles `tracerdet`, `svharness`, `sdharness` from checked-in source |
| `ExpoShim.swift` | the ExpoModulesCore stand-in — read its header before trusting it |
| `mainTracerDet.swift` | CLI around `TracerDetect.detect` |
| `mainSwingVision.swift` | CLI around the registered `localizeSwing` |
| `mainShotDetector.swift` | CLI around the registered `detectAndTrim` (iOS sim) |
| `manifest.py` | globs, content-de-duplicates, probes and hardlink-stages the corpus |
| `sheets.py` | contact sheets, six frames per clip, for classification |
| `classification.json` | the human labels — made from pixels, never from a detector |
| `impacts.py` | the app's own impact for every clip, by the app's own rule |
| `truth.py` / `truth.json` | audio candidates, confirmation strips, confirmed impacts |
| `bench.py` | detector -> ladder over the corpus, cached and parallel |
| `ladder.ts` | the real `traceClip`, whole batch in one node process |
| `report.py` | the table |
| `impacterr.py` | the app's impact vs truth |
| `selfcheck.py` | invariants over the bench's own data |
| `e2e.sh`, `run.sh`, `impact.py` | earlier one-clip helpers, superseded, marked as such |

`selfcheck.py` is the thing to run when you come back to this cold: it catches new
clips arriving unclassified, ids colliding, truth entries pointing at clips that
are gone, hardlinks replaced by stale copies, and results files measured with a
detector that has since changed.

---

## Provenance, and the thing `selfcheck.py` caught

Every results file records the detector source hash it was measured with, and
`selfcheck.py` compares it against the current one. **That check earned its keep
on its first run.**

The first full baseline was measured between 23:45 and 00:38 against detector
source hash `caa986ca545c`. At **00:21**, mid-run, another agent edited both
`TracerDetect.swift` and `TracerDetectCore.swift`. The measurement itself was not
corrupted — `bench.py` invokes a binary that was already built, so the whole run
used one detector — but the next `build.sh` rebuilt it and every stored result
became a measurement of a superseded version. `selfcheck.py` said so in two lines
rather than letting the numbers quietly rot into a different detector's.

The old-hash run is kept at `$BENCH_WORK/archive/results-*-caa986ca545c.json`.
All numbers in this document are from the re-run at hash `2ca30f5e58e2` unless a
line says otherwise.

**When you come back to this, run `selfcheck.py` first.** If it says the results
were measured with a different detector, they were, and `./bench.sh` is the fix.

---

## Verify status at the end of this session

```
npx tsc --noEmit           clean
node --test tests/*.test.ts  886 tests, 0 fail, 0 skipped, 0 todo
```

**No tests were added.** This agent owns `docs/tracer-v3/bench/` and nothing in
`lib/` or `modules/`, and the only thing it could have unit-tested is its own
bench. `selfcheck.py` is that instead: it asserts the bench's own invariants and
exits non-zero, and it is the thing that caught the detector changing underneath
a completed measurement. The test count moved 872 -> 886 during the session
because other agents added tests, not this one.
