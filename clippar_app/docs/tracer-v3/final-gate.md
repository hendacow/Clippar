# final-gate — the last gate on `feat/tracer-v3` before a dev build

**Agent:** `final-gate`, 6 Sep 2026. **Branch:** `feat/tracer-v3`, working tree on top of
`d32faa1`. **Repo:** `clippar_app`.
**Input read in full:** `docs/tracer-v3/gate.md`, then `fixes.md` (rounds 1, 2 and 3) and
`re-verify.md`. **I trusted none of it.** Every number below is from my own fixtures and my
own run.

**I ran no `git` command that writes and no `npm install`.** The only file I added to the
repo is this one. Every probe is in this session's scratchpad.

---

# VERDICT — **FAIL**

**GATE-1 is genuinely closed. I reproduced its fix working, on the gate agent's own clip and
on 58 500 of my own. But the property the brief asks me to certify — "no combination
produces a drawn distance more than 25 % from the truth, through any decision path" — does
not hold, and it does not hold through the path that was never the GPS's fault.**

| # | Check | Result |
|---|---|---|
| 1 | `npm run verify` — tsc clean, > 838 tests, 0 fail/skip/todo | **PASS** — **847 tests**, 0 fail, 0 skipped, 0 todo, exit 0, run twice |
| 2 | No drawn distance > 25 % from truth, through any path | **FAIL** — **1 719 of 39 086** drawn numbers, **180 of them GPS-backed**. Worst **+194 %** (**FG-1**, **FG-2**, **FG-3**) |
| 3 | Refusals, my own no-ball inputs, `forceTrace` off AND on | **PASS** on every realistic input. One class draws that should not (**FG-4**, latent) |
| 4 | Reversibility with the flag off; every revert clause true | **PASS** on behaviour; all six clauses true. A **different** file still carries the old false one (**FG-5**) |
| 5 | Swift `-parse` × 5, `-typecheck` the three together | **PASS** — exit 0 everywhere |
| 6 | Diff hygiene | **PASS.** `GolfBallDetector.mlpackage` **is now in git** — review F3 is closed, verified |
| 7 | Open findings classified | Done — §7 |

**The one sentence.** The carry *verdict* is now sound; the carry *label* is not. Once the
fit's own 1-sigma passes about 10 m, `COARSEST_LABEL_STEP_M` caps how far the pill can
widen, so the number stops describing its own uncertainty and starts reading like a
measurement — and there is no "too uncertain to state" rung except the one GATE-1 added for
unconfirmed GPS verdicts. **That is why the worst rows in my sweep have no GPS in them at
all.**

---

## FG-1 — HIGH, BLOCKING · the pill states a distance at a 5–10 m step no matter how wide the fit's own sigma is

**Worst row in the sweep, no GPS involved.** Reproduced exactly from the generator, not
quoted from a log:

```
gid 473  1284x2778@60  pitch 0.8  hcam 1.75  fov 77  v0 41.07  theta 8.81  phi 3.83
         rpm 1266  12 detections, stride 2 (a dropped-frame track), starting 3 frames after impact
    TRUTH carry 62.34 m
  gps=null  dec=fit                  sigma=36.6 m  step=10   "180 m" / "apex 14 m · no GPS"   +193.5 %
  gps=  80  dec=pixel_only_fallback  sigma=36.6 m  step=10   "180 m" / "apex 14 m · no GPS"   +193.5 %
```

A 62 m shot drawn as **"180 m"**. The fit's own `sigmaTotal.carryM` is **36.6 m** and the
pill rounds to **10 m**, because `roundLabelM` cannot offer a coarser step than
`COARSEST_LABEL_STEP_M = 10`. Nothing is wrong with the GPS here — there is no GPS.

**Worst GPS-backed row, same mechanism:**

```
gid 955  1284x2778@60  pitch 0.8  hcam 1.75  fov 77  v0 35.77  theta 43.49  phi 11.99
         rpm 4582  6 detections, starting 3 frames after impact
    TRUTH carry 85.68 m
  gps=null  dec=fit  sigma=99.8 m  step=10   "160 m" / "apex 64 m · no GPS"    +89.7 %
  gps= 150  dec=fit  sigma=82.0 m  step=10   "140 m" / "apex 53 m"             +67.6 %   <- no "· no GPS"
            carry: status=carry_consistent  z=1.07  zNoPixelSigma=1.07  sigmaM=21.8
            flags: … | carry_untested(no_usable_pixel_only_carry_sigma) | …
```

**And the cleanest one, where the GPS is exactly double the truth and the ladder cannot
tell:**

```
gid 2697  1170x2532@24  pitch 2.5  hcam 1.62  fov 66  v0 45.51  theta 10.72  phi 5.72
          rpm 2929  5 detections
    TRUTH carry 111.38 m
  gps=null    dec=fit  sigma=34.1 m  step=10   "140 m" / "apex 12 m · no GPS"   +29.6 %
  gps= 222.8  dec=fit  sigma=35.9 m  step=10   "170 m" / "apex 16 m"            +49.2 %   <- GPS-BACKED
              carry: status=carry_consistent  z=-1.97  zNoPixelSigma=-2.50
```

`z = −1.97` against `Z_TENSION = 2.0`. **The verdict is right** — with a 35.9 m sigma on a
111 m shot, a reading of 222.8 m genuinely is inside two sigma and the pixels cannot refute
it. What is wrong is that the pill then states it to the nearest 10 m.

The fix agent named this residue and measured one row at 18.8 %, calling it "the LABEL
VOCABULARY, not the carry verdict". **That diagnosis is exactly right and the magnitude on
record understates it by an order of magnitude:** it is 1 719 rows, up to +194 %, and it
fires with no GPS.

### Scale, on my own sweep — 58 500 `traceClip` calls, 0 threw

```
decision    {"fit":28569,"pixel_only_fallback":21835,"none":8096}
carryStatus {"(none)":33045,"carry_consistent":13865,"carry_tension":7045,
             "carry_as_scale":4518,"carry_inconsistent":27}
labelKind   {"number":39086,"no distance":10673,"SKIP":8096,"down the line":645}

drawn WITH a number 39086   of those GPS-backed 13959
LABEL numbers more than 25 % from truth: 1719   (GPS-backed 180)
LABEL numbers more than 15 % from truth: 4004   (GPS-backed 1088)
```

