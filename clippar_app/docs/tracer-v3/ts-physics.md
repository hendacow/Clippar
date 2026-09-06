# ts-physics — `lib/tracerPhysics.ts` and `lib/tracerCamera.ts`

Agent: **ts-physics**. Owns exactly four files:
`lib/tracerPhysics.ts`, `lib/tracerCamera.ts`, `tests/tracerPhysics.test.ts`, `tests/tracerCamera.test.ts`.

Ported from `tracer-lab/lib/flight.py` and `tracer-lab/lib/camera.py`. Both are pure TypeScript:
no React, no native imports, no I/O, no config read. Nothing in either file runs unless something
calls it, so `config.tracer.enabled === false` is satisfied trivially.

---

## 1. `lib/tracerPhysics.ts`

RK4 flight model in the lab world frame (metres, X forward, **Y left**, Z up, ball launches at the
origin). Faithful port of `flight.py`.

### API (contract, implemented exactly)

```ts
type Bucket = 'driver' | 'longIron' | 'shortIron' | 'wedge' | 'pitch';
interface FlightSample { t; x; y; z }
interface FlightSummary { carryM; apexM; hangS; landAngleDeg; lateralM }
interface Flight { samples; summary; at(t); /* + dt, vLand, launch, apexTSec */ }

simulate(a: { v0; thetaDeg; phiDeg?; rpmBack?; rpmSide?; dt?;
              model?; rhoAir?; z0?; maxTSec? }): Flight
solveV0ForCarry(carryM, thetaDeg, rpmBack, rpmSide?, opts?): number   // throws out of bracket
inferLaunch(carryM, bucket?): { bucket; v0; thetaDeg; rpmBack; v0InRange }
spinAxisTiltDeg(rpmBack, rpmSide): number
spinFromAxis(rpmTotal, tiltDeg): { rpmBack; rpmSide }
CLUB_PRIORS: Record<Bucket, { thetaDeg; rpmBack; v0; carryM; rollFrac }>
```

