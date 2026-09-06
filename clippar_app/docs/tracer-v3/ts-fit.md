# ts-fit — `lib/tracerFit.ts` (port of tracer-lab `lib/fit.py`, waves 2 + 4)

**Owner:** ts-fit agent · **Date:** 2026-09-06 · **Owns:** `lib/tracerFit.ts` (1 484 lines),
`tests/tracerFit.test.ts` (656, 28 tests), `tests/fixtures/tracerFitClips.ts` (184). Nothing else
was touched, no `git` was run, no `npm install`.

**Source:** `~/projects/clippar/tracer-lab/lib/fit.py` — the wave-4 file, i.e. wave-2 `fit` as
edited in place by `fit2` — read against `experiments/fit/report.md`,
`experiments/fit2/report.md` and `experiments/skeptic-physics/report.md`. Where those disagree
the **skeptic's** corrected understanding is what is ported.

## Headline: this is a faithful port, and it is measured, not asserted

**11 of the 12 hold-out rows reproduce the lab's `experiments/fit2/results/holdout.csv` to 0.01 px**
(`full` model, the same real clips, the same labels, the same cameras), and the fitted launch
parameters match to the printed precision as well. The 12th row differs by 0.76 px on a row the
lab's own fit reported `optimizer_not_converged` for.

| clip | K | **this port** median / max px | **lab** median / max px |
|---|---|---|---|
| IMG_3631 (4K60 driver) | 3 | 22.40 / 39.28 | 22.40 / 39.28 |
| | **5** | **4.94 / 16.88** | **4.94 / 16.88** |
| | 8 | 7.75 / 17.59 | 7.75 / 17.59 |
| | 12 | 3.98 / 7.14 | 3.98 / 7.14 |
| IMG_3649 (4K60 driver, backlit) | 3 | 22.28 / 57.05 | 22.28 / 57.05 |
| | **5** | **7.60 / 19.01** | **7.60 / 19.01** |
| | 8 | 3.55 / 9.93 | 3.55 / 9.93 |
| | 12 | 6.55 / 6.57 | 6.55 / 6.57 |
| IMG_3632 (fairway bunker) | 3 | 19.45 / 35.14 | 20.21 / 36.51 |
| | **5** | **7.01 / 16.86** | **7.01 / 16.86** |
| | 8 | 8.15 / 17.29 | 8.15 / 17.29 |
| | 12 | 11.37 / 13.11 | 11.37 / 13.11 |

IMG_3631 K=5 also lands on the lab's launch numbers: v0 75.28 m/s, θ 11.72°, φ 10.02°,
carry 251.5 m, t0 +0.337 frames — all asserted in the suite, not just eyeballed.

*(The task brief quotes IMG_3649 K=5 as 5.7 px. That is the **wave-2** number; `fit2` §5 shows it
became 7.6 px when the labels were corrected to add frame 431 as the first track frame. The
labels on disk are the corrected ones, so 7.60 is the right target and the wave-2 number is stale.)*

## API (what other agents call)

```ts
// contract signatures, implemented exactly
export interface TrackPoint { frame: number; x: number; y: number; conf?: number }
export type CarryStatus = 'carry_as_scale' | 'carry_consistent' | 'carry_tension'
                        | 'carry_inconsistent' | 'carry_untested';
export function fitLaunch(a: FitOptions): FitResult;
export function predictTrack(fit: FitResult, frames: number[], fps: number): Px[];
export function flightPixels(fit, a: { fps: number; hz?: number; tEndSec?: number })
  : Array<{ x; y; tSec; frame; depthM; inFront }>;      // extra fields, superset of the contract
export function labelStepM(sigmaM: number): 1 | 5 | 10;
export function roundLabelM(valueM: number, sigmaM: number): number;

// extras
export function priorFor(bucket?: Bucket): FitPrior;             // undefined -> the lab's generic prior
export function carryModelFor(kind, bucket, sigmaGpsM, fpxFrac): CarryModelSpec;
export const FPX_FRAC_PRIOR = 0.12;   // f_px from lens metadata x an unknown stabilisation crop
export const FPX_FRAC_DEVICE = 0.02;  // f_px from AVCaptureDevice intrinsics
```

