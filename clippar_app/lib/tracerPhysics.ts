/**
 * Golf-ball flight physics for the v3 shot tracer. Pure TypeScript — no React,
 * no native imports, no I/O — so every function here is unit-testable under
 * `node --test` and runs unchanged inside the fit loop on a phone.
 *
 * This is a faithful port of `tracer-lab/lib/flight.py` (see
 * `tracer-lab/experiments/flight/report.md`). Nothing was re-derived: the
 * coefficients, the spin-decay rate, the club priors and the sign conventions
 * below are the lab's, and the tests pin the lab's own numbers.
 *
 * ─── World frame (shared with lib/tracerCamera.ts and the lab) ───
 * Right-handed, metres. Origin = the ground point directly below the camera.
 * X forward (down the optical axis), Y LEFT, Z up. The ball launches from the
 * origin of this module's own frame (0,0,0) — the caller translates.
 *
 * NOTE the frame difference from the rest of the app: `lib/tracerMath.ts` (the
 * v1/v2 tracer) works in normalized 0..1 BOTTOM-LEFT screen coordinates. This
 * module is metres in the world. Exactly one function converts world/pixel
 * geometry into the render spec, and it lives in `lib/tracerV3.ts`.
 *
 * ─── Physics ───
 *     m dv/dt = m g + ½ ρ A |v| ( −Cd v + Cl (ω̂ × v) )
 *     Cd(S) = cd0 + cd1·S
 *     Cl(S) = min(clA·S^clP, clMax)          S = ω r / |v|   (spin ratio)
 *     ω(t)  = ω₀ e^(−spinDecay·t)            axis fixed in inertial space
 *
 * ─── Honesty, carried across from the lab report (do not soften these) ───
 * • The *form* of Cd(S) / Cl(S) is the standard one from wind-tunnel work on
 *   dimpled balls (Bearman & Harvey 1976; Smits & Smith 1994; Penner 2003).
 *   The *numbers* were NOT taken from those papers. They are a five-parameter
 *   least-squares calibration to nine TrackMan tour-average numbers, done in
 *   the lab (`experiments/flight/tune.py`, variant H). Treat this as a
 *   calibrated interpolation across the golf envelope, not an aerodynamic
 *   measurement.
 * • The lift cap is load-bearing, not a hack. Three simpler forms were fitted
 *   and all failed: an uncapped power law and a linear Cl both miss the 7-iron
 *   landing angle by ~4°, and a rational-saturation Cl breaks the driver on all
 *   four metrics. Saturating Cl at ≈0.33 above S≈0.31 is what lets the 7-iron
 *   land steeply while the wedge apex stays right. Its exact level is fitted.
 * • Landing angle carries a systematic ~3° SHALLOW bias on every iron-type shot
 *   checked, fitted or held-out (probably the missing Reynolds-number drag rise
 *   as the ball slows, which this model omits). Nothing downstream may treat a
 *   simulated landing angle as better than ±4°.
 * • CLUB_PRIORS are recollected typical amateur values, not data. They seed a
 *   fit; the footage must be allowed to override them.
 */

// ─── Constants (tracer-lab/lib/flight.py) ───

/** m/s². */
export const G = 9.81;
/** kg/m³ — the value the lab's coefficients were fitted at. Changing it invalidates them. */
export const RHO_AIR = 1.2;
/** kg — R&A/USGA maximum ball mass. */
export const BALL_MASS_KG = 0.04593;
/** m — R&A/USGA minimum ball diameter; the same constant the camera module uses. */
export const BALL_DIAMETER_M = 0.04267;
export const BALL_RADIUS_M = BALL_DIAMETER_M / 2;
export const BALL_AREA_M2 = Math.PI * BALL_RADIUS_M * BALL_RADIUS_M;

const RPM_TO_RAD_S = (2 * Math.PI) / 60;
const DEG = Math.PI / 180;

/**
 * Aerodynamic coefficient model. `Cd(S) = cd0 + cd1·S`,
 * `Cl(S) = min(clA·S^clP, clMax)`, spin magnitude decaying at `spinDecay` per
 * second. Exposed so tests (and only tests) can vary it — production always
 * uses DEFAULT_AERO.
 */
export interface AeroModel {
  cd0: number;
  cd1: number;
  clA: number;
  clP: number;
  clMax: number;
  /** 1/s. 0.045 = 4.5 %/s, held fixed during the lab's fit. */
  spinDecay: number;
  name: string;
}

