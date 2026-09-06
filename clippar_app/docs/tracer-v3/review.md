# Tracer V3 — adversarial review

**Reviewer:** `skeptic`, 6 Sep 2026. **Scope:** the whole `feat/tracer-v3` working tree against
`feat/onboarding-fast-value`, read against `~/projects/clippar/tracer-lab`.

**I changed no code.** Every probe I wrote lived in `clippar_app/tests/.skeptic/` and has been
deleted; `git status --short` is exactly what it was when I started. Everything below is either
something I ran, or something I read and can point at by line.

---

## Verdict

**GO for a dev build, conditional on three things being done first.** The maths is a faithful,
independently-reproducible port — I ran the lab's Python and the port's TypeScript side by side and
they agree to four significant figures on every club bucket and every TrackMan target. The refusal
ladder does refuse: every absence-of-evidence path skips, and I could not find an input with no ball
in it that produced an arc.

**None of the three blockers is in the maths.**

1. **`GolfBallDetector.mlpackage` is not in git** (**F3**). The podspec references it. Build it as it
   stands and the ball model is silently absent — the detector degrades to blob + pose and the
   field test measures the wrong pipeline.
2. **The record screen's 0.5× lens toggle and its pinch zoom silently rescale every distance**
   (**F3a**). `getCameraFovDeg()` hard-codes the 1× wide lens, so a clip shot at 1.5× pinch is drawn
   cleanly as **"140 m" when the shot was 202 m**, and a clip on 0.5× misses the implausibility cap
   by one metre of apex. Nothing records which lens or zoom a clip was shot at. This needs no
   coincidence — one gesture on the capture screen does it.
3. **A wrong GPS carry can be laundered past the inconsistency check** (**F1**). Reproduced: a 40 m
   GPS reading against a 204 m pixel track is detected as `carry_inconsistent(z=6.3σ)` by the primary
   fit, then silently accepted by the refit that follows, and drawn as **"210 m · apex 35 m"** with
   the "no GPS" honesty marker removed.

**F1 and F3a are the same failure wearing two hats:** the product stating a confident wrong distance
rather than skipping. They are the only two paths I found that do it. Fix them and this is worth
putting on a phone. Everything else on this list can ride into the
first field test as long as it is written down, which is what the rest of this document is for.

---

## Findings, ranked

Severity is "what would this cost Henry on a course", not "how hard was it to find".

### F1 — HIGH · CONFIRMED · a detected `carry_inconsistent` is laundered by the spin-bound refit

`lib/tracerV3.ts` decides the GPS verdict by reading `fit.flags` **on whichever fit the ladder
ended on**, not on the primary. `runFitLadder`'s rung 2 (backspin pinned at a bound → refit) can
replace the primary with a refit whose own carry status is `carry_untested`, because with
`fixSpin: true` the pixel-only companion's covariance goes singular and
`pixelOnly.summarySigma.carryM` comes back `NaN` (`lib/tracerFit.ts:1336-1377`). `traceClip` then
finds no `carry_inconsistent` flag and never takes the `pixel_only_fallback` branch.

Reproduction — the same 12-detection driver track, GPS carry 40 m:

```
=== GPS 40 === decision=fit reason=null
flags: fpx_is_prior(+-12%_on_v0) | carry_untested(no_usable_pixel_only_carry_sigma) | arc_end:fitted
  ladder primary               K=12 rms=0.77 v0=57.8 carry=135 acc=false
                               flags=[rpm_back_at_lower_bound, …, carry_inconsistent(z=6.3sigma)]
  ladder spin_bound:+pitch     K=12 rms=0.86 v0=52.8 carry=109 acc=false
                               flags=[…, carry_inconsistent(z=6.0sigma)]
  ladder spin_bound:spin_fixed K=12 rms=0.45 v0=63.9 carry=209 acc=TRUE
                               flags=[fpx_is_prior, carry_untested(no_usable_pixel_only_carry_sigma)]
final: apex=34.8 carry=209   LABEL "210 m" / "apex 35 m"
```

Compare GPS = 100 m on the identical track, where rung 2 does not fire: `carry_inconsistent(z=4.1σ)`
→ `pixel_only_fallback` → the GPS is correctly thrown away.

**Two separate defects meet here.**

*(a) `carry_untested` is not the conservative choice the comment says it is.* `lib/tracerFit.ts:1332`
reads: *"The lab substituted sigma = 0 for a missing Monte Carlo, which silently turns
`carry_as_scale` into `carry_consistent`; saying `carry_untested` instead is the one place this port
is deliberately more conservative than fit.py."* It is the opposite. With `sc = 0` the lab still
computes `z` — for D = 40 m against a 204 m pixel carry, `z ≈ 6.5σ` → `carry_inconsistent` → the GPS
is dropped. The port skips the test entirely and **uses the carry untested**. Substituting 0 only
loses the `carry_as_scale` rung, which is the *permissive* one; it never loses the *protective* one.

*(b) The verdict is read off the wrong fit.* Even with (a) fixed, reading `fit.flags` after the
ladder means a refit's opinion silently overwrites the primary's. The lab reads the flags of the fit
it renders too, but the lab's fits always carry a status, so it never sees a hole.

**Suggested fix, smallest first:** in `lib/tracerFit.ts`, when `scPx` is not finite, fall back to
`sc = 0` and compute `z` anyway (that is exactly `fit.py:889`), keeping `carry_untested` as an
*additional* flag rather than as a replacement for the test. Optionally also carry the primary's
worst carry verdict forward through `runFitLadder`.

**Cost of not fixing:** the single most embarrassing failure this pipeline can produce — a wrong
distance stated confidently, with the honesty marker removed — is reachable from a plausible field
input (a GPS carry that is short because the golfer laid up, or because the successor fix landed on
the cart path).

---

### F2 — HIGH · CONFIRMED · the lab's `impact_slack_frames` is dropped, and it costs recall, not safety