**Where the wrong numbers live** — and this is the finding, because it is not where three
rounds of fixes have been looking:

| path | numbers drawn | > 25 % from truth |
|---|---|---|
| GPS-backed (`carry_consistent`, drawn with no "· no GPS") | 13 959 | **180 — 1.3 %** |
| no GPS supplied at all (the control) | 3 687 | **154 — 4.2 %** |
| `decision = fit`, GPS rejected upstream | 3 704 | **159 — 4.3 %** |
| `decision = pixel_only_fallback` | 21 423 | **1 380 — 6.4 %** |

**The GPS half is now the *safest* path in the ladder.** That is the fix agent's work and it
is real. The problem is the pixel-only number, which nothing has ever gated on accuracy.

By track length, the failures are concentrated exactly where the residual gate does not
reach — `poor_fit` requires `nPoints >= POOR_FIT_MIN_K = 10` (`lib/tracerV3.ts:1760`), so a
5–8 frame track with an rms between 4 and 8 px @1080p draws with only a
`large_pixel_residual` flag nobody reads:

```
 3 frames  4.1 %      8 frames  7.3 %     14 frames  3.3 %
 4 frames  3.4 %     10 frames  5.7 %     16 frames  1.0 %
 5 frames  9.4 %     12 frames  2.9 %     18 frames  2.9 %
 6 frames  9.7 %                          20 frames  2.7 %
```

### It does not go away on a realistic capture — it halves

```
                                            n      >25%           gps-backed >25%   worst
everything swept                          39086   4.40 %              1.29 %        230 %
width >= 1080 (what the app records)       25923   4.43 %              1.50 %        189 %
 … AND fps in {30,60}                      12818   4.22 %              1.29 %        189 %
 … AND >= 8 detections                      9518   2.87 %              0.74 %        189 %
 … AND phi >= 1.5 deg (off the shot line)   7757   3.06 %              0.80 %        189 %
 … AND GPS carry <= 300 m or none           6581   2.90 %              0.79 %        189 %
```

**Roughly 1 drawn number in 34 is more than 25 % wrong on a capture the app can actually
produce.** Henry's rule is "never".

### There is no cheap threshold, and I checked rather than proposing one

The obvious fix is a "too uncertain to state" rung keyed on the fit's own sigma. Measured
over all 39 086 drawn numbers:

| rule | numbers withheld | > 25 % errors caught | correct numbers (≤ 10 % out) lost |
|---|---|---|---|
| withhold when `sigma > 15 %` of the drawn carry | 65.3 % | 1 644 / 1 719 | 19 333 / 32 096 (60.2 %) |
| `> 20 %` | 31.6 % | 1 385 / 1 719 | 8 157 / 32 096 (25.4 %) |
| `> 25 %` | 7.3 % | 821 / 1 719 | 1 373 / 32 096 (4.3 %) |
| `> 30 %` | 2.7 % | 573 / 1 719 | 295 / 32 096 (0.9 %) |
| `> 40 %` | 0.8 % | 284 / 1 719 | 21 / 32 096 (0.1 %) |

**The fit's own sigma is a weak predictor of its own error.** Median sigma is 17 % of the
drawn carry, p90 is 24 %; the bad rows are not concentrated at the top. So this is not
"one conjunct" like GATE-1 was — **it is a product decision about whether this feature
states a distance at all on a short track**, and it belongs to whoever owns that decision,
not to a gate agent. I did not attempt it.

---

## FG-2 — HIGH · `carry_untested` is a FLAG, not always a STATUS — so GATE-1's allowlist never sees it, and its second z-score buys literally nothing on 1 in 7 GPS-backed clips

`lib/tracerFit.ts:1388-1394`, which is F1(a)'s rule and correct on its own terms:

```ts
const scUsable = scPx != null && Number.isFinite(scPx) && (pixelOnly?.ok ?? false);
if (pixelOnly && Number.isFinite(pixelOnly.summary.carryM)) {
  const cPx = pixelOnly.summary.carryM;
  const sc = scUsable ? (scPx as number) : 0;
  if (!scUsable) flags.push('carry_untested(no_usable_pixel_only_carry_sigma)');
```

When the pixel-only companion has a finite carry but an unusable **sigma**, `sc = 0`. Then:

```ts
const denom          = Math.sqrt(sigmaTest ** 2 + sc ** 2 + sigPxSys ** 2);
const denomNoPxSigma = Math.sqrt(sigmaTest ** 2 +            sigPxSys ** 2);
```

are the same number, so **`z` and `zNoPixelSigma` are identical** and GATE-1's whole
addition is a no-op. The verdict then comes back `carry_consistent`, and `carry_untested`
is recorded only as a flag — deliberately, and the comment says so: *"never as a
replacement for the test."*

But `lib/tracerV3.ts`'s new allowlist reads the **status**:

```ts
const carryVerdict = usedFit.carryStatus !== 'carry_consistent' ? usedFit.carryStatus : …
const gpsUnverified = gpsBackedLabel && carryVerdict !== 'carry_consistent';
```

and its own comment claims to cover *"`carry_untested` — with no pixel-only companion to
test against at all"*. It covers the case where there is **no companion**. It does not cover
the case where there is one with an unusable sigma, which is the case the flag is named for.

Measured on the sweep:

```
GPS-backed numbers carrying the carry_untested flag: 1931/13959 = 13.8 %
  rows where z === zNoPixelSigma EXACTLY:            1931/1931  = 100.0 %
  status on those rows: {"carry_consistent":1878,"carry_tension":53}
  of those, >25 % from truth: 34/1931 = 1.8 %   (vs 1.2 % for GPS-backed rows without it)
```

**One GPS-backed clip in seven gets no benefit at all from the fix this branch's last round
was written to make**, and the worst GPS-backed row in the whole sweep (gid 955, +67.6 %) is
one of them. The effect size is modest — 34 rows — but the shape is the one that has now
produced four findings in a row: **a name the deciding code does not look at.**