`FitOptions` adds, all defaulted to the lab's values: `carrySigmaGpsM` (5 m), `mcSamples` (64),
`seed` (0), `dtSec` (1/120), `multistart` (true), `pixelOnly` (a pre-fitted companion).
`FitResult` adds `sigma`, `summarySigma`, `startXyz`, `frames`, `residualPx`, `chi2Px`,
`chi2Prior`, `chi2Carry`, `chi2Red`, `dof`, `cost`, `nFev`, `runtimeMs`, `seedSource`, `pixelOnly`.

### Three things the caller (`lib/tracerV3.ts`) must know

1. **`fitLaunch` THROWS for inputs from which no fit exists** — an empty track, a non-finite fps,
   a first frame that is not after `impactFrame`, an address pixel above the horizon. Those are
   one-line checks the ladder should make anyway, and a thrown error is safer than an `ok: false`
   result carrying a fabricated flight. **`ok: false` means a fit RAN and should not be trusted**
   (optimiser did not converge, a non-finite parameter, an unphysical flight).
2. **`flightPixels().tSec` is CLIP time** (t0 + flight time), not flight time — the renderer needs
   to know when in the video the ball leaves the club. The render spec's `samples[0].tSec === 0`
   convention is `tracerV3.ts`'s to produce, at the same moment it converts these **top-left
   pixels** into **normalized bottom-left** ones. This module never touches that convention.
3. **`flags` strings are byte-identical to the lab's** (snake_case parameter names) so lab reports
   and app logs can be compared directly: `t0_at_lower_bound`, `rpm_back_at_upper_bound`,
   `theta_deg_at_upper_bound`, `few_frames:N`, `underdetermined:…`, `spin_unidentified(sigma>50%)`,
   `tilt_unidentified(sigma>10deg)`, `large_pixel_residual`, `optimizer_not_converged`,
   `fpx_is_prior(+-12%_on_v0)`, `carry_as_scale(…)`, `carry_tension(…)`, `carry_inconsistent(…)`,
   `carry_untested(…)`, `joint_fit_worse_pixel_minimum(…)`. Test with `startsWith`, not equality —
   most carry a parenthesised value.

## Ported verbatim

* **Parameterisation and bounds**: v0 6–95, θ −5…75°, φ ±60°, spin 300–15 000 rpm, tilt ±50°,
  dpitch ±5°; the same optimiser unit scales; `rpmSide = −rpmBack·tan(tilt)` (TrackMan sign).
* **t0 bounded to the impact-frame interval** `[k/fps, (k+1)/fps]` — a hard bound, not a prior,
  because the ball is at address in frame k and displaced in k+1. No `impact_slack_frames`: the
  contract does not expose it, so the flag it produced would have been dead code.
* **Priors**: derived from `CLUB_PRIORS` by the lab's own rule (σ = the full band width for v0/θ,
  ln(hi/lo) for backspin, tilt 0 ± 15°). Verified against `lib.fit.make_prior` in the lab's venv —
  **all six buckets match exactly**, including `pitch` (20 ± 12, 35 ± 12, 5 000 rpm, lnσ 0.70) and
  the `generic` fallback (40 ± 30, 20 ± 15, 5 000 rpm, lnσ 1.0) used when no bucket is given.
* **Residuals**: `(project(simulate(...)) − obs)/σ_px` with σ_px = width/1080 for a confident point
  and 3× for a doubtful one; soft-L1 loss, f_scale 2; the weak priors; the carry residual.
* **Camera-pitch nuisance** in the lab's `keep_h` mode (h_cam held, start re-back-projected).
  Default off — on short tracks it moves the wrong way (fit report §3).
