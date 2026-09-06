/**
 * Port of `tracer-lab/experiments/flight/test_flight.py` (24 tests) to
 * node:test, plus the runtime budget the phone needs.
 *
 * Every expected number here is traced to the lab: the TrackMan targets and
 * tolerances come from `tracer-lab/CONVENTIONS.md`, the pinned driver /
 * hold-out numbers from `tracer-lab/experiments/flight/report.md`. Nothing was
 * produced by running this port and then blessed as correct.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulate,
  solveV0ForCarry,
  inferLaunch,
  spinVector,
  spinAxisTiltDeg,
  spinFromAxis,
  bucketFromLabName,
  CLUB_PRIORS,
  DEFAULT_AERO,
  VALIDATION_TARGETS,
  VALIDATION_TOLERANCE,
  G,
  BALL_MASS_KG,
  BALL_DIAMETER_M,
  BALL_AREA_M2,
} from '../lib/tracerPhysics';

const DEG = Math.PI / 180;

/** assert |a - b| <= tol, with a message that shows the miss. */
function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, expected ${expected} ± ${tol}`
  );
}

// ─── Constants ───

test('physics constants match the lab', () => {
  near(BALL_MASS_KG, 0.04593, 1e-12, 'ball mass');
  near(BALL_DIAMETER_M, 0.04267, 1e-12, 'ball diameter');
  near(BALL_AREA_M2, Math.PI * (0.04267 / 2) ** 2, 1e-15, 'ball area');
  near(G, 9.81, 1e-12, 'gravity');
  // The five fitted coefficients (variant H). If any of these move, the nine
  // TrackMan residuals in the report no longer describe this model.
  assert.deepEqual(
    [DEFAULT_AERO.cd0, DEFAULT_AERO.cd1, DEFAULT_AERO.clA, DEFAULT_AERO.clP, DEFAULT_AERO.clMax, DEFAULT_AERO.spinDecay],
    [0.2103, 0.2908, 0.6912, 0.6243, 0.3291, 0.045]
  );
});

// ─── Analytic checks ───

test('vacuum flight matches the analytic parabola', () => {
  const v0 = 50;
  const th = 30;
  const fl = simulate({ v0, thetaDeg: th, rhoAir: 0, dt: 1 / 120 });
  const range = (v0 ** 2 * Math.sin(2 * th * DEG)) / G;
  const apex = (v0 * Math.sin(th * DEG)) ** 2 / (2 * G);
  const hang = (2 * v0 * Math.sin(th * DEG)) / G;
  near(fl.summary.carryM, range, range * 2e-4, 'vacuum range');
  // Apex is the highest SAMPLE, not the interpolated maximum, so it sits a
  // little low — the same 2e-3 relative tolerance the lab used.
  near(fl.summary.apexM, apex, apex * 2e-3, 'vacuum apex');
  near(fl.summary.hangS, hang, hang * 2e-4, 'vacuum hang');
  near(fl.summary.landAngleDeg, th, 0.01, 'vacuum landing angle');
  near(fl.summary.lateralM, 0, 1e-9, 'vacuum lateral');
});

test('drag alone shortens the flight and steepens the landing', () => {
  const vac = simulate({ v0: 70, thetaDeg: 12, rhoAir: 0 });
  const air = simulate({ v0: 70, thetaDeg: 12 }); // no spin => drag only
  assert.ok(air.summary.carryM < vac.summary.carryM);
  assert.ok(air.summary.landAngleDeg > vac.summary.landAngleDeg);
});

test('backspin adds lift', () => {
  const nospin = simulate({ v0: 75, thetaDeg: 10.9 });
  const spin = simulate({ v0: 75, thetaDeg: 10.9, rpmBack: 2686 });
  assert.ok(spin.summary.apexM > nospin.summary.apexM);
  assert.ok(spin.summary.hangS > nospin.summary.hangS);
});

// ─── Sample format ───

test('samples are uniform, start at the origin and end exactly on the ground', () => {
  const dt = 1 / 120;
  const fl = simulate({ v0: 60, thetaDeg: 13, rpmBack: 3200, dt });
  const s = fl.samples;
  assert.deepEqual(s[0], { t: 0, x: 0, y: 0, z: 0 });
  for (let i = 1; i < s.length; i++) assert.ok(s[i].t > s[i - 1].t, 'time strictly increases');
  // Every interval but the last (the ground crossing) is exactly dt.
  for (let i = 1; i < s.length - 1; i++) near(s[i].t - s[i - 1].t, dt, 1e-12, `interval ${i}`);
  assert.equal(s[s.length - 1].z, 0);
  assert.ok(s.every((p) => p.z >= 0), 'never below ground');
  assert.ok(s[s.length - 1].t - s[s.length - 2].t <= dt + 1e-12, 'last step is short, not long');
  assert.ok(s.length >= 60 * fl.summary.hangS, 'at least 60 Hz, as the conventions require');
});

test('at() interpolates inside the samples and clamps outside', () => {
  const fl = simulate({ v0: 60, thetaDeg: 13, rpmBack: 3200 });
  const tMid = fl.summary.hangS / 2;
  const p = fl.at(tMid);
  const i = Math.floor(tMid / fl.dt);
  assert.ok(fl.samples[i].x <= p.x && p.x <= fl.samples[i + 1].x);
  assert.deepEqual(fl.at(-1), { x: fl.samples[0].x, y: fl.samples[0].y, z: fl.samples[0].z });
  const last = fl.samples[fl.samples.length - 1];
  assert.deepEqual(fl.at(99), { x: last.x, y: last.y, z: last.z });
  // The tail interval is shorter than dt, so the index guess is wrong there —
  // this is the case the two fix-up loops in at() exist for.
  const tTail = last.t - (last.t - fl.samples[fl.samples.length - 2].t) * 0.5;
  const tail = fl.at(tTail);
  assert.ok(tail.z > 0 && tail.z < fl.samples[fl.samples.length - 2].z + 1e-9);
});

// ─── Sign conventions and symmetry ───

test('positive sidespin curves LEFT, and the mirror is exact', () => {
  const left = simulate({ v0: 60, thetaDeg: 13, rpmBack: 3200, rpmSide: 1000 });
  const right = simulate({ v0: 60, thetaDeg: 13, rpmBack: 3200, rpmSide: -1000 });
  assert.ok(left.summary.lateralM > 5, `expected a clear draw, got ${left.summary.lateralM}`);
  near(right.summary.lateralM, -left.summary.lateralM, 1e-9, 'mirror lateral');
  near(right.summary.carryM, left.summary.carryM, 1e-9, 'mirror carry');
});

test('zero sidespin is exactly planar', () => {
  const fl = simulate({ v0: 54, thetaDeg: 16.3, rpmBack: 7097 });
  assert.ok(Math.max(...fl.samples.map((p) => Math.abs(p.y))) < 1e-9);
});

test('azimuth rotates the flight without changing it', () => {
  const a = simulate({ v0: 54, thetaDeg: 16.3, rpmBack: 7097 });
  const b = simulate({ v0: 54, thetaDeg: 16.3, phiDeg: 90, rpmBack: 7097 });
  near(b.summary.carryM, a.summary.carryM, a.summary.carryM * 1e-9, 'rotated carry');
  near(b.summary.apexM, a.summary.apexM, a.summary.apexM * 1e-9, 'rotated apex');
  const last = b.samples[b.samples.length - 1];
  assert.ok(Math.abs(last.x) < 1e-6, 'a 90° azimuth lands on the +Y axis');
  near(last.y, a.samples[a.samples.length - 1].x, 1e-9, 'rotated landing');
});

test('the backspin axis points to the ball’s right', () => {
  const { nx, ny, nz, omega } = spinVector(0, 3000, 0);
  near(nx, 0, 1e-12, 'nx');
  near(ny, -1, 1e-12, 'ny');
  near(nz, 0, 1e-12, 'nz');
  near(omega, (3000 * 2 * Math.PI) / 60, 1e-9, 'omega');
});

test('TrackMan spin-axis tilt round-trips, with the sign flipped', () => {
  const tilt = spinAxisTiltDeg(2686, -1000); // negative side = curves right = positive tilt
  assert.ok(tilt > 0, `expected a positive (fade) tilt, got ${tilt}`);
  const { rpmBack, rpmSide } = spinFromAxis(Math.hypot(2686, 1000), tilt);
  near(rpmBack, 2686, 1e-9, 'rpmBack');
  near(rpmSide, -1000, 1e-9, 'rpmSide');
});

// ─── The nine TrackMan targets, all at once ───

test('all nine TrackMan targets are inside tolerance simultaneously', () => {
  const failures: string[] = [];
  for (const [club, t] of Object.entries(VALIDATION_TARGETS)) {
    const s = simulate({ v0: t.v0, thetaDeg: t.thetaDeg, rpmBack: t.rpmBack, dt: 1 / 120 }).summary;
    const checks: Array<[string, number, number | null, number]> = [
      ['carryM', s.carryM, t.carryM, t.carryM * VALIDATION_TOLERANCE.carryRel],
      ['apexM', s.apexM, t.apexM, t.apexM * VALIDATION_TOLERANCE.apexRel],
      ['hangS', s.hangS, t.hangS, (t.hangS ?? 0) * VALIDATION_TOLERANCE.hangRel],
      ['landAngleDeg', s.landAngleDeg, t.landAngleDeg, VALIDATION_TOLERANCE.landAbsDeg],
    ];
    for (const [name, sim, target, tol] of checks) {
      if (target === null) continue; // no published target for this club/metric
      if (Math.abs(sim - target) > tol) {
        failures.push(`${club}.${name}: ${sim.toFixed(2)} vs ${target} ± ${tol.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `TrackMan targets missed: ${failures.join('; ')}`);
});

