/**
 * Tracer geometry SIMULATION HARNESS — runs the exact production math
 * (lib/tracerMath.ts) against synthetic GPS rounds, no phone required.
 *
 *   npx tsx scripts/simulate-tracer.ts
 *
 * Each scenario plants shot N at a fixed tee, derives shot N+1 by moving
 * carryM meters along bearingDeg (inverse haversine), then runs the same
 * precheckArcGeometry + buildArcSpec the app runs and asserts:
 *   - recovered carry matches the planted distance (GPS math round-trips)
 *   - bearing delta sign/magnitude → xLand lands on the correct side
 *   - arc shape is sane (apex above launch+landing, points in [0,1]-ish)
 *   - animation timing fits inside the clip
 */
import {
  haversineMeters,
  initialBearingDeg,
  precheckArcGeometry,
  buildArcSpec,
  isTracerSkip,
  projectLanding,
  portraitHFovDeg,
  computeHorizonY,
  bucketForCarry,
  TRACER_PRIORS,
  type TracerGeometryInput,
} from '../lib/tracerMath';
import {
  computeShotCarry,
  fitDetectedTrack,
  buildArcSpecV2,
  type TrackPoint,
  type ShotFix,
} from '../lib/tracerV2';
import { config } from '../constants/config';

// ─── Inverse haversine: destination point given start, bearing, distance ───
const R = 6371000;
const DEG = Math.PI / 180;
function destination(
  lat: number,
  lon: number,
  bearingDeg: number,
  distM: number
): { lat: number; lon: number } {
  const δ = distM / R;
  const θ = bearingDeg * DEG;
  const φ1 = lat * DEG;
  const λ1 = lon * DEG;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
  return { lat: φ2 / DEG, lon: λ2 / DEG };
}

// ─── Scenario table ───
// Tee: a Brisbane park (same latitude band as Henry's street test).
const TEE = { lat: -27.44463, lon: 153.01504 };

interface Scenario {
  name: string;
  carryM: number;
  shotBearingDeg: number; // true bearing the ball travels
  cameraHeadingDeg: number; // camera optical-axis azimuth
  pitchDownDeg: number | null;
  gpsAccM: number;
  clipDurationSec: number;
  impactTimeMs: number;
  expect: {
    skip?: string; // expected skip reason (gates that SHOULD fire)
    xLandSide?: 'left' | 'center' | 'right'; // relative to frame center 0.5
  };
}

const scenarios: Scenario[] = [
  {
    name: 'straight 100m (camera dead on)',
    carryM: 100,
    shotBearingDeg: 270,
    cameraHeadingDeg: 270,
    pitchDownDeg: 5,
    gpsAccM: 6,
    clipDurationSec: 10,
    impactTimeMs: 3000,
    expect: { xLandSide: 'center' },
  },
  {
    name: '100m, 25° RIGHT of camera',
    carryM: 100,
    shotBearingDeg: 295,
    cameraHeadingDeg: 270,
    pitchDownDeg: 5,
    gpsAccM: 6,
    clipDurationSec: 10,
    impactTimeMs: 3000,
    expect: { xLandSide: 'right' },
  },
  {
    name: '100m, 25° LEFT of camera',
    carryM: 100,
    shotBearingDeg: 245,
    cameraHeadingDeg: 270,
    pitchDownDeg: 5,
    gpsAccM: 6,
    clipDurationSec: 10,
    impactTimeMs: 3000,
    expect: { xLandSide: 'left' },
  },
  {
    name: 'driver 230m straight',
    carryM: 230,
    shotBearingDeg: 10,
    cameraHeadingDeg: 10,
    pitchDownDeg: 3,
    gpsAccM: 5,
    clipDurationSec: 12,
    impactTimeMs: 4000,
    expect: { xLandSide: 'center' },
  },
  {
    name: 'wedge 60m slight right',
    carryM: 60,
    shotBearingDeg: 100,
    cameraHeadingDeg: 90,
    pitchDownDeg: 8,
    gpsAccM: 5,
    clipDurationSec: 8,
    impactTimeMs: 2500,
    expect: { xLandSide: 'right' },
  },
  {
    name: "Henry's street test: 80m walk, heading 274°",
    carryM: 80,
    shotBearingDeg: 280,
    cameraHeadingDeg: 274.7,
    pitchDownDeg: 7.08,
    gpsAccM: 6.8,
    clipDurationSec: 9,
    impactTimeMs: 2467,
    expect: { xLandSide: 'right' },
  },
  {
    name: 'GPS teleport 400m (cart ride) → must skip',
    carryM: 400,
    shotBearingDeg: 0,
    cameraHeadingDeg: 0,
    pitchDownDeg: 5,
    gpsAccM: 6,
    clipDurationSec: 10,
    impactTimeMs: 3000,
    expect: { skip: 'carry-max' },
  },
  {
    name: 'impact at clip end → must skip (anim-too-short)',
    carryM: 100,
    shotBearingDeg: 270,
    cameraHeadingDeg: 270,
    pitchDownDeg: 5,
    gpsAccM: 6,
    clipDurationSec: 5,
    impactTimeMs: 4800,
    expect: { skip: 'anim-too-short' },
  },
];

