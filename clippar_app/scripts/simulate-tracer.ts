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
  type TracerGeometryInput,
} from '../lib/tracerMath';
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

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
