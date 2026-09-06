/**
 * Inverse shot fit: a short ball track in pixels -> the 3D launch state -> the whole flight.
 *
 * Direct port of the tracer lab's `lib/fit.py` (wave-2 `fit` as hardened in place by wave-4
 * `fit2`), read against `experiments/fit/report.md`, `experiments/fit2/report.md` and
 * `experiments/skeptic-physics/report.md`. Where the skeptic refuted the original fit report
 * this file follows the SKEPTIC — see docs/tracer-v3/ts-fit.md for the list.
 *
 * Given
 *   * a post-impact ball track in pixels (detector output, or ground-truth labels in tests),
 *   * the clip's pinhole camera (lib/tracerCamera.ts),
 *   * the address-ball pixel (the ball's 3D start point, via the ground plane),
 *   * the impact frame k (ball still at address in k, already displaced in k+1),
 *   * optionally the GPS distance to the next shot (carry + roll),
 * this recovers (v0, thetaDeg, phiDeg, rpmBack, tiltDeg, t0) — plus an optional camera-pitch
 * nuisance — by robust nonlinear least squares on the reprojection error of
 * `simulate()` -> `camera.project()`, with weak club-bucket priors, and returns the full flight
 * with formal + Monte-Carlo uncertainties, a systematic error budget and diagnostic flags.
 *
 * COORDINATES. Everything here is TOP-LEFT PIXELS of the display-oriented frame and the
 * world frame of lib/tracerCamera.ts (X forward, Y left, Z up, camera at (0, 0, hCamM)).
 * Nothing in this file knows about the normalized bottom-left render convention — that
 * conversion happens once, in lib/tracerV3.ts, by project rule.
 *
 * WHY it is TypeScript and not Swift. The lab's whole hold-out validation transfers as node
 * tests (see tests/tracerFit.test.ts), which is what makes `npm run verify` a real gate on the
 * maths. Only the code that must touch pixels (detection, render) is native.
 *
 * WHY a hand-rolled optimiser. The lab used `scipy.optimize.least_squares` (TRF). There is no
 * scipy here, so this implements a bounded Levenberg-Marquardt with numerical Jacobians and
 * projected steps, plus scipy's exact IRLS scaling for the soft-L1 loss so the robust cost,
 * its gradient and its Gauss-Newton Hessian match term for term. It is deterministic.
 */
import {
  BALL_RADIUS_M,
  CLUB_PRIORS,
  simulate,
  type Bucket,
  type Flight,
  type FlightSummary,
} from './tracerPhysics';
import { TracerCamera, type Px } from './tracerCamera';

// ─── Public types ───

/**
 * One detected (or labelled) ball position. `conf` is the detector's confidence and is mapped
 * onto the lab's two-tier label weighting: the lab used sigma = width/1080 px for a `sure`
 * label and 3x that for an `approx` one, so conf 1 -> 1x, conf 0 -> 3x, linear between.
 * Missing conf is treated as 1 (the lab's default for an unqualified label).
 */
export interface TrackPoint {
  frame: number;
  x: number;
  y: number;
  conf?: number;
}

/**
 * What the GPS carry did to the fit. From fit2 §2, on the z-score of the PIXEL-ONLY carry
 * against the measured distance D:
 *   carry_as_scale     the pixel-only carry is loose (sigma > 15 % of it) — the GPS is setting
 *                      the depth scale the pixels cannot see, and NO consistency claim is made.
 *   carry_consistent   |z| <= 2.
 *   carry_tension      2 < |z| <= 4. The lab's sweep puts a 30 % wrong D here, not at
 *                      inconsistent, once the f_px systematic is honestly in sigma_D.
 *   carry_inconsistent |z| > 4. Needs roughly a 55 % error at the metadata f_px prior.
 *   carry_untested     a carry was supplied but the pixel-only companion could not be formed.
 */
export type CarryStatus =
  | 'carry_as_scale'
  | 'carry_consistent'
  | 'carry_tension'
  | 'carry_inconsistent'
  | 'carry_untested';

/** Per-quantity systematic error budget (fit2 §3). All terms are 1-sigma, added in quadrature. */
export interface BudgetTerms {
  /** Formal 1-sigma from the fit covariance (or the Monte Carlo, for carry/apex). */
  formal: number;
  /** Camera pitch, propagated 1:1 into launch angle (skeptic-physics §3). Zero if pitch is fitted. */
  pitch: number;
  /** Focal length, propagated along the exact (f, depth, v0) degeneracy (skeptic-physics §2). */
  fpx: number;
  total: number;
}

export interface FitResult {
  /**
   * True when the fit produced a flight worth using: the optimiser converged, every parameter
   * is finite and the flight is physical. It is NOT a product decision — the refusal ladder in
   * lib/tracerV3.ts still has to read `flags`, `carryStatus` and `rmsPx`.
   */
  ok: boolean;
  params: {
    v0: number;
    thetaDeg: number;
    phiDeg: number;
    rpmBack: number;
    tiltDeg: number;
    /** Impact time on the clip timeline, seconds. Bounded to [k/fps, (k+1)/fps]. */
    t0Sec: number;
    /** Fitted camera-pitch correction, degrees (0 unless `fitPitch`). */
    dPitchDeg: number;
  };
  flight: Flight;
  summary: FlightSummary;
  /** The camera actually used — `camera.withPitchDelta(dPitchDeg)` when the pitch was fitted. */
  camera: TracerCamera;
  rmsPx: number;
  maxResidPx: number;
  nPoints: number;
  sigmaTotal: { thetaDeg: number; v0: number; carryM: number; apexM: number };
  budget: Record<string, BudgetTerms>;
  carryStatus: CarryStatus | null;
  carryZ: number | null;
  /**
   * The same z-score with the PIXEL-ONLY carry sigma dropped from the
   * denominator (GATE NEW-1(a)). `carryZ` divides by that sigma, so a loose
   * pixel carry — exactly the `carry_as_scale` case — makes any GPS distance
   * look agreeable. This one asks whether the GPS lands where the pixel
   * geometry puts it, allowing for the f_px prior alone. Null when no
   * consistency test could be formed.
   */
  carryZNoPixelSigma: number | null;
  /** sigma_D actually used in the joint residual, metres. */
  carrySigmaM: number | null;
  labelStepM: 1 | 5 | 10;
  carryLabelM: number;
  flags: string[];

  // ── extras (not in the cross-agent contract, but cheap and load-bearing for diagnostics) ──
  /** Formal 1-sigma per free parameter; null for a parameter that was fixed or not estimable. */
  sigma: Record<string, number | null>;
  /** Monte-Carlo 1-sigma of the flight summary. */
  summarySigma: FlightSummary;
  /** Ball centre at impact, world metres. */
  startXyz: { x: number; y: number; z: number };
  /** Frames used, and the per-frame reprojection error in pixels. */
  frames: number[];
  residualPx: number[];
  chi2Px: number;
  chi2Prior: number;
  chi2Carry: number | null;
  chi2Red: number;
  dof: number;
  cost: number;
  nFev: number;
  runtimeMs: number;
  /** Which seed won stage 2 — 'prior' | 'pixel_only' | 'pixel_only_rescaled'. */
  seedSource: string;
  /** The pixel-only companion fit (present only on a joint fit; it seeds and calibrates it). */
  pixelOnly: FitResult | null;
}

export interface FitOptions {
  track: TrackPoint[];
  camera: TracerCamera;
  addressPx: Px;
  /** Ball at address in this frame, displaced in the next one. */
  impactFrame: number;
  fps: number;
  /** GPS distance for the shot. Null/undefined = pixel-only fit. */
  carryM?: number | null;
  bucket?: Bucket;
  /** Fix backspin and tilt at the bucket prior (the reduced 4-parameter model). */
  fixSpin?: boolean;
  /** Also fit a camera-pitch correction. Off by default — on short tracks it moves the WRONG way. */
  fitPitch?: boolean;
  /** 1-sigma of the camera pitch. Prior width when `fitPitch`; otherwise 1:1 into sigma(theta). */
  pitchSigmaDeg?: number;
  /** Fractional 1-sigma of f_px. Default 0.12 when `camera.params.fPxIsPrior`, else 0.02. */
  fpxFrac?: number;
  /**
   * How to read `carryM`. 'nextShot' (default) = distance to the next shot, i.e. carry + roll.
   * 'carry' = a true carry, roll dropped. `null` = ignore the carry entirely (pixel-only).
   */
  carryModel?: 'nextShot' | 'carry' | null;
  /** LM iteration cap per solver stage. Caps the work; default 200. */
  maxIterations?: number;
  /**
   * Let `t0` start up to this many frames BEFORE `impactFrame` — the lab's `impact_slack_frames`
   * (fit.py:636, `t_lo = (impact_frame - impact_slack_frames) / fps`). The upper bound is
   * unchanged.
   *
   * REVIEW F2. This was left unported as "dead code", on the reading that `impactFrame` is always
   * `firstDetection - 1` so the true launch is always inside `[k/fps, (k+1)/fps]`. It is not: when
   * the detector's first detection lands 2+ frames after the ball actually left the club (which is
   * when the ball is fastest and blurriest), `impactFrame` is that many frames late and the true
   * `t0` sits OUTSIDE the interval. The optimiser then pins `t0` at its lower bound and a perfect
   * flight comes back as `track_not_ballistic` / `implausible_flight`. Measured on the fixture
   * clip: a 3-frame-late first detection turned an rms-0.02 px fit into an `implausible_flight`
   * skip. `lib/tracerV3.ts: selectDetections` computes the lab's slack from the departure cue.
   */
  impactSlackFrames?: number;

