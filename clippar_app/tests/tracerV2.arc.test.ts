import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitDetectedTrack,
  buildArcSpecV2,
  type TrackPoint,
  type ShotCarry,
  type CarryTier,
  type BuildArcInputV2,
} from '../lib/tracerV2';
import {
  projectLanding,
  portraitHFovDeg,
  bucketForCarry,
  computeHorizonY,
  TRACER_PRIORS,
} from '../lib/tracerMath';

// S7 — fitDetectedTrack + buildArcSpecV2. Invariants I1–I10 + I11a from the
// plan (V7). All coords normalized, bottom-left origin, y-up.

const HFOV_LAND = 62;
const VFOV = 62;
const HORIZON = 0.52;
const CAMH = 1.0;

// ── Synthetic detected track: launch at p0, screen velocity (vx, vy),
//    slight screen-space deceleration, sampled over `thSec`. ──
function makeTrack(
  p0: { x: number; y: number },
  vx: number,
  vy: number,
  thSec: number,
  n = 10,
): TrackPoint[] {
  const pts: TrackPoint[] = [];
  const gScreen = 0.3; // mild downward curvature in screen space
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * thSec;
    pts.push({
      x: p0.x + vx * t,
      y: p0.y + vy * t - 0.5 * gScreen * t * t,
      tMs: t * 1000,
    });
  }
  return pts;
}

function mkCarry(
  carryM: number,
  deltaDeg: number | null,
  tier: CarryTier = 1,
): ShotCarry {
  return {
    carryM,
    bearingDeg: 270,
    deltaDeg,
    sigmaD: 4,
    tier,
    labelText: tier === 1 ? `${Math.round(carryM)}m` : tier === 2 ? `~${Math.round(carryM)}m` : null,
    tierReason: null,
  };
}

function landingFor(carryM: number, deltaDeg: number) {
  return projectLanding({
    deltaDeg,
    carryM,
    horizonY: HORIZON,
    hFovPortraitDeg: portraitHFovDeg(HFOV_LAND),
    vFovPortraitDeg: VFOV,
    tripodHeightM: CAMH,
  });
}

function buildFrom(opts: {
  p0?: { x: number; y: number };
  vx?: number;
  vy?: number;
  thSec?: number;
  carryM?: number;
  deltaDeg?: number;
  tier?: CarryTier;
  maxAnimSec?: number;
}) {
  const p0 = opts.p0 ?? { x: 0.5, y: 0.15 };
  const track = makeTrack(p0, opts.vx ?? 0.05, opts.vy ?? 0.4, opts.thSec ?? 0.4);
  const fit = fitDetectedTrack(track);
  const carryM = opts.carryM ?? 150;
  const deltaDeg = opts.deltaDeg ?? -10;
  const carry = mkCarry(carryM, deltaDeg, opts.tier ?? 1);
  const landing = landingFor(carryM, deltaDeg);
  const input: BuildArcInputV2 = {
    fit,
    carry,
    landing,
    horizonY: HORIZON,
    vFovPortraitDeg: VFOV,
    camHeightM: CAMH,
    animStartSec: 0.1,
    maxAnimSec: opts.maxAnimSec ?? 6.5,
  };
  return { fit, carry, landing, spec: buildArcSpecV2(input) };
}

// Velocity of the polyline across the segment-1→segment-2 seam, computed from
// the ACTUAL samples (not meta) — for non-tautological C1 / speed-ratio checks.
// The seam is located by the sample nearest meta.handoff (robust to timeline
// compression, which shifts tSec but not the seam's spatial position).
function seamVels(spec: {
  samples: { x: number; y: number; tSec: number }[];
  meta: { handoff: { x: number; y: number } };
}) {
  const h = spec.meta.handoff;
  let k = 0;
  let best = Infinity;
  for (let i = 0; i < spec.samples.length; i++) {
    const d = Math.hypot(spec.samples[i].x - h.x, spec.samples[i].y - h.y);
    if (d < best) {
      best = d;
      k = i;
    }
  }
  const fd = (a: { x: number; y: number; tSec: number }, b: typeof a) => {
    const dt = b.tSec - a.tSec || 1e-9;
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  };
  const before = k > 0 ? fd(spec.samples[k - 1], spec.samples[k]) : null;
  const after = k < spec.samples.length - 1 ? fd(spec.samples[k], spec.samples[k + 1]) : null;
  return { before, after, k };
}

// ── fitDetectedTrack ──

