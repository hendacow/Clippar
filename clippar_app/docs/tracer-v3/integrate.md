# integrate — wiring the five builders into the shipping app

**Agent:** `integrate`, tracer-v3 build wave, 6 Sep 2026.
**Status:** complete. `npm run verify` = **tsc clean + 798/798 tests**. The wave arrived at 743;
this agent added 55 — 31 in `tests/tracerV3.test.ts`, 24 in `tests/tracerV3Wiring.test.ts`.
Swift: `swiftc -parse` clean on the one Swift file I edited (see §7 for what that does NOT mean).

**Source of the ladder:** `~/projects/clippar/tracer-lab/lib/tracer.py` — the wave-4 `e2e2`
integration with the wave-5 `render3` additions — read against `experiments/e2e2/report.md`
and `experiments/render3/report.md`.

---

## 1. Files

| File | What changed |
|---|---|
| `constants/config.ts` | `tracer.engine`, `tracer.gps`, `tracer.v3`; the dev-variant flip; `tracerAllowedOnBinary()` |
| `lib/tracerV3.ts` | **new, 1 571 lines** — the decision ladder, the refusals, the one coordinate conversion, the render spec |
| `modules/shot-detector/index.ts` | `detectShotV3` / `renderTracerV3` / `isTracerV3Available` wrappers + native types |
| `modules/shot-detector/ios/ShotDetectorModule.swift` | registers the two `AsyncFunction`s (+58 lines; nothing else touched) |
| `hooks/useEditorState.ts` | the V3 branch of `processAllTracers`, `deriveImpactFix`, `fixForPairing` |
| `hooks/useCamera.ts` | stop-anchored session fix + raw fix series persisted at save |
| `app/(tabs)/record.tsx` | mounts `useGpsSession` |
| `app/(tabs)/profile.tsx` | dev-variant-gated entry point |
| `app/profile/tracer-dev-settings.tsx` | **new** — ported from `origin/tracer-v2`, extended for V3 |
| `lib/storage.ts` | 3 additive columns, `updateClipGpsFix`, `getRecentTracerDiagnostics` |
| `tests/tracerV3.test.ts` | **new, 31 tests** — the ladder, every refusal, the conversion, the spec |
| `tests/tracerV3Wiring.test.ts` | **new, 24 tests** — the seams |
| `tests/fixtures/tracerV3Clip.ts` | **new** — the shared synthetic clip |

I ran no `git` command, no `npm install`, and touched no other agent's file.

---

## 2. The revert switch, and why it is shaped the way it is

`ENABLE_TRACER_ON_DEV_VARIANT` in `constants/config.ts`. Set it to `false` and nothing flips;
`config.tracer.enabled` stays the `false` literal in every binary and the app is byte-identical
to today.

**`tracer.enabled` is a plain literal that is FLIPPED after the config object is defined**, rather
than a computed property. Three constraints meet, and only this shape satisfies all three:

1. **`constants/config.ts` must stay node-safe.** Five test files import it under
   `node --import tsx --test`, where `expo-constants` cannot resolve at all. The variant read is
   therefore a guarded `require` that degrades to "not dev" (verified: node throws
   `Stripping types is currently unsupported for files under node_modules`, which the `catch`
   swallows). Metro resolves a literal-string `require` statically, so the device build is
   unaffected — and `modules/shot-detector/index.ts` already uses exactly this pattern twice.
2. **`tests/tracerClaims.test.ts` pins `enabled: <literal> as boolean` in the source text.** That
   test exists so a rename cannot turn the paywall/onboarding guards into dead code while the copy
   keeps selling a tracer the binary does not ship (App Review 3.1.2). A call expression breaks it,
   and weakening it to accommodate this file would delete the protection it was written for.
3. **Ordering is unambiguous.** An ES module's body runs to completion before any importing
   module's body starts, so every consumer — including module-level ones like `lib/gpsSession.ts`'s
   singleton — sees the flipped value. There is no "who imported first" hazard.

