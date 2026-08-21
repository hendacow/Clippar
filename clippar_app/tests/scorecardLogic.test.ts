import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAR_OPTIONS,
  MIN_HOLE_PAR,
  MAX_HOLE_PAR,
  liveHoleNumbers,
  buildHoleDataFromPars,
  presetHasScorecard,
  holeWasPlayed,
  playedHoles,
  nextUnfilledIndex,
  isScorecardComplete,
  sanitizeHolePars,
  totalParOf,
  findPresetToUpdate,
} from '../lib/scorecardLogic';

// ── constants ──────────────────────────────────────────────

test('par options are the three standard pars the UI offers', () => {
  assert.deepEqual([...PAR_OPTIONS], [3, 4, 5]);
});

// ── liveHoleNumbers ────────────────────────────────────────

test('liveHoleNumbers: 18 from hole 1 → 1..18', () => {
  assert.deepEqual(liveHoleNumbers(18, 1), [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  ]);
});

test('liveHoleNumbers: 9 from hole 1 → 1..9', () => {
  assert.deepEqual(liveHoleNumbers(9, 1), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('liveHoleNumbers: 9 from hole 10 (back nine) → 10..18', () => {
  assert.deepEqual(liveHoleNumbers(9, 10), [10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test('liveHoleNumbers: 18 from hole 10 wraps → 10..18 then 1..9', () => {
  assert.deepEqual(
    liveHoleNumbers(18, 10),
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  );
});

// ── buildHoleDataFromPars ──────────────────────────────────

test('buildHoleDataFromPars: startHole 1 maps holeNumber N → pars[N-1]', () => {
  const holes = buildHoleDataFromPars([3, 4, 5], 1);
  assert.deepEqual(holes, [
    { holeNumber: 1, par: 3 },
    { holeNumber: 2, par: 4 },
    { holeNumber: 3, par: 5 },
  ]);
});

test('buildHoleDataFromPars: back-nine start maps element 0 → hole 10', () => {
  const pars = [4, 3, 5, 4, 4, 3, 5, 4, 4];
  const holes = buildHoleDataFromPars(pars, 10);
  assert.equal(holes.length, 9);
  assert.deepEqual(holes[0], { holeNumber: 10, par: 4 });
  assert.deepEqual(holes[8], { holeNumber: 18, par: 4 });
});

test('buildHoleDataFromPars: defaults startHole to 1', () => {
  assert.deepEqual(buildHoleDataFromPars([4, 4]), [
    { holeNumber: 1, par: 4 },
    { holeNumber: 2, par: 4 },
  ]);
});

// ── presetHasScorecard ─────────────────────────────────────

test('presetHasScorecard: true when hole_pars length matches holes_played', () => {
  assert.equal(
    presetHasScorecard({ hole_pars: new Array(18).fill(4), holes_played: 18 }),
    true,
  );
});

test('presetHasScorecard: false when hole_pars is null (legacy preset)', () => {
  assert.equal(
    presetHasScorecard({ hole_pars: null, holes_played: 18 }),
    false,
  );
});

test('presetHasScorecard: false on length mismatch (stale/partial row)', () => {
  assert.equal(
    presetHasScorecard({ hole_pars: [4, 4, 4], holes_played: 9 }),
    false,
  );
});

// ── holeWasPlayed / playedHoles (skipped holes) ────────────

test('holeWasPlayed: scored but never filmed → PLAYED (must still render)', () => {
  assert.equal(holeWasPlayed({ strokes: 5, clipCount: 0 }), true);
});

test('holeWasPlayed: filmed but never scored → played', () => {
  assert.equal(holeWasPlayed({ strokes: 0, clipCount: 2 }), true);
});

test('holeWasPlayed: no score and no clips → never played', () => {
  assert.equal(holeWasPlayed({ strokes: 0, clipCount: 0 }), false);
});

test('holeWasPlayed: an unscored hole is undefined/null, not 0', () => {
  assert.equal(holeWasPlayed({}), false);
  assert.equal(holeWasPlayed({ strokes: null, clipCount: null }), false);
  assert.equal(holeWasPlayed({ strokes: undefined, clipCount: 3 }), true);
  assert.equal(holeWasPlayed({ strokes: 4 }), true);
});

// Fixture helper: a round's holes with (strokes, clipCount) per hole number.
const holesOf = (
  entries: [holeNumber: number, strokes: number, clipCount: number][],
) => entries.map(([holeNumber, strokes, clipCount]) => ({
  holeNumber,
  strokes,
  clipCount,
}));

const numbersOf = (holes: { holeNumber: number }[]) =>
  holes.map((h) => h.holeNumber);

test('playedHoles: a gap in the middle drops only the unplayed holes', () => {
  // The owner's exact case: played 10, skipped 11 + 12, played 13.
  const holes = holesOf([
    [10, 4, 2],
    [11, 0, 0],
    [12, 0, 0],
    [13, 5, 1],
  ]);
  assert.deepEqual(numbersOf(playedHoles(holes)), [10, 13]);
});

test('playedHoles: a scored-but-unfilmed hole inside the gap survives', () => {
  const holes = holesOf([
    [10, 4, 2],
    [11, 0, 0],
    [12, 6, 0], // walked it, filmed nothing — still a real hole
    [13, 5, 1],
  ]);
  assert.deepEqual(numbersOf(playedHoles(holes)), [10, 12, 13]);
});

test('playedHoles: first hole skipped', () => {
  const holes = holesOf([
    [1, 0, 0],
    [2, 4, 1],
    [3, 5, 0],
  ]);
  assert.deepEqual(numbersOf(playedHoles(holes)), [2, 3]);
});

test('playedHoles: last hole skipped', () => {
  const holes = holesOf([
    [1, 4, 1],
    [2, 4, 0],
    [3, 0, 0],
  ]);
  assert.deepEqual(numbersOf(playedHoles(holes)), [1, 2]);
});

test('playedHoles: every hole skipped → empty, not a phantom round', () => {
  const holes = holesOf([
    [1, 0, 0],
    [2, 0, 0],
    [3, 0, 0],
  ]);
  assert.deepEqual(playedHoles(holes), []);
});

test('playedHoles: every hole played → nothing dropped', () => {
  const holes = holesOf(
    liveHoleNumbers(18, 1).map((n) => [n, 4, 1] as [number, number, number]),
  );
  assert.equal(playedHoles(holes).length, 18);
});

test('playedHoles: nine-hole round keeps its real hole numbers', () => {
  const holes = holesOf(
    liveHoleNumbers(9, 10).map(
      (n) => [n, n === 12 || n === 13 ? 0 : 4, 0] as [number, number, number],
    ),
  );
  assert.deepEqual(numbersOf(playedHoles(holes)), [10, 11, 14, 15, 16, 17, 18]);
});

test('playedHoles: a round starting on 10 and wrapping keeps play order', () => {
  // Shotgun start on 10, all 18 holes, skipped 18 and 1 (rain).
  const wrapped = Array.from({ length: 18 }, (_, i) => ((9 + i) % 18) + 1);
  const holes = holesOf(
    wrapped.map(
      (n) => [n, n === 18 || n === 1 ? 0 : 4, 0] as [number, number, number],
    ),
  );
  const kept = numbersOf(playedHoles(holes));
  // Play order preserved (10..17 then 2..9) — NOT re-sorted to 2..17.
  assert.deepEqual(kept, [10, 11, 12, 13, 14, 15, 16, 17, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('playedHoles: empty list → empty list', () => {
  assert.deepEqual(playedHoles([]), []);
});

// ── nextUnfilledIndex (auto-advance) ───────────────────────

test('nextUnfilledIndex: advances to the next hole', () => {
  assert.equal(nextUnfilledIndex([4, null, null], 0), 1);
});

test('nextUnfilledIndex: wraps to an earlier gap after the last hole', () => {
  // Filled hole 2 (index 2) last; index 1 is still empty → wrap back to it.
  assert.equal(nextUnfilledIndex([4, null, 5], 2), 1);
});

test('nextUnfilledIndex: returns null when everything is filled', () => {
  assert.equal(nextUnfilledIndex([3, 4, 5], 1), null);
});

test('nextUnfilledIndex: stays on `from` when it is the only gap', () => {
  assert.equal(nextUnfilledIndex([4, null, 5], 1), 1);
});

test('nextUnfilledIndex: empty array → null', () => {
  assert.equal(nextUnfilledIndex([], 0), null);
});

// ── isScorecardComplete ────────────────────────────────────

test('isScorecardComplete: all filled → true', () => {
  assert.equal(isScorecardComplete([3, 4, 5]), true);
});

test('isScorecardComplete: any gap → false', () => {
  assert.equal(isScorecardComplete([3, null, 5]), false);
});

test('isScorecardComplete: empty → false', () => {
  assert.equal(isScorecardComplete([]), false);
});

// ── sanitizeHolePars ───────────────────────────────────────

test('sanitizeHolePars: clean array round-trips', () => {
  assert.deepEqual(sanitizeHolePars([3, 4, 5], 3), [3, 4, 5]);
});

test('sanitizeHolePars: length mismatch → null', () => {
  assert.equal(sanitizeHolePars([4, 4], 9), null);
});

test('sanitizeHolePars: a null/unfilled hole → null', () => {
  assert.equal(sanitizeHolePars([4, null, 4], 3), null);
});

test('sanitizeHolePars: rejects out-of-range pars', () => {
  assert.equal(sanitizeHolePars([2, 4, 4], 3), null); // below MIN
  assert.equal(sanitizeHolePars([4, 7, 4], 3), null); // above MAX
});

test('sanitizeHolePars: accepts a par-6 within bounds', () => {
  assert.deepEqual(sanitizeHolePars([MIN_HOLE_PAR, MAX_HOLE_PAR], 2), [3, 6]);
});

test('sanitizeHolePars: rejects non-integers', () => {
  assert.equal(sanitizeHolePars([4, 4.5, 4], 3), null);
});

// ── totalParOf ─────────────────────────────────────────────

test('totalParOf: sums the array', () => {
  assert.equal(totalParOf([3, 4, 5, 4]), 16);
});

// ── findPresetToUpdate (upsert-by-name decision) ───────────

const presetsFixture = [
  { id: 'a', name: 'Riversdale GC' },
  { id: 'b', name: 'Pebble Beach' },
];

test('findPresetToUpdate: exact name match → update that preset (its id)', () => {
  assert.equal(findPresetToUpdate(presetsFixture, 'Pebble Beach')?.id, 'b');
});

test('findPresetToUpdate: unknown name → null (insert a new preset)', () => {
  assert.equal(findPresetToUpdate(presetsFixture, 'Augusta National'), null);
});

test('findPresetToUpdate: trims the query name before matching', () => {
  assert.equal(findPresetToUpdate(presetsFixture, '  Riversdale GC  ')?.id, 'a');
});

test('findPresetToUpdate: match is case-sensitive (mirrors the DB unique key)', () => {
  // A differently-cased name is a distinct preset, not a collision → insert.
  assert.equal(findPresetToUpdate(presetsFixture, 'pebble beach'), null);
});

test('findPresetToUpdate: blank name never matches', () => {
  assert.equal(findPresetToUpdate(presetsFixture, '   '), null);
});

test('findPresetToUpdate: empty preset list → null', () => {
  assert.equal(findPresetToUpdate([], 'Riversdale GC'), null);
});
