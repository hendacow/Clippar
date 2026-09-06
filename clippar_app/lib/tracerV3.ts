/**
 * lib/tracerV3.ts — the V3 decision ladder. PURE TS, no React Native, no native
 * imports, fully unit-testable under `node --test`.
 *
 * This is the file that decides whether a clip gets a trace at all, and it is
 * the file that must never fabricate a shot. Everything upstream of it produces
 * evidence (the Swift detector's ball positions, the camera calibration, the
 * GPS distance); everything downstream of it just draws what it is handed. So
 * every refusal in the product lives here, in one place, with the lab
 * measurement that motivated it named next to it.
 *
 * ── PROVENANCE ────────────────────────────────────────────────────────────
 * Ported from `~/projects/clippar/tracer-lab/lib/tracer.py` — the wave-4 `e2e2`
 * integration with the wave-5 `render3` additions. Read `experiments/e2e2/
 * report.md` and `experiments/render3/report.md` before changing a number here.
 * Every constant below carries the lab's own name in a comment. Where the port
 * DEVIATES from the lab it says so inline and in `docs/tracer-v3/integrate.md`;
 * the deviations are all forced by the TypeScript API surface the other agents
 * fixed (`lib/tracerFit.ts` has no per-point `sigma`, no partial `fixed` map and
 * no custom prior), and each one is called out where it bites.
 *
 * ── THE ONE COORDINATE CONVERSION ─────────────────────────────────────────
 * SHARED CONVENTION 1: the detector, the camera and the fit all work in
 * TOP-LEFT PIXELS of the display-oriented frame; the render spec is NORMALIZED
 * 0..1 BOTTOM-LEFT. `pxToNormalizedBottomLeft` below is the ONLY place that
 * conversion happens, and it has its own test. If you find a `1 - y /` anywhere
 * else in the V3 path, that is the bug.
 *
 * ── WHAT THIS FILE DOES NOT DO ────────────────────────────────────────────
 * The lab's `find_seen_landing()` re-reads SOURCE FRAMES after the last
 * detection to follow the ball to its touchdown. That needs pixels, so it
 * cannot live in TypeScript, and no native counterpart was built in this wave.
 * `decideArcEnd` is therefore the lab's own `decide_arc_end(..., search=False)`
 * path — a supported lab configuration, not an invention — which keeps the
 * "last detection is already at the landing" rung and otherwise stops at the
 * fitted landing. The consequence is stated honestly in the report: on a chip
 * that the detector followed all the way down, the drawn arc can run a few
 * frames past where the ball is seen to stop (the lab measured 61-70 px on
 * IMG_3652 before it added the search).
 */
import {
  BALL_RADIUS_M,
  CLUB_PRIORS,
  simulate,
  type Bucket,
} from './tracerPhysics';
import {
  TracerCamera,
  calibrateFromAddressBall,
  fPxFromFovDeg,
  type CameraParams,
  type Px,
} from './tracerCamera';
import {
  fitLaunch,
  flightPixels,
  labelStepM,
  predictTrack,
  roundLabelM,
  type CarryStatus,
  type FitResult,
  type TrackPoint,
} from './tracerFit';
import { config } from '../constants/config';

// ─── SHARED CONVENTION 2 — what the native detector returns ─────────────────

/** One ball position, pixels, top-left origin, display-oriented. */
export interface BallDetection {
  frame: number;
  /** `frame / fps`, seconds on the ANALYSED file's timeline. */
  t: number;
  x: number;
  y: number;
  /** Apparent radius in pixels. */
  r: number;
  conf: number;
}

/** `detectShotV3`'s payload. Mirrors SHARED CONVENTION 2 exactly. */
export interface TracerDetectResultV3 {
  found: boolean;
  method: 'blob-kalman' | 'none';
  fps: number;
  width: number;
  height: number;
  impactFrameGiven: number;
  /**
   * `launchFrame - 1`. The DEPARTURE CUE defines the launch frame, not the
   * audio transient, so this can differ from `impactFrameGiven` by several
   * frames. Downstream timing must use this one — the detector's
   * `notes.impactCorrected` says when it moved.
   */
  impactFrameUsed: number | null;
  launchFrame: number | null;
  address: { x: number; y: number; r: number } | null;
  detections: BallDetection[];
  notes: Record<string, string | number | boolean>;
  msPerFrame: number;
}

// ─── SHARED CONVENTION 3 — what the native renderer consumes ────────────────

export interface RenderSampleV3 {
  /** Normalized 0..1, BOTTOM-LEFT origin, display-oriented. */
  x: number;
  y: number;
  /** Seconds from `animStartSec`. `[0] === 0`, strictly increasing. */
  tSec: number;
}

export interface TracerRenderSpecV3 {
  samples: RenderSampleV3[];
  /** Per-sample range from the camera, metres. Drives taper and depth fade. */
  depths?: number[];
  animStartSec: number;
  animDurationSec: number;
  color?: string;
  coreColor?: string;
  lineWidthPx?: number;
  midWidthPx?: number;
  glowWidthPx?: number;
  cometHead?: boolean;
  taperMin?: number;
  depthFadeMin?: number;
  occlusion?: boolean;
  labelText?: string;
  labelSubText?: string;
  labelAtApex?: boolean;
  endAtSec?: number | null;
  freezeCompleteToSec?: number | null;
  landHoldSec?: number;
}

// ─── Ladder constants, all from tracer-lab/lib/tracer.py ────────────────────

/** "first 12-15 frames after impact" -> 15, scaled by fps/30. */
const EARLY_FRAMES_30FPS = 15;
/** `fit_pitch` only for tracks at least this long (30 fps equivalent). */
const LONG_TRACK_30FPS = 20;
/** The full (spin-free) model only from this many detections. */
const MIN_FULL_MODEL = 5;
/** Below this: a prior-driven arc (with carry) or nothing. */
const MIN_FIT = 3;
/** The spin-bound rung may add the pitch nuisance from this many points. */
const MIN_PITCH_CANDIDATE = 8;
/** Detections below this confidence get 2x sigma (the judge: conf is ORDINAL,
 *  so treat < 0.4 as "weight down", not as a probability). */
const CONF_DOWNWEIGHT = 0.4;
/** @1080p px: image-y rise after the minimum that counts as "through the apex". */
const APEX_MIN_DESCENT_PX = 10.0;
/** One residual > this x the others' median (and > OUTLIER_MIN_PX) is an outlier. */
const OUTLIER_RATIO = 5.0;
const OUTLIER_MIN_PX = 10.0;
/** A spin-off-bound refit is accepted if rms <= this x the primary's. */
const SPIN_REFIT_RMS_FACTOR = 1.5;
/** m/s: below this the "flight" is a putt or a rolling ball. */
const MIN_FLIGHT_V0 = 8.0;
/** IMG_3647, a putt: apex 0.0 m, hang 0.14 s at 8.8 m/s. */
const MIN_FLIGHT_APEX_M = 0.3;
const MIN_FLIGHT_HANG_S = 0.4;
/** @1080p: IMG_2329, a topped shot — 3 wrong detections fit 95 m/s at 22 px rms. */
const MAX_RMS_PX = 8.0;
/** @1080p over >= POOR_FIT_MIN_K frames: IMG_2331 drew a 2.7 deg bullet under a
 *  climbing ball at 5.3 px over 23 frames. Every good clip is <= 2.8 px. */
const POOR_FIT_RMS_PX = 4.0;
const POOR_FIT_MIN_K = 10;
/** @1080p: a track whose image-y never rises this much above the address is not a flight. */
const MIN_CLIMB_PX = 25.0;
/** Detections beyond the fitted window needed for the held-out check ... */
const HOLDOUT_MIN_N = 3;
/** @1080p: ... and the median offset of the early fit on them that triggers a
 *  refit with ALL detections (IMG_2331: 25 px on 9 later detections). */
const HOLDOUT_REFIT_PX = 6.0;
/** Last detection within this of the fitted landing counts as "tracked to the ground". */
const END_TAIL_S = 0.25;
/** @1080p: ... and within this many px of the fitted landing pixel. */
const END_NEAR_LANDING_PX = 120.0;
/** The plausibility cap only judges short fits (K <= this) or prior-driven ones. */
const IMPLAUSIBLE_K_MAX = 4;
/** Multiplier on the bucket's own maximum. 1.0 = the maximum itself, which is
 *  the reading that reproduces the lab brief's worked numbers (48.8 ~ 45 m,
 *  8.07 ~ 7.5 s for a driver) and catches its test case. */
const IMPLAUSIBLE_MARGIN = 1.0;
/** A capped refit is accepted while its rms is within this x the uncapped one's... */
const IMPLAUSIBLE_RMS_FACTOR = 2.0;
/** ... or below this @1080p — the rms at which this lab already stops believing a fit. */
const IMPLAUSIBLE_RMS_FLOOR_PX = 4.0;
/** CLUB_PRIORS bucket that bounds a prior CLUB_PRIORS does not have. The lab's
 *  `CAP_BUCKET`: 'pitch' -> wedge, an unknown club -> 'driver' (the longest, so
 *  the cap is the most permissive one). */
const CAP_BUCKET: Partial<Record<string, Bucket>> = { pitch: 'wedge' };
const CAP_BUCKET_UNKNOWN: Bucket = 'driver';
/** 'landing_depression_off' when the drawn landing's depression below the
 *  horizon is off the expectation by more than this factor...
 *
 *  WHICH EXPECTATION (REVIEW F8): the RANGE one, `f*h/R`, using the landing's
 *  real ground range from the camera — not the lab's `expected_flat_px`
 *  (`f*h/carry`), which assumes the ball was hit from directly under the lens.
 *  The port kept only the flat number and dropped the lab's own docstring
 *  saying the two differ by tens of px on a 10 m chip and by well under a px on
 *  a 250 m drive, so the flag survived and the sentence telling you to ignore it
 *  did not. Both numbers are still reported in `meta.landingCheck`. */
const DEPRESSION_OFF_RATIO = 2.0;
/** ... OR this many px @1080p. */
const DEPRESSION_OFF_PX = 15.0;

// ─── Not from the lab: the app's own capture surface (REVIEW F3a, F4) ───────

/** The one lens `getCameraFovDeg()` describes. Anything else rescales f_px. */
const SUPPORTED_CAPTURE_LENS = '1x';
/** expo-camera's normalized pinch zoom below which the framing is the lens's
 *  own. Not zero, because `zoom` is a float round-tripped through SQLite; the
 *  smallest step the pinch gesture applies is 0.004. */
const CAPTURE_ZOOM_EPSILON = 1e-3;
/** deg: below this azimuth the shot is down the camera axis, where the geometry
 *  loses the SCALE as well as the direction (REVIEW F4). */
const AXIS_DEGENERATE_PHI_DEG = 1.5;
/** ... and the fit tells you so: some rung of the ladder could not determine v0
 *  to better than this fraction of it. On the reviewer's own fixture a
 *  full-freedom fit at phi = 0 returns sigma(v0)/v0 = 21 %, against 2-3 % at
 *  every other azimuth, so the gap this sits in is an order of magnitude wide. */
const AXIS_DEGENERATE_V0_REL_SIGMA = 0.1;

/**
 * The coarsest rounding step `labelStepM` can offer (metres). A distance whose
 * honest 1-sigma is wider than this has NO step in the vocabulary that
 * describes it, so stating it at all reads as a measurement it is not — the
 * same argument F4 makes for the axis-degenerate geometry, and GATE NEW-1(b)
 * takes the same remedy. Kept as a named constant because it is a claim about
 * `labelStepM`, not a tuning knob: if that function ever gains a coarser step,
 * this moves with it.
 */
const COARSEST_LABEL_STEP_M = 10;

// ─── FG-1: when a fit is too uncertain to STATE a distance ──────────────────
//
// Three tests, all three measured over 58 500 `traceClip` calls before being
// chosen, and each one an EXISTING gate of this ladder with the conjunct that
// was blocking it removed. Any one of them withholds the number; the arc is
// unaffected. `docs/tracer-v3/fixes.md` round 4 has the full sweep, including
// the rules that were tried and rejected.
//
// WHY NOT THE OBVIOUS RULE. The gate proposed keying this on the fit's own
// sigma as a fraction of the carry, and measured that it is a weak predictor of
// the fit's own error. My sweep says the same and worse: `sigma > 0.20 * carry`
// withholds 20.2 % of numbers, loses 12.8 % of the CORRECT ones, and still
// leaves 485 of 1 319 wrong ones on the table with a worst case of 99 %. The
// reason is that the failures are CONFIDENTLY wrong — a tight formal sigma with
// a large error — which is precisely the disease F4 was invented for, so F4's
// test, not the sigma, is the one that generalises.

/**
 * (1) The fit could not pin the ball speed to better than this fraction of it.
 *
 * This is review F4's own quantity with F4's azimuth conjunct removed — the
 * same move GATE-1 made on `AS_SCALE_FRAC`, for the same reason: a threshold is
 * a line the failure does not respect, and the conjunct was what let it through.
 * `AXIS_DEGENERATE_V0_REL_SIGMA` (10 %) stays where it is, because that one
 * governs the stronger claim that the whole GEOMETRY is degenerate and refuses
 * the apex too; this one only withholds a number, so it can afford to be
 * stricter. Measured over 58 500 calls: on its own it catches 1 229 of the
 * 1 319 wrong numbers for 11.9 % of the correct ones, which is a better trade
 * than any rule keyed on the carry sigma at any threshold.
 */
const LOOSE_V0_REL_SIGMA = 0.05;

