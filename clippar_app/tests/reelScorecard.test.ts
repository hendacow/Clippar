import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReelScorecard } from '../lib/reelScorecard';

// Henry: "the same scorecard that's on the preview is the exact same I want
// on the export reel." The preview card obeys lib/scoreDisplay.ts — a hole
// shows nothing until it was ENDED, and TOTAL counts finished holes only.
//
// The reel's payload used to ignore both rules: totalPar/totalStrokes summed
// EVERY hole, and `strokes` on an unfinished hole is only the clip-count
// fallback from buildHoleSections. So a reel could print a proud total made
// partly of holes the golfer never ended. These tests pin the fix:
//
//   1. completion rides along per hole, so native can draw an empty cell;
//   2. totals come from completedTotals — unfinished holes contribute
//      nothing, and "nothing finished" is reported as such (holesCompleted 0)
//      rather than as a total of zero strokes that looks real;
//   3. the per-hole reel timeline (startMs/endMs) is untouched by any of it.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

const hole = (
  holeNumber: number,
  par: number,
  strokes: number,
  hasScore: boolean,
  durationMs = 1000,
) => ({ holeNumber, par, strokes, hasScore, durationMs });

// ─── Completion travels to native ───

test('every hole carries whether it was actually finished', () => {
  const sc = buildReelScorecard('Royal Melbourne', [
    hole(1, 4, 5, true),
    hole(2, 3, 2, false),
  ]);
  assert.deepEqual(
    sc.holes.map((h) => h.hasScore),
    [true, false],
  );
});

test('an unfinished hole still carries its par, so the card can show it', () => {
  const sc = buildReelScorecard('Royal Melbourne', [hole(1, 5, 2, false)]);
  assert.equal(sc.holes[0].par, 5);
  assert.equal(sc.holes[0].hasScore, false);
});

// ─── TOTAL counts finished holes only ───

test('a mid-hole clip count never leaks into the reel total', () => {
  const sc = buildReelScorecard('Royal Melbourne', [
    hole(1, 4, 5, true), // bogey, finished
    hole(2, 3, 3, true), // par, finished
    hole(3, 4, 2, false), // 2 clips so far — must not count
  ]);
  assert.equal(sc.totalStrokes, 8);
  assert.equal(sc.totalPar, 7);
  assert.equal(sc.holesCompleted, 2);
});

test('nothing finished reports nothing finished, not a zero total', () => {
  const sc = buildReelScorecard('Royal Melbourne', [
    hole(1, 4, 2, false),
    hole(2, 3, 1, false),
  ]);
  assert.equal(sc.holesCompleted, 0);
  assert.equal(sc.totalStrokes, 0);
  assert.equal(sc.totalPar, 0);
});

test('a finished round totals every hole', () => {
  const sc = buildReelScorecard('Royal Melbourne', [
    hole(1, 4, 3, true),
    hole(2, 3, 3, true),
    hole(3, 5, 7, true),
  ]);
  assert.equal(sc.totalStrokes, 13);
  assert.equal(sc.totalPar, 12);
  assert.equal(sc.holesCompleted, 3);
});

// ─── The reel timeline is unchanged ───

test('hole ranges are the running sum of each hole’s playable duration', () => {
  const sc = buildReelScorecard('Royal Melbourne', [
    hole(1, 4, 4, true, 3000),
    hole(2, 3, 2, false, 1500),
    hole(3, 5, 6, true, 2500),
  ]);
  assert.deepEqual(
    sc.holes.map((h) => [h.startMs, h.endMs]),
    [
      [0, 3000],
      [3000, 4500],
      [4500, 7000],
    ],
  );
});

test('a hole with no playable clips is a zero-length range, not a gap', () => {
  const sc = buildReelScorecard('Royal Melbourne', [
    hole(1, 4, 4, true, 2000),
    hole(2, 3, 3, true, 0),
    hole(3, 4, 4, true, 1000),
  ]);
  assert.deepEqual(
    sc.holes.map((h) => [h.startMs, h.endMs]),
    [
      [0, 2000],
      [2000, 2000],
      [2000, 3000],
    ],
  );
});

test('an unnamed round still gets a card title', () => {
  assert.equal(buildReelScorecard('', [hole(1, 4, 4, true)]).courseName, 'Round');
});

// ─── Both cards are wired to the same rules ───

test('the reel payload delegates its totals to the shared helper', () => {
  const src = read('lib/reelScorecard.ts');
  assert.match(src, /completedTotals/);
  // The old "sum every hole" arithmetic must not come back.
  assert.doesNotMatch(src, /reduce\(\(sum/);
});

test('the editor builds the reel payload through that helper', () => {
  const src = read('app/round/editor.tsx');
  assert.match(src, /buildReelScorecard\(/);
  assert.match(src, /hasScore: hole\.hasScore/);
  assert.doesNotMatch(src, /totalPar: state\.holes\.reduce/);
});

test('native ports the score palette and names lib/scoreDisplay.ts as its source', () => {
  const src = read('modules/shot-detector/ios/ShotDetectorModule.swift');
  assert.match(src, /SOURCE OF TRUTH: clippar_app\/lib\/scoreDisplay\.ts/);
  // Eagle gold, birdie green, par white, bogey orange, double+ red.
  for (const hex of ['#FFD700', '#4CAF50', '#FFFFFF', '#FF9800', '#FF4444']) {
    assert.ok(src.includes(hex), `Swift palette is missing ${hex}`);
  }
  // The card must key off completion, not playback position.
  assert.match(src, /hole\.isComplete/);
  assert.doesNotMatch(src, /let isPlayed = cellIdx <= index/);
});