---

## FG-3 — MEDIUM-HIGH · review F4's `axis_degenerate` refusal is silently lost on the `pixel_only_fallback` path

Same clip, same drawn fit, same 37.1 m sigma. The only difference is whether a GPS carry
was supplied and then *rejected*:

```
gid 3384  720x1280@60  pitch 8  hcam 1.3  fov 70  v0 18.37  theta 33.52  phi 5.40
          rpm 3273  5 detections
    TRUTH carry 30.28 m
  gps=null  dec=fit                  "down the line" / "no distance"      <- F4 fires, correctly
            flags: … | axis_degenerate(phi=0.26deg,worst_sigma_v0=161%_of_v0)
  gps=  35  dec=pixel_only_fallback  "100 m" / "apex 9 m · no GPS"        +216.5 %
            flags: inconsistent | … | (no axis_degenerate)
```

**Mechanism, read from source.** `axisDegenerate` is
`|usedFit.params.phiDeg| < AXIS_DEGENERATE_PHI_DEG && worstV0RelSigma >= AXIS_DEGENERATE_V0_REL_SIGMA`,
and `worstV0RelSigma` is accumulated inside `runFitLadder` over the rungs that ladder ran
(`lib/tracerV3.ts:1090`). With a GPS carry supplied, those rungs are the **joint** fits,
which the carry keeps well conditioned — so the worst v0 sigma never gets large. The fit
that is then **drawn** on `pixel_only_fallback` is the pixel-only companion, which is
precisely the ill-conditioned one F4 exists to catch, and whose conditioning that ladder
never measured.

So: supplying a GPS carry that the ladder subsequently throws away removes F4's protection
from the very fit it was written for.

Across the sweep, **52 geometries** where the no-GPS control correctly refuses with "down
the line / no distance" state a number once some GPS carry is supplied; **18 of them state a
number more than 25 % wrong.** This also draws a near-vertical arc down the camera axis with
a distance on it, so it is a wrong arc as well as a wrong number.

---

## FG-4 — MEDIUM, latent · a non-finite detection is dropped by the fitter but still counted by the refusal ladder

`lib/tracerFit.ts:1038` filters the track to finite points. `selectDetections` and the
`nUsed < MIN_FIT` guard in `lib/tracerV3.ts:678` count the raw array. So junk counts toward
the one guard that stands between "no evidence" and "a number":

```
truth carry 195.3 m; 10 detections, forceTrace OFF, no GPS
  0 of 10 non-finite   nUsed=10   err=  0%   "200 m" / "apex 20 m · no GPS"
  5 of 10 non-finite   nUsed=10   err=-10%   "180 m" / "apex 17 m · no GPS"
  9 of 10 non-finite   nUsed=10   err=-65%   "70 m"  / "apex 8 m · no GPS"
 10 of 10 non-finite   nUsed=10   SKIP fit_failed:tracerFit: empty track
```

**One usable pixel, and the pill says "70 m" for a 195 m shot.** `meta.selection.k` reports
10. The residual gates cannot help: with one point the rms is 0.

**Every FINITE corruption I could build is correctly refused**, and I checked that before
raising this — a Kalman that loses lock and freezes, and one that drifts linearly, are both
caught at every mix of real and corrupted frames, by `not_a_flight`, `implausible_flight`
or `track_not_ballistic`. The hole is specifically that a non-finite coordinate makes the
residual tests vacuous rather than failing them.

**Reachability: I did not demonstrate it.** Nothing in `TracerDetectCore.swift`'s emission
rule (`tracerApplyEmissionRule`, `:2258`) checks finiteness, and the coordinates come from
blob centroids and Kalman state, but I could not produce an input that makes the Swift
detector emit a NaN and I did not run any Swift. Raising it because the JS ladder is the
safety layer and this is its one countable-by-junk guard, not because I can show it firing.

---

## FG-5 — LOW (honesty) · the revert note is right; `lib/storage.ts` still carries the sentence it corrected

`constants/config.ts` now says SIX and **all six are true — I checked each against the
code** (§4). But `lib/storage.ts:165`, in the comment on the same two columns, still says:

> NULL on every row written before this, and on every tracer-disabled build.

That is the exact claim gate NEW-3 was raised about and that `constants/config.ts` item 3
now corrects. `hooks/useCamera.ts:663-664` binds both columns **outside** the
`if (tracerV3Gps)` block, and `app/(tabs)/record.tsx:354` supplies `getCaptureOptics`
unconditionally — so they are written non-null with the tracer off, deliberately, and
`constants/config.ts` says so. **Two files in the same change set disagree about the same
fact, for the third time.** No behaviour, no number, no arc.

---

## FG-6 — LOW (observation) · the new dev screen re-arms the *v1* bypass across restarts

F6 was closed for the V3 bypass: `app/profile/tracer-dev-settings.tsx:224` says so and
`config.tracer.v3.forceTrace` is genuinely not rehydrated. But eight lines above, the same
`useEffect` **does** rehydrate `SETTING_DEBUG_FORCE_TRACE` into `config.tracer.debugForceTrace`
(`:201-204`), which is the *v1* engine's bypass and has exactly F6's shape — persisted, and
silently re-armed by opening the diagnostics screen.

It is confined to the v1 engine: `config.tracer.debugForceTrace` is read only by
`lib/tracerMath.ts` and by the v1 branch of `processAllTracers`
(`hooks/useEditorState.ts:1622`, below the V3 `continue`). **It cannot produce a wrong V3
number.** It can produce a wrong v1 arc over a putt, and only with `engine: 'v1'`.

---

# 1. `npm run verify` — PASS

```
> tsc --noEmit                          # no output — clean
> node --import tsx --test tests/*.test.ts
ℹ tests 847     ℹ pass 847     ℹ fail 0
ℹ skipped 0     ℹ todo 0       EXIT=0
```

**847 tests, 0 failures, 0 skipped, 0 todo, tsc clean, exit 0.** Floor was 838, so **+9**.
Run twice end to end, identical both times.

