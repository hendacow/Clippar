/**
 * A FOURTH synthetic clip: the one where review F4's axis-degenerate refusal is
 * SILENTLY LOST the moment a GPS carry is supplied and then thrown away
 * (FG-3, `docs/tracer-v3/final-gate.md`).
 *
 * WHY IT EXISTS, and why none of the three siblings will do. FG-3 needs a
 * geometry where THREE things are true at once, and I searched the other
 * fixtures for it first and found nothing — `tests/tracerV3Refusals.test.ts`
 * asserts that, so a later "simplification" that merges the fixtures deletes the
 * reproduction rather than quietly weakening it:
 *
 *   1. the PIXEL-ONLY fit is ill-conditioned — sigma(v0)/v0 = 12 % here, against
 *      F4's 10 % bar — and fits to an azimuth of 1.25 deg when the ball actually
 *      flew at 2.0 deg, i.e. it has lost the direction and with it the scale;
 *   2. the JOINT fits are not, because a GPS carry pins the depth (1 %), so
 *      `LadderRun.worstV0RelSigma` — accumulated over the rungs the ladder RAN —
 *      never sees the bad conditioning;
 *   3. the carry is then rejected anyway, so `pixel_only_fallback` DRAWS the
 *      ill-conditioned fit that no rung measured.
 *
 * The result before FG-3: `gps=null` correctly refuses the distance ("down the
 * line"), and `gps=80` draws the same 28.7 m arc for a 23.6 m shot — **+21 %,
 * with a number on it**. Supplying a GPS reading the ladder throws away removed
 * F4's protection from the very fit F4 was written for.
 *
 * THE GEOMETRY is the gate's own camera for its worst FG-3 row (720x1280, 8 deg
 * of pitch, camera 1.30 m up, 70 deg landscape FOV), deliberately sharing no
 * constant with the other three fixtures. The shot is a high, slow one — a
 * 35 deg wedge at 16 m/s — because a steep, short flight over seven 30 fps
 * frames is what makes the pixel-only depth degenerate.
 *
 * THE DEFAULT LAUNCH MOVED ON 7 SEP, and the reason is worth reading before
 * touching it again. It used to be a 45 deg wedge 3.0 deg off the line, and the
 * header used to say — approvingly — that the fixture "slips both residual
 * gates: rms is 7.66 px @1080p, under MAX_RMS_PX = 8, and `poor_fit` needs
 * nPoints >= 10 while this track is 7". `tune` then CLOSED that hole: `poor_fit`
 * lost its length conjunct, because a real clip walked through it (`IMG_0323`,
 * a phone on a golf trolley, three blobs at 5.6 px @1080, drawing an arc). The
 * old default is now refused outright — which is the right answer for a fit that
 * misses its own detections by 7.66 px and does not converge (`ok: false`) — and
 * with it refused, FG-3 had no reproduction left. So the launch moved to the
 * nearest neighbouring geometry that still exhibits all three conditions above
 * AND converges: 35 deg, 2.0 deg of azimuth, rms 3.37 px @1080p. The mechanism
 * under test is unchanged; only the launch is. **Do not "restore" the old
 * numbers — they no longer draw, and the test that reads them would go green by
 * never reaching its own assertions.**
 *
 * Conventions are `lib/tracerFit.ts`'s, identical to all three siblings: the
 * flight is simulated from z0 = the ball radius, and world z is measured from
 * `start.z - BALL_RADIUS_M`.
 */
import { BALL_RADIUS_M, simulate } from '../../lib/tracerPhysics';
import { TracerCamera } from '../../lib/tracerCamera';
import {
  fPxFromLandscapeFov,
  type BallDetection,
  type TraceClipInput,
  type TracerDetectResultV3,
} from '../../lib/tracerV3';

export const WIDTH = 720;
export const HEIGHT = 1280;
export const FPS = 30;
export const K_IMPACT = 40;
export const PITCH_DOWN_DEG = 8;
export const H_CAM_M = 1.3;
export const FOV_LANDSCAPE_DEG = 70;