* **Two-stage multistart**: 13 seeds (v0 × {0.5, 0.75, 1, 1.25, 1.6} × θ ± 10°) through a reduced
  model at 40 evaluations each, then the full free set from the best two at up to 1 000.
* **fit2 §1 seeding**: a joint fit computes the pixel-only companion FIRST and seeds from it, and
  drops the 13-seed multistart when it has that seed. This is a correctness fix, not a speed one.
* **fit2 §2 carry model**: σ_D² = σ_gps² + bag(3 m)² + (rollσ·D)² + (fpxFrac·D)², the club roll
  band as a shifted Gaussian (mean = midpoint, σ = half-width), and the z-based semantics
  `carry_as_scale` (> 15 % pixel-carry σ) / `carry_consistent` / `carry_tension` (2–4σ) /
  `carry_inconsistent` (> 4σ).
* **fit2 §3 error budget**: pitch 1:1 into σ(θ); f_px into σ(v0), σ(θ), σ(carry), σ(apex) along the
  exact (f, depth, v0) degeneracy; `labelStepM` 1/5/10 m.
* **Monte-Carlo summary sigmas**: 64 correlated draws from the covariance, clipped to the bounds.

**Sweep reproduction.** The carry semantics were checked against fit2's `prior` sweep rows, not
just spot-tested. Levels across e = −40…+40 % on IMG_3631 all frames (`carry` kind):
`t t Q Q Q Q Q Q Q Q t t` — identical to the lab's row, with z = 2.44 at 30 % against the lab's
2.4 and σ_D = 29.9 m against "30 m". IMG_3649 all frames likewise, z = 2.30 vs the lab's 2.2.
The `nextShot` asymmetry reproduces too: a 30 % LONGER distance is quiet (roll explains it), a
30 % shorter one is `carry_tension`.

## Changed, and why

