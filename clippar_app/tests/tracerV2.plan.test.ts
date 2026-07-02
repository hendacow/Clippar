import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideTracerPlan,
  type TracerPlanRow,
  type TracerVisionSignal,
} from '../lib/tracerV2';
import { config } from '../constants/config';

// S10 — decideTracerPlan: rung ladder + hard veto matrix. Fixture rows are
// plain objects (no SQLite) so every combination is a one-liner.

const DEG = Math.PI / 180;
const R = 6371000;
function destination(lat: number, lon: number, bearingDeg: number, distM: number) {
  const d = distM / R;
  const th = bearingDeg * DEG;
  const p1 = lat * DEG;
  const l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lon: l2 / DEG };
}

const TEE = { lat: -27.44463, lon: 153.01504 };

function baseRow(overrides: Partial<TracerPlanRow> = {}): TracerPlanRow {
  return {
    shot_type: 'swing',
    impact_time_ms: 1000,
    auto_trim_start_ms: 0,
    duration_seconds: 8,
    gps_latitude: TEE.lat,
    gps_longitude: TEE.lon,
    gps_eff_acc_m: 3,
    gps_accuracy_m: 3,
    camera_heading_deg: 270,
    camera_heading_calibration: 3,
    ...overrides,
  };
}

/** A same-hole successor at carryM/bearingDeg from TEE with the given effAcc. */
function successorRow(carryM: number, effAcc: number, bearingDeg = 270): TracerPlanRow {
  const p = destination(TEE.lat, TEE.lon, bearingDeg, carryM);
  return baseRow({ gps_latitude: p.lat, gps_longitude: p.lon, gps_eff_acc_m: effAcc, gps_accuracy_m: effAcc });
}

const NO_GPS: TracerPlanRow = baseRow({ gps_latitude: null, gps_longitude: null, gps_eff_acc_m: null, gps_accuracy_m: null });

const VISION_FULL: TracerVisionSignal = {
  found: true,
  method: 'vision',
  groundedEvidence: false,
  poseAnchor: { x: 0.5, y: 0.3 },
  pointCount: 12,
};
const VISION_POSE_ONLY: TracerVisionSignal = {
  found: false,
  method: 'none',
  groundedEvidence: false,
  poseAnchor: { x: 0.5, y: 0.2 },
  pointCount: 0,
};
const VISION_NONE: TracerVisionSignal = {
  found: false,
  method: 'none',
  groundedEvidence: false,
  poseAnchor: null,
  pointCount: 0,
};
const VISION_GROUNDED_VETO: TracerVisionSignal = {
  found: false,
  method: 'none',
  groundedEvidence: true,
  poseAnchor: null,
  pointCount: 2,
};
const VISION_GROUNDED_DECOY_PLUS_FOUND: TracerVisionSignal = {
  found: true,
  method: 'vision',
  groundedEvidence: true,
  poseAnchor: null,
  pointCount: 9,
};

// ── Hard vetoes ──

test('veto: putt → skipReason putt, never faked', () => {
  const row = baseRow({ shot_type: 'putt' });
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_FULL });
  assert.equal(r.skipReason, 'putt');
});

test('putt bypassed under debugForceTrace/gpsOnlyTrace → not vetoed', () => {
  const row = baseRow({ shot_type: 'putt' });
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_FULL, bypassEvidence: true });
  assert.equal(r.skipReason, undefined);
  assert.equal(r.rung, 'R0');
});

test('veto: no-impact → skipReason no-impact', () => {
  const row = baseRow({ impact_time_ms: null });
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_FULL });
  assert.equal(r.skipReason, 'no-impact');
});

test('veto: anim-too-short (impact right at clip end) → skipReason anim-too-short', () => {
  const row = baseRow({ impact_time_ms: 7900, duration_seconds: 8 });
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_FULL });
  assert.equal(r.skipReason, 'anim-too-short');
});

test('anim-too-short is decidable pre-vision (sensors.vision undefined)', () => {
  const row = baseRow({ impact_time_ms: 7900, duration_seconds: 8 });
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: undefined });
  assert.equal(r.skipReason, 'anim-too-short');
});

test('putt/no-impact decidable pre-vision so the batch can skip the Vision pass', () => {
  const puttRow = baseRow({ shot_type: 'putt' });
  const r1 = decideTracerPlan(puttRow, successorRow(150, 3), { vision: undefined });
  assert.equal(r1.skipReason, 'putt');

  const noImpactRow = baseRow({ impact_time_ms: null });
  const r2 = decideTracerPlan(noImpactRow, successorRow(150, 3), { vision: undefined });
  assert.equal(r2.skipReason, 'no-impact');
});

test('a well-formed clip has no skipReason pre-vision (proceeds to detection)', () => {
  const row = baseRow();
  const r = decideTracerPlan(row, successorRow(150, 3), { vision: undefined });
  assert.equal(r.skipReason, undefined);
});

test('veto: grounded ONLY when groundedEvidence AND found:false', () => {
  const row = baseRow();
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_GROUNDED_VETO });
  assert.equal(r.skipReason, 'grounded');
});

test('grounded decoy + found:true (real ball found separately) → renders, not vetoed', () => {
  const row = baseRow();
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_GROUNDED_DECOY_PLUS_FOUND });
  assert.equal(r.skipReason, undefined);
  assert.equal(r.rung, 'R0');
});

