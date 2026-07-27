import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planHighlightTrim,
  HIGHLIGHT_SECONDS,
  LEAD_IN_SECONDS,
  type HighlightInput,
} from '../modules/swing-vision/highlightTrim';

// The trim POLICY is pure, so it can be pinned down without a device. The three
// leave-unchanged cases matter as much as the trim itself: cutting a clip we do
// not understand is worse than not cutting it.

const res = (over: Partial<HighlightInput>): HighlightInput => ({
  decision: 'SWING',
  strokeType: 'swing',
  tImpact: 4.2,
  durationSec: 20,
  ...over,
});

test('a full swing is trimmed to exactly the highlight length', () => {
  const p = planHighlightTrim(res({ tImpact: 8 }));
  assert.equal(p.trim, true);
  assert.equal(p.startSec, 8 - LEAD_IN_SECONDS);
  assert.ok(Math.abs(p.endSec - p.startSec - HIGHLIGHT_SECONDS) < 1e-9);
});

test('a putt is left UNCHANGED', () => {
  const p = planHighlightTrim(res({ strokeType: 'putt' }));
  assert.equal(p.trim, false);
  assert.match(p.reason, /putt/);
});

test('no detection leaves the clip UNCHANGED', () => {
  const p = planHighlightTrim(res({ decision: 'NO_SWING', tImpact: undefined }));
  assert.equal(p.trim, false);
  assert.match(p.reason, /no swing/);
});

test('a clip already shorter than the highlight is left alone', () => {
  const p = planHighlightTrim(res({ durationSec: 4 }));
  assert.equal(p.trim, false);
});

test('a swing near the START still yields a full-length window', () => {
  // Impact at 0.5s would put the window at -1.5s; it must slide, not shorten.
  const p = planHighlightTrim(res({ tImpact: 0.5, durationSec: 20 }));
  assert.equal(p.startSec, 0);
  assert.ok(Math.abs(p.endSec - p.startSec - HIGHLIGHT_SECONDS) < 1e-9);
});

test('a swing near the END still yields a full-length window inside the clip', () => {
  const p = planHighlightTrim(res({ tImpact: 19.8, durationSec: 20 }));
  assert.ok(Math.abs(p.endSec - p.startSec - HIGHLIGHT_SECONDS) < 1e-9);
  assert.ok(p.endSec <= 20 + 1e-9, 'window must not run past the end of the clip');
  assert.ok(p.startSec >= 0);
});

test('a SWING decision with no impact time is treated as no detection', () => {
  const p = planHighlightTrim(res({ tImpact: undefined }));
  assert.equal(p.trim, false);
});