  // ── extras, all defaulted to the lab's values ──
  /** GPS 1-sigma in metres — one term of sigma_D. Lab default 5 m. */
  carrySigmaGpsM?: number;
  /** Monte-Carlo draws for the flight-summary sigmas. Lab default 64. */
  mcSamples?: number;
  /** Seed for the (deterministic) Monte-Carlo PRNG. */
  seed?: number;
  /** RK4 step of the forward model, seconds. Lab default 1/120. */
  dtSec?: number;
  /** 13-seed multistart over v0 x theta. Lab default on. */
  multistart?: boolean;
  /**
   * A pixel-only companion already fitted on the SAME track and camera, to save re-fitting it
   * (the joint fit needs one, and computing it is most of a joint fit's cost). It is trusted,
   * not checked — pass one from a different track and the carry consistency test is nonsense.
   */
  pixelOnly?: FitResult | null;
}

// ─── Constants ported verbatim from tracer-lab/lib/fit.py ───

const PARAM_NAMES = ['v0', 'thetaDeg', 'phiDeg', 'rpmBack', 'tiltDeg', 't0Sec', 'dPitchDeg'] as const;
type ParamName = (typeof PARAM_NAMES)[number];
type Params = Record<ParamName, number>;

/** Physical bounds. `t0Sec` is bounded to the impact-frame interval instead, at construction. */
const BOUNDS: Record<Exclude<ParamName, 't0Sec'>, [number, number]> = {
  v0: [6, 95],
  thetaDeg: [-5, 75],
  phiDeg: [-60, 60],
  rpmBack: [300, 15000],
  tiltDeg: [-50, 50],
  dPitchDeg: [-5, 5],
};

/** Unit scales for the optimiser — one scaled unit is "a reasonable step" in each parameter. */
const SCALES: Record<Exclude<ParamName, 't0Sec'>, number> = {
  v0: 10,
  thetaDeg: 5,
  phiDeg: 5,
  rpmBack: 1000,
  tiltDeg: 5,
  dPitchDeg: 0.5,
};

/** Flag names use the lab's snake_case parameter names so a flag string is byte-identical to it. */
const FLAG_PARAM_NAME: Record<ParamName, string> = {
  v0: 'v0',
  thetaDeg: 'theta_deg',
  phiDeg: 'phi_deg',
  rpmBack: 'rpm_back',
  tiltDeg: 'tilt_deg',
  t0Sec: 't0',
  dPitchDeg: 'dpitch_deg',
};

const DEFAULT_DT_SEC = 1 / 120;
/** soft-L1 loss scale: residuals beyond 2 sigma stop pulling linearly. */
const F_SCALE = 2.0;
/** A track point with conf 0 gets 3x the pixel sigma — the lab's `approx` label weight. */
const TRACK_SIGMA_APPROX_MULTIPLIER = 3;

/** f_px from lens metadata x an unknown stabilisation crop (camera report). */
export const FPX_FRAC_PRIOR = 0.12;
/** f_px read from AVCaptureDevice intrinsics. Estimate, not measured on device. */
export const FPX_FRAC_DEVICE = 0.02;

/** Where the phone actually was, relative to the ball, at the next shot. 1-sigma metres. */
const BAG_OFFSET_M = 3.0;
const DEFAULT_GPS_SIGMA_M = 5.0;

/** Carry-consistency thresholds (fit2 §2). */
const AS_SCALE_FRAC = 0.15;
const Z_TENSION = 2.0;
const Z_INCONSISTENT = 4.0;

/** Iteration caps, mirroring the lab's nfev caps (40 / 300 / 1000 evaluations). */
const STAGE1_MULTISTART_MAX_NFEV = 40;
const SEEDED_MAX_NFEV = 300;
const STAGE2_MAX_NFEV = 1000;
const DEFAULT_MAX_ITERATIONS = 200;

// ─── Small linear algebra (n <= 7; no dependency worth taking for this) ───

function choleskyDecompose(a: number[][]): number[][] | null {
  const n = a.length;
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i][j];
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return null;
        l[i][i] = Math.sqrt(s);
      } else {
        l[i][j] = s / l[j][j];
      }
    }
  }
  return l;
}

