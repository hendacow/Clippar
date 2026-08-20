import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyVolumeEvent,
  resolveStopRequest,
  canStartRecording,
  nextHoleAfter,
  lastHoleOf,
  findLastClipIndexOnHole,
  previousHoleTarget,
  resumeShotNumber,
  upsertHoleScore,
  orderedHoleNumbers,
  MIN_CLIP_DURATION_MS,
} from '../lib/liveRecordingLogic';

// Live-recording hardening: these tests lock down the pure decision
// functions behind the three user-reported symptoms — phantom auto-start on
// round entry (S3), the generic recording error / lost shots (S2), and
// "Delete last shot" reappearing in the editor (S1).

const NOW = 1_000_000;
const volumeDefaults = { nowMs: NOW, resetTarget: 0.5, resetTolerance: 0.02 };

// ---- classifyVolumeEvent -------------------------------------------------

test('volume event inside the grace window is suppressed (audio-session activation noise)', () => {
  assert.equal(
    classifyVolumeEvent({ ...volumeDefaults, value: 0.25, graceUntilMs: NOW + 500 }),
    'suppress-grace'
  );
});

test('volume event at the reset target is suppressed even with no pending reset expectation', () => {
  // Route-change / session notifications report the CURRENT volume, which we
  // keep pinned at 0.5. Real presses report 0.55/0.65/0.7 — never 0.5.
  assert.equal(
    classifyVolumeEvent({ ...volumeDefaults, value: 0.5, graceUntilMs: 0 }),
    'suppress-reset'
  );
  assert.equal(
    classifyVolumeEvent({ ...volumeDefaults, value: 0.51, graceUntilMs: 0 }),
    'suppress-reset'
  );
});

test('volume event away from the reset target after the grace window is a press', () => {
  assert.equal(
    classifyVolumeEvent({ ...volumeDefaults, value: 0.65, graceUntilMs: 0 }),
    'press'
  );
  assert.equal(
    classifyVolumeEvent({ ...volumeDefaults, value: 0.25, graceUntilMs: NOW - 1 }),
    'press'
  );
});

// ---- resolveStopRequest --------------------------------------------------

test('un-forced early stop is ignored (phantom clicker bounce guard)', () => {
  assert.equal(resolveStopRequest({ elapsedMs: 1200, forced: false }), 'ignore');
});

test('forced early stop cancels — recording ends but the too-short clip is discarded', () => {
  // On-screen record button / tutorial end: the user unambiguously asked to
  // stop. Previously this was silently swallowed AFTER a confirming haptic,
  // leaving the camera recording to the 120s cap.
  assert.equal(resolveStopRequest({ elapsedMs: 800, forced: true }), 'cancel');
});

test('stop after the minimum duration is a normal stop from either path', () => {
  assert.equal(resolveStopRequest({ elapsedMs: MIN_CLIP_DURATION_MS, forced: false }), 'stop');
  assert.equal(resolveStopRequest({ elapsedMs: 8000, forced: true }), 'stop');
});

// ---- canStartRecording ---------------------------------------------------

test('start is blocked while recording and while the previous clip finalizes', () => {
  // Calling recordAsync during the 5-10s MP4 finalize window makes the
  // native side no-op with a never-settling promise (REC shows, nothing
  // records). The finalizing gate closes that window.
  assert.equal(canStartRecording({ isRecording: true, isFinalizing: false }), false);
  assert.equal(canStartRecording({ isRecording: false, isFinalizing: true }), false);
  assert.equal(canStartRecording({ isRecording: false, isFinalizing: false }), true);
});

// ---- round-over / last hole ---------------------------------------------

test('lastHoleOf covers all four round shapes, including the wrap', () => {
  assert.equal(lastHoleOf(18, 1), 18);
  assert.equal(lastHoleOf(9, 1), 9);
  assert.equal(lastHoleOf(9, 10), 18);
  // Shotgun full round: tees off on 10, plays 10..18 then 1..9, ends on 9 —
  // the last hole in PLAY order, not the numerically largest.
  assert.equal(lastHoleOf(18, 10), 9);
});

test('nextHoleAfter advances in play order and ends exactly at the last hole', () => {
  assert.equal(nextHoleAfter(1, 18, 1), 2);
  assert.equal(nextHoleAfter(17, 18, 1), 18);
  assert.equal(nextHoleAfter(18, 18, 1), null); // round over
  assert.equal(nextHoleAfter(9, 9, 1), null);
  assert.equal(nextHoleAfter(17, 9, 10), 18);
  assert.equal(nextHoleAfter(18, 9, 10), null);
});

test('nextHoleAfter wraps 18 → 1 on a shotgun full round, and ends on 9', () => {
  assert.equal(nextHoleAfter(10, 18, 10), 11);
  assert.equal(nextHoleAfter(18, 18, 10), 1); // THE wrap — not 19, not over
  assert.equal(nextHoleAfter(1, 18, 10), 2);
  assert.equal(nextHoleAfter(8, 18, 10), 9);
  assert.equal(nextHoleAfter(9, 18, 10), null); // real end of the round
});

