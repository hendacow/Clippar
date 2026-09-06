/**
 * Tests for lib/tracerCamera.ts.
 *
 * Two kinds of expectation live here and they are not interchangeable:
 *
 * 1. **Closed-form checks** — the horizon row, a post's projected height, the
 *    sphere silhouette. These are derived from the trigonometry independently
 *    of the implementation, so they would catch a sign error the port itself
 *    reproduced faithfully.
 * 2. **Regression fixtures from the lab** — three per-clip calibrations pasted
 *    out of `tracer-lab/experiments/camera/calibration.json`. Same inputs must
 *    give the same camera height, range and ball position. These pin the port
 *    against `tracer-lab/lib/camera.py`; they say nothing about whether the
 *    lab's own measurement of Henry's footage was right.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TracerCamera,
  calibrateFromAddressBall,
  fPxFromFovDeg,
  fovDegFromFPx,
  fPxFrom35mmEquiv,
  type CameraParams,
  type Px,
} from '../lib/tracerCamera';
import { BALL_DIAMETER_M, BALL_RADIUS_M } from '../lib/tracerPhysics';

const DEG = Math.PI / 180;

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, expected ${expected} ± ${tol}`
  );
}

/** A plain 1080p portrait camera on a tripod, looking 5° down. */
function testCamera(overrides: Partial<CameraParams> = {}): TracerCamera {
  return new TracerCamera({
    fPx: 1504.2292581465217, // the lab's central 24 mm-equivalent prior, 1080p
    width: 1080,
    height: 1920,
    pitchDownDeg: 5,
    rollDeg: 0,
    hCamM: 1.35,
    fPxIsPrior: true,
    ...overrides,
  });
}

// ─── Focal length helpers ───

test('fPxFromFovDeg round-trips, and reproduces the lab’s prior band', () => {
  near(fovDegFromFPx(fPxFromFovDeg(65, 1920), 1920), 65, 1e-9, 'fov round trip');
  // Sanity in the other direction: the app's ShotTracer fallback is a 62° long
  // axis on a 1920-px frame.
  near(fPxFromFovDeg(62, 1920), 1598, 1, 'app fallback f_px');
  // The lab's f_px numbers are the 24 mm-equivalent lens at an assumed
  // stabilisation crop. Deriving them here rather than pasting them shows
  // where the fixture focal lengths below come from.
  near(fPxFrom35mmEquiv(24, 1080, 1920, 1.0), 1331.1763346429395, 1e-9, 'no crop');
  near(fPxFrom35mmEquiv(24, 1080, 1920, 1.13), 1504.2292581465217, 1e-9, 'central crop');
  near(fPxFrom35mmEquiv(24, 1080, 1920, 1.28), 1703.9057083429627, 1e-9, 'heavy crop');
  near(fPxFrom35mmEquiv(24, 2160, 3840, 1.13), 3008.4585162930434, 1e-9, '4K central crop');
  // The unknown crop is the whole ±12 % systematic: no-crop to heavy-crop is
  // a 28 % spread in f_px, and carry rides on it 1:1.
  near(fovDegFromFPx(fPxFrom35mmEquiv(24, 1080, 1920, 1.0), 1920), 71.59577253809705, 1e-9, 'uncropped FOV');
});

// ─── Projection ───

test('project → backproject round-trips to 1e-9 m', () => {
  const cam = testCamera({ rollDeg: 2.5 });
  const ground = [
    { x: 3, y: 0.5, z: 0 },
    { x: 25, y: -4, z: 0 },
    { x: 120, y: 9, z: 0 },
  ];
  const px = cam.project(ground);
  for (let i = 0; i < ground.length; i++) {
    const back = cam.backprojectGround(px[i]);
    near(back.x, ground[i].x, 1e-9, `x[${i}]`);
    near(back.y, ground[i].y, 1e-9, `y[${i}]`);
    near(back.z, 0, 1e-9, `z[${i}]`);
  }
  // The same for a ball centre one radius off the ground.
  const ballWorld = { x: 4.5, y: 0.3, z: BALL_RADIUS_M };
  const back = cam.ballCentreFromPixel(cam.project([ballWorld])[0]);
  near(back.x, ballWorld.x, 1e-9, 'ball x');
  near(back.y, ballWorld.y, 1e-9, 'ball y');
  near(back.z, BALL_RADIUS_M, 1e-12, 'ball z');
});

