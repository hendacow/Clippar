/**
 * Shot-tracer geometry + arc synthesis. Pure TypeScript — no native imports
 * (the BallLaunchResult / TracerRenderSpec imports below are type-only and
 * erased at compile time), so every function here is unit-testable.
 *
 * Coordinate convention everywhere: normalized 0..1, display-oriented,
 * BOTTOM-LEFT origin (Vision convention; matches detectBallLaunch output and
 * what renderTracerOnClip's animation tool consumes).
 *
 * The arc is fully synthesized here and handed to Swift as final normalized
 * control points — Swift does zero golf math.
 */
import { config } from '../constants/config';
import type { BallLaunchResult, TracerRenderSpec } from '../modules/shot-detector';

const EARTH_RADIUS_M = 6371000;
const DEG = Math.PI / 180;

/**
 * Skip reasons persisted into tracer_meta.reason. The first three are
 * pairing-level (decided by the batch loop before geometry runs); the rest
 * come out of precheckArcGeometry / buildArcSpec.
 */
export type TracerSkipReason =
  | 'putt'
  | 'no-impact'
  | 'no-next-gps'
  | 'gps-accuracy'
  | 'carry-min'
  | 'carry-max'
  | 'bearing-delta'
  | 'anim-too-short'
  | 'no-heading'
  | 'grounded';

/** Diagnostic blob persisted as JSON into local_clips.tracer_meta. */
export interface TracerMeta {
  reason?: TracerSkipReason;
  method?: 'vision' | 'none';
  carryM?: number;
  bearingDeg?: number;
  /** GPS-vs-heading bearing delta; null when heading was unusable (F3 —
   *  never silently substituted with 0). */
  deltaDeg?: number | null;
  confidence?: number;
  headingUsable?: boolean;
  /** carryM < 40 m — endpoints are GPS-noise-dominated, arc is best-guess. */
  lowCarryConfidence?: boolean;
  /** F8b: detected horizontal drift contradicted sign(deltaDeg); the
   *  DETECTED direction won the lateral placement. */
  directionConflict?: boolean;
  /** 'no-next-gps' skip where the CLIP'S OWN fix was the missing one —
   *  disambiguates from a missing landing fix for diagnostics. */
  missingOwnGps?: boolean;
  lateralSource?: 'heading' | 'vision';
  horizonY?: number;
  bucket?: 'drive' | 'iron' | 'wedge';
  apexM?: number;
  hangS?: number;
}

// ─── Spherical geometry ───

/** Great-circle distance in meters between two WGS84 fixes. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dPhi = (lat2 - lat1) * DEG;
  const dLam = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing from fix 1 to fix 2, degrees clockwise from true north. */
export function initialBearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dLam = (lon2 - lon1) * DEG;
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * Signed bearing delta in (-180, 180]: positive = the landing bearing is to
 * the RIGHT of the camera's optical axis.
 */
export function bearingDeltaDeg(bearingDeg: number, headingDeg: number): number {
  return ((bearingDeg - headingDeg + 540) % 360) - 180;
}

// ─── Camera / projection ───

/**
 * Convert the back camera's LANDSCAPE (long-axis) horizontal FOV — what
 * AVCaptureDevice.videoFieldOfView reports for the 1920x1080 format — to the
 * portrait horizontal FOV (~36-40 deg). Using the landscape value directly
 * compresses lateral endpoints by ~40%. In portrait the long axis is
 * vertical, so the portrait VERTICAL FOV is the landscape value itself.
 */
export function portraitHFovDeg(hFovLandscapeDeg: number): number {
  return (
    (2 * Math.atan((1080 / 1920) * Math.tan((hFovLandscapeDeg * DEG) / 2))) / DEG
  );
}

/**
 * Per-clip horizon line from the captured camera pitch (F2). A camera tilted
 * DOWN by pitchDownDeg sees the horizon ABOVE frame center by
 * tan(pitch)/(2*tan(vFov/2)) in normalized (bottom-left, y-up) units.
 * Clamped to [0.30, 0.75]; null pitch (old clips / CoreMotion timeout) falls
 * back to the level-camera constant config.tracer.horizonY.
 */
