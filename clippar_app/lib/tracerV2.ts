/**
 * tracerV2.ts — GPS-backbone carry tiers (S6) + closed-form two-segment arc
 * (S7). Pure TypeScript, no native imports, fully unit-testable. See
 * TRACER_V2_PLAN.md §Pillar 1 / §Pillar 4 and amendments A2/A3/A4.
 *
 * Coordinate convention (matches tracerMath.ts / detectBallLaunch): normalized
 * 0..1, display-oriented, BOTTOM-LEFT origin, y-up. The arc rises (y increases)
 * to the apex then descends (y decreases) to the GPS-projected landing.
 *
 * Geometry primitives (haversine / bearing / delta) are IMPORTED from
 * tracerMath.ts — never forked.
 */
import { config } from '../constants/config';
import {
  haversineMeters,
  initialBearingDeg,
  bearingDeltaDeg,
  bucketForCarry,
  apexHeightM,
  hangTimeSec,
  projectLanding,
  TRACER_PRIORS,
  type ShotBucket,
} from './tracerMath';

// ────────────────────────────────────────────────────────────────────────
// Shared small helpers (clamp/lerp not exported from tracerMath)
// ────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ════════════════════════════════════════════════════════════════════════
// S6 — computeShotCarry: GPS carry, bearing, σ_d, tier, label
// ════════════════════════════════════════════════════════════════════════

/** One accuracy-weighted per-shot fix from the GPS estimator (lib/gpsSession). */
export interface ShotFix {
  lat: number;
  lon: number;
  /** Effective accuracy in meters (estimator output, already safety-scaled). */
  effAccM: number;
}

/**
 * Calibration / pairing context for the carry (4th arg of computeShotCarry).
 * `headingCalibration` gates the bearing delta; the rest drive the A3 label
 * chain-break defenses.
 */
export interface CarryCalib {
  /** iOS compass calibration 0-3; < 1 (or null) → heading unusable → deltaDeg null. */
  headingCalibration: number | null;
  /** A3 plausibility gate: the clip's classified shot bucket, if known. */
  shotType?: ShotBucket | null;
  /** A3: seconds between this clip and its pairing successor; > 8 min caps Tier2. */
  interClipGapSec?: number | null;
  /** A3: the 3-click penalty gesture (or any pairing break) severed the chain
   *  to the "next" fix — the landing is not this shot's, so force Tier3. */
  brokenChain?: boolean;
}

export type CarryTier = 1 | 2 | 3;

export interface ShotCarry {
  carryM: number;
  bearingDeg: number;
  /** GPS-vs-heading delta; null when heading unusable (never silently 0). */
  deltaDeg: number | null;
  /** Honest 1σ distance error: GPS σ folded with the A2 bag-offset variance. */
  sigmaD: number;
  tier: CarryTier;
  /** Tier1 → "142m", Tier2 → "~140m", Tier3 → null. */
  labelText: string | null;
  /** Why the tier was capped/forced (A3 / bounds), for tracer_meta. */
  tierReason: string | null;
}

/** Shot-type plausibility ceilings (A3) — beyond these the pairing is wrong. */
const A3_MAX_CARRY_M: Record<ShotBucket, number> = {
  wedge: 120,
  iron: 220,
  drive: 350,
};
const A3_GAP_MAX_SEC = 8 * 60;

/**
 * Compute carry distance, bearing, bearing-delta, distance uncertainty, and
 * the tiered label from two per-shot GPS fixes.
 *
 * Tier rules (plan §Pillar 1), with the A2 bag-offset folded into the REPORTED
 * σ_d. To keep the Tier-1 effAcc≤5 boundary self-consistent (both endpoints
 * ≤5 ⟹ pure GPS σ ≤5), the Tier-1 σ check uses the pure GPS σ (as the plan's
 * literal `σ_d=√((a²+b²)/2)` states); the Tier-2 relative-σ check uses the
 * A2-folded σ_d (the honest error over carry, where the bag offset matters).
 *
 * A3 chain-break defenses are applied AFTER the raw tier: shot-type/distance
 * implausibility or a broken chain force Tier3; an inter-clip gap > 8 min caps
 * at Tier2.
 */
