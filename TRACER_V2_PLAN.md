# Tracer V2 — GPS-Backbone Ball-Flight Tracer: Research, Build & Verification Plan

> Produced 2026-07-02 from a 17-agent research workflow (4 codebase mappers, 7 web researchers, 2 competing architects + judge, 3 adversarial attackers — ~1.2M tokens of analysis). This is the authoritative plan for building the v2 tracer in the **clippar-dev** build.

---

## 0. Product intent (Henry's spec, verbatim intent)

- **GPS owns the DISTANCE.** Fix near this shot → fix near the next shot = carry. v1 failed on GPS *reliability* (stale one-shot fixes + hard skip-gates suppressed most renders). v2's #1 job is making the GPS measurement reliable. Always-on location during a round is accepted.
- **Ball detection owns the LAUNCH LOOK, not distance.** Vision tracks the real early flight: launch point, climb angle (height), and lateral left/right drift.
- **Two-segment arc:** the tracer *starts on the real detected ball*; when the camera loses the ball, a synthetic, physics-plausible curve continues seamlessly (no kink) and lands at the GPS-projected landing spot, at the right height relative to the **horizon** (from device pitch), so the distance *reads* visually correct.
- Synthetic priors (club/shot-type) are the **last-resort** rung only.

## 1. What already exists (do not rebuild)

v1 is **fully merged into `origin/main`** and disabled only by a JS kill switch (`config.tracer.enabled`, commit `f82515d`). Verified inventory:

| Asset | Location | State |
|---|---|---|
| Ball detection (`detectBallLaunch`) — VNDetectTrajectoriesRequest, pose-seeded launch ROI (F10), clubhead-decoy rejection (F9), grounded-roll veto (F8a), PTS-stamped buffers | `clippar_app/modules/shot-detector/ios/ShotTracer.swift` | **100% GPS-free, reusable verbatim** |
| Tracer render — AVVideoCompositionCoreAnimationTool burn-in, 3-layer glow, distance pill, every export landmine guarded (-11838 audio, -11847 background, 1080p preset pin) | same file, `renderTracerOnClipImpl` | Reusable; needs additive polyline/keyframe delta |
| Geometry — haversine carry, bearing vs heading, `computeHorizonY` (pitch+FOV), apex/hang priors, two-Bezier arc | `clippar_app/lib/tracerMath.ts` | Keep + import; v2 adds `tracerV2.ts` on top |
| Capture — per-shot GPS fix/accuracy, compass heading, CoreMotion pitch | `hooks/useCamera.ts`, `hooks/useLocation.ts` | GPS capture gets replaced (root cause of v1 failure) |
| Orchestration — idempotent `tracer_status` machine, staleness/invalidations, F17 export gates | `hooks/useEditorState.ts`, `lib/storage.ts` | Keep; invert gate ladder |
| Test infra — `tests/tracerMath.test.ts` (node:test via tsx, in CI), `scripts/simulate-tracer.ts` (54 geometry checks), `app/(dev)/tracer-sim.tsx` device harness w/ crash-bisect ladder, sample video | various | Extend for v2 |

