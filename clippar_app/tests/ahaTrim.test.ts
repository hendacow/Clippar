import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFallbackTrimWindow,
  computeOverallBuildTimeoutMs,
  dedupeSelectedAssets,
  collectSuccessfulClips,
  resolveBatchOutcome,
  buildProgressLine,
  FALLBACK_CLIP_MS,
  MAX_AHA_CLIPS,
  OVERALL_TIMEOUT_BASE_MS,
  OVERALL_TIMEOUT_PER_CLIP_MS,
} from '../components/onboarding/flow/ahaTrim';

// The onboarding aha's detection-failed fallback trims the middle ~6s of the
// user's picked clip. These tests lock down the window math so a short clip
// is never over-trimmed and an unknown duration never produces a bogus window.

test('long clip: centered 6s window', () => {
  const w = computeFallbackTrimWindow(60_000);
  assert.ok(w);
  assert.equal(w.endMs - w.startMs, FALLBACK_CLIP_MS);
  assert.equal(w.startMs, 27_000);
  assert.equal(w.endMs, 33_000);
});

test('clip barely longer than the window still fits inside duration', () => {
  const w = computeFallbackTrimWindow(7_000);
  assert.ok(w);
  assert.ok(w.startMs >= 0);
  assert.ok(w.endMs <= 7_000);
  assert.equal(w.endMs - w.startMs, FALLBACK_CLIP_MS);
});

test('short clip: play as-is (null window)', () => {
  assert.equal(computeFallbackTrimWindow(4_000), null);
  assert.equal(computeFallbackTrimWindow(FALLBACK_CLIP_MS), null);
});

test('unknown/invalid duration: null window', () => {
  assert.equal(computeFallbackTrimWindow(undefined), null);
  assert.equal(computeFallbackTrimWindow(null), null);
  assert.equal(computeFallbackTrimWindow(0), null);
  assert.equal(computeFallbackTrimWindow(NaN), null);
});

// ── Multi-clip batch helpers ──────────────────────────────────────────────
// The aha now accepts up to 5 clips: each runs the single-clip ladder, the
// survivors get stitched. These lock down the pure batch math.

test('overall timeout: 30s base + 15s per clip', () => {
  assert.equal(computeOverallBuildTimeoutMs(1), OVERALL_TIMEOUT_BASE_MS + OVERALL_TIMEOUT_PER_CLIP_MS);
  assert.equal(computeOverallBuildTimeoutMs(1), 45_000);
  assert.equal(computeOverallBuildTimeoutMs(5), 30_000 + 15_000 * 5);
});

test('overall timeout: degenerate counts clamp to a single-clip budget', () => {
  assert.equal(computeOverallBuildTimeoutMs(0), 45_000);
  assert.equal(computeOverallBuildTimeoutMs(-3), 45_000);
  assert.equal(computeOverallBuildTimeoutMs(NaN), 45_000);
  assert.equal(computeOverallBuildTimeoutMs(2.9), 30_000 + 15_000 * 2); // floors fractions
});

test('dedupeSelectedAssets: drops duplicate assetIds, keeps pick order', () => {
  const assets = [
    { uri: 'file:///a.mov', assetId: 'A' },
    { uri: 'file:///b.mov', assetId: 'B' },
    { uri: 'file:///a-copy.mov', assetId: 'A' }, // same asset re-surfaced
  ];
  const out = dedupeSelectedAssets(assets);
  assert.deepEqual(out.map((a) => a.uri), ['file:///a.mov', 'file:///b.mov']);
});

test('dedupeSelectedAssets: falls back to uri identity and skips empty uris', () => {
  const assets = [
    { uri: 'file:///a.mov' },
    { uri: 'file:///a.mov' },
    { uri: '' },
    { uri: 'file:///b.mov', assetId: null },
  ];
  const out = dedupeSelectedAssets(assets);
  assert.deepEqual(out.map((a) => a.uri), ['file:///a.mov', 'file:///b.mov']);
});

test(`dedupeSelectedAssets: caps at MAX_AHA_CLIPS (${MAX_AHA_CLIPS})`, () => {
  const assets = Array.from({ length: 9 }, (_, i) => ({ uri: `file:///${i}.mov` }));
  const out = dedupeSelectedAssets(assets);
  assert.equal(out.length, MAX_AHA_CLIPS);
  assert.equal(out[0].uri, 'file:///0.mov');
  assert.equal(out[MAX_AHA_CLIPS - 1].uri, `file:///${MAX_AHA_CLIPS - 1}.mov`);
});

test('collectSuccessfulClips: skips failed clips, preserves pick order', () => {
  assert.deepEqual(
    collectSuccessfulClips(['file:///1.mov', null, 'file:///3.mov', null, 'file:///5.mov']),
    ['file:///1.mov', 'file:///3.mov', 'file:///5.mov']
  );
  assert.deepEqual(collectSuccessfulClips([null, null]), []);
  assert.deepEqual(collectSuccessfulClips([]), []);
  assert.deepEqual(collectSuccessfulClips(['']), []); // empty uri is not a success
});

test('resolveBatchOutcome: 0 → sample, 1 → single, ≥2 → stitched in order', () => {
  assert.deepEqual(resolveBatchOutcome([]), { kind: 'sample' });
  assert.deepEqual(resolveBatchOutcome(['file:///a.mov']), {
    kind: 'single',
    uri: 'file:///a.mov',
  });
  assert.deepEqual(resolveBatchOutcome(['file:///a.mov', 'file:///b.mov']), {
    kind: 'stitched',
    uris: ['file:///a.mov', 'file:///b.mov'],
  });
});

test('resolveBatchOutcome: partial failure (2 of 5 fail) still stitches the 3 survivors', () => {
  const successes = collectSuccessfulClips([
    'file:///1.mov',
    null,
    'file:///3.mov',
    null,
    'file:///5.mov',
  ]);
  assert.deepEqual(resolveBatchOutcome(successes), {
    kind: 'stitched',
    uris: ['file:///1.mov', 'file:///3.mov', 'file:///5.mov'],
  });
});

test('buildProgressLine: single clip keeps the historical copy', () => {
  assert.equal(buildProgressLine(null), 'Finding the swing…');
  assert.equal(buildProgressLine({ current: 1, total: 1, stage: 'cutting' }), 'Finding the swing…');
});

test('buildProgressLine: multi-clip reflects cutting and stitching progress', () => {
  assert.equal(buildProgressLine({ current: 2, total: 4, stage: 'cutting' }), 'Cutting swing 2 of 4…');
  assert.equal(buildProgressLine({ current: 5, total: 5, stage: 'cutting' }), 'Cutting swing 5 of 5…');
  assert.equal(
    buildProgressLine({ current: 3, total: 3, stage: 'stitching' }),
    'Stitching 3 swings into one reel…'
  );
});

test('buildProgressLine: clamps out-of-range current into [1, total]', () => {
  assert.equal(buildProgressLine({ current: 0, total: 3, stage: 'cutting' }), 'Cutting swing 1 of 3…');
  assert.equal(buildProgressLine({ current: 9, total: 3, stage: 'cutting' }), 'Cutting swing 3 of 3…');
});