`selectDetections` sets `kImp = first - 1` and `fitLaunch` bounds `t0` hard to
`[impactFrame/fps, (impactFrame+1)/fps]` (`lib/tracerFit.ts:1022-1023`). The lab bounds it to
`[(k_imp − impact_slack_frames)/fps, (k_imp+1)/fps]`, where the slack comes from the **departure
cue** (`launch_frame`). The port computes no slack, and its own comment
(`lib/tracerV3.ts:509-513`) says the number "would be dead" — which is true of the code and false of
the consequence.

`launchFrame` and `impactFrameUsed` are therefore read by `traceClip` for **nothing except a
diagnostic flag**. The whole point of wave 4's departure cue is discarded at the seam.

Reproduction — the same true flight, dropping the first *N* detections (which is what a detector
does when the ball is fastest and blurriest just after impact), with `launchFrame` still correct:

| dropped early frames | result |
|---|---|
| 0 | **drawn** — v0 62.0, θ 13.0, carry 202 m, rms **0.01 px** (truth: 202 m) |
| 2 | **SKIP** `track_not_ballistic` — v0 pegged at 95, rms 17.4 px |
| 4 | **SKIP** `implausible_flight` — apex 75.5 m, rms 83.7 px |
| 6 | **SKIP** `implausible_flight` — apex 77.0 m, rms 88.4 px |
| 8 | **SKIP** `implausible_flight` — apex 83.0 m, rms 151.8 px |

Every one of those carries `t0_at_lower_bound` and `v0_at_upper_bound` — the optimiser is telling
you it is pinned against a bound it should not be at.

This is **safe** (it refuses rather than fabricates) but it is a **recall cliff**, and recall is
already the weak half of this pipeline: the plan itself says the detector finds the ball on ~half of
unseen footage. A two-frame late first detection is not an exotic case.

**Suggested fix:** thread `impactSlackFrames` (or simply a `t0LoFrame`) through `FitLaunchArgs` and
widen `tLo` to `min(launchFrame, first) / fps`. This is a `lib/tracerFit.ts` API addition, not a
maths change.

**Watch for it in the field as:** a lot of `track_not_ballistic` / `implausible_flight` skips whose
`meta.ladder[].flags` contain `t0_at_lower_bound`. That combination means F2, not a bad clip.

---

### F3 — HIGH · CONFIRMED · the 5.9 MB Core ML model is not tracked by git

```
$ git check-ignore -v …/GolfBallDetector.mlpackage/…/weight.bin   # exit 1 — not ignored
$ git status --short | grep mlpackage
?? clippar_app/modules/shot-detector/ios/GolfBallDetector.mlpackage/
```

`ShotDetector.podspec` now hard-references it. The precedent it cites — `swing-vision` — has its
69 MB `MobileCLIP2S2Image.mlpackage` **committed** (`git ls-files` confirms all three files). This
one is not.

The model itself is genuine and correct, and I verified it rather than taking the doc's word:

```
Manifest.json                         MATCH
Data/com.apple.CoreML/model.mlmodel   MATCH
Data/com.apple.CoreML/weights/weight.bin  MATCH
   (sha256 vs tracer-lab/experiments/det-yolo-ball/golfballyolov8n_640.mlpackage)
```
Its embedded metadata reads `Ultralytics golfball YOLOv8n`, `{0: 'golfball'}`, `[640, 640]`,
`quantize: 16`, `nms: False`, exported 2026-09-05 — i.e. exactly what `native-detect.md` claims.

**Failure mode if it is missed:** not a crash. `TracerBallModel.ensureLoaded()` sets
`loadError = "GolfBallDetector (.mlmodelc/.mlpackage) not found in any bundle"`, `available` stays
false, the address finder degrades to bright-blob + pose ROI, and `notes.coreml` records why
(`TracerDetect.swift:676`). That is good engineering and it is exactly what makes this dangerous:
**the field test would run, produce plausible-looking skips, and measure a pipeline that is not the
one that was built.**

**Fix:** `git add clippar_app/modules/shot-detector/ios/GolfBallDetector.mlpackage` before any build.
Then check `tracer_meta.detectorNotes.coreml === "ok"` on the first clip of the field test.

---

### F3a — HIGH · CONFIRMED · the record screen's lens toggle and pinch zoom silently rescale every distance

This is the one I would fix before F1 if I could only fix one, because it needs no coincidence — a
single gesture on the record screen triggers it, and it is not modelled anywhere.

`getCameraFovDegImpl` (`modules/shot-detector/ios/ShotTracer.swift:1026-1052`) hard-codes
`AVCaptureDevice.default(.builtInWideAngleCamera, …)` and returns the **1× wide lens's**
`videoFieldOfView` for its 1920×1080 format. It has no idea what lens or zoom the clip was actually
shot at. Meanwhile `app/(tabs)/record.tsx` gives the golfer **both**:

- a `zoomMode: '0.5x' | '1x'` toggle that switches `selectedLens` to the **ultra-wide** device
  (lines 188-232), and
- **continuous pinch-to-zoom** on the preview, deliberately *not* blocked mid-recording (line 201+).

Both comments say the same thing — *"never reaches the detection pipeline"* — and for v1 that was
true: the detector and auto-trim run on the recorded file and do not care about FOV. **For V3 it is
false.** `f_px` is the scale of the entire world model: `depth ≈ f_px · 0.04267 / diameter_px`, and
ball speed and carry ride on depth. `lib/tracerV3.ts` even says the zoom factor "is not persisted per
clip" — but it says it as a footnote to the ±12 % systematic, and this is not a ±12 % effect.

Driving the whole ladder with detections generated at the **true** capture FOV and the `f_px` the app
would actually supply (truth: v0 62 m/s, carry 201.9 m, apex 24.2 m):

