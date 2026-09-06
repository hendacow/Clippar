# gate — the final gate on `feat/tracer-v3` before commit and dev build

**Agent:** `gate`, 6 Sep 2026. **Branch:** `feat/tracer-v3`.
**Repo:** `/Users/hendacow/projects/clippar/final_shipment/clippar_app`.
**Input read in full:** `docs/tracer-v3/re-verify.md`, then `fixes.md` (both rounds) and
`review.md`.
**Reference:** `~/projects/clippar/tracer-lab`, and the port's own source.

I trusted nothing. Every reproduction below is on **my own fixture**, deliberately
different from both repo fixtures and from the fix agent's:

| fixture | resolution | fps | pitch | hCam | FOV | ball |
|---|---|---|---|---|---|---|
| `tests/fixtures/tracerV3Clip.ts` | 1080x1920 | 60 | 6.0 deg | 1.40 m | 62 deg | (4.0, +0.3) |
| `tests/fixtures/tracerV3ShortTrack.ts` | 2160x3840 | 30 | 9.0 deg | 1.62 m | 68 deg | (3.2, -0.6) |
| **mine** | **1440x2560** | **30 and 60** | **4.5 deg** | **1.48 m** | **73 deg** | **(2.4, +1.1)** |

**I ran no `git` command that writes, and no `npm install`.** The only file I added to the
repo is this one. Every probe lives in this session's scratchpad, not in `tests/`.

---

# VERDICT — **FAIL**

**`npm run verify` passes and every other check passes. The single property the brief
called "the one that matters most" does not hold, and I reproduced it on my own geometry
through a decision path nobody has looked at.**

| # | Check | Result |
|---|---|---|
| 1 | `npm run verify` — tsc clean, >830 tests, 0 fail/skip/todo | **PASS** — **838 tests**, 0 fail, 0 skipped, 0 todo, exit 0, run twice |
| 2 | A wrong GPS carry can never produce a confident distance, through ANY path | **FAIL** — the `carry_tension` rung (**GATE-1**), and the prior rung (**GATE-2**) |
| 3 | Refusal suite + my own no-ball inputs, `forceTrace` off AND on | **PASS** — 30/30 committed, plus 24 of my own x both settings |
| 4 | NEW-2 closed: both controls, both callbacks, or an optics snapshot | **PASS** — **both**, read from source. **Not pressed on a device.** |
| 5 | Reversibility with the flag off; every clause of the revert comment true | **PASS** on behaviour. The comment's clause count is short (**GATE-3**, LOW) |
| 6 | Diff hygiene | **PASS**, except `GolfBallDetector.mlpackage` is **still not in git** (review F3, unchanged, blocking) |
| 7 | Swift `-parse` x5, `-typecheck` the three together | **PASS** — exit 0 everywhere |

---

## GATE-1 — HIGH, BLOCKING · a wrong GPS carry still reaches a confident, GPS-backed
## label, through `carry_tension` — the rung immediately below the one NEW-1 fixed

**The quote the brief asked for.** My own fixture, 1440x2560 at 60 fps, 5 detections,
v0 55 m/s, launch 10 deg, 3400 rpm, azimuth 1 deg. **The pixels get it right on their own.**

```
### WORST  fps60 f5 v55 th10 rpm3400 phi1   TRUTH carry 164.6 m
  NO-GPS control: "170 m" / "apex 17 m · no GPS" | fit carry 171.8 | err 4%
  gps= 40 dec=pixel_only_fallback  status=null             "170 m" / "apex 20 m · no GPS"  err=3%
  gps= 60 dec=pixel_only_fallback  status=null             "170 m" / "apex 20 m · no GPS"  err=3%
  gps= 80 dec=fit    status=carry_tension  z= 3.18 sigma=12.7  "100 m" / "apex 6 m"   err=-39%
  gps=100 dec=fit    status=carry_tension  z= 2.55 sigma=15.3  "110 m" / "apex 7 m"   err=-33%
  gps=120 dec=fit    status=carry_tension  z= 2.77 sigma=18.0  "170 m" / "apex 19 m"  err=3%
  gps=165 dec=fit    status=carry_consistent z= 0.57 sigma=24.1 "160 m" / "apex 13 m" err=-3%
```

**Read the `gps=80` row.** The shot carried **164.6 m**. The app's own pixels say
**171.8 m**. A GPS reading of 80 m — the golfer laid up, or the successor fix landed on the
cart path, which is the review's own stated threat model — drags the drawn number to
**"100 m"**, and the sub-label is **`"apex 6 m"` with no `· no GPS`**, because the GPS
genuinely was used. That is Henry's rule broken by **39 %**, and it is worse than the
−33 % NEW-1 reproduction this round closed.

The neighbouring row is the same shot at 6 frames instead of 5: `gps=60 → "100 m"`, also
−39 %, also `carry_tension`, also GPS-backed.

### It is not NEW-1 reopened. It is the rung one step milder, and it was never examined

NEW-1 lived in `carry_as_scale`. This lives in `carry_tension`
(`Z_TENSION = 2.0 < |z| <= Z_INCONSISTENT = 4.0`), and **`carry_tension` is still a flag
that is pushed and otherwise ignored** — `lib/tracerV3.ts:1659-1660`:

```ts
} else if (fit.flags.some((f) => f.startsWith('carry_tension'))) {
  flags.push('carry_tension');
}
```

That is byte-for-byte the shape `carry_as_scale` had at `:1662` before this round, and it
is the shape the whole NEW-1 finding was about.