/**
 * (2) The fitted flight misses the detections by more than this, @1080p.
 *
 * `poor_fit` already refuses on rms, but only at `nPoints >= POOR_FIT_MIN_K`
 * (10) and only above `POOR_FIT_RMS_PX` (4) — and the gate showed the failures
 * are concentrated exactly in the hole that leaves: 5-8 frame tracks with an rms
 * between 4 and 8 px, which draw carrying only a `large_pixel_residual` flag
 * nobody reads. So the SAME question is asked with no length conjunct, and at a
 * bar anchored to the fit's own noise model rather than invented: `fitLaunch`
 * defines the label noise as `width / 1080` px per point, so this is two sigma
 * of the error the fit itself assumes.
 */
const LOOSE_RMS_PX_1080 = 2.0;

/**
 * (3) The label's own 1-sigma as a fraction of the carry it is about to state.
 *
 * The weak predictor, kept as a backstop rather than as the rule: it is the only
 * one of the three that catches a fit which is well conditioned AND follows the
 * pixels AND is still wrong, and it removes 16 of the 63 rows the other two
 * leave. It is NOT the vocabulary rule taken literally — `sigma <=
 * COARSEST_LABEL_STEP_M` applied to every number withholds 96 % of them and
 * 97 % of the correct ones, which is not a product, and saying so is more honest
 * than pretending 25 % falls out of the rounding steps. It is a measured bar.
 */
const LOOSE_CARRY_SIGMA_FRAC = 0.25;

/**
 * CT-6. The apex is stated only when the fit's own 1-sigma on it is inside this
 * fraction of the apex. 0.25 is the value the FG-1 sweep already measured for
 * this quantity (`sigma(apex)/apex > 0.25` caught 985 of 1319 wrong CARRIES),
 * reused here for the number it actually describes rather than as a proxy.
 * Measured on synthetic geometry, not on a phone.
 */
const LOOSE_APEX_SIGMA_FRAC = 0.25;

// ─── Knobs (structural read of config.tracer.v3) ────────────────────────────

/**
 * The slice of `config.tracer.v3` this module consumes, read structurally for
 * the same reason `lib/gpsSession.ts` reads its own: a partial or absent block
 * must fall back to the documented default rather than arrive as `undefined`
 * and turn every threshold comparison into `false`.
 */
export interface TracerV3Knobs {
  fitMaxIterations: number;
  fitPitchAllowed: boolean;
  pitchSigmaDeg: number;
  implausibleCap: boolean;
  freezeComplete: boolean;
  freezeTailSec: number;
  freezeMaxSec: number;
  occlusion: boolean;
  labelRounding: boolean;
  forceTrace: boolean;
  /** Render sampling rate of the flight, Hz. The lab renders the RK4 samples
   *  directly, which are 1/120 s apart (`tracerPhysics.DEFAULT_DT`). */
  renderHz: number;
}

export const DEFAULT_V3_KNOBS: TracerV3Knobs = {
  fitMaxIterations: 200,
  fitPitchAllowed: true,
  pitchSigmaDeg: 0.5,
  implausibleCap: true,
  freezeComplete: true,
  freezeTailSec: 0.6,
  freezeMaxSec: 6.0,
  occlusion: true,
  labelRounding: true,
  forceTrace: false,
  renderHz: 120,
};

/** Merge the live `config.tracer.v3` over the defaults, ignoring anything of
 *  the wrong type. Exported so the dev-settings screen can show what is live. */
export function resolveV3Knobs(
  tracerConfig: unknown,
  overrides?: Partial<TracerV3Knobs>
): TracerV3Knobs {
  const merged: TracerV3Knobs = { ...DEFAULT_V3_KNOBS };
  const block =
    typeof tracerConfig === 'object' && tracerConfig !== null && 'v3' in tracerConfig
      ? (tracerConfig as { v3: unknown }).v3
      : undefined;
  if (typeof block === 'object' && block !== null) {
    const slice = block as Partial<Record<keyof TracerV3Knobs, unknown>>;
    for (const key of Object.keys(DEFAULT_V3_KNOBS) as (keyof TracerV3Knobs)[]) {
      const value = slice[key];
      const want = typeof DEFAULT_V3_KNOBS[key];
      if (want === 'number' && typeof value === 'number' && Number.isFinite(value)) {
        (merged[key] as number) = value;
      } else if (want === 'boolean' && typeof value === 'boolean') {
        (merged[key] as boolean) = value;
      }
    }
  }
  if (overrides) {
    for (const key of Object.keys(overrides) as (keyof TracerV3Knobs)[]) {
      const value = overrides[key];
      if (value !== undefined) (merged[key] as unknown) = value;
    }
  }
  return merged;
}

// ─── The one coordinate conversion (SHARED CONVENTION 1) ────────────────────

/**
 * Detector/camera/fit pixels -> render-spec normalized coordinates.
 *
 * Top-left origin, pixel-INDEX coordinates in (the camera model's principal
 * point is `((w-1)/2, (h-1)/2)`, i.e. an index, not a corner) -> 0..1
 * BOTTOM-LEFT, which is what `TracerRenderV3.swift` multiplies by the render
 * size to get CALayer coordinates (CALayer's y axis points up).
 *
 * The `+ 0.5` is the pixel-centre offset, and it is the reason this is worth a
 * test: pixel index i covers the continuous span [i, i+1), so its centre is
 * i + 0.5. With it, the principal point (w-1)/2 maps to exactly 0.5 — the
 * geometric centre of the frame — which is the identity the test pins. Without
 * it the whole trace sits half a pixel up and left; that is sub-pixel and
 * invisible, but "invisible" is not a reason to have the wrong formula in the
 * one function everything else trusts.
 */
export function pxToNormalizedBottomLeft(p: Px, width: number, height: number): { x: number; y: number } {
  return {
    x: (p.x + 0.5) / width,
    y: 1 - (p.y + 0.5) / height,
  };
}

// ─── Inputs / outputs ───────────────────────────────────────────────────────

/** How the focal length was obtained. Drives the f_px error term in the fit. */
export type FPxSource = 'intrinsics' | 'fov-metadata' | 'config-fallback';

export interface TraceClipInput {
  /** The native detector's result for this clip. */
  detection: TracerDetectResultV3;
  /**
   * CoreMotion's camera pitch at record start, degrees, positive looking down.
   * REQUIRED: the camera cannot be calibrated without it, and there is no
   * honest default — a guessed pitch maps 1:1 into launch angle.
   */
  pitchDownDeg: number | null;
  /** Camera roll, degrees. 0 for a tripod; the app does not capture it yet. */
  rollDeg?: number;
  /** Focal length in pixels of the display-oriented frame. */
  fPx: number;
  fPxSource: FPxSource;
  /**
   * The optics the clip was actually SHOT with, read back from its row.
   *
   * REVIEW F3a, and it is the reason this field exists at all. `fPx` above comes
   * from `getCameraFovDeg()`, which hard-codes `.builtInWideAngleCamera` and
   * reports the 1x lens's `videoFieldOfView` for the FORMAT. The record screen
   * gives the golfer a 0.5x ultra-wide toggle and continuous pinch zoom, neither
   * of which reaches that number — and f_px is the scale of the entire world
   * model (`depth ~ fPx * 0.04267 / diameterPx`, and ball speed and carry ride on
   * depth). The reviewer drove the ladder with detections generated at the TRUE
   * capture FOV: a 202 m drive shot at 1.5x pinch is drawn cleanly as "140 m",
   * and a 0.5x clip misses the implausibility cap by one metre of apex. This is
   * not the budgeted +-12 % systematic; it is a factor of two.
   *
   * So the ladder refuses anything it cannot prove was shot at 1x with no pinch
   * (`lens_unsupported`). A skip costs a trace; a confidently wrong distance is
   * the worst thing this feature can do.
   *
   * OMITTING THIS FIELD IS A REFUSAL, not a default. A caller that does not model
   * capture optics gets `lens_unsupported`, because "unknown lens" and "1x" are
   * the same input to every calculation downstream and only one of them is safe.
   */
  capture?: {
    /** `local_clips.capture_lens`: '1x' (wide) or '0.5x' (ultra-wide). null = a
     *  clip recorded before the column existed, i.e. an unknown lens. */
    lens: string | null;
    /** `local_clips.capture_zoom`: expo-camera's normalized pinch zoom, 0 = the
     *  lens's native framing. null = unknown. */
    zoom: number | null;
  } | null;
  /** GPS distance to the NEXT same-hole shot, metres. Null = pixel-only. */
  carryM?: number | null;
  /** GPS-only 1-sigma of that distance (`gpsSession.carryBetween().sigmaGpsM`). */
  carrySigmaGpsM?: number | null;
  /** Club bucket, when something knows it. The app does not, so this is
   *  normally undefined and the fit uses the lab's generic prior. */
  bucket?: Bucket;
  /** The swing classifier's verdict. A putt is refused before any fitting. */
  shotType?: 'swing' | 'putt' | null;
  /** Duration of the file the trace will be RENDERED onto, seconds. */
  renderDurationSec: number;
  /**
   * Seconds to subtract from the detector's timeline to reach the render
   * file's timeline. Detection runs on the ORIGINAL file (it has more
   * post-impact footage); the render runs on the TRIMMED one, which starts
   * `auto_trim_start_ms` later. 0 when both are the same file.
   */
  detectToRenderOffsetSec?: number;
  knobs?: Partial<TracerV3Knobs>;
}

export type TraceDecision = 'none' | 'prior' | 'fit' | 'pixel_only_fallback';

/** One rung of the fit ladder, logged whether or not it was accepted. */
export interface LadderEntry {
  tag: string;
  k: number;
  rmsPx: number;
  maxPx: number;
  v0: number;
  thetaDeg: number;
  rpmBack: number;
  carryM: number;
  flags: string[];
  accepted: boolean;
}

/**
 * The diagnostic blob persisted to `local_clips.tracer_meta`. This is what a
 * field test is read from later, so it carries the fitted parameters, the
 * sigmas, every flag and the decision — not just a pass/fail.
 */
export interface TracerV3Meta {
  engine: 'v3';
  decision: TraceDecision;
  reason: string | null;
  flags: string[];
  nDetections: number;
  selection: {
    mode: 'none' | 'early' | 'all' | 'first3' | 'all_holdout';
    k: number;
    throughApex: boolean;
    climbPx: number | null;
    frameRange: [number, number] | null;
    kImpFit: number | null;
    /** F2: frames of slack the fit was given on t0's lower bound. */
    impactSlackFrames: number;
    /** FG-4: emitted detections dropped as non-finite before any count or gate. */
    nNonFinite: number;
    holdoutMedianPx?: number;
  };
  camera?: {
    fPx: number;
    fPxSource: FPxSource;
    hCamM: number;
    pitchDownDeg: number;
    rollDeg: number;
  };
  launch?: {
    v0: number;
    thetaDeg: number;
    phiDeg: number;
    rpmBack: number;
    tiltDeg: number;
    t0Sec: number;
    dPitchDeg: number;
  };
  flight?: {
    carryM: number;
    apexM: number;
    hangS: number;
    landAngleDeg: number;
    lateralM: number;
  };
  sigmaTotal?: { thetaDeg: number; v0: number; carryM: number; apexM: number };
  /**
   * How well the ball speed could be pinned, as a fraction of it — the quantity
   * F4's `axis_degenerate` refusal and FG-3's correction to it are keyed on.
   *
   * `worst` is over every rung of the ladder that produced the drawn fit
   * (including rejected ones); `drawn` is the fit that is ACTUALLY DRAWN, which
   * on `pixel_only_fallback` is a pixel-only companion no rung measured. It is
   * on the row because a flag that only appears when it fires tells a field test
   * nothing about the clips where it nearly did (FG-3).
   */
  conditioning?: { worstV0RelSigma: number; drawnV0RelSigma: number };
  fit?: { rmsPx: number; maxResidPx: number; nPoints: number; ok: boolean };
  carry?: {
    inputM: number | null;
    sigmaGpsM: number | null;
    status: CarryStatus | null;
    z: number | null;
    /** GATE-1: the same z with the pixel-only carry sigma dropped from the
     *  denominator. It is half the verdict now, so it has to reach the row a
     *  field test is read from — the whole finding was a number the code
     *  computed and nobody looked at. */
    zNoPixelSigma: number | null;
    sigmaM: number | null;
    labelM: number | null;
    labelStepM: number | null;
  };
  arcEnd?: { mode: 'fitted' | 'seen'; endAtSec: number | null; reason: string };
  implausible?: {
    checked: boolean;
    over: string[];
    apexM: number;
    hangS: number;
    apexMaxM: number;
    hangMaxS: number;
    bucket: Bucket;
  };
  landingCheck?: {
    horizonRow: number;
    landingPx: [number, number];
    depressionPx1080: number;
    expectedFlatPx1080: number;
    /** F8: the landing's real ground range from the camera, and the depression
     *  the projection must reproduce at that range. The flat-ground number
     *  above is kept for comparison with the lab's own reports, but this is the
     *  pair that says whether the geometry is wrong. */
    landingGroundRangeM: number | null;
    expectedRangePx1080: number | null;
    residualVsRangePx1080: number | null;
    aboveHorizon: boolean;
  };
  render?: { sampleCount: number; animStartSec: number; animDurationSec: number };
  ladder: LadderEntry[];
  detectorNotes: Record<string, string | number | boolean>;
  msPerFrame: number;
  /** Wall time of the whole ladder, ms. */
  elapsedMs: number;
}

export interface TraceClipResult {
  decision: TraceDecision;
  /** Null only when a trace was produced. */
  reason: string | null;
  flags: string[];
  /** Null whenever `decision === 'none'`. */
  spec: TracerRenderSpecV3 | null;
  meta: TracerV3Meta;
}

/** True when this result must be persisted as a SKIP rather than a render. */
export function isTraceSkip(r: TraceClipResult): boolean {
  return r.spec === null;
}

