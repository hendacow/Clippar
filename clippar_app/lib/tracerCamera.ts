/**
 * Pinhole camera model for the v3 shot tracer. Pure TypeScript — no React, no
 * native imports, no I/O — so it is unit-testable and runs inside the fit loop.
 *
 * Port of `tracer-lab/lib/camera.py` (see `tracer-lab/experiments/camera/report.md`),
 * de-vectorised: the lab worked on (N,2) numpy arrays, this works on one point
 * at a time (or a small array for `project`), because the app never has more
 * than a few hundred points and allocation is the cost that matters on a phone.
 *
 * ─── Frames ───
 * World: right-handed metres, origin = the ground point directly below the
 * camera, X forward (optical axis projected on the ground), Y LEFT, Z up.
 * Camera centre at (0, 0, hCamM). Yaw is 0 by construction; pitch is positive
 * looking DOWN; roll is positive when the right end of the horizon drops.
 *
 * Pixels: **display-oriented frame, TOP-LEFT origin, x right, y down**, in
 * pixels of the native frame (1080x1920 portrait for the app's recordings).
 * This is the detector's frame and the lab's frame. It is NOT the app's
 * existing render frame — `lib/tracerMath.ts` and the native `TracerRenderSpec`
 * are normalized 0..1 BOTTOM-LEFT. Exactly one function converts, and it lives
 * in `lib/tracerV3.ts`. Do not convert here.
 *
 * Internally the usual OpenCV camera axes are used (Xc right, Yc down, Zc
 * forward): with pitch = roll = 0, world (X, Y, Z) maps to (−Y, −Z, X).
 *
 * ─── What this model can and cannot know (measured in the lab, not assumed) ───
 * Every static cue in a single-depth golf scene — ball diameter, golfer height,
 * horizon, ground plane — fixes a RATIO (range/fPx or hCam/range), never fPx
 * itself. The lab confirmed this numerically: scanning fPx over 1331–1704 px
 * moved hCam by under 1 %. So fPx has to come from outside the footage.
 *
 * **This is the one place the app is better than the lab, and why
 * `fPxIsPrior` is a first-class field.** The lab's clips carried no usable FOV
 * metadata, so it used a 24 mm-equivalent prior with an unknown stabilisation
 * crop: a ±12 % systematic. On the phone we read the focal length from
 * `AVCaptureDevice` (intrinsics delivery, else `videoFieldOfView` ÷ zoom), so
 * it is a measurement. The consequence the lab measured, which every consumer
 * must respect: **ball speed and carry inherit the fPx error 1:1.** A ±12 %
 * prior gives ±12 % on carry; device intrinsics give ~±2 %. Anything that
 * quotes a distance has to widen its error bar when `fPxIsPrior` is true —
 * that is what `lib/tracerFit.ts`'s `fpxFrac` term is for.
 */
import { BALL_DIAMETER_M, BALL_RADIUS_M } from './tracerPhysics';

const DEG = Math.PI / 180;

/** Row-major 3x3. */
type Mat3 = [number, number, number, number, number, number, number, number, number];

/** A pixel in the display-oriented, top-left-origin frame. */
export interface Px {
  x: number;
  y: number;
}

/** A point in the world frame, metres. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraParams {
  /** Focal length in pixels of the recorded frame. */
  fPx: number;
  width: number;
  height: number;
  /** Positive = the camera is looking DOWN. CoreMotion supplies this, ±0.5°. */
  pitchDownDeg: number;
  /** Positive = the right end of the horizon drops. On a tripod, expect < 1°. */
  rollDeg: number;
  /** Camera height above the ground, metres. */
  hCamM: number;
  /**
   * True when `fPx` came from lens metadata / a FOV assumption (±12 %), false
   * when it came from `AVCaptureDevice` intrinsics (~±2 %). Ball speed and
   * carry inherit this error 1:1 — see the module header.
   */
  fPxIsPrior: boolean;
}

/**
 * What an apparent diameter measurement actually measured. A sphere's
 * silhouette is an ellipse once it is off-axis, so the three differ:
 * `radial` (along the line from the principal point) is the largest,
 * `tangential` (across it) the smallest, and `equivalent` = 2·√(a·b) is what a
 * circle or area fit returns. The lab's detector reports `equivalent`.
 */
export type DiameterKind = 'radial' | 'tangential' | 'equivalent';

// ─── Small matrix helpers (kept in the lab's shape so the port is checkable) ───