test('points behind the camera and above the horizon give NaN, not a plausible pixel', () => {
  const cam = testCamera();
  const behind = cam.project([{ x: -5, y: 0, z: 1 }])[0];
  assert.ok(Number.isNaN(behind.x) && Number.isNaN(behind.y), 'behind the camera → NaN');
  // A pixel above the horizon has no ground point: its ray never comes down.
  const aboveHorizon: Px = { x: 540, y: cam.horizonRow() - 50 };
  const g = cam.backprojectGround(aboveHorizon);
  assert.ok(Number.isNaN(g.x), 'above the horizon → NaN');
  // One pixel below the horizon does hit the ground, a very long way away.
  const belowHorizon: Px = { x: 540, y: cam.horizonRow() + 1 };
  assert.ok(Number.isFinite(cam.backprojectGround(belowHorizon).x));
});

test('a 1.8 m post at 100 m projects where the trigonometry says', () => {
  const cam = testCamera();
  const [base, top] = cam.project([
    { x: 100, y: 0, z: 0 },
    { x: 100, y: 0, z: 1.8 },
  ]);
  // For roll = 0 the row of a point at depression δ below horizontal is
  // exactly cy + f·tan(δ − pitch). Derived from the rotation, not from the code.
  const row = (z: number): number =>
    cam.cy + cam.params.fPx * Math.tan(Math.atan((cam.params.hCamM - z) / 100) - 5 * DEG);
  near(base.y, row(0), 1e-9, 'post base row');
  near(top.y, row(1.8), 1e-9, 'post top row');
  near(base.x, cam.cx, 1e-9, 'post is on the principal column');
  near(base.y - top.y, 27.261921224114303, 1e-9, 'post height in px (lab camera.py)');
  // The cue the lab used for the golfer: the horizon crosses a vertical object
  // at exactly camera height.
  const atCameraHeight = cam.project([{ x: 100, y: 0, z: cam.params.hCamM }])[0];
  near(atCameraHeight.y, cam.horizonRow(), 1e-9, 'horizon crosses the post at camera height');
});

// ─── Horizon ───

test('horizonRow = cy − f·tan(pitch) with no roll, at every column', () => {
  for (const pitchDownDeg of [-3, 0, 1.27, 5, 12]) {
    const cam = testCamera({ pitchDownDeg });
    const expected = cam.cy - cam.params.fPx * Math.tan(pitchDownDeg * DEG);
    near(cam.horizonRow(), expected, 1e-9, `horizon at pitch ${pitchDownDeg}`);
    near(cam.horizonRow(0), expected, 1e-9, `left edge at pitch ${pitchDownDeg}`);
    near(cam.horizonRow(1079), expected, 1e-9, `right edge at pitch ${pitchDownDeg}`);
  }
});

test('roll tilts the horizon by exactly the roll angle, right end down', () => {
  for (const rollDeg of [-2, -0.14, 3, 8]) {
    const cam = testCamera({ rollDeg });
    const vLeft = cam.horizonRow(0);
    const vRight = cam.horizonRow(1079);
    const slopeDeg = Math.atan2(vRight - vLeft, 1079) / DEG;
    near(slopeDeg, rollDeg, 1e-9, `horizon slope at roll ${rollDeg}`);
    // At the principal column the roll only stretches the pitch term.
    near(
      cam.horizonRow(),
      cam.cy - (cam.params.fPx * Math.tan(5 * DEG)) / Math.cos(rollDeg * DEG),
      1e-9,
      `horizon row at roll ${rollDeg}`
    );
  }
  assert.ok(testCamera({ rollDeg: 3 }).horizonRow(1079) > testCamera({ rollDeg: 3 }).horizonRow(0),
    'positive roll drops the RIGHT end (larger row)');
});

// ─── Ball size cue ───

test('depth from diameter: on-axis is f·D/w at 3 m and 100 m', () => {
  const cam = testCamera();
  const f = cam.params.fPx;
  for (const range of [3, 100]) {
    const w = (f * BALL_DIAMETER_M) / range;
    near(cam.depthFromDiameterPx(w), range, 1e-9, `on-axis depth at ${range} m`);
  }
  near((f * BALL_DIAMETER_M) / 3, 21.395154, 1e-6, 'a ball at 3 m is ~21 px across');
  near((f * BALL_DIAMETER_M) / 100, 0.641855, 1e-6, 'a ball at 100 m is sub-pixel');
});

test('the off-axis silhouette correction matches lib/camera.py', () => {
  const cam = testCamera();
  const at: Px = { x: 540, y: 1400 }; // 16.3° off axis in a portrait frame
  near(cam.offAxisAngleRad(at) / DEG, 16.32220431609679, 1e-9, 'off-axis angle');
  // Reference values printed by tracer-lab/lib/camera.py for the same inputs.
  near(cam.depthFromDiameterPx(21.39, at, 'equivalent'), 3.1917219990002414, 1e-9, 'equivalent');
  near(cam.depthFromDiameterPx(21.39, at, 'radial'), 3.258052758485671, 1e-9, 'radial');
  near(cam.depthFromDiameterPx(21.39, at, 'tangential'), 3.1267416687374374, 1e-9, 'tangential');
  // Ignoring the correction would call the same ball 6 % closer than it is —
  // this is why depthFromDiameterPx takes a position at all.
  const naive = cam.depthFromDiameterPx(21.39);
  assert.ok(naive < 3.1917219990002414 * 0.95, `naive ${naive} should be well short`);
});