// ─── Focal length ───────────────────────────────────────────────────────────

/**
 * Focal length in pixels from the back camera's LANDSCAPE horizontal field of
 * view (what native `getCameraFovDeg()` reports, from `videoFieldOfView`).
 *
 * The lens does not care which way the phone is held: the landscape-horizontal
 * FOV spans the sensor's LONG axis, which in a display-oriented portrait frame
 * is the HEIGHT. Pixels are square, so one f_px serves both axes.
 *
 * This is a METADATA PRIOR, not a measurement — `videoFieldOfView` describes
 * the format, and the recorded clip may have been digitally zoomed (the record
 * screen has pinch zoom, and the factor is not persisted per clip). That is
 * why `fPxIsPrior` stays true and the fit carries the lab's +-12 % f_px
 * systematic through to the label's rounding step.
 */
export function fPxFromLandscapeFov(hFovLandscapeDeg: number, width: number, height: number): number {
  return fPxFromFovDeg(hFovLandscapeDeg, Math.max(width, height));
}

// ─── Selection (lab: select_detections) ─────────────────────────────────────

export interface Selection {
  nTotal: number;
  used: BallDetection[];
  kImpFit: number | null;
  mode: 'none' | 'early' | 'all' | 'first3' | 'all_holdout';
  throughApex: boolean;
  firstDetFrame: number | null;
  lastDetFrame: number | null;
  launchFrame: number | null;
  frameRange: [number, number] | null;
  earlyWindowFrames: number | null;
  climbPx: number | null;
  /**
   * How many frames before `kImpFit` the fit may put `t0` — the lab's
   * `impact_slack_frames` (tracer.py:251). See `FitOptions.impactSlackFrames`
   * and REVIEW F2.
   */
  impactSlackFrames: number;
  /** How many emitted detections were dropped as non-finite (FG-4). */
  nNonFinite: number;
}

/**
 * Which detections the fit sees, and where the impact frame is.
 *
 * All detections within the first 15 (30 fps-equivalent) frames after impact;
 * if the track continues THROUGH THE IMAGE APEX all detections are used, because
 * the fit report shows the lob chips only resolve speed against launch angle on
 * the descent. Fewer than 3 in the early window -> the first 3.
 */
/**
 * The detections the ladder is allowed to count — FG-4, `docs/tracer-v3/final-gate.md`.
 *
 * A detection whose frame, x or y is not finite is DROPPED BY THE FITTER
 * (`lib/tracerFit.ts:1038` filters the track to finite points) but used to be
 * COUNTED by the refusal ladder, so junk got past the one guard standing
 * between "no evidence" and "a number": `chooseModel`'s `nUsed < MIN_FIT` and
 * every downstream `sel.used.length` test read the raw array. The gate measured
 * 9 of 10 NaN coordinates fitting ONE point at rms 0 — the residual gates are
 * vacuous with a single point — and drawing "70 m" for a 195 m shot.
 *
 * EVERY read of `det.detections` inside this module goes through here, which is
 * the actual fix: the previous shape had the count and the fit reading two
 * different arrays, and the hold-out refit below re-read the raw one a second
 * time. `meta.nDetections` still reports what the detector EMITTED, because
 * that is a fact about the detector; everything that decides goes through this.
 *
 * The gate could not show the Swift detector emitting a non-finite coordinate
 * (`tracerApplyEmissionRule` does not check finiteness, but no input was found
 * that produces a NaN centroid), so this closes a hole in the JS safety layer
 * rather than a demonstrated field failure. It is cheap and the failure it
 * prevents is the worst one this feature has.
 */
export function finiteDetections(det: TracerDetectResultV3): BallDetection[] {
  return (det.detections ?? []).filter(
    (d) => Number.isFinite(d.frame) && Number.isFinite(d.x) && Number.isFinite(d.y)
  );
}

export function selectDetections(det: TracerDetectResultV3): Selection {
  const raw = det.detections ?? [];
  const finite = finiteDetections(det);
  const dets = [...finite].sort((a, b) => a.frame - b.frame);
  const fr = det.fps / 30.0;
  const u = det.width / 1080.0;
  const out: Selection = {
    nTotal: dets.length,
    used: [],
    kImpFit: null,
    mode: 'none',
    throughApex: false,
    firstDetFrame: null,
    lastDetFrame: null,
    launchFrame: det.launchFrame,
    frameRange: null,
    earlyWindowFrames: null,
    climbPx: null,
    impactSlackFrames: 0,
    nNonFinite: raw.length - finite.length,
  };
  if (dets.length === 0) return out;

  const first = Math.round(dets[0].frame);
  // The ball is at address in k and displaced in k+1, so the fit's impact frame
  // is the frame before the first detection.
  const kImp = first - 1;

  // ── impact slack (lab: tracer.py:248-252) ──
  //
  // REVIEW F2. This was previously not computed, on the reasoning that
  // `lib/tracerFit.ts` bounded t0 hard to [kImp/fps, (kImp+1)/fps] so the number
  // "would be dead". Dead in the code, not in the consequence: when the detector
  // misses the first frames of flight (the ball is fastest and blurriest right
  // after impact), `kImp` is that many frames LATE, the true launch falls outside
  // the interval, and the optimiser pins t0 at the bound. A perfect flight then
  // comes back as `track_not_ballistic` or `implausible_flight` — a recall cliff,
  // not a safety margin. `fitLaunch` now takes the slack; this computes it.
  //
  // The DEPARTURE CUE is the evidence: `launchFrame` is the frame the detector
  // saw the ball leave, so t0 may start as early as that. With no cue, fall back
  // to the audio impact frame and add one frame either way, exactly as the lab
  // does. A launch frame AFTER the first detection is impossible, so it is
  // clamped — which also makes the slack non-negative by construction.
  const kLaunchRaw = det.launchFrame;
  const haveCue = kLaunchRaw !== null && kLaunchRaw !== undefined && Number.isFinite(kLaunchRaw);
  const kLaunchFallback = Number.isFinite(det.impactFrameGiven) ? Math.round(det.impactFrameGiven) : first;
  const kLaunch = Math.min(haveCue ? Math.round(kLaunchRaw as number) : kLaunchFallback, first);
  const slack = first - kLaunch + (haveCue ? 0 : 1);
  out.impactSlackFrames = slack;

  const nEarly = Math.round(EARLY_FRAMES_30FPS * fr);
  const early = dets.filter((d) => d.frame - kImp <= nEarly);

  // Through the image apex? Minimum strictly inside, >= 3 detections after it,
  // image y rises >= 10 px @1080p, and the last is below the first of the tail.
  const ys = dets.map((d) => d.y);
  let iMin = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] < ys[iMin]) iMin = i;
  const after = ys.slice(iMin + 1);
  const through =
    iMin >= 2 &&
    after.length >= 3 &&
    after[after.length - 1] - ys[iMin] >= APEX_MIN_DESCENT_PX * u &&
    after[after.length - 1] > after[0];

  let used: BallDetection[];
  let mode: Selection['mode'];
  if (through) {
    used = dets;
    mode = 'all';
  } else if (early.length >= MIN_FIT) {
    used = early;
    mode = 'early';
  } else {
    used = dets.slice(0, MIN_FIT);
    mode = 'first3';
  }

  const addrY = det.address?.y;
  const yMin = Math.min(...ys);

  out.used = used;
  out.kImpFit = kImp;
  out.mode = mode;
  out.throughApex = through;
  out.firstDetFrame = first;
  out.lastDetFrame = Math.round(dets[dets.length - 1].frame);
  out.frameRange = [Math.round(used[0].frame), Math.round(used[used.length - 1].frame)];
  out.earlyWindowFrames = nEarly;
  out.climbPx = addrY === undefined ? null : addrY - yMin;
  return out;
}

/** The top of the ladder: which model, or no trace at all. */
export function chooseModel(
  nUsed: number,
  carryM: number | null | undefined,
  sel: Pick<Selection, 'throughApex'>,
  fps: number,
  knobs: TracerV3Knobs
): { decision: TraceDecision; fixSpin: boolean; fitPitch: boolean; reason: string | null } {
  const fr = fps / 30.0;
  if (nUsed === 0) {
    return { decision: 'none', fixSpin: true, fitPitch: false, reason: 'no_detections' };
  }
  if (nUsed < MIN_FIT) {
    if (carryM === null || carryM === undefined) {
      return {
        decision: 'none',
        fixSpin: true,
        fitPitch: false,
        reason: `too_few_detections_no_carry(${nUsed})`,
      };
    }
    // The club prior decides speed and launch angle; the pixels only decide the
    // direction. Honest, and the plausibility cap below judges it hardest.
    return {
      decision: 'prior',
      fixSpin: true,
      fitPitch: false,
      reason: `${nUsed}_detections:prior_driven_arc_with_carry`,
    };
  }
  const fixSpin = nUsed < MIN_FULL_MODEL;
  const longTrack = nUsed >= LONG_TRACK_30FPS * fr;
  const fitPitch = Boolean(knobs.fitPitchAllowed && sel.throughApex && longTrack && !fixSpin);
  return { decision: 'fit', fixSpin, fitPitch, reason: null };
}

/**
 * Detections -> `lib/tracerFit.ts` track points.
 *
 * DEVIATION, and it is exact rather than approximate. The lab hands `fit_launch`
 * an explicit per-point `sigma = width/1080 * (2 if conf < 0.4 else 1)`.
 * `lib/tracerFit.ts` takes no `sigma`; it derives one from `conf` linearly,
 * `sigma = pxSigma * (1 + 2*(1 - conf))`. Inverting that for the two
 * multipliers the lab actually uses gives conf 1 -> 1x and conf 0.5 -> 2x, so
 * mapping the detector's ordinal confidence onto {1, 0.5} reproduces the lab's
 * step weighting exactly through the API that exists. Passing the raw detector
 * confidence through would NOT: conf 0.45 would get 2.1x where the lab gives 1x.
 */
export function trackForFit(used: BallDetection[]): TrackPoint[] {
  return used.map((d) => ({
    frame: d.frame,
    x: d.x,
    y: d.y,
    conf: d.conf >= CONF_DOWNWEIGHT ? 1 : 0.5,
  }));
}

// ─── Plausibility limits (lab: bucket_flight_limits) ────────────────────────

export interface BucketFlightLimits {
  bucket: Bucket;
  apexMaxM: number;
  hangMaxS: number;
  apexTypicalM: number;
  hangTypicalS: number;
}

const CAP_LIMITS = new Map<Bucket, BucketFlightLimits>();

/**
 * The largest apex and hang a club bucket can physically produce: its
 * CLUB_PRIORS upper corner (fastest ball speed x highest launch x every
 * backspin in range) simulated through the flight model.
 *
 * The lab searches `itertools.product(v0_range, theta_range, rpm_range)` over
 * 2-tuples, i.e. the 8 CORNERS. `CLUB_PRIORS` here stores [lo, typ, hi], so the
 * corners are entries 0 and 2 — the typical value is deliberately not included,
 * so this reproduces the lab's own search and not a wider one.
 *
 * This is a PHYSICAL bound, not a per-clip tune: it depends only on the bucket.
 */
export function bucketFlightLimits(bucket: Bucket | undefined): BucketFlightLimits {
  const name: Bucket = bucket === undefined ? CAP_BUCKET_UNKNOWN : (CAP_BUCKET[bucket] ?? bucket);
  const cached = CAP_LIMITS.get(name);
  if (cached) return { ...cached };

  const p = CLUB_PRIORS[name];
  const corners = (b: readonly [number, number, number]) => [b[0], b[2]];
  let apexMax = -Infinity;
  let hangMax = -Infinity;
  for (const v0 of corners(p.v0)) {
    for (const thetaDeg of corners(p.thetaDeg)) {
      for (const rpmBack of corners(p.rpmBack)) {
        const f = simulate({ v0, thetaDeg, phiDeg: 0, rpmBack, rpmSide: 0 });
        if (f.summary.apexM > apexMax) apexMax = f.summary.apexM;
        if (f.summary.hangS > hangMax) hangMax = f.summary.hangS;
      }
    }
  }
  const typical = simulate({ v0: p.v0[1], thetaDeg: p.thetaDeg[1], phiDeg: 0, rpmBack: p.rpmBack[1], rpmSide: 0 });
  const limits: BucketFlightLimits = {
    bucket: name,
    apexMaxM: IMPLAUSIBLE_MARGIN * apexMax,
    hangMaxS: IMPLAUSIBLE_MARGIN * hangMax,
    apexTypicalM: typical.summary.apexM,
    hangTypicalS: typical.summary.hangS,
  };
  CAP_LIMITS.set(name, limits);
  return { ...limits };
}

export interface PlausibilityCheck {
  checked: boolean;
  k: number;
  short: boolean;
  priorDriven: boolean;
  apexM: number;
  hangS: number;
  limits: BucketFlightLimits;
  ratio: number;
  over: string[];
  why: string;
}

/**
 * Is this fitted flight possible for the club? Only SHORT or PRIOR-DRIVEN fits
 * are judged — a long track carries its own evidence. IMG_3626 is the case this
 * exists for: 3 detections fitted 71.8 m/s, a 53.7 m apex and 8.2 s of hang,
 * which no golfer produces.
 */
