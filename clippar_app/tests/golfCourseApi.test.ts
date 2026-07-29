import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCountryCode,
  normalizeAndRankCourses,
  parseTeeSets,
} from '../lib/golfCourseApi';

// Regression tests for the golf-course search bug: GolfCourseAPI's /v1/search
// ignores any country filter, so Australian courses were buried under US
// results. The fix reads country from `location.country` and ranks the target
// country first. These lock down both halves so they can't silently regress.

test('normalizeCountryCode: full names → 2-letter codes', () => {
  assert.equal(normalizeCountryCode('Australia'), 'AU');
  assert.equal(normalizeCountryCode('United States'), 'US');
  assert.equal(normalizeCountryCode('United Kingdom'), 'GB');
  assert.equal(normalizeCountryCode('au'), 'AU');
  assert.equal(normalizeCountryCode('US'), 'US');
});

test('normalizeCountryCode: empty/invalid → undefined', () => {
  assert.equal(normalizeCountryCode(''), undefined);
  assert.equal(normalizeCountryCode('   '), undefined);
  assert.equal(normalizeCountryCode(null), undefined);
  assert.equal(normalizeCountryCode(undefined), undefined);
});

// Mirrors the real /v1/search shape: country only at location.country, no
// top-level country_code. Order is the API's US-first ordering.
const RAW = [
  { id: 24200, club_name: 'Royal Melbourne', location: { city: 'Long Grove', state: 'IL', country: 'United States' } },
  { id: 5066, club_name: 'Royal Melbourne Gc', location: { city: 'Melbourne', state: 'VIC', country: 'Australia' } },
  { id: 999, club_name: 'St Andrews', location: { city: 'St Andrews' } }, // ungeocoded, no country
  { id: 5266, club_name: 'Royal Melbourne Gc', location: { city: 'Melbourne', state: 'VIC', country: 'Australia' } },
];

test('normalizeAndRankCourses: AU courses rank first, ungeocoded second, rest last', () => {
  const ranked = normalizeAndRankCourses(RAW, 'AU');
  assert.deepEqual(
    ranked.map((c) => c.id),
    ['5066', '5266', '999', '24200'],
  );
  // The real Australian Royal Melbourne now beats the US one.
  assert.equal(ranked[0].country, 'AU');
  assert.equal(ranked[ranked.length - 1].country, 'US');
});

test('normalizeAndRankCourses: country read from location.country, not the old top-level fields', () => {
  const [au] = normalizeAndRankCourses(
    [{ id: 1, club_name: 'X', location: { country: 'Australia' } }],
    'AU',
  );
  // Pre-fix this collapsed to the 'AU' fallback for *every* row regardless of
  // actual country — so a US row would also have read 'AU'. Prove it's real.
  assert.equal(au.country, 'AU');
  const [us] = normalizeAndRankCourses(
    [{ id: 2, club_name: 'Y', location: { country: 'United States' } }],
    'AU',
  );
  assert.equal(us.country, 'US');
});

test('normalizeAndRankCourses: stable within a country group (preserves API relevance)', () => {
  const sameCountry = [
    { id: 'a', club_name: 'A', location: { country: 'Australia' } },
    { id: 'b', club_name: 'B', location: { country: 'Australia' } },
    { id: 'c', club_name: 'C', location: { country: 'Australia' } },
  ];
  const ranked = normalizeAndRankCourses(sameCountry, 'AU');
  assert.deepEqual(ranked.map((c) => c.id), ['a', 'b', 'c']);
});

test('normalizeAndRankCourses: empty input → empty array', () => {
  assert.deepEqual(normalizeAndRankCourses([], 'AU'), []);
  assert.deepEqual(normalizeAndRankCourses(undefined as any, 'AU'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// parseTeeSets — the bug that made every par read as 4
// ─────────────────────────────────────────────────────────────────────────────
//
// Fixtures below are the ACTUAL shape returned by GolfCourseAPI /v1/search for
// Royal Queensland Golf Club, captured 2026-07-29. Verified live:
//   tees is an OBJECT keyed by gender, not an array
//   holes carry only {par, yardage} — there is no hole_number field at all
//   handicap (stroke index) is null for all 18 holes on this course

test('parseTeeSets reads the gender-keyed tees OBJECT', () => {
  // The original code did `for (const t of raw.tees)`. On an object that throws
  // "not iterable", the caller's catch swallowed it, and getGolfCourseDetailLive
  // returned null EVERY time — so the app never once saw real hole data and
  // every hole fell through to the par-4 default downstream.
  const tees = parseTeeSets({
    tees: {
      male: [{ tee_name: 'Blue', total_meters: 6000, holes: [{ par: 5, yardage: 500 }] }],
      female: [{ tee_name: 'Red', total_meters: 5200, holes: [{ par: 4, yardage: 400 }] }],
    },
  });
  assert.equal(tees.length, 2);
  assert.deepEqual(tees.map((t) => t.name).sort(), ['Blue', 'Red']);
  assert.equal(tees.find((t) => t.name === 'Blue')!.gender, 'male');
});

test('parseTeeSets numbers holes positionally', () => {
  // No hole_number in the payload — it must come from the index. Leaving it
  // undefined meant the "which hole am I on" lookup never matched.
  const [tee] = parseTeeSets({
    tees: { male: [{ tee_name: 'Blue', holes: [{ par: 4 }, { par: 3 }, { par: 5 }] }] },
  });
  assert.deepEqual(tee.holes.map((h) => h.number), [1, 2, 3]);
  assert.deepEqual(tee.holes.map((h) => h.par), [4, 3, 5]);
});

test('parseTeeSets does NOT invent a par when the API omits it', () => {
  // The whole point. `par ?? 4` here is what put a wrong number on a scorecard
  // and then burned it into an exported video.
  const [tee] = parseTeeSets({
    tees: { male: [{ tee_name: 'Blue', holes: [{ par: 5 }, { yardage: 150 }] }] },
  });
  assert.equal(tee.holes[0].par, 5);
  assert.equal(tee.holes[1].par, undefined);
});

test('parseTeeSets keeps a missing stroke index missing', () => {
  // Royal Queensland returns handicap: null for all 18. Inventing one would
  // silently reorder shot allocation.
  const [tee] = parseTeeSets({
    tees: { male: [{ tee_name: 'Blue', holes: [{ par: 4, handicap: null }] }] },
  });
  assert.equal(tee.holes[0].handicap, undefined);
});

test('parseTeeSets converts yardage to metres for an AU scorecard', () => {
  const [tee] = parseTeeSets({
    tees: { male: [{ tee_name: 'Blue', holes: [{ par: 4, yardage: 400 }] }] },
  });
  assert.equal(tee.holes[0].metres, 366); // 400 * 0.9144
});

test('parseTeeSets still accepts the array shape if the vendor reverts', () => {
  const tees = parseTeeSets({ tees: [{ tee_name: 'Blue', holes: [{ par: 4 }] }] });
  assert.equal(tees.length, 1);
  assert.equal(tees[0].holes[0].number, 1);
});

test('parseTeeSets survives junk without throwing', () => {
  // It used to throw on the real payload, so this is not hypothetical.
  assert.deepEqual(parseTeeSets({}), []);
  assert.deepEqual(parseTeeSets({ tees: null }), []);
  assert.deepEqual(parseTeeSets({ tees: { male: 'nope' } }), []);
});