test('grounded veto bypassed under debugForceTrace/gpsOnlyTrace', () => {
  const row = baseRow();
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_GROUNDED_VETO, bypassEvidence: true });
  assert.equal(r.skipReason, undefined);
});

test('veto: no-anchor when nothing usable and allowPriorOnlyArc is off', () => {
  const prev = config.tracer.v2.allowPriorOnlyArc;
  (config.tracer.v2 as { allowPriorOnlyArc: boolean }).allowPriorOnlyArc = false;
  try {
    const r = decideTracerPlan(NO_GPS, null, { vision: VISION_NONE });
    assert.equal(r.skipReason, 'no-anchor');
  } finally {
    (config.tracer.v2 as { allowPriorOnlyArc: boolean }).allowPriorOnlyArc = prev;
  }
});

// ── Rung ladder ──

test('R0: GPS Tier1 + real vision fit', () => {
  const row = baseRow();
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_FULL });
  assert.equal(r.rung, 'R0');
  assert.equal(r.gpsTier, 1);
  assert.equal(r.carrySource, 'gps');
  assert.equal(r.skipReason, undefined);
});

test('R1: GPS Tier2 + real vision fit', () => {
  const row = baseRow();
  const next = successorRow(150, 8); // effAcc 8 → Tier2
  const r = decideTracerPlan(row, next, { vision: VISION_FULL });
  assert.equal(r.rung, 'R1');
  assert.equal(r.gpsTier, 2);
  assert.equal(r.carrySource, 'gps');
});

test('R2: GPS Tier1 + weak vision (pose-anchor only) — GPS drives it', () => {
  const row = baseRow();
  const next = successorRow(150, 3);
  const r = decideTracerPlan(row, next, { vision: VISION_POSE_ONLY });
  assert.equal(r.rung, 'R2');
  assert.equal(r.gpsTier, 1);
  assert.equal(r.carrySource, 'gps');
});

test('R2: GPS Tier2 + zero vision evidence — GPS still drives it (gpsOnlyTrace shape)', () => {
  const row = baseRow();
  const next = successorRow(150, 8);
  const r = decideTracerPlan(row, next, { vision: VISION_NONE });
  assert.equal(r.rung, 'R2');
  assert.equal(r.gpsTier, 2);
});

test('R3: vision valid + GPS unusable (Tier3 accuracy)', () => {
  const row = baseRow();
  const next = successorRow(150, 15); // effAcc 15 → Tier3
  const r = decideTracerPlan(row, next, { vision: VISION_FULL });
  assert.equal(r.rung, 'R3');
  assert.equal(r.gpsTier, 3);
  assert.equal(r.carrySource, 'prior');
});

test('R3: last shot of hole (no successor) → GPS unusable by construction', () => {
  const row = baseRow();
  const r = decideTracerPlan(row, null, { vision: VISION_FULL });
  assert.equal(r.rung, 'R3');
  assert.equal(r.gpsTier, null);
  assert.equal(r.carry, null);
});

test('stale GPS (missing fix entirely) → R3 with real vision', () => {
  const r = decideTracerPlan(NO_GPS, successorRow(150, 3), { vision: VISION_FULL });
  assert.equal(r.rung, 'R3');
  assert.equal(r.gpsTier, null);
});

test('stale GPS + nothing visual + allowPriorOnlyArc (dev default) → R4', () => {
  assert.equal(config.tracer.v2.allowPriorOnlyArc, true, 'dev default should be true for this test');
  const r = decideTracerPlan(NO_GPS, null, { vision: VISION_NONE });
  assert.equal(r.rung, 'R4');
  assert.equal(r.gpsTier, null);
});

test('R3 carrySource is "user" when a dev-settings default carry is set', () => {
  const row = baseRow();
  const next = successorRow(150, 15); // Tier3 → GPS unusable
  const r = decideTracerPlan(row, next, { vision: VISION_FULL, userDefaultCarryM: 165 });
  assert.equal(r.rung, 'R3');
  assert.equal(r.carrySource, 'user');
});

// ── A3 brokenChain → tier demotion propagates into the rung decision ──

test('brokenChain forces Tier3 → demotes what would be R0 down to R3', () => {
  const row = baseRow();
  const next = successorRow(150, 3); // would be Tier1 otherwise
  const r = decideTracerPlan(row, next, { vision: VISION_FULL, brokenChain: true });
  assert.equal(r.gpsTier, 3);
  assert.equal(r.rung, 'R3');
  assert.equal(r.carry?.tierReason, 'broken-chain');
});

// ── Full rung × veto sweep: every combination is either a hard veto or one
//    of R0-R4, never anything else. ──

test('property sweep: rung is always one of R0-R4 (or a hard veto) across the matrix', () => {
  const tiers: Array<[number, TracerPlanRow | null]> = [
    [1, successorRow(150, 3)],
    [2, successorRow(150, 8)],
    [3, successorRow(150, 15)],
    [0, null], // last-shot-of-hole
  ];
  const visions = [VISION_FULL, VISION_POSE_ONLY, VISION_NONE];
  for (const [, next] of tiers) {
    for (const vision of visions) {
      const r = decideTracerPlan(baseRow(), next, { vision });
      if (r.skipReason) {
        assert.ok(['putt', 'no-impact', 'grounded', 'anim-too-short', 'no-anchor'].includes(r.skipReason));
      } else {
        assert.ok(['R0', 'R1', 'R2', 'R3', 'R4'].includes(r.rung));
      }
    }
  }
});