1. **The optimiser.** No scipy, so this is a bounded Levenberg–Marquardt with forward-difference
   Jacobians (the lab's `diff_step = 1e-6`) and **scipy's exact IRLS scaling for the soft-L1 loss**
   (`scale_for_robust_loss_function`): J is scaled by (1+z)^(−3/4) and f by (1+z)^(1/4), so
   JᵀJ and Jᵀf are the true Gauss–Newton Hessian and gradient of the robust cost. Candidates are
   ranked by scipy's `cost` and the covariance comes from the robust-scaled Jacobian at the
   solution, exactly as `res.jac` does. **Bounds are handled by an active set** — a component
   pinned at a bound with an outward gradient is dropped from the linear solve — plus two trial
   points per damping value (the step truncated to stay inside the box, and the step hard-clipped).
   A naive projected step was written first and it is what made IMG_3632 miss: 10.56 px instead of
   7.01 at K=5, with `optimizer_not_converged`. The active-set version fixed all three IMG_3632
   rows to the lab's values without moving a single digit on the two driver clips.
2. **A third joint-fit seed: the pixel-only optimum EXACTLY as found** (`seedSource:
   'pixel_only_exact'`). The lab nudges every seed component 2 % of its range off any bound,
   because a seed sitting on a bound made TRF crawl (7 000 evaluations / 8 s). This optimiser does
   not have that problem, and the nudge is actively harmful on IMG_3632 (spin pinned at 15 000 rpm
   AND t0 pinned at impact): from the nudged seed the joint fit converged to a 10 % worse cost and
   raised a **false** `joint_fit_worse_pixel_minimum`. The lab's nudged seed is still a candidate —
   they are ranked by cost — so nothing is lost. With the exact seed the fit2 invariant holds by
   construction: the joint total can never exceed pixel-only + its carry term.
3. **`carry_untested` is now reachable, and means something.** In `fit.py` the branch was dead
   (the companion is always computed) and a missing Monte Carlo silently became σ = 0, which turns
   `carry_as_scale` into `carry_consistent` — a claim with no basis. Here the consistency test is
   only formed when the pixel-only companion is `ok` and has a finite carry σ; otherwise the status
   is `carry_untested`. **This port is deliberately more conservative than the lab in this one place.**
4. **The legacy flat-σ carry model is NOT ported.** `fit.py` keeps it as the default only so its
   wave-2 test suite still passes; skeptic-physics §6 refuted it (it fires `carry_inconsistent`
   against a *correct* GPS reading at ±10 % on a long 4K track). `carryModel` defaults to
   `'nextShot'`; `'carry'` drops roll; **explicit `null` turns the carry residual off entirely**,
   which is how a caller disables the GPS with one field.
5. **`fit_fscale` / `fit_depth` / `fit_hcam` are not ported.** The contract has no switch for them
   and fit2 §4 measured them as off-by-default: uninformative nuisances that sit at their prior on
   short tracks and drift v0 by −3 % on drivers at identical rms. Porting three dead parameters
   would have been three more ways to be wrong.
6. **`flightPixels` always ends exactly at the landing time.** The lab's `np.arange` stopped short
   of it unless the hang time happened to be a multiple of the step; the renderer needs the arc to
   end at the landing point.
7. **`invSpd` falls back to a tiny ridge** where the lab fell back to a pseudo-inverse. It only
   ever bites on a rank-deficient fit, which is already flagged `underdetermined`.
8. **Monte-Carlo draws differ.** numpy's PCG64 is not reproducible here, so a seeded mulberry32 +
   Box–Muller is used. The σ values are 64-draw estimates (~9 % relative noise on a σ), so this is
   inside their own noise — and the same input gives the same output, which is what the app needs.
9. **`conf` replaces the lab's `quality` tier.** conf 1 ↔ `sure` (σ = width/1080), conf 0 ↔
   `approx` (3σ), linear between; a missing conf is treated as 1, the lab's default. The fixtures
   encode the labels' tiers as conf 1/0 so the weighting is bit-identical.
10. **`z0` and `maxTSec`.** `lib/tracerPhysics.ts` kept both, so the flight starts at the ball
    radius and lands at z = 0 exactly as `fit.py` did, and a pixel-only residual only integrates as
    far as the last observed frame (`tauMax + 2·dt`, the lab's own `max_t`). Without the latter
    every evaluation would simulate 7 s instead of 0.2 s — a ~30× cost for no change in the answer.

## Verification — what was actually run

```
npx tsc --noEmit                                   # clean, whole repo
node --import tsx --test tests/tracerFit.test.ts   # 28 tests, 28 pass, ~2.0 s
npm test                                           # 743 pass, 0 fail (baseline was 652)
```

**Measured runtime** (this dev machine, node 25, `tsx`; the assertion in the suite is < 400 ms):

| case | pixel-only | joint, INCLUDING its pixel-only companion |
|---|---|---|
| IMG_3631 K=5 (10 fr) | **11.5 ms** (max 17.1) | **80.6 ms** (max 82.9) |
| IMG_3631 all (39 fr) | 19.9 ms | 81.1 ms |
| IMG_3649 K=5 (10 fr) | 9.4 ms | 48.6 ms |
| IMG_3632 all (15 fr) | 8.9 ms | 29.7 ms |

Medians of 15 runs. The joint fit is 3–8× the pixel-only one because every residual evaluation
needs the carry, i.e. the whole 7 s flight, which is exactly the lab's ratio. **This is a one-off
per shot, after the detector.** Phone numbers are unknown — see below.

**Synthetic K=5 speed accuracy**, 20 noise seeds at 1 px on the lab's synthetic driver:
**median |Δv0| 2.38 %, max 6.89 %** (lab, different noise draws: median 3.0 %, max 6.4 %).
Median |Δθ| 0.34°, max 0.87°. Both inside the lab's own guards (median < 4 %, max < 10 %).

**The 28 tests**, by what they defend:

* Synthetic round trip at K=5 / 1 px (v0 5 %, θ 1.5°, φ 1°, t0 0.15 fr, rms < 2 px, 3σ coverage);
  the 20-seed speed spread; an exact noise-free round trip with the reduced model; spin identified
  from 25 frames and refused from 3; `predictTrack` in-sample and order-preserving.
* **Hold-out on three real clips × K ∈ {3, 5, 8, 12} against the lab's table**, plus IMG_3631 K=5's
  launch numbers. Tolerance max(1 px, 10 %) — a broken port lands at 20–100 px on every row.
* t0 inside the impact interval on all three clips; `t0_at_lower_bound` where the lab has it.
* Carry: consistent at e = 0 and the fit does not move; **no false alarm at ±5 / ±10 %** in both
  models (the case skeptic-physics §6 refuted the legacy rule on); flagged at ±30 % on a long 4K
  driver; the `nextShot` asymmetry; `carry_as_scale` on IMG_3649 K=5 (16 % pixel-carry σ);
  `carry_untested` with no usable companion σ; the joint fit never a worse pixel minimum.
* Determinism (byte-identical snapshots twice, pixel-only and joint); runtime; `maxIterations`
  really caps the work.
* Budget: pitch enters σ(θ) 1:1 and totals are quadrature sums; device intrinsics shrink σ(v0)
  from 12 % to 2 % of v0 and drop the `fpx_is_prior` flag; label rounding 1/5/10 m and a real
  driver carry rounding to 10 m.
* Refusals: empty track, fps 0, a track starting on the impact frame, an address above the horizon.
* `flightPixels`: clip time monotone from impact to landing, positive depth, starts at the address
  pixel, `tEndSec` respected.
* An impact frame off by one produces `large_pixel_residual` / `t0_at_*_bound` and >3× the rms —
  the skeptic's "re-check the impact frame" signal.
* A one-point track answers, flagged `underdetermined` + `few_frames`.

## What I could NOT verify

* **No phone timing.** Every number above is node on a Mac. JavaScriptCore/Hermes on an A-series
  chip will differ; the lab's own Swift estimate was 20–50 ms, unmeasured. The pixel-only fit is
  ~12 ms here with a 400 ms budget, so there is a lot of headroom, but it is headroom, not a
  measurement.
* **No device, no camera, no video.** House rule: nothing about camera or video behaviour is
  asserted from a simulator, and none was run.
* **The `pitch` bucket has no hold-out test here.** The lab's two pitch clips (IMG_3629, IMG_3652)
  are the ones its own report says do NOT extrapolate from the early frames (20–32 px median,
  landing 9 frames late) — a real information limit, not a port question — so they are not in the
  fixtures. The `pitch` prior itself was verified numerically against the lab.
* **`fitPitch: true` is implemented and typechecked but not hold-out tested.** It is off by default
  for the reason the lab gives (on short tracks it moves the wrong way), and the app should be
  passing CoreMotion's pitch instead of fitting one.
* **`carrySigmaGpsM` is the lab's invented 5 m.** No real GPS reading has been through this code;
  the GPS agent's `lib/gpsSession.ts` produces the effective accuracy that should replace it.
* **The systematics the lab could not remove are still here and are still real:** speed and carry
  ride on f_px (±12 % while it is a metadata prior, hence `fpx_is_prior` and a 10 m label step),
  camera pitch maps 1:1 into launch angle, and the flight model's apex is uncertain by tens of
  percent even when the carry is right (skeptic-physics §5). None of that is a port defect and none
  of it is hidden — it is in `budget`, `sigmaTotal` and `labelStepM`.
* **`pixelOnly` passed by a caller is trusted, not checked.** Pass one fitted on a different track
  and the carry consistency test is nonsense.

## Reversibility

`lib/tracerFit.ts` imports only `./tracerPhysics` and `./tracerCamera`, has no module-level side
effects, and reads no config. With `config.tracer.enabled === false` nothing calls it, so the app
is byte-identical to today. The fixtures are test-only.