**Fail-closed, double-gated, same as `lib/devPro.ts`.** `extra.variant === 'development'` AND a
bundle id ending `.dev`. `extra.variant` is stamped at publish time, so a stray
`APP_VARIANT=development eas update --branch production` would push a dev manifest onto every App
Store install; the bundle id is baked into the binary and no OTA can change it. The matrix is
asserted in `tests/tracerV3Wiring.test.ts`.

`tracer.engine: 'v1' | 'v3'` (default `'v3'`) is a second knob, not a replacement — v1 stays
reachable, and with `enabled` on the two are a genuine A/B on the same clips.

---

## 3. `lib/tracerV3.ts` — the API

```ts
// Wire shapes (SHARED CONVENTIONS 2 and 3) — DEFINED here, imported as types by the bridge
export interface BallDetection { frame; t; x; y; r; conf }            // top-left px
export interface TracerDetectResultV3 { found; method; fps; width; height; impactFrameGiven;
  impactFrameUsed; launchFrame; address; detections; notes; msPerFrame }
export interface RenderSampleV3 { x; y; tSec }                        // normalized bottom-left
export interface TracerRenderSpecV3 { samples; depths?; animStartSec; animDurationSec; color?;
  coreColor?; lineWidthPx?; midWidthPx?; glowWidthPx?; cometHead?; taperMin?; depthFadeMin?;
  occlusion?; labelText?; labelSubText?; labelAtApex?; endAtSec?; freezeCompleteToSec?; landHoldSec? }

// THE ENTRY POINT
export function traceClip(input: TraceClipInput): TraceClipResult;
export interface TraceClipInput { detection; pitchDownDeg: number|null; rollDeg?; fPx;
  fPxSource: 'intrinsics'|'fov-metadata'|'config-fallback'; carryM?; carrySigmaGpsM?; bucket?;
  shotType?: 'swing'|'putt'|null; renderDurationSec; detectToRenderOffsetSec?; knobs? }
export interface TraceClipResult { decision: 'none'|'prior'|'fit'|'pixel_only_fallback';
  reason: string|null; flags: string[]; spec: TracerRenderSpecV3|null; meta: TracerV3Meta }
export function isTraceSkip(r: TraceClipResult): boolean;

// THE ONE CONVERSION (SHARED CONVENTION 1) — tested, and asserted to be the only one
export function pxToNormalizedBottomLeft(p: Px, width: number, height: number): {x,y};

// Ladder internals, exported for tests and for the dev screen
export function selectDetections(det): Selection;
export function chooseModel(nUsed, carryM, sel, fps, knobs);
export function trackForFit(used: BallDetection[]): TrackPoint[];
export function bucketFlightLimits(bucket?: Bucket): BucketFlightLimits;
export function checkFlightPlausible(fit, bucket, decision): PlausibilityCheck;
export function decideArcEnd(det, sel, fit, fps, width): ArcEnd;
export function landingHorizonCheck(fit, landingPx, width): LandingCheck;
export function buildLabel(fit, hasGps, labelRounding): { labelText; labelSubText };
export function fPxFromLandscapeFov(hFovLandscapeDeg, width, height): number;
export function resolveV3Knobs(tracerConfig: unknown, overrides?): TracerV3Knobs;
export const DEFAULT_V3_KNOBS: TracerV3Knobs;
export interface TracerV3Meta { /* the tracer_meta diagnostic blob — see §6 */ }
```

### The conversion

```ts
x = (px.x + 0.5) / width
y = 1 - (px.y + 0.5) / height
```

The `+ 0.5` is the pixel-centre offset. The camera model's principal point is `((w-1)/2, (h-1)/2)`
— a pixel INDEX — so with the offset the principal point maps to exactly 0.5, the geometric centre
of the frame. That identity is what the test pins. Without it the whole trace sits half a pixel up
and left: invisible, but "invisible" is not a reason to have the wrong formula in the one function
everything else trusts. `TracerRenderV3.swift:425` multiplies straight through
(`CGPoint(x: s.x * renderSize.width, y: s.y * renderSize.height)`, CALayer y-up), so the two ends agree.