**Nothing parked, checked rather than taken from `fixes.md`:**

```
$ grep -rnE "\.skip\(|\.todo\(|\.only\(|xit\(|xtest\(|\bskip: *true|\btodo: *true" tests/
$                                        # exit 1 — no matches
$ ls tests/*.test.ts | wc -l
      62                                 # unchanged
```

Per-file counts match the round-3 table: `tracerFit` 30, `tracerV3Refusals` 36,
`tracerV3Wiring` 33.

**Nothing weakened — with one change that deserves naming.** `git diff --numstat tests/`
shows **two** deleted lines in the whole suite. Both are the same edit:
`assertNeverConfidentlyWrong` gained a fourth parameter, `maxErrFrac = 0.15`. **The default
is unchanged, so every pre-existing call site still asserts 15 %.** Two new call sites pass
`0.2` (`tests/tracerV3Refusals.test.ts:591` and `:717`), and the test comment states the one
row that needs it, with its z and its sigma. That is a disclosed widening on new
assertions, not a weakening of old ones — but a later reader should know the sweep test in
§3c asserts 20 %, not 15 %.

The new tests are real. `GATE-1: this fixture reaches carry_tension in the diluted band
NEITHER sibling reaches` measures `|z_no_pixel_sigma| / |z|` on all three fixtures and pins
that only the new one is in the band — so a later "simplification" that merges the fixtures
fails rather than silently deleting the reproduction. That is the right shape and I could
not find a way for it to pass vacuously.

---

# 2. The property, swept hard — FAIL

## 2a. My fixtures

Deliberately sharing no constant with any of the three in `tests/fixtures/`:

| fixture | resolution | fps | pitch | hCam | FOV | ball |
|---|---|---|---|---|---|---|
| `tracerV3Clip.ts` | 1080×1920 | 60 | 6.0° | 1.40 m | 62° | (4.0, +0.3) |
| `tracerV3ShortTrack.ts` | 2160×3840 | 30 | 9.0° | 1.62 m | 68° | (3.2, −0.6) |
| `tracerV3FlatTension.ts` | 1440×2560 | 60 | 4.5° | 1.48 m | 73° | (2.4, +1.1) |
| **mine, camera 1** | **1170×2532** | | **2.5°** | **1.62 m** | **66°** | **(3.7, −1.6)** |
| **mine, camera 2** | **886×1920** | | **12.0°** | **1.05 m** | **58°** | **(1.8, +2.2)** |
| **mine, camera 3** | **1284×2778** | | **0.8°** | **1.75 m** | **77°** | **(5.5, +0.9)** |
| **mine, camera 4** | **720×1280** | | **8.0°** | **1.30 m** | **70°** | **(2.9, −0.4)** |
| **mine, camera 5** | **1600×2844** | | **15.0°** | **1.90 m** | **61°** | **(4.6, +2.8)** |
| **mine, camera 6** | **1080×2400** | | **5.5°** | **1.45 m** | **64°** | **(2.1, −3.1)** |

Smoke test first, so a failure below is the ladder's and not the fixture's — pixel-only, no
GPS, on three of them:

```
f6@30  th11 v62  truth carry 195.3  ->  "200 m" / "apex 20 m · no GPS"
f12@60 th14 v62  truth carry 203.4  ->  "200 m" / "apex 26 m · no GPS"
f20@60 th18 v72  truth carry 246.8  ->  "250 m" / "apex 47 m · no GPS"
```

## 2b. The sweep

**4 500 geometries × 13 carries = 58 500 `traceClip` calls, 0 threw.** Nine shards, one
seeded PRNG per geometry (`mulberry32(0x9e37 + gid·2654435761)`), so any row can be
regenerated from its `gid` alone. Every parameter moves independently:

- **camera** — one of the six above · **fps** {24, 30, 60, 120}
- **detections** 3–20 · **start** 1–3 frames after impact · **stride** 1 or 2 (dropped frames)
- **sub-frame impact offset** uniform [0, 1)
- **launch angle** — half the draws forced into the flat **8–14°** band where GATE-1 lived,
  half uniform over 5–50°
- **ball speed** 16–82 m/s, correlated with launch the way a bag is
- **azimuth** 0.0–12°, with 10 % of draws under 0.6° to reach the axis-degenerate case
- **back spin** 1 200–9 000 rpm, **side spin** ±1 500 rpm · **confidence** 0.30–0.95
- **GPS** — `null`, plus 6 sampled from {5, 10, 20, 35, 50, 80, 110, 150, 200, 260, 320, 400,
  500} m and 6 sampled from {0.3, 0.5, 0.7, 0.85, 0.95, 1.0, 1.05, 1.15, 1.4, 2.0, 3.0}×
  truth, so both the absolute 5–500 m ladder and the relative error ladder are covered
- **`carrySigmaGpsM`** — supplied on 35 % of calls, 2–15 m

Result quoted in full in FG-1. **RESULT: FAIL.**

## 2c. The controls, which say the fix did not simply turn the GPS off

```
GPS within +-5 % of truth — 6300 drawn clips
  stated a number: 4927 (78.2 %)   of those GPS-backed: 4817
  withheld the number: 1336        down the line: 37
  of the numbers stated, >15 % out: 128   >25 %: 72

GPS at 0.3x / 0.5x / 0.7x / 1.4x / 2x / 3x of truth — 12929 drawn clips
  GPS-BACKED numbers: 2015   of those >15 % out: 331   >25 %: 90
  withheld: 3688             fell back to pixel-only: 7187
```

**A correct GPS reading is still used and still labelled on 4 in 5 clips.** That is the
thing a "fix" of this kind is most likely to have broken, and it did not.

## 2d. GATE-1's own reproduction, re-run — it is closed

On the fix agent's fixture, my run, not theirs:

```
=== f5@60  TRUTH 164.6 m
  gps=null dec=fit                 st=null            "170 m" / "apex 17 m · no GPS"    +4 %
  gps=  80 dec=pixel_only_fallback st=null            "170 m" / "apex 17 m · no GPS"    +4 %   <- was "100 m", -39 %
  gps= 100 dec=fit  st=carry_tension    z=2.55 zNoPx=3.73  "no distance" / "GPS unchecked"
  gps= 120 dec=fit  st=carry_tension    z=2.77 zNoPx=2.79  "no distance" / "GPS unchecked"
  gps= 165 dec=fit  st=carry_consistent z=0.57 zNoPx=0.80  "160 m" / "apex 13 m"        -3 %   <- still used
```

Both of the gate agent's headline rows are gone, and a correct reading still gets its
number. Same at 6 and 8 detections.

## 2e. The `prior` rung — still latent, still bad if it is ever reached

The brief names it, and my main sweep cannot reach it (3-detection floor). A dedicated
sweep — 4 cameras × 2 fps × K ∈ {1, 2} × 3 speeds × 3 launch angles × 13 carries,
**1 872 calls**:

```
drawn with a number 993 (GPS-backed 46)
numbers more than 25 % from truth: 701   of those GPS-BACKED: 33
  worst:  +66 %  K=1 gps=150 truth=84   "140 m" / "apex 24 m"   dec=prior  GPS-BACKED
```

**Seven in ten of its numbers are more than 25 % out.** It stays unreachable only because
`detectMinTrackEmit = 3` (`constants/config.ts:439` → `modules/shot-detector/index.ts:920` →
`TracerDetectCore.swift:2263`), and `tests/tracerV3Refusals.test.ts:117` asserts
`config.tracer.v3.detectMinTrackEmit >= 3` so the unreachability is machine-checked. **That
one assertion is now load-bearing for the product rule, not just for tidiness.**

## 2f. A note on reproducibility, because two of my own quotes did not reproduce at first

The sweep CSV prints geometry to 2 dp. On ill-conditioned clips the fit is chaotic, so
**re-typing a row's rounded parameters does not reproduce that row** — my first attempt at
gid 955 gave +10.8 % instead of +67.6 %. Re-derived through the sweep's own seeded generator
all four quoted rows reproduce exactly. Every geometry quoted in this report was produced
that way; none was typed back from the log.

---

# 3. Refusals — my own inputs, `forceTrace` OFF and ON

36 inputs × both settings = 72 calls, on my geometry.

**Every absence of evidence refuses under BOTH settings:** detector found nothing, address
ball null, zero detections, 1 or 2 detections with no carry, no camera pitch, fps 0,
width/height 0, unknown lens, 0.5× lens, pinch zoom 0.35, null lens/zoom, NaN `fPx`,
negative `fPx`. `forceTrace` reaches none of them, which is the design.

Every not-a-golf-shot input refuses with `forceTrace` OFF: static blob (3 and 12 frames),
all detections on one pixel, pure noise (12 and 20 frames, with and without GPS), a track
that only ever falls, a topped ball, a rolling putt classified as a swing.

**The one class that draws when it should not is FG-4** (non-finite coordinates). Four rows,
both settings, and the number can be −65 %.

Two readings that are not failures but belong on the record:

- **`all conf 0` draws**, and with a GPS carry it draws GPS-backed: `"190 m" / "apex 19 m"`.
  Review F14, re-confirmed on a fourth geometry. The discrimination is upstream in Swift
  (`confMean >= 0.4`); the ladder only uses confidence to widen the pixel sigma.
- **My divot drew where the review's skipped** — `"down the line" / "no distance"` with
  `forceTrace` off, i.e. refused the number but drew the arc. With a 180 m GPS carry the
  same divot draws `"20 m" / "apex 5 m · no GPS"`. F14 stands.

---

# 4. Reversibility with the flag off — PASS, and all six revert clauses are true

**The flag is off under node**, so §2 and §3 are the off-path run rather than a claim about
it. Every clause checked against the code, not read off the comment:

| clause in `constants/config.ts` | checked how | verdict |
|---|---|---|
| "no GPS session" | `hooks/useGpsSession.ts:40` `isActive = enabled && config.tracer.enabled && …`; `startWatch`'s **first line** is `if (!isActive) return;` (`:75`) | **true** |
| "no detection, no render" | every `detectShotV3` / `traceClip` / `renderTracerV3` call in the app is inside `processAllTracers`, whose first line is `if (!config.tracer.enabled \|\| !storage \|\| !roundId) return;` (`hooks/useEditorState.ts:1326`). Swept the whole tree: no other call site | **true** |
| "no UI reachable by tapping" | the pushing row is `{isDevVariant() && config.tracer.enabled && (…)}` (`app/(tabs)/profile.tsx:840`) | **true** |
| **no permission prompt** | all three `Location.*` calls (`:82`, `:92`, `:105`) are inside `startWatch`, below its early return; `AppState.addEventListener` (`:186`) is behind `if (!isActive) return` at `:179`; `setInterval` (`:193`) behind the guard at `:192` | **true** |
| 1. route registered, unguarded | `app/profile/tracer-dev-settings.tsx` is a route file; it contains no `config.tracer.enabled` guard and no `Redirect`. Deep-linked with the flag off it reads an empty GPS ring and calls no detector — it imports `gpsSession` but not `traceClip`/`detectShotV3` | **true, and inert** |
| 2. schema migration flag-independent | `lib/storage.ts:120-123, 137, 141, 147, 169-170` — nine tracer `ALTER TABLE` statements in one ungated list | **true** |
| 3. `capture_lens` / `capture_zoom` WRITTEN non-null | `hooks/useCamera.ts:663-664`, outside the `if (tracerV3Gps)` block at `:598`; `app/(tabs)/record.tsx:354` supplies `getCaptureOptics` unconditionally | **true — and `lib/storage.ts` contradicts it, FG-5** |
| 4. one focus subscription + one state object per mount | `useFocusEffect` registered unconditionally with a gated body (`:160-174`); one `useState<GpsHealth>` (`:42`) | **true** |
| 5. `gpsSession` module singleton | `lib/gpsSession.ts:623` constructs it on import. It imports nothing from `expo-location` — I grepped the file, there is no location call in it at all | **true, and inert** |
| 6. native payload in every binary | `ShotDetector.podspec` lists `CoreML` in `s.frameworks` and `GolfBallDetector.mlpackage` in `s.resource_bundles`; `ShotDetectorModule.swift:253` and `:269` register the two `AsyncFunction`s | **true** |