export function computeHorizonY(
  pitchDownDeg: number | null,
  vFovPortraitDeg: number,
  fallbackHorizonY: number = config.tracer.horizonY
): number {
  if (pitchDownDeg === null || !Number.isFinite(pitchDownDeg)) {
    return fallbackHorizonY;
  }
  const halfV = Math.tan((vFovPortraitDeg * DEG) / 2);
  if (!(halfV > 0)) return fallbackHorizonY;
  const y = 0.5 + Math.tan(pitchDownDeg * DEG) / (2 * halfV);
  return clamp(y, 0.3, 0.75);
}

/**
 * Pinhole-project the GPS landing point into the normalized portrait frame.
 *
 * GATE vs CLAMP pairing (F6): config.tracer.maxBearingDeltaDeg (60) is the
 * "camera plainly isn't facing the shot" GATE — beyond it the clip is
 * skipped entirely. WITHIN that gate, x is clamped to the deliberately wide
 * [-0.30, 1.30] band so slices and pushes exit the frame naturally instead
 * of bending back to a fake in-frame landing — that off-screen exit is what
 * real broadcast tracers look like.
 *
 * yLand sits tan(atan2(tripodHeight, carry)) below the horizon — for a
 * 150 m carry that is ~0.007, i.e. the arc terminates essentially AT the
 * horizon by construction.
 */
export function projectLanding(args: {
  deltaDeg: number;
  carryM: number;
  horizonY: number;
  hFovPortraitDeg: number;
  vFovPortraitDeg: number;
  tripodHeightM?: number;
}): { x: number; y: number } {
  const tripodHeightM = args.tripodHeightM ?? config.tracer.tripodHeightM;
  const halfW = Math.tan((args.hFovPortraitDeg * DEG) / 2);
  const halfH = Math.tan((args.vFovPortraitDeg * DEG) / 2);
  const x = clamp(0.5 + Math.tan(args.deltaDeg * DEG) / (2 * halfW), -0.3, 1.3);
  const y =
    args.horizonY -
    Math.tan(Math.atan2(tripodHeightM, Math.max(args.carryM, 20))) / (2 * halfH);
  return { x, y };
}

// ─── Shot buckets / flight priors (Trackman-derived) ───

export type ShotBucket = 'drive' | 'iron' | 'wedge';

/** (launchDeg, kApex, apexLoM, apexHiM) per bucket. */
export const TRACER_PRIORS: Record<
  ShotBucket,
  { launchDeg: number; kApex: number; apexLoM: number; apexHiM: number }
> = {
  drive: { launchDeg: 12, kApex: 0.13, apexLoM: 15, apexHiM: 32 },
  iron: { launchDeg: 18, kApex: 0.16, apexLoM: 12, apexHiM: 30 },
  wedge: { launchDeg: 26, kApex: 0.22, apexLoM: 8, apexHiM: 25 },
};

export function bucketForCarry(carryM: number): ShotBucket {
  if (carryM > 180) return 'drive';
  if (carryM >= 80) return 'iron';
  return 'wedge';
}

export function apexHeightM(carryM: number): number {
  const p = TRACER_PRIORS[bucketForCarry(carryM)];
  return clamp(p.kApex * carryM, p.apexLoM, p.apexHiM);
}

/** Hang time prior — calibrates to Tour numbers (29 m apex -> 6.2 s). */
export function hangTimeSec(apexM: number): number {
  return clamp(1.15 * Math.sqrt(Math.max(apexM, 0)), 2.5, 6.5);
}

// ─── Gate ladder ───