test('nextHoleAfter refuses a hole the round does not contain', () => {
  assert.equal(nextHoleAfter(12, 9, 1), null); // hole 12 isn't in a front nine
  assert.equal(nextHoleAfter(3, 9, 10), null);
});

// ---- findLastClipIndexOnHole --------------------------------------------

test('delete-last-shot targets the last clip on the CURRENT hole only', () => {
  const clips = [
    { holeNumber: 1 },
    { holeNumber: 2 },
    { holeNumber: 2 },
    { holeNumber: 3 },
  ];
  assert.equal(findLastClipIndexOnHole(clips, 2), 2);
  assert.equal(findLastClipIndexOnHole(clips, 3), 3);
  assert.equal(findLastClipIndexOnHole(clips, 1), 0);
});

test('a hole with no clips yields -1 (nothing to delete)', () => {
  assert.equal(findLastClipIndexOnHole([{ holeNumber: 1 }], 5), -1);
  assert.equal(findLastClipIndexOnHole([], 1), -1);
});

// ---- previousHoleTarget (manual Previous Hole clamping) ------------------

test('previousHoleTarget steps back one hole in play order', () => {
  assert.equal(previousHoleTarget(5, 18, 1), 4);
  assert.equal(previousHoleTarget(18, 18, 1), 17);
  // Wrapping round: the hole before 1 is 18 in play order.
  assert.equal(previousHoleTarget(1, 18, 10), 18);
  assert.equal(previousHoleTarget(9, 18, 10), 8);
});

test('previousHoleTarget clamps at the round start hole (never below)', () => {
  // Front-9 / full round: can't go below hole 1.
  assert.equal(previousHoleTarget(1, 18, 1), null);
  // Back-nine round: can't go below hole 10.
  assert.equal(previousHoleTarget(10, 9, 10), null);
  assert.equal(previousHoleTarget(11, 9, 10), 10);
  // Shotgun full round: 10 is the FIRST hole played, so no previous — even
  // though 9 exists on the card, it's the round's last hole, not its prior.
  assert.equal(previousHoleTarget(10, 18, 10), null);
});

// ---- resumeShotNumber (shot counter when landing on a hole) --------------

test('resumeShotNumber on a brand-new hole with no clips is 1 (forward advance)', () => {
  assert.equal(resumeShotNumber([], [], 6), 1);
});

test('resumeShotNumber appends after existing clips on an unscored hole', () => {
  const clips = [{ holeNumber: 6 }, { holeNumber: 6 }, { holeNumber: 7 }];
  assert.equal(resumeShotNumber([], clips, 6), 3);
});

test('resumeShotNumber restores from a committed score so penalties survive', () => {
  // Hole 5 was scored 6 (e.g. 4 clips + a 2-stroke penalty). Stepping back
  // must resume at 7 so re-ending unchanged reproduces 6, not the clip count.
  const scores = [{ holeNumber: 5, strokes: 6 }];
  const clips = [
    { holeNumber: 5 },
    { holeNumber: 5 },
    { holeNumber: 5 },
    { holeNumber: 5 },
  ];
  assert.equal(resumeShotNumber(scores, clips, 5), 7);
});

// ---- upsertHoleScore (idempotent per-hole score list) -------------------

test('upsertHoleScore appends a new hole and keeps the list sorted', () => {
  const scores = [
    { holeNumber: 1, strokes: 4 },
    { holeNumber: 3, strokes: 5 },
  ];
  const next = upsertHoleScore(scores, { holeNumber: 2, strokes: 3 });
  assert.deepEqual(
    next.map((s) => s.holeNumber),
    [1, 2, 3]
  );
});

test('upsertHoleScore replaces an existing hole (no duplicate, no double-count)', () => {
  const scores = [
    { holeNumber: 1, strokes: 4 },
    { holeNumber: 2, strokes: 5 },
  ];
  const next = upsertHoleScore(scores, { holeNumber: 2, strokes: 7 });
  assert.equal(next.length, 2);
  assert.deepEqual(next, [
    { holeNumber: 1, strokes: 4 },
    { holeNumber: 2, strokes: 7 },
  ]);
});

// ---- orderedHoleNumbers (real hole numbers, start-hole aware) ------------

test('orderedHoleNumbers yields real hole numbers for each round shape', () => {
  assert.deepEqual(orderedHoleNumbers(18, 1), [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  ]);
  assert.deepEqual(orderedHoleNumbers(9, 1), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // Back-nine round renders holes 10–18, NOT 1–9.
  assert.deepEqual(orderedHoleNumbers(9, 10), [
    10, 11, 12, 13, 14, 15, 16, 17, 18,
  ]);
  // Shotgun full round wraps after 18 back to 1, in PLAY order.
  assert.deepEqual(orderedHoleNumbers(18, 10), [
    10, 11, 12, 13, 14, 15, 16, 17, 18, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
});