| capture | true f_px | app f_px | ratio | result |
|---|---|---|---|---|
| 1× wide, no zoom | 1598 | 1598 | 1.00 | **drawn "200 m"**, carry 203, rms 0.03 ✅ |
| **0.5× ultra-wide** | 806 | 1598 | 1.98 | SKIP `implausible_flight` — apex **49.8 m vs the 48.8 m cap** |
| 1× + **1.5× pinch** | 2397 | 1598 | 0.67 | **DRAWN "140 m"** for a 202 m shot — carry 139, v0 47.8, rms 3.65 |
| 1× + 2× pinch | 3195 | 1598 | 0.50 | SKIP `poor_fit` — rms **4.6 px vs the 4.0 px threshold** |
| 1× + 3× pinch | 4793 | 1598 | 0.33 | SKIP `track_not_ballistic` — rms 13.1 px |

Read the near-misses. The 0.5× case is caught by **one metre of apex** and the 2× pinch by
**0.6 px of rms**. Those are not guards, they are coincidences of this fixture; a slightly softer
shot on 0.5× sails through and reads roughly **double** its real distance, because carry scales
essentially linearly with `f_px` (the exact `(f, depth, v0)` degeneracy the lab documents).

And the 1.5× row is not a near-miss at all: **a 202 m drive is drawn, cleanly, as "140 m".** The
row's flags are `large_pixel_residual` and `optimizer_not_converged` — both real tells, and the
ladder uses neither as a refusal.

For contrast, the *budgeted* ±12 % band behaves exactly as the error model promises: −12 % → 182 m,
+12 % → 220 m against a 203 m truth. The error budget is honest. It is simply an order of magnitude
too small for the thing that actually varies.

**Fixes, cheapest first.**

1. **Record the capture state.** Persist `zoomMode` and the normalized `zoom` on the clip row at
   save time — they are already React state in `record.tsx`. Then `traceClip` can skip, or at least
   flag, any clip that was not shot at 1× with zoom 0.
2. **Refuse rather than guess.** Until (1) exists, treat any clip whose fit reports
   `optimizer_not_converged` **and** `large_pixel_residual` as a skip: on this evidence that pair is
   the signature of a wrong `f_px`, and it costs nothing on a correctly-shot clip (the 1× row has
   neither).
3. **Longer term, the plan's own answer:** read `AVCaptureDevice` intrinsics
   (`isCameraIntrinsicMatrixDeliveryEnabled`) per clip, which is what `TRACER_V3_PLAN.md` says was
   going to happen and what `fPxSource: 'intrinsics'` exists for. Nothing currently produces that
   value — every call site passes `'fov-metadata'`.

---

### F4 — MEDIUM-HIGH · CONFIRMED · a shot down the camera axis fits cleanly and is 47 % wrong, unflagged

The plan states the axis case renders "as a near-vertical line. Real, not a bug." That understates
it: the geometry does not only lose the *direction*, it loses the *scale*, and it does so with a
residual small enough to pass every gate.

Same launch (v0 62 m/s, θ 13°, 3000 rpm), 14 detections, varying only the azimuth:

| φ | truth carry / apex | fitted carry / apex | rms | drawn label |
|---|---|---|---|---|
| **0°** | 202 m / 24.2 m | **211 m / 35.5 m** | **0.64 px** | "210 m · apex 35 m" |
| 1° | 202 / 24.2 | 203 / 24.6 | 0.03 px | "200 m · apex 25 m" |
| 2° | 202 / 24.2 | 203 / 24.6 | 0.03 px | "200 m · apex 25 m" |
| 4° | 202 / 24.2 | 203 / 24.6 | 0.03 px | "200 m · apex 25 m" |
| 8°, 15° | 202 / 24.2 | 203 / 24.6 | 0.02 px | "200 m · apex 25 m" |

**A 47 % apex error at 0.64 px rms.** Nothing flags it. Every refusal in the ladder is a residual
test or a plausibility test, and this failure is plausible and fits.

The degeneracy is razor-sharp — one degree of azimuth is enough to break it — so this is rare on
real footage, where the phone is never perfectly on the shot line. But "down the line at the target"
is the app's *documented capture instruction*, so φ ≈ 0 is the intended case, not an edge case.

`meta.launch.phiDeg` is recorded, so this is diagnosable after the fact. It is not detectable *by
the app*, and no flag exists.

**Suggested mitigation (cheap):** flag `axis_degenerate` when `|phiDeg|` is below ~1.5° **and** the
formal `sigma.v0` is large, and either suppress the pill's distance or widen `labelStepM` to 10 m.
Drawing the arc is fine; claiming a metre-accurate carry off it is not.

---

### F5 — MEDIUM · CONFIRMED · a pixel-only fallback still claims GPS backing

`buildLabel(usedFit, carryM !== null, knobs.labelRounding)` — `hasGps` is *"a carry was supplied"*,
not *"a carry was used"*. So on `decision === 'pixel_only_fallback'` (the GPS was tested and
rejected) and on `joint_fit_rejected` (the joint fit was discarded), the arc is drawn from pixels
alone but the sub-label **omits "· no GPS"**.

Observed across a sweep on one track:

```
GPS=100m -> pixel_only_fallback, carry_out=204  label "200 m"  sub "apex 25 m"     <- no "· no GPS"
GPS=500m -> pixel_only_fallback, carry_out=204  label "200 m"  sub "apex 25 m"     <- no "· no GPS"
(no GPS) ->                     carry_out=204  label "200 m"  sub "apex 25 m · no GPS"
```

The *number* is honest (it is the pixel carry). The *provenance* is not, and provenance is the whole
job of that marker. The lab has the same shape — its "no GPS" note is set by the caller, and its
`pixel_only_fallback` path keeps `carry_m` — so this is a faithful port of a lab bug rather than a
new one. It matters more here because a golfer reads the pill and the lab reader read a JSON blob.

**Fix:** `buildLabel(usedFit, decision !== 'pixel_only_fallback' && !flags.includes('joint_fit_rejected') && carryM !== null, …)`.

---

### F6 — MEDIUM · CONFIRMED · `forceTrace` survives an app restart and is silently rehydrated

`app/profile/tracer-dev-settings.tsx` persists `tracer_v3_force_trace` to the SQLite settings table
and, **on every mount of that screen**, writes it back into
`config.tracer.v3.forceTrace` (lines 170-212). `forceTrace` bypasses `putt`, `not_a_flight`
(both the never-climbs rung and the physics rung), `track_not_ballistic`, `poor_fit` and
`implausible_flight`.