### The mechanism, at the fit level — the fix has a hole immediately below its own trigger

The fix agent's second z-score, `carryZNoPixelSigma`, is exactly the right test. It is
**computed on every fit but only ever tested when `asScale` is true** —
`lib/tracerFit.ts:1436`:

```ts
if (Math.abs(z) > Z_INCONSISTENT || (asScale && Math.abs(zScale) > Z_INCONSISTENT)) {
```

and `asScale` is `rel > AS_SCALE_FRAC`, i.e. the pixel-only carry sigma above **15 %** of
the pixel carry. On the failing clip it is **14.13 %**:

```
$ node --import tsx …/mech.ts
truth carry       164.57
pixel-only carry  162.74  sigma 23.00  ok true
rel = sc / cPx    14.13%   (AS_SCALE_FRAC = 15%)  -> asScale = false
D= 60  status=carry_tension  z=  3.34  zNoPixelSigma=5.04  carry=102.6
D= 80  status=carry_tension  z=  2.69  zNoPixelSigma=4.06  carry=108.1
D=100  status=carry_tension  z=  2.04  zNoPixelSigma=3.08  carry=117.7
D=120  status=carry_consistent z=1.39  zNoPixelSigma=2.10  carry=131.3
```

**`zNoPixelSigma` is 5.04 and 4.06 — over the 4-sigma bar on both. The code computed the
number that catches it and did not look at it,** because a 23 m sigma on a 163 m carry
is 14.13 % and the threshold is 15 %.

This is the fix agent's own diagnosis surviving one notch below their own threshold. Their
sentence was: *"the looser the pixels, the more agreeable every GPS reading looks. The test
is circular."* That is true at 14 % exactly as it is at 16 %; 15 % is a line the failure
does not respect.

### Scale, on my own sweep — 9 072 clips

```
$ node --import tsx …/sweep.ts
ran 9072 traceClip calls over 648 geometries x 14 carries
drawn-with-a-number 8288 | no-distance 64 | skipped 720 | threw 0
=== numbers more than 25% from truth: 56
=== GPS-BACKED numbers more than 15% from truth: 211
decision histogram {"fit":3613,"pixel_only_fallback":4739,"none":720}
carry status histogram {"null":5824,"carry_tension":1688,"carry_consistent":1522,"carry_as_scale":38}
label kind histogram {"number":8288,"SKIP":720,"no distance":38,"down the line":26}
RESULT: FAIL
```

**52 of the 56 worst rows are `carry_tension` with `gpsBacked=true`.** The other 4 are
`pixel_only_fallback` rows honestly marked `· no GPS` (a pixel failure, not a GPS one).
Every failing row has launch angle 10 deg — the flattest in the sweep, where depth is
weakly determined and the joint fit is most pliable.

### What the obvious fix would cost, measured rather than asserted

Dropping the `asScale &&` conjunct at `lib/tracerFit.ts:1436` — testing `zScale`
unconditionally at the same 4-sigma bar. Simulated offline from the exposed
`carryZNoPixelSigma`; **I edited no file.**

```
$ node --import tsx …/cost.ts
CORRECT readings (truth +-5%): 801
  would newly be rejected as carry_inconsistent by an UNCONDITIONAL zScale test: 2  (0.2%)

WRONG readings (0.35x / 0.5x of truth): 534
  caught TODAY (carry_inconsistent): 246  (46.1%)
  caught WITH the unconditional test: 512  (95.9%)

wrong readings the unconditional test would newly catch (first 10):
  fps30 f4 v55 th10 rpm3400 D=58 (truth 165) status=carry_tension z=3.40 zNoPx=5.17 -> joint carry 102
  fps30 f4 v55 th10 rpm5200 D=60 (truth 171) status=carry_tension z=3.50 zNoPx=5.13 -> joint carry 103
  fps30 f4 v55 th14 rpm2200 D=82 (truth 164) status=carry_tension z=3.22 zNoPx=4.26 -> joint carry 128
  fps30 f4 v55 th14 rpm3400 D=61 (truth 176) status=carry_tension z=4.00 zNoPx=5.22 -> joint carry 124
  fps30 f4 v68 th10 rpm2200 D=72 (truth 207) status=carry_tension z=3.73 zNoPx=5.43 -> joint carry 137
```

**A GPS carry that is half the truth is caught 46 % of the time today and 96 % of the time
with the conjunct removed, and the price on correct readings is 2 in 801 (0.2 %).** That is
the trade Henry's rule asks for, in the direction it asks for, and it is one conjunct in a
line that already exists. I did not apply it — I am the gate, and a change to the carry
verdict needs its own reproduction test committed alongside it.

**A second, independent option** (they are complementary, not alternatives): make
`carry_tension` widen the label the way NEW-1(b) made `carry_as_scale` widen it. Under
tension the fit's own sigma was 12.7 m while the error was 65 m, which is F4's argument
verbatim.

---

## GATE-2 — MEDIUM (latent, machine-pinned) · a prior-driven arc states the GPS carry as a
## measured distance, from one pixel

The brief named `a prior-driven arc` as a path to check. It is the one that produces the
number most directly, and my probe reached it:

```
truth carry of the underlying flight = 236.5 m

K=1 gps=  5  dec=pixel_only_fallback  "110 m" / "apex 17 m · no GPS"
K=1 gps= 20  dec=pixel_only_fallback  "110 m" / "apex 17 m · no GPS"
K=1 gps= 60  dec=prior  status=carry_tension     "60 m"  / "apex 14 m"     <- GPS-backed
K=1 gps=150  dec=prior  status=carry_consistent  "140 m" / "apex 24 m"     <- GPS-backed
K=1 gps=250  dec=pixel_only_fallback  "110 m" / "apex 17 m · no GPS"

bucket-forced driver, K=1:
  gps=150  "140 m" / "apex 10 m"  flags=prior|carry_tension|few_frames:1|
           underdetermined:2_pixel_equations_for_4_free_params(prior-driven)|
           carry_untested(no_usable_pixel_only_carry_sigma)
```

The club prior sets speed and launch, the GPS sets the scale, **one pixel sets the
direction**, and the pill reads as a measurement. This is review **F7**, and I confirm the
review's reachability finding rather than contradicting it:

- `chooseModel` returns `'prior'` only for `nUsed < MIN_FIT` (`lib/tracerV3.ts:673`).
- `selectDetections` can never reduce `used` below `min(nDets, 3)` — the three branches are
  `dets`, `early` (guarded `>= MIN_FIT`), or `dets.slice(0, MIN_FIT)` (`:633-644`). I read
  all three rather than assuming.
- So `nUsed < 3` requires the detector to emit fewer than 3, and it will not:
  `TracerDetectCore.swift:2263` `scored.count >= params.minTrackEmit`, default 3
  (`:76`), fed from `config.tracer.v3.detectMinTrackEmit = 3` (`constants/config.ts:439`,
  `modules/shot-detector/index.ts:920`). **The dev-settings screen does not expose it** —
  `grep detectMinTrackEmit app/profile/tracer-dev-settings.tsx` returns nothing.
- `tests/tracerV3Refusals.test.ts:113` asserts `detectMinTrackEmit >= 3`, so the
  unreachability is machine-checked, not a comment.

**So it is latent, and it is the right call to have left it.** I record it because the
brief asked for that path by name and because the guard is two module boundaries away in
Swift, behind a value clamped only to `max(1, v)` (`TracerDetect.swift:69`).

**Also settled here:** the fix agent wrote that the residual `carry_untested` status
"still labels as GPS-backed" and that they "could not construct an input that reaches it".
**I did — it is this path,** and only this path. At K >= 3 it never appears:

```
$ node --import tsx …/untested.ts
2268 clips; carry_untested GPS-backed numbers: 0
status histogram {"null":1414,"carry_tension":430,"carry_consistent":387,"carry_as_scale":37}
```

---

## GATE-3 — LOW (honesty) · the revert comment's "FOUR things survive" is short

`constants/config.ts:534` says *"FOUR things survive the revert"* and lists the route, the
schema migration, the two capture columns and the record-screen subscription. **All four are
true — I checked each against the code (see check 5).** But the list is not complete:

