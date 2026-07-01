import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GpsSession,
  DEFAULT_GPS_CONFIG,
  computeEffAcc,
  weightedMedian,
  type RawFix,
} from '../lib/gpsSession';

// ── helpers ─────────────────────────────────────────────────────────────────
const BASE_LAT = -37.8136; // Melbourne-ish
const BASE_LON = 144.9631;
const M_PER_DEG = 111320;
/** North offset in meters → latitude delta (lon held constant in these tests). */
const north = (m: number) => m / M_PER_DEG;
/** Distance for lon-constant (north-only) points, in meters. */
const metersNorth = (latA: number, latB: number) => Math.abs(latA - latB) * M_PER_DEG;

function fix(ts: number, latM: number, acc: number, speed: number): RawFix {
  return { ts, lat: BASE_LAT + north(latM), lon: BASE_LON, acc, speed, course: 0 };
}

// ── S2: estimator ────────────────────────────────────────────────────────────

test('clean 30 stationary fixes @3m → effAcc ≤5m and position within 1m of centroid', () => {
  const s = new GpsSession();
  const anchor = 30_000;
  // 1Hz around a fixed point, ±2m symmetric jitter (mean 0), spanning the window.
  for (let i = 0; i < 30; i++) s.addFix(fix(8_000 + i * 1000, ((i % 5) - 2), 3, 0));
  const r = s.estimateShotFix(anchor);
  assert.equal(r.reason, null);
  assert.ok(r.fix);
  assert.ok(r.fix!.effAccM <= 5, `effAcc ${r.fix!.effAccM} should be ≤5`);
  assert.ok(metersNorth(r.fix!.lat, BASE_LAT) <= 1, 'position within 1m of centroid');
});

test('40m outlier rejected by the weighted median', () => {
  const s = new GpsSession();
  const anchor = 30_000;
  for (let i = 0; i < 29; i++) s.addFix(fix(8_000 + i * 1000, ((i % 5) - 2), 3, 0));
  s.addFix(fix(29_000, 40, 18, 0)); // wild WiFi-anchored fix, weight 1/324 vs 1/9
  const r = s.estimateShotFix(anchor);
  assert.ok(r.fix);
  assert.ok(metersNorth(r.fix!.lat, BASE_LAT) < 3, 'outlier must not drag the estimate');
});

test('walking fixes excluded (speed > 0.7)', () => {
  const s = new GpsSession();
  const anchor = 30_000;
  for (let i = 0; i < 10; i++) s.addFix(fix(24_000 + i * 1000, 0, 4, 0)); // stationary @0m
  for (let i = 0; i < 12; i++) s.addFix(fix(20_000 + i * 400, 50, 5, 1.5)); // walking @50m
  const r = s.estimateShotFix(anchor);
  assert.ok(r.fix);
  assert.ok(metersNorth(r.fix!.lat, BASE_LAT) < 3, 'walking fixes must be excluded');
});

test('warm-up fixes excluded (first 15s after start)', () => {
  const s = new GpsSession();
  s.markWarmup(0);
  for (let i = 0; i < 15; i++) s.addFix(fix(i * 1000, 60, 4, 0)); // junk @60m during warm-up
  for (let i = 0; i < 16; i++) s.addFix(fix(16_000 + i * 1000, 0, 4, 0)); // real @0m
  const r = s.estimateShotFix(28_000);
  assert.ok(r.fix);
  assert.ok(metersNorth(r.fix!.lat, BASE_LAT) < 3, 'warm-up junk must be excluded');
});

test('stale → null, NEVER a cached fix', () => {
  const s = new GpsSession();
  for (let i = 0; i < 10; i++) s.addFix(fix(i * 1000, 0, 4, 0)); // fixes only near t=0
  const r = s.estimateShotFix(30_000); // anchor 30s later, >staleSec from any fix
  assert.equal(r.fix, null);
  assert.equal(r.reason, 'gps-stale');
});

test('window widening when < minFixes in the base window; source=widened', () => {
  const s = new GpsSession();
  const anchor = 50_000;
  for (let i = 0; i < 3; i++) s.addFix(fix(48_000 + i * 1000, 0, 4, 0)); // in base window + satisfies staleness
  for (let i = 0; i < 3; i++) s.addFix(fix(12_000 + i * 1000, 0, 5, 0)); // only reached after widening
  const r = s.estimateShotFix(anchor);
  assert.ok(r.fix);
  assert.ok(r.fix!.fixCount >= 5, `expected ≥5 fixes after widening, got ${r.fix!.fixCount}`);
  assert.equal(r.fix!.source, 'widened');
});

test('property sweep: computeEffAcc monotone in acc (↑) and N/span (↓)', () => {
  for (let n = 3; n <= 60; n += 7) {
    let prev = -Infinity;
    for (let acc = 3; acc <= 20; acc++) {
      const e = computeEffAcc(acc, n, n, DEFAULT_GPS_CONFIG); // 1Hz → span≈N
      assert.ok(e >= prev - 1e-9, `effAcc must not drop as acc rises (n=${n})`);
      prev = e;
    }
  }
  for (let acc = 3; acc <= 20; acc += 4) {
    let prev = Infinity;
    for (let n = 3; n <= 60; n++) {
      const e = computeEffAcc(acc, n, n, DEFAULT_GPS_CONFIG);
      assert.ok(e <= prev + 1e-9, `effAcc must not rise as N/span grows (acc=${acc})`);
      prev = e;
    }
  }
});