test('driver numbers match the lab report to the digit it published', () => {
  const s = simulate({ v0: 75, thetaDeg: 10.9, rpmBack: 2686, dt: 1 / 120 }).summary;
  near(s.carryM, 247.0, 0.5, 'carry');
  near(s.apexM, 29.3, 0.3, 'apex');
  near(s.hangS, 6.68, 0.05, 'hang');
  near(s.landAngleDeg, 37.0, 0.3, 'landing angle');
});

test('held-out LPGA shots generalise in carry, and land ~3° shallow', () => {
  // NOT fitted. Report §"Hold-out check": targets quoted from memory of
  // TrackMan's LPGA table, so ±2 %. The point of this test is the BIAS: it
  // pins the known shallow landing angle so nobody downstream mistakes the
  // simulated descent for a measurement.
  const driver = simulate({ v0: 62.6, thetaDeg: 13.2, rpmBack: 2611 }).summary;
  const iron = simulate({ v0: 46.5, thetaDeg: 19.0, rpmBack: 6699 }).summary;
  near(driver.carryM, 201.3, 1.0, 'LPGA driver carry (report value)');
  near(iron.carryM, 133.4, 1.0, 'LPGA 7-iron carry (report value)');
  assert.ok(Math.abs(driver.carryM - 199) / 199 < 0.04, 'LPGA driver carry within 4 % of target');
  assert.ok(Math.abs(iron.carryM - 129) / 129 < 0.04, 'LPGA 7-iron carry within 4 % of target');
  // Both shallow, by roughly 3°, in the same direction as the fitted residuals.
  assert.ok(driver.landAngleDeg < 37 - 2, `LPGA driver landing ${driver.landAngleDeg} should be shallow`);
  assert.ok(iron.landAngleDeg < 47 - 2, `LPGA 7-iron landing ${iron.landAngleDeg} should be shallow`);
  assert.ok(driver.landAngleDeg > 37 - 5 && iron.landAngleDeg > 47 - 5, 'shallow by ~3°, not broken');
});

