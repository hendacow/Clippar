/**
 * Tests for the search-courses proxy's input guards.
 *
 *   SUPABASE_URL=https://test.supabase.co SUPABASE_SERVICE_ROLE_KEY=test-key \
 *     deno test --allow-env supabase/functions/search-courses/index.test.ts
 *
 * This function is the only thing between the public internet and a paid API
 * key with a 300/day account-wide quota, so everything a caller sends is
 * checked before it can cost us a request.
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseCourseId, parseQuery, safeRegionCode } from './index.ts';

Deno.test('parseQuery accepts a real search term', () => {
  assertEquals(parseQuery('Royal Melbourne'), 'Royal Melbourne');
  assertEquals(parseQuery('  Pebble  '), 'Pebble');
});

Deno.test('parseQuery rejects anything that would waste vendor quota', () => {
  assertEquals(parseQuery('a'), null); // below the client's own 2-char floor
  assertEquals(parseQuery(''), null);
  assertEquals(parseQuery('   '), null);
  assertEquals(parseQuery('x'.repeat(81)), null);
  assertEquals(parseQuery(null), null);
  assertEquals(parseQuery(12), null);
  assertEquals(parseQuery({ toString: () => 'Royal' }), null);
});

Deno.test('safeRegionCode rejects appended query parameters', () => {
  // The attack: `country=AU&limit=10000` appends parameters to a request that
  // carries our GOLF_COURSE_API_KEY.
  assertEquals(safeRegionCode('AU&limit=10000', 'AU'), 'AU');
  assertEquals(safeRegionCode('AU#', 'AU'), 'AU');
  assertEquals(safeRegionCode('../admin', 'AU'), 'AU');
  assertEquals(safeRegionCode(null, 'AU'), 'AU');
  assertEquals(safeRegionCode('au', 'XX'), 'AU');
});

Deno.test('parseCourseId only accepts a numeric vendor id', () => {
  assertEquals(parseCourseId('24200'), '24200');
  assertEquals(parseCourseId(24200), '24200');
  // Path traversal / endpoint re-pointing on our credentials.
  assertEquals(parseCourseId('../search?search_query=x'), null);
  assertEquals(parseCourseId('24200/../../admin'), null);
  assertEquals(parseCourseId('24200?x=1'), null);
  assertEquals(parseCourseId(''), null);
  assertEquals(parseCourseId(null), null);
  assertEquals(parseCourseId('0'.repeat(21)), null);
});