export function computeShotCarry(
  fixA: ShotFix,
  fixB: ShotFix,
  headingDeg: number | null,
  calib: CarryCalib,
): ShotCarry {
  const g = config.tracer.gps;

  const carryM = haversineMeters(fixA.lat, fixA.lon, fixB.lat, fixB.lon);
  const bearingDeg = initialBearingDeg(fixA.lat, fixA.lon, fixB.lat, fixB.lon);

  const headingUsable =
    headingDeg !== null &&
    Number.isFinite(headingDeg) &&
    calib.headingCalibration !== null &&
    (calib.headingCalibration ?? 0) >= 1;
  const deltaDeg = headingUsable ? bearingDeltaDeg(bearingDeg, headingDeg!) : null;

  // Pure GPS σ (plan Tier-1 literal) and A2-folded honest σ_d (bag offset as an
  // independent variance, added in quadrature).
  const a = Math.max(fixA.effAccM, 0);
  const b = Math.max(fixB.effAccM, 0);
  const sigmaGps = Math.sqrt((a * a + b * b) / 2);
  const sigmaD = Math.sqrt(sigmaGps * sigmaGps + g.filmSpotOffsetVarM ** 2);

  // ── Raw tier from accuracy + geometry ──
  let tier: CarryTier;
  let tierReason: string | null = null;
  const effAccOk1 = a <= g.tier1EffAccM && b <= g.tier1EffAccM;
  const effAccOk2 = a <= g.tier2EffAccM && b <= g.tier2EffAccM;
  const carryInTier1Range = carryM >= 20 && carryM <= 350;
  const relSigma = carryM > 0 ? sigmaD / carryM : Infinity;

  if (effAccOk1 && sigmaGps <= g.tier1EffAccM && carryInTier1Range) {
    tier = 1;
  } else if (effAccOk2 && relSigma <= g.tier2RelSigma) {
    tier = 2;
    tierReason = !effAccOk1
      ? 'effacc>5'
      : !carryInTier1Range
        ? 'carry-out-of-range'
        : 'sigma';
  } else {
    tier = 3;
    tierReason = !effAccOk2 ? 'effacc>10' : 'relsigma>10%';
  }

  // ── A3 chain-break defenses (only ever DEMOTE) ──
  // Penalty-gesture / pairing break → the landing isn't this shot's.
  if (calib.brokenChain) {
    tier = 3;
    tierReason = 'broken-chain';
  }
  // Shot-type vs distance implausibility → the pairing is wrong.
  if (tier < 3 && calib.shotType) {
    const maxForType = A3_MAX_CARRY_M[calib.shotType];
    if (carryM > maxForType) {
      tier = 3;
      tierReason = `implausible-${calib.shotType}>${maxForType}m`;
    }
  }
  // Long gap between clips → pairing is stale; can't be an exact label.
  if (
    tier === 1 &&
    calib.interClipGapSec !== null &&
    calib.interClipGapSec !== undefined &&
    calib.interClipGapSec > A3_GAP_MAX_SEC
  ) {
    tier = 2;
    tierReason = 'inter-clip-gap>8min';
  }

  const rounded = Math.round(carryM);
  const labelText = tier === 1 ? `${rounded}m` : tier === 2 ? `~${rounded}m` : null;

  return {
    carryM,
    bearingDeg,
    deltaDeg,
    sigmaD,
    tier,
    labelText,
    tierReason,
  };
}

// ════════════════════════════════════════════════════════════════════════
// S7 — fitDetectedTrack + buildArcSpecV2
// ════════════════════════════════════════════════════════════════════════

/** A detected-track point on the ORIGINAL file timeline. */
export interface TrackPoint {
  x: number;
  y: number;
  tMs: number;
}

export interface DetectedFit {
  degenerate: false;
  /** Launch point (fit evaluated at the first kept time). */
  p0: { x: number; y: number };
  /** Handoff position P_h (fit at the last kept time). */
  ph: { x: number; y: number };
  /** Screen velocity V_h at the handoff (normalized units per SECOND). */
  vh: { x: number; y: number };
  /** Handoff time relative to launch, seconds. */
  thSec: number;
  /** Normalized climb at launch = vY/|V| ∈ [0,1] (sine of screen launch angle). */
  vy0: number;
  /** Sign of net lateral drift over the kept window. */
  latSign: -1 | 0 | 1;
  /** Max perpendicular deviation of the track from its p0→ph chord, normalized
   *  by chord length (F8b curvature residual). */
  curvatureResidual: number;
  /** Points kept after trailing-trim + robust weighting (for diagnostics). */
  keptCount: number;
}

export interface DegenerateFit {
  degenerate: true;
  reason: 'D2';
  /** Points available (0–4) — buildArcSpecV2 uses them for direction-only. */
  points: TrackPoint[];
}

export type FitResult = DetectedFit | DegenerateFit;

const HUBER_K = 0.04; // normalized-screen residual scale for endpoint robustifying

/**
 * Fit the detected ball track: trim the trailing 20% of points (roll/decay
 * noise), require ≥5 kept points spanning ≥150 ms, then a Huber-robust
 * weighted-least-squares QUADRATIC IN TIME for x(t) and y(t). Returns the
 * launch point, handoff (P_h, V_h), normalized climb, lateral sign, and the
 * curvature residual. Degenerate (< 5 pts / short span / ill-conditioned) →
 * D2 with whatever raw points exist for the direction-only ladder.
 */
