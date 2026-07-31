import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startHoleOptions,
  normalizeStartHole,
  presetCoversRound,
  courseHolesCoverRound,
  findSavedScorecard,
  isCourseKnown,
  isCourseKnownForAnyStart,
  resolveRoundHoles,
  startRoundGate,
  recentSetups,
  type SetupPreset,
} from '../lib/roundSetup';

const par = (n: number, value = 4) => new Array(n).fill(value);

const preset = (over: Partial<SetupPreset> = {}): SetupPreset => ({
  course_id: null,
  course_name: 'Riversdale',
  holes_played: 18,
  start_hole: 1,
  hole_pars: par(18),
  ...over,
});

// ── startHoleOptions / normalizeStartHole ──────────────────

test('startHoleOptions: 9 holes can tee off on 1 or 10', () => {
  assert.deepEqual(
    startHoleOptions(9).map((o) => o.value),
    [1, 10],
  );
});

test('startHoleOptions: 18 holes only ever start on hole 1 (the round never wraps)', () => {
  assert.deepEqual(
    startHoleOptions(18).map((o) => o.value),
    [1],
  );
});

test('normalizeStartHole: a back-nine start does not survive a flip to 18', () => {
  assert.equal(normalizeStartHole(18, 10), 1);
  assert.equal(normalizeStartHole(9, 10), 10);
  assert.equal(normalizeStartHole(9, 1), 1);
});

// ── presetCoversRound ──────────────────────────────────────

test('presetCoversRound: an 18-hole scorecard covers a back-nine round', () => {
  assert.equal(presetCoversRound(preset(), 9, 10), true);
});

test('presetCoversRound: a front-nine scorecard does NOT cover the back nine', () => {
  const front = preset({ holes_played: 9, start_hole: 1, hole_pars: par(9) });
  assert.equal(presetCoversRound(front, 9, 10), false);
  assert.equal(presetCoversRound(front, 9, 1), true);
});

test('presetCoversRound: a nine-hole scorecard does not cover a full 18', () => {
  assert.equal(
    presetCoversRound(preset({ holes_played: 9, hole_pars: par(9) }), 18, 1),
    false,
  );
});

test('presetCoversRound: a preset with no saved pars covers nothing', () => {
  assert.equal(presetCoversRound(preset({ hole_pars: null }), 18, 1), false);
});

test('presetCoversRound: a truncated par array is not trusted', () => {
  // holes_played says 18 but only 9 pars were written — a half-saved row.
  assert.equal(presetCoversRound(preset({ hole_pars: par(9) }), 18, 1), false);
});

// ── courseHolesCoverRound ──────────────────────────────────

test('courseHolesCoverRound: full API hole data covers the round', () => {
  const holes = Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4 }));
  assert.equal(courseHolesCoverRound(holes, 18, 1), true);
  assert.equal(courseHolesCoverRound(holes, 9, 10), true);
});

test('courseHolesCoverRound: a hole the API had no par for leaves the round unknown', () => {
  // CourseSearch drops par-less holes rather than defaulting them to 4, so a
  // short list means we genuinely do not know hole 7.
  const holes = Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4 })).filter(
    (h) => h.holeNumber !== 7,
  );
  assert.equal(courseHolesCoverRound(holes, 18, 1), false);
  // ...but a back-nine round never plays hole 7, so that round IS known.
  assert.equal(courseHolesCoverRound(holes, 9, 10), true);
});

test('courseHolesCoverRound: no hole data at all', () => {
  assert.equal(courseHolesCoverRound(undefined, 18, 1), false);
  assert.equal(courseHolesCoverRound([], 18, 1), false);
});

// ── findSavedScorecard ─────────────────────────────────────

test('findSavedScorecard: matches the course by name, case- and space-insensitively', () => {
  const p = preset({ course_name: 'Riversdale Golf Club' });
  const found = findSavedScorecard({
    courseName: '  riversdale golf club ',
    presets: [p],
    holesPlayed: 18,
    startHole: 1,
  });
  assert.equal(found, p);
});

test('findSavedScorecard: a different course is not a match', () => {
  const found = findSavedScorecard({
    courseName: 'Kingston Heath',
    presets: [preset()],
    holesPlayed: 18,
    startHole: 1,
  });
  assert.equal(found, null);
});

test('findSavedScorecard: course id wins over a renamed course', () => {
  const p = preset({ course_id: 'uuid-1', course_name: 'Riversdale (old name)' });
  const found = findSavedScorecard({
    courseName: 'Riversdale Golf Club',
    courseId: 'uuid-1',
    presets: [p],
    holesPlayed: 18,
    startHole: 1,
  });
  assert.equal(found, p);
});

test('findSavedScorecard: skips a matching course whose scorecard is too short', () => {
  const short = preset({ holes_played: 9, hole_pars: par(9) });
  const full = preset({ hole_pars: par(18, 5) });
  const found = findSavedScorecard({
    courseName: 'Riversdale',
    presets: [short, full],
    holesPlayed: 18,
    startHole: 1,
  });
  assert.equal(found, full);
});

// ── isCourseKnown / startRoundGate ─────────────────────────