- `lib/gpsSession.ts:623` constructs the module-level `gpsSession` singleton on import,
  unconditionally (review F11's second half).
- The 5.9 MB `.mlpackage`, `CoreML` linked, and two `AsyncFunction` registrations ship in
  every binary regardless of the flag (review F12).

Neither executes work and both are disclosed elsewhere (`verify.md`, `native-detect.md`,
`review.md`). It is the same class as NEW-3 — a comment that reads as exhaustive and is not
— and NEW-3 was raised precisely because this comment had drifted once already. Cheapest
fix is one clause: *"FOUR things survive in the JS layer; the binary payload (F12) and the
`gpsSession` singleton (F11) are separate and disclosed there."*

---

# 1. `npm run verify`

```
$ cd /Users/hendacow/projects/clippar/final_shipment/clippar_app && npm run verify
> clippar_app@1.1.0 verify
> npm run typecheck && npm run test

> clippar_app@1.1.0 typecheck
> tsc --noEmit
                                        # no output — tsc is clean

> clippar_app@1.1.0 test
> node --import tsx --test tests/*.test.ts
…
ℹ tests 838
ℹ suites 0
ℹ pass 838
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 67931.577542
EXIT=0
```

**838 tests, 0 failures, 0 skipped, 0 todo, tsc clean, exit 0.** Floor was 830, so **+8**.
Run twice end to end, same result both times.

**Nothing was weakened**, checked rather than taken from `fixes.md`:

```
$ grep -rnE "\.skip\(|\.todo\(|\bskip: *true|\btodo: *true|\.only\(|xtest\(|xit\(|describe\.only|it\.only" tests/
$                                        # exit 1 — no matches anywhere in tests/
```

and the +8 closes exactly against the three files the fix agent named:

```
$ for f in tests/tracer*.test.ts tests/gpsSession.test.ts; do echo "$(grep -cE '^\s*test\(' $f)  $f"; done
14  tests/tracerCamera.test.ts        30  tests/tracerV3Refusals.test.ts   <- was 26 (+4)
 5  tests/tracerClaims.test.ts        32  tests/tracerV3Wiring.test.ts     <- was 30 (+2)
28  tests/tracerFit.test.ts           31  tests/tracerV3.test.ts           <- was 26 (+2)
 4  tests/tracerMath.test.ts          25  tests/gpsSession.test.ts
24  tests/tracerPhysics.test.ts

$ ls tests/*.test.ts | wc -l
      62
```

830 + 4 + 2 + 2 = **838**. 62 test files, none missing.

**The new tests are real, not decorative.** I read all six. The two fit-level ones
(`tests/tracerFit.test.ts:373`, `:407`) run on the **real clip `IMG_3649`**, not a
synthetic, and the first asserts that the lab's own `z` is **under** the bar — so the test
cannot pass for the wrong reason — while the pixel-sigma-free `z` is over it. The second
pins the bound (a −30 % error is still `carry_as_scale`, not a refusal). The NEW-2 test
(`tests/tracerV3Wiring.test.ts:384`) is a source-text test that checks the snapshot is
taken **before** `setIsRecording(false)` by string index, that the save consumes it, that
both callbacks check `recordingBusy` and no longer check `camera.isRecording`, and that
both Pressables carry `disabled={recordingBusy}`.

---

# 2. GATE-1: the property, reproduced independently

My own fixture, geometry in the table at the top. Smoke test first, so a failure below is
the ladder's and not the fixture's:

```
$ node --import tsx …/smoke.ts
F_PX 1729.8 1440x2560
truth carry 236.5 apex 34.7 hang 7.06
no-gps: fit null 240 m / apex 35 m · no GPS fit carry 237.0 sigmaCarry 30.8
flags fpx_is_prior(+-12%_on_v0) | arc_end:fitted
```

The fixture is recovered to **+0.2 %** with no GPS, so every error below is the GPS's.

### 2a. The sweep — 5 m to 500 m, 648 geometries

`fps {30,60} x frames {4,5,6,8,10,14} x v0 {55,68,78} x theta {10,14,18} x rpm
{2200,3400,5200} x phi {1,5}`, each against `null` and 13 GPS carries from 5 m to 500 m.
Output quoted in full in GATE-1 above. **RESULT: FAIL** — 56 drawn numbers more than 25 %
from truth, 52 of them GPS-backed.

### 2b. NEW-1's own fix DOES hold on my geometry — checked separately

`carry_as_scale` fires 11 times on my geometry, and **every one drops the distance**:

```
$ node --import tsx …/asscale.ts
carry_as_scale reached 11 times on my geometry:
  f5 v72 th11 rpm3800 gps=150 truth=243 sigma=22 "no distance" / "GPS unchecked"
     carry_as_scale(pixel_carry_sigma=62%>15%,z=-0.2,z_no_pixel_sigma=-0.9),
     carry_as_scale_no_distance(honest_sigma=76m>10m)
  f6 v72 th11 rpm2400 gps= 90 truth=232 sigma=14 "no distance" / "GPS unchecked"
     carry_as_scale(pixel_carry_sigma=17%>15%,z=2.4,z_no_pixel_sigma=3.9),
     carry_as_scale_no_distance(honest_sigma=27m>10m)
  … (11 rows)

of those, 0 still drew a NUMBER:
```

**NEW-1(b) works on geometry it was not tuned to, and NEW-1(a) works too** — GPS carries of
5, 15 and 40 m never reached `carry_as_scale` at all on my fixture; they became
`carry_inconsistent` and fell back to pixel-only. The fix agent's work is genuine. GATE-1
is the band it does not cover.

### 2c. Short shots, where `carry_as_scale` keeps its number by design

The fix agent's sweep used 200–260 m truths. NEW-1(b) only drops the distance when the
honest sigma exceeds 10 m, so on a short shot the number survives — deliberately. I swept
chips to mid-irons (24–139 m truths) against GPS carries of 3–500 m:

```
=== GPS-backed numbers >25% from truth on SHORT shots: 1
worst GPS-backed error: -30%  ->  pitch v0 22 th 34 f6 gps=20 truth=42.7 "30 m"/"apex 8 m"
                                  status=carry_tension
```

One row, and it is `carry_tension` again — the same GATE-1 mechanism, 13 m absolute on a
43 m pitch against a claimed sigma of 6.5 m. The band is bounded on both sides: a GPS carry
of 10 m (−76 %) and one of 90 m (+111 %) are both correctly discarded to `pixel_only_fallback`.

---

# 3. The refusal suite, plus my own inputs, `forceTrace` OFF and ON

### 3a. The committed suite

```
$ node --import tsx --test tests/tracerV3Refusals.test.ts
✔ a detector that found no address ball never draws, with or without the bypass
✔ no detections, and one or two without a GPS carry, never draw
✔ a track of 1-2 detections plus a carry is prior-driven and says so in every field
✔ no camera pitch is a refusal, not a guessed pitch
✔ a near-static blob is refused with or without a GPS carry
✔ a topped ball is refused on the physics floor, not on the residual
✔ a rolling putt the classifier called a SWING is still refused
✔ a putt the classifier called a putt is refused before any fitting
✔ a divot and a tossed ball, tracked as long as a real one would be, are refused
✔ F1 x3 · NEW-1 x4 · F3a x4 · F2 x3 · F4 x2 · F5 x2 · F8 x2 · diagnostics x1
ℹ tests 30  ℹ pass 30  ℹ fail 0  ℹ skipped 0  ℹ todo 0
```

### 3b. My own 24 inputs, each run with `forceTrace` OFF and ON

```
force OFF  detector found nothing             SKIP  detector_found_no_address_ball
force ON   detector found nothing             SKIP  detector_found_no_address_ball
force OFF  address ball null                  SKIP  detector_found_no_address_ball
force ON   address ball null                  SKIP  detector_found_no_address_ball
force OFF  zero detections                    SKIP  no_detections
force ON   zero detections                    SKIP  no_detections
force OFF  1 detection, no carry              SKIP  too_few_detections_no_carry(1)
force ON   1 detection, no carry              SKIP  too_few_detections_no_carry(1)
force OFF  2 detections, no carry             SKIP  too_few_detections_no_carry(2)
force ON   2 detections, no carry             SKIP  too_few_detections_no_carry(2)
force OFF  no camera pitch                    SKIP  no_camera_pitch(CoreMotion sample missing)
force ON   no camera pitch                    SKIP  no_camera_pitch(CoreMotion sample missing)
force OFF  fps 0 / bad geometry               SKIP  detector_geometry_invalid(fps=0, 1440x2560)
force ON   fps 0 / bad geometry               SKIP  detector_geometry_invalid(fps=0, 1440x2560)
force OFF  unknown lens                       SKIP  lens_unsupported:shot at lens=unknown zoom=unknown
force ON   unknown lens                       SKIP  lens_unsupported:shot at lens=unknown zoom=unknown
force OFF  lens 0.5x                          SKIP  lens_unsupported:shot at lens=0.5x zoom=0.000
force ON   lens 0.5x                          SKIP  lens_unsupported:shot at lens=0.5x zoom=0.000
force OFF  pinch zoom 0.35                    SKIP  lens_unsupported:shot at lens=1x zoom=0.350
force ON   pinch zoom 0.35                    SKIP  lens_unsupported:shot at lens=1x zoom=0.350
force OFF  classifier says putt               SKIP  putt
force ON   classifier says putt               DRAWN "240 m" / "apex 35 m · no GPS"   <- judgement, bypassable by design
force OFF  static blob 12f                    SKIP  not_a_flight:track never climbs (max rise 1 px)
force ON   static blob 12f                    DRAWN "0 m" / "apex 0 m · no GPS"
force OFF  static blob 12f + GPS 150          SKIP  not_a_flight:track never climbs (max rise 1 px)
force ON   static blob 12f + GPS 150          DRAWN "0 m" / "apex 0 m · no GPS"
force OFF  random noise 12f                   SKIP  track_not_ballistic:rms 854.6 px > 11 px over 12 frames
force ON   random noise 12f                   DRAWN "30 m" / "apex 2 m · no GPS"
force OFF  random noise 12f + GPS 220         SKIP  track_not_ballistic:rms 854.6 px > 11 px over 12 frames
force ON   random noise 12f + GPS 220         DRAWN "30 m" / "apex 2 m · no GPS"
force OFF  only ever falling 10f              SKIP  not_a_flight:track never climbs (max rise -1 px)
force ON   only ever falling 10f              DRAWN "0 m" / "apex 0 m · no GPS"
force OFF  topped ball                        SKIP  not_a_flight:fitted v0 12.0 m/s, apex 0.03 m, hang 0.13 s
force ON   topped ball                        DRAWN "2 m" / "apex 0 m · no GPS"
force OFF  rolling putt (classified swing)    SKIP  not_a_flight:fitted v0 39.8 m/s, apex 0.02 m, hang 0.01 s
force ON   rolling putt (classified swing)    DRAWN "0 m" / "apex 0 m · no GPS"
force OFF  divot v0 14 th 45                  SKIP  track_not_ballistic:rms 11.1 px > 11 px over 10 frames
force ON   divot v0 14 th 45                  DRAWN "20 m" / "apex 5 m · no GPS"
force OFF  all conf 0                         DRAWN "240 m" / "apex 36 m · no GPS"   <- review F14
force ON   all conf 0                         DRAWN "240 m" / "apex 36 m · no GPS"
force OFF  PRIOR: 1 detection + GPS 150       DRAWN "140 m" / "apex 24 m"            <- GATE-2
force ON   PRIOR: 1 detection + GPS 150       DRAWN "140 m" / "apex 24 m"
force OFF  PRIOR: 2 detections + GPS 150      DRAWN "down the line" / "no distance"
force OFF  PRIOR: 2 detections + GPS 500      DRAWN "down the line" / "no distance"
force OFF  PRIOR: 1 spurious det + GPS 150    DRAWN "down the line" / "no distance"

absence-of-evidence violations (must skip under BOTH settings): 0
```

**PASS on the property that matters.** Every **absence of evidence** — no address ball, no
detections, too few detections without a carry, no camera pitch, invalid geometry, unknown
or non-1x lens, any pinch — refused under **both** `forceTrace` settings. Every
not-a-golf-shot input refused with `forceTrace` off.

Two readings that are not failures but belong on the record:

- **`all conf 0` draws.** Review F14 re-confirmed on a third geometry: the ladder never
  refuses on confidence, it only doubles the pixel sigma. The discrimination is upstream in
  Swift (`confMean >= 0.4`). Known, accepted.
- **My divot skipped where the review's drew.** `track_not_ballistic:rms 11.1 px > 11 px` —
  by 0.1 px. That is a coincidence of my geometry, not a guard; F14 stands.

---

# 4. NEW-2, confirmed closed by reading the source

**Both remedies are present. Nothing here was pressed on a device — I did not run this on a
phone, and no Swift was compiled or executed.**

### The snapshot (the real fix)

`hooks/useCamera.ts:1048`, inside `stopRecording`, in a `try`:

```ts
capturedOpticsRef.current = getCaptureOpticsRef.current?.() ?? null;
```

It is at **line 1048**; `isRecordingRef.current = false` is at **:1072** and
`setIsRecording(false)` at **:1073**. So the read happens **before** the eager state flip —
which is what re-verify identified as the moment the controls came back to life. The save
consumes it at `:601-602` and only falls back to a live read when it is null (`:606`, a
recording that ended without passing through `stopRecording`), and `startRecording` clears
it at `:328` so a stop that never reached a save cannot hand its framing to the next clip.

### The guards (the house pattern)

`app/(tabs)/record.tsx`: `recordingBusy = camera.isRecording || camera.isFinalizing`
(`:374`); `flipCamera` `if (recordingBusy) return;` (`:407`); `selectZoom`
`if (recordingBusy) return;` (`:416`); `disabled={recordingBusy}` on the zoom pill (`:2021`)
and the flip button (`:2042`). All four sites are `recordingBusy`, none is
`camera.isRecording`.

`applyZoom` (`:392-394`) only ever **raises** `captureZoomPeak`, so a pinch after the stop
press cannot lower it either — and with the snapshot taken at the press it cannot reach the
saved clip at all.

### What "closed" does not mean

**This was not pressed on a device.** The check for whoever has a phone: pinch to a visible
zoom, record, press stop, tap "1x" (it should now be greyed out and inert) within the
finalize window, then read `capture_zoom` off the row. It must be the pinched value.

---

# 5. Reversibility with the flag off, and the revert comment clause by clause

**The flag really is off under node**, so §1 and §3 are the off-path run, not a claim about it:

```
$ node --import tsx …/flag.ts
tracer.enabled = false | engine = v3 | v3.forceTrace = false | detectMinTrackEmit = 3
```

| Clause in `constants/config.ts` | Checked how | Verdict |
|---|---|---|
| "no GPS session" | `hooks/useGpsSession.ts:40` `isActive = enabled && config.tracer.enabled && …`; `startWatch` `if (!isActive) return;` on its **first line** (`:75`) | **true** |
| "no detection, no render" | every `detectShotV3` / `traceClip` / `renderTracerV3` call site is inside `processAllTracers`, whose first line is `if (!config.tracer.enabled \|\| !storage \|\| !roundId) return;` (`hooks/useEditorState.ts:1326`) | **true** |
| "no UI reachable by tapping" | the pushing row is `{isDevVariant() && config.tracer.enabled && (…)}` (`app/(tabs)/profile.tsx:840`) | **true** |
| **no permission prompt** | `getForegroundPermissionsAsync` (`:82`), `requestForegroundPermissionsAsync` (`:92`) and `watchPositionAsync` (`:105`) are **all** inside `startWatch`, below its early return. `AppState.addEventListener` is at `:186` behind `if (!isActive) return` at `:179`; `setInterval` at `:193` behind the guard at `:192` | **true — this is the one that mattered** |
| survivor 1: the route is registered, unguarded | `app/profile/tracer-dev-settings.tsx` exists as a route file; `grep -n "config.tracer.enabled\|Redirect"` inside it returns nothing | **true** |
| survivor 2: schema migration flag-independent | `lib/storage.ts:137,141,147,169,170` — five `ALTER TABLE … ADD COLUMN` in one ungated list | **true** |
| survivor 3: `capture_lens` / `capture_zoom` **WRITTEN, non-null** | `hooks/useCamera.ts:663-664` bind them, **outside** the `if (tracerV3Gps)` block at `:598` | **true — NEW-3 is genuinely fixed** |
| survivor 4: one focus subscription + one state object per mount | `useFocusEffect` registered unconditionally with a gated body (`:160-174`); one `useState<GpsHealth>` (`:42`) | **true** |
| "FOUR things survive" | see **GATE-3** | **short** — the `gpsSession` module singleton (`lib/gpsSession.ts:623`) and the binary payload (F12) also survive |

The NEW-3 test (`tests/tracerV3Wiring.test.ts:443`) makes the disagreement fail a test
rather than wait for a later agent, which is the right shape.

---

# 6. The diff, read for accidents (READ-ONLY — no git command in this session wrote)

```
$ git status --short
 M ../TRACER_V3_PLAN.md            ?? lib/{tracerV3,tracerFit,tracerCamera,tracerPhysics,gpsSession}.ts
 M app/(tabs)/profile.tsx          ?? hooks/useGpsSession.ts
 M app/(tabs)/record.tsx           ?? app/profile/tracer-dev-settings.tsx
 M constants/config.ts             ?? modules/shot-detector/ios/{TracerDetect,TracerDetectCore,TracerRenderV3}.swift
 M docs/tracer-v3/NEXT.md          ?? modules/shot-detector/ios/GolfBallDetector.mlpackage/
 M hooks/useCamera.ts              ?? tests/{gpsSession,tracerCamera,tracerFit,tracerPhysics,
 M hooks/useEditorState.ts            tracerV3,tracerV3Refusals,tracerV3Wiring}.test.ts
 M lib/storage.ts                  ?? tests/fixtures/  ?? docs/tracer-v3/
 M modules/shot-detector/index.ts
 M modules/shot-detector/ios/ShotDetector.podspec
 M modules/shot-detector/ios/ShotDetectorModule.swift
 (plus 7 paths that predate this work: ../.vercel/, ../CLIPPAR_PTY_LTD_APPLE_ACCOUNT.md,
  .playwright-mcp/, reg90.txt (dated 18 Aug), ../clippar_mount/, ../logo_transparent/, ../migration/)

$ git diff --stat
 TRACER_V3_PLAN.md                                  |  35 ++-
 clippar_app/app/(tabs)/profile.tsx                 |  27 ++
 clippar_app/app/(tabs)/record.tsx                  |  92 ++++++-
 clippar_app/constants/config.ts                    | 274 ++++++++++++++++++-
 clippar_app/docs/tracer-v3/NEXT.md                 |   9 +-
 clippar_app/hooks/useCamera.ts                     | 134 ++++++++-
 clippar_app/hooks/useEditorState.ts                | 298 ++++++++++++++++++++-
 clippar_app/lib/storage.ts                         | 139 +++++++++-
 clippar_app/modules/shot-detector/index.ts         | 122 +++++++++
 .../modules/shot-detector/ios/ShotDetector.podspec |   8 +-
 .../shot-detector/ios/ShotDetectorModule.swift     |  58 ++++
 11 files changed, 1161 insertions(+), 35 deletions(-)
```

| Check | Result |
|---|---|
| Scratch files | **none new.** `docs/tracer-v3/` holds 12 files; the two the review named are gone. `labCheck.ts` remains — a disclosed research tool, not imported by any app or test file (`grep -rn labCheck app hooks lib components constants modules tests` exits 1), so it is typechecked but never bundled. Judgement call, not a violation. |
| `GolfBallDetector.mlpackage` on disk | **yes, 5.9 MB, all three files** — `Manifest.json`, `Data/com.apple.CoreML/model.mlmodel`, `Data/com.apple.CoreML/weights/weight.bin` |
| …in git? | **NO.** `git ls-files …mlpackage` → 0 files. `git check-ignore` → exit 1 (not ignored — never added). **Review F3 is unchanged and still blocks any build.** One `git add` by the seat. |
| Debug prints on a per-frame path | **none.** `TracerDetect.swift` and `TracerDetectCore.swift` — the per-frame code — have **0** `print(`, `NSLog`, `os_log`, `debugPrint`. `TracerRenderV3.swift` has 5 `print(`, all once-per-render or error paths (`:1645` freeze failure, `:1686` occlusion degraded, `:1755` background expiry, `:1783` FAIL, `:1791` OK). `lib/{tracerV3,tracerFit,tracerPhysics,tracerCamera,gpsSession}.ts` have **0** `console.*`. The 6 `console.*` in the tracked diff are 4 inside `__DEV__` or the gated V3 branch (`useCamera.ts:565`, `:623`; `useEditorState.ts`) and 2 `console.warn` for a missing native module. |
| Machine-absolute paths | **none.** `grep -rn "/Users/"` over all 18 new/changed TS + Swift files: exit 1. |
| `tracer-lab` at runtime | **none.** Every mention is inside a provenance comment; filtering comment lines leaves zero hits. |
| `TODO` / `FIXME` / `XXX` / `HACK` | **none** in any new file. |
| `git add -A` hazard | unchanged and still real — 7 untracked paths predate this work. **Name the paths.** |

---

# 7. Swift

`SDK=$(xcrun --sdk iphoneos --show-sdk-path)` =
`/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.5.sdk`.
No `pod install` in this checkout, so **nothing was compiled into an app and nothing ran.**

```
$ for f in *.swift; do out=$(xcrun swiftc -parse -sdk "$SDK" -target arm64-apple-ios15.0 "$f" 2>&1); \
    echo "=== swiftc -parse $f : exit=$? ==="; [ -n "$out" ] && echo "$out"; done
=== swiftc -parse ShotDetectorModule.swift : exit=0 ===
=== swiftc -parse ShotTracer.swift : exit=0 ===
=== swiftc -parse TracerDetect.swift : exit=0 ===
=== swiftc -parse TracerDetectCore.swift : exit=0 ===
=== swiftc -parse TracerRenderV3.swift : exit=0 ===

$ xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios15.0 \
      TracerDetectCore.swift TracerDetect.swift TracerRenderV3.swift
exit=0                                        # no output

$ # singly, for the record
--- TracerDetectCore.swift : exit=0
--- TracerDetect.swift : exit=1   TracerDetect.swift:41:25: error: cannot find 'TracerParams' in scope
--- TracerRenderV3.swift : exit=0
--- ShotDetectorModule.swift : exit=1   ShotDetectorModule.swift:1:8: error: no such module 'ExpoModulesCore'
--- ShotTracer.swift : exit=1           ShotTracer.swift:1:8: error: no such module 'ExpoModulesCore'
```

`TracerDetect.swift` names types declared in `TracerDetectCore.swift` — that is the point of
the split, and the three-file typecheck is the check that matters. The two `ExpoModulesCore`
failures are the missing pods, not the code. **This reproduces `re-verify.md` §4 exactly.**

**What "clean" does NOT mean:** no file was compiled to object code, linked, signed,
installed or run. Expo's `AsyncFunction` marshalling, Core ML loading, the `.mlpackage` →
`.mlmodelc` compile-and-cache, every Vision call and every AVFoundation export path are
**entirely unverified**, and the seam through `ShotDetectorModule.swift` cannot be
typechecked here at all.

---

# 8. What I could NOT verify

- **Nothing ran on a device and no frame was rendered.** See §7.
- **NEW-2 was not pressed on a phone.** Source and source-text test only.
- **`getCaptureOptics` has still never been called by a real recording**, and the two
  capture columns have never been written by a real `saveLocalClip`.
- **My fixtures are simulated flights projected through a known camera.** They prove the
  ladder recovers a flight it is *given*. They say nothing about whether the Swift detector
  finds a ball on real footage — which is still the biggest unmeasured thing in this branch.
- **GATE-1's field frequency is unmeasured.** I know it needs a launch angle around 10 deg,
  4–8 detections, and a pixel-only carry sigma in roughly the 8–15 % band (14.13 % on the
  worst clip). What fraction of real clips land there is unknown. Every failing row in my
  sweep was at the flattest launch angle I tested.
- **I did not apply the GATE-1 fix, and the 0.2 % / 95.9 % figures are simulated offline**
  from the exposed `carryZNoPixelSigma` rather than measured after an edit. They are
  arithmetic on real fit output, not a run of the changed code.
- **I did not re-derive the 4-sigma bar, `AS_SCALE_FRAC = 15 %`, `Z_TENSION = 2.0`, or F4's
  `axis_degenerate` threshold.** They are the lab's numbers, reused.
- **I did not re-run the lab-vs-port numerical comparison** (`verify.md` §5).
- **GPS end to end.** No fix from a real receiver has been through the ring, the impact
  anchor or the re-derivation.

---

# 9. Everything I ran, in order

| # | Command | Result |
|---|---|---|
| 1 | `npm run verify` (x2) | tsc clean, **838/838**, 0 skip/todo, exit 0 |
| 2 | `grep -rnE "\.skip\(\|\.todo\(\|\.only\(\|xit\("` over `tests/` | exit 1 — nothing parked |
| 3 | per-file `test(` counts, `ls tests/*.test.ts \| wc -l` | 830 + 4 + 2 + 2 = 838, 62 files |
| 4 | `…/smoke.ts` — my fixture | truth 236.5 m, pixel-only fit +0.2 % |
| 5 | `…/sweep.ts` — 9 072 `traceClip` calls, 648 geometries x 14 carries | **FAIL — 56 numbers >25 % out, 52 GPS-backed → GATE-1** |
| 6 | `…/worst.ts` — the failing rows in full | −39 % at `gps=80` against a 164.6 m truth |
| 7 | `…/mech.ts` — fit level | `rel = 14.13 %` (< 15 %), `zNoPixelSigma = 5.04` unchecked |
| 8 | `…/cost.ts` — what the one-conjunct fix costs | 0.2 % of correct readings; 46 % → 96 % of wrong ones caught |
| 9 | `…/asscale.ts` — does NEW-1(b) hold on my geometry | 11 hits, **0 drew a number** — the fix works |
| 10 | `…/short.ts` — chips to mid-irons vs 3–500 m carries | 1 bad row, `carry_tension`, −30 % |
| 11 | `…/tension.ts` — the tension band characterised | bounded both sides; worst −30 % at a −53 % GPS reading |
| 12 | `…/prior.ts` + `…/untested.ts` (2 268 clips) | GATE-2; `carry_untested` unreachable at K >= 3 |
| 13 | `…/refuse.ts` — 24 inputs x `forceTrace` both ways | **0 absence-of-evidence violations** |
| 14 | `node --import tsx --test tests/tracerV3Refusals.test.ts` | 30/30 |
| 15 | `swiftc -parse` x5, `-typecheck` the three together and singly | exit 0 / exit 0 |
| 16 | `git status --short`, `git diff --stat`, `git ls-files`, `git check-ignore` | read-only; model on disk, **not in git** |
| 17 | grep sweeps: `/Users/`, `tracer-lab`, `console.`, `print(`, TODO | clean as tabled in §6 |

---

# VERDICT — is this safe to commit and put in a dev build for a field test?

## Commit: **YES.** Dev build with distances on: **NO.** Dev build for the field test that actually matters: **YES, with three capture instructions.**

**Commit it.** 838 green, nothing weakened, tsc clean, Swift parses and typechecks, no
scratch files, no debug prints on a per-frame path, no machine paths, no lab paths at
runtime, and the revert is honest about what it leaves behind. **This is a better branch
than the one re-verify read, and NEW-1, NEW-2 and NEW-3 are genuinely closed** — I
reproduced NEW-1's fix working on geometry it was never tuned to. Leaving it uncommitted
blocks everyone and protects nobody.

**Do not run a field test that reads distances off the pill until GATE-1 is closed.** A
GPS carry that is half the truth is thrown away only 46 % of the time; the rest are folded
in and drawn GPS-backed, and I measured −39 % on a shot the app's own pixels had right to
4 %.

**The field test worth running this week is the one that measures the thing nobody has
measured — whether the Swift detector finds the ball — and it does not need the GPS at
all.** Three instructions, and they are the same ones the review and re-verify both landed
on:

1. **`git add clippar_app/modules/shot-detector/ios/GolfBallDetector.mlpackage` before the
   build.** Without it the ball model is silently absent, the detector degrades to blob +
   pose, and the test measures a pipeline nobody built. Then check
   `tracer_meta.detectorNotes.coreml === "ok"` on the first clip.
2. **Set `carryM: null` for this outing.** With no GPS carry, GATE-1 cannot fire — it lives
   entirely in the carry verdict — and neither can F1 or F5. Every render is pixel-only and
   honestly marked `· no GPS`.
3. **Capture at 1x with no pinch, phone level-ish, at least 1–2 degrees off the shot line,
   and `forceTrace` OFF.** Any other lens or any pinch is refused outright (correctly), a
   shot exactly down the axis loses its distance to F4, and `forceTrace` will draw arcs over
   putts and divots.

**If the GPS half is wanted in the first outing instead, GATE-1 is one conjunct** —
`lib/tracerFit.ts:1436`, drop `asScale &&` so the pixel-sigma-free z is tested on every
fit. Measured cost: **2 correct readings in 801 lost, 266 more wrong ones caught.** It
needs the reproduction above committed as a test beside it, on a fixture at launch angle
10 degrees, because neither existing fixture reaches this band.
