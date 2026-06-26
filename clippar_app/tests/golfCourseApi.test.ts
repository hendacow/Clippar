import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCountryCode,
  normalizeAndRankCourses,
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