export function fitDetectedTrack(points: TrackPoint[]): FitResult {
  const pts = (points ?? []).filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.tMs),
  );
  const degenerate = (): DegenerateFit => ({
    degenerate: true,
    reason: 'D2',
    points: pts.slice(0, 4),
  });
  if (pts.length < 5) return degenerate();

  // Sort by time, trim trailing 20% (keep ≥5).
  const sorted = [...pts].sort((p, q) => p.tMs - q.tMs);
  const keepN = Math.max(5, Math.floor(sorted.length * 0.8));
  const kept = sorted.slice(0, keepN);
  const spanMs = kept[kept.length - 1].tMs - kept[0].tMs;
  if (kept.length < 5 || spanMs < 150) return degenerate();

  // Relative time in seconds (t0 = 0 at launch).
  const t0Ms = kept[0].tMs;
  const T = kept.map((p) => (p.tMs - t0Ms) / 1000);
  const X = kept.map((p) => p.x);
  const Y = kept.map((p) => p.y);
  const thSec = T[T.length - 1];

  // Weighted quadratic fit c0 + c1 t + c2 t² via normal equations, one Huber
  // reweight pass to blunt a single outlier endpoint (A4 robustification).
  type Quad = { c0: number; c1: number; c2: number } | null;
  function fitQuad(vals: number[], w: number[]): Quad {
    // Normal matrix M (3x3) for basis [1, t, t²], weighted.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < T.length; i++) {
      const t = T[i], wi = w[i];
      const t2 = t * t;
      s0 += wi;
      s1 += wi * t;
      s2 += wi * t2;
      s3 += wi * t2 * t;
      s4 += wi * t2 * t2;
      b0 += wi * vals[i];
      b1 += wi * vals[i] * t;
      b2 += wi * vals[i] * t2;
    }
    // Solve the symmetric 3x3 [[s0,s1,s2],[s1,s2,s3],[s2,s3,s4]] x = [b0,b1,b2].
    const m = [
      [s0, s1, s2],
      [s1, s2, s3],
      [s2, s3, s4],
    ];
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    // Cramer's rule.
    const col = [b0, b1, b2];
    const solveCol = (ci: number) => {
      const mm = m.map((row) => row.slice());
      for (let r = 0; r < 3; r++) mm[r][ci] = col[r];
      return (
        mm[0][0] * (mm[1][1] * mm[2][2] - mm[1][2] * mm[2][1]) -
        mm[0][1] * (mm[1][0] * mm[2][2] - mm[1][2] * mm[2][0]) +
        mm[0][2] * (mm[1][0] * mm[2][1] - mm[1][1] * mm[2][0])
      );
    };
    return { c0: solveCol(0) / det, c1: solveCol(1) / det, c2: solveCol(2) / det };
  }

  const w = kept.map(() => 1);
  let fx = fitQuad(X, w);
  let fy = fitQuad(Y, w);
  if (!fx || !fy) return degenerate();

  // Huber reweight pass on the combined residual.
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const rx = X[i] - (fx.c0 + fx.c1 * t + fx.c2 * t * t);
    const ry = Y[i] - (fy.c0 + fy.c1 * t + fy.c2 * t * t);
    const r = Math.hypot(rx, ry);
    w[i] = r <= HUBER_K ? 1 : HUBER_K / r;
  }
  const fx2 = fitQuad(X, w);
  const fy2 = fitQuad(Y, w);
  if (fx2 && fy2) {
    fx = fx2;
    fy = fy2;
  }

  const evalPos = (t: number) => ({
    x: fx!.c0 + fx!.c1 * t + fx!.c2 * t * t,
    y: fy!.c0 + fy!.c1 * t + fy!.c2 * t * t,
  });
  const evalVel = (t: number) => ({
    x: fx!.c1 + 2 * fx!.c2 * t,
    y: fy!.c1 + 2 * fy!.c2 * t,
  });

  const p0 = evalPos(0);
  const ph = evalPos(thSec);
  const vh = evalVel(thSec);
  const v0 = evalVel(0);
  const speed0 = Math.hypot(v0.x, v0.y);
  const vy0 = speed0 > 1e-9 ? clamp(v0.y / speed0, 0, 1) : 0;

  const netDx = ph.x - p0.x;
  const latSign: -1 | 0 | 1 =
    Math.abs(netDx) < 1e-4 ? 0 : netDx > 0 ? 1 : -1;

  // Curvature residual: max perpendicular distance of kept points from the
  // p0→ph chord, normalized by chord length (F8b).
  const chordDx = ph.x - p0.x;
  const chordDy = ph.y - p0.y;
  const chordLen = Math.hypot(chordDx, chordDy);
  let maxPerp = 0;
  if (chordLen > 1e-6) {
    for (let i = 0; i < kept.length; i++) {
      const perp =
        Math.abs(chordDx * (p0.y - Y[i]) - (p0.x - X[i]) * chordDy) / chordLen;
      if (perp > maxPerp) maxPerp = perp;
    }
  }
  const curvatureResidual = chordLen > 1e-6 ? maxPerp / chordLen : 0;

  return {
    degenerate: false,
    p0,
    ph,
    vh,
    thSec,
    vy0,
    latSign,
    curvatureResidual,
    keptCount: kept.length,
  };
}

// ─── Arc spec ───

export interface TracerSampleV2 {
  x: number;
  y: number;
  tSec: number;
}

export interface TracerMetaV2 {
  tier: CarryTier;
  labelText: string | null;
  bucket: ShotBucket;
  carryM: number;
  apexM: number;
  hangS: number;
  /** D1–D6 rung actually taken. */
  degenerate: 'none' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
  /** The arc's actual landing target (== last sample; may differ from the raw
   *  GPS projection when F8b flips the lateral sign). */
  endpoint: { x: number; y: number };
  /** Handoff continuity witnesses (for C0/C1 invariants). */
  handoff: { x: number; y: number };
  vHandoffIn: { x: number; y: number };
  vHandoffOut: { x: number; y: number };
  /** Solved vertical pseudo-gravities + phase split. */
  gUp: number;
  gDown: number;
  tUpSec: number;
  tRemSec: number;
  /** F8b lateral-sign decision log. */
  parallaxEstimate: number;
  curvatureResidual: number;
  override: boolean;
  lateralSource: 'gps' | 'vision';
  straightBow: boolean;
  latSign: -1 | 0 | 1;
  /** A8: roll actually applied to the output samples (0 when none/exceeded). */
  rollDeg: number;
  /** A8: |roll| > 15° — mount too tilted to compensate; forced off-axis degrade. */
  rollExceeded: boolean;
  /** A8: |deltaDeg| > 60° (side-on) OR rollExceeded — projection model broke,
   *  rendered detected segment + short bowed tail only, no landing/label. */
  offAxis: boolean;
}

export interface TracerRenderSpecV2 {
  samples: TracerSampleV2[];
  animStartSec: number;
  animDurationSec: number;
  styling: {
    color: string;
    coreColor: string;
    lineWidthPx: number;
    midWidthPx: number;
    glowWidthPx: number;
    cometHead: boolean;
  };
  labelText: string | null;
  meta: TracerMetaV2;
}