/** Solve A x = b for symmetric positive-definite A. Returns null when A is not usable. */
function solveSpd(a: number[][], b: number[]): number[] | null {
  const l = choleskyDecompose(a);
  if (!l) return null;
  const n = a.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= l[i][k] * y[k];
    y[i] = s / l[i][i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= l[k][i] * x[k];
    x[i] = s / l[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

/**
 * Inverse of a symmetric positive-definite matrix, by solving against the identity.
 * The lab fell back to a pseudo-inverse when J^T J was singular; here a tiny ridge is added
 * instead (documented deviation — it only ever affects a rank-deficient, prior-driven fit,
 * which is flagged `underdetermined` anyway).
 */
function invSpd(a: number[][]): number[][] | null {
  const n = a.length;
  let m = a;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cols: number[][] = [];
    let okAll = true;
    for (let j = 0; j < n; j++) {
      const e = new Array<number>(n).fill(0);
      e[j] = 1;
      const c = solveSpd(m, e);
      if (!c) {
        okAll = false;
        break;
      }
      cols.push(c);
    }
    if (okAll) {
      const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] = cols[j][i];
      return out;
    }
    let tr = 0;
    for (let i = 0; i < n; i++) tr += Math.abs(m[i][i]);
    const ridge = Math.max(tr / n, 1) * 10 ** (-10 + attempt * 3);
    m = m.map((row, i) => row.map((v, j) => (i === j ? v + ridge : v)));
  }
  return null;
}

// ─── Deterministic PRNG for the Monte-Carlo summary sigmas ───
// numpy's PCG64 is not reproducible here, so the DRAWS differ from the lab's. The sigmas are
// 64-draw Monte-Carlo estimates (~9 % relative noise on a sigma) so this is inside their own
// noise; what matters for the app is that the SAME input gives the SAME output, which it does.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormals(rand: () => number, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 2) {
    // Box-Muller. u1 is nudged off zero so log() stays finite.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

// ─── Club-bucket priors ───

/**
 * The Gaussian priors used as extra residuals. Weak by design: the pixels must win wherever
 * they carry information, and the prior only pins what they cannot see (spin on a short track,
 * speed on a three-frame one). Derived from `CLUB_PRIORS` by the lab's rule — sigma is the FULL
 * width of the plausible band for v0 and theta, and ln(hi/lo) for backspin.
 */
interface FitPrior {
  bucket: Bucket | 'generic';
  v0: number;
  v0Sigma: number;
  thetaDeg: number;
  thetaSigma: number;
  rpmBack: number;
  rpmLogSigma: number;
  tiltDeg: number;
  tiltSigma: number;
}

/** A straight-at-the-camera lob gives no curvature information, so tilt is only weakly pinned. */
const TILT_PRIOR_SIGMA_DEG = 15;

/**
 * The lab's wide fallback when no club bucket is known (`priors=None`): 40 +- 30 m/s,
 * 20 +- 15 deg, 5000 rpm with a log-sigma of 1. It constrains almost nothing, which is the
 * point — an unknown club must not be silently treated as a driver.
 */
const GENERIC_PRIOR: FitPrior = {
  bucket: 'generic',
  v0: 40,
  v0Sigma: 30,
  thetaDeg: 20,
  thetaSigma: 15,
  rpmBack: 5000,
  rpmLogSigma: 1,
  tiltDeg: 0,
  tiltSigma: TILT_PRIOR_SIGMA_DEG,
};

/** Roll band spanning every club, for the generic bucket. */
const GENERIC_ROLL_FRAC = [0, 0.15] as const;

export function priorFor(bucket?: Bucket): FitPrior {
  if (!bucket) return GENERIC_PRIOR;
  const p = CLUB_PRIORS[bucket];
  return {
    bucket,
    v0: p.v0[1],
    v0Sigma: p.v0[2] - p.v0[0],
    thetaDeg: p.thetaDeg[1],
    thetaSigma: p.thetaDeg[2] - p.thetaDeg[0],
    rpmBack: p.rpmBack[1],
    rpmLogSigma: Math.log(p.rpmBack[2] / p.rpmBack[0]),
    tiltDeg: 0,
    tiltSigma: TILT_PRIOR_SIGMA_DEG,
  };
}

// ─── GPS carry model (fit2 §2) ───

/**
 * The GPS gives the distance to the NEXT shot, so D = carry + roll (+ wherever the phone was
 * when the next shot was struck). The residual is (carry_pred * (1 + rollMean) - D) / sigma_D,
 *
 *     sigma_D^2 = sigma_gps^2 + bag^2 + (rollSigma * D)^2 + (fpxFrac * D)^2
 *
 * The roll band is a club-bucket property (`CLUB_PRIORS[bucket].rollFrac`) used as a SHIFTED
 * Gaussian: mean = the band midpoint, sigma = its half-width. That is a stated choice, not a
 * derivation — roll is one-sided in reality and least squares needs a mean and a sigma, and a
 * half-width is 1.7x the sigma of a uniform band, i.e. conservative.
 *
 * The f_px term is the fix the skeptic demanded (§6): without it the flag fires against a
 * CORRECT GPS reading whenever the focal-length prior is 10 % off, which is the regime real
 * readings live in.
 */
export interface CarryModelSpec {
  kind: 'nextShot' | 'carry';
  sigmaGpsM: number;
  bagOffsetM: number;
  rollFrac: readonly [number, number];
  fpxFrac: number;
}

export function carryModelFor(
  kind: 'nextShot' | 'carry',
  bucket: Bucket | 'generic',
  sigmaGpsM: number,
  fpxFrac: number
): CarryModelSpec {
  return {
    kind,
    sigmaGpsM,
    bagOffsetM: BAG_OFFSET_M,
    rollFrac: bucket === 'generic' ? GENERIC_ROLL_FRAC : CLUB_PRIORS[bucket].rollFrac,
    fpxFrac,
  };
}

function rollMean(cm: CarryModelSpec): number {
  return cm.kind === 'nextShot' ? 0.5 * (cm.rollFrac[0] + cm.rollFrac[1]) : 0;
}

function rollSigma(cm: CarryModelSpec): number {
  return cm.kind === 'nextShot' ? 0.5 * (cm.rollFrac[1] - cm.rollFrac[0]) : 0;
}

/** Model prediction of the GPS distance for a given carry. */
function dPred(cm: CarryModelSpec, carryM: number): number {
  return carryM * (1 + rollMean(cm));
}

/** 1-sigma of (D - dPred(carry)), evaluated at the measured D so it is constant in the fit. */
function sigmaD(cm: CarryModelSpec, dM: number, includeFpx: boolean): number {
  const roll = rollSigma(cm) * dM;
  const fpx = includeFpx ? cm.fpxFrac * dM : 0;
  return Math.sqrt(cm.sigmaGpsM ** 2 + cm.bagOffsetM ** 2 + roll * roll + fpx * fpx);
}

// ─── Honest label rounding ───

/**
 * Rounding step for a distance label given its total 1-sigma. A label more precise than its
 * own error is a lie the renderer tells, so 1 m is only allowed below 2.5 m of uncertainty.
 */
export function labelStepM(sigmaM: number): 1 | 5 | 10 {
  if (!Number.isFinite(sigmaM)) return 10;
  if (sigmaM <= 2.5) return 1;
  if (sigmaM <= 7.5) return 5;
  return 10;
}

export function roundLabelM(valueM: number, sigmaM: number): number {
  const step = labelStepM(sigmaM);
  return step * Math.round(valueM / step);
}

// ─── Flight sampling ───

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Flight samples placed at the ball's start point, at the requested flight times.
 *
 * The flight is simulated from z0 = the ball radius and lands at z = 0, exactly as the lab did,
 * so the placement offsets z by (start.z - R): at t = 0 the ball centre is at the address point
 * and at landing it is on the ground.
 *
 * `taus` must be ascending; they are, because they are (frame/fps - t0) over a sorted track.
 */
function positionsAt(fl: Flight, taus: number[], start: Vec3): Vec3[] {
  const s = fl.samples;
  const last = s.length - 1;
  const tEnd = s[last].t;
  const out: Vec3[] = new Array(taus.length);
  let i = 0;
  for (let k = 0; k < taus.length; k++) {
    const t = Math.min(Math.max(taus[k], 0), tEnd);
    while (i < last - 1 && s[i + 1].t < t) i++;
    const a = s[i];
    const b = s[i + 1] ?? a;
    const span = b.t - a.t;
    const f = span > 0 ? (t - a.t) / span : 0;
    out[k] = {
      x: start.x + a.x + f * (b.x - a.x),
      y: start.y + a.y + f * (b.y - a.y),
      z: start.z - BALL_RADIUS_M + a.z + f * (b.z - a.z),
    };
  }
  return out;
}

/**
 * The forward model, in the lab's parameterisation: tilt is TrackMan-signed, rpmSide follows.
 *
 * `maxTSec` is what makes the fit affordable on a phone. A pixel-only residual only needs the
 * flight as far as the last observed frame — a fifth of a second, ~25 RK4 steps — where the full
 * flight is 7 s and 840 steps. The lab did exactly this (`max_t = tau_max + 2*dt`); leaving it
 * out would multiply every fit's cost by ~30 for no change in the answer.
 */
function simulateParams(p: Params, dtSec: number, maxTSec?: number): Flight {
  return simulate({
    v0: p.v0,
    thetaDeg: p.thetaDeg,
    phiDeg: p.phiDeg,
    rpmBack: p.rpmBack,
    // TrackMan sign: positive tilt = axis tilted RIGHT = fade for a right-hander, and the
    // physics module's +rpmSide curves LEFT, hence the minus. (lab fit.py::_simulate)
    rpmSide: -p.rpmBack * Math.tan((p.tiltDeg * Math.PI) / 180),
    dt: dtSec,
    z0: BALL_RADIUS_M,
    maxTSec,
  });
}

/**
 * The exact (f_px, depth, speed) degeneracy of a single-depth scene: scaling f by s scales every
 * ground depth by s, so v0 -> s*v0 and theta -> atan(tan(theta)/s) leave every projected pixel
 * unchanged to first order (skeptic-physics §2, measured flat to 0.03 px on real footage).
 * Used to turn an f_px uncertainty into carry / apex uncertainty.
 */
function fpxFamily(p: Params, s: number): Params {
  return {
    ...p,
    v0: Math.min(Math.max(p.v0 * s, BOUNDS.v0[0]), BOUNDS.v0[1]),
    thetaDeg: (Math.atan(Math.tan((p.thetaDeg * Math.PI) / 180) / s) * 180) / Math.PI,
  };
}

// ─── The residual problem ───

/**
 * Residual assembly with a variable free/fixed split, so the same problem can be solved with a
 * reduced parameter set (stage 1, ranking the multistart basins) and then the full one (stage 2).
 *
 * Residual layout, in order: 2N pixel residuals, then one per free parameter that has a prior,
 * then — on a joint fit — one carry residual. Everything is in sigma units, so the sum of
 * squares is a chi-squared.
 */
class FitProblem {
  nFev = 0;

  /** Longest flight time any observed frame can need, given t0 >= tLo. */
  private readonly tauMax: number;
  private readonly off: Params;
  private readonly scale: Params;
  private readonly camCache = new Map<number, { cam: TracerCamera; start: Vec3 }>();

  constructor(
    readonly camera: TracerCamera,
    readonly addressPx: Px,
    /** Clip time of each track frame, seconds. Ascending. */
    readonly tObs: number[],
    readonly obsUv: Px[],
    readonly sig: number[],
    readonly tLo: number,
    readonly tHi: number,
    readonly prior: FitPrior,
    readonly carryM: number | null,
    readonly carrySigma: number,
    readonly carryModel: CarryModelSpec | null,
    readonly dtSec: number,
    readonly pitchSigmaDeg: number
  ) {
    this.tauMax = tObs[tObs.length - 1] - tLo;
    this.off = {
      v0: 0,
      thetaDeg: 0,
      phiDeg: 0,
      rpmBack: 0,
      tiltDeg: 0,
      dPitchDeg: 0,
      t0Sec: tLo,
    };
    this.scale = {
      ...SCALES,
      t0Sec: tHi - tLo,
    };
  }

  /**
   * Camera and ball start point for a pitch correction, in the lab's `keep_h` mode: h_cam is
   * held and the start point is re-back-projected, so +1 deg of pitch also brings the ball ~6 %
   * closer. That is the one-dimensional geometry family the real tracks actually follow — the
   * alternative (`keep_range`, trust the ball diameter and re-solve h_cam) fits worse on all
   * three long lab tracks (fit report §3).
   */
  cameraFor(dPitchDeg: number): { cam: TracerCamera; start: Vec3 } {
    const key = Math.round(dPitchDeg * 1e9) / 1e9;
    const hit = this.camCache.get(key);
    if (hit) return hit;
    const cam = key === 0 ? this.camera : this.camera.withPitchDelta(key);
    let start = cam.ballCentreFromPixel(this.addressPx);
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(start.z)) {
      // The address pixel is above the horizon for this pitch. Put the ball somewhere absurd so
      // the residual explodes and the optimiser backs out, rather than propagating a NaN.
      start = { x: 1e3, y: 0, z: 0 };
    }
    const entry = { cam, start };
    if (this.camCache.size > 4096) this.camCache.clear();
    this.camCache.set(key, entry);
    return entry;
  }

  /** Unit scale of a parameter, so the caller can turn a scaled covariance into a physical one. */
  scaleOf(n: ParamName): number {
    return this.scale[n];
  }

  toX(p: Params, free: readonly ParamName[]): number[] {
    return free.map((n) => (p[n] - this.off[n]) / this.scale[n]);
  }

  unpack(x: readonly number[], free: readonly ParamName[], fixed: Partial<Params>): Params {
    const p = { ...(fixed as Params) };
    for (let i = 0; i < free.length; i++) {
      const n = free[i];
      p[n] = x[i] * this.scale[n] + this.off[n];
    }
    return p;
  }

  bounds(free: readonly ParamName[]): { lo: number[]; hi: number[] } {
    const lo: number[] = [];
    const hi: number[] = [];
    for (const n of free) {
      if (n === 't0Sec') {
        // The ball is at address in the impact frame and displaced in the next one, so the
        // true impact time is inside that one-frame interval. This is a hard bound, not a prior.
        lo.push(0);
        hi.push(1);
      } else {
        lo.push(BOUNDS[n][0] / this.scale[n]);
        hi.push(BOUNDS[n][1] / this.scale[n]);
      }
    }
    return { lo, hi };
  }

  pixelResiduals(p: Params, fl: Flight, out: number[], at: number): number {
    const { cam, start } = this.cameraFor(p.dPitchDeg);
    const taus = this.tObs.map((t) => t - p.t0Sec);
    const uv = cam.project(positionsAt(fl, taus, start));
    let k = at;
    for (let i = 0; i < uv.length; i++) {
      const s = this.sig[i];
      const du = (uv[i].x - this.obsUv[i].x) / s;
      const dv = (uv[i].y - this.obsUv[i].y) / s;
      out[k++] = Number.isFinite(du) ? du : 1e3;
      out[k++] = Number.isFinite(dv) ? dv : 1e3;
    }
    return k;
  }

  priorResiduals(p: Params, free: readonly ParamName[], out: number[], at: number): number {
    const q = this.prior;
    let k = at;
    // Order matters only for reading the Jacobian; it mirrors the lab's.
    if (free.includes('v0')) out[k++] = (p.v0 - q.v0) / q.v0Sigma;
    if (free.includes('thetaDeg')) out[k++] = (p.thetaDeg - q.thetaDeg) / q.thetaSigma;
    if (free.includes('rpmBack')) out[k++] = Math.log(Math.max(p.rpmBack, 1e-3) / q.rpmBack) / q.rpmLogSigma;
    if (free.includes('tiltDeg')) out[k++] = (p.tiltDeg - q.tiltDeg) / q.tiltSigma;
    if (free.includes('dPitchDeg')) out[k++] = p.dPitchDeg / this.pitchSigmaDeg;
    return k;
  }

  carryResidual(fl: Flight): number {
    const cm = this.carryModel;
    const carry = fl.summary.carryM;
    const pred = cm ? dPred(cm, carry) : carry;
    return (pred - (this.carryM as number)) / this.carrySigma;
  }

  /** Count of prior residuals for a given free set — needed to size the residual vector. */
  nPriorResiduals(free: readonly ParamName[]): number {
    let n = 0;
    for (const name of ['v0', 'thetaDeg', 'rpmBack', 'tiltDeg', 'dPitchDeg'] as const) {
      if (free.includes(name)) n++;
    }
    return n;
  }

  residuals(x: readonly number[], free: readonly ParamName[], fixed: Partial<Params>, useCarry: boolean): number[] {
    this.nFev++;
    const p = this.unpack(x, free, fixed);
    // A joint fit needs the carry, so it needs the whole flight; a pixel-only one does not.
    const fl = simulateParams(p, this.dtSec, useCarry ? undefined : this.tauMax + 2 * this.dtSec);
    const m = 2 * this.tObs.length + this.nPriorResiduals(free) + (useCarry ? 1 : 0);
    const out = new Array<number>(m);
    let k = this.pixelResiduals(p, fl, out, 0);
    k = this.priorResiduals(p, free, out, k);
    if (useCarry) out[k++] = this.carryResidual(fl);
    return out;
  }
}