/**
 * Cross-check against the Python this was ported from. The five rows below were
 * printed by `tracer-lab/lib/flight.py` itself (CPython 3.12,
 * `simulate(v0, theta, 0, rpm, 0, dt=1/120).summary()`) and pasted here at ten
 * decimal places; the TypeScript agrees with every one of them to the last
 * digit printed. That is what makes this a port rather than a re-derivation —
 * so if an edit moves any of these, the maths changed, not the rounding.
 */
test('the port reproduces the lab Python to 1e-9', () => {
  const rows: Array<[string, number, number, number, [number, number, number, number]]> = [
    ['driver', 75, 10.9, 2686, [246.9995047237, 29.2666968135, 6.6830019556, 36.9734546064]],
    ['7-iron', 54, 16.3, 7097, [159.7443665301, 30.5525806426, 6.2660730988, 47.0124684919]],
    ['PW', 46, 24.2, 9304, [120.5201598760, 27.4753531785, 5.5610188864, 50.4422544442]],
    ['LPGA driver', 62.6, 13.2, 2611, [201.2808060098, 23.0217044313, 5.7946631187, 33.7980007788]],
    ['LPGA 7-iron', 46.5, 19.0, 6699, [133.4459064623, 23.6040036283, 5.4407394152, 43.5079854526]],
  ];
  for (const [name, v0, thetaDeg, rpmBack, [carry, apex, hang, land]] of rows) {
    const s = simulate({ v0, thetaDeg, rpmBack, dt: 1 / 120 }).summary;
    near(s.carryM, carry, 1e-9, `${name} carry`);
    near(s.apexM, apex, 1e-9, `${name} apex`);
    near(s.hangS, hang, 1e-9, `${name} hang`);
    near(s.landAngleDeg, land, 1e-9, `${name} landing angle`);
  }
});