// ─── Assertions ───
let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(scenario: string, label: string, ok: boolean, detail: string) {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${scenario} :: ${label} — ${detail}`);
  }
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `  (${detail})`}`);
}

console.log(
  `\n=== TRACER GEOMETRY SIMULATION (debugForceTrace=${config.tracer.debugForceTrace}) ===\n`
);

for (const s of scenarios) {
  const landing = destination(TEE.lat, TEE.lon, s.shotBearingDeg, s.carryM);
  const input: TracerGeometryInput = {
    latN: TEE.lat,
    lonN: TEE.lon,
    latN1: landing.lat,
    lonN1: landing.lon,
    gpsAccuracyMN: s.gpsAccM,
    gpsAccuracyMN1: s.gpsAccM,
    cameraHeadingDeg: s.cameraHeadingDeg,
    cameraHeadingCalibration: 3,
    cameraPitchDownDeg: s.pitchDownDeg,
    hFovLandscapeDeg: 62,
    clipDurationSec: s.clipDurationSec,
    impactTimeMs: s.impactTimeMs,
    autoTrimStartMs: 0,
  };

  console.log(`\n── ${s.name} ──`);
  const carryRecovered = haversineMeters(
    input.latN,
    input.lonN,
    input.latN1,
    input.lonN1
  );
  const bearingRecovered = initialBearingDeg(
    input.latN,
    input.lonN,
    input.latN1,
    input.lonN1
  );
  console.log(
    `  planted: carry=${s.carryM}m bearing=${s.shotBearingDeg}° | recovered: carry=${carryRecovered.toFixed(2)}m bearing=${bearingRecovered.toFixed(2)}°`
  );

  check(
    s.name,
    'GPS distance round-trips',
    Math.abs(carryRecovered - s.carryM) < 0.5,
    `recovered ${carryRecovered.toFixed(2)}m, planted ${s.carryM}m`
  );
  check(
    s.name,
    'GPS bearing round-trips',
    Math.abs(bearingRecovered - s.shotBearingDeg) < 0.3 ||
      Math.abs(Math.abs(bearingRecovered - s.shotBearingDeg) - 360) < 0.3,
    `recovered ${bearingRecovered.toFixed(2)}°, planted ${s.shotBearingDeg}°`
  );

  // No vision detection in the simulation — heading-only lateral placement,
  // exactly what a no-ball street test produces.
  const arc = buildArcSpec({ ...input, detection: null });

  if (s.expect.skip) {
    check(
      s.name,
      `gate fires (${s.expect.skip})`,
      isTracerSkip(arc) && arc.skip === s.expect.skip,
      isTracerSkip(arc) ? `got skip=${arc.skip}` : 'rendered instead of skipping'
    );
    continue;
  }

  if (isTracerSkip(arc)) {
    check(s.name, 'arc renders', false, `unexpected skip=${arc.skip}`);
    continue;
  }

  const { spec, meta } = arc;
  console.log(
    `  spec: p0=(${spec.p0.x.toFixed(3)},${spec.p0.y.toFixed(3)}) apex=(${spec.a.x.toFixed(3)},${spec.a.y.toFixed(3)}) land=(${spec.p3.x.toFixed(3)},${spec.p3.y.toFixed(3)})`
  );
  console.log(
    `  meta: deltaDeg=${meta.deltaDeg} bucket=${meta.bucket} apexM=${meta.apexM} hangS=${meta.hangS} anim=${spec.animStartSec.toFixed(2)}s+${spec.animDurationSec.toFixed(2)}s`
  );

  // Direction: xLand side vs frame center (y-up normalized coords; x: 0=left
  // edge, 1=right edge as rendered).
  const side =
    spec.p3.x > 0.55 ? 'right' : spec.p3.x < 0.45 ? 'left' : 'center';
  check(
    s.name,
    `lands ${s.expect.xLandSide} (xLand=${spec.p3.x.toFixed(3)})`,
    side === s.expect.xLandSide,
    `landed ${side}`
  );

  // Shape sanity: apex strictly above both endpoints (y-up), points finite.
  check(
    s.name,
    'apex above launch & landing',
    spec.a.y > spec.p0.y && spec.a.y > spec.p3.y,
    `apexY=${spec.a.y.toFixed(3)} p0Y=${spec.p0.y.toFixed(3)} p3Y=${spec.p3.y.toFixed(3)}`
  );
  check(
    s.name,
    'all points finite & in-frame-ish',
    [spec.p0, spec.c1, spec.a, spec.c2, spec.p3].every(
      (p) =>
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        p.x >= -0.31 &&
        p.x <= 1.31 &&
        p.y >= -0.1 &&
        p.y <= 1.1
    ),
    JSON.stringify(spec)
  );
  // Smoothness/monotonicity proxy: control points ordered along x between
  // p0 and p3 (no fold-backs that would kink the stroke).
  const xs = [spec.p0.x, spec.c1.x, spec.a.x, spec.c2.x, spec.p3.x];
  const dir = Math.sign(spec.p3.x - spec.p0.x) || 1;
  const monotone = xs.every(
    (x, i) => i === 0 || (x - xs[i - 1]) * dir >= -0.02
  );
  check(s.name, 'control points monotone (no kinks)', monotone, xs.map((x) => x.toFixed(3)).join(' → '));

  // Timing fits the clip with the export-safety margin.
  check(
    s.name,
    'animation fits inside clip',
    spec.animStartSec > 0 &&
      spec.animStartSec + spec.animDurationSec <= s.clipDurationSec - 0.29,
    `start=${spec.animStartSec}s dur=${spec.animDurationSec}s clip=${s.clipDurationSec}s`
  );

  // Larger carry → higher apex prior (depth perception via flight shape).
  check(
    s.name,
    'apex prior sane for carry',
    (meta.apexM ?? 0) > 3 && (meta.apexM ?? 0) < 60,
    `apexM=${meta.apexM}`
  );
}