`forceTrace` is unreachable with the flag off: its only read sites are inside `traceClip`
and inside `processAllTracers`, below that function's own guard.

**NEW-2, spot-verified rather than taken from the gate.** The optics snapshot
(`hooks/useCamera.ts:1048`) is genuinely the first statement of `stopRecording`, before
`isRecordingRef.current = false` (`:1072`) and `setIsRecording(false)` (`:1073`). All four
control sites are `recordingBusy`: `flipCamera` (`:407`), `selectZoom` (`:416`),
`disabled=` on the zoom pill (`:2021`) and the flip button (`:2042`).

I looked for a way past it and did not find one. The 120 s `maxDuration` auto-stop resolves
`recordAsync` without passing through `stopRecording`, so the save falls back to a live read
(`:606`) — but the `finally` that clears `isRecording` runs *after* the save body, so
`recordingBusy` is still true during that read and the controls are still inert. The
`FINALIZE_SAFETY_MS = 30 000` timeout has the same property.

**Not pressed on a device.** Source and source-text tests only.

---

# 5. Swift — PASS

`SDK = …/iPhoneOS26.5.sdk`, target `arm64-apple-ios15.0`. No `pod install` in this
checkout, so **nothing was compiled into an app and nothing ran.**

```
swiftc -parse  ShotDetectorModule.swift  exit=0
swiftc -parse  ShotTracer.swift          exit=0
swiftc -parse  TracerDetect.swift        exit=0
swiftc -parse  TracerDetectCore.swift    exit=0
swiftc -parse  TracerRenderV3.swift      exit=0

swiftc -typecheck TracerDetectCore.swift TracerDetect.swift TracerRenderV3.swift
exit=0                                   # no output

singly:  TracerDetectCore  exit=0
         TracerRenderV3    exit=0
         TracerDetect      exit=1  "cannot find 'TracerParams' in scope"     (the file split)
         ShotDetectorModule exit=1 "no such module 'ExpoModulesCore'"        (missing pods)
         ShotTracer        exit=1  "no such module 'ExpoModulesCore'"        (missing pods)
```

Reproduces `re-verify.md` §4 and `gate.md` §7 exactly.

**What "clean" does NOT mean:** no file was compiled to object code, linked, signed,
installed or run. Expo's `AsyncFunction` marshalling, Core ML loading, the `.mlpackage` →
`.mlmodelc` compile-and-cache, every Vision call and every AVFoundation export path are
entirely unverified.

---

# 6. Diff hygiene — PASS, and review F3 is closed

```
$ git status --short
 M constants/config.ts        M lib/tracerV3.ts
 M docs/tracer-v3/NEXT.md     M tests/tracerFit.test.ts
 M docs/tracer-v3/fixes.md    M tests/tracerV3Refusals.test.ts
 M lib/tracerFit.ts           M tests/tracerV3Wiring.test.ts
?? tests/fixtures/tracerV3FlatTension.ts     <- NEW, must be `git add`ed
(plus 7 paths that predate this work: ../.vercel/, ../CLIPPAR_PTY_LTD_APPLE_ACCOUNT.md,
 .playwright-mcp/ and reg90.txt (both dated 18 Aug), ../clippar_mount/, ../logo_transparent/,
 ../migration/)

$ git diff --stat
 constants/config.ts | 22 +-   lib/tracerFit.ts | 52 +-   tests/tracerFit.test.ts | 59 +
 docs/…/NEXT.md      |  6 +-   lib/tracerV3.ts  | 140 +-   tests/tracerV3Refusals  | 298 +
 docs/…/fixes.md     | 265 +                               tests/tracerV3Wiring    | 40 +
 8 files changed, 830 insertions(+), 52 deletions(-)
```

| check | result |
|---|---|
| **`GolfBallDetector.mlpackage` in git** | **YES — review F3 is CLOSED.** All three files tracked at `d32faa1`; `weight.bin` is 6 070 368 bytes in HEAD and 6 070 368 on disk; `git diff HEAD` on the package is empty. Verified against the object store, not the report |
| Scratch files | **none new.** `docs/tracer-v3/` holds 14 files, all reports (13 + this one). `labCheck.ts` remains — a disclosed research tool, imported by nothing (`grep -rn labCheck app hooks lib components constants modules tests` exits 1) |
| Machine-absolute paths | **none** in any of the 28 new/changed TS, TSX, Swift and podspec files. Per-file grep for the home-directory prefix, the system temp dir and the macOS per-user cache dir: 0 everywhere |
| `tracer-lab` at runtime | **none.** 34 mentions, every one on a `//` or ` *` provenance line — I listed all 34 rather than counting them |
| `TODO` / `FIXME` / `XXX` / `HACK` | **0** across all 28 files |
| Debug prints on a per-frame path | **none.** `TracerDetect.swift` and `TracerDetectCore.swift` — the per-frame code — have **0** `print(` / `NSLog` / `os_log` / `debugPrint`. `TracerRenderV3.swift` has 5, all once-per-render or error paths (`:1645`, `:1686`, `:1755`, `:1783`, `:1791`). `d32faa1` added **no** print to `ShotDetectorModule.swift`. `lib/{tracerV3,tracerFit,tracerPhysics,tracerCamera,gpsSession}.ts` have **0** `console.*` |
| `git add -A` hazard | unchanged and still real — 7 untracked paths predate this work. **Name the paths** |

**One thing the seat must do:** `git add clippar_app/tests/fixtures/tracerV3FlatTension.ts`.
Without it the six new tests that import it fail on a fresh clone, and the GATE-1
reproduction is not in the repo.

---

# 7. Every still-open finding, and what it can produce

