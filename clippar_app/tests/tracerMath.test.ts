import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters,
  initialBearingDeg,
  bearingDeltaDeg,
} from '../lib/tracerMath';

// Sample suite proving the lightweight tsx + node:test scaffold runs.
// These are the real GPS-tracer geometry functions — pure, deterministic,
// the kind of logic worth locking down with tests.

test('haversineMeters: identical points → 0', () => {
  assert.equal(haversineMeters(-27.5, 153.0, -27.5, 153.0), 0);
});

test('haversineMeters: 1° of latitude ≈ 111.2 km', () => {
  const m = haversineMeters(0, 0, 1, 0);
  assert.ok(Math.abs(m - 111195) < 500, `expected ~111195 m, got ${m}`);
});

test('initialBearingDeg: due north ≈ 0°, due east ≈ 90°', () => {
  const north = initialBearingDeg(0, 0, 1, 0);
  assert.ok(north < 0.01 || north > 359.99, `north: got ${north}`);
  assert.ok(Math.abs(initialBearingDeg(0, 0, 0, 1) - 90) < 0.01);
});

test('bearingDeltaDeg: signed, right-positive, wraps correctly', () => {
  assert.equal(bearingDeltaDeg(10, 0), 10);
  assert.equal(bearingDeltaDeg(350, 0), -10);
  assert.equal(bearingDeltaDeg(0, 0), 0);
  assert.equal(bearingDeltaDeg(0, 90), -90);
});