/**
 * Variant H of `tracer-lab/experiments/flight/variants2.py` — the chosen fit.
 * Worst residual across the nine TrackMan targets: 0.75 of tolerance.
 */
export const DEFAULT_AERO: AeroModel = {
  cd0: 0.2103,
  cd1: 0.2908,
  clA: 0.6912,
  clP: 0.6243,
  clMax: 0.3291,
  spinDecay: 0.045,
  name: 'lab-tuned-H-2026-09-05',
};

// ─── Types ───

/** One trajectory sample. Seconds from impact; metres in the world frame. */
export interface FlightSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

export interface FlightSummary {
  /** Ground distance from launch to landing = hypot(x, y). This is what a GPS
   *  distance to the next shot measures, which is why it is not just `x`. */
  carryM: number;
  /** Maximum height above the launch plane, sampled (not interpolated). */
  apexM: number;
  hangS: number;
  /** Degrees below horizontal at ground contact. Systematically ~3° shallow — see the header. */
  landAngleDeg: number;
  /** Signed lateral offset at landing; positive = LEFT of the launch line. */
  lateralM: number;
}

/** Launch conditions a Flight was produced from (echoed back for diagnostics). */
export interface LaunchConditions {
  v0: number;
  thetaDeg: number;
  phiDeg: number;
  rpmBack: number;
  rpmSide: number;
}

export interface Flight {
  /** Every `dt` from t = 0, with the final sample interpolated to z = 0 exactly. */
  samples: FlightSample[];
  summary: FlightSummary;
  /** Linear interpolation of position at time t, clamped to [0, hang]. */
  at(t: number): { x: number; y: number; z: number };
  /** Fixed step actually used (the last interval is shorter — it is the ground crossing). */
  readonly dt: number;
  /** Velocity at ground contact, m/s. `landAngleDeg` is derived from it. */
  readonly vLand: { x: number; y: number; z: number };
  readonly launch: LaunchConditions;
  /** Time of the highest sample. Used by the renderer to place an apex label. */
  readonly apexTSec: number;
}

/**
 * Club buckets. The first four are `tracer-lab/lib/flight.py: CLUB_PRIORS`;
 * `pitch` is the soft chip/pitch bucket the lab added later, in
 * `tracer-lab/lib/fit.py: EXTRA_PRIORS`, for shots far below a full wedge.
 */
export type Bucket = 'driver' | 'longIron' | 'shortIron' | 'wedge' | 'pitch';

/** [lo, typical, hi]. `sigma` for a fit prior is the full width (hi − lo). */
export type PriorBand = [number, number, number];

export interface ClubPrior {
  thetaDeg: PriorBand;
  rpmBack: PriorBand;
  v0: PriorBand;
  /** Plausible carry band, metres, used to pick a bucket from a GPS carry. */
  carryM: [number, number];
  /** Roll as a fraction of carry — `tracer-lab/lib/fit.py: ROLL_PRIORS`. Used
   *  by the fit's GPS carry model, where the GPS distance is carry + roll. */
  rollFrac: [number, number];
}

/**
 * Amateur (mid-handicap male) launch priors. **These are priors, not
 * measurements** — assembled in the lab from recollected published TrackMan /
 * Foresight amateur averages plus Henry's own 55–68 m/s driver ball-speed band.
 * Nothing here was measured from Henry's footage.
 *
 * Bucket names are camelCase here and snake_case in the lab JSON; see
 * `bucketFromLabName`.
 *
 * The `pitch` row is DERIVED, not quoted: the lab states that bucket only as a
 * Gaussian prior (`Prior("pitch", v0=20, v0σ=12, θ=35, θσ=12, rpm=5000,
 * lnRpmσ=0.7)`). Inverting `fit.py: make_prior`'s own convention — σ = full
 * band width for v0/θ, ln(hi/lo) for spin — gives v0 20±6, θ 35±6 and
 * rpm 5000·e^∓0.35 = 3523…7095. Its carry band is not stated anywhere in the
 * lab; [0, 55] m simply says "shorter than the wedge band's lower edge", and
 * `inferLaunch` never selects it (see there).
 */