```
M1 putt, forceTrace OFF  -> SKIP "putt"
M2 putt, forceTrace ON   -> DRAWN, label "0 m" / "apex 0 m · no GPS"
                            flags=[…|forced_past:not_a_flight|landing_depression_off]
```

The screen's header comment says *"`constants/config.ts` always BOOTS with the real-round-safe
values, so a crash mid-round cannot leave a bypass on."* True, and beside the point: the way it gets
turned back on is not a crash, it is **opening the diagnostics screen**. The same screen is the only
place to read what the last batch decided, so the natural mid-round action ("why did that skip?")
silently re-arms every bypass left over from a street test.

**Suggested fix:** do not persist `forceTrace` at all (it is a bench switch, and re-flipping it costs
one tap), or persist it with a timestamp and refuse to rehydrate one older than the current app
launch. A red banner on the dev screen while it is on would also do.

---

### F7 — MEDIUM · CONFIRMED · one detection plus a GPS carry draws a full, confidently-labelled arc

`chooseModel` returns `'prior'` for `nUsed < 3` when a carry exists. With **one** detection:

```
B3 1 det, carry 150 m
  decision=prior drawn=TRUE  rms=0.00px K=1
  flags=[prior | few_frames:1 | underdetermined:2_pixel_equations_for_4_free_params(prior-driven) | …]
  LABEL: "140 m" / "apex 24 m"    samples=671
```

The club prior sets the speed and the launch angle, the GPS sets the scale, and **a single pixel
sets the direction**. `checkFlightPlausible` cannot catch it, because a prior-driven fit is bounded
plausible by construction. One spurious detection — a cap, a divot, a distant player — plus a valid
carry produces a beautiful arc pointing the wrong way.

**This is faithful to the lab** (`< 3 detections, carry_m given -> decision 'prior'`) and it is
**currently unreachable in the app**: the native detector will not emit a track shorter than
`minTrackEmit = 3` (`TracerDetectCore.swift:2263`, `scored.count >= params.minTrackEmit && confMean >= params.confFloor`),
and `config.tracer.v3.detectMinTrackEmit` is 3.

So this is a latent hazard, not a live one. It is on this list because **nothing in `traceClip`
enforces the invariant** — the guard lives two module boundaries away, in Swift, behind a settable
option (`minTrackEmit` is clamped only to `max(1, v)`), and a future caller that supplies detections
from anywhere else inherits the hole.

**Suggested fix:** either raise `MIN_FIT` handling so `traceClip` refuses `nUsed < 3` outright and
delete the `prior` rung as unreachable, or keep it and make it visibly weaker (suppress the pill's
distance when `K < 3`, since the number is the prior, not a measurement).

---

### F8 — MEDIUM · CONFIRMED · `landing_depression_off` fires on legitimate short shots, and the port dropped the lab's explanation for why

The check is a faithful port of the lab's flag logic (both compare against `expected_flat_px = f·h/carry`).
But the lab **also** computes `expected_range_px` (using the landing's real ground range from the
camera) and `residual_vs_range_px`, and its docstring says plainly:

> `expected_range_*` uses the landing's real ground range from the camera (the ball is 3-6 m in front
> of it), and is what the projection must reproduce; the two differ by tens of px on a 10 m chip and
> by well under a px on a 250 m drive.

The port keeps only the flat-ground number (`lib/tracerV3.ts: landingHorizonCheck`) and
`meta.landingCheck` records only `expectedFlatPx1080`. So the flag survives and the sentence that
tells you to ignore it does not.

Empirically, on genuine simulated flights from a ball 4 m in front of the camera:

| shot | carry | `landing_depression_off`? |
|---|---|---|
| v0 15, θ 45 | 20 m | **fires** |
| v0 10, θ 50 | 9 m | **fires** |
| v0 9, θ 60 | 7 m | **fires** |
| v0 20, θ 35 (pitch) | 40 m | clean |
| v0 62, θ 13 (driver) | 202 m | clean |

The arithmetic: at a 20 m carry the flat-ground expectation is `f·h/20 ≈ 112 px` but the landing is
24 m from the camera, giving `≈ 93 px` — a 19 px difference, over the 15 px threshold, purely from
the 4 m the ball sits in front of the lens.

**Consequence:** every chip and pitch in the field test will carry a scary-looking flag that means
nothing, and a *real* geometry error on a short shot will be indistinguishable from it.

**Fix:** add `expectedRangePx` / `residualVsRangePx` to `LandingCheck` and `meta.landingCheck`, and
flag on the range residual rather than the flat one. The lab already wrote the formula.

*Related, lower:* the port feeds `landingHorizonCheck` the **drawn** end (the spec's last sample,
which `arc_end:seen` and the behind-the-camera trim can truncate) while comparing it against the
flat-ground depression at the **full fitted carry**. `arc_end:seen` truncates by at most `END_TAIL_S`
= 0.25 s so the error is small in practice, but the two halves of the comparison are not describing
the same point. PLAUSIBLE, low.

---

### F9 — LOW-MEDIUM · CONFIRMED · the revert removes the entry point but not the route

`app/profile/tracer-dev-settings.tsx` is an expo-router route file, so `/profile/tracer-dev-settings`
is registered in **every** binary, including production, and `app.config.js` defines a URL `scheme`.
The gate added to `app/(tabs)/profile.tsx` (`isDevVariant() && config.tracer.enabled`) hides the
row; it does not unregister the route. The screen itself has no guard — it renders, reads settings,
and its toggles mutate `config.tracer` in memory.

With the tracer off nothing that screen turns on can run, so this is cosmetic and review-hygiene
rather than functional. But "no UI" in the revert claim should read "no *reachable-by-tapping* UI".

**Fix if wanted:** an early `if (!config.tracer.enabled) return <Redirect href="/profile" />` at the
top of the screen. One line, and it makes the claim literally true.

---

### F10 — LOW · CONFIRMED · the schema migration runs with the flag off, and the revert does not undo it