function rotX(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function rotZ(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function mul(A: Mat3, B: Mat3): Mat3 {
  const M = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      M[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    }
  }
  return M as Mat3;
}

/** World → camera axis swap at pitch = roll = 0: Xc = −Y, Yc = −Z, Zc = X. */
const AXES: Mat3 = [0, -1, 0, 0, 0, -1, 1, 0, 0];

// ─── Focal length helpers ───

/** Focal length in pixels for a field of view spanning `axisPx` pixels. */
export function fPxFromFovDeg(fovDeg: number, axisPx: number): number {
  return (0.5 * axisPx) / Math.tan((fovDeg * DEG) / 2);
}

/** Inverse of `fPxFromFovDeg`. */
export function fovDegFromFPx(fPx: number, axisPx: number): number {
  return (2 * Math.atan((0.5 * axisPx) / fPx)) / DEG;
}

/**
 * Focal length in pixels from a lens' 35 mm-equivalent focal length — the
 * FALLBACK path, and the one the lab was stuck with. Equivalence is by
 * diagonal FOV of the full 4:3 sensor against the 43.27 mm full-frame
 * diagonal; video keeps the sensor's full width (the long axis) and crops the
 * height to 16:9, then video stabilisation narrows the FOV by a further linear
 * `crop` factor which is NOT reported anywhere. That unknown crop is the ±12 %
 * systematic — which is exactly why the app should read the device intrinsics
 * instead and set `fPxIsPrior: false`.
 */
export function fPxFrom35mmEquiv(
  equivMm: number,
  width: number,
  height: number,
  crop = 1.0,
  sensorAspect = 4 / 3
): number {
  const longPx = Math.max(width, height);
  const halfDiag = Math.atan(43.27 / 2 / equivMm);
  const diagNorm = Math.hypot(sensorAspect, 1.0); // 4:3 → 5
  const halfLongTan = (Math.tan(halfDiag) * sensorAspect) / diagNorm;
  return (0.5 * longPx) / (halfLongTan / crop);
}

// ─── The camera ───

export class TracerCamera {
  readonly params: CameraParams;
  /** Principal point. The lab puts it at the frame centre and so do we: the
   *  contract carries no cx/cy, and the device's true principal point differs
   *  from the centre by a few pixels at most. */
  readonly cx: number;
  readonly cy: number;
  /** World → camera rotation. x_cam = R · (x_world − C). */
  private readonly R: Mat3;

  constructor(p: CameraParams) {
    this.params = p;
    // (width − 1) / 2, not width / 2 — the lab's convention, kept so the
    // per-clip calibration fixtures reproduce to the last digit.
    this.cx = (p.width - 1) / 2;
    this.cy = (p.height - 1) / 2;
    this.R = mul(rotZ(p.rollDeg * DEG), mul(rotX(p.pitchDownDeg * DEG), AXES));
  }

  /** Camera centre in world coordinates. */
  get centre(): Vec3 {
    return { x: 0, y: 0, z: this.params.hCamM };
  }

  /** A copy with some parameters replaced. */
  with(overrides: Partial<CameraParams>): TracerCamera {
    return new TracerCamera({ ...this.params, ...overrides });
  }

  /**
   * A copy pitched down by `dPitchDeg` more. This is the fit's pitch nuisance
   * parameter: CoreMotion is good to ~0.5°, and pitch maps 1:1 into launch
   * angle, so the fit is allowed to move it a little against the pixels.
   */
  withPitchDelta(dPitchDeg: number): TracerCamera {
    return this.with({ pitchDownDeg: this.params.pitchDownDeg + dPitchDeg });
  }

  /** World point → camera frame (Xc right, Yc down, Zc forward). */
  toCamera(p: Vec3): Vec3 {
    const dx = p.x;
    const dy = p.y;
    const dz = p.z - this.params.hCamM;
    const R = this.R;
    return {
      x: R[0] * dx + R[1] * dy + R[2] * dz,
      y: R[3] * dx + R[4] * dy + R[5] * dz,
      z: R[6] * dx + R[7] * dy + R[8] * dz,
    };
  }

  /**
   * World points → pixels. Points at or behind the camera plane project to
   * NaN rather than to a plausible-looking pixel, because a wrapped-around
   * point drawn as a real one is exactly the failure that produces a tracer
   * arc pointing the wrong way.
   */
  project(pts: Vec3[]): Px[] {
    const f = this.params.fPx;
    const out: Px[] = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const c = this.toCamera(pts[i]);
      if (!(c.z > 1e-9)) {
        out[i] = { x: NaN, y: NaN };
        continue;
      }
      out[i] = { x: (f * c.x) / c.z + this.cx, y: (f * c.y) / c.z + this.cy };
    }
    return out;
  }

  /** Pixel → unit direction in WORLD coordinates, from the camera centre. */
  pixelToRay(p: Px): Vec3 {
    const f = this.params.fPx;
    const dx = (p.x - this.cx) / f;
    const dy = (p.y - this.cy) / f;
    const R = this.R;
    // Row vector times R, i.e. Rᵀ applied to the camera-frame direction.
    const wx = R[0] * dx + R[3] * dy + R[6];
    const wy = R[1] * dx + R[4] * dy + R[7];
    const wz = R[2] * dx + R[5] * dy + R[8];
    const n = Math.sqrt(wx * wx + wy * wy + wz * wz);
    return { x: wx / n, y: wy / n, z: wz / n };
  }

  /**
   * Intersect the pixel's ray with the horizontal plane Z = zPlane. Rays that
   * never reach the plane in front of the camera (anything at or above the
   * horizon) give NaN — the caller must treat that as "cannot know", never as
   * a very large distance.
   */
  backprojectPlane(p: Px, zPlane = 0): Vec3 {
    const d = this.pixelToRay(p);
    const s = (zPlane - this.params.hCamM) / d.z;
    if (!(s > 0) || !Number.isFinite(s)) return { x: NaN, y: NaN, z: NaN };
    return { x: s * d.x, y: s * d.y, z: this.params.hCamM + s * d.z };
  }

  /** Pixel → the ground point (z = 0) it sees. */
  backprojectGround(p: Px): Vec3 {
    return this.backprojectPlane(p, 0);
  }

  /**
   * World position of the CENTRE of a ball resting on the ground whose image
   * centre is this pixel — the centre sits one ball radius up, which at 3 m is
   * worth ~1 % of the range and is free to get right.
   */
  ballCentreFromPixel(p: Px): Vec3 {
    return this.backprojectPlane(p, BALL_RADIUS_M);
  }

  /** Angle of a pixel off the optical axis, radians. */
  offAxisAngleRad(p: Px): number {
    return Math.atan(Math.hypot(p.x - this.cx, p.y - this.cy) / this.params.fPx);
  }

  /** Angle below the horizontal of the ray through a pixel, radians. */
  depressionAngleRad(p: Px): number {
    const d = this.pixelToRay(p);
    return -Math.asin(Math.max(-1, Math.min(1, d.z)));
  }

  /**
   * Exact silhouette of a sphere under a pinhole: the semi-axes (radial,
   * tangential) in pixels of the image ellipse, and the ellipse's centre.
   *
   * Worth having because the naive `f·D/d` is wrong off-axis by a factor that
   * is not small at the edge of a portrait frame: a ball 20° off-axis is drawn
   * ~13 % taller radially than `f·D/d`. `depthFromDiameterPx` undoes it.
   */
  sphereImageAxes(centre: Vec3, radiusM = BALL_RADIUS_M): { aPx: number; bPx: number; centrePx: Px } {
    const Pc = this.toCamera(centre);
    const d = Math.sqrt(Pc.x * Pc.x + Pc.y * Pc.y + Pc.z * Pc.z);
    if (!(d > radiusM)) return { aPx: NaN, bPx: NaN, centrePx: { x: NaN, y: NaN } };
    const f = this.params.fPx;
    const beta = Math.asin(radiusM / d); // cone half-angle
    const alpha = Math.acos(Pc.z / d); // off-axis angle
    const aPx = 0.5 * f * (Math.tan(alpha + beta) - Math.tan(alpha - beta));
    const bPx =
      (f * Math.sin(beta)) /
      Math.sqrt(Math.max(Math.cos(alpha) ** 2 - Math.sin(beta) ** 2, 1e-12));
    // The ellipse centre is NOT the projected sphere centre: it sits further
    // out along the radial line, at f·tan of the mid angle.
    const rc = 0.5 * f * (Math.tan(alpha + beta) + Math.tan(alpha - beta));
    const rxy = Math.hypot(Pc.x, Pc.y);
    const ux = alpha > 1e-9 && rxy > 0 ? Pc.x / rxy : 0;
    const uy = alpha > 1e-9 && rxy > 0 ? Pc.y / rxy : 0;
    return { aPx, bPx, centrePx: { x: this.cx + rc * ux, y: this.cy + rc * uy } };
  }

  /**
   * Range in metres from the camera centre to a ball's centre, given its
   * apparent diameter in pixels.
   *
   * With `at` (the ball's image position) the off-axis stretch of the sphere's
   * silhouette is undone — the correction the lab implemented, and the reason
   * this signature takes more than a diameter. Without `at`, the on-axis
   * `f·D/w` is used, which is what the lab does when it has no position.
   *
   * This range carries the fPx error 1:1 (`params.fPxIsPrior`).
   */
  depthFromDiameterPx(diamPx: number, at?: Px, measured: DiameterKind = 'equivalent'): number {
    const num = this.params.fPx * BALL_DIAMETER_M;
    if (!at) return num / diamPx;
    const ca = Math.cos(this.offAxisAngleRad(at));
    const corr =
      measured === 'tangential'
        ? ca // w_t ≈ f·D / (d·cos α)
        : measured === 'radial'
          ? ca * ca // w_r ≈ f·D / (d·cos²α)
          : Math.pow(ca, 1.5); // geometric mean of the two — what a circle fit gives
    return num / (diamPx * corr);
  }

  /**
   * Image row of the true horizon (the vanishing line of the ground plane) at
   * column `u`, defaulting to the principal column. Includes roll, so the
   * horizon tilts: dv/du = tan(roll).
   *
   * At roll = 0 this is the familiar `cy − f·tan(pitch)`.
   */
  horizonRow(u?: number): number {
    const col = u ?? this.cx;
    const R = this.R;
    // The horizon is the set of ray directions with world z-component 0, i.e.
    // n · [u − cx, v − cy, f] = 0 where n = R · (0,0,1) is world "up" in the
    // camera frame — the third column of R.
    const n0 = R[2];
    const n1 = R[5];
    const n2 = R[8];
    if (Math.abs(n1) < 1e-12) return NaN;
    return this.cy - (n0 * (col - this.cx) + n2 * this.params.fPx) / n1;
  }
}