test('fitDetectedTrack: recovers a clean quadratic track; handoff velocity finite', () => {
  const track = makeTrack({ x: 0.5, y: 0.15 }, 0.1, 0.5, 0.5, 12);
  const fit = fitDetectedTrack(track);
  assert.equal(fit.degenerate, false);
  if (fit.degenerate) return;
  assert.ok(Math.abs(fit.p0.x - 0.5) < 0.02, `p0.x=${fit.p0.x}`);
  assert.ok(fit.ph.x > fit.p0.x, 'handoff drifts right of launch');
  assert.ok(Number.isFinite(fit.vh.x) && Number.isFinite(fit.vh.y));
  assert.ok(fit.vy0 >= 0 && fit.vy0 <= 1);
  assert.equal(fit.latSign, 1);
});

test('fitDetectedTrack: < 5 points → degenerate D2 (NaN-free, carries raw points)', () => {
  const fit = fitDetectedTrack([
    { x: 0.5, y: 0.15, tMs: 0 },
    { x: 0.52, y: 0.2, tMs: 60 },
    { x: 0.54, y: 0.25, tMs: 120 },
  ]);
  assert.equal(fit.degenerate, true);
  if (!fit.degenerate) return;
  assert.equal(fit.reason, 'D2');
  assert.equal(fit.points.length, 3);
});

test('fitDetectedTrack: span < 150ms → degenerate', () => {
  const track = makeTrack({ x: 0.5, y: 0.15 }, 0.1, 0.5, 0.1, 8); // 100ms span
  const fit = fitDetectedTrack(track);
  assert.equal(fit.degenerate, true);
});

// ── Invariants I1–I10 + I11a on a nominal arc ──