export const CLUB_PRIORS: Record<Bucket, ClubPrior> = {
  driver: {
    thetaDeg: [9, 13, 17],
    rpmBack: [2200, 3200, 4500],
    v0: [55, 61, 68],
    carryM: [160, 235],
    rollFrac: [0.05, 0.15],
  },
  // 3-wood / hybrid / 4–6 iron.
  longIron: {
    thetaDeg: [12, 15.5, 20],
    rpmBack: [3500, 5000, 6500],
    v0: [44, 50, 57],
    carryM: [140, 190],
    rollFrac: [0.03, 0.08],
  },
  // 7–9 iron.
  shortIron: {
    thetaDeg: [16, 20, 25],
    rpmBack: [5500, 7000, 8500],
    v0: [38, 44, 50],
    carryM: [105, 150],
    rollFrac: [0.03, 0.08],
  },
  // PW–SW full swings.
  wedge: {
    thetaDeg: [22, 27, 34],
    rpmBack: [7000, 8500, 10500],
    v0: [28, 36, 42],
    carryM: [55, 115],
    rollFrac: [0.0, 0.05],
  },
  // Soft pitch / chip. Derived — see the doc comment above.
  pitch: {
    thetaDeg: [29, 35, 41],
    rpmBack: [3523.44, 5000, 7095.34],
    v0: [14, 20, 26],
    carryM: [0, 55],
    rollFrac: [0.0, 0.05],
  },
};

/**
 * Buckets `inferLaunch` is allowed to choose between. Deliberately excludes
 * `pitch`: the lab's `infer_launch` reads `flight.CLUB_PRIORS`, which has four
 * entries, and adding a fifth overlapping band would silently change which
 * bucket a 55–60 m carry lands in. `pitch` is selectable only by an explicit
 * caller (the decision ladder, which knows a chip when it sees one).
 */
const INFERABLE_BUCKETS: Bucket[] = ['driver', 'longIron', 'shortIron', 'wedge'];

/** Lab JSON (detection files, `lib/tracer.py: BUCKET`) uses snake_case. */
const LAB_BUCKET_NAMES: Record<string, Bucket> = {
  driver: 'driver',
  long_iron: 'longIron',
  short_iron: 'shortIron',
  wedge: 'wedge',
  pitch: 'pitch',
};

/**
 * Map a lab bucket name onto ours. Returns null for anything else — including
 * the lab's `generic`, which is the *absence* of a bucket and must stay
 * distinguishable from a real one.
 */
export function bucketFromLabName(name: string): Bucket | null {
  return LAB_BUCKET_NAMES[name] ?? null;
}

// ─── Spin geometry ───

/**
 * Unit spin axis and magnitude (rad/s) for a launch.
 *
 * Backspin axis: horizontal, perpendicular to the launch azimuth, pointing to
 * the ball's RIGHT, so that ω × v points up when φ = 0 (axis = −Y).
 * Sidespin axis: +Z, so positive `rpmSide` pushes the ball toward +Y = LEFT.
 */
export function spinVector(
  /** Launch azimuth. (The lab's `spin_vector` also takes theta and never uses
   *  it — the axis is horizontal regardless of launch angle — so it is not a
   *  parameter here.) */
  phiDeg: number,
  rpmBack: number,
  rpmSide: number
): { nx: number; ny: number; nz: number; omega: number } {
  const phi = phiDeg * DEG;
  const wb = rpmBack * RPM_TO_RAD_S;
  const ws = rpmSide * RPM_TO_RAD_S;
  // Right-of-flight horizontal unit vector for a heading (cos φ, sin φ).
  const rx = Math.sin(phi);
  const ry = -Math.cos(phi);
  const wx = wb * rx;
  const wy = wb * ry;
  const wz = ws;
  const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (w < 1e-12) return { nx: 0, ny: -1, nz: 0, omega: 0 };
  return { nx: wx / w, ny: wy / w, nz: wz / w, omega: w };
}

/**
 * TrackMan-style spin-axis tilt in degrees: positive = tilted RIGHT = a fade
 * for a right-hander. Our `rpmSide` is positive-LEFT, so the sign flips.
 */
export function spinAxisTiltDeg(rpmBack: number, rpmSide: number): number {
  return -Math.atan2(rpmSide, rpmBack) / DEG;
}

/** Inverse of `spinAxisTiltDeg`: split a total spin at a TrackMan tilt. */
export function spinFromAxis(
  rpmTotal: number,
  tiltDeg: number
): { rpmBack: number; rpmSide: number } {
  const a = tiltDeg * DEG;
  return { rpmBack: rpmTotal * Math.cos(a), rpmSide: -rpmTotal * Math.sin(a) };
}

// ─── Integrator ───

/** Default step. The lab validated and fitted at 1/120 s; `lib/fit.py` uses it too. */
export const DEFAULT_DT = 1 / 120;