| finding | state | can it produce a **wrong number**? | a **wrong arc**? |
|---|---|---|---|
| **review F1** — GPS laundering via the refit | **closed** (round 1), re-verified | no | no |
| **review F2** — dropped `impact_slack_frames` | **closed** (round 1); threaded at `lib/tracerV3.ts:1062, 1470, 1611` | no — it cost recall, not safety | no |
| **review F3** — Core ML model not in git | **CLOSED.** Committed in `d32faa1`, byte-identical to disk | — | — |
| **review F3a** — lens/zoom rescale | **closed.** Every non-1×/pinched/unknown input refuses under both `forceTrace` settings in my run | no | no |
| **review F4** — axis-degenerate geometry | **partly open → FG-3.** The flag fires on `decision = fit`; it is **lost on `pixel_only_fallback`** | **YES** — up to +216 % | **YES** — a pole down the axis, with a number on it |
| **review F5** — pixel-only claiming GPS backing | **closed.** `gpsBackedLabel` is provenance now | no | no |
| **review F6** — persisted bypass re-armed | **closed for V3**; the same shape survives for the **v1** bypass → FG-6 | no (v1 has no V3 label) | **YES**, v1 engine only |
| **review F7 / gate GATE-2** — the `prior` rung, K < 3 | **open, latent.** 701 of 993 of its numbers are > 25 % out in my sweep. Unreachable while `detectMinTrackEmit >= 3`, which `tests/tracerV3Refusals.test.ts:117` machine-checks | **YES if reached** — up to +66 % GPS-backed | **YES** — direction from one pixel |
| **review F8** — `landing_depression_off` on short shots | **closed** (round 1) | no — a flag, not a gate | no |
| **review F9** — route survives the revert | open **by design**, disclosed as item 1. Deep-linkable in production; calls no detector | no | no |
| **review F10** — schema migration survives | open **by design**, disclosed as item 2 | no | no |
| **review F11** — `useGpsSession` + `gpsSession` singleton always mounted | open **by design**, items 4 and 5. Verified inert: no `expo-location` import in `lib/gpsSession.ts` at all | no | no |
| **review F12** — +5.9 MB in every binary | open **by design**, item 6. Verified in the podspec | no | no |
| **review F13** — `carryBetween` uses the module default config | **open.** `hooks/useEditorState.ts:1533` still omits the third argument | no — only `CarryEstimate.sigmaM`, which is diagnostic; the fit uses `carry.sigmaGpsM` and its own `BAG_OFFSET_M` | no |
| **review F14** — the ladder cannot tell a divot or a conf-0 track from a golf shot | **open, informational.** Re-confirmed on a fourth geometry | **YES** on non-golf input | **YES** |
| **gate NEW-1** — `carry_as_scale` laundering | **closed** (round 2), re-verified on my geometry | no | no |
| **gate NEW-2** — pinch zoom zeroed after the stop press | **closed** (round 2). Snapshot at the stop press, four `recordingBusy` guards. **Not pressed on a device** | no | no |
| **gate NEW-3 / GATE-3** — the revert comment | **closed** in `constants/config.ts`, all six items true. **Reopened in `lib/storage.ts`** → FG-5 | no | no |
| **gate GATE-1** — `carry_tension` laundering | **CLOSED**, reproduced closed on the gate's own clip and across 58 500 of mine | no | no |
| **round 3, "not attempted": the `pixel_only_fallback` companion choice** | **open, and now the single largest source of wrong numbers.** 6.4 % of its numbers are > 25 % out, against 4.2 % for pixel-only-by-design; round 3 measured its own traffic rising 1 622 → 1 767 | **YES** — up to +216 % | **YES** (it is also how FG-3 fires) |
| **round 3, "not attempted": `labelStepM` saturating at 10 m** | **open → FG-1.** Recorded as one 18.8 % row; measured as 1 719 rows up to +194 % | **YES** | no — the arc is fine, the number is not |
| **FG-2** — `carry_untested` is a flag, not a status | **new, open.** 13.8 % of GPS-backed clips; on 100 % of them `z === zNoPixelSigma` | **YES** — the worst GPS-backed row, +67.6 % | no |
| **FG-4** — non-finite detections counted by `MIN_FIT` | **new, open, latent.** Not demonstrated reachable from Swift | **YES if reachable** — −65 % from one pixel | **YES** |

---

# 8. What I could NOT verify

- **Nothing ran on a device and no frame was rendered.** No Swift was compiled, linked or
  executed. Core ML loading, the `.mlpackage` → `.mlmodelc` compile, every Vision call and
  every AVFoundation export path are untested, and the seam through
  `ShotDetectorModule.swift` cannot be typechecked here at all.
- **NEW-2 was not pressed on a phone.** Source and source-text only. The check for whoever
  has a device: pinch to a visible zoom, record, press stop, tap "1×" inside the finalize
  window, then read `capture_zoom` off the row — it must be the pinched value.
- **`getCaptureOptics` has still never been called by a real recording**, and the two
  capture columns have never been written by a real `saveLocalClip`.
- **My fixtures are simulated flights projected through a known camera.** They prove the
  ladder recovers a flight it is *given*. They say nothing about whether the Swift detector
  finds a ball on real footage, which remains the biggest unmeasured thing in this branch.
- **FG-4's reachability is unproven.** I could not make the Swift detector emit a non-finite
  coordinate, and I did not run it. Every finite corruption I built is correctly refused.
- **FG-1's field rate is an estimate from synthetic geometry**, not a measurement on real
  clips. 2.90 % of drawn numbers over 25 % on a realistic-capture filter is the best figure
  I have; how the real detector's track-length and residual distribution compares to my
  uniform 3–20 sample is unknown, and it is the single number that decides how bad FG-1 is
  in practice.
- **I did not re-derive `Z_INCONSISTENT = 4`, `Z_TENSION = 2`, `AS_SCALE_FRAC = 15 %`,
  `COARSEST_LABEL_STEP_M = 10`, `POOR_FIT_MIN_K = 10` or F4's thresholds.** They are the
  lab's numbers and round 2's, reused.
- **I did not re-run the lab-vs-port numerical comparison** (`verify.md` §5), and I did not
  re-run the fix agent's revert-each-half test procedure. I read the new tests and judged
  them; I did not independently prove each fails against pre-fix code.
- **GPS end to end.** No fix from a real receiver has been through the ring, the impact
  anchor or the re-derivation.

---

# 9. Everything I ran, in order