export function checkFlightPlausible(
  fit: FitResult,
  bucket: Bucket | undefined,
  decision: TraceDecision
): PlausibilityCheck {
  const k = fit.nPoints;
  const short = k <= IMPLAUSIBLE_K_MAX;
  const priorDriven =
    decision === 'prior' ||
    fit.flags.some((f) => f.startsWith('underdetermined') || f.startsWith('v0_at_'));
  const limits = bucketFlightLimits(bucket);
  const apexM = fit.summary.apexM;
  const hangS = fit.summary.hangS;
  const aR = apexM / limits.apexMaxM;
  const hR = hangS / limits.hangMaxS;
  const checked = short || priorDriven;
  const over: string[] = [];
  if (checked) {
    if (apexM > limits.apexMaxM) {
      over.push(
        `apex ${apexM.toFixed(1)} m > ${limits.apexMaxM.toFixed(1)} m (the ${limits.bucket} bucket's maximum; ` +
          `its typical shot peaks at ${limits.apexTypicalM.toFixed(1)} m)`
      );
    }
    if (hangS > limits.hangMaxS) {
      over.push(
        `hang ${hangS.toFixed(2)} s > ${limits.hangMaxS.toFixed(2)} s (the ${limits.bucket} bucket's maximum; ` +
          `its typical shot hangs ${limits.hangTypicalS.toFixed(2)} s)`
      );
    }
  }
  return {
    checked,
    k,
    short,
    priorDriven,
    apexM,
    hangS,
    limits,
    ratio: Math.max(aR, hR),
    over,
    why: over.length ? over.join('; ') : checked ? 'plausible' : `not judged (K=${k}, not prior-driven)`,
  };
}

// ─── Arc end (lab: decide_arc_end, search=False) ────────────────────────────

export interface ArcEnd {
  mode: 'fitted' | 'seen';
  /** Flight-relative seconds at which the drawn trace stops; null = the landing. */
  endAtSec: number | null;
  reason: string;
  remainingS: number | null;
  lastToLandingPx: number | null;
}

/**
 * Where the drawn trace stops. The lab's `decide_arc_end` with
 * `seen_landing_search=False` — a supported lab configuration.
 *
 * The in-source touchdown search (`find_seen_landing`) needs frame pixels and
 * has no native counterpart in this wave, so the only "seen" rung available is
 * the one that reads purely from the detections: the ball was tracked to within
 * 0.25 s AND 120 px @1080p of the fitted landing, so stop half a frame after
 * the last detection rather than drawing on to a landing nobody saw.
 */
export function decideArcEnd(
  det: TracerDetectResultV3,
  sel: Selection,
  fit: FitResult,
  fps: number,
  width: number
): ArcEnd {
  const dets = [...(det.detections ?? [])].sort((a, b) => a.frame - b.frame);
  const u = width / 1080.0;
  const t0 = fit.params.t0Sec;
  const hang = fit.summary.hangS;
  if (dets.length === 0) {
    return { mode: 'fitted', endAtSec: null, reason: 'no detections', remainingS: null, lastToLandingPx: null };
  }
  const last = dets[dets.length - 1];
  const kLast = Math.round(last.frame);
  const tLast = kLast / fps - t0;
  const remaining = hang - tLast;
  const landPx = predictTrack(fit, [(t0 + hang) * fps], fps)[0];
  const dLast = Math.hypot(last.x - landPx.x, last.y - landPx.y);

  if (!sel.throughApex) {
    return {
      mode: 'fitted',
      endAtSec: null,
      reason:
        `ball lost in the air ${remaining.toFixed(2)} s before the fitted landing ` +
        '(not tracked through the apex) -> fitted landing',
      remainingS: remaining,
      lastToLandingPx: dLast,
    };
  }
  if (remaining <= END_TAIL_S && dLast <= END_NEAR_LANDING_PX * u) {
    const endFrame = kLast + 0.5;
    // Clamp exactly as the lab does: at least two frames of arc, never past the
    // fitted landing.
    const endAtSec = Math.min(Math.max(endFrame / fps - t0, 2.0 / fps), hang);
    return {
      mode: 'seen',
      endAtSec,
      reason:
        `last detection f${kLast} is ${remaining.toFixed(2)} s / ${dLast.toFixed(0)} px from the fitted ` +
        'landing; trace stops half a frame after it (in-source touchdown search not available)',
      remainingS: remaining,
      lastToLandingPx: dLast,
    };
  }
  return {
    mode: 'fitted',
    endAtSec: null,
    reason:
      `through the apex but the ball was lost ${remaining.toFixed(2)} s / ${dLast.toFixed(0)} px before the ` +
      'fitted landing -> fitted landing',
    remainingS: remaining,
    lastToLandingPx: dLast,
  };
}

// ─── Landing vs horizon (lab: landing_horizon_check) ────────────────────────

export interface LandingCheck {
  horizonRow: number;
  landingPx: [number, number];
  depressionPx: number;
  depressionPx1080: number;
  /** `f * h / carry` — the brief's flat-ground number, which assumes the ball
   *  was hit from directly under the camera. Kept because it is what the lab
   *  reports and what the field notes will be read against. */
  expectedFlatPx: number;
  expectedFlatPx1080: number;
  /** Ground range of the landing from the camera, metres. Null when the caller
   *  could not supply it. */
  landingGroundRangeM: number | null;
  /** `f * h / R` — the expectation the projection must actually reproduce, and
   *  the one the flag is keyed off (REVIEW F8). */
  expectedRangePx: number | null;
  expectedRangePx1080: number | null;
  /** `depressionPx - expectedRangePx`. The number that says whether the drawn
   *  landing sits where the geometry puts it. */
  residualVsRangePx: number | null;
  aboveHorizon: boolean;
  flags: string[];
}

/**
 * Where the FITTED landing sits relative to the calibrated horizon, and whether
 * that agrees with flat ground at the fitted carry (Henry, 5 Sep: "it needs to
 * land on the horizon in relation to how far the ball was hit").
 *
 * A landing ABOVE the horizon is impossible for a ball landing on the camera's
 * ground plane, so `landing_above_horizon_BUG` is a bug flag, not a measurement.
 * The landing pixel is the one the RENDERER will draw — it comes out of the same
 * `flightPixels` call, through the same camera including any fitted dpitch — so
 * this is an assertion about the picture, not a parallel calculation.
 */
export function landingHorizonCheck(
  fit: FitResult,
  landingPx: Px,
  width: number,
  landingGroundRangeM: number | null = null
): LandingCheck {
  const cam = fit.camera;
  const hz = cam.horizonRow(landingPx.x);
  const depPx = landingPx.y - hz;
  const u1080 = width / 1080.0;
  const carry = Math.max(fit.summary.carryM, 1e-6);
  const expectedFlatPx = (cam.params.fPx * cam.params.hCamM) / carry;
  const rangeUsable = landingGroundRangeM !== null && Number.isFinite(landingGroundRangeM) && landingGroundRangeM > 1e-6;
  const expectedRangePx = rangeUsable ? (cam.params.fPx * cam.params.hCamM) / (landingGroundRangeM as number) : null;
  const flags: string[] = [];
  const aboveHorizon = depPx <= 0;
  if (aboveHorizon) flags.push('landing_above_horizon_BUG');

  // REVIEW F8. The flag is keyed off the RANGE residual, not the flat-ground
  // one. The port kept only `expected_flat_px` (`f*h/carry`, which assumes the
  // ball was hit from under the lens) and dropped the lab's `expected_range_px`
  // (`f*h/R`, the landing's real ground range) along with the docstring saying
  // the two differ by tens of px on a 10 m chip and by well under a px on a
  // 250 m drive. So the flag survived and the sentence that says to ignore it
  // did not: on the fixture, a genuine 12 m chip from a ball 4 m in front of the
  // camera fires it at 142.7 px observed vs a 190.7 px flat expectation, where
  // the range expectation is 142.1 px and the residual is 0.6 px.
  //
  // Consequence of the old behaviour: every chip and pitch in a field test would
  // carry a scary-looking flag that means nothing, and a REAL geometry error on
  // a short shot would be indistinguishable from it.
  const expected = expectedRangePx ?? expectedFlatPx;
  const residualVsRangePx = expectedRangePx === null ? null : depPx - expectedRangePx;
  const ratio = expected > 1e-9 ? depPx / expected : Infinity;
  const offRatio = !(1 / DEPRESSION_OFF_RATIO <= ratio && ratio <= DEPRESSION_OFF_RATIO);
  const offPx = Math.abs(depPx - expected) / u1080 > DEPRESSION_OFF_PX;
  if (offRatio || offPx) flags.push('landing_depression_off');
  return {
    horizonRow: hz,
    landingPx: [landingPx.x, landingPx.y],
    depressionPx: depPx,
    depressionPx1080: depPx / u1080,
    expectedFlatPx,
    expectedFlatPx1080: expectedFlatPx / u1080,
    landingGroundRangeM: rangeUsable ? (landingGroundRangeM as number) : null,
    expectedRangePx,
    expectedRangePx1080: expectedRangePx === null ? null : expectedRangePx / u1080,
    residualVsRangePx,
    aboveHorizon,
    flags,
  };
}

// ─── Fit ladder (lab: _fit_ladder) ──────────────────────────────────────────

interface FitVariant {
  fixSpin: boolean;
  fitPitch: boolean;
  dropFrames: number[];
}

interface LadderRun {
  fit: FitResult;
  variant: FitVariant;
  log: LadderEntry[];
  /**
   * The worst `sigma(v0) / v0` any rung of this ladder reported (F4).
   *
   * It is a property of the CLIP's geometry, not of which rung happened to win:
   * a shot straight down the camera axis makes the full-freedom fit
   * ill-conditioned (sigma(v0) 21 % of v0 on the reviewer's fixture), and the
   * spin-bound rescue rung then produces a tight, confident, 47 %-wrong apex.
   * Reading only the drawn fit's sigma cannot see that, because the drawn fit is
   * the tight one.
   */
  worstV0RelSigma: number;
  /**
   * Every pixel-only companion this ladder produced, in the order the rungs ran
   * (FG-1(c)). A joint fit builds one to seed and calibrate itself, so there is
   * one per rung that had a GPS carry — and they are DIFFERENT FITS, not the
   * rungs: a rung rejected because its joint fit was worse can still have a
   * perfectly good pixel-only companion, and the rung that won can have a poor
   * one. `pickPixelOnly` is what reads this.
   */
  pixelOnly: FitResult[];
}

function runFitLadder(
  track: TrackPoint[],
  camera: TracerCamera,
  sel: Selection,
  fps: number,
  addressPx: Px,
  carryM: number | null | undefined,
  bucket: Bucket | undefined,
  model: { fixSpin: boolean; fitPitch: boolean },
  input: TraceClipInput,
  knobs: TracerV3Knobs,
  width: number
): LadderRun {
  const u = width / 1080.0;
  const log: LadderEntry[] = [];
  let worstV0RelSigma = 0;
  const pixelOnly: FitResult[] = [];

  const run = (v: FitVariant, tag: string): FitResult => {
    const dropped = new Set(v.dropFrames);
    const tr = track.filter((t) => !dropped.has(t.frame));
    const f = fitLaunch({
      track: tr,
      camera,
      addressPx,
      impactFrame: sel.kImpFit ?? 0,
      // F2: the departure cue's slack on t0's LOWER bound. Without it a
      // detector that missed the first frames of flight makes a good clip skip.
      impactSlackFrames: sel.impactSlackFrames,
      fps,
      carryM: carryM ?? null,
      bucket,
      fixSpin: v.fixSpin,
      fitPitch: v.fitPitch,
      pitchSigmaDeg: knobs.pitchSigmaDeg,
      carryModel: carryM === null || carryM === undefined ? null : 'nextShot',
      carrySigmaGpsM: input.carrySigmaGpsM ?? undefined,
      maxIterations: knobs.fitMaxIterations,
    });
    log.push({
      tag,
      k: f.nPoints,
      rmsPx: f.rmsPx,
      maxPx: f.maxResidPx,
      v0: f.params.v0,
      thetaDeg: f.params.thetaDeg,
      rpmBack: f.params.rpmBack,
      carryM: f.summary.carryM,
      flags: [...f.flags],
      accepted: false,
    });
    // F4: how well this rung could pin the ball speed. Every rung counts,
    // including the rejected ones — a rung that could not determine v0 is
    // evidence about the geometry, whichever rung ends up drawn.
    worstV0RelSigma = Math.max(worstV0RelSigma, v0RelSigma(f));
    if (f.pixelOnly) pixelOnly.push(f.pixelOnly);
    return f;
  };

  let variant: FitVariant = { fixSpin: model.fixSpin, fitPitch: model.fitPitch, dropFrames: [] };
  let fit = run(variant, 'primary');

  // Rung 1 — a single gross outlier among >= 4 points. Kept only if the rms
  // HALVES, so a marginal improvement never silently discards real evidence.
  if (fit.flags.includes('large_pixel_residual') && fit.nPoints >= 4) {
    const r = fit.residualPx;
    let i = 0;
    for (let j = 1; j < r.length; j++) if (r[j] > r[i]) i = j;
    const others = medianOf(r.filter((_, j) => j !== i));
    if (r[i] > Math.max(OUTLIER_RATIO * others, OUTLIER_MIN_PX * u)) {
      const v1: FitVariant = { ...variant, dropFrames: [fit.frames[i]] };
      if (fit.nPoints - 1 < MIN_FULL_MODEL) v1.fixSpin = true;
      const f1 = run(v1, `drop_outlier:f${fit.frames[i]}`);
      if (f1.rmsPx < 0.5 * fit.rmsPx) {
        fit = f1;
        variant = v1;
        log[log.length - 1].accepted = true;
      }
    }
  }

  // Rung 2 — backspin pinned at a bound is unphysical, so try to get it off.
  //
  // DEVIATION. The lab offers two candidates: add the pitch nuisance, and fix
  // backspin at the prior with TILT STILL FREE. `lib/tracerFit.ts` has no
  // partial `fixed` map — `fixSpin` pins backspin AND tilt — so the second
  // candidate here is stricter than the lab's. That is conservative in the
  // right direction (it removes a degree of freedom rather than adding one),
  // and it is still accepted only if it leaves the bound at <= 1.5x the rms.
  if (fit.flags.some((f) => f.startsWith('rpm_back_at_')) && !variant.fixSpin) {
    const candidates: Array<{ v: FitVariant; tag: string }> = [];
    if (!variant.fitPitch && knobs.fitPitchAllowed && fit.nPoints >= MIN_PITCH_CANDIDATE) {
      candidates.push({ v: { ...variant, fitPitch: true }, tag: 'spin_bound:+pitch' });
    }
    candidates.push({ v: { ...variant, fixSpin: true }, tag: 'spin_bound:spin_fixed' });
    let best: { f: FitResult; v: FitVariant; idx: number } | null = null;
    for (const c of candidates) {
      const fc = run(c.v, c.tag);
      const offBound = !fc.flags.some((f) => f.startsWith('rpm_back_at_'));
      if (offBound && fc.rmsPx <= SPIN_REFIT_RMS_FACTOR * fit.rmsPx && (best === null || fc.rmsPx < best.f.rmsPx)) {
        best = { f: fc, v: c.v, idx: log.length - 1 };
      }
    }
    if (best !== null) {
      fit = best.f;
      variant = best.v;
      log[best.idx].accepted = true;
    }
  }

  if (!log.some((e) => e.accepted)) log[0].accepted = true;
  return { fit, variant, log, worstV0RelSigma, pixelOnly };
}