// ─── Bounded Levenberg-Marquardt with a soft-L1 loss ───

/**
 * scipy's exact IRLS trick for a robust loss (`scale_for_robust_loss_function`). With
 * z = (f/fScale)^2 and rho(z) = 2(sqrt(1+z) - 1):
 *
 *     Jscale = sqrt(rho'(z) + 2 rho''(z) z) = (1+z)^(-3/4)
 *     f_scaled = f * rho'(z) / Jscale       = f * (1+z)^(1/4)
 *
 * so that J_s^T f_s is the EXACT gradient of the robust cost and J_s^T J_s its Gauss-Newton
 * Hessian including the loss curvature. Without this the optimiser would minimise a different
 * function from the one the lab minimised, and every fitted number would drift.
 */
function scaleForRobustLoss(j: number[][], f: readonly number[], fScale: number): { js: number[][]; fs: number[] } {
  const m = f.length;
  const n = j[0]?.length ?? 0;
  const js: number[][] = new Array(m);
  const fs = new Array<number>(m);
  const inv = 1 / fScale;
  for (let i = 0; i < m; i++) {
    const z = (f[i] * inv) ** 2;
    const s = (1 + z) ** -0.75;
    fs[i] = f[i] * (1 + z) ** 0.25;
    const row = new Array<number>(n);
    for (let k = 0; k < n; k++) row[k] = j[i][k] * s;
    js[i] = row;
  }
  return { js, fs };
}

/** 0.5 * sum(fScale^2 * rho(z)) — scipy's `cost`, which is what candidate seeds are ranked by. */
function robustCost(f: readonly number[], fScale: number): number {
  let s = 0;
  const inv = 1 / fScale;
  for (let i = 0; i < f.length; i++) s += Math.sqrt(1 + (f[i] * inv) ** 2) - 1;
  return fScale * fScale * s;
}

interface LmResult {
  x: number[];
  cost: number;
  nfev: number;
  iterations: number;
  success: boolean;
  message: string;
}

/**
 * Forward-difference Jacobian, with the step reflected inward at an upper bound so the probe
 * never leaves the box. The relative step is the lab's `diff_step=1e-6`; the residual is smooth
 * in every parameter (the flight is a fixed-step RK4 and the sampling is linear interpolation
 * inside a 1/120 s segment) so a one-sided difference is accurate enough and costs n evaluations
 * instead of 2n.
 */
function numericJacobian(
  fn: (x: readonly number[]) => number[],
  x: readonly number[],
  f0: readonly number[],
  hi: readonly number[]
): number[][] {
  const n = x.length;
  const m = f0.length;
  const j: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  for (let k = 0; k < n; k++) {
    let h = 1e-6 * Math.max(1, Math.abs(x[k]));
    if (x[k] + h > hi[k]) h = -h;
    const xp = x.slice();
    xp[k] += h;
    const fp = fn(xp);
    for (let i = 0; i < m; i++) j[i][k] = (fp[i] - f0[i]) / h;
  }
  return j;
}

/**
 * Bounded Levenberg-Marquardt. Box constraints are handled by projecting the trial point back
 * into the box (the task's stated approach) and by zeroing the components of the gradient that
 * point out of an active bound before the convergence test. That is weaker than scipy's TRF
 * interior reflection, but the bounds here are physical limits that a good fit is not sitting on
 * — and when it IS sitting on one the fit is flagged (`*_at_upper_bound`) and the ladder can act.
 */