Extra exports (additive, nothing in the contract changed): `G`, `RHO_AIR`, `BALL_MASS_KG`,
`BALL_DIAMETER_M`, `BALL_RADIUS_M`, `BALL_AREA_M2`, `DEFAULT_DT` (= 1/120, the lab's step),
`AeroModel` + `DEFAULT_AERO`, `spinVector`, `bucketFromLabName`, `VALIDATION_TARGETS`,
`VALIDATION_TOLERANCE`, `LaunchConditions`, `ClubPrior`, `PriorBand`, `SimulateArgs`,
`SolveV0Options`, `InferredLaunch`.

The optional `model` / `rhoAir` / `z0` / `maxTSec` arguments exist because the lab's tests need
them (vacuum parabola at `rhoAir: 0`, spin-decay sweep via `model`). Production passes none of them.

### Ported verbatim

Coefficients `Cd = 0.2103 + 0.2908·S`, `Cl = min(0.6912·S^0.6243, 0.3291)`, spin decay 0.045/s,
ρ 1.2, m 45.93 g, d 42.67 mm, g 9.81; the RK4 loop and its ground-crossing interpolation; `at()`
including its two index fix-up loops; the spin-axis sign conventions; the bisection solver's
bracket [15, 100] m/s and 0.05 m tolerance; `CLUB_PRIORS` for the four flight buckets; the roll
fractions from `fit.py: ROLL_PRIORS`.

### Changed, and why

1. **`Flight.summary` is a property, not a method** — the shared contract says so.
2. **`solveV0ForCarry` throws** where Python raised `ValueError`. Same behaviour, TS idiom. It does
   not clamp: a clamped v0 would be a fabricated number the fit could not tell from a solved one.
3. **`spinVector(phiDeg, rpmBack, rpmSide)` drops the lab's unused `theta_deg` first argument.**
4. **The `pitch` bucket row in `CLUB_PRIORS` is DERIVED, not quoted.** The lab states that bucket
   only as a Gaussian prior in `fit.py: EXTRA_PRIORS` — `Prior("pitch", v0 20, v0σ 12, θ 35,
   θσ 12, rpm 5000, ln-rpm σ 0.7)` — with no [lo, hi] bands and no carry band anywhere. Inverting
   `fit.py: make_prior`'s own convention (σ = full band width for v0/θ; ln(hi/lo) for spin) gives
   θ [29, 35, 41], v0 [14, 20, 26], rpm [3523.44, 5000, 7095.34]. Its `carryM` is `[0, 55]`, which
   only says "shorter than the wedge band's lower edge" (55 m is the wedge's own `lo`).
5. **`inferLaunch` never selects `pitch`.** The lab's `infer_launch` scans `flight.CLUB_PRIORS`,
   which has four entries; adding a fifth overlapping band would silently change which bucket a
   55–60 m carry gets. `pitch` is reachable only by an explicit caller argument.
6. `inferLaunch` returns an extra `v0InRange` flag (the lab returned `v0_in_range` too; the
   contract omitted it, so it is additive).
7. No allocation inside the derivative — the acceleration is written into one reusable
   `Float64Array(3)` — because this runs a few hundred times per fit on a phone.

### Verification actually run

- `node --import tsx --test tests/tracerPhysics.test.ts` → **24/24 pass**.
- **The port agrees with the lab Python to 1e-9 on five shots** (driver, 7-iron, PW, and both
  held-out LPGA shots — carry, apex, hang, landing angle). I ran `tracer-lab/lib/flight.py` in the
  lab venv and the TS side-by-side at ten decimal places; every digit matches. Those numbers are
  pinned in the test file, so a future edit that changes the maths fails loudly.
- All nine TrackMan targets pass simultaneously (driver carry/apex/hang/land, 7-iron
  carry/apex/land, PW carry/apex), inside the brief's ±5 % / ±15 % / ±10 % / ±4° tolerances.
- Vacuum case vs the analytic parabola; monotonicity of carry in v0 over 20–100 m/s for all three
  clubs; sidespin sign and exact left/right mirror; azimuth rotation preserving carry and apex;
  bisection round-trip to 0.05 m/s; dt convergence 1/60 vs 1/240 (carry within 0.02 m).
- **Runtime, measured, not asserted from the lab:** `0.063 ms` per flight at dt = 1/60 and
  `0.121 ms` at 1/120, on this Mac in the node test runner (200 reps after a 50-rep warm-up).
  Budget was 3 ms; it is ~48× under. No optimisation beyond the no-allocation derivative was
  needed. **A phone will be slower than this Mac** — that is not measured here.

### Honesty carried across from the lab (repeated in the file header)

- The coefficients are a 5-parameter fit to 9 TrackMan numbers, not an aerodynamic measurement.
- The lift cap is load-bearing: three simpler forms were fitted in the lab and all failed.
- **Landing angle is systematically ~3° shallow** on every iron-type shot, fitted or held out.
  Nothing downstream may treat a simulated landing angle as better than ±4°. The LPGA hold-out
  test pins that bias rather than hiding it.
- `CLUB_PRIORS` are recollected typical amateur values, not data.

---

## 2. `lib/tracerCamera.ts`

Pinhole camera in the same world frame, working in **top-left pixels of the display-oriented
frame**. Port of `camera.py`, de-vectorised (one point at a time instead of numpy (N,2) arrays).

### API (contract, implemented exactly)

```ts
interface CameraParams { fPx; width; height; pitchDownDeg; rollDeg; hCamM; fPxIsPrior }
interface Px { x; y }

class TracerCamera {
  constructor(p: CameraParams);
  readonly params; readonly cx; readonly cy;   // principal point = frame centre
  project(pts: Vec3[]): Px[];
  pixelToRay(p: Px): Vec3;
  backprojectGround(p: Px): Vec3;
  ballCentreFromPixel(p: Px): Vec3;
  depthFromDiameterPx(diamPx, at?: Px, measured?: DiameterKind): number;
  horizonRow(u?: number): number;
  withPitchDelta(dPitchDeg): TracerCamera;
  with(overrides: Partial<CameraParams>): TracerCamera;
  // extras: centre, toCamera, backprojectPlane, offAxisAngleRad,
  //         depressionAngleRad, sphereImageAxes
}

fPxFromFovDeg(fovDeg, axisPx): number
calibrateFromAddressBall(a): CameraParams
```

Extra exports: `Vec3`, `DiameterKind`, `AddressBallCalibration`, `fovDegFromFPx`,
`fPxFrom35mmEquiv`.

### Two signature extensions (additive — existing calls still compile)

1. **`depthFromDiameterPx(diamPx, at?, measured?)`.** The contract's one-argument form cannot carry
   the off-axis correction, which needs to know *where* in the frame the ball is. With `at` omitted
   it is the lab's on-axis `f·D/w` exactly; with `at` it applies the sphere-silhouette correction.
   This matters: at 16.3° off axis a ball is drawn **6.4 % larger** than `f·D/w`, which is 6.4 %
   straight into the address-ball range and therefore into the camera height.
2. **`calibrateFromAddressBall` takes optional `fPxIsPrior`, `diamKind`, `seedHCamM`.** It has to
   return a `CameraParams`, which has an `fPxIsPrior` field, and the argument list in the contract
   had no way to set it. It **defaults to `true`** — the conservative reading: unless the caller
   says the focal length came from the device, it is treated as a ±12 % prior.

### Ported verbatim

`R = rotZ(roll)·rotX(pitch)·AXES` with `AXES: (X,Y,Z) → (−Y,−Z,X)`; projection, `pixelToRay`,
plane back-projection and its NaN-in-front-of-camera rule; `sphereImageAxes` (exact sphere
silhouette, both semi-axes and the offset ellipse centre); the three diameter conventions and their
`cos α` / `cos²α` / `cos^1.5 α` corrections; `horizonRow` including roll; the focal-length helpers
(`fPxFromFovDeg`, `fovDegFromFPx`, `fPxFrom35mmEquiv`); and the `f_given` branch of `calibrate()` — the one the app uses.

**Principal point is `((width−1)/2, (height−1)/2)`**, the lab's convention. Kept deliberately: it
is what makes the per-clip fixtures reproduce to the last digit.

### Deliberately NOT ported

- `pitch_roll_from_horizon`, `horizon_line`, `ground_grid`, `describe` — nothing in v3 measures a
  horizon line from footage (pitch comes from CoreMotion, and the fit carries a `dPitchDeg`
  nuisance instead). Left out rather than shipped as dead code; they are ~20 lines in `camera.py`
  if a later agent wants footage-refined pitch.
- `calibrate`'s golfer-height cue and its f-scan (`h_given`) mode. The golfer cue was the lab's
  independent cross-check on `h_cam` (it agreed within ±13 % on all 8 clips); the f-scan is the
  ill-conditioned branch the report warns against. Neither is on the app's path.

### The one real improvement over the lab: `fPxIsPrior`

The lab could not measure `fPx` from its footage at all — every static cue in a single-depth scene
fixes a ratio (`range/fPx` or `hCam/range`), never `fPx` — so it used a 24 mm-equivalent prior
times an unknown stabilisation crop, a **±12 % systematic**. The app reads the focal length from
`AVCaptureDevice`. So `fPxIsPrior` is a first-class field on `CameraParams`, it survives `with()`
and `withPitchDelta()`, `fPxFromFovDeg` exists for the fallback path, and every consumer can tell
which it has.

**The consequence, which every consumer must respect: ball speed and carry inherit the `fPx` error
1:1.** A ±12 % prior gives ±12 % on carry. That is what `tracerFit`'s `fpxFrac` term is for — the
lab's own defaults are 0.12 for a prior and 0.02 for device intrinsics.

### Verification actually run

- `node --import tsx --test tests/tracerCamera.test.ts` → **14/14 pass**.
- `npx tsc --noEmit` over the whole app → clean.
- Full suite `node --import tsx --test tests/*.test.ts` → **715/715 pass, 0 fail** (baseline was
  652; my two files add 38, the rest are other agents' files that had already landed).
- **Closed-form checks, derived independently of the code:** project→backproject round trip to
  1e-9 m (with roll on, and for a ball centre one radius off the ground); `horizonRow` equals
  `cy − f·tan(pitch)` at five pitches and at every column; roll tilts the horizon by exactly the
  roll angle with the right end dropping, and the principal-column row picks up the expected
  `1/cos(roll)`; a 1.8 m post at 100 m projects to `cy + f·tan(δ − pitch)` for base and top; the
  horizon crosses a vertical post at exactly camera height (the cue the lab used for the golfer).
- **Reference values regenerated by running `tracer-lab/lib/camera.py`** and pinned: the off-axis
  angle and all three diameter conventions at (540, 1400); the sphere silhouette semi-axes at 3 m;
  the four `fPxFrom35mmEquiv` values in the lab's prior band; the post height in pixels.
- **Three per-clip regression fixtures** from `experiments/camera/calibration.json` — IMG_3632 and
  IMG_3629 (1080p30) and IMG_3631 (4K60), spanning +3.4° to −3.0° pitch and 0.82–1.27 m camera
  height. Same inputs reproduce the file's `h_cam_from_ball_m`, `depth_from_diameter_m`, horizon
  row and ball world position **to 1e-9** (horizon row to 1e-6 — the file stores it rounded).
  One deviation is documented in the fixture itself: IMG_3629's published `ball_world` came from a
  *joint* solve (ball + a stranger at 28 m + the golfer, h_cam 0.86 m), so the fixture pins the
  ball-only value (h_cam 0.8234 m), recomputed from `camera.py` with the same inputs this function
  takes.
- Refusal paths: a non-positive diameter and an address pixel above the horizon both throw rather
  than returning a number. Points behind the camera and pixels above the horizon give NaN, not a
  plausible-looking pixel.
- The calibration seed cancels exactly (three different seeds, agreeing to 1e-12), and the test
  shows that assuming the app's old fixed 1.35 m instead moves this clip's address ball by > 5 %.

### What I could NOT verify

- **Nothing here touched a device or the simulator, and nothing here needed to** — both modules are
  pure arithmetic with no camera, video or BLE surface. But that also means **no claim in this
  report is evidence about real capture**: that `AVCaptureDevice` intrinsics are actually
  deliverable with stabilisation off, and that they are good to ~2 %, is the lab's estimate
  (`fit.py: DEFAULT_FPX_FRAC_DEVICE = 0.02`, labelled "estimate, not measured"). It needs a device
  check before anyone quotes a carry accuracy.
- **The principal point is assumed to be the frame centre.** The contract's `CameraParams` has no
  `cx`/`cy`, so a device-delivered principal point cannot be used even when intrinsics give one. On
  a 1080-wide frame a few pixels of offset is small next to the horizon error, but it is an
  assumption, not a measurement. Adding two optional fields to `CameraParams` and threading them
  through the constructor is the whole change if a later agent wants it.
- Neither module has been run against Henry's footage in this repo — the fixtures replay the lab's
  measurements of that footage, they do not re-measure it. Whether the pipeline works end to end is
  the fit and e2e agents' result, not mine.
- The physics landing-angle bias (~3° shallow) is inherited from the lab and untested against
  anything new here.
