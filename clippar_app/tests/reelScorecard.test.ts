import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReelScorecard, holeReelDurationMs } from '../lib/reelScorecard';

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

// ─── The reel timeline counts only clips that are IN the reel ───
//
// Native decides which hole's card to draw over a shot by matching that shot's
// position in the reel against the cumulative startMs/endMs below. So the
// timeline has to be built from the clips that actually got composed. The
// editor drops clips whose file is gone from disk and could not be
// re-downloaded — iOS evicts app files routinely, so that is an ordinary
// event — and counting a dropped clip's duration here pushes every later hole
// boundary past where the video really is, until shots carry an earlier hole's
// card.

const timed = (
  id: string,
  durationMs: number,
  extra: Partial<{
    isExcluded: boolean;
    autoTrimmed: boolean;
    originalUri: string;
    trimStartMs: number;
    trimEndMs: number;
  }> = {},
) => ({
  id,
  durationMs,
  trimStartMs: extra.trimStartMs ?? 0,
  trimEndMs: extra.trimEndMs ?? -1,
  isExcluded: extra.isExcluded,
  autoTrimmed: extra.autoTrimmed,
  originalUri: extra.originalUri,
});

test('holeReelDurationMs: a dropped clip contributes nothing', () => {
  const clips = [timed('a', 3000), timed('b', 4000), timed('c', 2000)];
  const inReel = new Set(['a', 'c']); // 'b' was missing on disk and unrecoverable
  assert.equal(holeReelDurationMs(clips, (c) => inReel.has(c.id)), 5000);
});

test('holeReelDurationMs: excluded clips still contribute nothing', () => {
  const clips = [timed('a', 3000), timed('b', 4000, { isExcluded: true })];
  assert.equal(holeReelDurationMs(clips, () => true), 3000);
});

test('holeReelDurationMs: a user trim is measured, a full clip uses its duration', () => {
  const clips = [
    timed('a', 10000, { trimStartMs: 2000, trimEndMs: 5000 }), // 3000
    timed('b', 4000), // trimEndMs -1 → full 4000
  ];
  assert.equal(holeReelDurationMs(clips, () => true), 7000);
});

test('holeReelDurationMs: a pre-trimmed clip contributes its trim file, not the original video', () => {
  // sourceUri IS the trim file, and composeClips sends native 0..-1 for it, so
  // the contribution is that file's length — 2500ms, not the 14.5s original.
  const clips = [
    timed('a', 2500, {
      autoTrimmed: true,
      originalUri: 'file:///orig.mov',
      trimStartMs: 12000,
      trimEndMs: 14500,
    }),
  ];
  assert.equal(holeReelDurationMs(clips, () => true), 2500);
});

test('holeReelDurationMs: a pre-trimmed clip ignores a durationMs left at the original length', () => {
  // THE BUG. useEditorState's auto-trim points sourceUri at the trim file in
  // React state but never refreshes durationMs, so for the rest of that session
  // durationMs is the UNTRIMMED recording. Only SQLite gets the corrected value
  // (markClipTrimmed), and nothing reloads the editor between auto-trim and
  // Export — so this is the state every ordinary round exports in.
  //
  // The trim window's WIDTH is the trim file's length by construction (it is
  // the number markClipTrimmed persists), so it is what must be counted.
  const clips = [
    timed('a', 30000, {
      autoTrimmed: true,
      originalUri: 'file:///orig.mov',
      trimStartMs: 12000,
      trimEndMs: 15000,
    }),
  ];
  assert.equal(holeReelDurationMs(clips, () => true), 3000);
});

test('holeReelDurationMs: a pre-trimmed clip with no explicit end falls back to durationMs', () => {
  // The manual re-trimmer writes trimEndMs -1 when the user drags the end
  // handle to the very end, and writes the trimmed length into durationMs at
  // the same time (ClipTrimModal.handleSave → updateTrim's sourceOverride).
  const clips = [
    timed('a', 4000, { autoTrimmed: true, originalUri: 'file:///orig.mov', trimStartMs: 9000 }),
  ];
  assert.equal(holeReelDurationMs(clips, () => true), 4000);
});