// ════════════════════════════════════════════════════════════════════════
// TRACER V2 — two-segment handoff scenarios (S6/S7) + A8 camera-angle
// ════════════════════════════════════════════════════════════════════════

const VFOV2 = 62;
const HFOV2 = 62;
const CAMH2 = config.tracer.v2.bagMountHeightM;

function makeTrackSim(
  p0: { x: number; y: number },
  vx: number,
  vy: number,
  thSec: number,
  n = 10,
): TrackPoint[] {
  const pts: TrackPoint[] = [];
  const gScreen = 0.3;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * thSec;
    pts.push({ x: p0.x + vx * t, y: p0.y + vy * t - 0.5 * gScreen * t * t, tMs: t * 1000 });
  }
  return pts;
}
function landSim(deltaDeg: number, carryM: number, horizonY: number) {
  return projectLanding({
    deltaDeg,
    carryM,
    horizonY,
    hFovPortraitDeg: portraitHFovDeg(HFOV2),
    vFovPortraitDeg: VFOV2,
    tripodHeightM: CAMH2,
  });
}
function assertArcSaneSim(name: string, spec: ReturnType<typeof buildArcSpecV2>) {
  const finite = spec.samples.every(
    (s) => Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.tSec),
  );
  check(name, 'v2 samples finite & NaN-free', finite, 'non-finite sample');
  let inc = spec.samples[0].tSec === 0;
  for (let i = 1; i < spec.samples.length; i++) if (spec.samples[i].tSec <= spec.samples[i - 1].tSec) inc = false;
  check(name, 'v2 tSec strictly increasing from 0', inc, 'tSec not increasing');
  const last = spec.samples[spec.samples.length - 1];
  check(
    name,
    'v2 exact endpoint (last == meta.endpoint)',
    Math.abs(last.x - spec.meta.endpoint.x) < 1e-6 && Math.abs(last.y - spec.meta.endpoint.y) < 1e-6,
    'endpoint mismatch',
  );
}