test('an exact sphere silhouette round-trips back to its range', () => {
  const cam = testCamera();
  const dir = cam.pixelToRay({ x: 540, y: 1400 });
  for (const range of [3, 100]) {
    const centre = {
      x: dir.x * range,
      y: dir.y * range,
      z: cam.params.hCamM + dir.z * range,
    };
    const { aPx, bPx, centrePx } = cam.sphereImageAxes(centre);
    const equivalent = 2 * Math.sqrt(aPx * bPx);
    const recovered = cam.depthFromDiameterPx(equivalent, centrePx, 'equivalent');
    // The lab quotes ~1e-4 m for this round trip; the residual is the
    // cos^1.5 approximation to the true ellipse, not a coding error.
    near(recovered, range, 1e-4 * Math.max(1, range / 3), `sphere round trip at ${range} m`);
    assert.ok(aPx > bPx, 'the silhouette is stretched radially, not tangentially');
  }
  // Pinned against lib/camera.py at 3 m: a ball at 16.3° off axis is drawn
  // 22.76 px across, not the 21.40 px that f·D/d predicts.
  const c3 = { x: dir.x * 3, y: dir.y * 3, z: cam.params.hCamM + dir.z * 3 };
  const s3 = cam.sphereImageAxes(c3);
  near(s3.aPx, 11.615302193, 1e-8, 'radial semi-axis');
  near(s3.bPx, 11.147140115, 1e-8, 'tangential semi-axis');
});

// ─── fPxIsPrior is first class ───

test('fPxIsPrior survives every copy and is not defaulted away', () => {
  const device = testCamera({ fPxIsPrior: false });
  assert.equal(device.params.fPxIsPrior, false);
  assert.equal(device.withPitchDelta(0.4).params.fPxIsPrior, false);
  assert.equal(device.with({ hCamM: 1.1 }).params.fPxIsPrior, false);
  assert.equal(testCamera().withPitchDelta(-1).params.fPxIsPrior, true);
  // The default for calibration is the conservative one: unless the caller
  // says the focal length came from the device, it is a ±12 % prior.
  const cal = calibrateFromAddressBall({
    addressPx: { x: 358.87, y: 1244.32 },
    addressDiamPx: 12.9,
    fPx: 1504.2292581465217,
    width: 1080,
    height: 1920,
    pitchDownDeg: 3.3670551605650245,
  });
  assert.equal(cal.fPxIsPrior, true);
});

test('withPitchDelta moves the horizon and nothing else', () => {
  const cam = testCamera();
  const tilted = cam.withPitchDelta(0.5);
  near(tilted.params.pitchDownDeg, 5.5, 1e-12, 'pitch');
  near(tilted.params.hCamM, cam.params.hCamM, 0, 'height unchanged');
  assert.ok(tilted.horizonRow() < cam.horizonRow(), 'pitching down raises the horizon in the frame');
});

// ─── Calibration: regression fixtures from the lab ───

/**
 * Three of the eight clips from `tracer-lab/experiments/camera/calibration.json`
 * — two 1080p30 and one 4K60, spanning +3.4° to −3.0° of pitch and 0.82 to
 * 1.27 m of camera height. `hCamM` and `rangeM` are the file's own
 * `h_cam_from_ball_m` and `depth_from_diameter_m`.
 *
 * The lab derived its pitch from a measured horizon; here it is fed in
 * directly, which is what CoreMotion gives the app. Everything downstream is
 * the same computation, so these must reproduce to the last digit.
 */