test('I1/I2 C0+C1 continuity at handoff (well-behaved: raw == effective)', () => {
  // Drift agrees with the landing side (+x) and vy is below the A4 clamp, so
  // neither the straightening nor the V_h.y clamp is active → raw handoff
  // velocity == effective, and segment 1 is NOT re-pinned.
  const { spec } = buildFrom({ vx: 0.04, vy: 0.4, thSec: 0.4, carryM: 150, deltaDeg: 12 });
  const m = spec.meta;
  assert.equal(m.seg1Repinned, false);
  // meta witnesses (raw IN vs effective OUT) coincide because nothing clamped.
  assert.ok(Math.abs(m.vHandoffIn.x - m.vHandoffOut.x) < 1e-9, `metaC1x ${m.vHandoffIn.x} vs ${m.vHandoffOut.x}`);
  assert.ok(Math.abs(m.vHandoffIn.y - m.vHandoffOut.y) < 1e-9, `metaC1y ${m.vHandoffIn.y} vs ${m.vHandoffOut.y}`);
  // C1 on the ACTUAL polyline (not meta): the seam velocity is continuous.
  const { before, after } = seamVels(spec);
  assert.ok(before && after, 'seam found');
  assert.ok(Math.abs(before!.x - after!.x) < 0.05 && Math.abs(before!.y - after!.y) < 0.05, `polyC1 ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  // C0: a sample sits exactly at the handoff position.
  const near = spec.samples.reduce((best, s) =>
    Math.abs(s.x - m.handoff.x) + Math.abs(s.y - m.handoff.y) <
    Math.abs(best.x - m.handoff.x) + Math.abs(best.y - m.handoff.y)
      ? s
      : best,
  );
  assert.ok(Math.abs(near.x - m.handoff.x) < 1e-2 && Math.abs(near.y - m.handoff.y) < 1e-2);
});

test('I3 exact endpoint: last sample == GPS landing (no F8b override)', () => {
  // vx (+) agrees with delta (+) → no lateral-sign override → endpoint == GPS.
  const { spec, landing } = buildFrom({ carryM: 180, deltaDeg: 20, vx: 0.05 });
  const last = spec.samples[spec.samples.length - 1];
  assert.equal(spec.meta.override, false);
  assert.ok(Math.abs(last.x - landing.x) < 1e-6, `x ${last.x} vs ${landing.x}`);
  assert.ok(Math.abs(last.y - landing.y) < 1e-6, `y ${last.y} vs ${landing.y}`);
});

test('I4/I11a apex bounds: apexM ∈ [bucketLo, 1.5·bucketHi]', () => {
  for (const carryM of [40, 100, 150, 230, 290]) {
    const { spec } = buildFrom({ carryM });
    const b = bucketForCarry(carryM);
    const p = TRACER_PRIORS[b];
    assert.ok(
      spec.meta.apexM >= p.apexLoM - 1e-9 && spec.meta.apexM <= p.apexHiM * 1.5 + 1e-9,
      `carry ${carryM} (${b}): apexM=${spec.meta.apexM} not in [${p.apexLoM}, ${p.apexHiM * 1.5}]`,
    );
  }
});

test('I5 vertical monotone: rises to a single apex then descends', () => {
  const { spec } = buildFrom({ carryM: 150 });
  const ys = spec.samples.map((s) => s.y);
  let peak = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[peak]) peak = i;
  // non-decreasing up to peak, non-increasing after (small float tolerance)
  for (let i = 1; i <= peak; i++) assert.ok(ys[i] - ys[i - 1] >= -1e-6, `rise break @${i}`);
  for (let i = peak + 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] <= 1e-6, `fall break @${i}`);
});

test('I6 no lateral sign reversal: x is monotone across the whole arc', () => {
  const { spec } = buildFrom({ carryM: 150, vx: 0.06, deltaDeg: 25 });
  const xs = spec.samples.map((s) => s.x);
  const dir = Math.sign(xs[xs.length - 1] - xs[0]) || 1;
  for (let i = 1; i < xs.length; i++) {
    assert.ok((xs[i] - xs[i - 1]) * dir >= -1e-6, `lateral reversal @${i}: ${xs[i - 1]}→${xs[i]}`);
  }
});

test('I7 cross-handoff speed ratio < 1.3 (raw fit IN vs effective OUT)', () => {
  const { spec, fit } = buildFrom({ vx: 0.2, vy: 0.9, carryM: 200, thSec: 0.4 });
  assert.equal(fit.degenerate, false);
  if (fit.degenerate) return;
  // vHandoffIn is the RAW detected fit velocity; vHandoffOut the EFFECTIVE
  // (clamped) synthetic entry — different sources, so this is not tautological.
  const inSpd = Math.hypot(fit.vh.x, fit.vh.y);
  assert.ok(Math.abs(spec.meta.vHandoffIn.x - fit.vh.x) < 1e-9, 'vHandoffIn == raw fit');
  const outSpd = Math.hypot(spec.meta.vHandoffOut.x, spec.meta.vHandoffOut.y);
  assert.ok(outSpd / Math.max(inSpd, 1e-9) < 1.3, `ratio ${outSpd / inSpd}`);
  // And the actual polyline has no gross velocity jump at the seam.
  const { before, after } = seamVels(spec);
  if (before && after) {
    const r = Math.hypot(after.x, after.y) / Math.max(Math.hypot(before.x, before.y), 1e-9);
    assert.ok(r < 2.0, `polyline seam jump ${r}`);
  }
});

test('I8 tSec strictly increasing, first == 0 (I11b precursor)', () => {
  const { spec } = buildFrom({ carryM: 150 });
  assert.equal(spec.samples[0].tSec, 0);
  for (let i = 1; i < spec.samples.length; i++) {
    assert.ok(spec.samples[i].tSec > spec.samples[i - 1].tSec, `not increasing @${i}`);
  }
  assert.ok(spec.samples.length >= 60 && spec.samples.length <= 90, `count=${spec.samples.length}`);
});

test('I9 all samples finite & roughly in-frame', () => {
  const { spec } = buildFrom({ carryM: 150, deltaDeg: 55 });
  for (const s of spec.samples) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.tSec));
    assert.ok(s.x >= -0.35 && s.x <= 1.35 && s.y >= -0.15 && s.y <= 1.15, JSON.stringify(s));
  }
});

// ── Degenerate ladder (NaN-free) ──

test('D2 direction-only handoff: degenerate fit + direction → NaN-free arc', () => {
  const fit = fitDetectedTrack([
    { x: 0.5, y: 0.15, tMs: 0 },
    { x: 0.53, y: 0.22, tMs: 80 },
  ]);
  const carry = mkCarry(150, -10, 1);
  const spec = buildArcSpecV2({
    fit,
    carry,
    landing: landingFor(150, -10),
    horizonY: HORIZON,
    vFovPortraitDeg: VFOV,
    camHeightM: CAMH,
    animStartSec: 0.1,
    maxAnimSec: 6,
    detectedDirection: { dx: 0.3, dy: 0.95 },
  });
  assert.equal(spec.meta.degenerate, 'D2');
  for (const s of spec.samples) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
  const last = spec.samples[spec.samples.length - 1];
  assert.ok(Math.abs(last.x - landingFor(150, -10).x) < 1e-6);
});

test('D3 pose-anchored synthetic (no usable vision) → NaN-free arc', () => {
  const spec = buildArcSpecV2({
    fit: { degenerate: true, reason: 'D2', points: [] },
    carry: mkCarry(120, 5, 2),
    landing: landingFor(120, 5),
    horizonY: HORIZON,
    vFovPortraitDeg: VFOV,
    camHeightM: CAMH,
    animStartSec: 0.1,
    maxAnimSec: 6,
    poseAnchor: { x: 0.48, y: 0.2 },
  });
  assert.equal(spec.meta.degenerate, 'D3');
  for (const s of spec.samples) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
});

test('D5/D6 prior-only + nothing → NaN-free (allowPriorOnlyArc gated)', () => {
  // No fit, no pose, no direction → D5 (allowPriorOnlyArc true in dev config).
  const spec = buildArcSpecV2({
    fit: { degenerate: true, reason: 'D2', points: [] },
    carry: mkCarry(200, 0, 3),
    landing: landingFor(200, 0),
    horizonY: HORIZON,
    vFovPortraitDeg: VFOV,
    camHeightM: CAMH,
    animStartSec: 0.1,
    maxAnimSec: 6,
  });
  assert.ok(spec.meta.degenerate === 'D5' || spec.meta.degenerate === 'D6');
  for (const s of spec.samples) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.tSec));
});

// ── F8b lateral-sign override log ──

test('F8b: meta always logs parallaxEstimate, curvatureResidual, override', () => {
  const { spec } = buildFrom({ carryM: 150 });
  assert.equal(typeof spec.meta.parallaxEstimate, 'number');
  assert.equal(typeof spec.meta.curvatureResidual, 'number');
  assert.equal(typeof spec.meta.override, 'boolean');
});

test('F8b: |deltaDeg| < 8° flags a straight-bow', () => {
  const { spec } = buildFrom({ carryM: 150, deltaDeg: 3 });
  assert.equal(spec.meta.straightBow, true);
});

// ── Property sweep: carry × deltaDeg × vy0 × vx × t_h ──

test('property sweep: invariants hold across carry×delta×vy0×vx×t_h×maxAnim', () => {
  const carries = [25, 80, 150, 230, 300];
  const deltas = [-60, -25, 0, 25, 60];
  const vys = [0.15, 0.5, 0.9, 1.2]; // launch climb; handoff vy = vy − 0.3·th
  const vxs = [-0.3, 0, 0.3];
  const ths = [0.15, 0.6, 1.5];
  const maxAnims = [0.8, 1.5, 3, 6.5]; // B1: short clips must not over-run
  let count = 0;
  for (const carryM of carries)
    for (const deltaDeg of deltas)
      for (const vy of vys)
        for (const vx of vxs)
          for (const thSec of ths)
            for (const maxAnimSec of maxAnims) {
              count++;
              const { spec, fit } = buildFrom({ carryM, deltaDeg, vx, vy, thSec, maxAnimSec });
              const b = bucketForCarry(carryM);
              const p = TRACER_PRIORS[b];
              const tag = `c${carryM} d${deltaDeg} vy${vy} vx${vx} th${thSec} max${maxAnimSec}`;

              for (const s of spec.samples) {
                assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.tSec), `NaN @ ${tag}`);
              }
              // strictly increasing time, first 0
              assert.equal(spec.samples[0].tSec, 0, `t0 @ ${tag}`);
              for (let i = 1; i < spec.samples.length; i++) {
                assert.ok(spec.samples[i].tSec > spec.samples[i - 1].tSec, `tSec @ ${tag}`);
              }
              // B1: last tSec EXACTLY == animDurationSec, every keyTime ≤ 1, and
              // animDurationSec ≤ maxAnimSec (else native ERR_TRACER_SPEC).
              const last = spec.samples[spec.samples.length - 1];
              assert.ok(Math.abs(last.tSec - spec.animDurationSec) < 1e-9, `lastT==animDur @ ${tag}: ${last.tSec} vs ${spec.animDurationSec}`);
              assert.ok(spec.animDurationSec <= maxAnimSec + 1e-6, `animDur≤max @ ${tag}`);
              for (const s of spec.samples) assert.ok(s.tSec / spec.animDurationSec <= 1 + 1e-9, `keyTime≤1 @ ${tag}`);
              // exact endpoint (== meta.endpoint; F8b may flip the side)
              assert.ok(Math.abs(last.x - spec.meta.endpoint.x) < 1e-6 && Math.abs(last.y - spec.meta.endpoint.y) < 1e-6, `endpoint @ ${tag}`);
              // apex bounds / I11a
              assert.ok(spec.meta.apexM >= p.apexLoM - 1e-9 && spec.meta.apexM <= p.apexHiM * 1.5 + 1e-9, `apex @ ${tag}: ${spec.meta.apexM}`);
              // B2: vertical strictly one-peak (rise then fall) for EVERY case —
              // no wrong-sign plunge/jump.
              const ys = spec.samples.map((s) => s.y);
              let pk = 0;
              for (let i = 1; i < ys.length; i++) if (ys[i] > ys[pk]) pk = i;
              for (let i = 1; i <= pk; i++) assert.ok(ys[i] - ys[i - 1] >= -1e-6, `rise @ ${tag} i${i}`);
              for (let i = pk + 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] <= 1e-6, `fall @ ${tag} i${i}`);
              // MAJOR 1: no endpoint teleport. A real descent steepens smoothly
              // (last step ≈ the adjacent step); the gDown-cap teleport bug made
              // the forced endpoint jump ~14× the prior step. Assert the last
              // step is within 3× the previous step (catches teleports, allows
              // smooth steepening).
              const steps: number[] = [];
              for (let i = 1; i < spec.samples.length; i++) steps.push(Math.hypot(spec.samples[i].x - spec.samples[i - 1].x, spec.samples[i].y - spec.samples[i - 1].y));
              const nS = steps.length;
              assert.ok(steps[nS - 1] <= 3 * steps[nS - 2] + 1e-6, `endpoint teleport @ ${tag}: last ${steps[nS - 1].toFixed(4)} vs prev ${steps[nS - 2].toFixed(4)}`);
              // cross-handoff speed ratio (I7): effective synthetic entry speed
              // vs the RAW detected fit speed. Non-tautological — vHandoffIn is
              // the raw fit velocity, vHandoffOut the effective (clamped/
              // straightened) one; the clamp only ever reduces, so ratio ≤ 1.
              // Only meaningful with a real detected→synthetic seam.
              if (!fit.degenerate) {
                const inSpd = Math.hypot(spec.meta.vHandoffIn.x, spec.meta.vHandoffIn.y);
                const outSpd = Math.hypot(spec.meta.vHandoffOut.x, spec.meta.vHandoffOut.y);
                assert.ok(outSpd / Math.max(inSpd, 1e-9) < 1.3, `speedratio @ ${tag}: ${outSpd / inSpd}`);
              }
              // no lateral sign reversal
              const xs = spec.samples.map((s) => s.x);
              const dir = Math.sign(xs[xs.length - 1] - xs[0]) || 1;
              for (let i = 1; i < xs.length; i++) {
                assert.ok((xs[i] - xs[i - 1]) * dir >= -1e-4, `lateral reversal @ ${tag} i${i}`);
              }
            }
  assert.ok(count === 5 * 5 * 4 * 3 * 3 * 4, `swept ${count}`);
});

// ════════════════════════════════════════════════════════════════════════
// A8 — camera-angle robustness: roll compensation + off-axis degrade
// ════════════════════════════════════════════════════════════════════════

const FRAME_ASPECT = 9 / 16;
function rot(x: number, y: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = x - 0.5;
  const dy = y - 0.5;
  return {
    x: 0.5 + dx * c - (dy * s) / FRAME_ASPECT,
    y: 0.5 + dx * s * FRAME_ASPECT + dy * c,
  };
}

function buildA8(opts: {
  rollDeg: number;
  pitchDownDeg: number;
  deltaDeg: number;
  carryM?: number;
}) {
  const carryM = opts.carryM ?? 150;
  const horizonY = computeHorizonY(opts.pitchDownDeg, VFOV);
  const track = makeTrack({ x: 0.5, y: 0.15 }, 0.05, 0.4, 0.4);
  const fit = fitDetectedTrack(track);
  const landing = projectLanding({
    deltaDeg: opts.deltaDeg,
    carryM,
    horizonY,
    hFovPortraitDeg: portraitHFovDeg(HFOV_LAND),
    vFovPortraitDeg: VFOV,
    tripodHeightM: CAMH,
  });
  const base: BuildArcInputV2 = {
    fit,
    carry: mkCarry(carryM, opts.deltaDeg, 1),
    landing,
    horizonY,
    vFovPortraitDeg: VFOV,
    camHeightM: CAMH,
    animStartSec: 0.1,
    maxAnimSec: 6.5,
  };
  const spec0 = buildArcSpecV2({ ...base, rollDeg: 0 });
  const specR = buildArcSpecV2({ ...base, rollDeg: opts.rollDeg });
  return { spec0, specR, horizonY };
}

test('A8 roll×pitch×deltaDeg sweep: rotated-arc invariants hold', () => {
  const rolls = [-8, 8, 15];
  const pitches = [-10, 0, 10];
  const deltas = [0, 30, 60];
  for (const rollDeg of rolls)
    for (const pitchDownDeg of pitches)
      for (const deltaDeg of deltas) {
        const { spec0, specR } = buildA8({ rollDeg, pitchDownDeg, deltaDeg });
        const tag = `roll${rollDeg} pitch${pitchDownDeg} d${deltaDeg}`;
        // none of these should degrade (roll ≤ 15, |delta| ≤ 60)
        assert.equal(specR.meta.offAxis, false, `unexpected degrade @ ${tag}`);
        assert.equal(specR.meta.rollDeg, rollDeg, `rollDeg logged @ ${tag}`);

        // (1) endpoint rotates WITH the frame: specR endpoint == rot(spec0 endpoint)
        const er = rot(spec0.meta.endpoint.x, spec0.meta.endpoint.y, rollDeg);
        assert.ok(
          Math.abs(specR.meta.endpoint.x - er.x) < 1e-9 &&
            Math.abs(specR.meta.endpoint.y - er.y) < 1e-9,
          `endpoint rotation @ ${tag}`,
        );
        // last sample == rotated endpoint (exact endpoint under rotation)
        const last = specR.samples[specR.samples.length - 1];
        assert.ok(Math.abs(last.x - er.x) < 1e-6 && Math.abs(last.y - er.y) < 1e-6, `last==endpoint @ ${tag}`);

        // (2) C1 preserved under rotation: both handoff velocity witnesses
        //     rotate consistently (rotation is linear → any continuity gap is
        //     preserved). Vector rotation about the origin in aspect space.
        const rr = (rollDeg * Math.PI) / 180;
        const cV = Math.cos(rr), sV = Math.sin(rr), aspV = 9 / 16;
        const rotV = (v: { x: number; y: number }) => ({
          x: v.x * cV - (v.y * sV) / aspV,
          y: v.x * sV * aspV + v.y * cV,
        });
        const rIn = rotV(spec0.meta.vHandoffIn);
        const rOut = rotV(spec0.meta.vHandoffOut);
        assert.ok(
          Math.abs(specR.meta.vHandoffIn.x - rIn.x) < 1e-9 && Math.abs(specR.meta.vHandoffIn.y - rIn.y) < 1e-9,
          `vIn rotates @ ${tag}`,
        );
        assert.ok(
          Math.abs(specR.meta.vHandoffOut.x - rOut.x) < 1e-9 && Math.abs(specR.meta.vHandoffOut.y - rOut.y) < 1e-9,
          `vOut rotates @ ${tag}`,
        );

        // (3) horizon-relative apex unchanged: apexM invariant, and the apex
        //     sample rotates together with everything else.
        assert.equal(specR.meta.apexM, spec0.meta.apexM, `apexM invariant @ ${tag}`);
        let pk = 0;
        for (let i = 1; i < spec0.samples.length; i++) if (spec0.samples[i].y > spec0.samples[pk].y) pk = i;
        const apexRot = rot(spec0.samples[pk].x, spec0.samples[pk].y, rollDeg);
        assert.ok(
          Math.abs(specR.samples[pk].x - apexRot.x) < 1e-9 &&
            Math.abs(specR.samples[pk].y - apexRot.y) < 1e-9,
          `apex rotates together @ ${tag}`,
        );

        // all samples finite + strictly increasing time
        assert.equal(specR.samples[0].tSec, 0, `t0 @ ${tag}`);
        for (let i = 1; i < specR.samples.length; i++) {
          assert.ok(Number.isFinite(specR.samples[i].x) && Number.isFinite(specR.samples[i].y));
          assert.ok(specR.samples[i].tSec > specR.samples[i - 1].tSec, `tSec @ ${tag}`);
        }
      }
});

test('A8 degrade: |roll| > 15° → not compensated, rollExceeded + offAxis, no label', () => {
  const { specR } = buildA8({ rollDeg: 20, pitchDownDeg: 0, deltaDeg: 10 });
  assert.equal(specR.meta.rollExceeded, true);
  assert.equal(specR.meta.offAxis, true);
  assert.equal(specR.meta.rollDeg, 0); // not roll-compensated
  assert.equal(specR.labelText, null);
  assert.equal(specR.meta.labelText, null);
  for (const s of specR.samples) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.tSec));
});

test('A8 boundary: roll exactly 15° still compensates (not degraded)', () => {
  const { specR } = buildA8({ rollDeg: 15, pitchDownDeg: 0, deltaDeg: 10 });
  assert.equal(specR.meta.rollExceeded, false);
  assert.equal(specR.meta.offAxis, false);
  assert.equal(specR.meta.rollDeg, 15);
});

test('A8 degrade: |deltaDeg| > 60° (side-on) → offAxis, detected+tail, no label/anchor', () => {
  const { specR } = buildA8({ rollDeg: 0, pitchDownDeg: 0, deltaDeg: 70 });
  assert.equal(specR.meta.offAxis, true);
  assert.equal(specR.meta.rollExceeded, false);
  assert.equal(specR.labelText, null);
  // endpoint is the tail end (NOT the GPS landing) — no landing anchor
  const last = specR.samples[specR.samples.length - 1];
  assert.ok(Math.abs(last.x - specR.meta.endpoint.x) < 1e-9);
  for (const s of specR.samples) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
});

test('A8 boundary: deltaDeg exactly 60° still renders a full arc (not degraded)', () => {
  const { specR } = buildA8({ rollDeg: 0, pitchDownDeg: 0, deltaDeg: 60 });
  assert.equal(specR.meta.offAxis, false);
  assert.ok(specR.labelText !== null);
});

test('A8 null roll is treated as 0 (no rotation, no crash)', () => {
  const track = makeTrack({ x: 0.5, y: 0.15 }, 0.05, 0.4, 0.4);
  const spec = buildArcSpecV2({
    fit: fitDetectedTrack(track),
    carry: mkCarry(150, -10, 1),
    landing: landingFor(150, -10),
    horizonY: HORIZON,
    vFovPortraitDeg: VFOV,
    camHeightM: CAMH,
    animStartSec: 0.1,
    maxAnimSec: 6.5,
    rollDeg: null,
  });
  assert.equal(spec.meta.rollDeg, 0);
  assert.equal(spec.meta.offAxis, false);
});

// ════════════════════════════════════════════════════════════════════════
// Reviewer repro regressions (B1 / B2 / B3 / MAJOR 1)
// ════════════════════════════════════════════════════════════════════════

test('B1 repro: thSec=0.6, maxAnimSec=1.0 → last tSec == animDurationSec, keyTimes ≤ 1', () => {
  const { spec } = buildFrom({ thSec: 0.6, maxAnimSec: 1.0, carryM: 150, vx: 0.05, vy: 0.5 });
  const last = spec.samples[spec.samples.length - 1];
  assert.ok(Math.abs(last.tSec - spec.animDurationSec) < 1e-9, `last ${last.tSec} vs animDur ${spec.animDurationSec}`);
  assert.ok(spec.animDurationSec <= 1.0 + 1e-6, `animDur ${spec.animDurationSec} > maxAnim`);
  for (const s of spec.samples) assert.ok(s.tSec / spec.animDurationSec <= 1 + 1e-9, `keyTime>1 @ ${s.tSec}`);
});

test('B1 sweep: last tSec == animDurationSec exactly for maxAnim ∈ {0.8,1.5,3,6.5}', () => {
  for (const maxAnimSec of [0.8, 1.5, 3, 6.5])
    for (const thSec of [0.15, 0.6, 1.5]) {
      const { spec } = buildFrom({ thSec, maxAnimSec, carryM: 150 });
      const last = spec.samples[spec.samples.length - 1];
      assert.ok(Math.abs(last.tSec - spec.animDurationSec) < 1e-9, `max${maxAnimSec} th${thSec}: ${last.tSec} vs ${spec.animDurationSec}`);
      assert.ok(spec.animDurationSec <= maxAnimSec + 1e-6);
    }
});

test('B2 repro: vy=0.15, th=1.5 (handoff vy goes negative) → vertical monotone, no jump', () => {
  const { spec } = buildFrom({ vy: 0.15, thSec: 1.5, vx: 0.05, carryM: 150 });
  const ys = spec.samples.map((s) => s.y);
  let pk = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[pk]) pk = i;
  for (let i = 1; i <= pk; i++) assert.ok(ys[i] - ys[i - 1] >= -1e-6, `rise break @${i}`);
  for (let i = pk + 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] <= 1e-6, `fall break @${i}`);
  // No mid-arc teleport: the reported bug jumped 1.34–1.49 screen-heights.
  let maxJump = 0;
  for (let i = 1; i < ys.length; i++) maxJump = Math.max(maxJump, Math.abs(ys[i] - ys[i - 1]));
  assert.ok(maxJump < 0.2, `max vertical step ${maxJump}`);
});

test('B3 negative: laterally-straight track (gravity sag only) does NOT trip F8b override', () => {
  for (const thSec of [1.0, 1.2, 1.4]) {
    // x strictly linear (no lateral curve); y has strong gravity sag.
    const track: TrackPoint[] = [];
    for (let i = 0; i < 12; i++) {
      const t = (i / 11) * thSec;
      track.push({ x: 0.5 + 0.02 * t, y: 0.2 + 0.6 * t - 0.5 * 0.9 * t * t, tMs: t * 1000 });
    }
    const fit = fitDetectedTrack(track);
    assert.equal(fit.degenerate, false);
    if (fit.degenerate) continue;
    assert.ok(fit.curvatureResidual <= 0.02, `th${thSec}: lateral curvRes ${fit.curvatureResidual} should be ~0 for gravity sag`);
    // GPS lands left; detected drift is a hair right (parallax). Override must
    // NOT fire (no real lateral curvature) → endpoint stays on the GPS side.
    const spec = buildArcSpecV2({
      fit,
      carry: mkCarry(150, -20, 1),
      landing: landingFor(150, -20),
      horizonY: HORIZON,
      vFovPortraitDeg: VFOV,
      camHeightM: CAMH,
      animStartSec: 0.1,
      maxAnimSec: 6.5,
    });
    assert.equal(spec.meta.override, false, `th${thSec}: override fired on gravity sag`);
  }
});

test('B3 positive: a genuine curving fade DOES trip F8b override', () => {
  // x has real quadratic curvature (a fade): drifts right then curves; GPS says
  // left. Strong lateral curvature + drift beyond parallax → override fires.
  const thSec = 1.2;
  const track: TrackPoint[] = [];
  for (let i = 0; i < 12; i++) {
    const t = (i / 11) * thSec;
    const s = t / thSec;
    track.push({ x: 0.5 + 0.28 * s * s, y: 0.2 + 0.6 * t - 0.5 * 0.4 * t * t, tMs: t * 1000 });
  }
  const fit = fitDetectedTrack(track);
  assert.equal(fit.degenerate, false);
  if (fit.degenerate) return;
  assert.ok(fit.curvatureResidual > 0.02, `curvRes ${fit.curvatureResidual} should exceed 0.02 for a fade`);
  const spec = buildArcSpecV2({
    fit,
    carry: mkCarry(150, -20, 1), // GPS says LEFT, vision curves RIGHT
    landing: landingFor(150, -20),
    horizonY: HORIZON,
    vFovPortraitDeg: VFOV,
    camHeightM: CAMH,
    animStartSec: 0.1,
    maxAnimSec: 6.5,
  });
  assert.equal(spec.meta.override, true, 'override should fire on a genuine fade');
  assert.equal(spec.meta.lateralSource, 'vision');
});

test('MAJOR 1: gDown never exceeds the gMax·gUp cap, and the endpoint is not teleported', () => {
  // Sweep params that push toward a steep descent (high apex, close landing).
  for (const carryM of [50, 90, 150, 260])
    for (const vy of [0.5, 0.9, 1.2])
      for (const thSec of [0.3, 0.6]) {
        const { spec } = buildFrom({ carryM, vy, thSec, deltaDeg: 5, maxAnimSec: 6.5 });
        if (spec.meta.degenerate !== 'D1') continue;
        // cap respected (+0.02 for the round2 on the exposed meta values)
        assert.ok(spec.meta.gDown <= 1.5 * spec.meta.gUp + 0.02, `c${carryM} vy${vy} th${thSec}: gDown ${spec.meta.gDown} > 1.5·gUp ${spec.meta.gUp}`);
        // no endpoint teleport: last step within 3× the previous step
        const s = spec.samples;
        const lastStep = Math.hypot(s[s.length - 1].x - s[s.length - 2].x, s[s.length - 1].y - s[s.length - 2].y);
        const prevStep = Math.hypot(s[s.length - 2].x - s[s.length - 3].x, s[s.length - 2].y - s[s.length - 3].y);
        assert.ok(lastStep <= 3 * prevStep + 1e-6, `c${carryM} vy${vy} th${thSec}: teleport last ${lastStep} vs prev ${prevStep}`);
      }
});