test('weightedMedian favours the low-accuracy-radius (high-weight) cluster', () => {
  const v = weightedMedian([
    { value: 0, acc: 3 },
    { value: 0.1, acc: 3 },
    { value: -0.1, acc: 3 },
    { value: 0.2, acc: 3 },
    { value: 40, acc: 18 },
  ]);
  assert.ok(Math.abs(v) < 1, `weighted median ${v} should stay near the tight cluster`);
});

// ── S2: health chip (currentEffAcc) ─────────────────────────────────────────
test('currentEffAcc: warm-up → locking, then green / yellow / red by effAcc, stale → locking', () => {
  // Warm-up window → locking regardless of fixes.
  const warm = new GpsSession();
  warm.markWarmup(0);
  warm.addFix(fix(2_000, 0, 3, 0));
  assert.equal(warm.currentEffAcc(5_000).state, 'locking');

  // Tight 3m fixes up to now → green.
  const green = new GpsSession();
  for (let i = 0; i < 20; i++) green.addFix(fix(1_000 + i * 1000, 0, 3, 0));
  assert.equal(green.currentEffAcc(21_000).state, 'green');

  // 8m fixes → yellow (≤10m, >5m).
  const yellow = new GpsSession();
  for (let i = 0; i < 20; i++) yellow.addFix(fix(1_000 + i * 1000, 0, 8, 0));
  assert.equal(yellow.currentEffAcc(21_000).state, 'yellow');

  // 16m fixes → red (>10m).
  const red = new GpsSession();
  for (let i = 0; i < 20; i++) red.addFix(fix(1_000 + i * 1000, 0, 16, 0));
  assert.equal(red.currentEffAcc(21_000).state, 'red');

  // Newest fix older than staleSec → locking (GPS went silent).
  const stale = new GpsSession();
  for (let i = 0; i < 10; i++) stale.addFix(fix(1_000 + i * 1000, 0, 3, 0));
  assert.equal(stale.currentEffAcc(60_000).state, 'locking');
});

// ── A1 anti-test (MUST fail a start-press implementation) ────────────────────
test('A1: impact-anchored estimate lands on the BALL, not the pre-walk BAG cluster', () => {
  const s = new GpsSession();
  // Canonical danger case: drop the bag at the cart path, walk ~29s to a
  // 120m-out drive, set up, swing. 1Hz timeline:
  //   0–9s   stationary at the BAG (0m)              speed 0
  //   10–38s walking BAG→BALL (0→120m north)         speed 1.5
  //   39–58s stationary at the BALL (120m north)     speed 0
  for (let t = 0; t <= 9; t++) s.addFix(fix(t * 1000, 0, 4, 0));
  for (let t = 10; t <= 38; t++) s.addFix(fix(t * 1000, 120 * ((t - 10) / 28), 6, 1.5));
  for (let t = 39; t <= 58; t++) s.addFix(fix(t * 1000, 120, 4, 0));

  const recordingStartTs = 7_000; // start press AT THE BAG
  const impactMs = 43_000; // impact 43s later, standing at the ball
  const impactAnchor = recordingStartTs + impactMs; // 50_000

  const impact = s.estimateAtImpact(impactAnchor);
  const startPress = s.estimateAtImpact(recordingStartTs); // start-press impl, same estimator

  assert.ok(impact.fix && startPress.fix);
  // Impact anchor → the BALL (~120m). This is exactly the assertion a
  // start-press implementation fails.
  assert.ok(
    metersNorth(impact.fix!.lat, BASE_LAT + north(120)) < 3,
    `impact-anchored fix should be at the ball (~120m), got ${metersNorth(impact.fix!.lat, BASE_LAT).toFixed(1)}m`
  );
  // Start press → the BAG (the previous filming spot — the v1 trap).
  assert.ok(
    metersNorth(startPress.fix!.lat, BASE_LAT) < 3,
    'start-press anchor demonstrably lands on the bag (the wrong cluster)'
  );
  // The two anchors resolve to clusters ~120m apart — the whole point of A1.
  assert.ok(metersNorth(impact.fix!.lat, startPress.fix!.lat) > 50);
});

test('impact vs stop anchor use their own windows (15/10 vs 25/10)', () => {
  const s = new GpsSession();
  const anchor = 60_000;
  // 6 stationary fixes at [anchor−5s .. anchor] at P0 (0m) — enough that the
  // impact window (15s pre) does NOT widen.
  for (let i = 0; i < 6; i++) s.addFix(fix(55_000 + i * 1000, 0, 4, 0));
  // 3 stationary fixes at ~anchor−20s at P1 (+30m) — inside the STOP 25s
  // pre-window but OUTSIDE the IMPACT 15s pre-window.
  for (let i = 0; i < 3; i++) s.addFix(fix(40_000 + i * 1000, 30, 4, 0));

  const impact = s.estimateAtImpact(anchor);
  const stop = s.estimateAtStop(anchor);
  assert.ok(impact.fix && stop.fix);

  // Impact window excludes the anchor−20s cluster entirely.
  assert.equal(impact.fix!.fixCount, 6);
  assert.equal(impact.fix!.source, 'impact');
  assert.ok(metersNorth(impact.fix!.lat, BASE_LAT) < 2, 'impact ignores the −20s cluster');

  // Stop window reaches back far enough to include it.
  assert.equal(stop.fix!.fixCount, 9);
  assert.equal(stop.fix!.source, 'stop-fallback');
});