| # | command | result |
|---|---|---|
| 1 | `npm run verify` (×2) | tsc clean, **847/847**, 0 skip/todo, exit 0 |
| 2 | `grep -rnE "\.skip\(\|\.todo\(\|\.only\(\|xit\("` over `tests/` | exit 1 |
| 3 | `git diff --numstat tests/` + read the 2 deleted lines | the `maxErrFrac` parameterisation; default unchanged |
| 4 | `finalgate/smoke.ts` — my geometry, pixel-only | recovered to within one rounding step on all three |
| 5 | `finalgate/sweep.ts` ×9 shards — **58 500 `traceClip` calls** | **FAIL — 1 719 numbers > 25 % out, 180 GPS-backed** |
| 6 | `finalgate/analyse.mjs`, `dig.mjs`, `dig2.mjs`, `dig3.mjs`, `dig4.mjs` | FG-1, FG-2, FG-3 and the cost tables |
| 7 | `finalgate/exact.ts` — the four worst rows re-derived from the generator | all four reproduce exactly |
| 8 | `finalgate/repro.ts` — GATE-1's own reproduction, my run | **closed**; correct readings still used |
| 9 | `finalgate/refuse.ts` — 36 inputs × `forceTrace` both ways | absences all refuse; **FG-4** |
| 10 | `finalgate/nan.ts` — 0–10 of 10 detections non-finite | −65 % from one usable pixel |
| 11 | `finalgate/frozen.ts` — frozen and drifting Kalman tracks | **all refused**; the finite cases are safe |
| 12 | `finalgate/prior.ts` — **1 872 calls** on the `prior` rung | 701 of 993 numbers > 25 % out; latent |
| 13 | `swiftc -parse` ×5, `-typecheck` the three together and singly | exit 0 / exit 0 |
| 14 | `git status --short`, `git diff --stat`, `git ls-files`, `git cat-file -s` | read-only; **model in git and byte-identical** |
| 15 | grep sweeps over 28 files: absolute home/temp paths, `tracer-lab`, `console.`, `print(`, TODO | clean as tabled in §6 |
| 16 | source trace of every revert clause, every `Location.*` call, every tracer entry point | §4 |

**Total: at least 60 444 `traceClip` calls** — 58 500 in the main sweep, 1 872 on the
`prior` rung, 72 in the refusal suite, plus the targeted probes in rows 4, 7, 8, 10 and 11.

---

# VERDICT — is this safe to put in a dev build for a field test?

## **NO — not for a field test that reads distances off the pill. YES for the field test that actually needs running, with the four capture instructions below.**

**What is genuinely better than it was, and I checked rather than accepted:** GATE-1 is
closed as a class, not an instance — I reproduced the fix working on the gate agent's own
clip and I could not walk under it anywhere in 58 500 calls. The GPS-backed path is now the
**safest** path in the ladder (1.3 % of its numbers over 25 %, against 4.2 % for pixel-only
and 6.4 % for the fallback). A correct GPS reading is still used and still labelled on 4 in
5 clips, so the fix did not buy safety by turning the feature off. The Core ML model is in
git, so a build will measure the pipeline that was actually built. 847 green, nothing
weakened, no scratch files, no debug prints on a per-frame path, no machine paths, no lab
paths at runtime, and the revert note is honest at all six items.

**Why the distances still cannot be shown.** About **1 drawn number in 34** is more than
25 % from the truth on a capture the app can produce, and the worst is **+194 %** — a 62 m
shot drawn as "180 m", with no GPS involved. Three rounds of fixes have made the *carry
verdict* sound and have not touched the *label*: once the fit's own 1-sigma passes 10 m the
pill cannot widen any further, so it states a number at 10 m precision against a 35–100 m
sigma. **Henry's rule is that this feature may skip and may draw a trace with no distance,
but must never show a confidently wrong number. 1 in 34 is not never.**

**The field test worth running this week is still the one nobody has run: does the Swift
detector find the ball?** It does not need the GPS and it does not need the pill.

## Exact capture instructions for that test

1. **Before the build, `git add clippar_app/tests/fixtures/tracerV3FlatTension.ts`** — six
   tests import it and it is untracked, so a fresh clone is red. Then commit the round-3
   working tree. The `.mlpackage` is already in git; **do not** use `git add -A` — seven
   unrelated untracked paths are sitting in this tree.
2. **Take the GPS out of the loop: set `maxCarryM: 0` in `constants/config.ts:366`.** One
   number. `hooks/useEditorState.ts:1538` gates on
   `carry.carryM > 0 && carry.carryM <= config.tracer.maxCarryM`, so a zero makes
   `carryUsable` false on every clip and `traceClip` receives `carryM: null`. Every render
   is then pixel-only and honestly marked "· no GPS", and FG-2, FG-3, review F1 and F5
   cannot fire at all. (There is no dev-screen toggle for this — it is a source edit, and it
   is trivially reversible.)
3. **Capture at 1×, no pinch, phone roughly level, standing at least 2° off the shot line,
   `forceTrace` OFF.** Any other lens or any pinch is refused outright, which is correct; a
   shot straight down the axis loses its number to F4 — and, per **FG-3**, would silently
   get it back if a GPS carry were in play, which instruction 2 prevents. `forceTrace` draws
   arcs over putts and divots.
4. **Read the arc, not the number, and record both.** On the first clip check
   `tracer_meta.detectorNotes.coreml === "ok"` before walking to the second tee — anything
   else means the model did not reach the bundle and the test is measuring a degraded
   detector. Then, for every clip, note `meta.selection.k` (the detection count),
   `meta.fit.rmsPx`, `meta.sigmaTotal.carryM` and the drawn carry, and compare the drawn
   carry against a laser or a course marker **afterwards**. That comparison is the missing
   input to FG-1: it turns "2.9 % of synthetic clips" into a real number, and it is the
   thing that decides whether the pill ever gets to state a distance.

**If the GPS half is wanted in the first outing instead, it should not be.** FG-1 fires
without it, FG-3 needs it, and the one number the outing can produce that nobody has —
whether the detector finds the ball — does not use it.