// ─── Integrator quality ───

test('dt convergence: 1/60 and 1/240 agree', () => {
  // The lab measured 30 Hz already within 1 mm of a 2400 Hz reference, so the
  // step is not where any error lives. 1/60 is what a phone would use.
  for (const [club, t] of Object.entries(VALIDATION_TARGETS)) {
    const coarse = simulate({ v0: t.v0, thetaDeg: t.thetaDeg, rpmBack: t.rpmBack, dt: 1 / 60 }).summary;
    const fine = simulate({ v0: t.v0, thetaDeg: t.thetaDeg, rpmBack: t.rpmBack, dt: 1 / 240 }).summary;
    near(coarse.carryM, fine.carryM, 0.02, `${club} carry`);
    near(coarse.hangS, fine.hangS, 0.002, `${club} hang`);
    near(coarse.landAngleDeg, fine.landAngleDeg, 0.02, `${club} landing angle`);
    near(coarse.apexM, fine.apexM, 0.02, `${club} apex`);
  }
});

test('spin decay has a monotonic effect on apex and hang', () => {
  const at = (spinDecay: number) =>
    simulate({ v0: 75, thetaDeg: 10.9, rpmBack: 2686, model: { ...DEFAULT_AERO, spinDecay } }).summary;
  const a = at(0);
  const b = at(0.045);
  const c = at(0.09);
  assert.ok(a.apexM > b.apexM && b.apexM > c.apexM);
  assert.ok(a.hangS > b.hangS && b.hangS > c.hangS);
});

// ─── Inverse and priors ───

test('carry is monotonic in v0 across the golf range', () => {
  for (const [club, t] of Object.entries(VALIDATION_TARGETS)) {
    let prev = -Infinity;
    for (let v = 20; v <= 100; v += 5) {
      const c = simulate({ v0: v, thetaDeg: t.thetaDeg, rpmBack: t.rpmBack }).summary.carryM;
      assert.ok(c > prev, `${club}: carry not monotonic at v0=${v}`);
      prev = c;
    }
  }
});

