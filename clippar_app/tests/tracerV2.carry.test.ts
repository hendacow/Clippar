import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeShotCarry, type ShotFix, type CarryCalib } from '../lib/tracerV2';

// S6 — computeShotCarry: carry/bearing/σ_d/tier/label + A3 chain-break defenses.
// Tier rules (plan §Pillar 1): Tier1 both effAcc ≤5 AND pure GPS σ ≤5 AND
// 20≤carry≤350; Tier2 both effAcc ≤10 AND σ_d/carry ≤10%; else Tier3. σ_d is
// the A2-folded honest error √((a²+b²)/2 + filmSpotOffsetVarM²).

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
function fixes(carryM: number, effA: number, effB = effA, bearingDeg = 270) {
  const b = destination(TEE.lat, TEE.lon, bearingDeg, carryM);
  const fixA: ShotFix = { lat: TEE.lat, lon: TEE.lon, effAccM: effA };
  const fixB: ShotFix = { lat: b.lat, lon: b.lon, effAccM: effB };
  return { fixA, fixB };
}
const CAL: CarryCalib = { headingCalibration: 3 };

// ── Tier boundaries ──

test('Tier1: effAcc 4.9m both, 150m carry → Tier1 exact label', () => {
  const { fixA, fixB } = fixes(150, 4.9);
  const r = computeShotCarry(fixA, fixB, 270, CAL);
  assert.equal(r.tier, 1);
  assert.equal(r.labelText, `${Math.round(r.carryM)}m`);
  assert.equal(r.labelText!.startsWith('~'), false);
});

test('Tier boundary: effAcc 5.1m both → drops out of Tier1 (→ Tier2 ~label)', () => {
  const { fixA, fixB } = fixes(150, 5.1);
  const r = computeShotCarry(fixA, fixB, 270, CAL);
  assert.equal(r.tier, 2);
  assert.equal(r.labelText, `~${Math.round(r.carryM)}m`);
});

test('Tier2: effAcc 9.9m both → Tier2', () => {
  const { fixA, fixB } = fixes(150, 9.9);
  const r = computeShotCarry(fixA, fixB, 270, CAL);
  assert.equal(r.tier, 2);
});

test('Tier3: effAcc 10.1m both → Tier3 (no label)', () => {
  const { fixA, fixB } = fixes(150, 10.1);
  const r = computeShotCarry(fixA, fixB, 270, CAL);
  assert.equal(r.tier, 3);
  assert.equal(r.labelText, null);
});

test('σ_d folds in the A2 bag offset: effAcc 5/5 → σ_d = √(25+9) ≈ 5.83', () => {
  const { fixA, fixB } = fixes(150, 5.0);
  const r = computeShotCarry(fixA, fixB, 270, CAL);
  assert.ok(Math.abs(r.sigmaD - Math.sqrt(25 + 9)) < 0.05, `σ_d=${r.sigmaD}`);
  // pure GPS σ (=5) ≤ 5 and effAcc ≤ 5 → still Tier1 at the boundary.
  assert.equal(r.tier, 1);
});

test('relative-σ gate: short 25m carry with 8m effAcc → σ_d/carry > 10% → Tier3', () => {
  const { fixA, fixB } = fixes(25, 8);
  const r = computeShotCarry(fixA, fixB, 270, CAL);
  assert.equal(r.tier, 3); // rel σ ≈ 8.5/25 ≈ 0.34
});

test('carry 19m (< 20m Tier1 floor) → not Tier1', () => {
  const { fixA, fixB } = fixes(19, 3);
  const r = computeShotCarry(fixA, fixB, 270, CAL);
  assert.notEqual(r.tier, 1);
});

test('carry 351m (> 350m Tier1 ceiling) → Tier2, reason carry-out-of-range', () => {
  const { fixA, fixB } = fixes(351, 3);
  const r = computeShotCarry(fixA, fixB, 270, CAL);
  assert.equal(r.tier, 2);
  assert.equal(r.tierReason, 'carry-out-of-range');
});

// ── v1 worked-example parity (from tracerMath self-check) ──
// N (37,-122) → N+1 (37.001327,-122.000293), heading 5.0° → carry 149.8m,
// bearing 350.0°, delta -15.0°.

test('v1 worked-example parity: carry 149.8m, bearing 350.0°, delta -15.0°', () => {
  const fixA: ShotFix = { lat: 37, lon: -122, effAccM: 4 };
  const fixB: ShotFix = { lat: 37.001327, lon: -122.000293, effAccM: 4 };
  const r = computeShotCarry(fixA, fixB, 5.0, CAL);
  assert.ok(Math.abs(r.carryM - 149.8) < 0.5, `carry=${r.carryM}`);
  assert.ok(Math.abs(r.bearingDeg - 350.0) < 0.3, `bearing=${r.bearingDeg}`);
  assert.ok(Math.abs((r.deltaDeg ?? NaN) - -15.0) < 0.3, `delta=${r.deltaDeg}`);
});

// ── Heading usability ──

test('deltaDeg is null when compass calibration < 1 (never silently 0)', () => {
  const { fixA, fixB } = fixes(150, 4);
  const r = computeShotCarry(fixA, fixB, 270, { headingCalibration: 0 });
  assert.equal(r.deltaDeg, null);
  // carry/tier are unaffected by heading.
  assert.equal(r.tier, 1);
});

test('deltaDeg is null when heading itself is null', () => {
  const { fixA, fixB } = fixes(150, 4);
  const r = computeShotCarry(fixA, fixB, null, { headingCalibration: 3 });
  assert.equal(r.deltaDeg, null);
});

// ── A3 chain-break defenses (only ever demote) ──

test('A3 plausibility: wedge carrying 150m (> 120m) → forced Tier3', () => {
  const { fixA, fixB } = fixes(150, 3);
  const r = computeShotCarry(fixA, fixB, 270, { headingCalibration: 3, shotType: 'wedge' });
  assert.equal(r.tier, 3);
  assert.match(r.tierReason ?? '', /implausible-wedge/);
});

test('A3 plausibility: iron 150m (< 220m) stays Tier1', () => {
  const { fixA, fixB } = fixes(150, 3);
  const r = computeShotCarry(fixA, fixB, 270, { headingCalibration: 3, shotType: 'iron' });
  assert.equal(r.tier, 1);
});

test('A3 gap: > 8 min between clips caps a Tier1 shot at Tier2', () => {
  const { fixA, fixB } = fixes(150, 3);
  const r = computeShotCarry(fixA, fixB, 270, {
    headingCalibration: 3,
    interClipGapSec: 9 * 60,
  });
  assert.equal(r.tier, 2);
  assert.equal(r.tierReason, 'inter-clip-gap>8min');
});

test('A3 broken chain (penalty gesture) → forced Tier3 regardless of accuracy', () => {
  const { fixA, fixB } = fixes(150, 2);
  const r = computeShotCarry(fixA, fixB, 270, { headingCalibration: 3, brokenChain: true });
  assert.equal(r.tier, 3);
  assert.equal(r.tierReason, 'broken-chain');
  assert.equal(r.labelText, null);
});