export interface SimulateArgs {
  /** Ball speed at impact, m/s. */
  v0: number;
  /** Launch angle above horizontal, degrees. */
  thetaDeg: number;
  /** Launch azimuth, degrees, positive = LEFT of +X. */
  phiDeg?: number;
  rpmBack?: number;
  /** Positive curves the ball LEFT (draw/hook for a right-hander). */
  rpmSide?: number;
  dt?: number;
  /** Test-only overrides. Production leaves all three alone. */
  model?: AeroModel;
  /** Air density; 0 gives the analytic vacuum parabola the tests check against. */
  rhoAir?: number;
  z0?: number;
  maxTSec?: number;
}

class SimulatedFlight implements Flight {
  readonly samples: FlightSample[];
  readonly summary: FlightSummary;
  readonly dt: number;
  readonly vLand: { x: number; y: number; z: number };
  readonly launch: LaunchConditions;
  readonly apexTSec: number;

  constructor(
    samples: FlightSample[],
    vLand: { x: number; y: number; z: number },
    launch: LaunchConditions,
    dt: number
  ) {
    this.samples = samples;
    this.vLand = vLand;
    this.launch = launch;
    this.dt = dt;

    let apexM = -Infinity;
    let apexTSec = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].z > apexM) {
        apexM = samples[i].z;
        apexTSec = samples[i].t;
      }
    }
    this.apexTSec = apexTSec;

    const last = samples[samples.length - 1];
    this.summary = {
      carryM: Math.hypot(last.x, last.y),
      apexM,
      hangS: last.t,
      landAngleDeg:
        Math.atan2(-vLand.z, Math.hypot(vLand.x, vLand.y)) / DEG,
      lateralM: last.y,
    };
  }

  at(t: number): { x: number; y: number; z: number } {
    const s = this.samples;
    if (t <= 0) return { x: s[0].x, y: s[0].y, z: s[0].z };
    const last = s[s.length - 1];
    if (t >= last.t) return { x: last.x, y: last.y, z: last.z };
    // Uniform steps except the final (ground-crossing) one, so the index guess
    // is exact everywhere but the tail; the two while loops fix it up.
    let i = Math.min(Math.floor(t / this.dt), s.length - 2);
    while (s[i + 1].t < t) i++;
    while (s[i].t > t) i--;
    const a = s[i];
    const b = s[i + 1];
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return {
      x: a.x + f * (b.x - a.x),
      y: a.y + f * (b.y - a.y),
      z: a.z + f * (b.z - a.z),
    };
  }
}

/**
 * RK4 fixed-step flight from impact to ground contact.
 *
 * Scalar doubles throughout with no allocation inside the derivative — the
 * acceleration is written into one reusable 3-vector — because this runs a few
 * hundred times inside `lib/tracerFit.ts`'s optimiser on a phone. The lab
 * measured ~1 ms per flight in CPython at 120 Hz; the ported cost is asserted
 * by `tests/tracerPhysics.test.ts` rather than assumed.
 */