Three `ALTER TABLE local_clips ADD COLUMN` statements (`recording_start_ts`, `gps_fix_series`,
`gps_fix_meta`) are appended to `migrateEditorColumns()`'s list, which runs on every database open
regardless of `config.tracer.enabled`, inside the file's existing
`for (const sql of migrations) { try { await db.execAsync(sql + ';'); } catch {} }`. `saveLocalClip`'s
INSERT also grew from 22 to 25 columns and writes three NULLs on every clip save with the tracer off.

Idempotent, cheap, matches the established pattern in that file, and semantically identical. But it
is the honest answer to "is it byte-identical": **no, the schema changes, and reverting the flag
does not remove the columns.**

---

### F11 — LOW · CONFIRMED · `useGpsSession` is mounted unconditionally

`app/(tabs)/record.tsx:307` calls `useGpsSession(config.tracer.engine === 'v3')` outside any
conditional. Inside, `isActive = enabled && config.tracer.enabled && Platform.OS !== 'web'` and every
effect early-returns on `!isActive`. I read all four:

| effect | with the flag off |
|---|---|
| `useFocusEffect` | registers a React Navigation focus listener; callback body and cleanup are both no-ops |
| AppState listener | `if (!isActive) return` before `addEventListener` — **not registered** |
| 1 Hz health tick | `if (!isActive) return` before `setInterval` — **not started** |
| `useEffect(() => stopWatch, …)` | registers an unmount cleanup that removes a null subscription |
| `useState` | one `GpsHealth` object, `state: 'off'` |

**No location watch, no permission request, no timer, no log.** The residue is one navigation focus
subscription, one unmount cleanup and one state object per mount of the record screen. That is not
"byte-identical" in the literal sense and it is completely harmless in the practical one.

Also module-level: `lib/gpsSession.ts:623` constructs `export const gpsSession = new GpsSession(…)`
on import, and `hooks/useCamera.ts` imports it unconditionally. Pure object, empty ring, no timers.
`expo-location` is imported statically by `useGpsSession`, but `hooks/useLocation.ts` (already
imported by `record.tsx`) imports it too, so no new native module is pulled in.

---

### F12 — LOW · CONFIRMED, and correctly disclosed · +5.9 MB in every build including production

`s.resource_bundles = { 'ShotDetectorResources' => ['GolfBallDetector.mlpackage'] }` ships the model
whether or not the tracer is on. This is stated in `docs/tracer-v3/verify.md:201` and
`native-detect.md:383`, which is what the brief asked for. Loading is genuinely lazy
(`TracerBallModel.ensureLoaded()` is only reached from `detect`), so with the flag off no model is
compiled and the ANE is never woken.

Context worth keeping in mind: `swing-vision` already ships a **69 MB** `.mlpackage` in the same app,
so this is an ~8 % addition to an existing model payload, not a new category of cost.

---

### F13 — LOW · CONFIRMED · `carryBetween` uses the module default config, not the live one

`hooks/useEditorState.ts:1530` calls `carryBetween(own.fix, succ.fix)` with the third argument
omitted, so `cfg` defaults to `DEFAULT_GPS_CONFIG` rather than `gpsSession.cfg`. A retune of
`config.tracer.gps.bagOffsetM` therefore reaches `gpsSession` but not this call. Only
`CarryEstimate.sigmaM` is affected, which is diagnostic — the number handed to the fit is
`carry.sigmaGpsM`, which does not use `bagOffsetM`, and the fit applies its own `BAG_OFFSET_M`.
Elsewhere the code is careful about exactly this (`deriveImpactFix` explicitly threads
`gpsSession.cfg`), so this looks like an oversight rather than a decision.

---

### F14 — INFORMATIONAL · what the ladder cannot tell from a golf shot

Its floor for "this is a flight" is `v0 ≥ 8 m/s`, `apex ≥ 0.3 m`, `hang ≥ 0.4 s`. Real flying objects
that clear it get drawn, with a distance:

```
divot v0=15 th=45     -> drawn "20 m" / "apex 6 m · no GPS"
divot v0=10 th=50     -> drawn "9 m"  / "apex 3 m · no GPS"
tossed ball v0=9 th=60 -> drawn "7 m"  / "apex 3 m · no GPS"
real driver, conf 0.20 throughout -> drawn "210 m" / "apex 27 m · no GPS"
```

This is by design — the discrimination lives upstream, in the address-ball anchoring, the pose
skeleton veto and the conf floor, not in the ladder. Recording it because the first field test on a
soft fairway will produce divots, and the last line is worth noting separately: **a track whose every
detection is at conf 0.20 still draws**, because the emission floor is the *mean* track confidence
in Swift (`confMean >= 0.4`) and the ladder only uses conf to double the pixel sigma. A uniformly
low-confidence track is refused by the detector, never by `traceClip`.

---

## Question 1 — is it actually revertible?

I checked this by sweeping every call site of every new symbol rather than by reading the comments.

```
$ grep -rn --include='*.ts' --include='*.tsx' -E 'traceClip\(|detectShotV3\(|renderTracerV3\(|
    isTracerV3Available\(|useGpsSession\(|updateClipGpsFix\(|carryBetween\(|estimateAtStop\(|
    estimateAtImpact\(|seriesAround\(|getRecentTracerDiagnostics\(' app hooks lib components constants modules
```

| call site | gate |
|---|---|
| `useEditorState.ts` × 6 (`isTracerV3Available`, `detectShotV3`, `traceClip`, `renderTracerV3`, `updateClipGpsFix`, `carryBetween`) | inside `processAllTracers`, which is `if (!config.tracer.enabled \|\| !storage \|\| !roundId) return;` at line 1326 |
| `useEditorState.ts:91` (`estimateAtImpact`) | inside `deriveImpactFix`, only called from the gated batch |
| `useCamera.ts:563-564` (`estimateAtStop`, `seriesAround`) | inside `if (tracerV3Gps)`, `tracerV3Gps = config.tracer.enabled && engine === 'v3'` |
| `record.tsx:307` (`useGpsSession`) | mounted unconditionally; every effect gated inside — see **F11** |
| `tracer-dev-settings.tsx:220` (`getRecentTracerDiagnostics`) | screen reachable only from a gated row — but see **F9** (the route survives) |