test('startRoundGate: no course typed yet', () => {
  assert.deepEqual(
    startRoundGate({ courseName: '   ', presets: [], holesPlayed: 18, startHole: 1 }),
    { allowed: false, reason: 'no-course' },
  );
});

test('startRoundGate: a brand new course with no pars anywhere is blocked', () => {
  assert.deepEqual(
    startRoundGate({
      courseName: 'Some Paddock GC',
      presets: [],
      holesPlayed: 18,
      startHole: 1,
    }),
    { allowed: false, reason: 'unknown-course' },
  );
});

test('startRoundGate: a course we already have hole data for is NOT gated', () => {
  const holes = Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4 }));
  assert.deepEqual(
    startRoundGate({
      courseName: 'Kingston Heath',
      courseHoles: holes,
      presets: [],
      holesPlayed: 18,
      startHole: 1,
    }),
    { allowed: true },
  );
});

test('startRoundGate: a saved scorecard also un-gates the course', () => {
  assert.deepEqual(
    startRoundGate({
      courseName: 'Riversdale',
      presets: [preset()],
      holesPlayed: 9,
      startHole: 10,
    }),
    { allowed: true },
  );
});

test('isCourseKnown: known for the front nine, unknown for the back', () => {
  const front = preset({ holes_played: 9, start_hole: 1, hole_pars: par(9) });
  const base = { courseName: 'Riversdale', presets: [front] } as const;
  assert.equal(isCourseKnown({ ...base, holesPlayed: 9, startHole: 1 }), true);
  assert.equal(isCourseKnown({ ...base, holesPlayed: 9, startHole: 10 }), false);
});

test('isCourseKnownForAnyStart: a back-nine-only scorecard still lets a 9-hole setup continue', () => {
  const back = preset({ holes_played: 9, start_hole: 10, hole_pars: par(9) });
  const base = { courseName: 'Riversdale', presets: [back] } as const;
  // The default selection (front 9) is NOT covered...
  assert.equal(isCourseKnown({ ...base, holesPlayed: 9, startHole: 1 }), false);
  // ...but the golfer can still reach the step where they pick hole 10.
  assert.equal(isCourseKnownForAnyStart({ ...base, holesPlayed: 9, startHole: 1 }), true);
  // An 18-hole round has only one possible start, so there's no reprieve.
  assert.equal(isCourseKnownForAnyStart({ ...base, holesPlayed: 18, startHole: 1 }), false);
});

// ── resolveRoundHoles ──────────────────────────────────────

test('resolveRoundHoles: the saved scorecard overrides the API pars', () => {
  const apiHoles = Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4 }));
  const holes = resolveRoundHoles({
    courseName: 'Riversdale',
    courseHoles: apiHoles,
    presets: [preset({ hole_pars: par(18, 3) })],
    holesPlayed: 18,
    startHole: 1,
  });
  assert.equal(holes?.length, 18);
  assert.deepEqual(holes?.[0], { holeNumber: 1, par: 3 });
});

test('resolveRoundHoles: a back-nine preset maps its pars onto holes 10..18', () => {
  const holes = resolveRoundHoles({
    courseName: 'Riversdale',
    presets: [preset({ holes_played: 9, start_hole: 10, hole_pars: [3, 4, 5, 4, 4, 3, 5, 4, 4] })],
    holesPlayed: 9,
    startHole: 10,
  });
  assert.deepEqual(holes?.[0], { holeNumber: 10, par: 3 });
  assert.deepEqual(holes?.[8], { holeNumber: 18, par: 4 });
});

test('resolveRoundHoles: falls back to the API hole data, then to nothing', () => {
  const apiHoles = [{ holeNumber: 1, par: 5 }];
  assert.deepEqual(
    resolveRoundHoles({
      courseName: 'Kingston Heath',
      courseHoles: apiHoles,
      presets: [],
      holesPlayed: 18,
      startHole: 1,
    }),
    apiHoles,
  );
  assert.equal(
    resolveRoundHoles({
      courseName: 'Kingston Heath',
      presets: [],
      holesPlayed: 18,
      startHole: 1,
    }),
    undefined,
  );
});

// ── recentSetups ───────────────────────────────────────────

test('recentSetups: most recently used first, capped', () => {
  const rows = [
    preset({ course_name: 'A', last_used_at: '2026-01-01T00:00:00Z' }),
    preset({ course_name: 'B', last_used_at: '2026-07-01T00:00:00Z' }),
    preset({ course_name: 'C', last_used_at: '2026-03-01T00:00:00Z' }),
  ];
  assert.deepEqual(
    recentSetups(rows).map((p) => p.course_name),
    ['B', 'C', 'A'],
  );
  assert.deepEqual(
    recentSetups(rows, 2).map((p) => p.course_name),
    ['B', 'C'],
  );
});

test('recentSetups: undated rows keep their order behind the dated ones', () => {
  const rows = [
    preset({ course_name: 'A' }),
    preset({ course_name: 'B', last_used_at: '2026-07-01T00:00:00Z' }),
    preset({ course_name: 'C' }),
  ];
  assert.deepEqual(
    recentSetups(rows).map((p) => p.course_name),
    ['B', 'A', 'C'],
  );
});
