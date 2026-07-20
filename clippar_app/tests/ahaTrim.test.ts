import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFallbackTrimWindow,
  FALLBACK_CLIP_MS,
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