export interface BuildArcInputV2 {
  fit: FitResult;
  carry: ShotCarry;
  /** GPS-projected landing in normalized frame (from projectLanding / A5). */
  landing: { x: number; y: number };
  /** Horizon line + projection params (for apex → normalized-y mapping). */
  horizonY: number;
  vFovPortraitDeg: number;
  /** Camera height (bag mount, config.tracer.v2.bagMountHeightM). */
  camHeightM: number;
  /** When the arc starts drawing on the TRIMMED clip, and the max it can host. */
  animStartSec: number;
  maxAnimSec: number;
  /** Fallback launch anchor when the fit is degenerate (poseAnchor / default). */
  poseAnchor?: { x: number; y: number } | null;
  /** Raw detected unit direction (for D2 direction-only handoff), if any. */
  detectedDirection?: { dx: number; dy: number } | null;
  /** A8: camera roll (mount tilt) in degrees, from camera_roll_deg. null → 0.
   *  |roll| ≤ 15 → the whole arc is rotated by this to match the tilted world;
   *  |roll| > 15 → not compensated, off-axis degrade. */
  rollDeg?: number | null;
  /** Number of sample points to emit (60–90). */
  sampleCount?: number;
}

/** Portrait frame aspect (W/H) — roll rotation is done in pixel-aspect space so
 *  a screen tilt doesn't distort in normalized coords (9:16). */
const FRAME_ASPECT = 9 / 16;

function rotAboutCenter(
  x: number,
  y: number,
  cosR: number,
  sinR: number,
): { x: number; y: number } {
  const dx = x - 0.5;
  const dy = y - 0.5;
  return {
    x: 0.5 + dx * cosR - (dy * sinR) / FRAME_ASPECT,
    y: 0.5 + dx * sinR * FRAME_ASPECT + dy * cosR,
  };
}

function rotVec(
  vx: number,
  vy: number,
  cosR: number,
  sinR: number,
): { x: number; y: number } {
  return {
    x: vx * cosR - (vy * sinR) / FRAME_ASPECT,
    y: vx * sinR * FRAME_ASPECT + vy * cosR,
  };
}

const VY_MAX_NORM: Record<ShotBucket, number> = {
  // A4 clamp on V_h.y (normalized screen-heights / sec). Generous — only trims
  // a genuinely noisy endpoint; the apex bound (I11a) is enforced separately.
  drive: 1.6,
  iron: 1.8,
  wedge: 2.2,
};

/** Map an apex height (meters) to a normalized y above the horizon anchor. */
function apexToNormY(
  apexM: number,
  carryM: number,
  horizonY: number,
  camHeightM: number,
  vFovPortraitDeg: number,
): number {
  const halfH = Math.tan((vFovPortraitDeg * Math.PI) / 360);
  const y =
    horizonY +
    Math.tan(Math.atan2(apexM - camHeightM, 0.6 * Math.max(carryM, 20))) /
      (2 * Math.max(halfH, 1e-6));
  return y;
}

/**
 * Build the two-segment arc: real detected segment 1 (fit sampled at its own
 * timing) seamlessly continued by a closed-form synthetic segment 2 that hits
 * the GPS landing exactly. Vertical = piecewise quadratic-in-time with solved
 * g_up/g_down (t_up capped at 0.7·t_rem, else y_apex re-solved so CONTINUITY
 * outranks the apex prior). Lateral = one cubic Hermite from (P_h.x, V_h.x) to
 * (x_land, 0) with a Fritsch–Carlson monotonicity guard (no S-curves / sign
 * reversal). A4: V_h.y clamped to [0, vyMax(bucket)]; F8b: vision overrides the
 * GPS lateral sign only on curvature + parallax evidence. Degenerate ladder
 * D1–D6 covers thin/absent detections. NaN-free by construction.
 */
