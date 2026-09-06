import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GpsSession,
  DEFAULT_GPS_CONFIG,
  carryBetween,
  computeEffAcc,
  fixSourceLabel,
  gpsSession,
  weightedMedian,
  type GpsConfig,
  type RawFix,
  type ShotFix,
} from '../lib/gpsSession';

// ── helpers ─────────────────────────────────────────────────────────────────
const BASE_LAT = -37.8136; // Melbourne-ish
const BASE_LON = 144.9631;
const DEG = Math.PI / 180;
/**
 * The sphere the implementation uses (`EARTH_RADIUS_M` in lib/tracerMath.ts).
 * v2's test file used a flat 111320 m/deg here; that is a different sphere from
 * the one under test (111194.93 m/deg), and two radii in one file is a trap —
 * every "metres" assertion below would carry a silent 0.11 % bias. All offsets
 * and all measured distances are derived from this one constant.
 */
const EARTH_RADIUS_M = 6371000;
const M_PER_DEG = EARTH_RADIUS_M * DEG;
/** North offset in metres → latitude delta (lon held constant in these tests). */
const north = (m: number) => m / M_PER_DEG;
/** East offset in metres at a given latitude → longitude delta. */
const east = (m: number, atLat: number) => m / (M_PER_DEG * Math.cos(atLat * DEG));
/** Distance for lon-constant (north-only) points, in metres. */
const metersNorth = (latA: number, latB: number) => Math.abs(latA - latB) * M_PER_DEG;

function fix(ts: number, latM: number, acc: number, speed: number): RawFix {
  return { ts, lat: BASE_LAT + north(latM), lon: BASE_LON, acc, speed, course: 0 };
}

/** A minimal ShotFix for the carry tests — only lat/lon/effAccM are read. */
function shotFix(lat: number, lon: number, effAccM: number): ShotFix {
  return {
    lat,
    lon,
    effAccM,
    fixCount: 12,
    windowSec: 20,
    medianAccM: effAccM,
    source: 'impact',
    widened: false,
    estimatorVersion: 1,
  };
}

// ── estimator ────────────────────────────────────────────────────────────────

test('clean 30 stationary fixes @3m → effAcc ≤5m and position within 1m of centroid', () => {
  const s = new GpsSession();
  const anchor = 30_000;
  // 1Hz around a fixed point, ±2m symmetric jitter (mean 0), spanning the window.
  for (let i = 0; i < 30; i++) s.addFix(fix(8_000 + i * 1000, (i % 5) - 2, 3, 0));
  const r = s.estimateShotFix(anchor);
  assert.equal(r.reason, null);
  assert.ok(r.fix);
  assert.ok(r.fix!.effAccM <= 5, `effAcc ${r.fix!.effAccM} should be ≤5`);
  assert.ok(metersNorth(r.fix!.lat, BASE_LAT) <= 1, 'position within 1m of centroid');
});