const LAB_CLIPS = [
  {
    clip: 'IMG_3632',
    fPx: 1504.2292581465217,
    width: 1080,
    height: 1920,
    pitchDownDeg: 3.3670551605650245,
    rollDeg: -0.14000000000000143,
    ball: { x: 358.87, y: 1244.32 },
    diamPx: 12.9,
    horizonRow: 871,
    hCamM: 1.2677830765145202,
    rangeM: 5.162061243320058,
    ballWorld: { x: 4.972381392880995, y: 0.6071793442395204 },
  },
  {
    clip: 'IMG_3629',
    fPx: 1504.2292581465217,
    width: 1080,
    height: 1920,
    pitchDownDeg: 1.2700000000000002,
    rollDeg: 0.0,
    ball: { x: 486.96, y: 1311.92 },
    diamPx: 20.8,
    horizonRow: 926.1522717414355,
    hCamM: 0.8233930246718532,
    rangeM: 3.214809116382028,
    // NOTE: calibration.json publishes ball_world (3.2610, 0.1145) for this
    // clip because its camera height came from a JOINT solve over the ball, a
    // stranger at ~28 m and the golfer (0.86 m), not from the ball alone
    // (0.8234 m). This fixture is the ball-only value, recomputed from
    // lib/camera.py with the same inputs this function takes.
    ballWorld: { x: 3.1112315861, y: 0.1092638905 },
  },
  {
    clip: 'IMG_3631',
    fPx: 3008.4585162930434,
    width: 2160,
    height: 3840,
    pitchDownDeg: -2.9967213315860874, // pitched UP: the horizon sits below centre
    rollDeg: -0.5000000000000053,
    ball: { x: 739.19, y: 2811.78 },
    diamPx: 29.5,
    horizonRow: 2077,
    hCamM: 1.104043485719952,
    rangeM: 4.676431516115731,
    ballWorld: { x: 4.520043688188518, y: 0.5157122421831981 },
  },
];

test('per-clip calibration reproduces the lab’s numbers', () => {
  for (const c of LAB_CLIPS) {
    const params = calibrateFromAddressBall({
      addressPx: c.ball,
      addressDiamPx: c.diamPx,
      fPx: c.fPx,
      width: c.width,
      height: c.height,
      pitchDownDeg: c.pitchDownDeg,
      rollDeg: c.rollDeg,
    });
    near(params.hCamM, c.hCamM, 1e-9, `${c.clip} h_cam`);

    const cam = new TracerCamera(params);
    // The lab's pitch came from this horizon row; feeding the pitch back must
    // land on the same row.
    near(cam.horizonRow(), c.horizonRow, 1e-6, `${c.clip} horizon row`);
    near(
      cam.depthFromDiameterPx(c.diamPx, c.ball, 'equivalent'),
      c.rangeM,
      1e-9,
      `${c.clip} range from diameter`
    );
    const world = cam.ballCentreFromPixel(c.ball);
    near(world.x, c.ballWorld.x, 1e-9, `${c.clip} ball x`);
    near(world.y, c.ballWorld.y, 1e-9, `${c.clip} ball y`);
    near(world.z, BALL_RADIUS_M, 1e-12, `${c.clip} ball z`);

    // The defining property of the calibration: the size cue and the ground
    // cue now agree on the range. This is what h_cam was solved FOR.
    const rGround = Math.hypot(world.x, world.y, world.z - params.hCamM);
    near(rGround, c.rangeM, 1e-9, `${c.clip} ground range == size range`);
  }
});

test('the calibration seed cancels exactly — it is bookkeeping, not an assumption', () => {
  const base = {
    addressPx: { x: 358.87, y: 1244.32 },
    addressDiamPx: 12.9,
    fPx: 1504.2292581465217,
    width: 1080,
    height: 1920,
    pitchDownDeg: 3.3670551605650245,
    rollDeg: -0.14,
  };
  const a = calibrateFromAddressBall({ ...base, seedHCamM: 1.35 });
  const b = calibrateFromAddressBall({ ...base, seedHCamM: 0.4 });
  const c = calibrateFromAddressBall({ ...base, seedHCamM: 2.9 });
  near(b.hCamM, a.hCamM, 1e-12, 'seed 0.4 m');
  near(c.hCamM, a.hCamM, 1e-12, 'seed 2.9 m');
  // And the app's old fixed 1.35 m default is NOT the answer: this clip's
  // tripod was 1.27 m, which moves the address ball's depth by ~7 %.
  const wrong = new TracerCamera({ ...a, hCamM: 1.35 }).ballCentreFromPixel(base.addressPx);
  const right = new TracerCamera(a).ballCentreFromPixel(base.addressPx);
  assert.ok(Math.abs(wrong.x - right.x) / right.x > 0.05, 'assuming 1.35 m is a real error');
});

test('calibration refuses inputs it cannot honestly answer', () => {
  const base = {
    addressPx: { x: 540, y: 1400 },
    addressDiamPx: 12.9,
    fPx: 1504.2292581465217,
    width: 1080,
    height: 1920,
    pitchDownDeg: 5,
  };
  assert.throws(() => calibrateFromAddressBall({ ...base, addressDiamPx: 0 }), /positive/);
  // A "ball" above the horizon has no ground intersection — refuse, do not
  // invent a height.
  assert.throws(
    () => calibrateFromAddressBall({ ...base, addressPx: { x: 540, y: 100 } }),
    /cannot be calibrated/
  );
});