export interface TracerGeometryInput {
  /** Shot N — the clip being traced (camera stands at the ball). */
  latN: number;
  lonN: number;
  /** Shot N+1 — the IMMEDIATE same-hole successor (= landing spot). */
  latN1: number;
  lonN1: number;
  gpsAccuracyMN: number | null;
  gpsAccuracyMN1: number | null;
  cameraHeadingDeg: number | null;
  /** iOS compass calibration 0-3; < 1 means the heading is unusable. */
  cameraHeadingCalibration: number | null;
  cameraPitchDownDeg: number | null;
  /** Measured via getCameraFovDeg(), or config.tracer.cameraHFovLandscapeDeg. */
  hFovLandscapeDeg: number;
  /** Duration of the TRIMMED file (what the tracer is rendered onto). */
  clipDurationSec: number;
  /** Impact on the ORIGINAL file's timeline (impact_time_ms column). */
  impactTimeMs: number;
  /** auto_trim_start_ms column (original-timeline trim start), null if none. */
  autoTrimStartMs: number | null;
}

export type TracerSkip = { skip: TracerSkipReason; meta: TracerMeta };

export interface TracerGeometry {
  ok: true;
  carryM: number;
  bearingDeg: number;
  /** null when heading is unusable — F3: NEVER silently substituted with 0. */
  deltaDeg: number | null;
  headingUsable: boolean;
  /**
   * F3: heading missing/uncalibrated. The clip may still render, but ONLY
   * when ball detection comes back method='vision' (real launch-direction
   * evidence) — buildArcSpec enforces this; the batch loop can also use it
   * to decide nothing (detection runs anyway for anchor/veto).
   */
  requiresVision: boolean;
  lowCarryConfidence: boolean;
  horizonY: number;
  hFovPortraitDeg: number;
  vFovPortraitDeg: number;
  animStartSec: number;
  /** Largest animDurationSec the clip can host (duration - start - 0.3). */
  maxAnimSec: number;
}

export function isTracerSkip<T extends object>(r: T | TracerSkip): r is TracerSkip {
  return 'skip' in r;
}

/**
 * Pure-geometry gate ladder — everything that can be decided WITHOUT the
 * Vision pass. The batch loop MUST run this before detectBallLaunch (F5) so
 * a clip that will skip anyway never pays for a full-resolution trajectory
 * analysis. buildArcSpec re-runs it internally (idempotent).
 */
export function precheckArcGeometry(
  input: TracerGeometryInput
): TracerGeometry | TracerSkip {
  const { tracer } = config;
  const meta: TracerMeta = {};

  // F4: a fix worse than 20 m can place the "landing" a full club off —
  // refuse the pairing outright rather than render a confident lie.
  if (
    (input.gpsAccuracyMN !== null && input.gpsAccuracyMN > 20) ||
    (input.gpsAccuracyMN1 !== null && input.gpsAccuracyMN1 > 20)
  ) {
    return { skip: 'gps-accuracy', meta };
  }

  const carryM = haversineMeters(input.latN, input.lonN, input.latN1, input.lonN1);
  meta.carryM = round2(carryM);

  // F4 dynamic carry floor: the carry must clear the combined GPS error
  // budget of both fixes (unknown accuracy assumed 10 m), never below 25 m.
  const minCarryM = Math.max(
    25,
    2 * ((input.gpsAccuracyMN ?? 10) + (input.gpsAccuracyMN1 ?? 10))
  );
  if (carryM < minCarryM) return { skip: 'carry-min', meta };
  if (carryM > tracer.maxCarryM) return { skip: 'carry-max', meta };
  const lowCarryConfidence = carryM < 40;
  if (lowCarryConfidence) meta.lowCarryConfidence = true;

  const bearingDeg = initialBearingDeg(input.latN, input.lonN, input.latN1, input.lonN1);
  meta.bearingDeg = round2(bearingDeg);

  // F3 heading gate, part 1: a usable heading needs a value AND calibration
  // >= 1. When unusable we DON'T default deltaDeg to 0 — the clip survives
  // only if detection later proves the launch direction (method='vision').
  const headingUsable =
    input.cameraHeadingDeg !== null && (input.cameraHeadingCalibration ?? 0) >= 1;
  meta.headingUsable = headingUsable;
  let deltaDeg: number | null = null;
  if (headingUsable) {
    deltaDeg = bearingDeltaDeg(bearingDeg, input.cameraHeadingDeg!);
    meta.deltaDeg = round2(deltaDeg);
    if (Math.abs(deltaDeg) > tracer.maxBearingDeltaDeg) {
      return { skip: 'bearing-delta', meta };
    }
  } else {
    meta.deltaDeg = null;
  }

  // Anim-time precheck (exact: hangS >= 2.5 > minAnimSec, so the final
  // T = min(hangS, maxAnimSec) is short only when maxAnimSec is).
  const impactInClipMs = input.impactTimeMs - (input.autoTrimStartMs ?? 0);
  if (impactInClipMs < 0) return { skip: 'anim-too-short', meta };
  const animStartSec = impactInClipMs / 1000 + tracer.headDelaySec;
  const maxAnimSec = input.clipDurationSec - animStartSec - 0.3;
  if (maxAnimSec < tracer.minAnimSec) return { skip: 'anim-too-short', meta };

  const hFovPortrait = portraitHFovDeg(input.hFovLandscapeDeg);
  const vFovPortrait = input.hFovLandscapeDeg; // long axis is vertical in portrait
  const horizonY = computeHorizonY(input.cameraPitchDownDeg, vFovPortrait);
  meta.horizonY = round2(horizonY);

  return {
    ok: true,
    carryM,
    bearingDeg,
    deltaDeg,
    headingUsable,
    requiresVision: !headingUsable,
    lowCarryConfidence,
    horizonY,
    hFovPortraitDeg: hFovPortrait,
    vFovPortraitDeg: vFovPortrait,
    animStartSec,
    maxAnimSec,
  };
}

