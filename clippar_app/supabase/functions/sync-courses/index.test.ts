/**
 * Tests for the sync-courses input guards.
 *
 *   SUPABASE_URL=https://test.supabase.co SUPABASE_SERVICE_ROLE_KEY=test-key \
 *     deno test --allow-env supabase/functions/sync-courses/index.test.ts
 *
 * Three attacks, all reachable through `course_suggestions` / the `sync_single`
 * body, which are free-form text any signed-in user can write:
 *
 *   1. ILIKE wildcard smuggling. escapeLikePattern escaped `\ % _` but not `*`,
 *      and PostgREST — not Postgres — rewrites `*` to `%` before the pattern is
 *      evaluated. A suggestion named `Royal *` therefore matched a real catalog
 *      row, and approving it took the UPDATE branch of upsertCourse and
 *      overwrote that shared course.
 *   2. Outbound parameter pollution. `body.country` went into the third-party
 *      search URL unencoded, on a request carrying our paid API key.
 *   3. Unvalidated hole_data written to the shared `holes` table, which every
 *      user's scorecard is computed from.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  escapeLikePattern,
  isExactNameMatch,
  parseSuggestedHole,
  safeRegionCode,
} from './index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 1. LIKE/ILIKE metacharacters
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('escapeLikePattern neutralises every wildcard PostgREST honours', () => {
  // `*` is the regression: it used to pass through untouched.
  assertEquals(escapeLikePattern('Royal *'), 'Royal \\*');
  assertEquals(escapeLikePattern('Royal %'), 'Royal \\%');
  assertEquals(escapeLikePattern('Royal _'), 'Royal \\_');
  assertEquals(escapeLikePattern('a\\b'), 'a\\\\b');
  assertEquals(escapeLikePattern('*%_'), '\\*\\%\\_');
});

Deno.test('escapeLikePattern leaves an ordinary course name alone', () => {
  assertEquals(escapeLikePattern('Royal Melbourne Golf Club'), 'Royal Melbourne Golf Club');
});

Deno.test('no unescaped wildcard survives, for any metacharacter', () => {
  for (const meta of ['*', '%', '_']) {
    const escaped = escapeLikePattern(`Royal ${meta}`);
    // Every occurrence of the metacharacter must be immediately preceded by a
    // backslash — i.e. none of them is still acting as a wildcard.
    for (let i = 0; i < escaped.length; i++) {
      if (escaped[i] === meta) {
        assert(
          i > 0 && escaped[i - 1] === '\\',
          `unescaped "${meta}" at ${i} in ${escaped}`,
        );
      }
    }
  }
});

Deno.test('isExactNameMatch backstops the escape: a wildcard row is not accepted', () => {
  // What upsertCourse now does with whatever row the ILIKE returned. Even if a
  // pattern slipped through and matched a different course, this rejects it.
  assert(isExactNameMatch('Royal Melbourne', 'royal melbourne'));
  assert(!isExactNameMatch('Royal Melbourne', 'Royal *'));
  assert(!isExactNameMatch('Royal Melbourne', 'Royal %'));
  assert(!isExactNameMatch('Royal Melbourne', 'Royal'));
  assert(!isExactNameMatch('Royal Melbourne', ''));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Outbound parameter pollution
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('safeRegionCode rejects appended query parameters', () => {
  assertEquals(safeRegionCode('AU&limit=10000', 'AU'), 'AU');
  assertEquals(safeRegionCode('AU#', 'AU'), 'AU');
  assertEquals(safeRegionCode('AU&api_key=x', 'AU'), 'AU');
  assertEquals(safeRegionCode('../../admin', 'AU'), 'AU');
  assertEquals(safeRegionCode({ toString: () => 'AU&x=1' }, 'AU'), 'AU');
  assertEquals(safeRegionCode(null, 'QLD'), 'QLD');
});

Deno.test('safeRegionCode passes real region codes through, uppercased', () => {
  assertEquals(safeRegionCode('au', 'XX'), 'AU');
  assertEquals(safeRegionCode(' nz ', 'XX'), 'NZ');
  assertEquals(safeRegionCode('QLD', 'AU'), 'QLD');
  assertEquals(safeRegionCode('NSW', 'AU'), 'NSW');
});

Deno.test('a polluted region code cannot reach the outbound query string', () => {
  // Mirrors how searchGolfCourseAPI builds its URL, with both guards applied.
  const url = new URL(
    `https://api.golfcourseapi.com/v1/search?search_query=${encodeURIComponent('x')}` +
      `&country_code=${encodeURIComponent(safeRegionCode('AU&limit=10000', 'AU'))}`,
  );
  assertEquals(url.searchParams.get('country_code'), 'AU');
  assertEquals(url.searchParams.get('limit'), null);
  assertEquals([...url.searchParams.keys()].sort(), ['country_code', 'search_query']);
});

Deno.test('encodeURIComponent alone also defuses the injection', () => {
  // Second line of defence: even if safeRegionCode were bypassed, the encoded
  // value stays a single parameter value rather than becoming new parameters.
  const url = new URL(
    `https://api.golfcourseapi.com/v1/search?country_code=${encodeURIComponent('AU&limit=10000')}`,
  );
  assertEquals(url.searchParams.get('country_code'), 'AU&limit=10000');
  assertEquals(url.searchParams.get('limit'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Community-suggested hole data
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('parseSuggestedHole accepts a plausible hole', () => {
  assertEquals(parseSuggestedHole({ holeNumber: 7, par: 4, strokeIndex: 3, lengthMeters: 340 }), {
    hole_number: 7,
    par: 4,
    stroke_index: 3,
    length_meters: 340,
  });
});

Deno.test('parseSuggestedHole drops out-of-range and non-numeric junk', () => {
  assertEquals(parseSuggestedHole({ holeNumber: 1e9, par: 4 }), null);
  assertEquals(parseSuggestedHole({ holeNumber: 0, par: 4 }), null);
  assertEquals(parseSuggestedHole({ holeNumber: 19, par: 4 }), null);
  assertEquals(parseSuggestedHole({ holeNumber: 1, par: -4 }), null);
  assertEquals(parseSuggestedHole({ holeNumber: 1, par: 99 }), null);
  assertEquals(parseSuggestedHole({ holeNumber: '1', par: '4' }), null);
  assertEquals(parseSuggestedHole({ holeNumber: 1.5, par: 4 }), null);
  assertEquals(parseSuggestedHole(null), null);
  assertEquals(parseSuggestedHole('1'), null);
});

Deno.test('parseSuggestedHole nulls implausible optional fields rather than storing them', () => {
  const parsed = parseSuggestedHole({
    holeNumber: 1,
    par: 4,
    strokeIndex: 9999,
    lengthMeters: -50,
  });
  assertEquals(parsed?.stroke_index, null);
  assertEquals(parsed?.length_meters, null);
});
