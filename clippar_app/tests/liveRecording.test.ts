import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyVolumeEvent,
  resolveStopRequest,
  canStartRecording,
  isRoundOver,
  lastHoleOf,
  findLastClipIndexOnHole,
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

test('lastHoleOf covers all three round shapes', () => {
  assert.equal(lastHoleOf(18, 1), 18);
  assert.equal(lastHoleOf(9, 1), 9);
  assert.equal(lastHoleOf(9, 10), 18);
});

test('isRoundOver flips exactly past the last hole', () => {
  assert.equal(isRoundOver(18, 18, 1), false);
  assert.equal(isRoundOver(19, 18, 1), true);
  assert.equal(isRoundOver(10, 9, 1), true);
  assert.equal(isRoundOver(18, 9, 10), false);
  assert.equal(isRoundOver(19, 9, 10), true);
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
