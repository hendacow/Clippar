import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'lib', 'golfCourseApi.ts');
const PROXY = join(
  HERE,
  '..',
  'supabase',
  'functions',
  'search-courses',
  'index.ts',
);

const client = readFileSync(CLIENT, 'utf8');
const proxy = readFileSync(PROXY, 'utf8');

/**
 * SEC-008. lib/golfCourseApi.ts used to fetch api.golfcourseapi.com directly
 * from the device with `Authorization: Key ${EXPO_PUBLIC_GOLF_COURSE_API_KEY}`.
 * Expo inlines EXPO_PUBLIC_* into the JS bundle at build time, so the key was
 * recoverable from the shipped IPA, and the vendor's free tier is 300
 * requests/day ACCOUNT-WIDE — a curl loop with the extracted key takes course
 * search offline for every user, every day, at no cost. No Clippar server was
 * in the path, so no rate limiter could see it.
 *
 * These assert the shape of the fix rather than its behaviour, because the hole
 * IS the shape: a credential in the bundle and a request that skips our
 * backend. Source-level assertions are the only thing that catches a
 * reintroduction — a behavioural test would pass just as happily against a
 * direct call.
 */

// Strip comments so the explanatory prose in both files (which necessarily
// names the old key and host) doesn't satisfy or trip these checks.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const clientCode = stripComments(client);
const proxyCode = stripComments(proxy);

test('the app bundle carries no GolfCourseAPI credential', () => {
  assert.ok(
    !clientCode.includes('EXPO_PUBLIC_GOLF_COURSE_API_KEY'),
    'lib/golfCourseApi.ts must not read EXPO_PUBLIC_GOLF_COURSE_API_KEY — ' +
      'Expo inlines it into the shipped bundle',
  );
  assert.ok(
    !/Authorization/.test(clientCode),
    'lib/golfCourseApi.ts must not set an Authorization header; the key lives ' +
      'in the search-courses edge function',
  );
});

test('the app does not call the third-party golf API directly', () => {
  assert.ok(
    !clientCode.includes('api.golfcourseapi.com'),
    'lib/golfCourseApi.ts must not reference the vendor host — every call goes ' +
      'through the search-courses edge function so it can be rate limited',
  );
  assert.ok(
    !/\bfetch\s*\(/.test(clientCode),
    'lib/golfCourseApi.ts must not fetch() anything directly',
  );
});

test('both entry points route through the search-courses edge function', () => {
  // The failure mode this guards: a helper that exists but nothing calls. Both
  // exported network functions must reach the proxy.
  assert.ok(
    clientCode.includes("supabase.functions.invoke('search-courses'"),
    'the proxy helper must actually invoke the edge function',
  );
  const search = clientCode.slice(clientCode.indexOf('export async function searchGolfCoursesLive'));
  const detail = clientCode.slice(clientCode.indexOf('export async function getGolfCourseDetailLive'));
  assert.ok(
    search.includes('invokeSearchCourses'),
    'searchGolfCoursesLive must go through invokeSearchCourses',
  );
  assert.ok(
    detail.includes('invokeSearchCourses'),
    'getGolfCourseDetailLive must go through invokeSearchCourses',
  );
});

test('the edge proxy reads the key from a server-side secret and meters it', () => {
  assert.ok(
    proxyCode.includes("Deno.env.get('GOLF_COURSE_API_KEY')"),
    'search-courses must read the key from the Supabase secret',
  );
  assert.ok(
    !proxyCode.includes('EXPO_PUBLIC'),
    'search-courses must never read an EXPO_PUBLIC_* value — those are client-visible',
  );
  // A limiter that is imported but never called is not a limiter.
  assert.ok(
    /enforceRateLimits\(\s*supabase,\s*PER_CALLER/.test(proxyCode),
    'search-courses must enforce the per-caller rate limit',
  );
  assert.ok(
    /consumeRateLimit\(\s*supabase,\s*UPSTREAM_BUDGET/.test(proxyCode),
    'search-courses must spend from the project-wide upstream budget before ' +
      'calling the vendor',
  );
  assert.ok(
    proxyCode.includes('AbortSignal.timeout'),
    'every outbound call needs a timeout (spec 7.5)',
  );
});

test('the project-wide upstream budget stays under the vendor free tier', () => {
  const limit = /bucket:\s*'golfcourseapi-upstream',\s*\n?\s*limit:\s*(\d+)/.exec(proxyCode);
  assert.ok(limit, 'upstream budget must declare a numeric limit');
  const value = Number(limit![1]);
  assert.ok(
    value > 0 && value < 300,
    `upstream daily budget ${value} must be below the vendor's 300/day ` +
      'account-wide free tier, or the cap cannot protect the quota',
  );
});