console.log('\n\n=== TRACER V2 HANDOFF SCENARIOS ===\n');

// The 6 handoff scenarios: R0 full arc, R2 synthetic, wedge, fade, parallax
// straight (drift disagrees w/ GPS, low curvature), and last-shot prior-only.
const TEE2 = { lat: -27.44463, lon: 153.01504 };
const handoffScenarios = [
  { name: 'R0 iron 150m, clean detection (Tier1)', carryM: 150, deltaDeg: -12, vx: -0.05, vy: 0.45, th: 0.4, effAcc: 4, tier: 1 },
  { name: 'R2 driver 230m, weak detection', carryM: 230, deltaDeg: 8, vx: 0.03, vy: 0.35, th: 0.25, effAcc: 8, tier: 2 },
  { name: 'wedge 60m, steep launch', carryM: 60, deltaDeg: 5, vx: 0.02, vy: 0.7, th: 0.45, effAcc: 4, tier: 1 },
  { name: 'fade: right drift agrees with GPS right', carryM: 170, deltaDeg: 22, vx: 0.08, vy: 0.4, th: 0.4, effAcc: 4, tier: 1 },
  { name: 'parallax straight: drift right, GPS left, low curvature', carryM: 150, deltaDeg: -20, vx: 0.12, vy: 0.4, th: 0.5, effAcc: 5, tier: 1 },
  { name: 'straight bow: |delta| < 8', carryM: 140, deltaDeg: 3, vx: 0.01, vy: 0.45, th: 0.4, effAcc: 4, tier: 1 },
];