export function buildArcSpecV2(input: BuildArcInputV2): TracerRenderSpecV2 {
  const { tracer } = config;
  const arc = tracer.arc;
  const N = clamp(Math.round(input.sampleCount ?? 72), 60, 90);
  const carryM = Math.max(input.carry.carryM, 1);
  const bucket = bucketForCarry(carryM);

  // ── A8: camera-angle robustness ──
  // Roll beyond ±15° means the mount is wrong — don't compensate. Side-on
  // filming (|deltaDeg| > 60°) breaks the pinhole projection. Either → degrade:
  // detected segment + short bowed tail, no landing anchor, no label.
  const rollDegRaw = Number.isFinite(input.rollDeg ?? 0) ? input.rollDeg ?? 0 : 0;
  const rollExceeded = Math.abs(rollDegRaw) > 15;
  const offAxis =
    (input.carry.deltaDeg !== null && Math.abs(input.carry.deltaDeg) > 60) ||
    rollExceeded;
  if (offAxis) {
    return buildOffAxisDegrade(input, carryM, bucket, rollExceeded, rollDegRaw);
  }

  // Resolve the launch anchor + handoff state via the degenerate ladder.
  let p0: { x: number; y: number };
  let ph: { x: number; y: number };
  let vh: { x: number; y: number };
  let vy0: number;
  let thSec: number;
  let curvatureResidual = 0;
  let latSignFit: -1 | 0 | 1 = 0;
  let degenerate: TracerMetaV2['degenerate'];

  const defaultAnchor = input.poseAnchor ?? { x: 0.5, y: 0.18 };

  if (!input.fit.degenerate) {
    // D1 — real detected fit.
    const f = input.fit;
    p0 = f.p0;
    ph = f.ph;
    vh = { x: f.vh.x, y: f.vh.y };
    vy0 = f.vy0;
    thSec = Math.max(f.thSec, 0);
    curvatureResidual = f.curvatureResidual;
    latSignFit = f.latSign;
    degenerate = 'D1';
  } else if (input.fit.points.length >= 2 && input.detectedDirection) {
    // D2 — direction-only handoff: too few points to fit, but a launch ray
    // exists. Anchor at the first point, hand off almost immediately along the
    // detected ray so segment 2 does the work.
    const first = input.fit.points[0];
    p0 = { x: first.x, y: first.y };
    const dir = input.detectedDirection;
    const dlen = Math.hypot(dir.dx, dir.dy) || 1;
    const ux = dir.dx / dlen;
    const uy = Math.max(dir.dy / dlen, 0.05);
    thSec = 0.12;
    const spd = 0.6; // assumed early screen speed (normalized/sec)
    vh = { x: ux * spd, y: uy * spd };
    ph = { x: p0.x + vh.x * thSec, y: p0.y + vh.y * thSec };
    vy0 = clamp(uy, 0, 1);
    degenerate = 'D2';
  } else if (input.poseAnchor) {
    // D3 — no usable detection, pose anchor available (R2 synthetic).
    p0 = { x: input.poseAnchor.x, y: input.poseAnchor.y };
    ph = { x: p0.x, y: p0.y };
    const launchDeg = TRACER_PRIORS[bucket].launchDeg;
    const spd = 0.5;
    vh = {
      x: 0,
      y: Math.sin((launchDeg * Math.PI) / 180) * spd + 1e-3,
    };
    vy0 = clamp(Math.sin((launchDeg * Math.PI) / 180), 0, 1);
    thSec = 0;
    degenerate = 'D3';
  } else if (config.tracer.v2.allowPriorOnlyArc) {
    // D4/D5 — nothing but priors (dev-only R4). Default frame-bottom anchor.
    p0 = { x: defaultAnchor.x, y: defaultAnchor.y };
    ph = { x: p0.x, y: p0.y };
    const launchDeg = TRACER_PRIORS[bucket].launchDeg;
    const spd = 0.5;
    vh = { x: 0, y: Math.sin((launchDeg * Math.PI) / 180) * spd + 1e-3 };
    vy0 = clamp(Math.sin((launchDeg * Math.PI) / 180), 0, 1);
    thSec = 0;
    degenerate = 'D5';
  } else {
    // D6 — truly nothing usable; emit a minimal straight NaN-free stub so the
    // caller can decide to veto without a crash.
    degenerate = 'D6';
    return degenerateStub(input, carryM, bucket);
  }

  // ── Apex target (meters → normalized y), floored by detected climb, modulated
  //    by the prior, clamped to the bucket and I11a (≤ 1.5× bucketHi). ──
  const priors = TRACER_PRIORS[bucket];
  const vy0Norm = clamp(
    (vy0 - arc.vy0Lo) / Math.max(arc.vy0Hi - arc.vy0Lo, 1e-6),
    0,
    1,
  );
  // Apex = prior kApex·carry, modulated by the detected climb through vy0Norm
  // (steeper detected launch → larger kApex), clamped to the bucket range and
  // to I11a (≤ 1.5× bucketHi). apexHeightM(carry) is the pure geometry prior
  // used as the lower reference so a very shallow vy0 can't collapse the apex.
  const kApex = lerp(arc.kApexLo, arc.kApexHi, vy0Norm);
  const apexHiCap = priors.apexHiM * 1.5; // I11a
  const apexM = clamp(
    Math.max(kApex * carryM, Math.min(apexHeightM(carryM), priors.apexLoM)),
    priors.apexLoM,
    apexHiCap,
  );

  const hangS = hangTimeSec(apexM);

  // Normalized apex y target, kept strictly above the handoff.
  let yApexTarget = apexToNormY(
    apexM,
    carryM,
    input.horizonY,
    input.camHeightM,
    input.vFovPortraitDeg,
  );
  yApexTarget = Math.max(yApexTarget, ph.y + 0.02);

  // ── Vertical solve (piecewise quadratic in time) ──
  // Total remaining flight time from the handoff.
  const totalSyntheticIdeal = Math.max(hangS - thSec, arc.tRemMin);
  // Fit inside the clip's post-impact window.
  const maxSynthetic = Math.max(input.maxAnimSec - thSec, arc.tRemMin);
  const tRem = Math.max(Math.min(totalSyntheticIdeal, maxSynthetic), arc.tRemMin);

  // A4 clamp on the ascent velocity (continuity preserved; when inactive
  // vHandoffOut == V_h exactly). Damp-blend is applied in the sampler below.
  const vyMax = VY_MAX_NORM[bucket];
  const vYsolve = clamp(vh.y, 0, vyMax);

  // t_up so the apex reaches yApexTarget with v=0 there (apex condition):
  //   y_apex = P_h.y + 0.5 · vY · t_up  → t_up = 2·(Δ)/vY.
  let dyUp = Math.max(yApexTarget - ph.y, 1e-4);
  let tUp: number;
  let yApex: number;
  if (vYsolve > 1e-6) {
    tUp = (2 * dyUp) / vYsolve;
    const tUpCap = arc.tUpFracMax * tRem;
    if (tUp > tUpCap) {
      // Continuity outranks the apex prior: keep vY, cap t_up, re-solve apex.
      tUp = tUpCap;
      yApex = ph.y + 0.5 * vYsolve * tUp;
    } else {
      yApex = yApexTarget;
    }
  } else {
    // No upward velocity (degenerate/flat handoff): give a minimal ascent so
    // the arc still peaks, capped by t_rem.
    tUp = Math.min(0.3 * tRem, arc.tUpFracMax * tRem);
    yApex = Math.max(ph.y + 0.02, yApexTarget);
  }
  tUp = clamp(tUp, 1e-3, arc.tUpFracMax * tRem);
  dyUp = Math.max(yApex - ph.y, 1e-4);
  // g_up from the apex condition v(t_up)=0 with initial vY: g_up = vY / t_up
  // when vY drives it, else derived from the height over t_up².
  const gUpRaw = vYsolve > 1e-6 ? vYsolve / tUp : (2 * dyUp) / (tUp * tUp);
  const gUp = gUpRaw;

  // Descent: from (yApex, v=0) at tUp to yLand at tRem.
  const yLand = input.landing.y;
  const tDown = Math.max(tRem - tUp, 1e-3);
  // g_down capped so the descent can't spike past gMax·g_up (plan arc.gMax).
  let gDown = (2 * (yApex - yLand)) / (tDown * tDown);
  const gDownCap = arc.gMax * Math.max(gUp, 1e-6);
  if (Number.isFinite(gDownCap) && gDown > gDownCap) gDown = gDownCap;
  if (!Number.isFinite(gDown)) gDown = 0;

  // ── Lateral solve (single cubic Hermite, Fritsch–Carlson guarded) ──
  const straightBow =
    input.carry.deltaDeg !== null && Math.abs(input.carry.deltaDeg) < 8;

  // F8b: vision overrides the GPS lateral SIGN only on genuine CURVATURE
  // evidence beyond what the mount parallax can explain (a low-curvature drift
  // is treated as parallax and does NOT flip the side — see the effective
  // handoff below). When it does override, keep the GPS magnitude, flip side.
  const parallaxEstimate = clamp(input.camHeightM / Math.max(carryM, 20), 0, 0.2);
  let lateralSource: 'gps' | 'vision' = 'gps';
  let override = false;
  let xLand = input.landing.x;
  const driftMag = Math.abs(ph.x - p0.x);
  if (
    !input.fit.degenerate &&
    curvatureResidual > 0.02 &&
    driftMag > parallaxEstimate &&
    latSignFit !== 0 &&
    input.carry.deltaDeg !== null &&
    Math.sign(latSignFit) !== Math.sign(input.carry.deltaDeg || 0)
  ) {
    override = true;
    lateralSource = 'vision';
    xLand = ph.x + Math.abs(input.landing.x - ph.x) * latSignFit;
  }
  xLand = clamp(xLand, -0.3, 1.3);

  // Effective handoff lateral. To guarantee a MONOTONE lateral path (no sign
  // reversal / S-curve) AND C1 continuity, both segments share one handoff:
  //   • phEffX: the detected handoff x, clamped to lie between launch and
  //     landing (drift that overshoots the wrong side is parallax/noise —
  //     suppressed, matching A4's straight-shot-misread-as-fade correction).
  //   • vhEffX: the detected lateral velocity, kept only if it points TOWARD
  //     the landing and capped to the Fritsch–Carlson bound (α = m0/Δ ≤ 3) so
  //     the Hermite is monotone by construction and never triggers the guard.
  const dirL = Math.abs(xLand - p0.x) < 1e-6 ? 0 : Math.sign(xLand - p0.x);
  const phEffX =
    dirL === 0
      ? p0.x
      : clamp(ph.x, Math.min(p0.x, xLand), Math.max(p0.x, xLand));
  const dXseg2 = xLand - phEffX;
  let vhEffX = 0;
  if (dirL !== 0 && Math.sign(vh.x) === dirL && Math.abs(dXseg2) > 1e-6) {
    const fcCap = (3 * Math.abs(dXseg2)) / Math.max(tRem, 1e-6);
    vhEffX = dirL * Math.min(Math.abs(vh.x), fcCap);
  }
  // One effective handoff velocity, honored by BOTH segments (C1 exact).
  const vhEff = { x: vhEffX, y: vYsolve };
  const vHandoffIn = { x: vhEff.x, y: vhEff.y };

  // Hermite over s∈[0,1] (mapped to τ∈[0,tRem]): start tangent = vhEffX·tRem
  // (chain rule), end tangent = 0 (x'=0 at landing). α∈[0,3] ⇒ monotone.
  const x0 = phEffX;
  const x1 = xLand;
  const m0 = vhEffX * tRem;
  const m1 = 0;
  const vHandoffOutX = m0 / tRem; // == vhEffX; lateral velocity leaving handoff

  // ── Sample the polyline: segment 1 (detected, real timing) then segment 2
  //    (synthetic), one strictly-increasing time series. ──
  // Segment-1 sample count proportional to its time share.
  const totalDur = thSec + tRem;
  const seg1N =
    thSec > 1e-3 ? clamp(Math.round((thSec / totalDur) * N), 2, N - 4) : 0;
  const seg2N = N - seg1N;

  const samples: TracerSampleV2[] = [];

  // Segment 1: the real detected span, as a quadratic-in-time pinned to
  //   pos(0)=p0, pos(thSec)=(phEffX, ph.y), AND vel(thSec)=vhEff
  // so segment 1 EXITS the handoff at exactly the effective handoff velocity —
  // this is what makes C1 continuity hold against segment 2 (which enters at
  // the same velocity). Solving: c0 = p0 ; c2 = (p0 + vEff·th − pEff)/th² ;
  // c1 = vEff − 2·c2·th. (phEffX == detected ph.x whenever the drift is
  // toward the landing; vhEff.y == detected vh.y whenever the A4 clamp is off.)
  const th = thSec;
  const phX = phEffX;
  const phY = ph.y;
  const c2x = th > 1e-6 ? (p0.x + vhEff.x * th - phX) / (th * th) : 0;
  const c2y = th > 1e-6 ? (p0.y + vhEff.y * th - phY) / (th * th) : 0;
  const c1x = vhEff.x - 2 * c2x * th;
  const c1y = vhEff.y - 2 * c2y * th;
  for (let i = 0; i < seg1N; i++) {
    const frac = seg1N > 1 ? i / (seg1N - 1) : 0;
    const t = frac * th;
    samples.push({
      x: p0.x + c1x * t + c2x * t * t,
      y: p0.y + c1y * t + c2y * t * t,
      tSec: t,
    });
  }

  // Segment 2: synthetic. τ ∈ (0, tRem]. Vertical piecewise-quadratic (enters
  // at vYsolve, apex at tUp, exact landing at tRem); lateral one Hermite.
  for (let i = 1; i <= seg2N; i++) {
    const tau = (i / seg2N) * tRem;
    // Vertical:
    let y: number;
    if (tau <= tUp) {
      y = phY + vYsolve * tau - 0.5 * gUp * tau * tau;
    } else {
      const td = tau - tUp;
      y = yApex - 0.5 * gDown * td * td;
    }
    // Lateral Hermite in s = tau/tRem.
    const s = tau / tRem;
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    const x = h00 * x0 + h10 * m0 + h01 * x1 + h11 * m1;
    samples.push({ x, y, tSec: thSec + tau });
  }

  // Force EXACT endpoints (guards float drift): first = p0/launch, last = land.
  if (samples.length) {
    samples[0] = { x: p0.x, y: p0.y, tSec: 0 };
    samples[samples.length - 1] = { x: xLand, y: yLand, tSec: totalDur };
  }

  // Ensure strictly-increasing tSec (I11b precursor) — dedupe any coincident.
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].tSec <= samples[i - 1].tSec) {
      samples[i].tSec = samples[i - 1].tSec + 1e-4;
    }
  }

  // ── A8 roll compensation: the arc was solved in the gravity-aligned frame;
  //    rotate ALL output samples (and the handoff/endpoint/velocity witnesses)
  //    by rollDeg about frame center, in pixel-aspect space, so it matches the
  //    tilted world. Rotation is rigid (linear) → C1 and horizon-relative apex
  //    are preserved; only screen-space x-monotonicity is (correctly) no longer
  //    guaranteed once the frame is tilted. ──
  let hf = { x: phEffX, y: ph.y };
  let ep = { x: xLand, y: yLand };
  let vIn = { x: vHandoffIn.x, y: vHandoffIn.y };
  let vOut = { x: vHandoffOutX, y: vYsolve };
  if (rollDegRaw !== 0) {
    const rollRad = (rollDegRaw * Math.PI) / 180;
    const cosR = Math.cos(rollRad);
    const sinR = Math.sin(rollRad);
    for (let i = 0; i < samples.length; i++) {
      const r = rotAboutCenter(samples[i].x, samples[i].y, cosR, sinR);
      samples[i] = { x: r.x, y: r.y, tSec: samples[i].tSec };
    }
    hf = rotAboutCenter(hf.x, hf.y, cosR, sinR);
    ep = rotAboutCenter(ep.x, ep.y, cosR, sinR);
    vIn = rotVec(vIn.x, vIn.y, cosR, sinR);
    vOut = rotVec(vOut.x, vOut.y, cosR, sinR);
  }

  const animDurationSec = clamp(
    Math.min(totalDur, input.maxAnimSec),
    0.01,
    input.maxAnimSec,
  );

  const meta: TracerMetaV2 = {
    tier: input.carry.tier,
    labelText: input.carry.labelText,
    bucket,
    carryM: round2(carryM),
    apexM: round2(apexM),
    hangS: round2(hangS),
    degenerate,
    endpoint: { x: ep.x, y: ep.y },
    handoff: { x: round2(hf.x), y: round2(hf.y) },
    vHandoffIn: { x: vIn.x, y: vIn.y },
    vHandoffOut: { x: vOut.x, y: vOut.y },
    gUp: round2(gUp),
    gDown: round2(gDown),
    tUpSec: round2(tUp),
    tRemSec: round2(tRem),
    parallaxEstimate: round2(parallaxEstimate),
    curvatureResidual: round2(curvatureResidual),
    override,
    lateralSource,
    straightBow,
    latSign: latSignFit,
    rollDeg: rollDegRaw,
    rollExceeded: false,
    offAxis: false,
  };

  return {
    samples,
    animStartSec: input.animStartSec,
    animDurationSec,
    styling: {
      color: tracer.color,
      coreColor: tracer.coreColor,
      lineWidthPx: tracer.lineWidthPx,
      midWidthPx: tracer.midWidthPx,
      glowWidthPx: tracer.glowWidthPx,
      cometHead: tracer.cometHead,
    },
    labelText: input.carry.labelText,
    meta,
  };
}