**The flip mechanism itself.** `ENABLE_TRACER_ON_DEV_VARIANT && tracerAllowedOnBinary(readAppVariant(), readBundleId())`
is a correct mirror of `lib/devPro.ts:isDevVariant()` — `extra.variant === 'development'` **and** a
`.dev` bundle id, with `bundleId === undefined` falling through to the manifest check alone.
`expo-application` and `expo-constants` are both direct dependencies (`package.json:36,42`) and both
present in `node_modules`, so the bundle-id half is live on device and is not the inert second gate
it would be if the package were missing.

**Independent confirmation of the flag-off suite.** Under node both `require`s throw and the gate
fails closed, so `config.tracer.enabled` is `false` — meaning the suite run *is* the flag-off run,
not a claim about one. I ran it myself:

```
$ npm run verify
ℹ tests 799   ℹ pass 799   ℹ fail 0   EXIT=0
```
tsc emitted nothing.

**Not byte-identical, and here is the honest list:** the schema migration (**F10**), three extra NULL
columns in every `saveLocalClip` INSERT (**F10**), one navigation focus subscription and one unmount
cleanup on the record screen (**F11**), a module-level `GpsSession` object (**F11**), two extra
`AsyncFunction` registrations in the native module, `CoreML` linked into the binary, the
5.9 MB model in the bundle (**F12**), and the dev-settings route registered (**F9**). Nothing on that
list executes work, prompts the user, writes data or touches a hot path. **No permission prompt is
reachable with the flag off** — that is the one that mattered and it holds.

---

## Question 2 — can it fabricate a shot?

I walked every path in `lib/tracerV3.ts` and drove it with adversarial fixtures. Summary of what
refuses and what does not:

| input | result |
|---|---|
| `found: false`, or `address: null` | **SKIP** `detector_found_no_address_ball` — before anything else, and `forceTrace` cannot bypass it |
| 0 detections | **SKIP** `no_detections` |
| 1-2 detections, no carry | **SKIP** `too_few_detections_no_carry(n)` |
| 1-2 detections **with** a carry | **DRAWN** — see **F7** (unreachable today; the guard is in Swift) |
| a cap-like near-static blob, 7 frames | **SKIP** `implausible_flight` (apex 78 m, rms 192 px) — refused with or without GPS |
| a topped ball (v0 12, θ 2°), 10 frames | **SKIP** `not_a_flight:fitted v0 12.0 m/s, apex 0.03 m, hang 0.13 s` |
| a rolling putt the classifier called a *swing*, 20 frames | **SKIP** `not_a_flight` (v0 6.0, apex 0.15 m, hang 0.34 s) |
| a putt the classifier called a putt | **SKIP** `putt`, before any fitting |
| no CoreMotion pitch | **SKIP** `no_camera_pitch` |
| a detector that missed the first 2+ frames | **SKIP** — see **F2** (safe, but wrong reason) |
| GPS 500 m against a 204 m pixel track | drawn **pixel-only**, GPS discarded, `carry_inconsistent(z=-6.0σ)` — but the pill omits "no GPS" (**F5**) |
| GPS 40 m against a 204 m pixel track | **DRAWN with the GPS folded in, apex inflated 25 → 35 m, labelled "210 m"** — **F1** |
| a shot exactly down the camera axis | drawn, 47 % apex error, no flag — **F4** |
| a divot / a tossed ball that really flies | drawn with a distance — **F14** |

**The refusals are real and they are the lab's.** The only place I found the product asserting a
confident wrong number rather than skipping is **F1**, and it needs a specific coincidence (backspin
pinned at a bound *and* a wrong carry). **F4** is not a fabrication so much as an unflagged
degeneracy. Everything else in that table behaves the way the lab's report says it should.

---

## Question 3 — is the port faithful?

I did not take the constant tables on trust; I ran the lab's Python and the port's TypeScript and
compared outputs.

### Physics — reproduces the lab to four significant figures

Plausibility limits (the 8-corner `CLUB_PRIORS` search through the flight model):

| bucket | lab `apex_max` / `hang_max` | port `apexMaxM` / `hangMaxS` |
|---|---|---|
| driver | 48.80 / 8.075 | **48.80 / 8.075** |
| long_iron | 41.64 / 7.090 | **41.64 / 7.090** |
| short_iron | 37.70 / 6.615 | **37.70 / 6.615** |
| wedge | 33.76 / 5.897 | **33.76 / 5.897** |

TrackMan reference launches, straight through both flight models:

| | lab carry / apex / hang / land | port |
|---|---|---|
| driver 75 / 10.9° / 2686 | 247.0 / 29.3 / 6.68 / 37.0 | **247.0 / 29.3 / 6.68 / 37.0** |
| 7-iron 54 / 16.3° / 7097 | 159.7 / 30.6 / 6.27 / 47.0 | **159.7 / 30.6 / 6.27 / 47.0** |
| PW 46 / 24.2° / 9304 | 120.5 / 27.5 / 5.56 / 50.4 | **120.5 / 27.5 / 5.56 / 50.4** |

That is as strong a fidelity result as this kind of port can produce, and it validates the aero
model, the RK4 integrator, the spin decay and the summary extraction in one shot. It also confirms
`integrate.md:143`'s claim that the limits are "verified numerically, not asserted" — they are.

### Constant-by-constant