function levenbergMarquardt(
  fn: (x: readonly number[]) => number[],
  x0: readonly number[],
  lo: readonly number[],
  hi: readonly number[],
  opt: { maxIterations: number; maxNfev: number; fScale: number }
): LmResult {
  const n = x0.length;
  const clip = (v: number[]) => v.map((vi, i) => Math.min(Math.max(vi, lo[i]), hi[i]));
  let x = clip(x0.slice());
  let f = fn(x);
  let cost = robustCost(f, opt.fScale);
  let nfev = 1;
  let lambda = 1e-3;
  let iterations = 0;
  let message = 'max iterations';
  let success = false;

  const ftol = 1e-8;
  const xtol = 1e-8;
  const gtol = 1e-8;

  while (iterations < opt.maxIterations) {
    if (nfev >= opt.maxNfev) {
      message = 'max function evaluations';
      break;
    }
    const j = numericJacobian(fn, x, f, hi);
    nfev += n;
    const { js, fs } = scaleForRobustLoss(j, f, opt.fScale);

    // g = J^T f, H = J^T J, both in the robust-scaled metric.
    const g = new Array<number>(n).fill(0);
    const h: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < fs.length; i++) {
      const row = js[i];
      const fi = fs[i];
      for (let a = 0; a < n; a++) {
        g[a] += row[a] * fi;
        for (let b = a; b < n; b++) h[a][b] += row[a] * row[b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) h[a][b] = h[b][a];

    // Projected gradient: a component pushing out of an active bound cannot reduce the cost.
    let gMax = 0;
    for (let a = 0; a < n; a++) {
      const span = Math.max(hi[a] - lo[a], 1e-12);
      const atLo = x[a] - lo[a] < 1e-12 * span && g[a] > 0;
      const atHi = hi[a] - x[a] < 1e-12 * span && g[a] < 0;
      if (!atLo && !atHi) gMax = Math.max(gMax, Math.abs(g[a]));
    }
    if (gMax < gtol) {
      success = true;
      message = 'gtol';
      break;
    }

    // Active set: a component pinned at a bound whose gradient points out of the box cannot
    // move this iteration, so it is dropped from the linear solve entirely. Leaving it in and
    // clipping afterwards distorts the step direction for every OTHER component, which is how a
    // projected-step LM ends up crawling along a bound (the failure fit2 hit with a seed sitting
    // on the 15 000 rpm spin bound: 7000 evaluations).
    const activeFree: number[] = [];
    for (let i = 0; i < n; i++) {
      const span = Math.max(hi[i] - lo[i], 1e-12);
      const atLo = x[i] - lo[i] < 1e-10 * span && g[i] > 0;
      const atHi = hi[i] - x[i] < 1e-10 * span && g[i] < 0;
      if (!atLo && !atHi) activeFree.push(i);
    }

    let accepted = false;
    for (let inner = 0; inner < 30; inner++) {
      const k = activeFree.length;
      const a: number[][] = Array.from({ length: k }, (_, i) =>
        activeFree.map((cj, j) => {
          const v = h[activeFree[i]][cj];
          return i === j ? v + lambda * Math.max(v, 1e-12) : v;
        })
      );
      const dRed = k > 0 ? solveSpd(a, activeFree.map((i) => -g[i])) : null;
      if (dRed) {
        const d = new Array<number>(n).fill(0);
        activeFree.forEach((i, j) => {
          d[i] = dRed[j];
        });
        // Two trial points per damping value, because neither alone is enough:
        //  (a) the step truncated to stay just inside the box — keeps the descent DIRECTION;
        //  (b) the full step hard-clipped — lets a parameter that genuinely belongs on a bound
        //      arrive in one iteration instead of creeping toward it geometrically.
        let alpha = 1;
        for (const i of activeFree) {
          if (d[i] > 0) alpha = Math.min(alpha, (hi[i] - x[i]) / d[i]);
          else if (d[i] < 0) alpha = Math.min(alpha, (lo[i] - x[i]) / d[i]);
        }
        const trials: number[][] = [];
        if (alpha < 1) {
          trials.push(clip(x.map((v, i) => v + 0.995 * alpha * d[i])));
          trials.push(clip(x.map((v, i) => v + d[i])));
        } else {
          trials.push(clip(x.map((v, i) => v + d[i])));
        }
        let bestTrial: { x: number[]; f: number[]; cost: number } | null = null;
        for (const xn of trials) {
          const fnv = fn(xn);
          nfev++;
          const costN = robustCost(fnv, opt.fScale);
          if (!bestTrial || costN < bestTrial.cost) bestTrial = { x: xn, f: fnv, cost: costN };
          if (nfev >= opt.maxNfev) break;
        }
        if (bestTrial && bestTrial.cost < cost) {
          let step = 0;
          let norm = 0;
          for (let i = 0; i < n; i++) {
            step += (bestTrial.x[i] - x[i]) ** 2;
            norm += x[i] ** 2;
          }
          const dcost = cost - bestTrial.cost;
          x = bestTrial.x;
          f = bestTrial.f;
          cost = bestTrial.cost;
          accepted = true;
          lambda = Math.max(lambda / 3, 1e-12);
          if (dcost < ftol * Math.max(cost, 1e-30)) {
            success = true;
            message = 'ftol';
          } else if (Math.sqrt(step) < xtol * (Math.sqrt(norm) + xtol)) {
            success = true;
            message = 'xtol';
          }
          break;
        }
      }
      lambda *= 3;
      if (lambda > 1e12) {
        // No downhill step exists in this metric: the point is a (constrained) minimum.
        success = true;
        message = 'lambda';
        break;
      }
      if (nfev >= opt.maxNfev) break;
    }
    iterations++;
    if (success) break;
    if (!accepted) {
      // 30 damping increases without a downhill step, or the evaluation budget ran out.
      message = nfev >= opt.maxNfev ? 'max function evaluations' : 'no downhill step';
      break;
    }
  }

  return { x, cost, nfev, iterations, success, message };
}

// ─── The public fit ───

function nowMs(): number {
  const g = globalThis as { performance?: { now?: () => number } };
  return typeof g.performance?.now === 'function' ? g.performance.now() : Date.now();
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Fit the launch state to a pixel track.
 *
 * Throws (rather than returning `ok: false`) for inputs from which NO fit can be formed, so the
 * caller has to test them itself and the failure is never mistaken for a bad shot:
 *   * an empty track, or a non-finite fps;
 *   * a first track frame that is not after `impactFrame` (the ball is at address in that frame);
 *   * an address pixel that does not back-project onto the ground plane (above the horizon).
 * `ok: false` means a fit RAN and should not be trusted.
 *
 * With a carry the pixel-only fit is run FIRST and its optimum seeds the joint fit. That is not
 * an optimisation, it is a correctness fix: without it the joint fit on IMG_3632 settled in a
 * worse pixel minimum (chi2_px 16.2 vs 4.0) and reported a false `carry_inconsistent` (fit2 §1).
 */
export function fitLaunch(a: FitOptions): FitResult {
  const tStart = nowMs();
  const { camera, addressPx, impactFrame, fps } = a;

  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`tracerFit: fps must be positive, got ${fps}`);

  const track = a.track
    .filter((p) => Number.isFinite(p.frame) && Number.isFinite(p.x) && Number.isFinite(p.y))
    .slice()
    .sort((p, q) => p.frame - q.frame);
  if (track.length === 0) throw new Error('tracerFit: empty track');

  // The lab's label noise model: sigma = width/1080 px for a confident point, 3x for a doubtful
  // one. width is the SHORT axis of the display-oriented portrait frame, so a 4K clip weights
  // its pixels at 2 and a 1080p clip at 1 — the same physical accuracy either way.
  const pxSigma = camera.params.width / 1080;
  const sig = track.map((p) => {
    const conf = clampNum(p.conf ?? 1, 0, 1);
    return pxSigma * (1 + (TRACK_SIGMA_APPROX_MULTIPLIER - 1) * (1 - conf));
  });

  const tObs = track.map((p) => p.frame / fps);
  const obsUv: Px[] = track.map((p) => ({ x: p.x, y: p.y }));
  // F2: only the LOWER bound moves. `tHi` stays at (impactFrame + 1)/fps, so the "first track
  // frame is not after impactFrame" guard below is unchanged and a slack can never let the fit
  // put the launch after the first detection.
  const slackFrames = Number.isFinite(a.impactSlackFrames ?? 0) ? Math.max(0, a.impactSlackFrames ?? 0) : 0;
  const tLo = (impactFrame - slackFrames) / fps;
  const tHi = (impactFrame + 1) / fps;
  if (tObs[0] < tHi - 1e-9) {
    throw new Error(
      `tracerFit: first track frame ${track[0].frame} is not after impactFrame ${impactFrame}`
    );
  }
  const start0 = camera.ballCentreFromPixel(addressPx);
  if (!Number.isFinite(start0.x) || !Number.isFinite(start0.y) || !Number.isFinite(start0.z)) {
    throw new Error('tracerFit: address pixel does not back-project onto the ground plane');
  }

  const prior = priorFor(a.bucket);
  const fpxFrac = a.fpxFrac ?? (camera.params.fPxIsPrior ? FPX_FRAC_PRIOR : FPX_FRAC_DEVICE);
  const pitchSigmaDeg = a.pitchSigmaDeg ?? 1.5;
  const dtSec = a.dtSec ?? DEFAULT_DT_SEC;
  const maxIterations = a.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const multistart = a.multistart ?? true;
  const mcSamples = a.mcSamples ?? 64;
  const seed = a.seed ?? 0;

  const fixed: Partial<Params> = {};
  if (a.fixSpin) {
    fixed.rpmBack = prior.rpmBack;
    fixed.tiltDeg = prior.tiltDeg;
  }
  if (!a.fitPitch) fixed.dPitchDeg = 0;
  const free = PARAM_NAMES.filter((n) => !(n in fixed));

  const carryKind = a.carryModel === undefined ? 'nextShot' : a.carryModel;
  const carryM = a.carryM ?? null;
  const useCarry =
    carryKind !== null && carryM !== null && Number.isFinite(carryM) && carryM > 0;
  const cm = useCarry ? carryModelFor(carryKind, prior.bucket, a.carrySigmaGpsM ?? DEFAULT_GPS_SIGMA_M, fpxFrac) : null;
  // The f_px term is noise only because nothing in this fit can absorb it (there is no f-scale
  // nuisance in the app's parameter set), so it always belongs in sigma_D.
  const sigmaDUsed = cm ? sigmaD(cm, carryM as number, true) : Number.NaN;

  const prob = new FitProblem(
    camera, addressPx, tObs, obsUv, sig, tLo, tHi, prior,
    useCarry ? (carryM as number) : null, sigmaDUsed, cm, dtSec, pitchSigmaDeg
  );

  // ── the pixel-only companion first: it seeds the joint fit and calibrates its carry test ──
  let pixelOnly: FitResult | null = a.pixelOnly ?? null;
  if (useCarry && !pixelOnly) {
    pixelOnly = fitLaunch({ ...a, carryM: null, carryModel: null, pixelOnly: null });
  }

  // ── seeds ──
  const base: Params = {
    v0: prior.v0,
    thetaDeg: prior.thetaDeg,
    phiDeg: 0,
    rpmBack: prior.rpmBack,
    tiltDeg: prior.tiltDeg,
    dPitchDeg: 0,
    // The lab seeds the midpoint of the IMPACT FRAME's own interval, not of the slack-widened one
    // (fit.py:688, `0.5 * (impact_frame / fps + t_hi)`). Identical while the slack is 0, which is
    // why this only had to be said once F2 made the slack non-zero: seeding at the widened
    // midpoint would start the optimiser further from the launch the more doubtful the impact
    // frame is, which is backwards.
    t0Sec: 0.5 * (impactFrame / fps + tHi),
  };
  // A parameter held fixed must seed at its held value, not at the prior's.
  Object.assign(base, fixed);
  const seededJoint = useCarry && pixelOnly !== null;
  const seeds: Params[] = [{ ...base }];
  // With a pixel-only optimum in hand the 13-seed prior multistart is redundant for the joint
  // fit: it reached the identical cost in 24/24 lab cases at 4x the runtime (fit2 §1).
  if (multistart && !seededJoint) {
    for (const fv of [0.5, 0.75, 1.25, 1.6]) {
      for (const dth of [-10, 0, 10]) {
        const s = { ...base };
        if (free.includes('v0')) s.v0 = clampNum(prior.v0 * fv, BOUNDS.v0[0] + 1, BOUNDS.v0[1] - 1);
        if (free.includes('thetaDeg')) {
          s.thetaDeg = clampNum(prior.thetaDeg + dth, BOUNDS.thetaDeg[0] + 1, BOUNDS.thetaDeg[1] - 1);
        }
        seeds.push(s);
      }
    }
  }

  // ── stage 1: the reduced model (spin and the pitch nuisance held), to rank the basins ──
  const free1 = free.filter((n) => n !== 'rpmBack' && n !== 'tiltDeg' && n !== 'dPitchDeg');
  const fixed1: Partial<Params> = { ...fixed };
  for (const n of ['rpmBack', 'tiltDeg', 'dPitchDeg'] as const) {
    if (free.includes(n)) fixed1[n] = base[n];
  }
  const b1 = prob.bounds(free1);
  const fn1 = (x: readonly number[]) => prob.residuals(x, free1, fixed1, useCarry);
  const nfev1 = multistart && !seededJoint ? STAGE1_MULTISTART_MAX_NFEV : SEEDED_MAX_NFEV;
  const stage1 = seeds
    .map((s) => {
      const r = levenbergMarquardt(fn1, prob.toX(s, free1), b1.lo, b1.hi, {
        maxIterations,
        maxNfev: nfev1,
        fScale: F_SCALE,
      });
      return { cost: r.cost, p: prob.unpack(r.x, free1, fixed1) };
    })
    .sort((x, y) => x.cost - y.cost);

  // ── stage 2: the full free set, from the best stage-1 basins plus the pixel-only optimum ──
  const cands: { p: Params; src: string; maxNfev: number }[] = stage1
    .slice(0, multistart && !seededJoint ? 2 : 1)
    .map((r) => ({ p: r.p, src: 'prior', maxNfev: STAGE2_MAX_NFEV }));

  if (useCarry && pixelOnly) {
    // The pixel-only optimum EXACTLY as found. This candidate is not in the lab (its optimiser
    // needed the nudge below to avoid crawling along an active bound) and it is what makes the
    // fit2 invariant hold here: started at the pixel-only minimum, the joint fit can only leave
    // it for something cheaper, so its total cost can never exceed pixel-only + its carry term.
    // Without it IMG_3632 (spin pinned at 15 000 rpm, t0 pinned at impact) converged from the
    // nudged seed to a 10 % worse cost and raised a false `joint_fit_worse_pixel_minimum`.
    const pExact: Params = { ...base };
    for (const n of free) pExact[n] = pixelOnly.params[n];
    cands.push({ p: pExact, src: 'pixel_only_exact', maxNfev: SEEDED_MAX_NFEV });

    // The lab's nudged copy: every component pushed 2 % of its range off any bound, because a
    // seed sitting exactly on one made scipy's TRF crawl (7000 evaluations / 8 s on IMG_3632).
    // Kept because it does sometimes find the better basin — the candidates are ranked by cost.
    const pPx: Params = { ...base };
    for (const n of free) {
      if (n === 't0Sec') continue;
      const [blo, bhi] = BOUNDS[n];
      const margin = 0.02 * (bhi - blo);
      pPx[n] = clampNum(pixelOnly.params[n], blo + margin, bhi - margin);
    }
    const tMargin = 0.02 * (tHi - tLo);
    pPx.t0Sec = clampNum(pixelOnly.params.t0Sec, tLo + tMargin, tHi - tMargin);
    cands.push({ p: pPx, src: 'pixel_only', maxNfev: SEEDED_MAX_NFEV });

    const cPx = pixelOnly.summary.carryM;
    const target = (carryM as number) / (1 + rollMean(cm as CarryModelSpec));
    if (cPx > 1e-6 && free.includes('v0')) {
      // carry grows roughly as v0^1.1 in this drag model, so v0 scales as (D/carry)^0.9.
      const ratio = clampNum((target / cPx) ** 0.9, 0.5, 1.6);
      if (Math.abs(ratio - 1) > 0.03) {
        const pRs: Params = { ...pPx, v0: clampNum(pPx.v0 * ratio, BOUNDS.v0[0] + 0.5, BOUNDS.v0[1] - 0.5) };
        cands.push({ p: pRs, src: 'pixel_only_rescaled', maxNfev: SEEDED_MAX_NFEV });
      }
    }
  }

  const bF = prob.bounds(free);
  const fnFull = (x: readonly number[]) => prob.residuals(x, free, fixed, useCarry);
  let best: LmResult | null = null;
  let seedSource = 'prior';
  for (const c of cands) {
    const r = levenbergMarquardt(fnFull, prob.toX(c.p, free), bF.lo, bF.hi, {
      maxIterations,
      maxNfev: c.maxNfev,
      fScale: F_SCALE,
    });
    if (!best || r.cost < best.cost - 1e-12) {
      best = r;
      seedSource = c.src;
    }
  }
  const res = best as LmResult;
  const p = prob.unpack(res.x, free, fixed);
  const { cam: camFit, start } = prob.cameraFor(p.dPitchDeg);

  // ── residuals, chi-squareds, covariance ──
  const flFull = simulateParams(p, dtSec);
  const predUv = camFit.project(positionsAt(flFull, tObs.map((t) => t - p.t0Sec), start));
  const residualPx: number[] = [];
  let chi2Px = 0;
  for (let i = 0; i < predUv.length; i++) {
    const du = predUv[i].x - obsUv[i].x;
    const dv = predUv[i].y - obsUv[i].y;
    residualPx.push(Math.hypot(du, dv));
    chi2Px += (du / sig[i]) ** 2 + (dv / sig[i]) ** 2;
  }
  const priorRes: number[] = [];
  prob.priorResiduals(p, free, priorRes, 0);
  const chi2Prior = priorRes.reduce((s, v) => s + v * v, 0);
  const chi2Carry = useCarry ? prob.carryResidual(flFull) ** 2 : null;
  const nFree = free.length;
  const dof = 2 * track.length - nFree;
  const chi2Red = dof > 0 ? chi2Px / dof : Number.NaN;
  const inflate = dof > 0 ? Math.max(1, chi2Red) : 1;

  const fFinal = prob.residuals(res.x, free, fixed, useCarry);
  const jFinal = numericJacobian(fnFull, res.x, fFinal, bF.hi);
  const { js } = scaleForRobustLoss(jFinal, fFinal, F_SCALE);
  const hMat: number[][] = Array.from({ length: nFree }, () => new Array<number>(nFree).fill(0));
  for (let i = 0; i < js.length; i++) {
    for (let x1 = 0; x1 < nFree; x1++) {
      for (let x2 = 0; x2 < nFree; x2++) hMat[x1][x2] += js[i][x1] * js[i][x2];
    }
  }
  const covXRaw = invSpd(hMat);
  const covX = covXRaw ? covXRaw.map((row) => row.map((v) => v * inflate)) : null;
  const sigma: Record<string, number | null> = {};
  for (const n of PARAM_NAMES) sigma[n] = null;
  if (covX) {
    free.forEach((n, i) => {
      const v = covX[i][i] * prob.scaleOf(n) ** 2;
      sigma[n] = v > 0 && Number.isFinite(v) ? Math.sqrt(v) : null;
    });
  }

  // ── Monte-Carlo propagation of the covariance into the flight summary ──
  const summary = flFull.summary;
  const summarySigma: FlightSummary = {
    carryM: Number.NaN,
    apexM: Number.NaN,
    hangS: Number.NaN,
    landAngleDeg: Number.NaN,
    lateralM: Number.NaN,
  };
  if (covX && mcSamples > 0 && nFree > 0) {
    const l = choleskyDecompose(covX);
    const rand = mulberry32(seed);
    const acc: Record<keyof FlightSummary, number[]> = {
      carryM: [], apexM: [], hangS: [], landAngleDeg: [], lateralM: [],
    };
    for (let d = 0; d < mcSamples; d++) {
      const z = standardNormals(rand, nFree);
      const xd = res.x.slice();
      for (let i = 0; i < nFree; i++) {
        // Correlated draw when the Cholesky exists; independent-diagonal fallback when it does
        // not (a rank-deficient, already-flagged fit), matching the lab's own fallback.
        let delta = 0;
        if (l) for (let k = 0; k <= i; k++) delta += l[i][k] * z[k];
        else delta = Math.sqrt(Math.max(covX[i][i], 0)) * z[i];
        xd[i] = clampNum(xd[i] + delta, bF.lo[i], bF.hi[i]);
      }
      const s = simulateParams(prob.unpack(xd, free, fixed), dtSec).summary;
      acc.carryM.push(s.carryM);
      acc.apexM.push(s.apexM);
      acc.hangS.push(s.hangS);
      acc.landAngleDeg.push(s.landAngleDeg);
      acc.lateralM.push(s.lateralM);
    }
    for (const k of Object.keys(acc) as (keyof FlightSummary)[]) {
      const v = acc[k];
      const mean = v.reduce((s2, x2) => s2 + x2, 0) / v.length;
      summarySigma[k] = Math.sqrt(v.reduce((s2, x2) => s2 + (x2 - mean) ** 2, 0) / v.length);
    }
  }

  // ── the systematic error budget (fit2 §3) ──
  // A camera-pitch error is 1:1 a launch-angle error (skeptic-physics §3 — the perturbation the
  // original fit report never ran, and the reason its "launch angle robust to +-1 deg" claim was
  // refuted). If dpitch is fitted its posterior is already in the formal covariance.
  // f_px moves v0 and theta along the exact degeneracy above; carry and apex come from two extra
  // simulations along the same family.
  const th = (p.thetaDeg * Math.PI) / 180;
  const fEff = fpxFrac;
  const pitchEff = a.fitPitch ? 0 : pitchSigmaDeg;
  const num = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v : 0);
  let famCarry = 0;
  let famApex = 0;
  if (fEff > 0) {
    const hiF2 = simulateParams(fpxFamily(p, 1 + fEff), dtSec).summary;
    const loF2 = simulateParams(fpxFamily(p, 1 - fEff), dtSec).summary;
    famCarry = 0.5 * Math.abs(hiF2.carryM - loF2.carryM);
    famApex = 0.5 * Math.abs(hiF2.apexM - loF2.apexM);
  }
  const budget: Record<string, BudgetTerms> = {
    thetaDeg: {
      formal: num(sigma.thetaDeg),
      pitch: pitchEff,
      fpx: ((fEff * Math.sin(th) * Math.cos(th)) * 180) / Math.PI,
      total: 0,
    },
    v0: { formal: num(sigma.v0), pitch: 0, fpx: fEff * p.v0, total: 0 },
    carryM: { formal: num(summarySigma.carryM), pitch: 0, fpx: famCarry, total: 0 },
    apexM: { formal: num(summarySigma.apexM), pitch: 0, fpx: famApex, total: 0 },
  };
  for (const k of Object.keys(budget)) {
    const t = budget[k];
    t.total = Math.sqrt(t.formal ** 2 + t.pitch ** 2 + t.fpx ** 2);
  }
  const sigmaTotal = {
    thetaDeg: budget.thetaDeg.total,
    v0: budget.v0.total,
    carryM: budget.carryM.total,
    apexM: budget.apexM.total,
  };

  // ── flags ──
  const flags: string[] = [];
  free.forEach((n, i) => {
    const span = bF.hi[i] - bF.lo[i];
    if (res.x[i] - bF.lo[i] < 1e-4 * span) flags.push(`${FLAG_PARAM_NAME[n]}_at_lower_bound`);
    else if (bF.hi[i] - res.x[i] < 1e-4 * span) flags.push(`${FLAG_PARAM_NAME[n]}_at_upper_bound`);
  });
  if (track.length < 3) flags.push(`few_frames:${track.length}`);
  if (dof <= 0) {
    flags.push(`underdetermined:${2 * track.length}_pixel_equations_for_${nFree}_free_params(prior-driven)`);
  }
  if (free.includes('rpmBack') && sigma.rpmBack != null && sigma.rpmBack > 0.5 * p.rpmBack) {
    flags.push('spin_unidentified(sigma>50%)');
  }
  if (free.includes('tiltDeg') && sigma.tiltDeg != null && sigma.tiltDeg > 10) {
    flags.push('tilt_unidentified(sigma>10deg)');
  }
  const rmsPx = Math.sqrt(residualPx.reduce((s, v) => s + v * v, 0) / residualPx.length);
  const sortedSig = [...sig].sort((x, y) => x - y);
  const mid = sortedSig.length >> 1;
  const medSig = sortedSig.length % 2 ? sortedSig[mid] : 0.5 * (sortedSig[mid - 1] + sortedSig[mid]);
  // Three times the label noise. The skeptic's point: a residual this size means the geometry or
  // the impact frame is wrong, and the ladder must treat it as "re-check", not as a result.
  if (rmsPx > 3 * medSig) flags.push('large_pixel_residual');
  if (!res.success) flags.push('optimizer_not_converged');
  if (camera.params.fPxIsPrior) flags.push(`fpx_is_prior(+-${Math.round(100 * fpxFrac)}%_on_v0)`);

  // ── carry consistency (fit2 §2) ──
  let carryStatus: CarryStatus | null = null;
  let carryZ: number | null = null;
  let carryZNoPixelSigma: number | null = null;
  if (useCarry && cm) {
    // REVIEW F1(a). This branch used to REFUSE the test whenever the pixel-only Monte Carlo came
    // back non-finite (a singular covariance, which is exactly what `fixSpin` produces), set
    // `carry_untested` and use the GPS carry anyway. The comment that stood here called that "the
    // one place this port is deliberately more conservative than fit.py". It was the opposite, and
    // that sentence is what hid the bug: substituting sigma = 0 costs only the PERMISSIVE
    // `carry_as_scale` rung (rel = 0 can never exceed AS_SCALE_FRAC) and keeps the PROTECTIVE
    // `carry_inconsistent` one. Refusing to test throws the protection away and keeps nothing.
    // Reproduced by the reviewer: a 40 m GPS carry against a 204 m pixel track drawn as
    // "210 m / apex 35 m" with the "no GPS" marker removed.
    //
    // So: `sc = 0` when the sigma is unusable, exactly as fit.py:889
    // (`sc = float(sc) if np.isfinite(sc) else 0.0`), and `carry_untested` stays as an ADDITIONAL
    // flag saying the denominator is missing a term — never as a replacement for the test.
    const scPx = pixelOnly?.summarySigma.carryM;
    const scUsable = scPx != null && Number.isFinite(scPx) && (pixelOnly?.ok ?? false);
    // The lab gates on `pixel_only is not None` alone. The one thing the test genuinely cannot be
    // formed without is a finite pixel-only carry to compare against.
    if (pixelOnly && Number.isFinite(pixelOnly.summary.carryM)) {
      const cPx = pixelOnly.summary.carryM;
      const sc = scUsable ? (scPx as number) : 0;
      if (!scUsable) flags.push('carry_untested(no_usable_pixel_only_carry_sigma)');
      // The pixel-only carry carries the f_px systematic too, so the consistency denominator has
      // it on BOTH sides; sigma_D itself drops it here to avoid double-counting.
      const sigPxSys = fpxFrac * cPx;
      const sigmaTest = sigmaD(cm, carryM as number, false);
      const denom = Math.sqrt(sigmaTest ** 2 + sc ** 2 + sigPxSys ** 2);
      const z = (dPred(cm, cPx) - (carryM as number)) / denom;
      carryZ = z;

      // Did the carry term cost more pixels than it bought? That is an optimiser failure, not a
      // disagreement between the GPS and the pixels, and must not be reported as one (fit2 §1).
      const chi2CarryPx = ((dPred(cm, cPx) - (carryM as number)) / sigmaDUsed) ** 2;
      const pxLoss = chi2Px - pixelOnly.chi2Px;
      const carryGain = chi2CarryPx - (chi2Carry as number);
      if (pxLoss > Math.max(carryGain, 0) + 2 && pxLoss > 4) {
        flags.push(
          `joint_fit_worse_pixel_minimum(chi2_px ${chi2Px.toFixed(1)} vs ${pixelOnly.chi2Px.toFixed(1)}, carry_gain ${carryGain.toFixed(1)})`
        );
      }

      const rel = cPx > 1e-6 ? sc / cPx : Number.POSITIVE_INFINITY;
      const asScale = rel > AS_SCALE_FRAC;

      // GATE NEW-1(a). `z` above carries the pixel-only carry sigma in its own
      // denominator. When that sigma is LOOSE — which is what `carry_as_scale`
      // means, and what a short track always produces (34-69 % of the carry on
      // an 8-10 frame driver) — it divides the test down to nothing: a 10 m GPS
      // carry against a 250 m pixel track scored z = 2.0 and sailed through.
      // `zScale` asks the same question with that term dropped: does the GPS
      // distance land where the pixel GEOMETRY puts it, allowing for the f_px
      // prior but not for this fit's own looseness. It is the F1(a) principle
      // applied to the second unusable sigma — an unusable sigma is DROPPED
      // from the denominator, never used to skip the test.
      const denomNoPxSigma = Math.sqrt(sigmaTest ** 2 + sigPxSys ** 2);
      const zScale = denomNoPxSigma > 1e-9 ? (dPred(cm, cPx) - (carryM as number)) / denomNoPxSigma : 0;
      carryZNoPixelSigma = zScale;

      // DELIBERATE DEVIATION FROM THE LAB, and it is the whole of NEW-1(a).
      // `fit.py:907-920` tests `carry_as_scale` FIRST, so a loose pixel carry
      // pre-empts the inconsistency test and the GPS becomes the depth scale
      // however wrong it is (`tracer.py:837` does nothing with the verdict but
      // append a flag). Reproduced on an 8-frame driver: truth 251 m, pixel-only
      // 257 m, GPS carries of 5/10/20/40/80 m drawn as "170 m".."200 m",
      // decision=fit, and the "no GPS" honesty marker absent because the GPS
      // *was* used. The lab renders research clips for a human reading a CSV;
      // this renders a number to a golfer, and Henry's rule outranks fidelity:
      // the feature may skip and it may draw a trace without a distance, but it
      // must never show a confidently wrong number. So the PROTECTIVE verdict is
      // tested first and against BOTH z-scores, and `carry_as_scale` keeps only
      // the case it was designed for: a loose pixel carry the GPS AGREES with.
      if (Math.abs(z) > Z_INCONSISTENT || (asScale && Math.abs(zScale) > Z_INCONSISTENT)) {
        carryStatus = 'carry_inconsistent';
        flags.push(
          `carry_inconsistent(z=${z.toFixed(1)}sigma` +
            (asScale ? `,z_no_pixel_sigma=${zScale.toFixed(1)}sigma` : '') +
            ')'
        );
        if (asScale) {
          // Why the as-scale rung did not save it. Named so nothing filtering on
          // `carry_as_scale` can mistake this for the permissive verdict.
          flags.push(
            `pixel_carry_too_loose_to_check_gps(pixel_carry_sigma=${Math.round(100 * rel)}%>${Math.round(100 * AS_SCALE_FRAC)}%)`
          );
        }
      } else if (asScale) {
        carryStatus = 'carry_as_scale';
        flags.push(
          `carry_as_scale(pixel_carry_sigma=${Math.round(100 * rel)}%>${Math.round(100 * AS_SCALE_FRAC)}%,z=${z.toFixed(1)},z_no_pixel_sigma=${zScale.toFixed(1)})`
        );
      } else if (Math.abs(z) > Z_TENSION) {
        carryStatus = 'carry_tension';
        flags.push(`carry_tension(z=${z.toFixed(1)}sigma)`);
      } else {
        carryStatus = 'carry_consistent';
      }
    } else {
      // No pixel-only companion at all, or one whose carry is not a number. There is nothing to
      // compare the GPS distance against, so the test genuinely cannot run — this is the only
      // remaining `carry_untested` STATUS, and the ladder treats it as "the GPS was never
      // checked" (REVIEW F1(b)).
      carryStatus = 'carry_untested';
      flags.push('carry_untested(no_pixel_only_carry)');
    }
  }

  const paramsFinite = PARAM_NAMES.every((n) => Number.isFinite(p[n]));
  const ok =
    res.success && paramsFinite && Number.isFinite(rmsPx) && summary.hangS > 0 && summary.carryM > 0;

  return {
    ok,
    params: {
      v0: p.v0,
      thetaDeg: p.thetaDeg,
      phiDeg: p.phiDeg,
      rpmBack: p.rpmBack,
      tiltDeg: p.tiltDeg,
      t0Sec: p.t0Sec,
      dPitchDeg: p.dPitchDeg,
    },
    flight: flFull,
    summary,
    camera: camFit,
    rmsPx,
    maxResidPx: residualPx.reduce((m, v) => (v > m ? v : m), 0),
    nPoints: track.length,
    sigmaTotal,
    budget,
    carryStatus,
    carryZ,
    carryZNoPixelSigma,
    carrySigmaM: useCarry ? sigmaDUsed : null,
    labelStepM: labelStepM(sigmaTotal.carryM),
    carryLabelM: roundLabelM(summary.carryM, sigmaTotal.carryM),
    flags,
    sigma,
    summarySigma,
    startXyz: start,
    frames: track.map((t) => t.frame),
    residualPx,
    chi2Px,
    chi2Prior,
    chi2Carry,
    chi2Red,
    dof,
    cost: res.cost,
    nFev: prob.nFev,
    runtimeMs: nowMs() - tStart,
    seedSource,
    pixelOnly,
  };
}

