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
  fit?: { rmsPx: number; maxResidPx: number; nPoints: number; ok: boolean };
  carry?: {
    inputM: number | null;
    sigmaGpsM: number | null;
    status: CarryStatus | null;
    z: number | null;
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
}

/**
 * Which detections the fit sees, and where the impact frame is.
 *
 * All detections within the first 15 (30 fps-equivalent) frames after impact;
 * if the track continues THROUGH THE IMAGE APEX all detections are used, because
 * the fit report shows the lob chips only resolve speed against launch angle on
 * the descent. Fewer than 3 in the early window -> the first 3.
 */
export function selectDetections(det: TracerDetectResultV3): Selection {
  const dets = [...(det.detections ?? [])].sort((a, b) => a.frame - b.frame);
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
    const sv0 = f.sigma.v0;
    if (sv0 != null && Number.isFinite(sv0) && f.params.v0 > 1e-6) {
      worstV0RelSigma = Math.max(worstV0RelSigma, sv0 / f.params.v0);
    }
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
  return { fit, variant, log, worstV0RelSigma };
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
   *   `carry_as_scale`   GATE NEW-1(b) — the number's scale came from a GPS
   *                      distance the pixels were too loose to check.
   */
  noDistance: 'axis_degenerate' | 'carry_as_scale' | null = null,
  /**
   * 1-sigma the rounding step is taken from, metres. Defaults to the fit's own
   * `sigmaTotal.carryM`; NEW-1(b) passes a WIDER one when the fit's sigma is
   * not the whole error (a GPS-set scale the pixels could not confirm).
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
  // GATE NEW-1(b). Same remedy, different cause: under `carry_as_scale` the
  // pixel-only carry is too loose to test the GPS distance, so the drawn number
  // rides on a GPS reading nothing in this pipeline has checked. Measured: a
  // 130 m GPS carry on a 251 m shot drew "220 m", and a 5-80 m one drew
  // "170 m".."200 m" before NEW-1(a) sent those to the inconsistency branch.
  // The trace is still drawn; the number is not claimed.
  if (noDistance === 'carry_as_scale') {
    return { labelText: 'no distance', labelSubText: 'GPS unchecked' };
  }
  const sigmaM = labelSigmaM ?? fit.sigmaTotal.carryM;
  const carryM = labelRounding ? roundLabelM(fit.summary.carryM, sigmaM) : Math.round(fit.summary.carryM);
  const apexM = Math.round(fit.summary.apexM);
  return {
    labelText: `${carryM} m`,
    labelSubText: hasGps ? `apex ${apexM} m` : `apex ${apexM} m · no GPS`,
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
      kImpFit: null, impactSlackFrames: 0,
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
  };

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

  // ── Held-out check: does the early fit predict the detections it did NOT
  //    use? IMG_2331's 14-frame early fit was 25 px off the 9 later detections
  //    and drew a 5-degree bullet under a ball that kept climbing.
  if (sel.mode !== 'all' && sel.used.length >= MIN_FIT) {
    const usedFrames = new Set(fit.frames);
    const dropped = new Set(variant.dropFrames);
    const held = (det.detections ?? []).filter(
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
        const all = [...(det.detections ?? [])].sort((a, b) => a.frame - b.frame);
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
            meta.selection = {
              mode: 'all_holdout',
              k: all.length,
              throughApex: sel2.throughApex,
              climbPx: sel2.climbPx,
              frameRange: sel2.frameRange,
              kImpFit: sel2.kImpFit,
              impactSlackFrames: sel2.impactSlackFrames,
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
    const pixelOnly = fit.pixelOnly;
    if (pixelOnly && worse) {
      // The optimiser, not the data: the joint fit found a worse pixel minimum
      // than its own pixel-only companion. Render the companion.
      flags.push(
        `joint_fit_rejected:worse_pixel_minimum(chi2_px ${fit.chi2Px.toFixed(1)} vs ${pixelOnly.chi2Px.toFixed(1)})`
      );
      usedFit = pixelOnly;
    } else if (inconsistent.length) {
      // The DATA: the GPS distance and the pixels cannot both be right, so drop
      // the GPS rather than bend the arc to it.
      decision = 'pixel_only_fallback';
      flags.push('inconsistent');
      usedFit = pixelOnly ?? fit;
      meta.reason = inconsistent[0];
    } else if (fit.flags.some((f) => f.startsWith('carry_tension'))) {
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
  const axisDegenerate =
    Math.abs(usedFit.params.phiDeg) < AXIS_DEGENERATE_PHI_DEG &&
    worstV0RelSigma >= AXIS_DEGENERATE_V0_REL_SIGMA;
  if (axisDegenerate) {
    flags.push(
      `axis_degenerate(phi=${usedFit.params.phiDeg.toFixed(2)}deg,` +
        `worst_sigma_v0=${(100 * worstV0RelSigma).toFixed(0)}%_of_v0)`
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

  // ── GATE NEW-1(b): a GPS-set scale the pixels could not check.
  //
  // `carry_as_scale` was pushed as a flag here and otherwise ignored, so the
  // pill read exactly like a measured distance — same rounding step, and no
  // "· no GPS", because the GPS genuinely WAS used. But the verdict's own
  // definition is that NO consistency claim is made: the pixel-only carry is
  // looser than 15 % of itself, so nothing in this pipeline has tested the GPS
  // reading, and the GPS reading's real failure modes (the golfer laid up, the
  // successor fix landed on the cart path, the phone was in the bag) are in no
  // sigma the fit computes. NEW-1(a) now catches the ones the geometry can
  // reject outright; what is left is the ones it cannot.
  //
  // So the label's sigma is the WIDEST of the three things the number rides on:
  // the fit's own total, the GPS distance's own sigma_D, and — the term that
  // decides it — the pixel-only carry sigma, which under this verdict is >= 15 %
  // of the carry by construction and was 34-69 % on 8-10 frame tracks. When that
  // exceeds the coarsest step `labelStepM` can offer, no rounding describes the
  // error and the distance is dropped the way F4 drops it; when it does not (a
  // genuinely short shot, where 15 % is a few metres) the step simply widens.
  const carryAsScale =
    carryM !== null &&
    decision !== 'pixel_only_fallback' &&
    (usedFit.carryStatus === 'carry_as_scale' || flags.includes('carry_as_scale'));
  const pxCarrySigmaM = (usedFit.pixelOnly ?? fit.pixelOnly)?.summarySigma.carryM;
  const asScaleSigmaM = carryAsScale
    ? Math.max(
        usedFit.sigmaTotal.carryM,
        usedFit.carrySigmaM ?? 0,
        // A missing companion sigma is not a small one: it is unknown, and the
        // whole finding is that an unusable sigma must never read as agreement.
        pxCarrySigmaM != null && Number.isFinite(pxCarrySigmaM)
          ? pxCarrySigmaM
          : Number.POSITIVE_INFINITY
      )
    : null;
  const asScaleNoDistance = asScaleSigmaM !== null && !(asScaleSigmaM <= COARSEST_LABEL_STEP_M);
  if (asScaleNoDistance) {
    flags.push(
      `carry_as_scale_no_distance(honest_sigma=${
        Number.isFinite(asScaleSigmaM as number) ? Math.round(asScaleSigmaM as number) : 'unknown'
      }m>${COARSEST_LABEL_STEP_M}m)`
    );
  }

  const { labelText, labelSubText } = buildLabel(
    usedFit,
    gpsBackedLabel,
    knobs.labelRounding,
    axisDegenerate ? 'axis_degenerate' : asScaleNoDistance ? 'carry_as_scale' : null,
    asScaleSigmaM ?? undefined
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
    sigmaM: fit.carrySigmaM,
    labelM: Number.isFinite(fit.carryLabelM) ? fit.carryLabelM : null,
    labelStepM: fit.labelStepM,
  };
}

/** Re-export so the batch and the dev screen do not each import tracerFit. */
export { labelStepM, roundLabelM, BALL_RADIUS_M };