test('holeReelDurationMs: trimming only the start still shortens the hole', () => {
  // trimEndMs -1 means "play to the end of the file", not "ignore the start
  // handle" — native plays [2000, 10000), i.e. 8000ms. Counting the full 10000
  // pushed every later hole boundary 2s late.
  const clips = [timed('a', 10000, { trimStartMs: 2000 })];
  assert.equal(holeReelDurationMs(clips, () => true), 8000);
});

test('an auto-trimmed round puts hole 2 where the video really starts', () => {
  // End-to-end shape of the bug: three 30s recordings auto-trimmed to 3s each.
  // Counting durationMs put hole 2's card at 60s into a reel that is 9s long,
  // so every shot after the first carried hole 1's scorecard.
  const trimmed = (id: string, startMs: number, endMs: number) =>
    timed(id, 30000, {
      autoTrimmed: true,
      originalUri: `file:///orig-${id}.mov`,
      trimStartMs: startMs,
      trimEndMs: endMs,
    });
  const holes = [
    { holeNumber: 1, par: 4, strokes: 4, hasScore: true, clips: [trimmed('a', 10000, 13000), trimmed('b', 4000, 7000)] },
    { holeNumber: 2, par: 3, strokes: 3, hasScore: true, clips: [trimmed('c', 21000, 24000)] },
  ];

  const sc = buildReelScorecard(
    'Royal Melbourne',
    holes.map((h) => ({
      holeNumber: h.holeNumber,
      par: h.par,
      strokes: h.strokes,
      hasScore: h.hasScore,
      durationMs: holeReelDurationMs(h.clips, () => true),
    })),
  );

  assert.deepEqual(
    sc.holes.map((h) => [h.startMs, h.endMs]),
    [[0, 6000], [6000, 9000]],
  );
});

test('holeReelDurationMs: never subtracts, so reversed bounds cannot pull a hole backwards', () => {
  const clips = [timed('a', 3000, { trimStartMs: 4000, trimEndMs: 1000 })];
  assert.equal(holeReelDurationMs(clips, () => true), 0);
});

test('a dropped clip does not shift every later hole boundary', () => {
  const holes = [
    { holeNumber: 1, par: 4, strokes: 4, hasScore: true, clips: [timed('a', 3000), timed('b', 5000)] },
    { holeNumber: 2, par: 3, strokes: 3, hasScore: true, clips: [timed('c', 4000)] },
  ];
  const inReel = new Set(['a', 'c']); // 'b' never made it into the composition

  const sc = buildReelScorecard(
    'Royal Melbourne',
    holes.map((h) => ({
      holeNumber: h.holeNumber,
      par: h.par,
      strokes: h.strokes,
      hasScore: h.hasScore,
      durationMs: holeReelDurationMs(h.clips, (c) => inReel.has(c.id)),
    })),
  );

  // Hole 2 starts where the real video does (3000ms), not 5000ms later.
  assert.equal(sc.holes[0].startMs, 0);
  assert.equal(sc.holes[0].endMs, 3000);
  assert.equal(sc.holes[1].startMs, 3000);
  assert.equal(sc.holes[1].endMs, 7000);
});

test('the editor builds the reel timeline from the composed clips, not every clip', () => {
  const src = read('app/round/editor.tsx');
  // The scorecard must be gated on the same set that reaches composeReel.
  assert.match(src, /holeReelDurationMs\(hole\.clips/);
  assert.match(src, /inReelClipIds/);
  // The old inline arithmetic — which counted every non-excluded clip,
  // including ones dropped as unrecoverable — must not come back.
  assert.doesNotMatch(src, /hole\.clips\.filter\(\(c\) => !c\.isExcluded\)/);
});

test('compose trim bounds are paired to clips by index, not by string-matching URIs', () => {
  const src = read('app/round/editor.tsx');
  assert.match(src, /validClips\.map\(\(clip, idx\) =>/);
  // The old walk guessed at recovered URIs and, on a miss, ran off the end
  // and silently dropped the user's trims for every remaining clip.
  assert.doesNotMatch(src, /uri\.includes\(`\$\{clip\.id\}\.mp4`\)/);
});