// ─── Using a fit ───

/**
 * Reprojected pixels of the fitted flight at the given frame indices (fractional allowed).
 * Frames before impact give the start pixel and frames after landing the landing pixel — the
 * lab's `clamp=True`. The caller decides what to draw; this only says where the ball was.
 */
export function predictTrack(fit: FitResult, frames: number[], fps: number): Px[] {
  // positionsAt walks the samples forward, so it needs ascending times; restore the caller's order.
  const order = frames.map((_, i) => i).sort((i, j) => frames[i] - frames[j]);
  const taus = order.map((i) => frames[i] / fps - fit.params.t0Sec);
  const uv = fit.camera.project(positionsAt(fit.flight, taus, fit.startXyz));
  const out: Px[] = new Array(frames.length);
  order.forEach((i, k) => {
    out[i] = uv[k];
  });
  return out;
}

/**
 * The whole fitted flight sampled for the renderer: pixels, clip time, and the range from the
 * camera so the render can taper and fade the line with depth.
 *
 * `tSec` is CLIP time (t0 + flight time), not flight time — the renderer needs to know when in
 * the video the ball leaves the club. The render spec's own `samples[0].tSec === 0` convention
 * is produced by lib/tracerV3.ts subtracting the first value, at the same time as it converts
 * these top-left pixels into normalized bottom-left ones.
 */