test('solveV0ForCarry round-trips each TrackMan club', () => {
  for (const [club, t] of Object.entries(VALIDATION_TARGETS)) {
    const c = simulate({ v0: t.v0, thetaDeg: t.thetaDeg, rpmBack: t.rpmBack }).summary.carryM;
    near(solveV0ForCarry(c, t.thetaDeg, t.rpmBack), t.v0, 0.05, `${club} v0`);
  }
});

test('solveV0ForCarry throws rather than clamping an unreachable carry', () => {
  assert.throws(() => solveV0ForCarry(400, 10.9, 2686), /outside bracket/);
});

test('inferLaunch picks the bucket the lab picks, and never picks pitch', () => {
  assert.equal(inferLaunch(90).bucket, 'wedge');
  assert.equal(inferLaunch(200).bucket, 'driver');
  assert.equal(inferLaunch(130).bucket, 'shortIron');
  assert.equal(inferLaunch(170).bucket, 'longIron');
  // A 30 m chip is outside every band; it must fall back to the nearest one
  // (wedge), not silently become a pitch — pitch is caller-selected only.
  assert.equal(inferLaunch(30).bucket, 'wedge');
  assert.equal(inferLaunch(30, 'pitch').bucket, 'pitch');
  const driver = inferLaunch(200);
  assert.ok(driver.v0InRange, `solved v0 ${driver.v0} outside the driver band`);
});

test('Henry’s 55–68 m/s driver band carries the distance the lab reports', () => {
  const lo = simulate({ v0: 55, thetaDeg: 13, rpmBack: 3200 }).summary.carryM;
  const hi = simulate({ v0: 68, thetaDeg: 13, rpmBack: 3200 }).summary.carryM;
  assert.ok(lo > 160 && lo < 185, `55 m/s carried ${lo} m`);
  assert.ok(hi > 215 && hi < 240, `68 m/s carried ${hi} m`);
});

test('club priors are ordered and the lab bucket names map', () => {
  for (const [bucket, p] of Object.entries(CLUB_PRIORS)) {
    for (const band of [p.thetaDeg, p.rpmBack, p.v0]) {
      assert.ok(band[0] <= band[1] && band[1] <= band[2], `${bucket}: [lo, typ, hi] out of order`);
    }
    assert.ok(p.carryM[0] < p.carryM[1], `${bucket}: carry band inverted`);
    assert.ok(p.rollFrac[0] <= p.rollFrac[1], `${bucket}: roll band inverted`);
  }
  assert.equal(bucketFromLabName('short_iron'), 'shortIron');
  assert.equal(bucketFromLabName('driver'), 'driver');
  // 'generic' is the ABSENCE of a bucket in the lab and must stay distinguishable.
  assert.equal(bucketFromLabName('generic'), null);
});

// ─── Runtime budget ───

test('one flight costs well under 3 ms — this runs inside the fit loop', () => {
  const args = { v0: 75, thetaDeg: 10.9, rpmBack: 2686, dt: 1 / 60 };
  for (let i = 0; i < 50; i++) simulate(args); // warm the JIT
  const reps = 200;
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) simulate(args);
  const ms = (performance.now() - t0) / reps;
  // Also record the 1/120 cost, which is the module default.
  const t1 = performance.now();
  for (let i = 0; i < reps; i++) simulate({ ...args, dt: 1 / 120 });
  const ms120 = (performance.now() - t1) / reps;
  console.log(`  tracerPhysics: ${ms.toFixed(3)} ms/flight @ 1/60, ${ms120.toFixed(3)} ms @ 1/120`);
  assert.ok(ms < 3, `${ms.toFixed(3)} ms per flight at dt=1/60 (budget 3 ms)`);
});
