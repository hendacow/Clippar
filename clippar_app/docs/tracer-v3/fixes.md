# fixes — the adversarial review's findings, applied

**Agent:** `fix`, 6 Sep 2026. **Branch:** `feat/tracer-v3`.
**Input:** `docs/tracer-v3/review.md` (the `skeptic` agent's findings), read in full, plus
`integrate.md` and `verify.md`. Reference for every algorithm: `~/projects/clippar/tracer-lab`.

**Gate:** `npm run verify` — **tsc clean, 830 tests, 0 failures.** It arrived at 799.
**+31 tests, none deleted, none weakened, none skipped or `todo`.** One existing test was
rewritten to assert the corrected contract and gained four assertions doing it (see F1).

I ran no `git` command and no `npm install`.

---

## What "reproduced" means here

Every HIGH and MED finding below was reproduced against the code as it stood, then fixed, then the
reproduction was committed as a test. To make that claim checkable rather than asserted, after
writing the tests I **temporarily reverted each fix in place** (byte copies taken first,
SHA-256 verified identical on restore — `49e2566c…e5fc` for `lib/tracerFit.ts`,
`db05d6c4…4788` for `lib/tracerV3.ts`) and re-ran the new suite against the pre-fix behaviour:

```
ℹ tests 26   ℹ pass 16   ℹ fail 10
✖ F1: a 40 m GPS carry against a 200 m pixel track is thrown away, not folded in
✖ F1: a carry_inconsistent raised by ANY ladder rung survives into the decision
✖ F3a: a clip shot at 1.5x zoom is refused rather than drawn at the wrong scale
✖ F3a: the 0.5x lens, an unknown lens and a missing capture block are all refused
✖ F3a: the lens refusal is an absence of input, so forceTrace cannot bypass it
✖ F2: a first detection three frames late still fits, instead of skipping
✖ F4: a shot down the camera axis is flagged and loses its distance
✖ F5: a pixel-only fallback never claims GPS backing
✖ F8: a legitimate short shot does not carry landing_depression_off
✖ every refusal carries the diagnostic blob a field test is read from
```

The 16 that passed either way are the controls — the absence-of-evidence refusals, and the
"and this must still work" cases (an agreeing GPS carry is still used; a 1× clip still draws;
one degree of azimuth still keeps its label). **A fix that made everything skip would have failed
those.**

---

## F1 — HIGH, blocking · a wrong GPS distance laundered into a confident label

**Reproduced.** `traceClip` on the 12-detection driver fixture with a 40 m GPS carry:

```
before   dec=fit    carry=208.9  apex=34.9  status=carry_untested  z=null
         LABEL "210 m" / "apex 35 m"            <- no "· no GPS"
after    dec=pixel_only_fallback  carry=204    LABEL "210 m" / "apex 35 m · no GPS"
         meta.reason = carry_inconsistent(z=…)
```

Two defects, both fixed at the root.

**(a) `lib/tracerFit.ts` — the consistency test refused to run.** When the pixel-only companion's
Monte-Carlo carry sigma came back non-finite — which is exactly what `fixSpin` produces, because the
covariance goes singular — the port set `carry_untested` **and used the carry anyway**. The comment
above it claimed this was "the one place this port is deliberately more conservative than fit.py".
It is the opposite, and that sentence is what hid the bug: substituting `sc = 0` costs only the
**permissive** `carry_as_scale` rung (with `sc = 0`, `rel = 0` can never exceed `AS_SCALE_FRAC`) and
keeps the **protective** `carry_inconsistent` one. Refusing to test throws the protection away and
keeps nothing.

Now, exactly as `tracer-lab/lib/fit.py:889` (`sc = float(sc) if np.isfinite(sc) else 0.0`): `sc = 0`,
`z` computed anyway, and `carry_untested(no_usable_pixel_only_carry_sigma)` kept as an **additional
flag**, never as a replacement for the verdict. The only remaining `carry_untested` **status** is
when there is no pixel-only companion at all — flagged `carry_untested(no_pixel_only_carry)` so the
two cases are distinguishable in `tracer_meta`. The false comment is deleted and replaced with the
finding.

**(b) `lib/tracerV3.ts` — the verdict was read off the wrong fit.** `traceClip` read `fit.flags` —
whichever rung the ladder *ended* on — so the spin-bound refit silently overwrote the primary's
opinion. It now takes the union of the drawn fit's `carry_inconsistent` flags and **every rung's** in
`meta.ladder`, including rungs that were not accepted: a disagreement between the GPS and the pixels
is a statement about the data, not about which rung noticed it. Cost of the conservative reading is
a pixel-only render, which is the safe half of the trade.

**Tests:** `tests/tracerV3Refusals.test.ts` §3 (three tests, incl. the "an agreeing carry is still
used" control) and the rewritten `tests/tracerFit.test.ts` fit-level test.

## F2 — HIGH · the missing impact slack turned good clips into skips

**Reproduced.** Dropping the first *N* detections of a perfect 202 m flight, `launchFrame` still
correct:

| dropped | before | after |
|---|---|---|
| 0 | drawn, carry 202.5, rms 0.02 | drawn, carry 202.5, rms 0.02 |
| 1 | **SKIP** `track_not_ballistic` rms 16.0 | drawn, carry 202.9, rms 0.02 |
| 2 | **SKIP** `track_not_ballistic` rms 45.5 | drawn, carry 203.5, rms 0.02 |
| 3 | **SKIP** `implausible_flight` apex 52.7 | drawn, carry 204.0, rms 0.02 |
| 4 | **SKIP** `track_not_ballistic` rms 104.9 | drawn, carry 203.8, rms 0.02 |
| 6 | SKIP `track_not_ballistic` rms 154.4 | SKIP `poor_fit` rms 4.3 — 10 frames, all late |

Every "before" skip carried `t0_at_lower_bound`: the optimiser saying it was pinned where it should
not have been.

- `FitOptions.impactSlackFrames?: number` added (the port's name for the lab's `FitLaunchArgs`).
  `tLo = (impactFrame - slack) / fps`; **`tHi` unchanged**, so the "first track frame is not after
  impactFrame" guard is untouched and the slack can never put the launch after the ball was seen.
- The seed also moved to the lab's `0.5 * (impactFrame/fps + tHi)` (`fit.py:688`) rather than the
  midpoint of the widened interval — identical while the slack is 0, and the widened midpoint would
  start the optimiser further from the launch the more doubtful the impact frame is.
- `selectDetections` computes the lab's slack (`tracer.py:248-252`): the departure cue
  (`launchFrame`) clamped to the first detection, plus one extra frame when there is no cue and the
  audio impact frame is the fallback. Recorded on `meta.selection.impactSlackFrames`.

**Tests:** three, including that the slack never lets `t0` land after the first detection.

## F3a — HIGH · lens and zoom silently rescaled every distance

**Reproduced, and it is worse than a threshold miss.** Detections generated through a camera at
1.5 × the focal length the app supplies (i.e. a 1.5× pinch), on a 202 m drive:

```
row claims 1x / zoom 0  ->  DRAWN, carry 131.3 m, LABEL "130 m"   (truth 202 m)
row records zoom 0.35   ->  SKIP  lens_unsupported
```

The review measured "140 m" on its own fixture; same failure, different geometry.

Four pieces:

1. **`lib/storage.ts`** — `capture_lens TEXT` and `capture_zoom REAL`, appended to the existing
   additive, idempotent `migrateEditorColumns` list, and bound on `saveLocalClip`'s INSERT.
2. **`app/(tabs)/record.tsx`** — `getCaptureOptics()` returns `{ lens: zoomMode, zoom: peak }`.
   **The PEAK zoom over the recording, not the value at the stop press**: the lens toggle is inert
   mid-clip but the pinch deliberately is not, so a zoom applied and released still rescaled the
   frames the detector reads. The peak is seeded from the standing pinch on the rising edge of
   `isRecording`, so a pinch applied and released *between* clips cannot make the next one look
   zoomed.
3. **`hooks/useCamera.ts`** — reads it once at save and writes both columns. **Not gated on
   `config.tracer`**, deliberately: a clip saved without them is one the ladder must refuse forever,
   so withholding them behind the flag would poison every clip recorded before it was flipped.
4. **`lib/tracerV3.ts`** — `TraceClipInput.capture`, and a `lens_unsupported` refusal for anything
   that is not `1x` with `|zoom| <= 1e-3`. It sits with the **absences of input**, so `forceTrace`
   does not bypass it — a wrong world scale is not a judgement about a shot, it is not knowing how
   big the world is.

**Omitting the field is a refusal, not a default.** `capture` is optional in the type (an additive
API change) and `undefined` skips. That is the whole point: "unknown lens" and "1×" are the same
input to every calculation downstream and only one of them is safe. `hooks/useEditorState.ts` always
passes the row's values, nulls included.

**Consequence, stated plainly:** every clip recorded before this change, and every imported clip,
now skips with `lens_unsupported`. That is correct and it is the intended cost.

**Tests:** four in the refusals file (including the "if the row lies, it still draws wrong" half, so
the test is evidence rather than decoration), plus three source-text pins in `tracerV3Wiring`.

## F4 — MED-HIGH · a shot down the camera axis

**Reproduced.** Same launch, azimuth swept, 14 detections (truth: carry 202 m, apex 24.2 m):

```
phi=0     carry 211.3  apex 35.5  rms 0.64   LABEL "210 m / apex 35 m"   <- 47 % apex error
phi>=0.5  carry 203.0  apex 24.6  rms 0.03   LABEL "200 m / apex 25 m"
```

**The reviewer's suggested test does not discriminate, and I am saying so rather than shipping it.**
"A large formal sigma on `v0`" is true of the *primary* fit at φ = 0 (σ(v0)/v0 = **21 %**, against
2–3 % at every other azimuth) — but the primary fit is not the one that gets drawn. It hits
`rpm_back_at_lower_bound`, the ladder's spin-bound rescue rung fires, and **that** fit is tight
(σ(v0)/v0 = 0.8 %) and confident and 47 % wrong. Reading the drawn fit's sigma sees nothing.

So the flag is keyed on the drawn fit's azimuth **and the worst conditioning any rung of its ladder
reported** (`LadderRun.worstV0RelSigma`), which is a property of the clip's geometry rather than of
which rung happened to win. Threshold 10 %, sitting in an order-of-magnitude-wide gap.

**The label drops the distance rather than widening the step, and here is why.** The rounding step
comes from the fit's own `sigmaTotal.carryM`, and the fit's sigma is *small* here while the error is
large — so no step this fit can compute describes the error, and a 10 m step still reads as a
measurement. The apex is the worse of the two (35 vs 24 m) and rounding never touched it at all. The
pill reads **"down the line" / "no distance"**. The arc is still drawn.

**Known gap, written down rather than hidden:** a track short enough that the ladder never runs a
full-freedom rung (`fixSpin` from the start, K < 5) has no ill-conditioned rung to notice, so this
cannot fire for it. Those are the fits the plausibility cap judges hardest, and that is all that
stands in for it there. Stated in the code comment too.

## F5 — one line · `pixel_only_fallback` claimed GPS backing

`buildLabel`'s `hasGps` meant "a carry was supplied", not "a carry was used", so a clip whose GPS had
been tested and **rejected** dropped the "· no GPS" marker — the one thing that marker exists to say.
Now `carryM !== null && decision !== 'pixel_only_fallback' && no joint_fit_rejected flag`.
Two tests; the second pins that a clip with no carry at all still says it.

## F6 — the debug bypass persisted and silently re-armed

`forceTrace` was written to the SQLite settings table and rehydrated into `config.tracer` on **every
mount** of the diagnostics screen — which is the one screen a golfer opens mid-round to ask "why did
that skip?". A street test three days earlier re-armed itself.

Now **session-only**: no settings key, nothing written, nothing rehydrated. It boots off from
`constants/config.ts` and only a deliberate tap turns it on. The header comment that claimed "a crash
mid-round cannot leave a bypass on" is replaced with what was actually true — the way it came back on
was not a crash, it was opening the screen. The card's subtitle now says "Session only". The orphan
`tracer_v3_force_trace` row a previous build may have written is never read again; it is left in
place rather than deleted, because a settings *write* on mount is a side effect this screen should
not have. The two v1 bypasses are untouched — the finding was about the V3 one.

## F8 — `landing_depression_off` fired on every legitimate short shot

**Reproduced.** A genuine ~12 m chip from a ball teed 4 m in front of the camera:

```
before   depression 142.7 px@1080  vs  flat expectation 190.7 px   -> landing_depression_off
after    depression 142.7 px@1080  vs  RANGE expectation 142.1 px  -> residual 0.6 px, clean
```

The port kept only the lab's `expected_flat_px` (`f·h/carry`, which assumes the ball was hit from
directly under the lens) and dropped `expected_range_px` (`f·h/R`, using the landing's real ground
range) **along with the lab's own docstring saying the two differ by tens of px on a 10 m chip and by
well under a px on a 250 m drive**. So the flag survived and the sentence telling you to ignore it
did not.

`flightPixels` now reports `groundRangeM` per sample (the lab's `R = hypot(P_land[0], P_land[1])`);
`buildSpec` carries the range of the sample the renderer actually draws as the landing;
`landingHorizonCheck` takes it and **keys the flag off the range residual**. Both expectations and
the residual are on `meta.landingCheck` — the flat one kept because it is what the lab's own reports
print. Two tests: the chip must be clean *and* the two expectations must differ by more than the
flag's own threshold (otherwise the test would pass for the wrong reason); the driver must be
unchanged.

---

## The probes, restored as permanent tests

`tests/tracerV3Refusals.test.ts` — **26 tests**. The `skeptic` agent wrote nine probe files, ran
them, and deleted them. That is backwards: a finding gets fixed once, a probe stops it coming back.

Absence of evidence (must never draw, and `forceTrace` must not reach them): `found: false`, a null
address, 0 detections, 1–2 detections with no carry, a missing camera pitch, an unknown lens.
Not-a-golf-shot: a cap-like near-static blob (with **and without** a GPS carry — a distance is a
scale, not evidence that anything flew), a topped ball, a rolling putt the classifier called a
*swing*, a divot, a tossed ball. Then one reproduction per finding, and the invariant that every
refusal carries the diagnostic blob a field test is read from.

**Two places where I refused to write a test that would have read better than it is true:**

- **The divot and the tossed ball skip because the ladder cannot fit 30 frames of them, not because
  anything recognised a divot.** Give it the first 10 frames of the same object and it draws. That
  is review F14, which is recorded and accepted — the discrimination lives upstream in the Swift
  address anchoring, the pose veto and the confidence floor. So the test asserts the *reason* for
  each skip, and says all of this in the comment above it.
- **One and two detections with a carry still draw** (review F7 — faithful to the lab, and
  unreachable in the app because the Swift detector will not emit a track shorter than
  `minTrackEmit = 3`). Fixing that was explicitly out of scope. Rather than pretend, the test pins
  both halves of what actually protects it: the config that keeps it unreachable, and the
  `prior` / `few_frames:K` / `underdetermined` flags that make it unmistakable in `tracer_meta` if a
  future caller ever supplies detections from somewhere else.

Five more tests in `tests/tracerV3Wiring.test.ts` pin the new seams in source: the two columns, the
capture path writing the peak zoom ungated, the batch always passing the optics, the runtime refusal
for `undefined`, and the absence of any settings key for the bypass.

---

## Honesty corrections

| Where | Was | Now |
|---|---|---|
| `lib/tracerFit.ts` (carry consistency) | "the one place this port is deliberately more conservative than fit.py" | Deleted. Replaced with F1 and the direction it actually pointed. |
| `lib/tracerV3.ts` `selectDetections` | `impact_slack_frames` "would be dead" | Replaced with what dropping it cost, and the slack is now computed. |
| `lib/tracerV3.ts` `DEPRESSION_OFF_*` | flags off the flat-ground expectation | Says which expectation and why (F8). |
| `app/profile/tracer-dev-settings.tsx:16` | "a crash mid-round cannot leave a bypass on" | True as written, misleading in context — replaced with the real mechanism (opening the screen) and the fix. |
| `constants/config.ts` revert comment | "byte-identical to today … no UI" | "no UI **reachable by tapping**", plus the honest list: the route survives (F9), the schema migration survives (F10), and `saveLocalClip` binds the columns to NULL. |
| `TRACER_V3_PLAN.md` "Honest limits" | reads as though `AVCaptureDevice` intrinsics were implemented | States that **nothing reads them**, that every call site passes `fPxSource: 'fov-metadata'`, and that the lens/zoom error is a factor of two rather than a percentage. The axis-degenerate bullet no longer says a capture tip is the mitigation. |
| `TRACER_V3_PLAN.md` | — | New **"Not done"** section: intrinsics delivery, the in-source touchdown search, and "nothing here has run on a device". |
| `docs/tracer-v3/integrate.md` | §4 deviation 4, the refusal list, the `tracer_meta` schema, §8 risk 2 | New §9 corrections table, appended rather than edited in place so the record of what was believed at the time survives. |

**Deleted:** `docs/tracer-v3/tracer-detect-core-check.swift` (37 KB) and
`tracer-detect-core-params.py` — an agent's verification scratch, outside the podspec's source glob
and outside `tsconfig`, reaching no build.

---

## Not attempted, on instruction

- **`AVCaptureDevice` intrinsics delivery.** Needs a device to verify. It is the next work item and
  it is now on the plan's "not done" list. Until it lands, `lens_unsupported` is what stands in for
  it.
- **The in-source touchdown search** (`find_seen_landing`).
- Everything else the review lists as "accept and write down" — F7, F9, F10, F11, F12, F13, F14 —
  which is what the honesty corrections and the two test comments above are for.

## What I could not verify

- **Nothing here has run on a device and no frame has been rendered.** No Swift was compiled; the
  new columns have never been written by a real `saveLocalClip` on a phone; `getCaptureOptics` has
  never been called by a real recording. The peak-zoom logic in `app/(tabs)/record.tsx` is pinned by
  a source-text test and by reading, **not by a pinch on a device**, and the record screen is the one
  screen that must never regress.
- **The `capture_zoom` value is expo-camera's normalized 0..1 pinch, not an optical factor.** The
  refusal only asks whether it is zero, so that is enough for the gate — but nothing here converts a
  non-zero zoom into a focal length, and nothing should until intrinsics land.
- **F4's threshold is calibrated on one synthetic fixture.** The 21 %-vs-2 % gap is wide, but it is
  one clip's geometry. The first field test should check whether `axis_degenerate` fires on anything
  it should not.
- **The F1 fix changes which fit gets drawn on a disagreeing GPS carry** (now the pixel-only
  companion). On the fixture that companion carries the spin-bound rung's bias: carry 210 m against
  a 202 m truth, ~4 % high. Honest provenance, still not a measurement — and the "· no GPS" marker
  now says so.

---

# fixes, round 2 — the re-verify gate's three findings, applied

**Agent:** `fix2`, 6 Sep 2026. **Branch:** `feat/tracer-v3`.
**Input:** `docs/tracer-v3/re-verify.md` (read in full), then `fixes.md` and `review.md`.
Reference for every algorithm: `~/projects/clippar/tracer-lab`, read directly.

**Gate:** `npm run verify` — **tsc clean, 838 tests, 0 failures, 0 skipped, 0 todo, exit 0.**
It arrived at 830. **+8 tests, none deleted, weakened, skipped or parked.** Run twice.

I ran no `git` command and no `npm install`.

| file | +tests |
|---|---|
| `tests/tracerFit.test.ts` | 26 → 28 |
| `tests/tracerV3Refusals.test.ts` | 26 → 30 |
| `tests/tracerV3Wiring.test.ts` | 30 → 32 |

New fixture: `tests/fixtures/tracerV3ShortTrack.ts` — 4K portrait at 30 fps, the gate
agent's own geometry. It exists because **NEW-1 cannot be reproduced on
`tests/fixtures/tracerV3Clip.ts`**, and one of the new tests asserts exactly that, so a
future reader does not "simplify" the two fixtures into one and quietly delete the
reproduction.

---

## NEW-1 — HIGH, blocking · `carry_as_scale` accepted a wildly wrong GPS carry

**Reproduced, on the gate agent's geometry, before touching anything.** An 8-frame driver,
truth 251.1 m, pixel-only 257.1 m:

```
gps=  5  dec=fit  status=carry_as_scale  z=2.06  drawn=169.1  LABEL "170 m" / "apex 15 m"   -33 %
gps= 10  dec=fit  status=carry_as_scale  z=2.00  drawn=169.7  LABEL "170 m" / "apex 15 m"   -32 %
gps= 20  dec=fit  status=carry_as_scale  z=1.88  drawn=173.3  LABEL "170 m" / "apex 15 m"   -31 %
gps= 40  dec=fit  status=carry_as_scale  z=1.64  drawn=182.8  LABEL "180 m" / "apex 16 m"   -27 %
gps= 80  dec=fit  status=carry_as_scale  z=1.16  drawn=202.9  LABEL "200 m" / "apex 20 m"   -19 %
```

No `· no GPS`, because the GPS *was* used. That is the review's own sentence: a wrong
distance stated confidently with the honesty marker removed.

**The first thing the reproduction showed, and it changes the fix.** Every one of those
z-scores is **under 2**, let alone the 4-sigma inconsistency bar. So the brief's part (a)
as literally worded — raise `carry_inconsistent` when `|z| > Z_INCONSISTENT` even if the
as-scale condition holds — **would not have caught a single row above.** The reason is the
mechanism itself: `sc`, the pixel-only carry sigma, sits in the z-score's own denominator,
and `carry_as_scale` is *defined* as `sc > 15 %` of the carry. It was 49 % here. A
denominator that large divides any disagreement away. **The test is circular: the looser
the pixels, the more agreeable every GPS reading looks.**

### (a) `lib/tracerFit.ts` — the protective verdict is tested first, on both z-scores

Two changes, and the second is the load-bearing one:

1. **Order reversed.** `carry_inconsistent` is now tested *before* `carry_as_scale`, so a
   genuinely large `z` can never be pre-empted. This is what the brief asked for and it is
   correct; on the reproduction it fires on nothing.
2. **A second z-score, `carryZNoPixelSigma`,** computed with `sc` dropped from the
   denominator — `sqrt(sigmaTest² + sigPxSys²)` — and tested against the same 4-sigma bar
   whenever the as-scale condition holds. It asks: does the GPS distance land where the
   pixel *geometry* puts it, allowing for the ±12 % focal-length prior but not for this
   fit's own looseness?

**Why (2) is not an invention.** It is the F1(a) principle applied to the second unusable
sigma. F1(a) established that when the pixel-only carry sigma is **non-finite** the answer
is to substitute 0 and run the test, never to skip it (`fit.py:889`). `carry_as_scale` is
the same situation wearing a different costume — the sigma is not missing, it is merely
enormous — and the port was skipping the protective test for it. Same disease, same cure.

**This is a deliberate deviation from the lab and it is stated in the code comment.**
`tracer-lab/lib/fit.py:907-920` tests `carry_as_scale` first; `tracer-lab/lib/tracer.py:837`
does nothing with the verdict but append a flag. I read both directly rather than trusting
the gate report. **The lab is not the authority here** — this is a faithful port of a lab
design gap, and the lab renders research clips for a human reading a CSV while this renders
a number to a golfer. Henry's rule outranks fidelity.

**Bounded, and the bound is tested.** The lab's own calibration says `carry_inconsistent`
is for roughly a 55 % error at the metadata f_px prior, and that band is preserved: on the
real clip `IMG_3649` at K=5 (pixel carry 224 m ± 16 %), a **−30 %** reading is still
`carry_as_scale`, a **−50 %** one is now `carry_inconsistent`. At −50 % the lab's own z is
**2.5** — inside the bar — and the pixel-sigma-free z is **4.1**. That single pair of
numbers is the whole finding, and there is a test asserting both halves so the test cannot
pass for the wrong reason.

### (b) `lib/tracerV3.ts` — an as-scale distance is no longer stated as a measurement

`carry_as_scale` was pushed as a flag and otherwise ignored, so the pill read exactly like a
measured distance: same rounding step, and no `· no GPS`, because the GPS genuinely had
been used.

**What the label's sigma should be.** Under this verdict nothing has checked the GPS
reading, and the reading's real failure modes — the golfer laid up, the successor fix landed
on the cart path, the phone was in the bag — are in **no sigma the fit computes**. So the
label's sigma is the widest of the three things the number rides on: the fit's own
`sigmaTotal.carryM`, the GPS distance's own `sigma_D`, and the pixel-only carry sigma, which
under this verdict is ≥ 15 % of the carry by construction and was **34–69 %** on 8–10 frame
tracks.

**Then the brief's own rule, implemented literally:** widen `labelStepM` to that sigma; if
it exceeds the coarsest step the vocabulary contains (10 m), no rounding describes the error
and the **distance is dropped the way F4 drops it**. The pill reads **"no distance" /
"GPS unchecked"**, the arc is still drawn, and `carry_as_scale_no_distance(honest_sigma=…)`
goes on the row. On a genuinely short shot, where 15 % is a few metres, the step simply
widens and the number survives — so this is a rule, not a special case.

**Why dropped rather than widened, in one line:** F4's argument transfers exactly — the
fit's own sigma was 22–32 m while the error was 48–82 m, so no step this fit can compute
describes it, and a 10 m step still reads as a measurement.

### After

```
gps=5..80   dec=none               SKIP  (carry_inconsistent -> the pixel-only companion
                                          of the spin-fixed rung fails track_not_ballistic)
gps=130     dec=fit  as_scale      "no distance" / "GPS unchecked"     (was "220 m", -11 %)
gps=257     dec=fit  as_scale      "no distance" / "GPS unchecked"     (agreeing, but unverifiable)
```

Swept 80 clips (2 frame counts × 2 spins × 2 speeds × 2 launch angles × 5 nonsense GPS
carries of 5–80 m against 200–260 m truths): **10 skip, 70 drawn pixel-only and marked
`· no GPS`, 0 GPS-backed numbers, and not one drawn number more than 25 % from truth.**

### What this costs, measured rather than asserted

The happy path is intact. With a **correct** GPS carry (truth ±5 %), across 12 clips × 3
readings on each fixture:

| fixture | GPS-backed number | "no distance" | skip | any number >15 % out |
|---|---|---|---|---|
| 1080p60 (tight) | **36 / 36** | 0 | 0 | **0** |
| 4K30 (short, loose) | **33 / 36** | 3 | 0 | **0** |

So the price is roughly **one short-track clip in twelve losing its number when the GPS was
right**, in exchange for none of them ever stating a wrong one. That is the trade Henry's
rule asks for, and it is the direction the review said the trade should go.

**Two consequences I am not hiding.**

- **Some clips that used to draw now skip entirely.** On the 8-frame fixture a rejected GPS
  carry sends the ladder to the drawn rung's pixel-only *companion*, and on a spin-fixed
  rung that companion is a poor fit (rms 23 px) which the physics gate then refuses — even
  though a standalone pixel-only run of the same detections draws 257 m against a 251 m
  truth. This is the re-verify agent's own §2a observation (`pixel_only_fallback` renders
  the companion, not a clean pixel-only measurement) and it is **pre-existing**, not new:
  the branch chose `pixelOnly ?? fit` before this round. My change makes it fire more often.
  A better fallback would pick the best pixel-only fit across the whole ladder. **Not
  attempted — out of scope, and it is a behaviour change to the drawn arc.** Filed here.
- **`carry_untested` is untouched.** The one remaining path to that status (no pixel-only
  companion at all) still labels as GPS-backed. It is the same shape as NEW-1 and I did not
  fix it, because it was not in the brief and I could not construct an input that reaches
  it. Named so the next gate does not have to find it twice.

**Tests (4 product-level + 2 fit-level), and each was run against the pre-fix code.** I
reconstructed the pre-fix `lib/tracerFit.ts` and `lib/tracerV3.ts`, checked by `diff` that
each differs from the file I started this session with by **my changes and nothing else**,
re-ran, and confirmed the reproduction fails and the controls pass either way. The
reconstructed `tracerFit.ts` hashes to `49e2566c…`, the prefix round 1 recorded for it.
(`tracerV3.ts` does **not** match round 1's `db05d6c4…`, so that file was edited after
round 1 took its copy — by whom I do not know, and it is not something I can settle from
here.)

```
✖ NEW-1: a 5-80 m GPS carry ... never draws a confident distance
     -> stated "170 m" for a 251 m shot (30 % out)
✖ NEW-1(b): a loose-but-agreeing pixel carry ... the arc is still drawn
✔ NEW-1: this fixture reaches carry_as_scale at all — the 1080p60 one never does
✔ NEW-1: the fix did not turn the GPS off — an agreeing carry on a TIGHT track ...
✖ GATE NEW-1(a): a loose pixel carry no longer PRE-EMPTS the inconsistency test
✔ GATE NEW-1(a): the deviation is bounded — a 30 % error is still the as-scale case
```

---

## NEW-2 — MED-HIGH · the recorded zoom could be zeroed by one tap after the stop press

**Reproduced from source** (see "what I could not verify" below — nothing was pressed on a
phone). All four gates were on `camera.isRecording`, which `stopRecording` clears on its
first line, so the 0.5x/1x pill and the flip button stayed live through the 5–10 s finalize
window; both call `resetPinchZoom()`, which sets `captureZoomPeak.current = 0`; and the
save read `getCaptureOptics()` live from that same ref. And the consequence, on a clip
actually shot at 1.5× whose row claims 1x / zoom 0:

```
row honest (zoom 0.35) -> SKIP  lens_unsupported
row LIES   (zoom 0)    -> fit  "160 m" / "apex 34 m · no GPS"   truth 223.6 m   -28 %
```

**Both fixes, because they close different holes.**

1. **The snapshot, which is the real fix.** `hooks/useCamera.ts` now takes the optics at the
   **stop press** — the first statement of `stopRecording`, before the eager state flip,
   before the haptic, before anything that can yield — into `capturedOpticsRef`, and the
   save consumes it. `stopRecording` is deliberately dependency-free so it is never
   recreated mid-clip, so the reader is mirrored into `getCaptureOpticsRef` the same way
   `practice` already is. **A saved clip's provenance is now immutable**, which is the
   property that was actually missing: it was not that the controls were reachable, it was
   that a clip already recorded could be rewritten. The snapshot is cleared at
   `startRecording` too, so a stop that never reached a save cannot hand its framing to the
   next clip, and the live read survives as a fallback for a recording that ends without
   passing through `stopRecording` — which is exactly today's behaviour on that path.
2. **The guard, because it is the house pattern.** `disabled={recordingBusy}` on both
   Pressables and `if (recordingBusy) return;` in both callbacks — the pattern
   `tests/trainingMode.test.ts:41` already asserts for every other round-mutating control on
   this screen. It also has an independent justification: the capture session should not be
   reconfigured while the MP4 is finalizing.

**Test:** one source-text test in `tests/tracerV3Wiring.test.ts`, in the `trainingMode.test.ts`
style, asserting the ref exists, that the snapshot is taken inside `stopRecording` **before**
`setIsRecording(false)`, that the save reads and consumes it, that both callbacks check
`recordingBusy` and no longer check `camera.isRecording`, and that both Pressables are
`disabled={recordingBusy}`. Confirmed failing against byte-exact pre-fix copies of both
files.

---

## NEW-3 — LOW · the revert comment was false again

`constants/config.ts` said reverting writes "no new columns WRITTEN" and that `saveLocalClip`
"binds those columns to NULL on every save". Both were false the day they were written: the
same round made `capture_lens` / `capture_zoom` write non-null values ungated on
`config.tracer`, deliberately.

Rewritten as a numbered list of the **four** things that survive the revert, with the two
columns named, stated plainly as **written, non-null**, and carrying the reason they are
ungated: *a clip saved without them is one the V3 ladder must refuse forever, because
"unknown lens" and "1x" are the same input to every calculation downstream and only one of
them is safe — so gating them behind the flag would silently poison every clip recorded
before it was flipped.* The note also records that this corrects what it said until 6 Sep,
rather than quietly reading as though it had always been right.

The same false claim was in the header of `tests/tracerV3Wiring.test.ts` ("no new column
written"). Corrected there too, in the same session, because a doc comment that overstates a
guarantee is how this one drifted in the first place.

**Test:** `GATE NEW-3: the revert note and the code agree about the two capture columns` —
it reads the ungated bind out of `hooks/useCamera.ts` as a precondition, then asserts the
revert note does not contain the two false phrases and does name both columns as written.
The disagreement between the two files is now the thing that fails a test, rather than the
thing a later agent finds.

---

## What I could NOT verify

- **Nothing ran on a device, and no frame was rendered.** No Swift was compiled. NEW-2 in
  particular is **read from source and pinned by a source-text test — it has not been
  pressed on a phone.** The check for whoever has one: pinch, record, stop, tap "1x" inside
  the finalize window, then read `capture_zoom` off the row. It should be the pinched value,
  and the pill should now be untappable while "1x" is disabled.
- **`getCaptureOptics` has still never been called by a real recording**, and the two
  columns have still never been written by a real `saveLocalClip`.
- **NEW-1's field frequency is still unmeasured.** I know `carry_as_scale` fires when the
  pixel-only carry sigma exceeds 15 % of the carry, that this was 34–69 % on my 8–10 frame
  synthetic tracks and 16 % on the real `IMG_3649` at K=5, and 1.3 % / 5.2 % on the lab's two
  long real clips. **What fraction of real field clips land above the threshold is unknown**,
  and it decides whether the "no distance" pill is rare or common. It is the first thing to
  read off a field test.
- **The 4-sigma bar on the new z-score is the lab's number, reused, not re-derived.** I
  checked it behaves sensibly at −30 %, −50 %, −70 %, −90 % and +50 %, +100 % on one real
  clip. That is one clip's geometry.
- **My fixtures are simulated flights projected through a known camera.** They prove the
  ladder recovers a flight it is *given*; they say nothing about whether the Swift detector
  finds a ball on real footage.
- **F3, unchanged and still blocking any build:** `GolfBallDetector.mlpackage` is on disk
  and still not in git. One `git add` by the seat. Not mine to run.

---

# fixes, round 3 — the gate's GATE-1 and GATE-3, applied as a CLASS fix

**Agent:** `fix3`, 6 Sep 2026. **Branch:** `feat/tracer-v3`.
**Input:** `docs/tracer-v3/gate.md` (read in full), then this file's rounds 1 and 2 and
`re-verify.md`. Reference for every algorithm: `~/projects/clippar/tracer-lab`.

**Gate:** `npm run verify` — **tsc clean, 847 tests, 0 failures, 0 skipped, 0 todo, exit 0.**
It arrived at 838. **+9 tests, none deleted, weakened, skipped or parked.**
`grep -rnE "\.skip\(|\.todo\(|\.only\(|xit\(" tests/` exits 1. 62 test files, unchanged.

| file | +tests |
|---|---|
| `tests/tracerFit.test.ts` | 28 → 30 |
| `tests/tracerV3Refusals.test.ts` | 30 → 36 |
| `tests/tracerV3Wiring.test.ts` | 32 → 33 |

New fixture: **`tests/fixtures/tracerV3FlatTension.ts`** — 1440x2560, 60 fps (and 30 on
request), 4.5 deg pitch, camera 1.48 m, ball 2.4 m out / 1.1 m left, 73 deg FOV, flat
10-degree launch. The gate agent's own geometry, because **neither existing fixture reaches
this band** and one of the new tests asserts exactly that.

**I ran no `git` command and no `npm install`.**

---

## GATE-1 — HIGH, blocking · a wrong GPS carry reaching a confident label through `carry_tension`

### Reproduced first, on the new fixture, before touching a line

```
=== f5@60  TRUTH carry 164.6 m         (no-GPS control: "170 m" / "apex 17 m · no GPS", fit 171.9)
  gps=  60 dec=pixel_only_fallback                     "170 m" / "apex 20 m · no GPS"
  gps=  80 dec=fit  st=carry_tension  z=3.18           "100 m" / "apex 6 m"      -39 %
  gps= 100 dec=fit  st=carry_tension  z=2.55           "110 m" / "apex 7 m"      -33 %
  gps= 120 dec=fit  st=carry_tension  z=2.77           "170 m" / "apex 19 m"
=== f6@60
  gps=  60 dec=fit  st=carry_tension  z=3.94           "100 m" / "apex 6 m"      -39 %
```

The gate agent's headline row, on my own run: **a 164.6 m shot the pixels get right on
their own is drawn "100 m", `decision=fit`, `carry_tension`, no "· no GPS".**

At the fit level, the mechanism, also reproduced rather than taken on trust:

```
pixel-only carry  171.84  sigma 24.33
rel = sc / cPx    14.16%   (AS_SCALE_FRAC = 15%)  -> asScale = FALSE
D= 60  status=carry_tension  z=3.45  zNoPixelSigma=5.22
D= 80  status=carry_tension  z=2.83  zNoPixelSigma=4.29
```

**The code computed 5.22 and 4.29 — both over the 4-sigma bar — and never looked at them**,
because `lib/tracerFit.ts:1436` tested `zScale` only when `asScale` was true, and 14.16 %
is below 15 %.

### (a) `lib/tracerFit.ts` — the second z-score is now part of every verdict

One conjunct removed. `carryZNoPixelSigma` was already computed on every fit that has a
carry; it is now **tested** on every one of them, and `rel` decides only which explanatory
flag is attached.

**Why this is the CLASS and not the instance.** The same shape has been found three times
at three thresholds — review F1 at `carry_untested`, gate NEW-1 at `carry_as_scale`,
GATE-1 at `carry_tension` — and every time the cause was a disagreement test skipped, or
diluted, by a sigma that was itself unreliable. F1(a) fixed it for a **non-finite** sigma
(substitute 0, never skip the test). NEW-1(a) fixed it for an **enormous** one, but behind
a 15 % gate. **A threshold is a line the failure does not respect**; the only version of
the rule that cannot be walked under has no threshold in it at all.

**Confirmed on real clips, not only the synthetic fixture** — this is the band, on data
from a phone:

| clip | K | rel | z (lab's own) | z_no_pixel_sigma | before | after |
|---|---|---|---|---|---|---|
| IMG_3649 | 6 | **14.3 %** | 2.65 | **4.06** | `carry_tension` | `carry_inconsistent` |
| IMG_3632 | 6 | 12.6 % | 2.81 | **4.01** | `carry_tension` | `carry_inconsistent` |
| IMG_3649 | 6 | 14.3 % | 2.12 | 3.25 (−40 % reading) | `carry_tension` | **unchanged** |

The last row is the bound, and it has its own test: the lab's ~55 % calibration is
preserved and **dropping the conjunct moved the boundary for nobody who was inside it.**

### (b) `lib/tracerV3.ts` — the label rule is now an ALLOWLIST

`carry_tension` was `flags.push('carry_tension')` and nothing else — byte-for-byte the
shape `carry_as_scale` had before round 2. Rather than add a second name to a denylist
(which is what produced three findings), the rule is inverted:

> **`carry_consistent` is the only verdict that licenses a GPS-backed number.**

Every other value — `carry_as_scale`, `carry_tension`, `carry_untested`, and
`carry_inconsistent` if it arrives on the implausible-flight refit after the carry decision
— goes down the NEW-1(b) path: honest sigma, and the distance dropped when it exceeds the
coarsest step `labelStepM` can offer. **The same code path, generalised — there is no
parallel one.** A verdict added to `CarryStatus` later is unverified until someone
deliberately says otherwise, which is the safe direction for a number a golfer reads.

**The honest sigma gained a fourth term, and it is the load-bearing one.** NEW-1(b) took
the widest of the fit's own total, sigma_D, and the pixel-only carry sigma. Those three are
enough under `carry_as_scale`, where the third is ≥ 15 % of the carry by construction. They
are **not** enough under tension: the gate agent measured a 13 m error against a claimed
6.5 m sigma on a 43 m pitch, because a short shot's 15 % is a few metres. So the fourth
term is **the disagreement itself** — how far the GPS dragged the drawn carry away from the
pixel-only companion's own answer. On the reproduction that term is 58 m against the fit's
own 21 m, and it is what withholds the number.

That is not an extra rule bolted on. It is NEW-1(a)'s principle applied at the label:
**sizing a claim with a sigma the evidence has already contradicted is the whole disease.**
Two estimates that disagree by X bound the error of whichever one is wrong at X, and
nothing in this pipeline knows which. It is confined to the unconfirmed verdicts on
purpose — under `carry_consistent` the fit has *tested* that gap against its own sigma and
explained it, and applying the term there would drop a correct GPS reading whenever the
pixels happened to be 4 % off. I checked that, rather than assuming it.

`meta.carry` also gains **`zNoPixelSigma`**, because it is half the verdict now and the
whole finding was a number the code computed and nobody looked at. It must reach the row a
field test is read from.

### After

```
  gps=  80 dec=pixel_only_fallback  "170 m" / "apex 17 m · no GPS"
           reason  carry_inconsistent(z=3.2sigma,z_no_pixel_sigma=4.7sigma)
  gps= 100 dec=fit  st=carry_tension  "no distance" / "GPS unchecked"
           carry_tension_no_distance(honest_sigma=58m>10m)
  gps= 120 dec=fit  st=carry_tension  "no distance" / "GPS unchecked"
  gps= 165 dec=fit  st=carry_consistent  "160 m" / "apex 13 m"     <- still used, still labelled
```

### What it costs — MEASURED by running the sweep twice, not simulated

3 888 `traceClip` calls: 648 geometries (fps {30,60} x frames {4,5,6,8,10,14} x v0
{55,68,78} x theta {10,14,18} x rpm {2200,3400,5200} x phi {1,5}) x 6 GPS readings, once
against the code as it stood and once against the code as it now stands.

| | before | after |
|---|---|---|
| GPS within ±5 % of truth: **GPS-backed numbers** | 1769 / 1944 | **1767 / 1944** |
| …of those, more than 15 % from truth | 12 | 10 |
| …any drawn number more than 25 % from truth | 0 | 0 |
| GPS at 0.35x / 0.5x / 2x of truth: **GPS-backed numbers** | 155 | **0** |
| …of those, more than 15 % from truth | 98 | **0** |
| …any drawn number more than 25 % from truth | **52** | **1** |
| `carry_tension` verdicts across the sweep | 157 | 12 |

**Two correct readings lost out of 1769 (0.11 %); 155 wrong ones stopped.** The single
remaining >25 % row is `pixel_only_fallback`, honestly marked "· no GPS" — a pixel failure,
not a GPS one. The gate agent's offline estimate was 0.2 % / 95.9 %; measured after the
edit it is 0.11 % and 100 %.

---

## GATE-3 — LOW (honesty) · "FOUR things survive the revert" was short by two

`constants/config.ts` now says **SIX**, and both new items were verified against the code
rather than copied from the gate report:

5. `lib/gpsSession.ts:623` constructs the module-level `gpsSession` singleton on import,
   unconditionally — the flag is read *inside* it, not around it.
6. The native payload ships in every binary: the 5.9 MB `GolfBallDetector.mlpackage`
   resource bundle and the `CoreML` framework link (both in `ShotDetector.podspec`), plus
   the `detectShotV3` and `renderTracerV3` `AsyncFunction` registrations.

This is the **third** drift of this one comment (F9/F10 "byte-identical", NEW-3 "no new
columns WRITTEN", now the count), so it gets a test rather than a footnote:
`GATE-3: the revert note lists everything that survives, and each item is true in the code`
asserts both halves — the note names them, **and** the singleton and the podspec entries
are still there. Removing either now shortens the note deliberately instead of silently.

---

## The tests, and the proof that they are tests

**Nine, and each was run against the pre-fix code.** I took byte copies of the three
changed source files, reverted **each half separately**, ran the new suite, and restored —
SHA-256 identical on all three afterwards (`f9faf54c…` / `70ac3382…` / `1560f36d…`).

```
revert (a) only — the fit-level conjunct restored
  ✖ GATE-1: the pixel-sigma-free z is tested with NO threshold on `rel`, on a real clip
  ✖ GATE-1: the two halves of the fix are distinguishable
revert (b) only — the label rule back to carry_as_scale alone
  ✖ GATE-1: a ~165 m shot with GPS carries from 5 m to 500 m never draws an unconfirmed GPS number
        -> {"frames":5,"fps":60} gps=100: a GPS-backed number on verdict "carry_tension"
  ✖ GATE-1: the two halves of the fix are distinguishable
revert (c) only — the revert comment back to FOUR
  ✖ GATE-3: the revert note lists everything that survives, and each item is true in the code
```

**The controls passed under every one of those reverts** — "the fix did not turn the GPS
off", "a genuinely tight pixel carry still gets its number", "the unconditional test is
still bounded". A fix that made everything withhold its number would have failed them.

Note that the reproduction test does **not** fail when only (a) is reverted, because (b)
catches those rows too. That overlap is deliberate and it is why the halves also have a
test that separates them by mechanism — one asserts the ladder *rejected the carry* (with
`z < 4` and `z_no_pixel_sigma > 4` parsed out of the row), the other that it *withheld the
number* (with `z_no_pixel_sigma < 4` and the honest sigma parsed out of the flag).

**The anti-merge pin.** `GATE-1: this fixture reaches carry_tension in the diluted band
NEITHER sibling reaches` measures **`|z_no_pixel_sigma| / |z|`** — which is
`sqrt(1 + sc² / (sigma_D² + sigma_fpx²))`, i.e. exactly how much the pixel-only sigma
dilutes the ordinary test. It is **1.457 on the new fixture**, **1.117 on `tracerV3Clip.ts`**
(too tight — the two tests agree, so a fix tuned there cannot see this), and
`tracerV3ShortTrack.ts` lands on `carry_as_scale` instead. A later "simplification" that
merges the three fixtures deletes the reproduction, and that test says so.

---

## The residue, named rather than smoothed over

At 8 detections a GPS reading of 120 m against a 164.6 m shot scores **z = 1.99 against
`Z_TENSION` = 2.0**. The verdict is `carry_consistent` — correctly: the pixel-only carry is
168.6 m with a sigma wide enough that 120 m is a two-sigma reading, and nothing here knows
which of the two is wrong. The pill then states **"130 m", 18.8 % from truth.**

**That is not the carry ladder. It is `labelStepM` saturating**: the drawn fit's own
1-sigma is **26.8 m**, nearly three times the coarsest rounding step the pill has, so the
number is stated at a precision the fit never claimed. It has a test —
`GATE-1: the residue is the LABEL VOCABULARY, not the carry verdict` — whose assertions are
on the things that are *true* (the verdict, the z, the sigma), not on the wrong number, so
it keeps passing when that decision is taken.

For the same reason the §3c reproduction sweep asserts a **20 %** bar rather than the 15 %
§3b uses. That is one row, named in the test comment with its z and its sigma, not a hedge.

---

## Not attempted, on instruction — named again

- **The `pixel_only_fallback` companion choice.** When a carry is rejected the ladder
  renders the drawn rung's pixel-only *companion*, which on a spin-fixed rung can be a poor
  fit, rather than the best pixel-only fit across the whole ladder. Round 2 filed it; this
  round makes it fire more often still: across the sweep the `pixel_only_fallback`
  decision went from 1 622 to 1 767, so **145 more readings now take that path**. **It is a
  behaviour change to the drawn arc and needs its own decision.**
- **`labelStepM` saturating at 10 m.** Above, and it is what the residue is. Giving every
  label a "too uncertain to state" rung would change what the golfer sees on most clips —
  pixel-only sigmas are routinely 30–40 m — so it needs its own decision too.

## What I could NOT verify

- **Nothing ran on a device and no frame was rendered.** No Swift was compiled. Everything
  here is `node --import tsx` against the TypeScript ladder.
- **My fixture is a simulated flight projected through a known camera.** It proves the
  ladder recovers a flight it is *given*; it says nothing about whether the Swift detector
  finds a ball on real footage, which is still the biggest unmeasured thing in this branch.
  The two fit-level tests do run on real clips (`IMG_3649`, `IMG_3632`).
- **GATE-1's field frequency is still unmeasured.** I know it needs a launch angle around
  10 degrees, 4–8 detections and a pixel-only carry sigma roughly in the 8–15 % band, and
  that `carry_tension` fell from 157 to 12 across my sweep. **What fraction of real clips
  land there is unknown**, and it decides whether "no distance" is rare or common. It is
  the first thing to read off a field test.
- **I did not re-derive `Z_INCONSISTENT` = 4, `Z_TENSION` = 2, `AS_SCALE_FRAC` = 15 % or
  `COARSEST_LABEL_STEP_M` = 10.** They are the lab's numbers and round 2's, reused. The
  point of this round is that the fix no longer *depends* on `AS_SCALE_FRAC` being right.
- **The fourth honest-sigma term (the disagreement) is my own reasoning, not the lab's.**
  The lab has no equivalent — `tracer.py:837` appends a flag and draws the number. It is
  justified in the code comment and measured in the table above, and it is the one part of
  this round a reviewer should push on hardest.
- **`GolfBallDetector.mlpackage` is still on disk and still not in git** (review F3,
  unchanged). One `git add` by the seat, and without it the dev build measures a pipeline
  nobody built.

---

# fixes, round 4 — the final gate's five findings, applied

**Agent:** `fix-fg`, 6 Sep 2026. **Branch:** `feat/tracer-v3`.
**Input:** `docs/tracer-v3/final-gate.md` read in full, then this file's rounds 1-3.
Reference for every algorithm: `~/projects/clippar/tracer-lab`.

**Gate:** `npm run verify` — **tsc clean, 860 tests, 0 failures, 0 skipped, 0 todo, exit 0.**
It arrived at 847. **+13 tests, none deleted, weakened, skipped or parked.**
`grep -rnE "\.skip\(|\.todo\(|\.only\(|xit\(" tests/` exits 1. 62 test files, unchanged.

| file | +tests |
|---|---|
| `tests/tracerV3Refusals.test.ts` | 36 → 48 |
| `tests/tracerV3Wiring.test.ts` | 33 → 34 |
| `tests/tracerFit.test.ts` | unchanged in count; **one existing test rewritten to the corrected contract and given four new assertions** (FG-2, below) |

Two new fixtures, each with an anti-merge pin asserting that no sibling reproduces it:
**`tests/fixtures/tracerV3AxisFallback.ts`** (FG-3) and
**`tests/fixtures/tracerV3DroppedFrames.ts`** (FG-1).

**I ran no `git` command and no `npm install`.**

---

## The headline, measured on ONE sweep run twice

58 500 `traceClip` calls — 4 500 geometries × 13 GPS readings, six cameras of my own sharing
no constant with any committed fixture, one seeded PRNG per geometry — run once against the
code as round 3 left it and once against the code as it now stands. Not simulated from
exposed diagnostics; the same generator, both times, 0 calls threw either time.

| | before (round 3) | after (round 4) |
|---|---|---|
| clips that draw an arc | 22 186 | **22 481** (+295) |
| … with a NUMBER on the pill | 16 844 | **12 398** (−26.4 %) |
| … "no distance" | 4 683 | 9 375 |
| … "down the line" | 659 | 708 |
| **numbers more than 25 % from truth** | **1 393 (8.27 %)** | **52 (0.42 %)** |
| numbers more than 15 % from truth | 2 534 | 505 |
| **WORST number drawn** | **+484 %** | **+49 %** |
| correct numbers (≤ 10 % out) | 13 019 | 11 263 (−13.5 %) |
| GPS-backed numbers > 25 % out | 174 | **16** |
| numbers stated on a CORRECT GPS reading | 1 065 | 844 (−21 %) |
| **realistic capture** (≥ 1080 px, 30/60 fps): numbers | 5 485 | 4 100 |
| **realistic capture: > 25 % out** | **398 (7.26 %)** | **11 (0.27 %)** |

**The sentence for Henry:** *about one in four clips that used to show a distance now shows
the arc with no number on it; in exchange the chance that a number it does show is more than
a quarter wrong drops from about 1 in 14 to about 1 in 370.*

**The arc count went UP, not down** (+295): FG-1(c) rescues clips that used to be refused
outright because the fallback drew a poor fit that the physics gate then threw away.

**What is left.** 52 rows on **18 distinct geometries**, worst **+49 %**, 16 of them
GPS-backed. They are not a class — the worst is one geometry (a 12-point track at rms 1.0 px
with sigma(v0)/v0 = 2 % that is nonetheless 49 % wrong) and no predictor I could find
separates it from the 11 263 correct ones without costing several times as many of them.
**It is 1 in 370 of the numbers still stated, and it is not zero.** §FG-1(a) has the sweep.

---

## FG-1 — HIGH, blocking · the pill stated a distance at a 5-10 m step whatever its own sigma

**Reproduced first, on a new fixture, before touching a line.** The gate's own camera and
launch family — 1284×2778 at 60 fps, flat 8.8° launch, dropped frames (every second one),
detections starting 3 frames after impact, **no GPS anywhere near it**:

```
truth carry 65.4 m     fitted carry 280.7 m     +329 %
LABEL "280 m" / "apex 33 m · no GPS"
      the fit's own sigma on that carry is 110.9 m; the rounding step is 10 m
```

The gate's worst was +194 % on a 62 m shot; the family reproduces harder than the row it
quoted, which is what the gate warned would happen — it says plainly that its CSV rounds
geometry to 2 dp and that an ill-conditioned clip is chaotic, so **nothing here is a re-typed
row.** `tests/fixtures/tracerV3DroppedFrames.ts` generates it, and a test asserts that all
four sibling fixtures recover their own flight to within 15 % so they cannot be mistaken for
reproductions.

### (a) The rule, and the sweep that chose it

**The gate's own proposal does not work, and I measured that rather than asserting it.**
Withholding on `sigma > f × carry`, over all 16 495 numbers the code drew before this round's
label change:

| rule | withheld | > 25 % caught | correct (≤10 %) lost | remaining > 25 % | worst kept |
|---|---|---|---|---|---|
| `sigma > 0.15 × carry` | 46.4 % | 1 091 / 1 319 | 39.2 % | 250 | 71 % |
| `sigma > 0.20 × carry` | 20.2 % | 834 / 1 319 | 12.8 % | **485** | 99 % |
| `sigma > 0.25 × carry` | 7.7 % | 652 / 1 319 | 2.1 % | 689 | 111 % |
| `sigma > 0.30 × carry` | 4.2 % | 544 / 1 319 | 0.3 % | 797 | 111 % |

**Because the failures are CONFIDENTLY wrong** — a tight formal sigma with a large error —
which is exactly the disease review F4 was invented for. So I swept every other quantity the
fit exposes:

| predictor | withheld | caught | correct lost | remaining | worst kept |
|---|---|---|---|---|---|
| **`sigma(v0)/v0` of the DRAWN fit > 5 %** | 18.2 % | **1 219 / 1 319** | **7.1 %** | 122 | 49 % |
| `sigma(v0)/v0` > 8 % | 12.2 % | 1 124 | 2.9 % | 217 | 57 % |
| `sigma(v0)/v0` > 10 % (F4's own bar) | 9.9 % | 1 059 | 1.5 % | 282 | 59 % |
| **rms > 2 px @1080p** | 15.1 % | 1 036 | 5.1 % | 305 | 120 % |
| rms > 4 px @1080p (`POOR_FIT_RMS_PX`) | 5.0 % | 519 | 0.7 % | 822 | 232 % |
| `sigma(apex)/apex > 0.25` | 27.4 % | 985 | 22.0 % | 356 | 196 % |
| spread of carries across ladder rungs > 0.2 × carry | 17.3 % | 418 | 14.0 % | 923 | 484 % |
| K < 8 points | 28.7 % | 754 | 25.0 % | 587 | 196 % |
| **the track did not reach the image apex** | **99.4 %** | **1 319 / 1 319** | **99.5 %** | **0** | **10 %** |

That last row is worth reading twice and it is not a proposal. **Every single wrong number in
the sweep came from a track that stopped before the apex, and among the 0.6 % that did reach
it nothing was more than 10 % out.** Depth is what the carry rides on and the descent is what
resolves depth. It is unusable as a rule — it withholds essentially everything, because
`selectDetections` deliberately uses only the first ~15 (30 fps-equivalent) frames unless the
track goes through the apex — but it is the strongest single fact in this sweep and it is why
the withheld pill says *"not enough of the flight"* rather than confessing to a sigma.

**The rule I shipped is three tests, any one of which withholds the number:**

| | | anchored to |
|---|---|---|
| 1 | `sigma(v0)/v0` of the DRAWN fit ≥ **5 %** | review F4's own quantity, with F4's **azimuth conjunct removed** |
| 2 | rms > **2 px @1080p** | `poor_fit`'s own question with its **`nPoints >= 10` conjunct removed**; 2 px is twice the per-point label noise `fitLaunch` itself assumes (`width/1080`) |
| 3 | label sigma > **25 % of the drawn carry** | the vocabulary rule, relative. A backstop, not the rule |

Each is an existing gate of this ladder with the conjunct that was blocking it taken out —
the same move GATE-1 made on `AS_SCALE_FRAC`, for the same reason: *a threshold is a line the
failure does not respect.* The gate's own analysis says where test 2 comes from: `poor_fit`
requires `nPoints >= POOR_FIT_MIN_K = 10`, so a 5-8 frame track at rms 4-8 px draws carrying
only a `large_pixel_residual` flag nobody reads.

**The frontier, so the choice is auditable and not just asserted:**

| rule | withheld | caught | correct lost | remaining (rate) | worst kept | numbers kept on a CORRECT GPS |
|---|---|---|---|---|---|---|
| test 1 alone, at F4's 10 % | 16.2 % | 1 138 | 5.5 % | 181 (1.31 %) | 57 % | 95 % |
| test 1 alone, at 5 % | 18.2 % | 1 219 | 7.1 % | 122 (0.90 %) | 49 % | 91 % |
| 1 or 2 | 25.7 % | 1 263 | 13.9 % | 56 (0.46 %) | 49 % | 87 % |
| 1 or 3 | 25.7 % | 1 256 | 13.6 % | 63 (0.51 %) | 49 % | 87 % |
| **1 or 2 or 3 — SHIPPED** | **24.7 %** | **1 266** | **12.4 %** | **53 (0.43 %)** | **49 %** | **87 %** |
| 1 (at 4 %) or 2 or 3 | 28.1 % | 1 272 | 15.8 % | 47 (0.40 %) | 49 % | 83 % |
| 1 or 2 or `sigma > 20 %` | 36.1 % | 1 290 | 23.3 % | 29 (0.28 %) | 49 % | 78 % |

Everything tighter than the shipped rule buys single-digit numbers of wrong rows for whole
percentage points of correct ones; everything looser leaves a tail with a worse worst case.

**A latent finding closed as a side effect, and I checked rather than assuming it.** Review F7
/ gate GATE-2 is the `prior` rung — K < 3 with a GPS carry — which the final gate measured at
**701 of 993 of its numbers more than 25 % from truth, worst +66 % GPS-backed**, held off the
product only by `detectMinTrackEmit >= 3` and the one test that machine-checks it. I re-ran it:
**2 880 `prior`-rung calls, 1 and 2 detections, every GPS reading in the ladder — 0 numbers
drawn.** The rung now draws a direction and never a distance, so the config assertion is no
longer the only thing standing between that rung and a wrong number. It is still the thing
keeping the rung unreachable and should stay.

**One door closed after the sweep, which changes no number in it.** `v0RelSigma` answers 0
for a fit that reports no formal sigma on `v0` — right for F4, where an unmeasurable rung must
not be able to trigger a refusal on its own, and wrong for a number about to be stated. Test 1
now treats that absence as its own reason to withhold (`sigma_v0=unknown`). **It did not arise
once in 58 500 calls** — every drawn fit reported a finite sigma(v0) — so it is a closed door
rather than a measured case, and the tables above are unaffected.

**One deliberate refinement, found by a test rather than by the sweep.** Test 1 reads the
conditioning of the **DRAWN** fit only, not `max(drawn, worst-rung)`. With the ladder term in
it the SAME drawn arc kept its number at `gps=60` and lost it at `gps=40`, purely because a
different rung had run — and the ladder term belongs to F4, which asks about the CLIP's
geometry, where a rejected rung is evidence. Drawn-only is also strictly cheaper: 24.7 %
withheld against 27.9 %, and 12.4 % of correct numbers lost against 15.4 %, for the same
residual.

**What I did NOT do:** apply the vocabulary rule literally. `sigma <= COARSEST_LABEL_STEP_M`
on every number withholds **96 % of them and 97 % of the correct ones**, so 25 % is a measured
product bar and not something that falls out of the rounding steps. Saying so is more honest
than dressing it up.

### (b) The wording when the distance is withheld

**`"no distance" / "not enough of the flight"`**, and it reuses `buildLabel`'s existing
`noDistance` argument — the same path `axis_degenerate` and `carry_as_scale`/`carry_tension`
already take. There is no parallel path; the arc is untouched and still drawn.

The wording is the sweep's own strongest finding turned into advice. The two existing pills
name a cause (*"down the line"*, *"GPS unchecked"*) and the first of them is **actionable** —
it tells the golfer to move. So does this one: the carry's uncertainty is dominated by depth,
depth is resolved by seeing the ball descend, and 100 % of the wrong numbers in the sweep came
from tracks that ended before the apex. It tells them the one thing they can change — frame
more of the shot — instead of confessing to a quantity they cannot act on.

### (c) `pixel_only_fallback` renders the best pixel-only fit in the ladder — FIXED, not deferred

Filed as out of scope by rounds 2 and 3. It is `pickPixelOnly` in `lib/tracerV3.ts` now.

**The rule has no threshold in it:** among the pixel-only companions the ladder produced, take
the one with the lowest rms that the fitter calls `ok`; ties go to the incumbent, so it can
only move the drawn arc when it has a measured reason to. A companion is not its rung — a rung
is rejected for what its JOINT fit did, and its companion never saw the carry — which is
review F1(b)'s principle pointed the other way.

**Measured on its own, before the label rule went in** (same 58 500 calls):

| | drawn-rung companion | best of ladder |
|---|---|---|
| numbers drawn | 16 208 | **16 495** (+287) |
| of those > 25 % out | 1 341 | **1 319** |
| correct numbers | 12 585 | **12 871** (+286) |
| `decision = fit` with the carry rejected: > 25 % out | 219 / 300 (73.0 %) | 200 / 306 (65.4 %) |

**Modest, and I am not going to inflate it.** It is a net gain on every axis — more clips
draw, fewer numbers are wrong, no clip loses one — but it is not the large win the gate hoped
for, because on many clips the ladder runs a single rung and there is nothing to choose
between. The 65 % of that one path that is still wrong is handled by (a), which withholds all
of it: after the label rule that row does not appear in the failure table at all.

**Tests:** the reproduction fixture and the anti-merge pin; the withheld pill and its exact
wording; that turning `labelRounding` off does not buy the number back (this is a rule about
whether a distance may be STATED); that test 3 is reachable **alone** on
`tracerV3AxisFallback` at 5 frames, so deleting the weakest of the three is visible rather
than silent; the cost control across all twelve clean geometries both with and without a GPS
carry; and, for (c), that the drawn fit IS the pick and the pick is strictly better than the
incumbent.

---

## FG-2 — HIGH · `carry_untested` was a FLAG and not a STATUS, so the allowlist never saw it

`lib/tracerFit.ts`. When the pixel-only companion has a finite carry but an unusable **sigma**,
F1(a) substitutes `sc = 0` so the protective test still runs — right, and unchanged. But with
`sc = 0` the two denominators differ by nothing:

```ts
const denom          = Math.sqrt(sigmaTest ** 2 + sc ** 2 + sigPxSys ** 2);
const denomNoPxSigma = Math.sqrt(sigmaTest ** 2 +            sigPxSys ** 2);
```

so `z === zNoPixelSigma` exactly, **GATE-1's whole addition is a no-op on those rows**, and
the verdict came back `carry_consistent` — which `lib/tracerV3.ts`'s allowlist reads as "the
pixels confirmed the GPS". They did not; the one test that could be formed did not object.
The gate measured it on **13.8 % of GPS-backed numbers**, `z === zNoPixelSigma` on 100 % of
them, and its own worst GPS-backed row (+67.6 %) among them.

**The fix is one branch and it takes nothing else with it.** `carry_as_scale` cannot pre-empt
it (`rel = sc / cPx` is 0 when `sc` is 0, so `asScale` is false by construction here) and the
two protective verdicts above still win, so the ONLY outcome that changes is
`carry_consistent → carry_untested`. The flag string is unchanged, so anything filtering field
rows on `carry_untested(no_usable_pixel_only_carry_sigma)` keeps matching.

**Tests, and one of them is a rewrite I am naming rather than burying.**
`tests/tracerFit.test.ts`'s F1 test asserted `carry_consistent` on this exact case — that was
round 1's answer and FG-2 shows it went one step too far. It now asserts `carry_untested`,
**and gains four assertions**: that the test still RAN (`carryZ !== null`, F1's property,
untouched), that the reading genuinely agrees (`|z| <= 2`, the precondition), that
`carryZNoPixelSigma === carryZ` exactly (the mechanism, so a later change that makes the sigma
usable fails here rather than drifting), and the unchanged half — a carry that cannot be true
still comes back `carry_inconsistent`. It runs on a **real clip**, `IMG_3631`, not a fixture.
The product-level half is on `tracerV3FlatTension` at 6 frames / 30 fps, with a control
asserting a clip whose companion sigma IS usable still gets its GPS-backed number.

**The cost, measured on the same 58 500 calls.** `carry_consistent` went from **7 222 to
6 190** and `carry_untested` from **0 to 1 045**: **1 032 clips, 14.3 % of the verdicts that
used to license a GPS-backed number**, against the gate's independently measured 13.8 %. Every
one of them now goes down the honest-sigma path, and because a missing companion sigma is
treated as unknown-and-therefore-unbounded (round 3's rule, unchanged), that is a withheld
distance rather than a widened step.

---

## FG-3 — MED-HIGH · the axis-degenerate refusal was lost on `pixel_only_fallback`

`worstV0RelSigma` is accumulated over the rungs the ladder RAN. With a GPS carry supplied
those rungs are the JOINT fits, which the carry keeps well conditioned — so the worst v0 sigma
never gets large. The fit then DRAWN on the fallback is the pixel-only companion, precisely
the ill-conditioned one F4 exists to catch, and one no rung of that ladder measured.

**Reproduced on a new fixture** (`tests/fixtures/tracerV3AxisFallback.ts`, the gate's own
camera: 720×1280 at 30 fps, 8° pitch, camera 1.30 m, 70° FOV, a 45° wedge at 16 m/s):

```
truth carry 23.8 m
gps=null  dec=fit                 "down the line" / "no distance"   <- F4 fires
          conditioning: worst 40 % / drawn 40 %   (every rung IS a pixel-only fit)
gps=80    dec=pixel_only_fallback "30 m" / "apex 8 m · no GPS"      +42 %
          conditioning: worst  1 % / drawn 40 %   <- the ladder never measured the drawn fit
```

Same clip, same drawn fit (33.7 m, azimuth fitted at 1.49° when the ball flew at 3.0°), same
error. The only difference is whether a GPS carry was supplied and then thrown away. It also
slips both residual gates, which is the gate's point about where these live: rms 7.66 px
@1080p, under `MAX_RMS_PX` = 8, and `poor_fit` needs `nPoints >= 10` while the track is 7.

**Fix:** measure the conditioning of the fit that is DRAWN as well as the ladder's worst rung,
and take the larger. Both terms are load-bearing and neither replaces the other — the ladder
term is F4's original case, where the drawn fit is the tight spin-bound rescue and only a
rejected rung knows the geometry was bad; the drawn term is FG-3's, where the drawn fit is not
a rung at all. When the drawn fit IS a rung the max is a no-op.

**Two smaller instances of the same shape, fixed in passing and named here:** the
implausible-flight refit runs its own ladder and its `worstV0RelSigma` was discarded with it,
and the flag now reports both terms
(`axis_degenerate(phi=…,worst_sigma_v0=…,drawn_sigma_v0=…)`) so a field row can tell F4's case
from FG-3's. `meta.conditioning` carries both numbers on every drawn clip, because a flag that
only appears when it fires tells a field test nothing about the clips where it nearly did.

**Cost, measured:** `down the line` went from 659 to 708 across 58 500 calls — **49 more
refusals in 22 481 drawn clips.** It has a test of its own asserting that a 12-frame track 4°
off the line with a rejected carry keeps its number.

---

## FG-4 — MEDIUM, latent · a non-finite detection was dropped by the fitter but counted by the ladder

`lib/tracerFit.ts:1038` has always filtered the track to finite points. `selectDetections` and
every `sel.used.length` gate downstream counted the RAW array, so junk got past the one guard
standing between "no evidence" and "a number".

**Reproduced on my own geometry, against the code as round 3 left it** — i.e. with FG-1
reverted as well, because otherwise FG-1 withholds the number and the reproduction is hidden.
The gate measured `-65 %` on its geometry; this is mine, not a re-typing of that row:

```
truth carry 196.5 m, 10 detections, no GPS, forceTrace OFF
  round 3     9 of 10 non-finite   nUsed=10   fitted ONE point   LABEL "110 m"   -44 %
  FG-1 only   9 of 10 non-finite   nUsed=10   fitted ONE point   LABEL "no distance"
  FG-4        9 of 10 non-finite   nUsed=1    too_few_detections_no_carry(1)
```

**The middle row is worth naming rather than hiding: with FG-1 in place, FG-4 no longer
changes the NUMBER on this input — a one-point fit has a wide enough sigma that the label rule
already withholds it.** What FG-4 changes is the COUNT: without it `meta.selection.k` reports
10 when one point was usable, the `nUsed < MIN_FIT` guard is defeated, and a field test reads
a track length that never existed. Two safety layers agreeing is the point of having two.

**The fix is one exported helper, `finiteDetections`, and that is the actual repair** — the
old shape had the count and the fit reading two different arrays, and the hold-out check
re-read the raw one **twice** more (its own `HOLDOUT_MIN_N` count, and the all-frame refit).
Every read inside the module now goes through the helper. `meta.nDetections` still reports what
the detector emitted, because that is a fact about the detector;
`meta.selection.nNonFinite` and a `non_finite_detections_dropped:N/M` flag say what was
dropped, so a field row does not silently show a smaller K than the detector reported.

**Reachability is still not demonstrated**, and the test says so: neither the gate nor I could
make the Swift detector emit a non-finite coordinate, and nothing in `tracerApplyEmissionRule`
checks. This closes a hole in the JS safety layer, which is the layer whose job is to be the
last one.

**Tests:** the reproduction under BOTH `forceTrace` settings (it is an absence of input, not a
judgement about a shot); the same case with a GPS carry, where one point reaches the `prior`
rung — it may draw a direction, it may not state a distance; the all-junk degenerate case
refusing as `no_detections` rather than throwing; a clean control that still draws; and one
for the hold-out path asserting its median is never NaN.

---

## FG-5 — LOW (honesty) · the fourth drift of one fact across three files

`lib/storage.ts:165` still said the two capture columns are *"NULL on every row written before
this, and on every tracer-disabled build"* — the exact claim `constants/config.ts` has now
corrected twice (gate NEW-3, then GATE-3). They are written **non-null with the tracer off**,
deliberately: `app/(tabs)/record.tsx` supplies `getCaptureOptics` unconditionally and
`hooks/useCamera.ts` binds both columns outside the `if (tracerV3Gps)` block.

Corrected, pointed at `constants/config.ts` item 3 as the canonical statement, and — because
this is the fourth time — **given a test**, which is what GATE-3 did for the other file. It
asserts the code fact first (the bind is still there, and still positioned outside the tracer
gate — checked by source position, because `if (tracerV3Gps) { … }` closes before the save
object and a span pattern cannot tell inside from after), then that the migration comment does
not contradict it. Without the precondition the test would keep passing if someone re-gated
the bind and made the old sentence true again.

One line in `hooks/useCamera.ts` was clarified in the same pass: *"the columns stay NULL"* in
the GPS section now says *"the GPS columns"*, and names the two capture columns as the
exception.

---

## FG-6 — not fixed, and why

The gate's own classification is LOW and its own sentence is *"It cannot produce a wrong V3
number."* The persisted `SETTING_DEBUG_FORCE_TRACE` rehydration is the **v1** engine's bypass,
read only by `lib/tracerMath.ts` and the v1 branch of `processAllTracers`. It was not in this
round's brief, it is a behaviour change to a different engine, and touching it would put an
unrequested edit in a change set that already moves the label rule. **Left open and named**,
where the gate left it.

---

## The tests, and the proof that they are tests

**Thirteen new, and each was run against the pre-fix code.** I took byte copies of
`lib/tracerV3.ts`, `lib/tracerFit.ts` and `lib/storage.ts`, reverted **each fix separately**,
ran the three tracer suites, restored, and verified SHA-256 identical every time
(`f109bb75…` / `f9f727c2…` / `c2d728e7…`, the shipped bytes).

```
revert FG-1  (the `too_uncertain` rung dropped from the label chain)
  ✖ FG-1: a fit too uncertain to state a distance draws the arc and withholds the number
  ✖ FG-1: the label-sigma test is reachable on its own, so deleting it is visible
revert FG-1(c) (pickPixelOnly returns the incumbent)
  ✖ FG-1(c): the fallback draws the best pixel-only fit in the ladder, not the drawn rung's companion
revert FG-2  (the `!scUsable` branch removed, back to carry_consistent)
  ✖ FG-2: an unusable pixel-only carry sigma reaches the ALLOWLIST, not just the flag list
  ✖ a missing pixel-only carry sigma runs the test (F1) and still reaches carry_untested (FG-2)
revert FG-3  (axisV0RelSigma = worstV0RelSigma)
  ✖ FG-3: the axis-degenerate refusal survives the pixel-only fallback
revert FG-4  (finiteDetections returns the raw array)
  ✖ FG-4: a non-finite detection is not counted by the guard that lets a number out
  ✖ FG-4: the hold-out refit reads the same filtered array the counts and the fit do
revert FG-5  (the old sentence restored in lib/storage.ts)
  ✖ FG-5: lib/storage.ts and constants/config.ts agree about the two capture columns
```

**The controls passed under every one of those reverts** — "it did not turn the feature off",
"a confirmed carry is still a GPS-backed number", "the same measurement does not spread to
shots that are fine", and every pre-existing GATE-1 / NEW-1 / F1-F8 control. A change that
made everything withhold would have failed them.

**Three tests are preconditions rather than reproductions**, and they are labelled as such:
that the two new fixtures actually reach the states they exist for, and that no sibling
fixture does. Those are the anti-merge pins rounds 2 and 3 established — a later
"simplification" that merges the fixtures fails a test instead of silently deleting a
reproduction.

---

## What I could NOT verify

- **Nothing ran on a device and no frame was rendered.** No Swift was compiled. Everything
  here is `node --import tsx` against the TypeScript ladder, and the whole native half — Core
  ML loading, Vision, the AVFoundation export — is as unmeasured as it was.
- **My fixtures and my sweep are simulated flights projected through a known camera.** They
  prove the ladder recovers, or honestly refuses to state, a flight it is *given*. They say
  nothing about whether the Swift detector finds a ball on real footage, which is still the
  biggest unmeasured thing in this branch.
- **The 24.7 % withholding rate is a rate on MY synthetic distribution**, and the gate's
  warning applies to it exactly as it did to the gate's own: how the real detector's
  track-length and residual distribution compares to a uniform 3-20 frame sample is unknown,
  and it decides whether "no distance" is a quarter of clips or most of them. **It is the
  first thing to read off a field test**, and the three tests are named individually on the
  row (`too_uncertain_no_distance(sigma_v0=…,rms=…,sigma=…)`) so that reading is a `grep`
  rather than a re-run.
- **The three bars — 5 %, 2 px, 25 % — are measured on that same synthetic distribution.**
  Two of them are anchored to quantities that already exist in this code (F4's `sigma(v0)/v0`,
  and the per-point label noise `fitLaunch` assumes); the third is a product judgement and is
  labelled as one. None was re-derived from first principles.
- **52 rows on 18 geometries still draw a number more than 25 % from truth, worst +49 %.**
  That is 1 in 370 of the numbers still stated, against 1 in 14 before. It is not zero and I
  did not find a rule that makes it zero without costing several correct numbers for each one
  it removes. **Whether 1 in 370 clears Henry's "never" is his call, not mine** — the honest
  statement is that the class the gate found is closed and a residue of individually
  unpredictable geometries is not.
- **`Z_INCONSISTENT = 4`, `Z_TENSION = 2`, `AS_SCALE_FRAC = 15 %`, `COARSEST_LABEL_STEP_M = 10`,
  `POOR_FIT_MIN_K = 10`, `AXIS_DEGENERATE_*`** are unchanged and were not re-derived. They are
  the lab's numbers and rounds 2-3's, reused.
- **FG-4 is still not demonstrated reachable from Swift**, and FG-6 is untouched by design.
- **`GolfBallDetector.mlpackage` is in git** (the gate verified it byte-identical) and round 3
  landed as `3da9eff`, so `tracerV3FlatTension.ts` is tracked. **This round's two new fixtures
  are not**: `tests/fixtures/tracerV3AxisFallback.ts` and
  `tests/fixtures/tracerV3DroppedFrames.ts` must be `git add`ed BY NAME — six tests import
  them and a fresh clone is red without them. `git add -A` is not safe in this tree; seven
  unrelated untracked paths predate this work.