// ─── Calibration ───

/**
 * Seed camera height for `calibrateFromAddressBall`. It cancels exactly (the
 * ground range is linear in hCam − ballRadius), so this is bookkeeping, not an
 * assumption — the test pins that two different seeds give the same answer.
 *
 * It happens to equal the app's old `config.tracer.tripodHeightM` default. That
 * default is NOT safe as an answer: the lab measured 0.82–1.63 m across eight
 * clips of the same tripod, and using 1.35 put one address ball 66 % off in
 * depth. Measure it per clip; that is what this function is for.
 */
const SEED_H_CAM_M = 1.35;

export interface AddressBallCalibration {
  /** Image centre of the ball at address, pixels, top-left origin. */
  addressPx: Px;
  /** Its apparent diameter in pixels (a circle/ring fit → `equivalent`). */
  addressDiamPx: number;
  fPx: number;
  width: number;
  height: number;
  /** From CoreMotion at record start, positive looking down. */
  pitchDownDeg: number;
  rollDeg?: number;
  /** Defaults to TRUE — the conservative reading. Pass false only when fPx
   *  really came from AVCaptureDevice intrinsics. */
  fPxIsPrior?: boolean;
  diamKind?: DiameterKind;
  /** Test hook only: proves the seed cancels. */
  seedHCamM?: number;
}