| item | lab | port | verdict |
|---|---|---|---|
| aero `cd0/cd1/clA/clP/clMax/spinDecay` | 0.2103 / 0.2908 / 0.6912 / 0.6243 / **0.3291** / 0.045 | identical, `name: 'lab-tuned-H-2026-09-05'` | ✅ exact, lift cap included |
| `CLUB_PRIORS` (4 buckets, θ/rpm/v0/carry bands) | `flight.py:348` | identical | ✅ exact |
| `pitch` bucket | `fit.py: EXTRA_PRIORS Prior("pitch", 20, 12, 35, 12, 5000, 0.7)` | derived to `[14,20,26]`, `[29,35,41]`, `[3523.44,5000,7095.34]` | ✅ round-trips exactly through `make_prior`'s own convention; derivation documented |
| `ROLL_PRIORS` | driver (.05,.15), irons (.03,.08), wedge/pitch (0,.05), generic (0,.15) | identical, incl. `GENERIC_ROLL_FRAC` | ✅ exact |
| carry σ: `σ_D² = σ_gps² + bag² + (roll_σ·D)² + (fpx·D)²` | `fit.py:184-191` | `sigmaD()` identical, `includeFpx` switch included | ✅ exact |
| `bag_offset_m` 3.0, `fpx_frac` 0.12 / 0.02 | `fit.py:89,90,159` | `BAG_OFFSET_M`, `FPX_FRAC_PRIOR/DEVICE` | ✅ exact |
| z thresholds: as-scale 15 %, tension 2σ, inconsistent 4σ | `fit.py` docstring 50-52 | `AS_SCALE_FRAC`, `Z_TENSION`, `Z_INCONSISTENT` | ✅ exact |
| `label_step_m` 1 / 5 / 10 at 2.5 / 7.5 m | `fit.py:236` | identical | ✅ exact |
| consistency denominator `√(σ_test² + sc² + σ_px_sys²)`, `include_fpx=False` | `fit.py:894-896` | identical | ✅ exact — **except the NaN branch, F1** |
| detector `P` dict (pre/post frames, bg, addr, sigmas, DoG k, peak, sector, step2, accept, miss, radius, depart, Kalman noise, motion, reseed, seed r, pose fracs, veto, ROI) | `detect.py:61-121` | `TracerDetectCore.swift:43-120` | ✅ every value matches |
| `min_track_emit` 3, `conf_floor` 0.4 | `detect.py:81,102` | enforced at `TracerDetectCore.swift:2263` | ✅ exact |
| `depart_scan (-4,6)`, `depart_persist 2`, `impact_flag_frames 2` | `detect.py:99` | `departScanLo/Hi/Persist/impactFlagFrames` | ✅ exact |
| ladder constants (`EARLY_FRAMES_30FPS` … `DEPRESSION_OFF_PX`) | `tracer.py:109-159` | `lib/tracerV3.ts:135-197` | ✅ every value matches |
| `CAP_BUCKET` | `{"pitch": "wedge", "generic": "driver"}`, default `driver` | `{pitch: wedge}` + `CAP_BUCKET_UNKNOWN = driver` | ✅ equivalent — the port's `Bucket` union has no `generic` |
| `accept_score_nodepart = 0.5` | defined in `P` | **not ported** | ✅ correct — it is defined and never read in the lab |
| `impact_slack_frames` | `select_detections` computes it, `fit_launch` widens `t0`'s lower bound | **not ported** | ❌ **F2 — real behavioural loss** |
| `find_seen_landing` / `SEEN_LANDING_*` / `TOUCHDOWN_MAX_Z_*` | in-source touchdown search | not ported | ⚠️ deliberate, disclosed; `decide_arc_end(search=False)` is a supported lab config |
| `IMPLAUSIBLE_IMPROVE` / `IMPLAUSIBLE_TIGHTEN` (tightened-prior refit) | `tracer.py:151-152` | not expressible; port refuses instead of rendering `implausible_flight_uncapped` | ⚠️ deliberate, **stricter** than the lab, correctly so |
| spin-bound rung candidate (b): backspin fixed, **tilt free** | `tracer.py` | `fixSpin` pins both | ⚠️ deliberate, stricter, documented — but it is the rung that triggers **F1** |
| per-point σ (`width/1080 × 2 if conf<0.4`) | explicit | reproduced by mapping conf → {1, 0.5} through `pxSigma·(1+2(1−conf))` | ✅ exact through the available API; the inversion is correct |
| `landing_horizon_check` `expected_range_px` / `residual_vs_range_px` | computed and reported | **not ported** | ❌ **F8** |
| `.mlpackage` | `experiments/det-yolo-ball/golfballyolov8n_640.mlpackage` | sha256-identical, all 3 files | ✅ byte for byte |

Two lab provenance nits called out in `tracer-lab/NEXT.md` — `tracer.py` rebinding `tag` inside the
implausible-cap loop, and a dead scratch path in `render3/results/IMG_3622.json` — do not appear in
the port. The port's cap loop uses a single `implausible_refit:` prefix and does not rebind.

---

## Question 4 — are the claims honest?

I scanned all 2 517 lines of `docs/tracer-v3/*.md` for "verified / measured / tested / confirmed"
and spot-checked the load-bearing ones.

**Held up under checking:**

- `integrate.md:143` "the plausibility limits are verified numerically, not asserted" — **true**, I
  reproduced 48.80 / 8.075 from the lab's own Python.
- `native-detect.md:15` the `.mlpackage` is "copied byte for byte" — **true**, sha256 on all three
  files.
- `native-detect.md:274` the Core ML decode was checked against the real model on a real frame
  (best anchor `(302.75, 436.5, 7.5, 7.5)` @ 0.745, letterbox-inverted to `(488, 1310)` against a
  labelled address of `(475, 1300)`) — **plausible and specific**; the cited artefacts
  (`experiments/det-yolo-ball/coreml_bench_results.md`, `golfballyolov8n_640.mlpackage`) both exist.
  I did not re-run coremltools.
- The verify agent's suite claim — **reproduced independently**: 799/799, tsc clean, exit 0.
- `native-detect.md:351` "The Core ML model has never been loaded on iOS", `native-render.md:348`
  "What could NOT be verified", `verify.md:469` on parse-vs-typecheck, `native-detect.md:313` "Cost —
  measured on a Mac, NOT on a phone", `verify.md:201` on the 5.9 MB — all present, all prominent.
  Nothing here has run on a phone or on video, and the documents say so repeatedly and clearly. This
  set of reports meets the lab's standard.