/** D6 — nothing usable. A short, straight, NaN-free stub the caller can veto. */
function degenerateStub(
  input: BuildArcInputV2,
  carryM: number,
  bucket: ShotBucket,
): TracerRenderSpecV2 {
  const { tracer } = config;
  const anchor = input.poseAnchor ?? { x: 0.5, y: 0.18 };
  const land = input.landing;
  const N = 60;
  const samples: TracerSampleV2[] = [];
  const dur = Math.max(Math.min(1.0, input.maxAnimSec), 0.2);
  for (let i = 0; i < N; i++) {
    const s = i / (N - 1);
    samples.push({
      x: anchor.x + (land.x - anchor.x) * s,
      y: anchor.y + (land.y - anchor.y) * s,
      tSec: s * dur,
    });
  }
  return {
    samples,
    animStartSec: input.animStartSec,
    animDurationSec: dur,
    styling: {
      color: tracer.color,
      coreColor: tracer.coreColor,
      lineWidthPx: tracer.lineWidthPx,
      midWidthPx: tracer.midWidthPx,
      glowWidthPx: tracer.glowWidthPx,
      cometHead: tracer.cometHead,
    },
    labelText: input.carry.labelText,
    meta: {
      tier: input.carry.tier,
      labelText: input.carry.labelText,
      bucket,
      carryM: round2(carryM),
      apexM: 0,
      hangS: round2(hangTimeSec(0)),
      degenerate: 'D6',
      endpoint: { x: land.x, y: land.y },
      handoff: { x: round2(anchor.x), y: round2(anchor.y) },
      vHandoffIn: { x: 0, y: 0 },
      vHandoffOut: { x: 0, y: 0 },
      gUp: 0,
      gDown: 0,
      tUpSec: 0,
      tRemSec: 0,
      parallaxEstimate: 0,
      curvatureResidual: 0,
      override: false,
      lateralSource: 'gps',
      straightBow: true,
      latSign: 0,
      rollDeg: 0,
      rollExceeded: false,
      offAxis: false,
    },
  };
}