**Hard-won gotchas (memory, still true):** never debug tracer renders on the iOS **simulator** (animation-tool exports crash in Apple's IOSurface emulation even on passthrough — device only); CATextLayer renders upright/no-transform in exports; `debugForceTrace` must be OFF for real rounds; the no-impact race self-heals on editor reopen; clip audio unmute re-triggers -10868 (separate open problem).

## 2. Architecture (merged design, 4 pillars)

**Branch:** `feat/tracer-v2` from `origin/main` (tracer files exist ONLY there).

### Pillar 1 — GPS backbone (the fix for v1's failure)
- New **`lib/gpsSession.ts`** (pure TS, unit-testable): 180s ring buffer + estimator. New **`hooks/useGpsSession.ts`**: `watchPositionAsync({accuracy: BestForNavigation, distanceInterval: 0})` (~1Hz) while the record tab is focused; `Balanced` on blur; re-warm-up on AppState resume. This **replaces the fatal one-shot `getCurrentPositionAsync(Accuracy.High)`** capture.
- Per-shot fix = **accuracy-weighted median over the stationary window** (speed ≤0.7 m/s, acc ≤20m), first 15s after start/resume excluded as warm-up junk, hard staleness rule (all fixes >10s old → explicit `gps-stale`, never a silently cached fix).
- `effAcc = max(2.5, median(acc)/sqrt(min(N, windowSec/15))) × 1.2` (multipath decorrelates ~15s, not √N; iOS accuracy is optimistic — safety factor calibrated by the field walk).
- **Tiered label policy replaces v1's five GPS hard-skips** — the arc ALWAYS renders:
  - **Tier 1** exact `"142m"`: both endpoints effAcc ≤5m AND σ_d=√((a²+b²)/2) ≤5m AND 20≤carry≤350m
  - **Tier 2** `"~140m"`: effAcc ≤10m AND σ_d/carry ≤10%
  - **Tier 3** no label; prior carry drives the arc
- Foreground-only, **when-in-use permission only** (no background modes, no Always prompt — app is foreground all round for camera+clicker anyway).
- Raw fix series + estimator version persisted per clip (re-tunable, reproducible).

### ⚠️ AMENDMENT A1 (from adversarial review — MANDATORY): anchor at IMPACT, not "clicker press"
Code-verified: the **start press happens at the bag, then the golfer walks 5–20s to the ball**; v1 captured GPS at recording STOP. "Fix at clicker press" is ambiguous and, if wired to the start press, the stationary window can median onto the *previous* filming spot 50–150m away.
**Pin:** `estimateShotFix` anchors at **absolute impact time** (`recording_start_ts + impact_time_ms`), window `[impact−15s, impact+10s]`; fallback anchor = recording-STOP with `[stop−25s, stop+10s]`. **NEVER the start press.** Persist start/stop/impact absolute timestamps in `local_clips`. Unit test must include a walk-then-stationary ring that *fails* a start-anchored implementation.

### ⚠️ AMENDMENT A2 (mandatory): model the bag offset
The phone is 2–4m+ from the ball at BOTH endpoints (partially cancels — placement is habitual). Add `tracer.gps.filmSpotOffsetVarM ≈ 3m` into σ_d. The **field-walk ground truth must be BALL positions with the phone 4–8m behind each station** — otherwise the acceptance gate validates the wrong quantity. Honest precision ceiling ≈3–4m; don't chase sub-meter.

### ⚠️ AMENDMENT A3 (mandatory): chain-break defenses for labels
Pairing = immediate next same-hole clip, so: break pairing across the 3-click penalty gesture; shot-type-vs-distance plausibility gate before Tier1/2 (wedge >120m / iron >220m / drive >350m → force Tier3, log); inter-clip gap >8 min → Tier2 max. The **last shot of every hole is R3 by construction** (no next fix) — acceptable for v2; a "hole-out pin press" UX is a future option.

### Pillar 2 — Vision = launch evidence only
- `detectBallLaunch` reused essentially unchanged. **One additive native change:** also accumulate each frame's newest `projectedPoint` (denoised track) alongside `detectedPoints` (gates stay on detectedPoints). **Never read `equationCoefficients`** (x-parameterized, ill-conditioned down-the-line).
- JS `fitDetectedTrack`: trim trailing 20% of points (keep ≥5, span ≥150ms), weighted least-squares quadratic **in time** → launch point, handoff position `P_h` + screen velocity `V_h`, normalized climb `vy0`, lateral sign.
- Expected segment-1 hit-rate: **40–70%** (ball is ~3.5px at 20m @1080p; white-on-overcast-sky is unwinnable). That's fine — R2 exists for exactly this.

### ⚠️ AMENDMENT A4 (mandatory): F8b parallax rewrite + V_h clamp
- The mount sits offset from the ball line → early screen drift contains **parallax**, so raw drift-sign can misread straight shots as draws/fades. Replace F8b's raw sign override with a **curvature test**: vision overrides GPS sign only when the track's deviation from its own initial ray exceeds a residual bound (>0.02 normalized from the chord) AND drift exceeds a parallax bound; for |Δbearing|<~8° render the straight-bow. Log `{parallaxEstimate, curvatureResidual, override}` in `tracer_meta`.
- **Clamp `V_h.y`** to `[0, vyMax(bucket)]` before solving the ascent (one noisy endpoint must not set the apex), with the same 0.15s damp-blend as the lateral guard; robustify the endpoint (median-of-3 / Huber weights). New invariant **I11a: apexM ≤ 1.5× bucketHi**.

### Pillar 3 — Horizon anchor
- `computeHorizonY` (pitch + FOV, clamp [0.30,0.75], fallback 0.52) and `projectLanding` reused **verbatim**; `x_land` from GPS bearing−heading via portrait FOV; `y_land = horizonY − tan(atan2(camHeight, carry))/(2·tan(vFov/2))`; `bagMountHeightM = 1.0` (new config; replaces tripod 1.35).
- `VNDetectHorizonRequest` **rejected** (roll-only, ~47% hit-rate). Skyline-scan fusion deferred to post-acceptance hardening.
- ⚠️ **AMENDMENT A5:** cheap elevation term — the GPS ring exists at both endpoints; use averaged `CLLocation.altitude` delta (usable for drops ≥8–10m) in `y_land`, gated on altitude accuracy. And the acceptance gate must be per-terrain (0 lands-in-sky on flat holes; counted+annotated on elevated tees) — a flat-course-only "zero" gate is unfailable-by-design.

### ⚠️ AMENDMENT A8 (founder, 2026-07-02): camera-angle robustness — the tracer must adapt to how the phone is actually angled
The three attitude axes, and what v2 does about each:
- **Pitch** (tilted up/down): already core — CoreMotion pitch drives `computeHorizonY`, which moves the horizon (and thus the landing height) up/down the frame. Covered.
- **Yaw / off-axis** (camera not pointing down the shot line): covered for moderate angles — `x_land` comes from (GPS landing bearing − compass heading) through the lens FOV, so a camera pointed 20° left of the shot places the landing 20°-worth right of center. Beyond the ±60° clamp (side-on filming), the projection model breaks: **detect |deltaDeg|>60° and degrade explicitly** (render the detected segment + a short bowed tail, drop the landing anchor + label, `tracer_meta.offAxis=true`) rather than drawing a wrong arc.
- **Roll** (mount tilted sideways → slanted horizon): **NOT handled by v1 — new requirement.** (a) Native: extend the one-shot gravity sample to return `{pitchDownDeg, rollDeg}` (additive `getDeviceAttitude`; keep `getDevicePitchDeg` for compat). (b) Capture: persist `camera_roll_deg` per clip alongside pitch. (c) Math: apply roll as a screen-space rotation — build the arc in the gravity-aligned frame, then rotate all output samples by `rollDeg` about frame center before emitting `TracerRenderSpecV2` (equivalently: the horizon line, landing point, and apex all rotate together, so the arc stays consistent with the tilted world in frame). Clamp compensation to |roll| ≤ 15° (beyond that the mount is wrong — degrade like off-axis, `tracer_meta.rollExceeded=true`). (d) Tests: sim scenarios at roll ∈ {−8°, +8°, +15°} × pitch ∈ {−10°, 0°, +10°} × deltaDeg ∈ {0°, 30°, 60°} asserting the rotated arc's horizon-relative invariants hold and the degrade paths fire.

### Pillar 4 — Two-segment arc (`lib/tracerV2.ts`, closed-form, no iteration)
- **Segment 1** = detection fit evaluated at real timestamps.
- **Segment 2** from `(P_h, V_h)`: piecewise quadratic-in-time vertical with solved pseudo-gravities `g_up/g_down` that **exactly hit the GPS landing**; apex floored by detected climb and modulated by priors (`kApex = lerp(0.13, 0.22, vy0-norm) · carry`, clamped to bucket: drive 15–32m / iron 12–30m / wedge 8–25m); lateral = **one cubic Hermite** from `(P_h.x, V_h.x)` to `(x_land, x'=0)` with Fritsch–Carlson overshoot guard.
- Guarantees by construction: C0/C1 continuity at handoff, exact endpoint hit, no S-curves, detected fade keeps fading. Priority order **in code**: continuity > endpoint > apex prior > hang prior.
- Hang-time pacing `T = clamp(1.15·√apexM, 2.5, 6.5)s`; detected segment at real timing; descent-only compression on short clips.
- Output `TracerRenderSpecV2 {samples[{x,y,tSec}] ≈60–90, animStartSec, animDurationSec, styling, labelText, meta}` — one time-sampled polyline so the handoff has **no visual seam**.
- Degenerate ladder D1–D6 (1–4 points → direction-only handoff; whole-flight-visible → detected fit + 0.2s tail; etc.).

### Render (additive to the battle-tested pipeline)
Polyline UIBezierPath + `CAKeyframeAnimation` strokeEnd (arc-length values / time keyTimes) + comet-head keyframes + 3-band width taper (100/60/35%); v1 5-point parser kept as fallback one release; **all landmine guards preserved verbatim**. Plan-B if CA pacing jitters: `AVMutableVideoComposition(applyingCIFiltersWithHandler:)`.
- ⚠️ **AMENDMENT A6 (mandatory):** real mutual exclusion for exports — batch-level `isTracerBatchRunning` (set before F14 scan, cleared in `finally`) checked by export/save/share/recompose, **plus** a native serial gate (dispatch semaphore) around `renderTracerOnClipImpl` + `composeReelOnDevice` so concurrent AVAssetExportSessions are structurally impossible. New invariant **I11b:** `samples[].tSec` strictly increasing, first t=0, last keyTime exactly 1.0, `values.count==keyTimes.count`; native rejects violations with `ERR_TRACER_SPEC`.
- ⚠️ **AMENDMENT A7:** decide the screen/battery story explicitly — add a **round mode** (idle-timer off + brightness floored + near-black UI) OR accept lock-induced Tier2/3 degradation; itemize the screen term in the battery gate; log screen state with `[GPS-RING]`. Per-clip perf gate: **median ≤4s / p95 ≤8s**; log `ProcessInfo.thermalState` per clip; pre-specify the downscale lever (detection at 720p / ROI-cropped) at `thermalState ≥ .serious`.

### Fallback ladder (GPS-present outranks vision-present, per product intent)
| Rung | Condition | Arc | Label |
|---|---|---|---|
| **R0** | GPS Tier1 + vision fit valid | real segment 1 + synthetic to GPS landing | `142m` |
| **R1** | GPS Tier2 + vision fit | same geometry | `~140m` |
| **R2** | GPS Tier1/2 + weak/no vision | synthetic from poseAnchor/default, GPS drives landing+apex+label | per tier |
| **R3** | vision valid + GPS unusable (incl. last shot of hole) | real launch/drift, prior-bucket carry | none |
| **R4** | nothing usable (gated `allowPriorOnlyArc`, dev-only) | pose-anchored prior arc + 1–3° bow | none |
| **Hard vetoes** (never faked): putt, no-impact, grounded (F8a AND found:false), anim-too-short, no-anchor | | | |

## 3. Build steps × verification (14 steps)

Each step is small and independently verifiable. **V(n) must pass before S(n+1).** CI = `npm run verify` (tsc + node:test) on every PR.

| # | Build | Verify |
|---|---|---|
| S1 | Branch `feat/tracer-v2` off origin/main; node-safe `lib/variant.ts`; `config.tracer.enabled = variantIsDev()`; config blocks (`tracer.gps/arc/v2`, `bagMountHeightM 1.0`, `allowPriorOnlyArc`); `videoStabilizationMode='off'` | V1: CI green; `simulate-tracer.ts` still 54/54 under plain node; variant unit test; dev client boots w/ tracer active; prod variant unaffected |
| S2 | `lib/gpsSession.ts` (ring, warm-up, stationary weighted-median estimator, staleness) + tests | V2: unit tests — clean-fix accuracy, outlier rejection, walking/warm-up exclusion, stale→null (never cached), window widening, monotone effAcc property sweep, **A1 walk-then-stationary anti-test** |
| S3 | `hooks/useGpsSession.ts` lifecycle + replace one-shot capture; **impact-time anchoring (A1)**; persist start/stop/impact timestamps; `[GPS-RING]` log | V3: `simctl location` scripted walk → ~1Hz fixes, correct estimator output at simulated press; re-warm-up on relaunch; device sanity effAcc ≤5m in 30s; only when-in-use prompt |
| S4 | Storage migration: `gps_eff_acc_m, gps_fix_count, gps_window_sec, gps_source, gps_fix_series(≤60), gps_estimator_version` + timestamps | V4: migration idempotency on pre-v2 DB fixture; recorded clips show sane values via sqlite3; CI green |
| S5 | Record-screen GPS health chip (green ≤5m/yellow ≤10m/red/locking); location usage-string copy; **no** background modes | V5: simctl drives chip states; fresh install = one when-in-use prompt; .ipa Info.plist audit; chip hidden off-dev |
| S6 | `tracerV2.computeShotCarry` (carry/bearing/σ_d/tier/label) + **A3 plausibility + gap + penalty chain-breaks** | V6: tier boundary tests (4.9/5.1/9.9/10.1m; σ_d 5m; 19/351m); v1 worked-example parity; accuracy-sweep sim scenarios |
| S7 | `fitDetectedTrack` + `buildArcSpecV2` (closed-form two-segment, D1–D6, **A4 V_h clamp + F8b curvature rewrite**) + sim scenarios | V7: invariants I1–I10 (+I11a): C0/C1 at handoff (1e-9), exact endpoint, apex bounds, monotone up/down, no lateral reversal, cross-handoff speed ratio <1.3, finite/NaN-free degenerates; property sweep carry×bearing×vy0×vx×t_h; all in CI |
| S8 | Native detection delta: accumulate `projectedPoints` (additive payload) | V8: dev build compiles; v1 payload fields byte-identical on a real clip diff; TS additive check |
| S9 | Native render delta: polyline + strokeEnd keyframes + comet head + taper; v1 parser fallback; **A6 native serial export gate + ERR_TRACER_SPEC (I11b)** | V9: device tracer-sim deep-link auto-runs V2 scenarios through the **crash-bisect ladder** on the no-audio fixture (+1 with-audio fixture = both -11838 branches); no seam at handoff; v1 spec still renders. **Never on simulator** |
| S10 | Orchestration: pure `decideTracerPlan()` → rungs R0–R4 + hard vetoes; extended `tracer_meta`; `markClipTrimmed` staling fix; **A6 batch flag** | V10: rung×veto matrix unit tests (last-shot→R3, stale→R3/R4, grounded semantics); street test (3 clips 30–100m apart) → arcs at R2/R0 w/ correct meta; re-trim → stale + predecessor staled; export refused while batch running |
| S11 | Dev settings (club default, label toggle, force-trace) + `[TRACER-V2]` NDJSON metrics + sim scenarios | V11: toggles persist + alter next batch; NDJSON parses into metrics table; deep-link auto-run completes |
| S12 | **GPS field walk**: dev screen + `analyze-gps-walk.ts`; legs 25/50/100/150m open + 2 canopy, 3 reps, **ball-position ground truth w/ phone 4–8m behind (A2)**; tune safetyFactor/tiers | V12 gate: open-ground mean \|err\| ≤5m AND p95 ≤10m; Tier1 rate ≥70% open / ≥40% canopy (canopy = calibration, not failure); zero silent stale fixes; results committed |
| S13 | **On-course acceptance round** (9 holes, bag mount, dev build) + `analyze-round.ts` scorecard + manual review of every rendered clip | V13 gate: ≥95% of non-putt shots render at some rung; Tier1/2 label ≥70% of paired shots (open-to-moderate course); **zero arcs contradicting visible launch**; 0 handoff kinks; lands-in-sky budget per terrain (A5); detect+render median ≤4s/p95 ≤8s + thermal logged (A7); battery ≤25pp itemized w/ screen term (A7); label plausibility vs club knowledge |
| S14 | Ship gate: prod variant byte-identical (no watcher, no batch); PR + CI + founder UAT on 5 traced clips. **Triggered-only spikes:** skyline horizon (if lands-in-sky >0 on elevated tees), CIFilter render (if CA pacing jitters), 60fps capture (if segment-1 hit-rate <40%) | V14: prod-build debug assert (no location watcher); UAT sign-off; each spike has its own pre-specified metric |

## 4. Honest risks (top 8)

1. **Canopy physics:** 5–11m RMS under leaf-on trees — Tier1 labels will be rare on tree-lined holes regardless of code. Expectation-setting, not a bug.
2. **iOS accuracy optimism:** reported `horizontalAccuracy` floors at 5m while true error can exceed it — the 1.2× factor is a guess until S12 calibrates it.
3. **Bag-offset bias** caps honest precision at ~3–4m (A2 models it; exact labels imply slightly more precision than physically exists).
4. **Last shot of each hole = no label** by construction (R3). Future "hole-out press" fixes it.
5. **Vision hit-rate unproven at scale** (expect 40–70%; overcast-sky drives are unwinnable) — many arcs will be R2 synthetics with generic launch shape. Review R2 examples before judging shippability; 60fps spike is the escalation.
6. **Handoff kink perception:** I7 bounds math, not eyes — budget one tuning loop on real clips (G_MAX / t_up caps / trim fraction); D2 direction-only is the escape hatch.
7. **Compass heading error (10–25°)** owns lateral placement in R2 no-detection arcs — wrong-side fades possible; F8b-rewrite + ±60° clamp + round-review counting is the honest mitigation.
8. **Foreground-only GPS:** phone lock mid-round stales the ring (next shot degrades tier). Round-mode screen dimming (A7) or future Always-permission path.

**IP hygiene (awareness):** never market as "Toptracer-style" (registered mark); a synthesized arc that doesn't claim to *measure* trajectory sits further from measurement patents; avoid "trajectory measurement" claims in copy.

## 5. Execution logistics

- **Branch:** `feat/tracer-v2` from `origin/main` only. The SQLite migration must keep pre-v2 rows readable.
- **Worker assignment:** natural lanes — (a) GPS core+wiring+UX (S2–S5), (b) math/arc + orchestration (S6,S7,S10,S11), (c) native deltas (S8,S9). S1 first (single PR), S12–S14 are Henry-in-the-loop field steps.
- **Every render PR** must run the tracer-sim crash-bisect ladder on device. **No simulator render debugging, ever.**
- Metro for the dev client: `APP_VARIANT=development npx expo start --tunnel`.