// ─── Arc synthesis ───

/** Detection fields buildArcSpec actually consumes (subset of BallLaunchResult). */
export type BallLaunchDetection = Pick<
  BallLaunchResult,
  | 'found'
  | 'method'
  | 'launchPoint'
  | 'direction'
  | 'groundedEvidence'
  | 'poseAnchor'
  | 'confidence'
>;

export type TracerArcInput = TracerGeometryInput & {
  /** Pre-computed detectBallLaunch result. Optional — geometry-only callers
   *  (and heading-usable clips on older native builds) pass null. */
  detection?: BallLaunchDetection | null;
};

export type TracerArcResult = { spec: TracerRenderSpec; meta: TracerMeta };

/**
 * Full gate ladder + control-point/timing synthesis. Returns either a
 * ready-to-render TracerRenderSpec (with diagnostics for tracer_meta) or a
 * skip with its reason.
 *
 * Ladder order: geometry gates (precheckArcGeometry — F4 carry/accuracy,
 * bearing gate, anim window), then detection-dependent gates: F8a grounded
 * veto, F3 no-heading (vision-or-skip), F8b direction conflict.
 */
export function buildArcSpec(input: TracerArcInput): TracerArcResult | TracerSkip {
  const { tracer } = config;
  const geom = precheckArcGeometry(input);
  if (isTracerSkip(geom)) return geom;

  const det = input.detection ?? null;
  const meta: TracerMeta = {
    method: det?.method ?? 'none',
    carryM: round2(geom.carryM),
    bearingDeg: round2(geom.bearingDeg),
    deltaDeg: geom.deltaDeg === null ? null : round2(geom.deltaDeg),
    headingUsable: geom.headingUsable,
    horizonY: round2(geom.horizonY),
  };
  if (det && det.confidence > 0) meta.confidence = round2(det.confidence);
  if (geom.lowCarryConfidence) meta.lowCarryConfidence = true;

  // F8a — detection as VETO: a blob was observed in the launch ROI but never
  // gained altitude (grounded/topped roll). Never synthesize a flying arc
  // over a rolling ball.
  if (det?.groundedEvidence) return { skip: 'grounded', meta };

  const visionOk = !!det && det.found && det.method === 'vision';
  const detDirection =
    visionOk && det!.direction && Number.isFinite(det!.direction.dx)
      ? det!.direction
      : null;

  // F3 — no usable heading: render ONLY on real launch-direction evidence
  // (vision trajectory with a non-degenerate, upward direction).
  if (!geom.headingUsable && (!visionOk || !detDirection || detDirection.dy <= 0)) {
    return { skip: 'no-heading', meta };
  }

  // Launch anchor P0: detected ball > pose ankles > frame-bottom default.
  const p0 =
    visionOk && det!.launchPoint
      ? { x: det!.launchPoint.x, y: det!.launchPoint.y }
      : det?.poseAnchor
        ? { x: det.poseAnchor.x, y: det.poseAnchor.y }
        : { x: 0.5, y: 0.18 };

  const halfH = Math.tan((geom.vFovPortraitDeg * DEG) / 2);
  const bucket = bucketForCarry(geom.carryM);
  const apexM = apexHeightM(geom.carryM);
  const hangS = hangTimeSec(apexM);
  meta.bucket = bucket;
  meta.apexM = round2(apexM);
  meta.hangS = round2(hangS);

  // Apex must clear the launch point or the two-Bezier construction folds
  // over itself (e.g. high pose anchor + clamped horizon).
  const yApexRaw =
    geom.horizonY +
    Math.tan(
      Math.atan2(apexM - tracer.tripodHeightM, 0.6 * Math.max(geom.carryM, 20))
    ) /
      (2 * halfH);
  const yApex = Math.max(yApexRaw, p0.y + 0.05);

  // Lateral placement.
  let effDeltaDeg: number | null = geom.deltaDeg;
  let xLand: number;
  let lateralSource: 'heading' | 'vision' = 'heading';
  if (geom.headingUsable) {
    // F8b — if the detected horizontal drift contradicts sign(deltaDeg),
    // trust the camera's own pixels: keep the GPS delta MAGNITUDE but flip
    // to the DETECTED sign.
    if (
      detDirection &&
      Math.abs(detDirection.dx) > 0.1 &&
      geom.deltaDeg !== null &&
      Math.abs(geom.deltaDeg) > 2 &&
      Math.sign(detDirection.dx) !== Math.sign(geom.deltaDeg)
    ) {
      meta.directionConflict = true;
      lateralSource = 'vision';
      effDeltaDeg = Math.abs(geom.deltaDeg) * Math.sign(detDirection.dx);
    }
    xLand = projectLanding({
      deltaDeg: effDeltaDeg!,
      carryM: geom.carryM,
      horizonY: geom.horizonY,
      hFovPortraitDeg: geom.hFovPortraitDeg,
      vFovPortraitDeg: geom.vFovPortraitDeg,
    }).x;
  } else {
    // No heading (F3, vision-verified path): there is no bearing delta to
    // project, so place xLand where the DETECTED launch ray points. Inverts
    // the prior-tangent construction below (u ∝ (0.6·(xApex−P0.x),
    // 1.4·(yApex−P0.y)), xApex = P0.x + 0.6·(xLand−P0.x), bow = 0):
    // xLand = P0.x + slope · (1.4 / 0.36) · (yApex − P0.y).
    lateralSource = 'vision';
    effDeltaDeg = null;
    const slope = detDirection!.dx / Math.max(detDirection!.dy, 0.15);
    xLand = clamp(p0.x + slope * (1.4 / 0.36) * (yApex - p0.y), -0.3, 1.3);
  }
  meta.lateralSource = lateralSource;

  // Bow gives the fade/draw look — it curves OPPOSITE the lateral
  // displacement. Without a bearing delta (vision-lateral path) the ray
  // already encodes the shape, so bow stays 0.
  const bow =
    effDeltaDeg === null || Math.abs(effDeltaDeg) < 2
      ? 0
      : -Math.sign(effDeltaDeg) * clamp(Math.abs(effDeltaDeg) * 0.004, 0, 0.06);

  const xApex = p0.x + 0.6 * (xLand - p0.x) + bow;

  // Launch tangent: detected unit direction when it points upward, else the
  // prior derived from the apex placement.
  let u: { dx: number; dy: number };
  if (detDirection && detDirection.dy > 0) {
    u = normalize(detDirection.dx, detDirection.dy);
  } else {
    u = normalize((xApex - p0.x) * 0.6, Math.max(yApex - p0.y, 0.05) * 1.4);
  }

  // Two quadratic Beziers joined at the apex with HORIZONTAL tangents on
  // both sides — guarantees the apex is the true max and C1 continuity.
  // C1 = launch ray ∩ apex line (clamped between P0.x and xApex);
  // C2 placed past the apex for the steeper descent (real descent angle is
  // 1.5-2x the launch angle).
  const c1x = clamp(
    p0.x + (u.dx / Math.max(u.dy, 0.15)) * (yApex - p0.y),
    Math.min(p0.x, xApex),
    Math.max(p0.x, xApex)
  );
  const c2x = xApex + 0.45 * (xLand - xApex);
  const yLand =
    geom.horizonY -
    Math.tan(Math.atan2(tracer.tripodHeightM, Math.max(geom.carryM, 20))) /
      (2 * halfH);

  // Timing: draw-on starts just after impact; T capped by the post-impact
  // window (precheck guarantees T >= minAnimSec, re-asserted defensively).
  const animDurationSec = Math.min(hangS, geom.maxAnimSec);
  if (animDurationSec < tracer.minAnimSec) return { skip: 'anim-too-short', meta };

  const spec: TracerRenderSpec = {
    p0,
    c1: { x: c1x, y: yApex },
    a: { x: xApex, y: yApex },
    c2: { x: c2x, y: yApex },
    p3: { x: xLand, y: yLand },
    animStartSec: geom.animStartSec,
    animDurationSec,
    color: tracer.color,
    coreColor: tracer.coreColor,
    lineWidthPx: tracer.lineWidthPx,
    midWidthPx: tracer.midWidthPx,
    glowWidthPx: tracer.glowWidthPx,
    cometHead: tracer.cometHead,
  };
  return { spec, meta };
}