/**
 * A8 off-axis / roll-exceeded degrade. The projection model is untrustworthy
 * (side-on filming |deltaDeg|>60°, or mount roll >15°), so we do NOT draw a
 * confident full arc to a GPS landing. Render the real detected launch plus a
 * short physics-plausible BOWED TAIL that continues the detected direction and
 * simply falls — no landing anchor, no distance label. NaN-free.
 */
function buildOffAxisDegrade(
  input: BuildArcInputV2,
  carryM: number,
  bucket: ShotBucket,
  rollExceeded: boolean,
  rollDeg: number,
): TracerRenderSpecV2 {
  const { tracer } = config;
  const N = 64;

  // Launch anchor + handoff direction from whatever evidence exists.
  let p0: { x: number; y: number };
  let vx: number;
  let vy: number;
  let thSec: number;
  let degenerate: TracerMetaV2['degenerate'] = 'D4';
  if (!input.fit.degenerate) {
    p0 = input.fit.p0;
    vx = input.fit.vh.x;
    vy = Math.max(input.fit.vh.y, 0.05);
    thSec = Math.max(input.fit.thSec, 0.05);
  } else if (input.fit.points.length >= 1 && input.detectedDirection) {
    const f = input.fit.points[0];
    p0 = { x: f.x, y: f.y };
    const d = input.detectedDirection;
    const len = Math.hypot(d.dx, d.dy) || 1;
    vx = (d.dx / len) * 0.5;
    vy = Math.max((d.dy / len) * 0.5, 0.05);
    thSec = 0.12;
    degenerate = 'D2';
  } else {
    const a = input.poseAnchor ?? { x: 0.5, y: 0.18 };
    p0 = { x: a.x, y: a.y };
    const launchDeg = TRACER_PRIORS[bucket].launchDeg;
    vx = 0;
    vy = Math.sin((launchDeg * Math.PI) / 180) * 0.5 + 1e-3;
    thSec = 0;
    degenerate = input.poseAnchor ? 'D3' : 'D5';
  }

  // Short bowed tail: ballistic fall from the handoff under a prior gravity,
  // with a gentle lateral bow continuing the launch direction. Not anchored.
  const tail = clamp(Math.min(1.2, input.maxAnimSec - thSec), 0.4, 1.5);
  const ph = { x: p0.x + vx * thSec, y: p0.y + vy * thSec };
  const gTail = (2 * vy) / tail; // peaks ~mid-tail then falls
  const samples: TracerSampleV2[] = [];
  const seg1N = thSec > 1e-3 ? Math.max(2, Math.round((thSec / (thSec + tail)) * N)) : 0;
  const seg2N = N - seg1N;
  for (let i = 0; i < seg1N; i++) {
    const t = (seg1N > 1 ? i / (seg1N - 1) : 0) * thSec;
    samples.push({ x: p0.x + vx * t, y: p0.y + vy * t, tSec: t });
  }
  for (let i = 1; i <= seg2N; i++) {
    const tau = (i / seg2N) * tail;
    const bow = 0.04 * Math.sin((Math.PI * tau) / tail) * Math.sign(vx || 1);
    samples.push({
      x: ph.x + vx * 0.5 * tau + bow,
      y: ph.y + vy * tau - 0.5 * gTail * tau * tau,
      tSec: thSec + tau,
    });
  }
  samples[0] = { x: p0.x, y: p0.y, tSec: 0 };
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].tSec <= samples[i - 1].tSec) samples[i].tSec = samples[i - 1].tSec + 1e-4;
  }

  const dur = clamp(Math.min(thSec + tail, input.maxAnimSec), 0.2, input.maxAnimSec);
  return {
    samples,
    animStartSec: input.animStartSec,
    animDurationSec: dur,
    styling: {
      color: tracer.color,
      coreColor: tracer.coreColor,
      lineWidthPx: tracer.lineWidthPx,
      midWidthPx: tracer.midWidthPx,
      glowWidthPx: tracer.glowWidthPx,
      cometHead: tracer.cometHead,
    },
    labelText: null, // A8: no label on a degraded projection
    meta: {
      tier: input.carry.tier,
      labelText: null,
      bucket,
      carryM: round2(carryM),
      apexM: 0,
      hangS: round2(hangTimeSec(0)),
      degenerate,
      endpoint: { x: samples[samples.length - 1].x, y: samples[samples.length - 1].y },
      handoff: { x: round2(ph.x), y: round2(ph.y) },
      vHandoffIn: { x: vx, y: vy },
      vHandoffOut: { x: vx * 0.5, y: vy },
      gUp: 0,
      gDown: round2(gTail),
      tUpSec: 0,
      tRemSec: round2(tail),
      parallaxEstimate: 0,
      curvatureResidual: 0,
      override: false,
      lateralSource: 'vision',
      straightBow: true,
      latSign: 0,
      rollDeg: 0, // degraded arc is not roll-compensated
      rollExceeded,
      offAxis: true,
    },
  };
}
