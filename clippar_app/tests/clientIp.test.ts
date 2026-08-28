/**
 * The rate-limit subject invariants, runnable by `npm run verify`.
 *
 * WHY THIS FILE EXISTS, since it duplicates part of
 * `supabase/functions/_shared/rateLimit.test.ts`:
 *
 * That suite runs under Deno, in its own CI job, and Deno is not installable in
 * every environment this repo gets worked on from — including the one where a
 * change to `canonicalIp` was written, verified against `npm run verify`, pushed,
 * and turned the edge-function job red on a stale assertion. `npm run verify` is
 * the gate this project's own guide names as the definition of done, and it could
 * not see the file being changed.
 *
 * So this pins the invariants that actually matter, in the runner everyone has.
 * The Deno suite stays the authority on the edge-function runtime; this is the
 * early warning. If the two ever disagree, the Deno one is right and this one is
 * stale — fix it here rather than deleting it, because a check you cannot run
 * locally is a check you find out about from CI.
 *
 * The property under test is BUCKET IDENTITY: one host must map to exactly one
 * rate-limit subject, whichever way its address is written. On `get-shared-reel`
 * — the one endpoint with no login — the cap is per subject, so every extra
 * spelling is another full allowance and another primary-key row in
 * `api_rate_limit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Loaded through a COMPUTED specifier on purpose. `rateLimit.ts` is a Deno
// module — it carries a `https://esm.sh/...` type import that this project's
// tsconfig cannot resolve, and a literal `.ts` specifier trips
// allowImportingTsExtensions. A computed one is opaque to tsc and resolved
// normally by tsx at runtime, which is exactly the split we want: the Deno job
// type-checks that file properly, this file only exercises its behaviour.
type RateLimitModule = {
  canonicalIp: (v: string) => string | null;
  clientIp: (req: Request) => string;
};

// Loaded inside each test rather than at module scope: tsx transpiles this file
// to CommonJS, which has no top-level await.
let cached: RateLimitModule | undefined;
async function load(): Promise<RateLimitModule> {
  if (!cached) {
    cached = (await import(
      new URL('../supabase/functions/_shared/rateLimit.ts', import.meta.url).href
    )) as RateLimitModule;
  }
  return cached;
}

const req = (headers: Record<string, string>) =>
  new Request('https://example.test/', { headers });

test('one host keys exactly one bucket, however its address is spelled', async () => {
  const { clientIp } = await load();
  const bucketFor = (ip: string) => clientIp(req({ 'cf-connecting-ip': ip }));
  // IPv4: leading zeros are a rendering choice (and are read as octal by some
  // stacks), so they must normalise rather than fork the bucket.
  const four = bucketFor('1.2.3.4');
  for (const spelling of ['1.2.3.4', '01.2.3.4', '001.2.3.4']) {
    assert.equal(bucketFor(spelling), four, `${spelling} must key the same bucket`);
  }

  // IPv6: case, zero-padding, and — the one an earlier version missed — WHERE the
  // caller put `::`. Compression is a rendering choice too.
  const six = bucketFor('2001:db8::1');
  for (
    const spelling of [
      '2001:DB8::1',
      '2001:0db8::0001',
      '2001:db8:0::1',
      '2001:db8::0:1',
      '2001:db8:0:0::1',
      '2001:db8:0:0:0::1',
      '2001:db8:0:0:0:0:0:1',
    ]
  ) {
    assert.equal(bucketFor(spelling), six, `${spelling} must key the same bucket`);
  }

  // A seven-group zero run is the worst case for the above.
  const loop = bucketFor('::1');
  for (const spelling of ['0::1', '0:0::1', '::0:1', '::0:0:1', '0:0:0:0:0:0:0:1']) {
    assert.equal(bucketFor(spelling), loop, `${spelling} must key the same bucket`);
  }

  // A v4-mapped address IS that v4 address. Without folding them together the
  // IPv4 normalisation above is bypassable by routing the same host through the
  // IPv6 branch.
  for (
    const spelling of ['::ffff:1.2.3.4', '0:0:0:0:0:ffff:1.2.3.4', '::ffff:102:304']
  ) {
    assert.equal(bucketFor(spelling), four, `${spelling} must key the same bucket`);
  }
});

test('a wrapped address keys its own host, not the shared fallback', async () => {
  const { clientIp } = await load();
  const bucketFor = (ip: string) => clientIp(req({ 'cf-connecting-ip': ip }));
  // `unknown` is ONE bucket for the entire internet. Sending a format the parser
  // does not handle there is all-or-nothing across every caller at once: an
  // ingress that appends a source port would put every visitor on a single
  // 120/hour pool, and one popular share link would 429 the world.
  assert.equal(bucketFor('203.0.113.9:41234'), bucketFor('203.0.113.9'));
  assert.equal(bucketFor('[2001:db8::1]:443'), bucketFor('2001:db8::1'));
  assert.equal(bucketFor('[2001:db8::1]'), bucketFor('2001:db8::1'));
  assert.equal(bucketFor('fe80::1%eth0'), bucketFor('fe80::1'));
  // Percent-encoded zone. The strip pattern was once `%25?`, which requires a
  // literal `2` — it handled this one and not the plain form above.
  assert.equal(bucketFor('fe80::1%25eth0'), bucketFor('fe80::1'));
});

test('anything that is not an address shares the fallback bucket', async () => {
  const { canonicalIp, clientIp } = await load();
  const bucketFor = (ip: string) => clientIp(req({ 'cf-connecting-ip': ip }));
  // Structure, not alphabet. An earlier character-class check accepted every one
  // of these, so each was a free extra allowance.
  for (
    const notAnAddress of [
      'dead',
      'cafe.babe',
      '....',
      '0',
      '1.2.3.4.',
      '.1.2.3.4',
      '256.1.2.3',
      '1.2.3',
      'f'.repeat(40),
      'a'.repeat(4096),
      "'; DROP TABLE api_rate_limit; --",
    ]
  ) {
    assert.equal(canonicalIp(notAnAddress), null, `${notAnAddress} is not an address`);
    assert.equal(bucketFor(notAnAddress), 'unknown', `${notAnAddress} must share the fallback`);
  }

  for (
    const malformed of [
      '2001:db8:::1',
      '2001:db8::1::2',
      '2001:zzzz::1',
      '1:2:3:4:5:6:7:8:9',
      '12345::1',
    ]
  ) {
    assert.equal(canonicalIp(malformed), null, `${malformed} is not an address`);
  }
});

test('header precedence and X-Forwarded-For handling are unchanged', async () => {
  const { clientIp } = await load();
  // These four are the behaviour the canonicalisation work must not have moved.
  // The X-Forwarded-For rule is the opposite of the usual advice, on measured
  // evidence recorded in rateLimit.ts — do not "correct" it without reading that.
  assert.equal(
    clientIp(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' })),
    '203.0.113.9',
  );
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' })), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '  203.0.113.9 ,, 10.0.0.1  ' })), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-real-ip': '198.51.100.8' })), '198.51.100.8');
  assert.equal(clientIp(req({})), 'unknown');

  // One caller crossing different internal hops is still one bucket — the
  // property the original last-entry implementation broke.
  assert.equal(
    clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })),
    clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.99' })),
  );

  // Junk in a higher-precedence header must not shadow a good value below it.
  assert.equal(
    clientIp(req({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '203.0.113.9' })),
    '203.0.113.9',
  );
});