export const F_PX = fPxFromLandscapeFov(FOV_LANDSCAPE_DEG, WIDTH, HEIGHT);

/** On the ground, 2.9 m in front of the camera and 0.4 m to the right. */
export const BALL_START = { x: 2.9, y: -0.4, z: BALL_RADIUS_M };

/** Impact 0.2 of a frame after `K_IMPACT`, inside [k/fps, (k+1)/fps]. */
export const SUB_FRAME = 0.2;
export function t0Sec(fps = FPS): number {
  return (K_IMPACT + SUB_FRAME) / fps;
}

export function truthCamera(): TracerCamera {
  return new TracerCamera({
    fPx: F_PX,
    width: WIDTH,
    height: HEIGHT,
    pitchDownDeg: PITCH_DOWN_DEG,
    rollDeg: 0,
    hCamM: H_CAM_M,
    fPxIsPrior: true,
  });
}

export function addressCue(cam: TracerCamera): { x: number; y: number; r: number } {
  const axes = cam.sphereImageAxes(BALL_START);
  return { x: axes.centrePx.x, y: axes.centrePx.y, r: Math.sqrt(axes.aPx * axes.bPx) };
}

export interface AxisFallbackOpts {
  v0?: number;
  thetaDeg?: number;
  /** The TRUE azimuth. The pixel-only fit recovers 1.25 deg from 2.0. */
  phiDeg?: number;
  rpmBack?: number;
  frames?: number;
  fps?: number;
  conf?: number;
}

function flightOf(o: AxisFallbackOpts) {
  return simulate({
    v0: o.v0 ?? 16,
    // 35 / 2.0, not 45 / 3.0 — see "THE DEFAULT LAUNCH MOVED" in the header.
    thetaDeg: o.thetaDeg ?? 35,
    phiDeg: o.phiDeg ?? 2,
    rpmBack: o.rpmBack ?? 3273,
    rpmSide: 0,
    z0: BALL_RADIUS_M,
  });
}

/** What the ball ACTUALLY did — the number every error is measured against. */
export function truthSummary(o: AxisFallbackOpts = {}) {
  return flightOf(o).summary;
}

/** Detections generated by projecting that real simulated flight. */
export function flightDetections(o: AxisFallbackOpts = {}): BallDetection[] {
  const cam = truthCamera();
  const flight = flightOf(o);
  const fps = o.fps ?? FPS;
  const t0 = t0Sec(fps);
  const n = o.frames ?? 7;
  const out: BallDetection[] = [];
  for (let i = 1; i <= n; i++) {
    const frame = K_IMPACT + i;
    const tau = frame / fps - t0;
    const s = flight.at(tau);
    const world = {
      x: BALL_START.x + s.x,
      y: BALL_START.y + s.y,
      z: BALL_START.z - BALL_RADIUS_M + s.z,
    };
    const uv = cam.project([world])[0];
    const axes = cam.sphereImageAxes(world);
    out.push({
      frame,
      t: frame / fps,
      x: uv.x,
      y: uv.y,
      r: Math.sqrt(axes.aPx * axes.bPx),
      conf: o.conf ?? 0.7,
    });
  }
  return out;
}

export function detectionResult(
  detections: BallDetection[],
  overrides: Partial<TracerDetectResultV3> = {}
): TracerDetectResultV3 {
  const cam = truthCamera();
  return {
    found: true,
    method: 'blob-kalman',
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    impactFrameGiven: K_IMPACT,
    impactFrameUsed: K_IMPACT,
    launchFrame: K_IMPACT + 1,
    address: addressCue(cam),
    detections,
    notes: {},
    msPerFrame: 11,
    ...overrides,
  };
}

export function traceInput(overrides: Partial<TraceClipInput> = {}): TraceClipInput {
  return {
    detection: detectionResult(flightDetections()),
    pitchDownDeg: PITCH_DOWN_DEG,
    fPx: F_PX,
    fPxSource: 'fov-metadata',
    capture: { lens: '1x', zoom: 0 },
    shotType: 'swing',
    renderDurationSec: 8,
    detectToRenderOffsetSec: 0,
    ...overrides,
  };
}