---

## 4. Ported vs changed — the ladder

### Ported faithfully (structure, thresholds and the lab's own constant names)

`select_detections` (early window 15 frames @30 fps scaled by fps; through-the-apex → ALL
detections; `first3` fallback) · `choose_model` (< 3 needs a carry, 3–4 fixes spin, ≥ 5 free,
`fit_pitch` only on a long track through the apex) · the never-climbs check (25 px @1080p) · the
fit ladder's rung 1 (single gross outlier, `OUTLIER_RATIO` 5 / `OUTLIER_MIN_PX` 10, kept only if
the rms HALVES) and rung 2 (backspin at a bound) · the held-out check (≥ 3 later detections,
median > 6 px @1080p → refit on all, kept only if the all-frame rms beats that median) · the carry
verdicts (`joint_fit_worse_pixel_minimum` → render the pixel-only companion;
`carry_inconsistent` → `pixel_only_fallback`; `carry_tension`; `carry_as_scale`) ·
`check_flight_plausible` and `bucket_flight_limits` (the 8 CLUB_PRIORS corners simulated through
the flight model) · the three physics refusals `not_a_flight` (v0 < 8 m/s, apex < 0.3 m,
hang < 0.4 s), `track_not_ballistic` (rms > 8 px @1080p) and `poor_fit` (rms > 4 px over ≥ 10
frames) · `decide_arc_end` · `landing_horizon_check`'s horizon/depression flags · the honest label
(1/5/10 m step from `sigma_total['carry_m']`, "· no GPS" on a pixel-only render).

**The plausibility limits are verified numerically, not asserted.** `tracer.py` states "48.8 m of
apex and 8.07 s of hang for a driver, 37.7 m / 6.61 s for a short iron"; this port reproduces all
four from `CLUB_PRIORS` through its own flight model, and the test fails if either drifts.

### Changed, and why — every one is forced by the fixed TS API surface