/**
 * Recover the camera height from the address ball, exactly as
 * `tracer-lab/lib/camera.py: calibrate(cues, f_px=…)` does.
 *
 * The ball gives two independent ranges: one from its apparent DIAMETER
 * (a size cue, scaling with fPx) and one from the GROUND PLANE (an angle cue,
 * scaling with hCam). Only one hCam makes them agree, and because the ground
 * range is exactly linear in (hCam − ballRadius), finding it is one division —
 * no search, no iteration.
 *
 * The lab does this from a measured horizon; here the pitch comes from
 * CoreMotion instead, which is the app's situation. Everything downstream is
 * identical, and feeding the lab's own per-clip pitch back in reproduces its
 * published hCam to the last digit (pinned in the tests).
 *
 * Throws when the inputs cannot produce a height — a non-positive diameter, or
 * an address pixel at or above the horizon. That is a refusal, and the caller
 * must skip the clip; there is no honest fallback number.
 */
export function calibrateFromAddressBall(a: AddressBallCalibration): CameraParams {
  if (!(a.addressDiamPx > 0)) {
    throw new Error(`calibrateFromAddressBall: diameter must be positive, got ${a.addressDiamPx}`);
  }
  const seed: CameraParams = {
    fPx: a.fPx,
    width: a.width,
    height: a.height,
    pitchDownDeg: a.pitchDownDeg,
    rollDeg: a.rollDeg ?? 0,
    hCamM: a.seedHCamM ?? SEED_H_CAM_M,
    fPxIsPrior: a.fPxIsPrior ?? true,
  };
  const cam = new TracerCamera(seed);
  const rSize = cam.depthFromDiameterPx(a.addressDiamPx, a.addressPx, a.diamKind ?? 'equivalent');
  const P = cam.backprojectPlane(a.addressPx, BALL_RADIUS_M);
  if (!Number.isFinite(P.x)) {
    throw new Error(
      'calibrateFromAddressBall: the address pixel does not meet the ground ' +
        '(at or above the horizon) — the clip cannot be calibrated'
    );
  }
  const rGround = Math.hypot(P.x, P.y, P.z - seed.hCamM);
  const hCamM = BALL_RADIUS_M + (seed.hCamM - BALL_RADIUS_M) * (rSize / rGround);
  return { ...seed, hCamM };
}