for (const s of handoffScenarios) {
  console.log(`\n── ${s.name} ──`);
  const horizonY = computeHorizonY(5, VFOV2);
  const landing = destination(TEE2.lat, TEE2.lon, 270 + s.deltaDeg, s.carryM);
  const fixA: ShotFix = { lat: TEE2.lat, lon: TEE2.lon, effAccM: s.effAcc };
  const fixB: ShotFix = { lat: landing.lat, lon: landing.lon, effAccM: s.effAcc };
  const carry = computeShotCarry(fixA, fixB, 270, { headingCalibration: 3 });
  const fit = fitDetectedTrack(makeTrackSim({ x: 0.5, y: 0.15 }, s.vx, s.vy, s.th));
  const spec = buildArcSpecV2({
    fit,
    carry,
    landing: landSim(carry.deltaDeg ?? 0, carry.carryM, horizonY),
    horizonY,
    vFovPortraitDeg: VFOV2,
    camHeightM: CAMH2,
    animStartSec: 0.1,
    maxAnimSec: 6.5,
  });
  console.log(`  carry=${carry.carryM.toFixed(1)}m tier=${carry.tier} label=${carry.labelText} apexM=${spec.meta.apexM} degenerate=${spec.meta.degenerate}`);
  assertArcSaneSim(s.name, spec);
  // vertical single-peak monotonicity
  const ys = spec.samples.map((p) => p.y);
  let pk = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[pk]) pk = i;
  let mono = true;
  for (let i = 1; i <= pk; i++) if (ys[i] - ys[i - 1] < -1e-6) mono = false;
  for (let i = pk + 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > 1e-6) mono = false;
  check(s.name, 'v2 vertical rises then falls (single apex)', mono, 'multi-peak');
  // lateral monotone (no reversal)
  const xs = spec.samples.map((p) => p.x);
  const dir = Math.sign(xs[xs.length - 1] - xs[0]) || 1;
  const latMono = xs.every((x, i) => i === 0 || (x - xs[i - 1]) * dir >= -1e-4);
  check(s.name, 'v2 no lateral sign reversal', latMono, xs.map((x) => x.toFixed(2)).join(' '));
  // C1 continuity on the POLYLINE seam (nearest sample to meta.handoff): the
  // segment-1 exit velocity == segment-2 entry velocity. Raw IN vs effective
  // OUT in meta may legitimately differ when straightening is active (parallax),
  // so check the actual polyline, not the meta witnesses.
  let hk = 0, hbest = Infinity;
  for (let i = 0; i < spec.samples.length; i++) {
    const d = Math.hypot(spec.samples[i].x - spec.meta.handoff.x, spec.samples[i].y - spec.meta.handoff.y);
    if (d < hbest) { hbest = d; hk = i; }
  }
  let c1 = true;
  if (hk > 0 && hk < spec.samples.length - 1) {
    const fdv = (a: typeof spec.samples[0], b: typeof spec.samples[0]) => ({ x: (b.x - a.x) / ((b.tSec - a.tSec) || 1e-9), y: (b.y - a.y) / ((b.tSec - a.tSec) || 1e-9) });
    const vb = fdv(spec.samples[hk - 1], spec.samples[hk]);
    const va = fdv(spec.samples[hk], spec.samples[hk + 1]);
    const bSpd = Math.hypot(vb.x, vb.y), aSpd = Math.hypot(va.x, va.y);
    c1 = Math.max(aSpd, bSpd) / Math.max(Math.min(aSpd, bSpd), 1e-9) < 1.5;
  }
  check(s.name, 'v2 C1 continuity at handoff (polyline)', c1, 'seam velocity jump');
  // apex within bucket bound (I11a)
  const p = TRACER_PRIORS[bucketForCarry(carry.carryM)];
  check(s.name, 'v2 apex ≤ 1.5× bucketHi (I11a)', spec.meta.apexM <= p.apexHiM * 1.5 + 1e-9, `apexM=${spec.meta.apexM}`);
}