| # | Deviation | Why it was necessary | Direction of risk |
|---|---|---|---|
| 1 | **Detection confidence is mapped onto `{1, 0.5}`, not passed through.** | The lab passes `fit_launch` an explicit per-point `sigma = px * (2 if conf < 0.4 else 1)`. `lib/tracerFit.ts` takes no `sigma`; it derives one from `conf` LINEARLY (`px * (1 + 2(1-conf))`). Inverting that for the lab's two multipliers gives conf 1 → 1×, conf 0.5 → 2×. **This reproduces the lab exactly**; passing the raw confidence would NOT (0.45 would get 2.1× where the lab gives 1×). | None — it is the exact port. |
| 2 | **The spin-bound rung's second candidate uses `fixSpin`, which pins backspin AND tilt.** The lab pins backspin at the prior with tilt still free. | `FitOptions` has no partial `fixed` map. | Conservative: removes a degree of freedom rather than adding one, and is still only accepted if it leaves the bound at ≤ 1.5× the rms. |
| 3 | **The implausible-flight rung REFUSES instead of capping.** The lab refits with a tightened prior (3 candidates) and, if none works, renders the uncapped flight with a flag. | `fitLaunch` accepts a `bucket`, not a `Prior`, so a tightened prior cannot be expressed. What is expressible is the reduced model, which is tried first (accepted only if it becomes plausible AND its rms is within the lab's `max(2×rms, 4 px)` budget). | **Stricter than the lab**, deliberately: it refuses to draw a flight outside the club's physical maximum where the lab would draw it with a flag. Better no arc than a 54 m apex on a 3-detection track. |
| 4 | **`impact_slack_frames` is not computed.** | `fitLaunch` bounds `t0` hard to `[k/fps, (k+1)/fps]` and exposes no slack, so the number would be dead code. | None; the ts-fit agent made the same call for the same reason. |
| 5 | **The in-source touchdown search is absent.** `decideArcEnd` is the lab's `decide_arc_end(..., search=False)`. | `find_seen_landing()` re-reads SOURCE FRAMES to follow the ball to its touchdown. That needs pixels; no native counterpart was built this wave. | **Real, and visible.** The detection-only rung (last detection within 0.25 s and 120 px @1080p of the fitted landing) survives, but on a chip the detector followed all the way down, the arc can run a few frames past where the ball stops. The lab measured 61–70 px on IMG_3652 before it added the search. |
| 6 | **`fitLaunch`'s `pixelOnly` companion is not reused between ladder rungs.** | The lab passes `_pixel_only` through; doing the same here needs the pixel-only ladder to be run separately first. | Cost, not correctness — up to ~2× the fits on a carry-constrained clip. See §8. |
| 7 | **A pre-check on the animation window.** Not in the lab. | `TracerRenderV3.swift` throws `ERR_TRACER_ANIM_WINDOW` when the draw starts within 0.4 s of the composed end. Catching it in TS turns a `'failed'` row — which the batch retries once and then leaves failed forever — into an honest `'skipped'` with a reason. | Strictly better. |
| 8 | **`endAtSec` is never sent**, and `freezeCompleteToSec` is OMITTED rather than sent as null. | The truncation is already applied by `flightPixels(tEndSec)`, so sending both would truncate twice. Omitting the key means the Swift parser never has to coerce an `NSNull`. | None. |

### Refusals, in firing order

`detector_found_no_address_ball` · `putt` · `no_detections` ·
`too_few_detections_no_carry(N)` · `not_a_flight:track never climbs` · `no_camera_pitch` ·
`camera_calibration_failed:…` · `fit_failed:…` · `implausible_flight:…` · `not_a_flight:…` ·
`track_not_ballistic:…` · `poor_fit:…` · `render_spec:…`

`config.tracer.v3.forceTrace` bypasses the **judgements** (putt, never-climbs, the three physics
refusals, implausible) so a street test with no club still renders. It does **not** bypass
`no address ball`, `no detections`, `no camera pitch` or `render_spec` — those are absences of
input, and inventing an arc from no evidence is the one thing this file exists to prevent. That
distinction has its own test.

---

## 5. GPS — how impact anchoring actually works in the app

The lab used hand-made GPS by design, so this half has no lab counterpart; the estimator is the
`ts-gps` agent's port of `origin/tracer-v2`, and what I added is the plumbing.

**The problem.** The definitive anchor is `recording_start_ts + impact_time_ms`, and
`impact_time_ms` does not exist at save time — `detectAndTrim` produces it minutes later, in the
editor. Anchoring on the stop press instead medians onto wherever the golfer walked from.

**The solution, in two halves.**

1. **At save (`hooks/useCamera.ts`)**, gated on `enabled && engine === 'v3'`: take
   `gpsSession.estimateAtStop(recordingStart + duration)` and `gpsSession.seriesAround(stop)`.
   Write the stop-anchored fix into `gps_latitude` / `gps_longitude` / `gps_accuracy_m` (falling
   back to today's one-shot fix when the session has nothing), and the RAW SERIES plus
   `recording_start_ts` into the new columns.
2. **At batch (`hooks/useEditorState.ts`)**, with impact known: `deriveImpactFix()` builds a fresh
   `GpsSession` from the stored series — no warm-up marker, so every stored fix counts, and it uses
   `gpsSession.cfg` so a config retune reaches re-derivation — and asks `estimateAtImpact()`. The
   answer is written back with `updateClipGpsFix` in ONE statement so position and provenance can
   never disagree.

**Pairing.** `carryBetween(ownFix, successorFix)`, successor = the immediate same-hole next clip.
`fixForPairing` falls back to the row's stored fix for a successor that has not been through
detection yet — a worse anchor but a real position, and refusing would deny a carry to every shot
whose successor happens to be untrimmed.

**The last shot of a hole has no successor**, so `carryBetween` returns null, the fit is pixel-only,
and the pill says "· no GPS". That is not an error and not a skip.

A "carry" beyond `config.tracer.maxCarryM` (300 m) is dropped as a GPS teleport: it costs a label,
where believing it would scale the whole flight to a lie.

**Why the engine gate and not just `enabled`.** The session estimate overwrites `gps_accuracy_m`
with `effAccM`, which is a different quantity from the one-shot fix's accuracy radius, and v1's
pairing gates read that column. Gating on `engine === 'v3'` means flipping back to v1 restores v1's
inputs exactly.

---

## 6. `tracer_meta` — what a field test is read from

`local_clips.tracer_meta` now holds `TracerV3Meta` as JSON, on **every** V3 outcome including
every refusal:

```
engine, decision, reason, flags[],
nDetections, selection{mode,k,throughApex,climbPx,frameRange,kImpFit,holdoutMedianPx},
camera{fPx,fPxSource,hCamM,pitchDownDeg,rollDeg},
launch{v0,thetaDeg,phiDeg,rpmBack,tiltDeg,t0Sec,dPitchDeg},
flight{carryM,apexM,hangS,landAngleDeg,lateralM},
sigmaTotal{thetaDeg,v0,carryM,apexM}, fit{rmsPx,maxResidPx,nPoints,ok},
carry{inputM,sigmaGpsM,status,z,sigmaM,labelM,labelStepM},
arcEnd{mode,endAtSec,reason}, implausible{...}, landingCheck{...},
render{sampleCount,animStartSec,animDurationSec},
ladder[{tag,k,rmsPx,maxPx,v0,thetaDeg,rpmBack,carryM,flags,accepted}],
detectorNotes, msPerFrame, elapsedMs
```

`flags` strings are byte-identical to the lab's snake_case, so an app log and a lab report can be
compared directly. The dev-settings screen renders the last 25 of these rows.

---

## 7. What I could NOT verify

**Nothing here has run on a device, and nothing here has rendered a frame.** There is no
`pod install` in this checkout, so the two Swift entry points I registered have never been compiled
into an app, let alone executed. Specifically:

- **Swift.** `xcrun swiftc -parse ShotDetectorModule.swift` is clean — that is a SYNTAX check and
  nothing more. The file imports `ExpoModulesCore`, so it cannot be `-typecheck`ed here. I did not
  compile `TracerDetect.swift` or `TracerRenderV3.swift` (their owners' checks stand); I did
  re-run `swiftc -typecheck` on `TracerDetectCore.swift` and it is clean. **I have not verified
  that `TracerDetect.detect` and `TracerRenderV3.render` link, run, or return the shapes their
  reports describe.** The JS wrappers assume they do.
- **The detector has never produced a real detection through this path.** Every test fixture is a
  simulated flight projected through a known camera. That proves the ladder recovers a flight it
  was given; it says nothing about whether the Swift detector finds the ball on real footage. The
  lab's own figure is ~half of unseen clips.
- **No render has been judged.** House rule: ball-flight tracer work is never judged from
  simulator renders. Occlusion, the comet, the freeze tail and the pill placement are all
  design intent from the render agents' reports, not results.
- **GPS is untested end to end.** The ring, the impact anchor and the re-derivation are unit-tested
  as pure functions; no fix from a real receiver has been through them in this app.
- **The `.dev` bundle-id gate is untested on a device.** `Application.applicationId` returns null
  under node, so only the pure predicate is covered.
- **Detector cost on a phone is unmeasured.** The lab's 8–33 ms/frame is a Mac Python number.

## 8. Risks I am handing on

1. **`f_px` is a metadata prior and the app cannot currently do better.** Native
   `getCameraFovDeg()` reads `videoFieldOfView`, which describes the FORMAT. Nothing reads
   `AVCaptureDevice` intrinsics, so `fPxIsPrior` is always true and the fit carries the lab's
   ±12 % systematic straight into ball speed, carry and the label's rounding step. The plan
   assumed intrinsics would be available; **they are not, and no agent built that path.**
2. **Digital pinch zoom is not accounted for at all.** The record screen has pinch zoom, the factor
   is not persisted per clip, and a zoomed clip has a longer effective focal length than the
   format's FOV implies. On a zoomed shot the carry is wrong by roughly the zoom factor, and
   nothing in the pipeline can see it. This is the largest unmodelled error I know of.
3. **The arc can outrun the ball on a tracked chip** — deviation 5 above. The fix is a native
   touchdown search; it is not built.
4. **Fit cost on a phone is unmeasured and could be seconds per clip.** A carry-constrained fit
   runs an internal pixel-only companion, and the ladder can run up to four fits (primary +
   outlier + spin-bound + implausible), each re-computing that companion because
   `FitOptions.pixelOnly` is not threaded through (deviation 6). An 18-hole round is ~40 clips.
   If it proves slow, threading the companion through is the first fix and it is contained.
5. **Landing angle is ~3° shallow, systematically** (inherited from the physics port, ts-physics
   risk 3). Nothing downstream treats it as better than ±4°, but it is exactly the direction that
   pushes a rendered arc's last few metres wrong — and 6 of 19 lab renders already landed behind
   the golfer.
6. **The three columns are CREATED unconditionally.** `migrateEditorColumns` is one shared,
   flag-independent list, so `recording_start_ts` / `gps_fix_series` / `gps_fix_meta` are added to
   every database including a tracer-disabled one. They are nullable, additive and never written
   with a non-null value while the flag is off — but "no new columns" is literally true only of the
   DATA, not of the schema. Making the migration conditional would be worse: a flag flipped
   mid-session would then find the columns missing.
7. **`useGpsSession` is mounted on the record screen whatever the flag says.** With the tracer off
   it is a hook whose every effect early-returns — no watch, no permission request, no interval —
   but it is new code on the record screen, which is the one screen that must never regress.
8. **A V3 `'skipped'` row never retries** (the batch's candidate filter, unchanged from v1). That is
   right for `no-camera-pitch`, which will never arrive, and wrong-ish for a transient detector
   failure — which lands on `'failed'` and gets its one retry instead.
9. **`.expo/types/router.d.ts` was regenerated** (a 4-second `expo start --offline`, killed) so the
   new route typechecks. It is a gitignored build artifact; CI regenerates it. No source change.

---

## 9. CORRECTIONS — applied 6 Sep by the `fix` agent

This report was written before the adversarial review. Four rows above are now WRONG and are
corrected here rather than edited in place, so the record of what was believed at the time survives:

| Where | What it said | What is true now |
|---|---|---|
| §4 deviation **4** | `impact_slack_frames` "is not computed … the number would be dead code. Direction of risk: None." | **Wrong, and it cost recall.** `FitOptions.impactSlackFrames` exists, `selectDetections` computes the lab's slack from the departure cue, and the ladder passes it. Without it a 3-frame-late first detection turned an rms-0.02 px fit into an `implausible_flight` skip. See `fixes.md` F2. |
| §4 refusal list | — | Two refusals added: **`lens_unsupported`** (the clip was not shot at 1× with no pinch — F3a) and the `axis_degenerate` label suppression (F4). `lens_unsupported` is an ABSENCE of input, so `forceTrace` does not bypass it. |
| §5 / §6 | `tracer_meta` schema | `selection.impactSlackFrames` and three `landingCheck` fields (`landingGroundRangeM`, `expectedRangePx1080`, `residualVsRangePx1080`) added. |
| §8 risk **2** | "Digital pinch zoom is not accounted for at all … nothing in the pipeline can see it." | It is now recorded per clip (`capture_lens`, `capture_zoom`) and any clip not shot at 1× with no pinch is refused. Intrinsics are still not read — that risk stands. |

Full detail, with the reproduction for each, is in `docs/tracer-v3/fixes.md`.