test('40m outlier rejected by the weighted median', () => {
  const s = new GpsSession();
  const anchor = 30_000;
  for (let i = 0; i < 29; i++) s.addFix(fix(8_000 + i * 1000, (i % 5) - 2, 3, 0));
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

/**
 * The v1 bug in one test. v1 answered this case with its last-known position;
 * every anchor below is far enough from the ring that the ONLY way to return a
 * fix is to coast on a cached one, which is exactly what must never happen.
 */
test('a ring that has gone silent yields gps-stale at every anchor — no cached fix, ever', () => {
  const s = new GpsSession();
  // A full, high-quality minute of fixes... that stopped 60s ago.
  for (let t = 0; t <= 60; t++) s.addFix(fix(t * 1000, 0, 3, 0));
  for (const anchor of [120_000, 180_000, 240_000]) {
    for (const r of [
      s.estimateShotFix(anchor),
      s.estimateAtImpact(anchor),
      s.estimateAtStop(anchor),
    ]) {
      assert.equal(r.fix, null, `anchor ${anchor} must not return a fix`);
      assert.equal(r.reason, 'gps-stale');
    }
  }
  // And the health chip agrees rather than showing the last good number.
  const h = s.currentEffAcc(120_000);
  assert.equal(h.state, 'locking');
  assert.equal(h.effAccM, null);
});

test('window widening when < minFixes in the base window; widened=true', () => {
  const s = new GpsSession();
  const anchor = 50_000;
  for (let i = 0; i < 3; i++) s.addFix(fix(48_000 + i * 1000, 0, 4, 0)); // in base window + satisfies staleness
  for (let i = 0; i < 3; i++) s.addFix(fix(12_000 + i * 1000, 0, 5, 0)); // only reached after widening
  const r = s.estimateShotFix(anchor); // non-barrier (stop-style) widening
  assert.ok(r.fix);
  assert.ok(r.fix!.fixCount >= 5, `expected ≥5 fixes after widening, got ${r.fix!.fixCount}`);
  assert.equal(r.fix!.widened, true);
});

// ── impact widening must not cross the walk onto the bag ─────────────────────
test('impact anchor never medians onto the bag across the walk (degrades instead)', () => {
  const s = new GpsSession();
  // The reviewer's scenario: hurried shot — 25 open-sky BAG fixes (acc 4) → 18s
  // walk → only 3 canopy BALL fixes (acc 12). 1/acc² weighting would PREFER the
  // bag (fix ~120m off at a plausible-looking effAcc). The movement barrier must
  // forbid crossing the walk: degrade to null, never the bag.
  const impact = 60_000;
  for (let t = 0; t <= 24; t++) s.addFix(fix(t * 1000, 0, 4, 0)); // BAG (open sky)
  for (let t = 25; t <= 42; t++) s.addFix(fix(t * 1000, 120 * ((t - 25) / 17), 6, 1.5)); // WALK
  for (let t = 58; t <= 60; t++) s.addFix(fix(t * 1000, 120, 12, 0)); // BALL (canopy, only 3)

  const r = s.estimateAtImpact(impact);
  // Never the bag — that is the whole guarantee.
  assert.ok(
    !(r.fix && metersNorth(r.fix.lat, BASE_LAT) < 30),
    'impact fix must never land on the pre-walk bag cluster'
  );
  // With only 3 ball fixes it degrades to no-fix; if it ever returns a fix it
  // must be the ball.
  if (r.fix) {
    assert.ok(metersNorth(r.fix.lat, BASE_LAT + north(120)) < 15, 'a returned fix must be the ball');
  } else {
    assert.equal(r.reason, 'no-fix');
  }
});

test('a speed-blind walk (speed = -1 under canopy) still never reaches the bag', () => {
  const s = new GpsSession();
  // The bag IS provably stationary (speed 0, tight acc — would be preferred by
  // 1/acc²) and within reach of the widen window, but the WALK between it and
  // the ball is speed-blind (CoreLocation reports -1 under canopy). Pre-fix, the
  // backward scan skipped those unknown-speed walk fixes and reached the bag.
  // Now unknown speed is a barrier, so it degrades instead.
  const impact = 60_000;
  for (let t = 16; t <= 24; t++) s.addFix(fix(t * 1000, 0, 4, 0)); // BAG (stationary, reachable)
  for (let t = 25; t <= 44; t++) s.addFix(fix(t * 1000, 120 * ((t - 25) / 19), 6, -1)); // WALK, speed unknown
  for (let t = 58; t <= 60; t++) s.addFix(fix(t * 1000, 120, 12, 0)); // BALL (only 3)

  const r = s.estimateAtImpact(impact);
  assert.ok(
    !(r.fix && metersNorth(r.fix.lat, BASE_LAT) < 30),
    'speed-blind walk must still never land on the bag'
  );
  if (r.fix) {
    assert.ok(metersNorth(r.fix.lat, BASE_LAT + north(120)) < 15, 'a returned fix must be the ball');
  } else {
    assert.equal(r.reason, 'no-fix');
  }
});

// ── widened provenance is a real, persisted flag ─────────────────────────────
test('fixSourceLabel composes anchor + widened provenance', () => {
  const mk = (source: 'impact' | 'stop-fallback', widened: boolean): ShotFix => ({
    lat: 0,
    lon: 0,
    effAccM: 3,
    fixCount: 6,
    windowSec: 20,
    medianAccM: 3,
    source,
    widened,
    estimatorVersion: 1,
  });
  assert.equal(fixSourceLabel(mk('impact', false)), 'impact');
  assert.equal(fixSourceLabel(mk('impact', true)), 'impact+widened');
  assert.equal(fixSourceLabel(mk('stop-fallback', true)), 'stop-fallback+widened');
});

test('an impact fix that reaches past its base window flags widened=true', () => {
  const s = new GpsSession();
  const impact = 60_000;
  // Sparse stationary dwell, NO walk between clusters: 3 in the base window,
  // 3 just before it → the barrier widens (no walking fix to stop it).
  for (const t of [46, 53, 59]) s.addFix(fix(t * 1000, 0, 4, 0)); // base [45,70]
  for (const t of [38, 41, 44]) s.addFix(fix(t * 1000, 0, 4, 0)); // before base, no walk
  const r = s.estimateAtImpact(impact);
  assert.ok(r.fix);
  assert.equal(r.fix!.widened, true);
  assert.equal(fixSourceLabel(r.fix!), 'impact+widened');
});

// ── no-fix vs gps-stale ──────────────────────────────────────────────────────
test('no-fix when fixes exist near the anchor but none are stationary', () => {
  const s = new GpsSession();
  for (let t = 25; t <= 35; t++) s.addFix(fix(t * 1000, 0, 5, 2.0)); // all walking
  const r = s.estimateShotFix(30_000);
  assert.equal(r.fix, null);
  assert.equal(r.reason, 'no-fix');

  // Contrast: fixes exist but are all far older than the anchor → gps-stale.
  const s2 = new GpsSession();
  for (let t = 0; t <= 9; t++) s2.addFix(fix(t * 1000, 0, 4, 0));
  assert.equal(s2.estimateShotFix(30_000).reason, 'gps-stale');
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

/**
 * Monotone in N specifically — and STRICTLY so until the √-averaging is capped,
 * after which it must go flat rather than continue improving. The cap is the
 * honest part: fixes 1 s apart are not independent, so 60 of them do not buy
 * √60. Without it a long dwell would report sub-metre accuracy it does not have.
 */
test('effAcc improves as N grows, then flattens at the decorrelation cap', () => {
  const accM = 9;
  const at = (n: number) => computeEffAcc(accM, n, n, DEFAULT_GPS_CONFIG); // 1Hz → span = N
  for (let n = 3; n < 60; n++) {
    assert.ok(at(n + 1) <= at(n) + 1e-9, `effAcc must not worsen going ${n}→${n + 1}`);
  }
  assert.ok(at(60) < at(15), 'a long dwell must beat a short one');
  // span/15 is the independent-sample count, so N is not what binds: doubling
  // the FIX RATE over the same 30s span must not improve the answer at all.
  assert.equal(computeEffAcc(accM, 60, 30, DEFAULT_GPS_CONFIG), computeEffAcc(accM, 30, 30, DEFAULT_GPS_CONFIG));
  // And the floor holds: no window makes a 3m fix look better than 2.5×1.2.
  assert.equal(computeEffAcc(0.1, 60, 180, DEFAULT_GPS_CONFIG), 2.5 * 1.2);
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

// ── health chip (currentEffAcc) ─────────────────────────────────────────────
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

// ── THE REGRESSION THAT MATTERS: impact anchor vs start press ────────────────
/**
 * A start-press-anchored implementation FAILS this test, and that is the point.
 * The golfer drops the bag at the cart path, presses record, walks ~29 s to a
 * ball 120 m out, sets up and swings. Anchoring at the press medians the
 * previous filming spot; anchoring at impact medians the ball.
 */
test('impact-anchored estimate lands on the BALL, not the pre-walk BAG cluster', () => {
  const s = new GpsSession();
  // 1Hz timeline:
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
  // The two anchors resolve to clusters ~120m apart — the whole point.
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

/**
 * The same trap seen through the CARRY, which is what the golfer actually sees,
 * and it is worse than a wobble: the press for a shot happens at the PREVIOUS
 * ball, so a start-press-anchored carry is shifted by one leg. It does not
 * report this shot badly — it reports the LAST shot instead, confidently, with
 * a healthy fix count and a tight effAcc. Here a 40 m pitch comes back as the
 * 220 m drive that preceded it.
 */
test('a start-press-anchored carry reports the PREVIOUS leg; the impact-anchored one is right', () => {
  const s = new GpsSession();
  // 1Hz timeline. Ball positions: tee 0m → drive to 220m → pitch to 260m.
  //   0–9s     stationary at the TEE (0m)                    — press for shot 1
  //   10–69s   riding the cart 0→220m (≈3.7 m/s)
  //   70–99s   stationary at BALL 1 (220m)  — impact 1 @95s, press for shot 2 @97s
  //   100–114s walking 220→260m
  //   115–144s stationary at BALL 2 (260m)  — impact 2 @140s
  for (let t = 0; t <= 9; t++) s.addFix(fix(t * 1000, 0, 4, 0));
  for (let t = 10; t <= 69; t++) s.addFix(fix(t * 1000, 220 * ((t - 10) / 59), 6, 3.7));
  for (let t = 70; t <= 99; t++) s.addFix(fix(t * 1000, 220, 4, 0));
  for (let t = 100; t <= 114; t++) s.addFix(fix(t * 1000, 220 + 40 * ((t - 100) / 14), 6, 2.7));
  for (let t = 115; t <= 144; t++) s.addFix(fix(t * 1000, 260, 4, 0));

  const impact1 = s.estimateAtImpact(95_000).fix;
  const impact2 = s.estimateAtImpact(140_000).fix;
  const press1 = s.estimateAtImpact(7_000).fix; // pressed at the tee
  const press2 = s.estimateAtImpact(97_000).fix; // pressed at ball 1, before walking on
  assert.ok(impact1 && impact2 && press1 && press2);

  const good = carryBetween(impact1, impact2);
  const bad = carryBetween(press1, press2);
  assert.ok(good && bad);
  assert.ok(Math.abs(good!.carryM - 40) < 1, `impact-anchored carry ≈40m, got ${good!.carryM}`);
  assert.ok(
    bad!.carryM > 200,
    `start-press carry should mis-report the previous 220m drive, got ${bad!.carryM}`
  );
});

// ── carryBetween ────────────────────────────────────────────────────────────
/**
 * Hand-computed geometry, not a re-run of the implementation: on a sphere of
 * radius R a small displacement of dN metres north and dE metres east is
 * Δφ = dN/R and Δλ = dE/(R·cos φ), and the great-circle distance is
 * √(dN² + dE²) to well under a millimetre at these ranges. So 90 m north +
 * 120 m east is a 3-4-5 triangle: exactly 150 m, on a bearing of
 * atan2(120, 90) = 53.130°.
 */
test('carryBetween: 150m leg (3-4-5 construction) — distance, bearing and the sigma claimed', () => {
  const a = shotFix(BASE_LAT, BASE_LON, 4);
  const b = shotFix(BASE_LAT + north(90), BASE_LON + east(120, BASE_LAT), 6);

  const c = carryBetween(a, b);
  assert.ok(c);
  assert.ok(Math.abs(c!.carryM - 150) < 0.05, `expected 150m, got ${c!.carryM}`);
  assert.ok(Math.abs(c!.bearingDeg - 53.1301) < 0.01, `expected 53.130°, got ${c!.bearingDeg}`);

  // σ_gps = √(a² + b²) = √52 = 7.2111 — the term the fit gets as sigma_gps_m.
  assert.ok(Math.abs(c!.sigmaGpsM - Math.sqrt(52)) < 1e-9);
  // v2 used √((a²+b²)/2) = √26 = 5.099 to keep a tier boundary tidy. V3 must
  // NOT: understating the GPS sigma by √2 makes the fit over-trust it.
  assert.ok(c!.sigmaGpsM > Math.sqrt(26) * 1.4, 'must not be the v2 RMS-average form');
  // Total = √(52 + 3²) = √61 = 7.8102, the bag offset folded in.
  assert.ok(Math.abs(c!.sigmaM - Math.sqrt(61)) < 1e-9);
  assert.equal(c!.bagOffsetM, DEFAULT_GPS_CONFIG.bagOffsetM);
  assert.equal(c!.effAccAM, 4);
  assert.equal(c!.effAccBM, 6);
});

test('carryBetween: 12m leg — the number is honest but the sigma swamps it', () => {
  const a = shotFix(BASE_LAT, BASE_LON, 3);
  const b = shotFix(BASE_LAT + north(12), BASE_LON, 3);

  const c = carryBetween(a, b);
  assert.ok(c);
  assert.ok(Math.abs(c!.carryM - 12) < 0.01, `expected 12m, got ${c!.carryM}`);
  assert.ok(Math.abs(c!.bearingDeg) < 0.01, 'due north → bearing 0');
  assert.ok(Math.abs(c!.sigmaGpsM - Math.sqrt(18)) < 1e-9); // √(3²+3²) = 4.2426
  assert.ok(Math.abs(c!.sigmaM - Math.sqrt(27)) < 1e-9); // √(18+9)   = 5.1962
  // The point of returning the sigma at all: on a 12m leg the uncertainty is
  // ~43% of the number. A ladder that reports this as a carry is lying, and it
  // now has the evidence to refuse. (Where the threshold sits is the ladder's
  // call, not ours — we only guarantee the sigma is not quietly flattering.)
  assert.ok(c!.sigmaM / c!.carryM > 0.4, 'a short leg must read as GPS-noise-dominated');
});

test('carryBetween is symmetric in distance and reciprocal in bearing', () => {
  const a = shotFix(BASE_LAT, BASE_LON, 4);
  const b = shotFix(BASE_LAT + north(90), BASE_LON + east(120, BASE_LAT), 6);
  const ab = carryBetween(a, b);
  const ba = carryBetween(b, a);
  assert.ok(ab && ba);
  assert.ok(Math.abs(ab!.carryM - ba!.carryM) < 1e-6);
  assert.ok(Math.abs(ab!.sigmaM - ba!.sigmaM) < 1e-12, 'σ must not depend on argument order');
  const reciprocal = (ab!.bearingDeg + 180) % 360;
  assert.ok(Math.abs(reciprocal - ba!.bearingDeg) < 0.01);
});

/**
 * The last shot of a hole has no successor, so there is no GPS carry. That is
 * the ORDINARY case — once per hole, eighteen times a round — not an error: the
 * shot renders pixel-only and unlabelled. It must return null cleanly and never
 * throw, because the batch loop runs over every clip including that one.
 */
test('carryBetween: no successor → null, cleanly (the last shot of a hole)', () => {
  const a = shotFix(BASE_LAT, BASE_LON, 4);
  assert.equal(carryBetween(a, null), null);
  assert.equal(carryBetween(a, undefined), null);
  assert.equal(carryBetween(null, a), null); // this shot's own fix failed
  assert.equal(carryBetween(null, null), null);
  assert.equal(carryBetween(undefined, undefined), null);
});

test('carryBetween: the bag-offset term comes from config, not a literal', () => {
  const cfg: GpsConfig = { ...DEFAULT_GPS_CONFIG, bagOffsetM: 0 };
  const a = shotFix(BASE_LAT, BASE_LON, 4);
  const b = shotFix(BASE_LAT + north(90), BASE_LON + east(120, BASE_LAT), 6);
  const c = carryBetween(a, b, cfg);
  assert.ok(c);
  assert.equal(c!.bagOffsetM, 0);
  // With the bag term off, total σ collapses onto the pure GPS σ.
  assert.ok(Math.abs(c!.sigmaM - c!.sigmaGpsM) < 1e-12);
});

// ── the config seam ─────────────────────────────────────────────────────────
/**
 * The singleton resolves `config.tracer.gps` over the defaults. A typo'd or
 * partial slice must not leave a threshold `undefined` — every comparison
 * against undefined is false, which would silently disable the speed gate and
 * the accuracy filter at once. This is the cheapest possible guard on that.
 */
test('the app singleton has a complete, finite config regardless of what config.ts carries', () => {
  for (const key of Object.keys(DEFAULT_GPS_CONFIG) as (keyof GpsConfig)[]) {
    const value = gpsSession.cfg[key];
    assert.equal(typeof value, 'number', `${key} must be a number`);
    assert.ok(Number.isFinite(value), `${key} must be finite, got ${value}`);
  }
});
