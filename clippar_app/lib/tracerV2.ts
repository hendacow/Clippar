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
  const carryInTier1Range =
    carryM >= g.tier1CarryMinM && carryM <= g.tier1CarryMaxM;
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
  /** F8b curvature residual — LATERAL-only (max deviation of x(t) from the
   *  x-chord, normalized by the 2D chord length). Purely lateral so vertical
   *  gravity sag is NOT mistaken for a draw/fade. */
  curvatureResidual: number;
  /** Quadratic-in-time fit coefficients [c0,c1,c2] for x and y (time relative
   *  to launch, seconds). Lets buildArcSpecV2 sample the REAL detected curve as
   *  segment 1 (untouched), rather than re-pinning it. */
  coeff: { x: [number, number, number]; y: [number, number, number] };
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

const HUBER_K = config.tracer.arc.huberK; // normalized-screen residual scale

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

  // F8b curvature residual — LATERAL ONLY. Deviation of x(t) from the straight
  // x-chord (x-linear interp), normalized by the 2D chord length. Because it
  // reads x alone, vertical gravity sag (a bend in y) contributes nothing, so
  // a laterally-straight shot never trips the override. The analytic max
  // deviation of a quadratic from its chord is |c2|·thSec²/4.
  const chordLen = Math.hypot(ph.x - p0.x, ph.y - p0.y);
  const maxLatDev = (Math.abs(fx.c2) * thSec * thSec) / 4;
  const curvatureResidual = chordLen > 1e-6 ? maxLatDev / chordLen : 0;

  return {
    degenerate: false,
    p0,
    ph,
    vh,
    thSec,
    vy0,
    latSign,
    curvatureResidual,
    coeff: {
      x: [fx.c0, fx.c1, fx.c2],
      y: [fy.c0, fy.c1, fy.c2],
    },
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
  /** Handoff continuity witnesses. vHandoffIn = the RAW detected fit velocity
   *  at the handoff; vHandoffOut = the EFFECTIVE velocity segment 2 leaves with
   *  (== the polyline seam velocity). They are equal when neither the A4 V_h
   *  clamp nor the lateral straightening is active, and differ (out ≤ in) when
   *  one is — never restated from a single source. */
  handoff: { x: number; y: number };
  vHandoffIn: { x: number; y: number };
  vHandoffOut: { x: number; y: number };
  /** True when segment 1 was RE-PINNED to exit at the effective handoff (the A4
   *  clamp or lateral straightening bent the tail of the detected segment toward
   *  the effective handoff). When false, segment 1 is the raw detected curve. */
  seg1Repinned: boolean;
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
 *  a screen tilt doesn't distort in normalized coords.
 *  NOTE: hardcoded 9:16 — the app records portrait only. If a landscape/other
 *  capture mode is ever added, this must become an input (width/height from the
 *  clip) or roll compensation will distort. Tracked for post-acceptance. */
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

/**
 * B1 timing finalizer. The samples carry natural times in [0, naturalTotal];
 * this rescales them so the LAST sample's tSec == the returned animDurationSec
 * EXACTLY (so keyTimes = tSec/animDuration are ≤ 1 with last == 1.0 — the
 * native parser rejects anything else with ERR_TRACER_SPEC). When the natural
 * total exceeds the clip's post-impact window, the WHOLE timeline is scaled
 * UNIFORMLY to fit: uniform scaling preserves the seam velocity ratio (both
 * sides ×1/scale) so there is no playback-speed jump at the detected→synthetic
 * handoff — a synthetic-only compression would speed up only half the arc.
 * Mutates `samples` in place. x/y are untouched, so the arc SHAPE is unchanged.
 */
function finalizeTiming(samples: TracerSampleV2[], maxAnimSec: number): number {
  const natural = samples[samples.length - 1].tSec;
  // UNIFORM time-scale (not synthetic-only): scaling the whole timeline equally
  // preserves the seam velocity RATIO (both sides ×1/scale), so there is no
  // playback-speed jump at the detected→synthetic handoff — a synthetic-only
  // compression would speed up only half the arc. x/y are untouched (shape
  // unchanged); only the clock compresses to fit the clip.
  const scale = natural > maxAnimSec && natural > 1e-9 ? maxAnimSec / natural : 1;
  if (scale !== 1) for (const s of samples) s.tSec *= scale;
  let animDur = Math.min(natural, maxAnimSec);
  // strictly increasing, then pin the last sample to animDur EXACTLY so every
  // keyTime = tSec/animDur ≤ 1 with last == 1.0.
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].tSec <= samples[i - 1].tSec) samples[i].tSec = samples[i - 1].tSec + 1e-5;
  }
  animDur = Math.max(animDur, samples[samples.length - 1].tSec);
  samples[samples.length - 1].tSec = animDur;
  return clamp(animDur, 0.01, maxAnimSec + 1e-9);
}

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
  const yLand = input.landing.y;
  const parallaxEstimate = clamp(input.camHeightM / Math.max(carryM, 20), 0, 0.2);
  // Raw detected handoff velocity (pre-clamp) — the honest C1 witness.
  const rawVh = !input.fit.degenerate
    ? { x: input.fit.vh.x, y: input.fit.vh.y }
    : { x: vh.x, y: vh.y };

  // A4 clamp on the ascent velocity, ideal synthetic time, and the t_up cap.
  const vyMax = arc.vyMaxNorm[bucket];
  const vYsolve = clamp(vh.y, 0, vyMax);
  let tRem = Math.max(hangS - thSec, arc.tRemMin);
  const tUpCap = arc.tUpFracMax * tRem;
  // Best apex reachable while PRESERVING continuity (keep vYsolve, cap t_up).
  const yApexContMax = ph.y + 0.5 * vYsolve * tUpCap;
  // The prior apex height (before any landing floor) — if the detected handoff
  // is already at/above it, the ball has finished climbing (or flown out the
  // top of frame), so there's no meaningful synthetic ascent to add.
  const yApexPrior = apexToNormY(apexM, carryM, input.horizonY, input.camHeightM, input.vFovPortraitDeg);

  // ── B2 / D4 — whole-flight-visible / detected-too-weak. Do NOT fabricate a
  //    synthetic apex-to-GPS-landing when it would be invalid or discontinuous:
  //    • no upward screen velocity at the handoff (already peaked/descending) —
  //      a synthetic "ascent" would plunge (wrong sign) then jump; OR
  //    • already at the landing height / almost no flight time left; OR
  //    • the detected climb is too weak to lift the ball above the (screen)
  //      landing within the continuity/speed bound — forcing the GPS landing
  //      would teleport the endpoint.
  //    Instead render the REAL detected flight + a short linear fade tail. ──
  if (
    !input.fit.degenerate &&
    (rawVh.y <= 1e-3 ||
      Math.abs(ph.y - yLand) <= arc.wholeFlightYTol ||
      hangS - thSec <= 0.3 ||
      yApexContMax <= yLand + arc.wholeFlightYTol ||
      ph.y >= yApexPrior - arc.wholeFlightYTol)
  ) {
    return buildWholeFlightVisible(input, {
      carryM,
      bucket,
      apexM,
      hangS,
      curvatureResidual,
      latSignFit,
      parallaxEstimate,
      rollDeg: rollDegRaw,
      N,
    });
  }

  // Apex y target, floored to clear BOTH the handoff and the landing so there
  // is always a real descent (no apex-below-landing → forced-endpoint teleport).
  const yApexFloor = Math.max(ph.y, yLand) + 0.02;
  let yApexTarget = apexToNormY(apexM, carryM, input.horizonY, input.camHeightM, input.vFovPortraitDeg);
  yApexTarget = Math.max(yApexTarget, yApexFloor);

  // Ascent: t_up so the apex reaches yApexTarget with v=0 (t_up=2Δ/vY), capped
  // at tUpFracMax·tRem (continuity outranks the apex prior → re-solve apex, but
  // never below the landing floor).
  const dyUp = Math.max(yApexTarget - ph.y, 1e-4);
  let tUp = (2 * dyUp) / vYsolve;
  let yApex: number;
  if (tUp > tUpCap) {
    tUp = tUpCap;
    yApex = Math.max(ph.y + 0.5 * vYsolve * tUp, yApexFloor);
  } else {
    yApex = yApexTarget;
  }
  tUp = clamp(tUp, 1e-3, Math.max(tUpCap, 1e-3));
  // Launch velocity that reaches yApex at t_up with v=0 there. This equals
  // vYsolve whenever the landing floor didn't raise the apex (D1 real-fit path,
  // where the D4 gate already guaranteed the apex clears the landing); it is
  // only boosted for prior-driven / degenerate arcs, which have no real detected
  // handoff velocity to stay continuous with.
  const v0 = (2 * (yApex - ph.y)) / tUp;
  const gUp = v0 / tUp; // apex condition v(t_up)=0

  // Descent to yLand. If the required g_down would exceed gMax·g_up, keep it AT
  // the cap and EXTEND t_down so the parabola still lands EXACTLY on yLand
  // (MAJOR 1 — no forced-endpoint teleport). Then finalize t_rem = t_up+t_down.
  const dropDown = Math.max(yApex - yLand, 0);
  let tDown = Math.max(tRem - tUp, 1e-3);
  let gDown = (2 * dropDown) / (tDown * tDown);
  const gDownCap = arc.gMax * Math.max(gUp, 1e-6);
  if (gDown > gDownCap && gDownCap > 0 && dropDown > 0) {
    gDown = gDownCap;
    tDown = Math.sqrt((2 * dropDown) / gDown); // extend to reach yLand smoothly
  }
  if (!Number.isFinite(gDown)) gDown = 0;
  tRem = tUp + tDown; // final synthetic duration

  // ── Lateral solve (single cubic Hermite, effective handoff keeps it monotone) ──
  const straightBow =
    input.carry.deltaDeg !== null && Math.abs(input.carry.deltaDeg) < 8;

  // F8b: vision overrides the GPS lateral SIGN only on genuine LATERAL curvature
  // (curvatureResidual is x-only, so vertical gravity sag never trips it) beyond
  // what the mount parallax can explain. When it overrides, keep the GPS
  // magnitude, flip to the detected side.
  let lateralSource: 'gps' | 'vision' = 'gps';
  let override = false;
  let xLand = input.landing.x;
  const driftMag = Math.abs(ph.x - p0.x);
  if (
    !input.fit.degenerate &&
    curvatureResidual > arc.f8bCurvatureMin &&
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
  // reversal / S-curve), the handoff x is clamped into the launch→landing
  // interval and the lateral velocity is kept only if it points toward the
  // landing (capped to the Fritsch–Carlson bound α≤3). Segment 1 is then
  // RE-PINNED to exit at this effective handoff — so when the clamp or straighten
  // is active, the tail of the detected segment is bent toward it (meta.
  // seg1Repinned = true); otherwise segment 1 == the raw detected curve.
  const dirL = Math.abs(xLand - p0.x) < 1e-6 ? 0 : Math.sign(xLand - p0.x);
  const phEffX =
    dirL === 0 ? p0.x : clamp(ph.x, Math.min(p0.x, xLand), Math.max(p0.x, xLand));
  const dXseg2 = xLand - phEffX;
  let vhEffX = 0;
  if (dirL !== 0 && Math.sign(vh.x) === dirL && Math.abs(dXseg2) > 1e-6) {
    const fcCap = (3 * Math.abs(dXseg2)) / Math.max(tRem, 1e-6);
    vhEffX = dirL * Math.min(Math.abs(vh.x), fcCap);
  }
  const vYeff = v0; // both segments enter/exit vertically at v0 (== vYsolve
  // unless a prior-driven apex was floored above the landing)
  const seg1Repinned =
    !input.fit.degenerate &&
    (Math.abs(phEffX - ph.x) > 1e-9 ||
      Math.abs(vhEffX - rawVh.x) > 1e-9 ||
      Math.abs(vYeff - rawVh.y) > 1e-9);

  // Hermite over s∈[0,1] (mapped to τ∈[0,tRem]): start tangent = vhEffX·tRem,
  // end tangent 0. α∈[0,3] ⇒ monotone.
  const x0 = phEffX;
  const x1 = xLand;
  const m0 = vhEffX * tRem;
  const m1 = 0;

  // ── Sample: segment 1 (re-pinned to exit at (phEffX, ph.y) with velocity
  //    (vhEffX, vYeff)) then segment 2 (synthetic). ──
  const totalDur = thSec + tRem;
  const seg1N =
    thSec > 1e-3 ? clamp(Math.round((thSec / totalDur) * N), 2, N - 4) : 0;
  const seg2N = N - seg1N;
  const samples: TracerSampleV2[] = [];
  const th = thSec;
  const phY = ph.y;
  const c2x = th > 1e-6 ? (p0.x + vhEffX * th - phEffX) / (th * th) : 0;
  const c2y = th > 1e-6 ? (p0.y + vYeff * th - phY) / (th * th) : 0;
  const c1x = vhEffX - 2 * c2x * th;
  const c1y = vYeff - 2 * c2y * th;
  for (let i = 0; i < seg1N; i++) {
    const t = (seg1N > 1 ? i / (seg1N - 1) : 0) * th;
    samples.push({ x: p0.x + c1x * t + c2x * t * t, y: p0.y + c1y * t + c2y * t * t, tSec: t });
  }
  // Sample the ascent and descent SEPARATELY (each with ≥2 points) so the apex
  // is always resolved — a single uniform grid can skip a short ascent (tiny
  // t_up), leaving an under-sampled peak and a spurious seam-velocity spike.
  const ascN = clamp(Math.round(seg2N * (tUp / tRem)), 2, seg2N - 2);
  const descN = seg2N - ascN;
  const hermiteX = (tau: number) => {
    const s = tau / tRem;
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * x0 +
      (s3 - 2 * s2 + s) * m0 +
      (-2 * s3 + 3 * s2) * x1 +
      (s3 - s2) * m1
    );
  };
  for (let i = 1; i <= ascN; i++) {
    const tau = (i / ascN) * tUp;
    samples.push({ x: hermiteX(tau), y: phY + vYeff * tau - 0.5 * gUp * tau * tau, tSec: thSec + tau });
  }
  for (let i = 1; i <= descN; i++) {
    const td = (i / descN) * tDown;
    const tau = tUp + td;
    samples.push({ x: hermiteX(tau), y: yApex - 0.5 * gDown * td * td, tSec: thSec + tau });
  }
  samples[0] = { x: p0.x, y: p0.y, tSec: 0 };
  samples[samples.length - 1] = { x: xLand, y: yLand, tSec: totalDur };

  // Honest handoff witnesses: RAW detected velocity IN, EFFECTIVE velocity OUT
  // (== the polyline seam velocity). Equal ⇔ no clamp/straighten was needed.
  let hf = { x: phEffX, y: ph.y };
  let ep = { x: xLand, y: yLand };
  let vIn = { x: rawVh.x, y: rawVh.y };
  let vOut = { x: vhEffX, y: vYeff };

  // ── A8 roll: rotate x/y of every sample + the witnesses about frame center in
  //    pixel-aspect space (tSec untouched). Rigid → C1 + horizon-relative apex
  //    preserved. ──
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

  // B1 timing: compress the synthetic segment so the LAST sample tSec ==
  // animDurationSec EXACTLY and every keyTime ≤ 1 (native rejects otherwise).
  const animDurationSec = finalizeTiming(samples, input.maxAnimSec);

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
    seg1Repinned,
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