export function simulate(a: SimulateArgs): Flight {
  const dt = a.dt ?? DEFAULT_DT;
  const model = a.model ?? DEFAULT_AERO;
  const rho = a.rhoAir ?? RHO_AIR;
  const phiDeg = a.phiDeg ?? 0;
  const rpmBack = a.rpmBack ?? 0;
  const rpmSide = a.rpmSide ?? 0;
  const maxT = a.maxTSec ?? 20;

  const th = a.thetaDeg * DEG;
  const ph = phiDeg * DEG;
  const vh = a.v0 * Math.cos(th);

  let x = 0;
  let y = 0;
  let z = a.z0 ?? 0;
  let vx = vh * Math.cos(ph);
  let vy = vh * Math.sin(ph);
  let vz = a.v0 * Math.sin(th);

  const { nx, ny, nz, omega: w0 } = spinVector(phiDeg, rpmBack, rpmSide);
  const k = (rho * BALL_AREA_M2) / (2 * BALL_MASS_KG); // 1/m
  const lam = model.spinDecay;
  const r = BALL_RADIUS_M;
  const { cd0, cd1, clA, clP, clMax } = model;

  // Reused across all four RK4 stages of every step: the derivative allocates nothing.
  const acc = new Float64Array(3);

  // (t, velocity) -> acceleration, written into `acc`. `ux/uy/uz` are the
  // velocity components of whichever RK4 stage is being evaluated.
  const accel = (t: number, ux: number, uy: number, uz: number): void => {
    const v = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (v < 1e-9) {
      acc[0] = 0;
      acc[1] = 0;
      acc[2] = -G;
      return;
    }
    const w = w0 * Math.exp(-lam * t);
    const S = (w * r) / v;
    const cd = cd0 + cd1 * S;
    let cl = 0;
    if (S > 0) {
      cl = clA * Math.pow(S, clP);
      if (cl > clMax) cl = clMax;
    }
    const kd = -k * cd * v;
    const kl = k * cl * v;
    // ω̂ × v
    const cx = ny * uz - nz * uy;
    const cy = nz * ux - nx * uz;
    const cz = nx * uy - ny * ux;
    acc[0] = kd * ux + kl * cx;
    acc[1] = kd * uy + kl * cy;
    acc[2] = kd * uz + kl * cz - G;
  };

  const samples: FlightSample[] = [{ t: 0, x, y, z }];
  let t = 0;
  const h = dt;
  const h2 = 0.5 * dt;
  const h6 = dt / 6;
  let vLand = { x: vx, y: vy, z: vz };

  while (t < maxT) {
    accel(t, vx, vy, vz);
    const ax1 = acc[0];
    const ay1 = acc[1];
    const az1 = acc[2];

    const vx2 = vx + h2 * ax1;
    const vy2 = vy + h2 * ay1;
    const vz2 = vz + h2 * az1;
    accel(t + h2, vx2, vy2, vz2);
    const ax2 = acc[0];
    const ay2 = acc[1];
    const az2 = acc[2];

    const vx3 = vx + h2 * ax2;
    const vy3 = vy + h2 * ay2;
    const vz3 = vz + h2 * az2;
    accel(t + h2, vx3, vy3, vz3);
    const ax3 = acc[0];
    const ay3 = acc[1];
    const az3 = acc[2];

    const vx4 = vx + h * ax3;
    const vy4 = vy + h * ay3;
    const vz4 = vz + h * az3;
    accel(t + h, vx4, vy4, vz4);
    const ax4 = acc[0];
    const ay4 = acc[1];
    const az4 = acc[2];

    const nX = x + h6 * (vx + 2 * vx2 + 2 * vx3 + vx4);
    const nY = y + h6 * (vy + 2 * vy2 + 2 * vy3 + vy4);
    const nZ = z + h6 * (vz + 2 * vz2 + 2 * vz3 + vz4);
    const nVx = vx + h6 * (ax1 + 2 * ax2 + 2 * ax3 + ax4);
    const nVy = vy + h6 * (ay1 + 2 * ay2 + 2 * ay3 + ay4);
    const nVz = vz + h6 * (az1 + 2 * az2 + 2 * az3 + az4);

    if (nZ < 0) {
      // The ball starts on the ground going up, so the first z < 0 is landing.
      // Linear interpolation to the ground crossing (the step is 8 ms; the
      // error this introduces is far below the model's own).
      const f = z !== nZ ? z / (z - nZ) : 1;
      samples.push({
        t: t + f * h,
        x: x + f * (nX - x),
        y: y + f * (nY - y),
        z: 0,
      });
      vLand = {
        x: vx + f * (nVx - vx),
        y: vy + f * (nVy - vy),
        z: vz + f * (nVz - vz),
      };
      break;
    }

    x = nX;
    y = nY;
    z = nZ;
    vx = nVx;
    vy = nVy;
    vz = nVz;
    t += h;
    samples.push({ t, x, y, z });
    vLand = { x: vx, y: vy, z: vz };
  }

  return new SimulatedFlight(
    samples,
    vLand,
    { v0: a.v0, thetaDeg: a.thetaDeg, phiDeg, rpmBack, rpmSide },
    dt
  );
}

// ─── Inverse ───

export interface SolveV0Options {
  loMS?: number;
  hiMS?: number;
  tolM?: number;
  dt?: number;
  model?: AeroModel;
  maxIterations?: number;
}

/**
 * Ball speed (m/s) that carries `carryM` at the given launch angle and spin,
 * by bisection. Carry is monotonic in v0 over the golf range for fixed launch
 * and spin (checked numerically in the tests, as the lab did).
 *
 * Throws when the target lies outside the bracket — the caller must decide
 * what an unreachable carry means, and a silently clamped v0 would be a
 * fabricated number.
 */