/**
 * How well a single fit could pin the ball speed: `sigma(v0) / v0`, or 0 when
 * the fit reports no formal sigma for it (a fixed parameter, or an inestimable
 * one). Zero is the right absence value — F4's test is `>=` a threshold, so an
 * unmeasurable rung must not be able to TRIGGER the refusal on its own.
 *
 * Pulled out of `runFitLadder` for FG-3, which needs the same measurement on a
 * fit that is not a ladder rung at all: the pixel-only companion.
 */
function v0RelSigma(f: FitResult): number {
  const sv0 = f.sigma.v0;
  if (sv0 == null || !Number.isFinite(sv0) || !(f.params.v0 > 1e-6)) return 0;
  return sv0 / f.params.v0;
}

/**
 * Which pixel-only fit the fallback DRAWS — FG-1(c), `docs/tracer-v3/final-gate.md`.
 *
 * THE FINDING. When the GPS carry is thrown away the ladder rendered
 * `fit.pixelOnly`: the companion of whichever rung happened to win the JOINT
 * competition. That competition is about the joint fit, and the companion rides
 * along on its model — so on a spin-bound rescue rung the companion is a
 * spin-fixed pixel-only fit which can be a poor one (round 2 measured rms 23 px,
 * refused by the physics gate, while a full-freedom pixel-only run of the same
 * detections drew 257 m against a 251 m truth). The gate then measured the
 * consequence at product level: `pixel_only_fallback` is the single largest
 * source of wrong numbers, 6.4 % of its numbers more than 25 % from truth
 * against 4.2 % for pixel-only-by-design, worst +216 %. Two rounds filed it as
 * out of scope; round 3 made it fire 145 times more often.
 *
 * THE CHOICE, and why it has no threshold in it. Among the companions the
 * ladder produced, take the one that BEST EXPLAINS THE PIXELS — lowest rms —
 * and require `ok`, which is the fitter's own statement that the optimiser
 * converged onto a physical flight with finite parameters. There is nothing to
 * tune: rms is the residual of the same detections through the same camera on
 * every candidate, and "the fit that follows the ball best" is the only
 * defensible answer to "which of these is the pixel-only measurement".
 *
 * WHY NOT the drawn rung's own, i.e. why a rejected rung's companion is
 * eligible: it is not the rung. A rung is rejected for what its JOINT fit did
 * (its rms did not halve, or backspin stayed on a bound); its companion never
 * saw the carry at all. This is F1(b)'s principle pointed the other way — there,
 * a rejected rung's opinion of the GPS still counted; here, a rejected rung's
 * pixel-only answer still counts.
 *
 * TIES GO TO THE INCUMBENT (`current`), so this can only ever move the drawn arc
 * when it has a measured reason to.
 */
function pickPixelOnly(candidates: FitResult[], current: FitResult | null): FitResult | null {
  let best = current !== null && current.ok ? current : null;
  for (const c of candidates) {
    if (!c.ok || !Number.isFinite(c.rmsPx)) continue;
    if (best === null || c.rmsPx < best.rmsPx) best = c;
  }
  // Every candidate unusable -> keep exactly what the branch used to do, so a
  // ladder with no `ok` companion behaves as it did rather than newly skipping.
  return best ?? current;
}

