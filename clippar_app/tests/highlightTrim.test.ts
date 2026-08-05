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
  const p = planHighlightTrim(res({ strokeType: 'putt', wristHeight: -0.65 }));
  assert.equal(p.trim, false);
  assert.match(p.reason, /putt/);
});

// A chip is a SHOT and must be trimmed. This is the case the old rule got
// wrong: motion decided, a chip's amplitude looks like a putt's, and the clip
// came back whole. Chips measure -0.21..+0.14 in wrist height, comfortably
// above the -0.485 bar, so the only thing that had to change was letting pose
// answer at all.
test('a chip is trimmed like any other shot', () => {
  const p = planHighlightTrim(
    res({ strokeType: 'swing', wristHeight: -0.185, tImpact: 8 }),
  );
  assert.equal(p.trim, true);
  assert.ok(Math.abs(p.endSec - p.startSec - HIGHLIGHT_SECONDS) < 1e-9);
});

// 'putt' with no pose reading is a residue label, not a detection — footage
// with no golf in it lands there too. The clip is left alone either way, so
// only the wording must not overclaim.
test('a putt decided WITHOUT pose does not claim to have seen a putt', () => {
  const p = planHighlightTrim(res({ strokeType: 'putt' }));
  assert.equal(p.trim, false);
  assert.doesNotMatch(p.reason, /putt/);
  assert.match(p.reason, /no shot detected/);
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

// The app's own window is 4s (2500ms before impact, 1500ms after) and the user
// can change it in Profile → Trim settings. Left to its defaults this policy
// would impose 5s on every trimmed clip instead — a visible change nobody
// asked for — so the caller's window has to win.
test('the callers window overrides the built-in default', () => {
  const p = planHighlightTrim(res({ tImpact: 8 }), { leadInSec: 2.5, totalSec: 4 });
  assert.equal(p.trim, true);
  assert.equal(p.startSec, 8 - 2.5);
  assert.ok(Math.abs(p.endSec - p.startSec - 4) < 1e-9);
});

test('a clip shorter than the CALLERS window is left whole', () => {
  // 4.5s clip against a 4s window trims; against the 5s default it would not.
  const short = planHighlightTrim(res({ durationSec: 4.5, tImpact: 2 }));
  assert.equal(short.trim, false);
  const withWindow = planHighlightTrim(
    res({ durationSec: 4.5, tImpact: 2 }), { leadInSec: 2.5, totalSec: 4 },
  );
  assert.equal(withWindow.trim, true);
});

test('a lead-in longer than the total window cannot invert the range', () => {
  const p = planHighlightTrim(res({ tImpact: 8 }), { leadInSec: 9, totalSec: 4 });
  assert.ok(p.endSec > p.startSec);
  assert.ok(p.startSec >= 0);
});