// ─── Helpers ───

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function normalize(dx: number, dy: number): { dx: number; dy: number } {
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return { dx: 0, dy: 1 };
  return { dx: dx / len, dy: dy / len };
}

// ─── __DEV__ self-check (no jest in repo) ───
// Worked vector from the design's geometrySpec: shot N (37, -122), shot N+1
// (37.0013270, -122.0002930), camera heading 5.0° true, landscape FOV 66°
// -> carry ≈ 149.8 m, bearing ≈ 350.0°, delta ≈ -15.0°, portrait hFOV ≈
// 40.14°, xLand ≈ 0.132 (143 px at 1080 wide; the wide F6 clamp is not hit).
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  const carry = haversineMeters(37, -122, 37.001327, -122.000293);
  const bearing = initialBearingDeg(37, -122, 37.001327, -122.000293);
  const delta = bearingDeltaDeg(bearing, 5.0);
  const hFovP = portraitHFovDeg(66);
  const xLand = projectLanding({
    deltaDeg: delta,
    carryM: carry,
    horizonY: 0.52,
    hFovPortraitDeg: hFovP,
    vFovPortraitDeg: 66,
  }).x;
  const checks: Array<[string, number, number, number]> = [
    ['carryM', carry, 149.8, 0.5],
    ['bearingDeg', bearing, 350.0, 0.3],
    ['deltaDeg', delta, -15.0, 0.3],
    ['hFovPortraitDeg', hFovP, 40.14, 0.05],
    ['xLand', xLand, 0.132, 0.005],
  ];
  for (const [name, actual, expected, tol] of checks) {
    if (!(Math.abs(actual - expected) <= tol)) {
      console.warn(
        `[tracerMath] self-check FAILED: ${name} = ${actual} (expected ${expected} ± ${tol})`
      );
    }
  }
}