console.log('\n\n=== TRACER V2 A8 (roll × pitch × deltaDeg) ===\n');
const rolls2 = [-8, 8, 15];
const pitches2 = [-10, 0, 10];
const deltas2 = [0, 30, 60];
for (const rollDeg of rolls2)
  for (const pitchDownDeg of pitches2)
    for (const deltaDeg of deltas2) {
      const tag = `A8 roll${rollDeg} pitch${pitchDownDeg} d${deltaDeg}`;
      const horizonY = computeHorizonY(pitchDownDeg, VFOV2);
      const fit = fitDetectedTrack(makeTrackSim({ x: 0.5, y: 0.15 }, 0.05, 0.4, 0.4));
      const carryA8 = computeShotCarry(
        { lat: TEE2.lat, lon: TEE2.lon, effAccM: 4 },
        { ...destination(TEE2.lat, TEE2.lon, 270 + deltaDeg, 150), effAccM: 4 },
        270,
        { headingCalibration: 3 },
      );
      const base = {
        fit,
        // Pin the delta to the exact test value (the recovered delta can round
        // a hair over the 60° boundary and mis-trip the off-axis clamp).
        carry: { ...carryA8, deltaDeg },
        landing: landSim(deltaDeg, 150, horizonY),
        horizonY,
        vFovPortraitDeg: VFOV2,
        camHeightM: CAMH2,
        animStartSec: 0.1,
        maxAnimSec: 6.5,
      };
      const spec0 = buildArcSpecV2({ ...base, rollDeg: 0 });
      const specR = buildArcSpecV2({ ...base, rollDeg });
      // endpoint rotates with the frame (aspect-space rotation about center)
      const r = (rollDeg * Math.PI) / 180;
      const cA = Math.cos(r), sA = Math.sin(r), asp = 9 / 16;
      const dx = spec0.meta.endpoint.x - 0.5, dy = spec0.meta.endpoint.y - 0.5;
      const ex = 0.5 + dx * cA - (dy * sA) / asp;
      const ey = 0.5 + dx * sA * asp + dy * cA;
      check(tag, 'A8 endpoint rotates with frame', Math.abs(specR.meta.endpoint.x - ex) < 1e-9 && Math.abs(specR.meta.endpoint.y - ey) < 1e-9, 'endpoint not rotated');
      // C1 preserved under rotation: both handoff velocity witnesses (raw IN,
      // effective OUT) rotate consistently (vector rotation about origin).
      const rvx = (v: { x: number; y: number }) => ({ x: v.x * cA - (v.y * sA) / asp, y: v.x * sA * asp + v.y * cA });
      const rIn = rvx(spec0.meta.vHandoffIn), rOut = rvx(spec0.meta.vHandoffOut);
      check(tag, 'A8 vHandoffIn rotates', Math.abs(specR.meta.vHandoffIn.x - rIn.x) < 1e-9 && Math.abs(specR.meta.vHandoffIn.y - rIn.y) < 1e-9, 'vIn not rotated');
      check(tag, 'A8 vHandoffOut rotates', Math.abs(specR.meta.vHandoffOut.x - rOut.x) < 1e-9 && Math.abs(specR.meta.vHandoffOut.y - rOut.y) < 1e-9, 'vOut not rotated');
      check(tag, 'A8 horizon-relative apex (apexM) unchanged', specR.meta.apexM === spec0.meta.apexM, 'apexM changed');
      check(tag, 'A8 not degraded (roll≤15, |delta|≤60)', specR.meta.offAxis === false, 'unexpected degrade');
    }
// degrade clamps fire
{
  const horizonY = computeHorizonY(0, VFOV2);
  const fit = fitDetectedTrack(makeTrackSim({ x: 0.5, y: 0.15 }, 0.05, 0.4, 0.4));
  const carry = computeShotCarry({ lat: TEE2.lat, lon: TEE2.lon, effAccM: 4 }, { ...destination(TEE2.lat, TEE2.lon, 280, 150), effAccM: 4 }, 270, { headingCalibration: 3 });
  const rollBad = buildArcSpecV2({ fit, carry: { ...carry, deltaDeg: 10 }, landing: landSim(10, 150, horizonY), horizonY, vFovPortraitDeg: VFOV2, camHeightM: CAMH2, animStartSec: 0.1, maxAnimSec: 6, rollDeg: 20 });
  check('A8 degrade', 'roll>15 → offAxis + rollExceeded + no label', rollBad.meta.offAxis && rollBad.meta.rollExceeded && rollBad.labelText === null, JSON.stringify(rollBad.meta));
  const sideOn = buildArcSpecV2({ fit, carry: { ...carry, deltaDeg: 70 }, landing: landSim(70, 150, horizonY), horizonY, vFovPortraitDeg: VFOV2, camHeightM: CAMH2, animStartSec: 0.1, maxAnimSec: 6, rollDeg: 0 });
  check('A8 degrade', '|delta|>60 → offAxis + no label', sideOn.meta.offAxis && sideOn.labelText === null, JSON.stringify(sideOn.meta));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