export function solveV0ForCarry(
  carryM: number,
  thetaDeg: number,
  rpmBack: number,
  rpmSide: number = 0,
  opts: SolveV0Options = {}
): number {
  let lo = opts.loMS ?? 15;
  let hi = opts.hiMS ?? 100;
  const tol = opts.tolM ?? 0.05;
  const maxIterations = opts.maxIterations ?? 60;
  const carry = (v: number): number =>
    simulate({
      v0: v,
      thetaDeg,
      phiDeg: 0,
      rpmBack,
      rpmSide,
      dt: opts.dt,
      model: opts.model,
    }).summary.carryM;

  const cLo = carry(lo);
  const cHi = carry(hi);
  if (!(cLo <= carryM && carryM <= cHi)) {
    throw new Error(
      `carry ${carryM.toFixed(1)} m outside bracket [${cLo.toFixed(1)}, ${cHi.toFixed(1)}] m ` +
        `for theta=${thetaDeg}, spin=${rpmBack}`
    );
  }
  for (let i = 0; i < maxIterations; i++) {
    const mid = 0.5 * (lo + hi);
    const c = carry(mid);
    if (Math.abs(c - carryM) < tol) return mid;
    if (c < carryM) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export interface InferredLaunch {
  bucket: Bucket;
  v0: number;
  thetaDeg: number;
  rpmBack: number;
  /** False when the solved v0 falls outside the bucket's plausible band — a
   *  sign the carry and the bucket disagree, which the fit should not hide. */
  v0InRange: boolean;
}

/**
 * Seed launch parameters from a known carry (the GPS distance to the next
 * shot). With no `bucket`, picks the bucket whose carry band contains
 * `carryM`; ties go to the higher-launch bucket, which is the amateur-typical
 * choice. The bands overlap on purpose — a carry alone cannot tell a hard
 * 8-iron from an easy 6-iron, and only the launch angle seen in the first
 * frames breaks the tie.
 */
export function inferLaunch(carryM: number, bucket?: Bucket): InferredLaunch {
  let chosen: Bucket;
  if (bucket) {
    chosen = bucket;
  } else {
    const inBand = INFERABLE_BUCKETS.filter(
      (b) => CLUB_PRIORS[b].carryM[0] <= carryM && carryM <= CLUB_PRIORS[b].carryM[1]
    );
    const candidates =
      inBand.length > 0
        ? inBand
        : // Outside every band: fall back to the nearest band edge.
          [...INFERABLE_BUCKETS].sort((p, q) => bandDistance(p, carryM) - bandDistance(q, carryM)).slice(0, 1);
    chosen = candidates.reduce((best, b) =>
      CLUB_PRIORS[b].thetaDeg[1] > CLUB_PRIORS[best].thetaDeg[1] ? b : best
    );
  }
  const prior = CLUB_PRIORS[chosen];
  const v0 = solveV0ForCarry(carryM, prior.thetaDeg[1], prior.rpmBack[1]);
  return {
    bucket: chosen,
    v0,
    thetaDeg: prior.thetaDeg[1],
    rpmBack: prior.rpmBack[1],
    v0InRange: prior.v0[0] <= v0 && v0 <= prior.v0[2],
  };
}

function bandDistance(bucket: Bucket, carryM: number): number {
  const [lo, hi] = CLUB_PRIORS[bucket].carryM;
  return Math.min(Math.abs(carryM - lo), Math.abs(carryM - hi));
}

// ─── Validation against TrackMan ───

export interface ValidationTarget {
  v0: number;
  thetaDeg: number;
  rpmBack: number;
  carryM: number;
  apexM: number;
  /** null = no published target for this club; reported but not scored. */
  hangS: number | null;
  landAngleDeg: number | null;
}

/**
 * TrackMan PGA Tour averages, quoted in `tracer-lab/CONVENTIONS.md`. These are
 * the nine numbers the coefficient model was fitted to; they are a consistency
 * check on the port, NOT independent evidence that the model is right.
 */
export const VALIDATION_TARGETS: Record<string, ValidationTarget> = {
  driver: { v0: 75.0, thetaDeg: 10.9, rpmBack: 2686, carryM: 251, apexM: 29, hangS: 6.4, landAngleDeg: 38 },
  sevenIron: { v0: 54.0, thetaDeg: 16.3, rpmBack: 7097, carryM: 157, apexM: 29, hangS: null, landAngleDeg: 50 },
  pitchingWedge: { v0: 46.0, thetaDeg: 24.2, rpmBack: 9304, carryM: 124, apexM: 27, hangS: null, landAngleDeg: null },
};

/** Tolerances from the lab's task brief. */
export const VALIDATION_TOLERANCE = {
  carryRel: 0.05,
  apexRel: 0.15,
  hangRel: 0.1,
  landAbsDeg: 4.0,
};