/**
 * D4 — whole-flight-visible. The detected ball has no upward screen velocity at
 * the handoff (already peaked/descending) or is already at the landing height,
 * so we do NOT fabricate a synthetic apex. Render the REAL detected flight
 * (untouched — seg1Repinned stays false) plus a short LINEAR fade tail that
 * continues the detected velocity. C1 is exact (the tail leaves at the detected
 * V_h). The GPS carry label is kept (distance is still valid).
 */
function buildWholeFlightVisible(
  input: BuildArcInputV2,
  ctx: {
    carryM: number;
    bucket: ShotBucket;
    apexM: number;
    hangS: number;
    curvatureResidual: number;
    latSignFit: -1 | 0 | 1;
    parallaxEstimate: number;
    rollDeg: number;
    N: number;
  },
): TracerRenderSpecV2 {
  const { tracer } = config;
  const arc = tracer.arc;
  const fit = input.fit as DetectedFit; // non-degenerate (caller-guaranteed)
  const N = clamp(ctx.N, 60, 90);
  const thSec = Math.max(fit.thSec, 1e-3);
  const evalX = (t: number) => fit.coeff.x[0] + fit.coeff.x[1] * t + fit.coeff.x[2] * t * t;
  const evalY = (t: number) => fit.coeff.y[0] + fit.coeff.y[1] * t + fit.coeff.y[2] * t * t;
  const vhx = fit.coeff.x[1] + 2 * fit.coeff.x[2] * thSec;
  const vhy = fit.coeff.y[1] + 2 * fit.coeff.y[2] * thSec;
  const ph = { x: evalX(thSec), y: evalY(thSec) };

  const tail = clamp(arc.wholeFlightTailSec, 0.1, Math.max(input.maxAnimSec - thSec, 0.1));
  const seg1N = clamp(Math.round((thSec / (thSec + tail)) * N), 2, N - 2);
  const seg2N = N - seg1N;
  const samples: TracerSampleV2[] = [];
  for (let i = 0; i < seg1N; i++) {
    const t = (i / (seg1N - 1)) * thSec; // REAL detected curve, untouched
    samples.push({ x: evalX(t), y: evalY(t), tSec: t });
  }
  for (let i = 1; i <= seg2N; i++) {
    const tau = (i / seg2N) * tail; // linear tail continuing detected velocity
    samples.push({ x: ph.x + vhx * tau, y: ph.y + vhy * tau, tSec: thSec + tau });
  }
  samples[0] = { x: evalX(0), y: evalY(0), tSec: 0 };

  let hf = { x: ph.x, y: ph.y };
  let ep = { x: samples[samples.length - 1].x, y: samples[samples.length - 1].y };
  let vIn = { x: vhx, y: vhy };
  let vOut = { x: vhx, y: vhy }; // linear tail leaves at exactly V_h → C1 exact
  if (ctx.rollDeg !== 0) {
    const rr = (ctx.rollDeg * Math.PI) / 180;
    const cR = Math.cos(rr);
    const sR = Math.sin(rr);
    for (let i = 0; i < samples.length; i++) {
      const r = rotAboutCenter(samples[i].x, samples[i].y, cR, sR);
      samples[i] = { x: r.x, y: r.y, tSec: samples[i].tSec };
    }
    hf = rotAboutCenter(hf.x, hf.y, cR, sR);
    ep = rotAboutCenter(ep.x, ep.y, cR, sR);
    vIn = rotVec(vIn.x, vIn.y, cR, sR);
    vOut = rotVec(vOut.x, vOut.y, cR, sR);
  }
  const animDurationSec = finalizeTiming(samples, input.maxAnimSec);

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
    meta: {
      tier: input.carry.tier,
      labelText: input.carry.labelText,
      bucket: ctx.bucket,
      carryM: round2(ctx.carryM),
      apexM: round2(ctx.apexM),
      hangS: round2(ctx.hangS),
      degenerate: 'D4',
      endpoint: { x: ep.x, y: ep.y },
      handoff: { x: round2(hf.x), y: round2(hf.y) },
      vHandoffIn: { x: vIn.x, y: vIn.y },
      vHandoffOut: { x: vOut.x, y: vOut.y },
      seg1Repinned: false, // detected segment untouched
      gUp: 0,
      gDown: 0,
      tUpSec: 0,
      tRemSec: round2(tail),
      parallaxEstimate: round2(ctx.parallaxEstimate),
      curvatureResidual: round2(ctx.curvatureResidual),
      override: false,
      lateralSource: 'vision',
      straightBow: input.carry.deltaDeg !== null && Math.abs(input.carry.deltaDeg) < 8,
      latSign: ctx.latSignFit,
      rollDeg: ctx.rollDeg,
      rollExceeded: false,
      offAxis: false,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// S10 — decideTracerPlan: pure orchestration decision (rung ladder + hard
// vetoes). Wires computeShotCarry's tier/label output into the fallback
// ladder from the plan (§2): R0/R1 (GPS-tiered + real vision), R2 (GPS-tiered
// + weak/no vision, synthetic anchor), R3 (vision-anchored, GPS unusable —
// includes last-shot-of-hole, which has no successor fix by construction),
// R4 (dev-only allowPriorOnlyArc escape when NOTHING is usable). Only 5 hard
// vetoes exist and are never faked: putt, no-impact, grounded (ONLY when
// groundedEvidence AND found:false — a grounded decoy can coexist with a real
// found ball), anim-too-short, no-anchor. The old v1 GPS skip reasons
// (gps-accuracy / carry-min / carry-max / bearing-delta / no-next-gps /
// no-heading) are GONE as skips in v2 — they only ever demote the GPS tier
// (via computeShotCarry) or leave gpsTier null, never veto the render.
// ════════════════════════════════════════════════════════════════════════

export type TracerRung = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
export type TracerCarrySource = 'gps' | 'prior' | 'user';
export type TracerHardVeto = 'putt' | 'no-impact' | 'grounded' | 'anim-too-short' | 'no-anchor';

/**
 * The subset of a `local_clips` row decideTracerPlan needs — either the
 * clip's own row or its same-hole successor. Plain data (no SQLite import),
 * so tests build fixtures as literal objects.
 *
 * NOTE on bypass (debugForceTrace / gpsOnlyTrace): when the caller's evidence
 * gates are bypassed and `impact_time_ms` was null, the caller substitutes a
 * synthetic anchor (clip midpoint) into this field BEFORE calling
 * decideTracerPlan — the function always trusts `impact_time_ms` as given.
 */
export interface TracerPlanRow {
  shot_type: string | null;
  impact_time_ms: number | null;
  auto_trim_start_ms: number | null;
  duration_seconds: number | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  /** v2 estimator effAcc (preferred). */
  gps_eff_acc_m: number | null;
  /** v1 mirror / pre-v2 raw one-shot accuracy (fallback when eff_acc is null). */
  gps_accuracy_m: number | null;
  camera_heading_deg: number | null;
  camera_heading_calibration: number | null;
}

/**
 * Minimal ball-detection signal decideTracerPlan needs to pick a rung —
 * deliberately NOT the full BallLaunchResult (width/height/points arrays
 * etc.) so fixtures stay one-liners. `undefined` = detection hasn't run yet
 * (a PRE-detection call — only the vision-independent vetoes below are
 * decidable; the caller uses this to skip a clip BEFORE paying for the
 * Vision pass); `null` = detection was intentionally skipped (gpsOnlyTrace).
 */
export interface TracerVisionSignal {
  found: boolean;
  method: 'vision' | 'none';
  groundedEvidence: boolean;
  poseAnchor: { x: number; y: number } | null;
  pointCount: number;
}

export interface TracerPlanSensors {
  vision: TracerVisionSignal | null | undefined;
  /** config.tracer.debugForceTrace || config.tracer.gpsOnlyTrace — suppresses
   *  the putt and grounded vetoes (never anim-too-short or no-anchor). */
  bypassEvidence?: boolean;
  /** A3: the 3-click penalty gesture (or any pairing break) severed this
   *  clip's successor GPS from being a valid landing — forces GPS Tier3. */
  brokenChain?: boolean;
  /** A3: seconds between this clip and its successor; caps Tier1→Tier2. */
  interClipGapSec?: number | null;
  /** A3: this clip's classified shot bucket, for the carry-plausibility gate. */
  shotBucket?: ShotBucket | null;
  /** S11 dev setting: user-entered default club carry. When set, R3/R4's
   *  prior-driven carrySource is 'user' instead of 'prior' (built-in bucket
   *  average) — purely a tracer_meta provenance flag; buildArcSpecV2 still
   *  derives the actual meters from TRACER_PRIORS/config.tracer.v2.priorCarries. */
  userDefaultCarryM?: number | null;
}

export interface TracerPlan {
  rung: TracerRung;
  carrySource: TracerCarrySource;
  gpsTier: CarryTier | null;
  skipReason?: TracerHardVeto;
  /** The computed GPS carry (when both fixes were usable), for tracer_meta —
   *  callers don't need to re-derive it. Null before GPS was evaluated
   *  (vetoed pre-GPS) or when either fix was missing. */
  carry: ShotCarry | null;
}

function rowToShotFix(row: TracerPlanRow): ShotFix | null {
  if (row.gps_latitude === null || row.gps_longitude === null) return null;
  const effAccM = row.gps_eff_acc_m ?? row.gps_accuracy_m;
  if (effAccM === null || !Number.isFinite(effAccM)) return null;
  return { lat: row.gps_latitude, lon: row.gps_longitude, effAccM };
}

const vetoResult = (
  skipReason: TracerHardVeto,
  gpsTier: CarryTier | null = null,
  carry: ShotCarry | null = null,
): TracerPlan => ({ rung: 'R3', carrySource: 'prior', gpsTier, skipReason, carry });

/**
 * S10 orchestration decision. Pure — no I/O, no native calls. Checks the 5
 * hard vetoes (in F5-ish order: putt → no-impact → anim-too-short, all
 * decidable from `row` alone → grounded → no-anchor, both needing
 * `sensors.vision`), then picks a rung from the GPS tier (computeShotCarry)
 * × vision-quality matrix (plan §2 fallback ladder).
 *
 * Called TWICE in practice: once with `sensors.vision = undefined` so the
 * batch loop can skip a clip (putt/no-impact/anim-too-short) BEFORE running
 * the expensive Vision pass, then again with the real `TracerVisionSignal`
 * once detection has run, for the final rung.
 */
export function decideTracerPlan(
  row: TracerPlanRow,
  nextRow: TracerPlanRow | null,
  sensors: TracerPlanSensors,
): TracerPlan {
  const bypass = sensors.bypassEvidence ?? false;

  // ── Hard veto 1: putt — never synthesize a flight over a putt. ──
  if (row.shot_type === 'putt' && !bypass) return vetoResult('putt');

  // ── Hard veto 2: no-impact — nothing to anchor timing on. ──
  if (row.impact_time_ms === null) return vetoResult('no-impact');

  // ── Hard veto 3: anim-too-short — pure timing, decidable pre-vision. ──
  const impactInClipMs = row.impact_time_ms - (row.auto_trim_start_ms ?? 0);
  const clipDurationSec = row.duration_seconds ?? 0;
  const animStartSec = impactInClipMs / 1000 + config.tracer.headDelaySec;
  const maxAnimSec = clipDurationSec - animStartSec - 0.3;
  if (impactInClipMs < 0 || maxAnimSec < config.tracer.minAnimSec) {
    return vetoResult('anim-too-short');
  }

  // ── GPS carry (own fix + same-hole successor fix; null successor covers
  //    the last-shot-of-hole case by construction — R3 by design). ──
  const ownFix = rowToShotFix(row);
  const succFix = nextRow ? rowToShotFix(nextRow) : null;
  const carry: ShotCarry | null =
    ownFix && succFix
      ? computeShotCarry(ownFix, succFix, row.camera_heading_deg, {
          headingCalibration: row.camera_heading_calibration,
          shotType: sensors.shotBucket ?? null,
          interClipGapSec: sensors.interClipGapSec ?? null,
          brokenChain: sensors.brokenChain ?? false,
        })
      : null;
  const gpsTier: CarryTier | null = carry?.tier ?? null;
  const gpsUsable = gpsTier === 1 || gpsTier === 2;

  // ── Pre-detection call: only the vision-independent vetoes above are
  //    decidable. Return a provisional rung (ignored by the caller except
  //    for `skipReason`, which is undefined here) so the batch loop knows
  //    whether to bother running detectBallLaunch at all. ──
  if (sensors.vision === undefined) {
    const carrySource: TracerCarrySource = gpsUsable
      ? 'gps'
      : sensors.userDefaultCarryM != null
        ? 'user'
        : 'prior';
    return {
      rung: gpsTier === 1 ? 'R0' : gpsTier === 2 ? 'R1' : 'R3',
      carrySource,
      gpsTier,
      carry,
    };
  }

  const vision = sensors.vision; // TracerVisionSignal | null (null = gpsOnlyTrace)

  // ── Hard veto 4: grounded — a blob was observed but never gained altitude
  //    (topped/rolling), AND no real ball was separately found. Never
  //    synthesize a flying arc over a rolling ball. ──
  if (!bypass && vision?.groundedEvidence === true && vision.found === false) {
    return vetoResult('grounded', gpsTier, carry);
  }

  const visionFound = !!vision && vision.found && vision.method === 'vision';
  const hasPoseAnchor = !!vision?.poseAnchor;
  const hasAnyPoints = (vision?.pointCount ?? 0) >= 1;
  const nothingVisual = !visionFound && !hasPoseAnchor && !hasAnyPoints;

  // ── Hard veto 5 / R4: truly nothing to anchor on AND GPS is unusable.
  //    allowPriorOnlyArc (dev-only) is the ONLY escape — else veto. ──
  if (nothingVisual && !gpsUsable) {
    if (!config.tracer.v2.allowPriorOnlyArc) return vetoResult('no-anchor', gpsTier, carry);
    const carrySource: TracerCarrySource = sensors.userDefaultCarryM != null ? 'user' : 'prior';
    return { rung: 'R4', carrySource, gpsTier, carry };
  }

  // ── Rung matrix: GPS tier × vision quality. ──
  let rung: TracerRung;
  if (gpsTier === 1 && visionFound) rung = 'R0';
  else if (gpsTier === 2 && visionFound) rung = 'R1';
  else if (gpsUsable) rung = 'R2'; // Tier1/2 + weak/no vision — GPS drives it
  else rung = 'R3'; // GPS unusable but SOME anchor exists (vision or pose)

  const carrySource: TracerCarrySource = gpsUsable
    ? 'gps'
    : sensors.userDefaultCarryM != null
      ? 'user'
      : 'prior';

  return { rung, carrySource, gpsTier, carry };
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
  const animDurationSec = finalizeTiming(samples, input.maxAnimSec);
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
    meta: {
      tier: input.carry.tier,
      labelText: input.carry.labelText,
      bucket,
      carryM: round2(carryM),
      apexM: 0,
      hangS: round2(hangTimeSec(0)),
      degenerate: 'D6',
      endpoint: { x: samples[samples.length - 1].x, y: samples[samples.length - 1].y },
      handoff: { x: round2(anchor.x), y: round2(anchor.y) },
      vHandoffIn: { x: 0, y: 0 },
      vHandoffOut: { x: 0, y: 0 },
      seg1Repinned: false,
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
  const animDurationSec = finalizeTiming(samples, input.maxAnimSec);
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
      seg1Repinned: false,
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