export function flightPixels(
  fit: FitResult,
  a: { fps: number; hz?: number; tEndSec?: number }
): Array<{
  x: number;
  y: number;
  tSec: number;
  frame: number;
  depthM: number;
  groundRangeM: number;
  inFront: boolean;
}> {
  const hz = a.hz ?? 120;
  const hang = fit.summary.hangS;
  const tEnd = Math.min(a.tEndSec ?? hang, hang);
  const taus: number[] = [];
  for (let t = 0; t <= tEnd + 1e-9; t += 1 / hz) taus.push(Math.min(t, tEnd));
  if (taus.length === 0) taus.push(0);
  // The lab's `np.arange` stopped short of the landing unless the hang time happened to be a
  // multiple of the step. The renderer needs the arc to END at the landing point, so the exact
  // end time is always the last sample.
  if (taus[taus.length - 1] < tEnd - 1e-12) taus.push(tEnd);

  const pts = positionsAt(fit.flight, taus, fit.startXyz);
  const uv = fit.camera.project(pts);
  const hCamM = fit.camera.params.hCamM;
  return taus.map((tau, i) => {
    const dx = pts[i].x;
    const dy = pts[i].y;
    const dz = pts[i].z - hCamM;
    const tSec = tau + fit.params.t0Sec;
    return {
      x: uv[i].x,
      y: uv[i].y,
      tSec,
      frame: tSec * a.fps,
      // Range from the camera centre — apparent size, and therefore line taper, goes as 1/this.
      depthM: Math.sqrt(dx * dx + dy * dy + dz * dz),
      // GROUND range from the camera, i.e. the lab's `R = hypot(P_land[0], P_land[1])`. Not the
      // same as the carry: the ball is teed 3-6 m in front of the lens, so on a short shot the two
      // differ by tens of pixels of horizon depression. `landingHorizonCheck` needs this one
      // (REVIEW F8) — the flat-ground number alone flags every legitimate chip.
      groundRangeM: Math.sqrt(dx * dx + dy * dy),
      // `project` returns NaN for anything at or behind the camera plane, which is exactly the
      // sample the renderer must drop rather than draw at a wrapped-around pixel.
      inFront: Number.isFinite(uv[i].x) && Number.isFinite(uv[i].y),
    };
  });
}