function medianOf(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── The render spec ────────────────────────────────────────────────────────

interface SpecBuild {
  spec: TracerRenderSpecV3 | null;
  reason: string | null;
  sampleCount: number;
  /** Ground range from the camera of the LAST sample actually emitted, i.e. of
   *  the point the renderer draws as the landing. `landingHorizonCheck` needs
   *  the range, not the carry (REVIEW F8), and this is the only place that
   *  knows which sample survived the in-front trim and the truncation. */
  landingGroundRangeM: number | null;
}

/**
 * Flight -> render spec. This is where SHARED CONVENTION 1 and SHARED
 * CONVENTION 3 meet, and it is the only place either is applied.
 *
 * The three invariants `TracerRenderV3.swift` hard-rejects on are produced here
 * rather than hoped for: `tSec[0] === 0`, strictly increasing, and
 * `tSec.last === animDurationSec`.
 */
function buildSpec(
  fit: FitResult,
  input: TraceClipInput,
  knobs: TracerV3Knobs,
  arcEnd: ArcEnd,
  labelText: string | undefined,
  labelSubText: string | undefined
): SpecBuild {
  const { fps, width, height } = input.detection;
  const offset = input.detectToRenderOffsetSec ?? 0;
  const tEndSec = arcEnd.endAtSec ?? fit.summary.hangS;
  const raw = flightPixels(fit, { fps, hz: knobs.renderHz, tEndSec });

  // Drop everything from the first sample that is behind the camera plane
  // onward. `project` returns NaN there, and a polyline that resumes after a
  // gap would be drawn as a straight line across the frame.
  const leading: typeof raw = [];
  for (const s of raw) {
    if (!s.inFront) break;
    leading.push(s);
  }
  if (leading.length < 2) {
    return {
      spec: null,
      reason: 'render_spec:fewer than 2 in-front samples',
      sampleCount: leading.length,
      landingGroundRangeM: null,
    };
  }

  const t0Clip = leading[0].tSec - offset;
  const samples: RenderSampleV3[] = [];
  const depths: number[] = [];
  // F8: the GROUND range of the last emitted sample, for the landing check.
  let landingRangeM: number | null = null;
  let prevT = -Infinity;
  for (const s of leading) {
    const t = s.tSec - offset - t0Clip;
    // Strictly increasing: `flightPixels` clamps its last step to tEnd, which
    // can duplicate the previous time to within floating-point noise, and equal
    // keyTimes glitch a CAKeyframeAnimation.
    if (t <= prevT + 1e-6) continue;
    prevT = t;
    const n = pxToNormalizedBottomLeft({ x: s.x, y: s.y }, width, height);
    samples.push({ x: n.x, y: n.y, tSec: t });
    depths.push(s.depthM);
    landingRangeM = s.groundRangeM;
  }
  if (samples.length < 2) {
    return {
      spec: null,
      reason: 'render_spec:fewer than 2 distinct samples',
      sampleCount: samples.length,
      landingGroundRangeM: null,
    };
  }
  samples[0].tSec = 0; // exact, not 1e-17

  const animStartSec = t0Clip;
  const animDurationSec = samples[samples.length - 1].tSec;
  if (!(animStartSec >= 0) || !(animDurationSec > 0)) {
    return {
      spec: null,
      reason: `render_spec:animStartSec ${animStartSec.toFixed(3)} / animDurationSec ${animDurationSec.toFixed(3)} out of range`,
      sampleCount: samples.length,
      landingGroundRangeM: null,
    };
  }

  // Freeze completion: when the flight outlasts the clip, hold the last source
  // frame so the trace still LANDS instead of being cut mid-air (render3 §4).
  // Capped, because a 3-detection fit can produce an 8 s hang on a 6 s clip and
  // holding a still frame for six seconds is not a highlight reel.
  const needsToSec = animStartSec + animDurationSec + knobs.freezeTailSec;
  let freezeCompleteToSec: number | null = null;
  if (knobs.freezeComplete && needsToSec > input.renderDurationSec) {
    freezeCompleteToSec = Math.min(needsToSec, input.renderDurationSec + knobs.freezeMaxSec);
  }

  // The renderer rejects a draw that starts within 0.4 s of the COMPOSED end
  // (ERR_TRACER_ANIM_WINDOW) — an animation with no time to run is an export
  // with an invisible tracer. Catching it here turns a 'failed' clip, which the
  // batch retries once and then leaves failed forever, into an honest 'skipped'
  // with a reason. The composed end includes any freeze tail, which is why this
  // is computed after it and not before.
  const composedEndSec = freezeCompleteToSec ?? input.renderDurationSec;
  if (!(animStartSec < composedEndSec - 0.4)) {
    return {
      spec: null,
      reason:
        `render_spec:anim window too short (draw starts at ${animStartSec.toFixed(2)} s, ` +
        `the clip ends at ${composedEndSec.toFixed(2)} s)`,
      sampleCount: samples.length,
      landingGroundRangeM: null,
    };
  }

  return {
    spec: {
      samples,
      depths,
      animStartSec,
      animDurationSec,
      // Colours and widths come from the shipped v1 tracer style so the two
      // engines look like the same product.
      color: config.tracer.color,
      coreColor: config.tracer.coreColor,
      lineWidthPx: config.tracer.lineWidthPx,
      midWidthPx: config.tracer.midWidthPx,
      glowWidthPx: config.tracer.glowWidthPx,
      cometHead: config.tracer.cometHead,
      occlusion: knobs.occlusion,
      labelText,
      labelSubText,
      labelAtApex: true,
      // `endAtSec` is deliberately NOT sent: the truncation is already applied
      // by `flightPixels(tEndSec)` above, so the samples END where the trace
      // should. Sending both would truncate twice. The key is omitted rather
      // than set to null so the Swift parser never has to coerce an NSNull.
      ...(freezeCompleteToSec === null ? {} : { freezeCompleteToSec }),
    },
    reason: null,
    sampleCount: samples.length,
    landingGroundRangeM: landingRangeM,
  };
}

/**
 * The pill. Rounded to the fit's own honest step (1 / 5 / 10 m from
 * `sigmaTotal.carryM`, which includes the f_px systematic), and explicitly
 * marked "no GPS" on a pixel-only render — a distance derived from pixels alone
 * rides entirely on the focal-length prior and must not read like a measurement.
 */
export function buildLabel(
  fit: FitResult,
  hasGps: boolean,
  labelRounding: boolean,
  /**
   * Why this pill must not state a distance, or null to state one.
   *   `axis_degenerate`  REVIEW F4 — the geometry lost the scale (see below).
   *   `gps_unchecked`    GATE NEW-1(b), widened to the whole class by GATE-1 —
   *                      the number's scale came from a GPS distance the pixels
   *                      did not CONFIRM (too loose to check, in tension with,
   *                      or untestable against).
   */
  noDistance: 'axis_degenerate' | 'gps_unchecked' | 'too_uncertain' | null = null,
  /**
   * 1-sigma the rounding step is taken from, metres. Defaults to the fit's own
   * `sigmaTotal.carryM`; the unconfirmed-GPS case passes a WIDER one, because
   * there the fit's own sigma is not the whole error.
   */
  labelSigmaM?: number
): { labelText: string; labelSubText: string } {
  // REVIEW F4. On the axis-degenerate geometry the pill DROPS the numbers
  // rather than widening the rounding step.
  //
  // Why dropped and not widened: the fit's own sigma is what drives the step,
  // and here the sigma is small (0.8 % of v0 on the drawn rung) while the error
  // is 47 % of apex and ~9 m of carry — so no step this fit can compute
  // describes the error, and a 10 m step still reads as a measurement. The apex
  // is the worse of the two and rounding never touched it at all. Drawing the
  // line is fine and the line is still drawn; claiming the number is not.
  if (noDistance === 'axis_degenerate') {
    return { labelText: 'down the line', labelSubText: 'no distance' };
  }
  // GATE NEW-1(b), widened by GATE-1. Same remedy, different cause: the drawn
  // number's scale came from a GPS reading the pixels did not confirm — too
  // loose to test it (`carry_as_scale`), in 2-4 sigma tension with it
  // (`carry_tension`), or with no pixel-only companion to test it against at
  // all (`carry_untested`). Measured: a 130 m GPS carry on a 251 m shot drew
  // "220 m"; an 80 m one on a 164.6 m shot drew "100 m". The trace is still
  // drawn; the number is not claimed.
  if (noDistance === 'gps_unchecked') {
    return { labelText: 'no distance', labelSubText: 'GPS unchecked' };
  }
  // FG-1 (docs/tracer-v3/final-gate.md), and it is the rung this feature was
  // missing rather than a third special case. The two above are about a
  // PARTICULAR cause — the geometry lost the scale, the GPS was never confirmed.
  // This one is the general statement both of them are instances of: the fit's
  // own 1-sigma is too wide for any step in the vocabulary to describe, so a
  // number would read as a measurement it is not.
  //
  // THE WORDING. It has to be useful as well as honest, because withholding is
  // now common enough that "no distance" alone would be most of what a golfer
  // sees. "Not enough of the flight" is the actual cause and the actionable one:
  // the carry's uncertainty is dominated by depth, depth is resolved by seeing
  // the ball descend, and the gate's own failure table is concentrated on the
  // 5-8 frame tracks that stop before the apex. It tells the golfer the one
  // thing they can change — frame more of the shot — rather than confessing to
  // an internal quantity they cannot act on.
  if (noDistance === 'too_uncertain') {
    return { labelText: 'no distance', labelSubText: 'not enough of the flight' };
  }
  const sigmaM = labelSigmaM ?? fit.sigmaTotal.carryM;
  const carryM = labelRounding ? roundLabelM(fit.summary.carryM, sigmaM) : Math.round(fit.summary.carryM);

  // CT-6 (docs/tracer-v3/certify.md). Four review rounds gated the CARRY and
  // none of them touched the APEX, which sits on the same pill with nothing
  // between it and the golfer. The certifying sweep found a clip whose pill
  // read "apex 39 m" for a shot that peaked at 7.5 m — a 5x error next to a
  // carry that had passed every gate — and measured the apex as materially
  // less reliable than the carry the rounds were about (+50 % on a clean
  // 20-frame track where the carry was 3.3 % out).
  //
  // The reason is geometric, not a bug: apex is resolved by the ball's
  // VERTICAL travel late in the flight, which is exactly what a track that
  // stops early does not contain, and unlike the carry it has no GPS
  // constraint to fall back on. So it gets the rule the carry already has,
  // applied to its own sigma: state it only when the fit's own 1-sigma on
  // apex is inside LOOSE_APEX_SIGMA_FRAC of the apex. Withheld, the sub-line
  // keeps the GPS provenance marker, because that describes the CARRY on the
  // line above and is still true.
  const apexSigmaM = fit.sigmaTotal.apexM;
  const apexUsable =
    Number.isFinite(fit.summary.apexM) &&
    fit.summary.apexM > 0 &&
    Number.isFinite(apexSigmaM) &&
    apexSigmaM <= LOOSE_APEX_SIGMA_FRAC * fit.summary.apexM;
  const apexPart = apexUsable ? `apex ${Math.round(fit.summary.apexM)} m` : 'apex —';
  return {
    labelText: `${carryM} m`,
    labelSubText: hasGps ? apexPart : `${apexPart} · no GPS`,
  };
}

// ─── The entry point ────────────────────────────────────────────────────────

function skip(
  reason: string,
  flags: string[],
  meta: TracerV3Meta,
  startedAt: number
): TraceClipResult {
  meta.decision = 'none';
  meta.reason = reason;
  meta.flags = flags;
  meta.elapsedMs = Date.now() - startedAt;
  return { decision: 'none', reason, flags, spec: null, meta };
}

/**
 * Detections + camera + optional GPS carry -> a render spec, or an honest skip.
 *
 * REFUSALS, in the order they fire. Every one of them is a clean skip with a
 * reason, and NONE of them draws a reduced-confidence arc:
 *
 *   no address ball        the detector never found the ball at rest
 *   lens_unsupported       not shot at 1x with no pinch, so f_px is wrong (F3a)
 *   putt                   the swing classifier said putt
 *   no detections          nothing flew, or nothing was seen to fly
 *   too few + no carry     < 3 detections and no GPS distance to scale them
 *   never climbs           the track never rises 25 px @1080p above the address
 *   camera uncalibratable  no pitch, or the address ball is above the horizon
 *   not_a_flight           v0 < 8 m/s, apex < 0.3 m or hang < 0.4 s (a putt)
 *   track_not_ballistic    rms > 8 px @1080p (a topped shot's wrong detections)
 *   poor_fit               rms > 4 px @1080p over >= 10 frames
 *   implausible_flight     a short fit whose apex/hang exceeds the club's maximum
 *   render_spec:*          the flight cannot be expressed as a drawable polyline
 */
export function traceClip(input: TraceClipInput): TraceClipResult {
  const startedAt = Date.now();
  const knobs = resolveV3Knobs(config.tracer, input.knobs);
  const det = input.detection;
  const { fps, width, height } = det;
  const u = width / 1080.0;
  const flags: string[] = [];

  const meta: TracerV3Meta = {
    engine: 'v3',
    decision: 'none',
    reason: null,
    flags,
    nDetections: det.detections?.length ?? 0,
    selection: {
      mode: 'none', k: 0, throughApex: false, climbPx: null, frameRange: null,
      kImpFit: null, impactSlackFrames: 0, nNonFinite: 0,
    },
    ladder: [],
    detectorNotes: det.notes ?? {},
    msPerFrame: det.msPerFrame,
    elapsedMs: 0,
  };

  // The detector reports whether it moved the impact frame; carry that through
  // so a timing argument in the field can be settled from the row.
  const corrected = det.notes?.impactCorrected;
  if (corrected !== undefined && corrected !== false) flags.push(`impact_corrected:${String(corrected)}`);

  // ── Absences of input. `forceTrace` does NOT bypass these: there is nothing
  //    to draw, and inventing an arc from no evidence is the one thing this
  //    file exists to prevent.
  if (!det.found || det.address === null) {
    return skip('detector_found_no_address_ball', flags, meta, startedAt);
  }
  if (!Number.isFinite(fps) || fps <= 0 || width <= 0 || height <= 0) {
    return skip(`detector_geometry_invalid(fps=${fps}, ${width}x${height})`, flags, meta, startedAt);
  }

  // ── The lens the clip was shot on (REVIEW F3a). Also an absence of input, and
  //    for the same reason: `fPx` describes the 1x wide lens at its native
  //    framing, so on any other lens or with any pinch zoom applied the scale of
  //    the whole world model is wrong by that factor — and wrong SILENTLY, with
  //    a fit that converges and a label that reads like a measurement. A 1.5x
  //    pinch drew a 202 m drive as "140 m". `forceTrace` does NOT bypass this:
  //    it bypasses judgements about a shot, and this is not a judgement, it is
  //    not knowing how big the world is.
  const capLens = input.capture?.lens ?? null;
  const capZoom = input.capture?.zoom ?? null;
  const lensOk = capLens === SUPPORTED_CAPTURE_LENS;
  const zoomOk = capZoom !== null && Number.isFinite(capZoom) && Math.abs(capZoom) <= CAPTURE_ZOOM_EPSILON;
  if (!lensOk || !zoomOk) {
    return skip(
      `lens_unsupported:shot at lens=${capLens ?? 'unknown'} zoom=${capZoom === null ? 'unknown' : capZoom.toFixed(3)}; ` +
        `f_px is only known for the ${SUPPORTED_CAPTURE_LENS} wide lens at zoom 0, and every distance scales with it`,
      flags,
      meta,
      startedAt
    );
  }

  // ── A judgement, so `forceTrace` may bypass it (street tests have no club).
  if (input.shotType === 'putt' && !knobs.forceTrace) {
    return skip('putt', flags, meta, startedAt);
  }

  const sel = selectDetections(det);
  meta.selection = {
    mode: sel.mode,
    k: sel.used.length,
    throughApex: sel.throughApex,
    climbPx: sel.climbPx,
    frameRange: sel.frameRange,
    kImpFit: sel.kImpFit,
    impactSlackFrames: sel.impactSlackFrames,
    nNonFinite: sel.nNonFinite,
  };
  // FG-4: a field row must say the detector emitted junk, not silently show a
  // smaller K than the detector reported.
  if (sel.nNonFinite > 0) {
    flags.push(`non_finite_detections_dropped:${sel.nNonFinite}/${meta.nDetections}`);
  }

  const carryM = input.carryM ?? null;
  const model = chooseModel(sel.used.length, carryM, sel, fps, knobs);
  if (model.decision === 'none') {
    return skip(model.reason ?? 'no_detections', flags, meta, startedAt);
  }
  if (model.decision === 'prior') flags.push('prior');

  // A track that never rises is a top, a shank along the ground, or a rolling
  // ball. The detector cannot tell; this rung can.
  if (
    sel.climbPx !== null &&
    Number.isFinite(sel.climbPx) &&
    sel.climbPx < MIN_CLIMB_PX * u &&
    sel.used.length >= MIN_FIT &&
    !knobs.forceTrace
  ) {
    flags.push('not_a_flight');
    return skip(
      `not_a_flight:track never climbs (max rise ${(sel.climbPx ?? 0).toFixed(0)} px above the address)`,
      flags,
      meta,
      startedAt
    );
  }

  // ── Camera. The address ball gives the height; CoreMotion gives the pitch.
  if (input.pitchDownDeg === null || !Number.isFinite(input.pitchDownDeg)) {
    return skip('no_camera_pitch(CoreMotion sample missing)', flags, meta, startedAt);
  }
  let camParams: CameraParams;
  try {
    camParams = calibrateFromAddressBall({
      addressPx: { x: det.address.x, y: det.address.y },
      addressDiamPx: 2 * det.address.r,
      fPx: input.fPx,
      width,
      height,
      pitchDownDeg: input.pitchDownDeg,
      rollDeg: input.rollDeg ?? 0,
      // TRUE unless the focal length came from AVCaptureDevice intrinsics. It
      // never does today (native reports `videoFieldOfView`, a format prior),
      // so the fit carries the lab's +-12 % f_px systematic and the label's
      // rounding step widens accordingly. That is the honest state, not a
      // pessimistic default.
      fPxIsPrior: input.fPxSource !== 'intrinsics',
    });
  } catch (err) {
    return skip(`camera_calibration_failed:${err instanceof Error ? err.message : String(err)}`, flags, meta, startedAt);
  }
  const camera = new TracerCamera(camParams);
  meta.camera = {
    fPx: camParams.fPx,
    fPxSource: input.fPxSource,
    hCamM: camParams.hCamM,
    pitchDownDeg: camParams.pitchDownDeg,
    rollDeg: camParams.rollDeg,
  };

  // ── Fit.
  const addressPx: Px = { x: det.address.x, y: det.address.y };
  let run: LadderRun;
  try {
    run = runFitLadder(
      trackForFit(sel.used),
      camera,
      sel,
      fps,
      addressPx,
      carryM,
      input.bucket,
      model,
      input,
      knobs,
      width
    );
  } catch (err) {
    // `fitLaunch` THROWS for inputs from which no fit exists (empty track, a
    // first frame not after the impact frame, an address pixel above the
    // horizon). That is a refusal, not a crash.
    return skip(`fit_failed:${err instanceof Error ? err.message : String(err)}`, flags, meta, startedAt);
  }
  let fit = run.fit;
  let variant = run.variant;
  meta.ladder = run.log;
  // F4: the worst-conditioned rung of whichever ladder produced the drawn fit.
  let worstV0RelSigma = run.worstV0RelSigma;
  // FG-1(c): every pixel-only companion that ladder produced, for the fallback.
  let pixelOnlyCandidates = run.pixelOnly;

  // ── Held-out check: does the early fit predict the detections it did NOT
  //    use? IMG_2331's 14-frame early fit was 25 px off the 9 later detections
  //    and drew a 5-degree bullet under a ball that kept climbing.
  if (sel.mode !== 'all' && sel.used.length >= MIN_FIT) {
    const usedFrames = new Set(fit.frames);
    const dropped = new Set(variant.dropFrames);
    // FG-4: `finiteDetections`, not `det.detections` — a non-finite point here
    // would be counted toward `HOLDOUT_MIN_N` and then produce a NaN offset the
    // median silently drops.
    const held = finiteDetections(det).filter(
      (d) => !usedFrames.has(Math.round(d.frame)) && !dropped.has(Math.round(d.frame))
    );
    if (held.length >= HOLDOUT_MIN_N) {
      const uv = predictTrack(fit, held.map((d) => d.frame), fps);
      const offs = uv
        .map((p, i) => (Number.isFinite(p.x) && Number.isFinite(p.y) ? Math.hypot(p.x - held[i].x, p.y - held[i].y) : NaN))
        .filter((v) => Number.isFinite(v));
      const med = offs.length ? medianOf(offs) : NaN;
      meta.selection.holdoutMedianPx = Number.isFinite(med) ? med : undefined;
      if (Number.isFinite(med) && med > HOLDOUT_REFIT_PX * u) {
        // FG-4: same array the counts and the fit see, not the raw one.
        const all = [...finiteDetections(det)].sort((a, b) => a.frame - b.frame);
        const sel2: Selection = {
          ...sel,
          used: all,
          mode: 'all_holdout',
          frameRange: [Math.round(all[0].frame), Math.round(all[all.length - 1].frame)],
        };
        const model2 = chooseModel(all.length, carryM, sel2, fps, knobs);
        let run2: LadderRun | null = null;
        try {
          run2 = runFitLadder(trackForFit(all), camera, sel2, fps, addressPx, carryM, input.bucket, model2, input, knobs, width);
        } catch {
          run2 = null;
        }
        if (run2) {
          for (const e of run2.log) e.tag = `holdout_refit:${e.tag}`;
          meta.ladder = [...meta.ladder, ...run2.log];
          // Kept only when the all-frame fit actually beats the disagreement it
          // was called in to explain.
          if (run2.fit.rmsPx < med) {
            flags.push(
              `holdout_refit:K${fit.nPoints}->${run2.fit.nPoints}(held-out median ${med.toFixed(1)}px, ` +
                `all-frame rms ${run2.fit.rmsPx.toFixed(2)})`
            );
            fit = run2.fit;
            variant = run2.variant;
            worstV0RelSigma = run2.worstV0RelSigma;
            pixelOnlyCandidates = run2.pixelOnly;
            meta.selection = {
              mode: 'all_holdout',
              k: all.length,
              throughApex: sel2.throughApex,
              climbPx: sel2.climbPx,
              frameRange: sel2.frameRange,
              kImpFit: sel2.kImpFit,
              impactSlackFrames: sel2.impactSlackFrames,
              nNonFinite: sel2.nNonFinite,
              holdoutMedianPx: med,
            };
          } else {
            flags.push(
              `holdout_disagreement:${med.toFixed(1)}px on ${held.length} later detections (all-frame refit not better)`
            );
          }
        }
      }
    }
  }

  if (variant.dropFrames.length) flags.push(`dropped_outlier:f${variant.dropFrames.join(',')}`);

  // ── The GPS carry's verdict on the fit.
  let decision: TraceDecision = model.decision;
  let usedFit = fit;
  if (carryM !== null) {
    // REVIEW F1(b). This used to read `fit.flags` — the flags of whichever rung
    // the ladder ENDED on — so a refit's opinion silently overwrote the
    // primary's. Reproduced: a 40 m GPS carry against a 204 m pixel track was
    // detected as `carry_inconsistent(z=6.2sigma)` by the primary fit and then
    // accepted by the spin-bound refit, which drew "210 m / apex 35 m". A
    // disagreement between the GPS and the pixels is a statement about the DATA,
    // not about the rung that noticed it, so once ANY fit in the sequence has
    // raised it, it survives into the decision and into the label.
    //
    // `meta.ladder` is the sequence so far — the primary run plus a hold-out
    // refit if one ran — including rungs that were not accepted. Deliberate: a
    // rejected rung's `carry_inconsistent` still means the GPS and the pixels
    // disagreed, and the cost of honouring it is a pixel-only render, which is
    // the safe half of the trade.
    const ladderInconsistent = meta.ladder
      .flatMap((e) => e.flags)
      .filter((f) => f.startsWith('carry_inconsistent'));
    const inconsistent = [
      ...fit.flags.filter((f) => f.startsWith('carry_inconsistent')),
      ...ladderInconsistent,
    ];
    const worse = fit.flags.some((f) => f.startsWith('joint_fit_worse_pixel_minimum'));
    // FG-1(c): the best pixel-only fit the ladder produced, not blindly the
    // drawn rung's companion. See `pickPixelOnly`.
    const pixelOnly = pickPixelOnly(pixelOnlyCandidates, fit.pixelOnly);
    // Recorded only when the companion is actually DRAWN, so a field row never
    // carries a note about a fit nobody saw.
    const notePick = () => {
      if (pixelOnly !== null && pixelOnly !== fit.pixelOnly) {
        flags.push(
          `pixel_only_best_of_ladder(rms ${(fit.pixelOnly?.rmsPx ?? NaN).toFixed(2)}->` +
            `${pixelOnly.rmsPx.toFixed(2)} px over ${pixelOnlyCandidates.length} companions)`
        );
      }
    };
    if (pixelOnly && worse) {
      // The optimiser, not the data: the joint fit found a worse pixel minimum
      // than its own pixel-only companion. Render the companion.
      flags.push(
        `joint_fit_rejected:worse_pixel_minimum(chi2_px ${fit.chi2Px.toFixed(1)} vs ${(fit.pixelOnly?.chi2Px ?? NaN).toFixed(1)})`
      );
      notePick();
      usedFit = pixelOnly;
    } else if (inconsistent.length) {
      // The DATA: the GPS distance and the pixels cannot both be right, so drop
      // the GPS rather than bend the arc to it.
      decision = 'pixel_only_fallback';
      flags.push('inconsistent');
      if (pixelOnly) notePick();
      usedFit = pixelOnly ?? fit;
      meta.reason = inconsistent[0];
    } else if (fit.flags.some((f) => f.startsWith('carry_tension'))) {
      // GATE-1: this is a diagnostic flag ONLY. Until 6 Sep it was the whole of
      // what `carry_tension` did — pushed here and never read again — which is
      // byte-for-byte the shape `carry_as_scale` had before NEW-1(b), and it let
      // an 80 m GPS reading be drawn as "100 m" on a 164.6 m shot. What the
      // verdict now costs the LABEL is decided below, next to `gpsBackedLabel`,
      // for every unconfirmed verdict at once. Do not re-derive it here.
      flags.push('carry_tension');
    }
    if (fit.carryStatus === 'carry_as_scale') flags.push('carry_as_scale');
  }
  for (const f of usedFit.flags) if (!flags.includes(f)) flags.push(f);

  // ── Plausibility (lab wave 5). A 3-point track cannot pin speed against
  //    launch angle, and without a bound the optimiser is free to answer with a
  //    flight no golfer hits.
  //
  //    DEVIATION, and it is the biggest one in this file. The lab REFITS with a
  //    tightened prior (three candidates) and only flags if none works.
  //    `lib/tracerFit.ts` accepts a bucket, not a prior, so a tightened prior
  //    cannot be expressed. What is expressible is the reduced model, so that
  //    is tried; if the flight is still outside the club's physical maximum the
  //    ladder REFUSES rather than draw it. That is stricter than the lab — the
  //    lab renders an uncapped implausible flight with a flag — and stricter is
  //    the right direction for something a golfer will see.
  if (knobs.implausibleCap) {
    let check = checkFlightPlausible(usedFit, input.bucket, decision);
    if (check.over.length && !variant.fixSpin) {
      const rmsBudget = Math.max(IMPLAUSIBLE_RMS_FACTOR * usedFit.rmsPx, IMPLAUSIBLE_RMS_FLOOR_PX * u);
      try {
        const reduced = runFitLadder(
          trackForFit(sel.used),
          camera,
          sel,
          fps,
          addressPx,
          carryM,
          input.bucket,
          { fixSpin: true, fitPitch: false },
          input,
          knobs,
          width
        );
        for (const e of reduced.log) e.tag = `implausible_refit:${e.tag}`;
        meta.ladder = [...meta.ladder, ...reduced.log];
        const reducedCheck = checkFlightPlausible(reduced.fit, input.bucket, decision);
        if (reducedCheck.over.length === 0 && reduced.fit.rmsPx <= rmsBudget) {
          flags.push(
            `implausible_flight_capped:${check.why} -> reduced model ` +
              `(apex ${usedFit.summary.apexM.toFixed(1)}->${reduced.fit.summary.apexM.toFixed(1)} m, ` +
              `rms ${usedFit.rmsPx.toFixed(2)}->${reduced.fit.rmsPx.toFixed(2)} px)`
          );
          usedFit = reduced.fit;
          check = reducedCheck;
          // FG-3, same shape: this refit runs its OWN ladder, and the drawn fit
          // is now one of its rungs, so its conditioning is part of "the worst
          // any rung of the ladder that produced the drawn fit reported".
          // Discarding it lost F4's evidence exactly the way the fallback did.
          worstV0RelSigma = Math.max(worstV0RelSigma, reduced.worstV0RelSigma);
        }
      } catch {
        /* the reduced refit is a bonus; its failure just leaves the check as it was */
      }
    }
    meta.implausible = {
      checked: check.checked,
      over: check.over,
      apexM: check.apexM,
      hangS: check.hangS,
      apexMaxM: check.limits.apexMaxM,
      hangMaxS: check.limits.hangMaxS,
      bucket: check.limits.bucket,
    };
    if (check.over.length && !knobs.forceTrace) {
      flags.push('implausible_flight');
      recordFit(meta, usedFit, carryM, input);
      return skip(`implausible_flight:${check.why}`, flags, meta, startedAt);
    }
  }

  // ── The three physics refusals, exactly the lab's thresholds.
  let refusal: [string, string] | null = null;
  if (
    usedFit.params.v0 < MIN_FLIGHT_V0 ||
    usedFit.summary.apexM < MIN_FLIGHT_APEX_M ||
    usedFit.summary.hangS < MIN_FLIGHT_HANG_S
  ) {
    refusal = [
      'not_a_flight',
      `not_a_flight:fitted v0 ${usedFit.params.v0.toFixed(1)} m/s, apex ${usedFit.summary.apexM.toFixed(2)} m, ` +
        `hang ${usedFit.summary.hangS.toFixed(2)} s (a putt or a rolling ball)`,
    ];
  } else if (usedFit.rmsPx > MAX_RMS_PX * u) {
    refusal = [
      'track_not_ballistic',
      `track_not_ballistic:rms ${usedFit.rmsPx.toFixed(1)} px > ${(MAX_RMS_PX * u).toFixed(0)} px over ` +
        `${usedFit.nPoints} frames (the detections do not lie on a flight; nothing drawn)`,
    ];
  } else if (usedFit.nPoints >= POOR_FIT_MIN_K && usedFit.rmsPx > POOR_FIT_RMS_PX * u) {
    refusal = [
      'poor_fit',
      `poor_fit:rms ${usedFit.rmsPx.toFixed(1)} px > ${(POOR_FIT_RMS_PX * u).toFixed(0)} px over ` +
        `${usedFit.nPoints} frames (the fitted flight does not follow the detected ball; nothing drawn ` +
        'rather than a wrong trace)',
    ];
  }
  if (refusal !== null && !knobs.forceTrace) {
    flags.push(refusal[0]);
    recordFit(meta, usedFit, carryM, input);
    return skip(refusal[1], flags, meta, startedAt);
  }
  if (refusal !== null) flags.push(`forced_past:${refusal[0]}`);

  recordFit(meta, usedFit, carryM, input);

  // ── Arc end, landing check, spec.
  const arcEnd = decideArcEnd(det, sel, usedFit, fps, width);
  meta.arcEnd = { mode: arcEnd.mode, endAtSec: arcEnd.endAtSec, reason: arcEnd.reason };
  flags.push(`arc_end:${arcEnd.mode}`);

  // ── REVIEW F4: a shot straight down the camera axis.
  //
  // The plan called this case "a near-vertical line. Real, not a bug." It
  // understates it: at phi = 0 the geometry loses the SCALE as well as the
  // direction, and it does so at a residual small enough to pass every gate. On
  // the reviewer's own fixture, phi = 0 fits at 0.64 px rms and reports apex
  // 35.5 m against a truth of 24.2 m — a 47 % error, with no flag, on the
  // capture the app itself instructs (down the line at the target).
  //
  // It is not detectable from the drawn fit alone, because the drawn fit is the
  // tight one: the full-freedom rung is the one that goes ill-conditioned
  // (sigma(v0)/v0 = 21 % at phi = 0 against 2-3 % elsewhere), and the ladder's
  // spin-bound rescue then answers confidently. So the test is the azimuth of
  // the drawn fit AND the worst conditioning any rung of its ladder reported.
  //
  // KNOWN GAP, stated rather than hidden: a track short enough that the ladder
  // never runs a full-freedom rung (`fixSpin` from the start, K < 5) has no
  // ill-conditioned rung to notice, so this cannot fire for it. Those fits are
  // the ones the plausibility cap judges hardest, which is the only thing
  // standing in for it there.
  //
  // FG-3 (docs/tracer-v3/final-gate.md). The refusal above was SILENTLY LOST on
  // `pixel_only_fallback`, and the mechanism is the mirror image of the one this
  // flag was invented for. `worstV0RelSigma` is accumulated over the rungs the
  // ladder RAN; with a GPS carry supplied those rungs are the JOINT fits, which
  // the carry keeps well conditioned, so the worst v0 sigma never gets large.
  // The fit then DRAWN on the fallback is the pixel-only companion — precisely
  // the ill-conditioned one this exists to catch, and one no rung of that ladder
  // ever measured. Supplying a GPS carry the ladder then throws away removed F4's
  // protection from the very fit it was written for.
  //
  // The gate measured it: 52 geometries where the no-GPS control correctly
  // refuses with "down the line / no distance" state a number once some GPS
  // carry is supplied, 18 of them more than 25 % wrong, worst +216 %. And it is
  // a wrong ARC as well as a wrong number — a near-vertical pole down the camera
  // axis with a distance on it.
  //
  // So: the worst of the ladder's rungs AND the fit that is actually drawn. Both
  // terms are load-bearing and neither replaces the other —
  //   * the ladder term is F4's original case, where the drawn fit is the TIGHT
  //     spin-bound rescue and only a rejected rung knows the geometry was bad;
  //   * the drawn term is FG-3's case, where the drawn fit is not a rung at all.
  // When the drawn fit IS a rung the max is a no-op, because `runFitLadder`
  // already folded it in.
  const drawnV0RelSigma = v0RelSigma(usedFit);
  const axisV0RelSigma = Math.max(worstV0RelSigma, drawnV0RelSigma);
  const axisDegenerate =
    Math.abs(usedFit.params.phiDeg) < AXIS_DEGENERATE_PHI_DEG &&
    axisV0RelSigma >= AXIS_DEGENERATE_V0_REL_SIGMA;
  meta.conditioning = { worstV0RelSigma, drawnV0RelSigma };
  if (axisDegenerate) {
    flags.push(
      `axis_degenerate(phi=${usedFit.params.phiDeg.toFixed(2)}deg,` +
        `worst_sigma_v0=${(100 * axisV0RelSigma).toFixed(0)}%_of_v0,` +
        `drawn_sigma_v0=${(100 * drawnV0RelSigma).toFixed(0)}%_of_v0)`
    );
  }

  // The GPS marker is about PROVENANCE, so it must say whether the carry was
  // USED, not whether one was supplied (REVIEW F5). On `pixel_only_fallback` the
  // GPS was tested and thrown away; on `joint_fit_rejected` the joint fit was
  // discarded for its pixel-only companion. Both draw from pixels alone and both
  // used to omit "· no GPS", which is the one thing that marker exists to say.
  const gpsBackedLabel =
    carryM !== null &&
    decision !== 'pixel_only_fallback' &&
    !flags.some((f) => f.startsWith('joint_fit_rejected'));

  // ── GATE-1: a GPS-set scale the pixels did not CONFIRM — every rung of it.
  //
  // This began as NEW-1(b), which covered `carry_as_scale` alone: that verdict
  // was pushed as a flag here and otherwise ignored, so the pill read exactly
  // like a measured distance — same rounding step, and no "· no GPS", because
  // the GPS genuinely WAS used. `carry_tension` had the identical shape one rung
  // below (`flags.push('carry_tension')` and nothing else, a few lines above),
  // and the gate agent walked straight through it: a GPS reading of 80 m against
  // a 164.6 m shot whose own pixels said 171.8 m was drawn "100 m" / "apex 6 m",
  // decision `fit`, no "· no GPS". 39 % wrong, and worse than the NEW-1(b)
  // reproduction. Reproduced here on `tests/fixtures/tracerV3FlatTension.ts`
  // before this was written.
  //
  // SO THE RULE IS AN ALLOWLIST, NOT A LIST OF KNOWN-BAD RUNGS. Exactly one
  // carry verdict says the pixels agreed with the GPS — `carry_consistent`.
  // Every other value means the reading was not confirmed: too loose to test
  // (`carry_as_scale`), tested and in 2-4 sigma tension (`carry_tension`), or
  // with no pixel-only companion to test against at all (`carry_untested`). A
  // denylist is what produced three findings at three thresholds (review F1,
  // gate NEW-1, gate GATE-1); an allowlist means a verdict added to
  // `CarryStatus` later is unverified until someone deliberately says otherwise.
  // `carry_inconsistent` never reaches here as a GPS-backed label — it becomes
  // `pixel_only_fallback` above — but it is covered by the same rule anyway,
  // because it can arrive on the implausible-flight refit AFTER that decision.
  //
  // WHAT THE HONEST SIGMA IS. The widest of four things the number rides on:
  //   1. the fit's own `sigmaTotal.carryM`;
  //   2. the GPS distance's own sigma_D;
  //   3. the pixel-only carry sigma — >= 15 % of the carry by construction under
  //      `carry_as_scale`, and 34-69 % on 8-10 frame tracks;
  //   4. THE DISAGREEMENT ITSELF: how far the GPS dragged the drawn carry away
  //      from the pixel-only companion's own answer.
  // (4) is the term GATE-1 forces and it is not an extra rule, it is the same
  // disease at the label that NEW-1(a) fixed at the verdict: sizing a label from
  // a sigma that the evidence has already contradicted. Under tension the fit's
  // own sigma was 12.7 m while the error was 65 m, and on a 43 m pitch the gate
  // measured a 13 m error against a claimed 6.5 m sigma — terms 1-3 miss both,
  // because a short shot's 15 % is only a few metres. Two estimates that
  // disagree by X bound the error of whichever one is wrong at X, and nothing in
  // this pipeline knows which.
  //
  // Then, unchanged from NEW-1(b): when that sigma exceeds the coarsest step
  // `labelStepM` can offer, no rounding describes the error and the distance is
  // dropped the way F4 drops it; when it does not, the step simply widens and
  // the number survives. That is why this is a rule and not a special case.
  const carryVerdict =
    usedFit.carryStatus !== 'carry_consistent'
      ? usedFit.carryStatus
      : fit.carryStatus !== 'carry_consistent'
        ? fit.carryStatus
        : 'carry_consistent';
  // `fit` as well as `usedFit`, because the implausible-flight refit can replace
  // the drawn fit AFTER the carry decision was taken, and the primary rung's
  // opinion of the GPS is a statement about the DATA (REVIEW F1(b)).
  const gpsUnverified = gpsBackedLabel && carryVerdict !== 'carry_consistent';
  const pxCompanion = usedFit.pixelOnly ?? fit.pixelOnly;
  const pxCarrySigmaM = pxCompanion?.summarySigma.carryM;
  const pxCarryM = pxCompanion?.summary.carryM;
  const unverifiedSigmaM = gpsUnverified
    ? Math.max(
        usedFit.sigmaTotal.carryM,
        usedFit.carrySigmaM ?? 0,
        // A missing companion sigma is not a small one: it is unknown, and the
        // whole finding is that an unusable sigma must never read as agreement.
        // Same for a missing companion carry — with nothing to disagree with,
        // there is no bound on the disagreement.
        pxCarrySigmaM != null && Number.isFinite(pxCarrySigmaM)
          ? pxCarrySigmaM
          : Number.POSITIVE_INFINITY,
        pxCarryM != null && Number.isFinite(pxCarryM)
          ? Math.abs(usedFit.summary.carryM - pxCarryM)
          : Number.POSITIVE_INFINITY
      )
    : null;
  const gpsUncheckedNoDistance =
    unverifiedSigmaM !== null && !(unverifiedSigmaM <= COARSEST_LABEL_STEP_M);

  // ── FG-1: "too uncertain to state" as a rung of its own.
  //
  // THE FINDING. Everything above decides whether the GPS distance may be
  // BELIEVED. Nothing decided whether the number may be STATED. `roundLabelM`
  // widens the step to 1 / 5 / 10 m from the fit's own sigma and then stops,
  // because `COARSEST_LABEL_STEP_M` is the coarsest step the vocabulary has — so
  // past about 10 m of sigma the pill stops describing its own uncertainty and
  // starts reading like a measurement. The gate measured the consequence over
  // 58 500 clips: 1 719 of 39 086 drawn numbers more than 25 % from truth, worst
  // +194 % — a 62 m shot drawn "180 m" — and the worst rows have NO GPS in them,
  // so three rounds of carry-verdict fixes could never have reached it.
  //
  // The same argument F4 and NEW-1(b) already make, generalised: when no step in
  // the vocabulary describes the error, the honest pill has no number on it. The
  // difference is only that those two knew WHY the sigma was untrustworthy and
  // this one does not have to.
  //
  // THE SAME PATH, NOT A PARALLEL ONE. This feeds `buildLabel`'s `noDistance`
  // argument, which is what `carry_as_scale` / `carry_tension` / `axis_degenerate`
  // already use; the arc is unchanged and still drawn.
  //
  // WHICH SIGMA in test (3). `unverifiedSigmaM` when the GPS was used but not
  // confirmed — that is the wider, honest one round 3 built — and otherwise the
  // fit's own `sigmaTotal.carryM`, which already carries the formal, pitch and
  // +-12 % f_px terms. Relative to the carry, because a 12 m sigma means
  // something different on a 40 m pitch and a 240 m drive.
  //
  // WHICH CONDITIONING in test (1): `drawnV0RelSigma` — the fit that is actually
  // DRAWN, and ONLY that fit. Deliberately NOT `axisV0RelSigma`, which folds in
  // the worst rung of the ladder: that term is F4's, and F4 asks a question
  // about the CLIP's geometry, where a rejected rung's ill-conditioning is
  // evidence. This question is about one number's own uncertainty, so a rung
  // nobody drew has nothing to say about it — and using the ladder term made the
  // SAME drawn arc keep its number at gps=60 and lose it at gps=40, purely
  // because a different rung ran. Measured over the sweep, the drawn-only term
  // is also strictly cheaper: it withholds 24.7 % of numbers against 27.9 % and
  // loses 12.4 % of the correct ones against 15.4 %, for the same residual.
  // FG-3's correction is what makes `drawnV0RelSigma` meaningful on the
  // `pixel_only_fallback` path at all — before it, nothing measured that fit.
  const labelSigmaM = unverifiedSigmaM ?? usedFit.sigmaTotal.carryM;
  const drawnCarryM = usedFit.summary.carryM;
  const rms1080 = usedFit.rmsPx / u;
  const uncertainWhy: string[] = [];
  // `v0RelSigma` answers 0 for a fit that reports no formal sigma on v0, which
  // is right for F4 (an unmeasurable rung must not be able to TRIGGER a refusal
  // on its own) and wrong here: for a number about to be stated, "the fit cannot
  // say how well it pinned the speed" is a reason to withhold, not to proceed.
  // So the absence is tested separately rather than folded into the comparison.
  // It did not arise once in 58 500 calls — every drawn fit reported a finite
  // sigma(v0) — so this is a closed door rather than a measured case.
  const drawnV0Sigma = usedFit.sigma.v0;
  if (drawnV0Sigma == null || !Number.isFinite(drawnV0Sigma) || !(usedFit.params.v0 > 1e-6)) {
    uncertainWhy.push('sigma_v0=unknown');
  } else if (!(drawnV0RelSigma < LOOSE_V0_REL_SIGMA)) {
    uncertainWhy.push(`sigma_v0=${(100 * drawnV0RelSigma).toFixed(0)}%>=${Math.round(100 * LOOSE_V0_REL_SIGMA)}%`);
  }
  if (!(rms1080 <= LOOSE_RMS_PX_1080)) {
    uncertainWhy.push(`rms=${rms1080.toFixed(1)}px>${LOOSE_RMS_PX_1080}px@1080`);
  }
  // Every comparison is a NEGATED one, so a NaN withholds rather than states.
  if (!(labelSigmaM <= LOOSE_CARRY_SIGMA_FRAC * drawnCarryM)) {
    uncertainWhy.push(
      `sigma=${Number.isFinite(labelSigmaM) ? labelSigmaM.toFixed(0) : 'unknown'}m>` +
        `${Math.round(100 * LOOSE_CARRY_SIGMA_FRAC)}%_of_${drawnCarryM.toFixed(0)}m`
    );
  }
  const tooUncertain = uncertainWhy.length > 0;
  if (tooUncertain && !gpsUncheckedNoDistance && !axisDegenerate) {
    // Named per TEST, so a field row says which of the three withheld it and a
    // later change to one of them is visible in the data rather than only in the
    // count of numbers that stopped appearing.
    flags.push(`too_uncertain_no_distance(${uncertainWhy.join(',')})`);
  }
  if (gpsUncheckedNoDistance) {
    // Named per verdict, so a field row says WHICH rung withheld the number and
    // nothing filtering on `carry_as_scale_no_distance` — the name this flag had
    // when it covered one rung — silently stops matching the others.
    flags.push(
      `${carryVerdict ?? 'carry_unverified'}_no_distance(honest_sigma=${
        Number.isFinite(unverifiedSigmaM as number) ? Math.round(unverifiedSigmaM as number) : 'unknown'
      }m>${COARSEST_LABEL_STEP_M}m)`
    );
  }

  const { labelText, labelSubText } = buildLabel(
    usedFit,
    gpsBackedLabel,
    knobs.labelRounding,
    axisDegenerate
      ? 'axis_degenerate'
      : gpsUncheckedNoDistance
        ? 'gps_unchecked'
        : tooUncertain
          ? 'too_uncertain'
          : null,
    unverifiedSigmaM ?? undefined
  );
  const built = buildSpec(usedFit, input, knobs, arcEnd, labelText, labelSubText);
  if (built.spec === null) {
    return skip(built.reason ?? 'render_spec:unbuildable', flags, meta, startedAt);
  }

  // The landing pixel the renderer will actually draw is the spec's last
  // sample, converted back out of normalized space. Checking the drawn pixel
  // rather than a parallel calculation is the point of the check.
  const lastSample = built.spec.samples[built.spec.samples.length - 1];
  const landingPx: Px = {
    x: lastSample.x * width - 0.5,
    y: (1 - lastSample.y) * height - 0.5,
  };
  const lc = landingHorizonCheck(usedFit, landingPx, width, built.landingGroundRangeM);
  const u1080 = width / 1080.0;
  meta.landingCheck = {
    horizonRow: lc.horizonRow,
    landingPx: lc.landingPx,
    depressionPx1080: lc.depressionPx1080,
    expectedFlatPx1080: lc.expectedFlatPx1080,
    landingGroundRangeM: lc.landingGroundRangeM,
    expectedRangePx1080: lc.expectedRangePx1080,
    residualVsRangePx1080: lc.residualVsRangePx === null ? null : lc.residualVsRangePx / u1080,
    aboveHorizon: lc.aboveHorizon,
  };
  for (const f of lc.flags) if (!flags.includes(f)) flags.push(f);

  meta.render = {
    sampleCount: built.sampleCount,
    animStartSec: built.spec.animStartSec,
    animDurationSec: built.spec.animDurationSec,
  };
  meta.decision = decision;
  meta.flags = flags;
  meta.elapsedMs = Date.now() - startedAt;
  return { decision, reason: meta.reason, flags, spec: built.spec, meta };
}

/** Fold a fit into the diagnostic blob. Called on the refusal paths too — a
 *  refusal that records WHY the fit was refused is what a field test reads. */
function recordFit(
  meta: TracerV3Meta,
  fit: FitResult,
  carryM: number | null,
  input: TraceClipInput
): void {
  meta.launch = {
    v0: fit.params.v0,
    thetaDeg: fit.params.thetaDeg,
    phiDeg: fit.params.phiDeg,
    rpmBack: fit.params.rpmBack,
    tiltDeg: fit.params.tiltDeg,
    t0Sec: fit.params.t0Sec,
    dPitchDeg: fit.params.dPitchDeg,
  };
  meta.flight = {
    carryM: fit.summary.carryM,
    apexM: fit.summary.apexM,
    hangS: fit.summary.hangS,
    landAngleDeg: fit.summary.landAngleDeg,
    lateralM: fit.summary.lateralM,
  };
  meta.sigmaTotal = { ...fit.sigmaTotal };
  meta.fit = { rmsPx: fit.rmsPx, maxResidPx: fit.maxResidPx, nPoints: fit.nPoints, ok: fit.ok };
  meta.carry = {
    inputM: carryM,
    sigmaGpsM: input.carrySigmaGpsM ?? null,
    status: fit.carryStatus,
    z: fit.carryZ,
    zNoPixelSigma: fit.carryZNoPixelSigma,
    sigmaM: fit.carrySigmaM,
    labelM: Number.isFinite(fit.carryLabelM) ? fit.carryLabelM : null,
    labelStepM: fit.labelStepM,
  };
}

/** Re-export so the batch and the dev screen do not each import tracerFit. */
export { labelStepM, roundLabelM, BALL_RADIUS_M };