**Claims I would change:**

1. **`lib/tracerFit.ts:1330-1334`** — *"saying `carry_untested` instead is the one place this port is
   deliberately more conservative than fit.py."* **False, and it is the sentence that hides F1.**
   It is the one place the port is *less* protective: substituting `sc = 0` costs you the permissive
   `carry_as_scale` rung and keeps the protective `carry_inconsistent` one; refusing to test costs
   you the protection.
2. **`lib/tracerV3.ts:509-513`** — the lab's `impact_slack_frames` "would be dead". Dead in the code,
   not in effect: dropping it converts a two-frame-late first detection from a good fit into a skip
   (**F2**). The comment should say what it costs.
3. **`app/profile/tracer-dev-settings.tsx:16-17`** — *"`constants/config.ts` always BOOTS with the
   real-round-safe values, so a crash mid-round cannot leave a bypass on."* True as written and
   misleading in context: the bypass comes back on the next mount of that screen (**F6**).
4. **`TRACER_V3_PLAN.md`** and the config comment describe the axis case as rendering "as a
   near-vertical line. Real, not a bug." Under-states it — it also costs 47 % of the apex and 9 m of
   carry at a residual small enough to pass every gate (**F4**).
5. **`config.ts`'s revert comment** — "no UI" should be "no UI you can reach by tapping"; the route
   survives (**F9**), as does the schema (**F10**).

---

## Question 5 — what will embarrass Henry on the phone?

Taking each item from the lab's judged results in turn.

| lab finding | state in the app |
|---|---|
| shots down the camera axis render as near-vertical poles | **partly handled: the pole is expected; the 47 % apex error is not, and is unflagged (F4).** `meta.launch.phiDeg` is recorded, so it is diagnosable afterwards. |
| ~half of unseen footage yields no ball | **handled as a skip**, with the full diagnostic blob in `tracer_meta` on every skip. But **F2** will add skips that are the port's fault, not the footage's. |
| the landing can sit behind the golfer (6 of 19) | **handled at render time** — `occlusion: true` runs `VNGeneratePersonSegmentationRequest` with a per-frame occluder refresh and a moving-limb/club mask, so the trace is hidden behind the golfer rather than drawn over him. **Not logged**: nothing records "the landing was occluded", so a clip whose trace disappears into a body will look like a render bug in the field notes. |
| distances depend on lens intrinsics | **the ±12 % half is priced in; the ×2 half is not.** `fPxSource` is `'fov-metadata'` at every call site (`useEditorState.ts:1560`), so `fPxIsPrior` is true, the ±12 % systematic flows into `sigmaTotal.carryM`, and `labelStepM` widens the pill accordingly — I confirmed that band behaves exactly as advertised. But the plan's promise of `AVCaptureDevice` intrinsics is **not implemented** (`getCameraFovDeg()` still returns `videoFieldOfView`, for the 1× lens only), and the lens/zoom error it does not cover is an order of magnitude larger — see **F3a**. The plan reads as though intrinsics were done; they are not. |
| a chip's arc can run past the seen touchdown | **partly** — the in-source search is absent, the detection-only rung survives. Disclosed in `integrate.md:155` with the lab's own 61-70 px measurement. |

**Additional, from this review:**

- **Neither the lens nor the zoom is persisted per clip** (**F3a**). `lib/tracerV3.ts` says so, as a
  footnote to the ±12 % band; it is not a ±12 % effect. **The single most useful capture rule for the
  first field test is: 1×, and do not pinch.** A 1.5× pinch turns a 202 m drive into a clean, unflagged
  "140 m".
- **Every chip and pitch will carry `landing_depression_off`** (F8) and it will mean nothing.

**The worst thing a first field test will show,** in order of likelihood:

1. **Almost everything skips**, with `t0_at_lower_bound` in the ladder log — that is **F2**, and it
   would be read as "the detector doesn't work" when the detector is fine.
2. **Every distance is wrong by the same factor**, because the clips were shot on 0.5× or with a
   pinch left on — **F3a**. This is the one that would be read as "the physics is wrong".
3. **A confident wrong distance on one hole** where the GPS carry was short — **F1**.
4. **Nothing at all**, because the model was not committed — **F3**.

---

## Three things to watch in the first field test

1. **`tracer_meta.detectorNotes.coreml` on the very first clip — and the lens the clip was shot on.**
   `coreml` must read `"ok"`; anything else means the `.mlpackage` did not reach the bundle (**F3**)
   and the whole test is measuring a degraded detector. And because nothing records the lens
   (**F3a**), the capture discipline has to be the record: **every clip at 1×, no pinch, written
   down.** Check both before walking to the second tee — they are the two ways the test measures the
   wrong thing entirely.

2. **The ratio of skips carrying `t0_at_lower_bound` or `v0_at_upper_bound` in `meta.ladder[].flags`.**
   Those together are the signature of **F2** — the fit pinned against a `t0` bound it should have
   been allowed past. If most skips look like that, the problem is the missing `impact_slack_frames`,
   not the footage, and the fix is a `lib/tracerFit.ts` API change rather than another detector wave.
   Watch for `optimizer_not_converged` alongside `large_pixel_residual` in the same log: on this
   evidence that pair means a wrong `f_px` (**F3a**), not a bad clip.

3. **Every clip where `meta.carry.status` is `carry_untested`, and every clip where `decision` is
   `pixel_only_fallback`.** The first is **F1** — the GPS was used without ever being tested, so the
   drawn distance may be badly wrong. The second is **F5** — the pill claims GPS backing it does not
   have. Both are one-line reads out of `tracer_meta`, and every drawn distance needs comparing
   against a laser or a course marker before any of this is shown to anyone but Henry.

**And before flying at all:** `git add` the `.mlpackage`; pin the capture to 1× with no pinch; and
either fix **F1** or set `carryM: null` for the first outing so the whole GPS half is out of the
loop. **A pixel-only field test that measures the detector honestly is worth more than a joint test
whose distances cannot be trusted** — and on the evidence above, the distances cannot be trusted
yet.
