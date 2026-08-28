/**
 * Tests for the shared rate limiter.
 *
 *   deno test supabase/functions/_shared/rateLimit.test.ts
 *
 * Network-free. The Postgres side (the atomic INSERT ... ON CONFLICT in
 * migration 016) cannot be unit tested without a database, so what is covered
 * here is the part that runs in the function and the part most likely to be got
 * wrong: which value we trust out of X-Forwarded-For, and what we do when the
 * limiter itself is unavailable.
 */
import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  canonicalIp,
  clientIp,
  consumeRateLimit,
  enforceRateLimit,
  RATE_LIMITS,
  type RateLimitRule,
} from './rateLimit.ts';

// deno-lint-ignore no-explicit-any
type AnyClient = any;

function reqWith(headers: Record<string, string>): Request {
  return new Request('https://example.test/', { headers });
}

/** A stub client whose rpc() returns whatever the test wants. */
function stubClient(handler: (fn: string, args: unknown) => unknown): AnyClient {
  return {
    rpc(fn: string, args: unknown) {
      const result = handler(fn, args);
      // The real client returns a thenable that also exposes .then for the
      // fire-and-forget sweep call.
      return Promise.resolve(result);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// clientIp — the header-trust question
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('clientIp PREFERS cf-connecting-ip over X-Forwarded-For (precedence only)', () => {
  // NAME CHANGED 2026-08-26. This test used to be called "...which the gateway
  // sets and a caller cannot forge", which claimed a security property it does
  // not check and structurally cannot: un-forgeability is a fact about what
  // Cloudflare does to inbound headers, and no unit test can observe that. All
  // this asserts is PRECEDENCE — given both headers, the first one wins.
  //
  // The distinction matters because a test name is read as a guarantee. See the
  // honest-scope note in clientIp() for the one request that would settle
  // forgeability.
  const req = reqWith({
    'cf-connecting-ip': '203.0.113.9',
    'x-forwarded-for': 'attacker-supplied, 10.0.0.1',
  });
  assertEquals(clientIp(req), '203.0.113.9');
});

Deno.test('clientIp falls back to the FIRST X-Forwarded-For entry', () => {
  // Deliberately the opposite of the usual advice, and the usual advice is right
  // in the usual case: where a proxy APPENDS to a caller-supplied header, entry
  // [0] is whatever the attacker typed. This function used to take the LAST
  // entry for exactly that reason.
  //
  // Measured against the live dev project, that was wrong here. Supabase's
  // gateway OVERWRITES X-Forwarded-For rather than appending: a request sent
  // with `X-Forwarded-For: 198.51.100.77` arrived with the same three entries as
  // one sent without it, caller still at index 0 — the spoof was discarded. So
  // [0] is gateway-asserted and [1..] are Supabase's own internal hops.
  //
  // Taking the last entry keyed every limit on Supabase's own load balancer:
  // 133 requests from one machine fragmented across 14 buckets and the real
  // client address never appeared once.
  assertEquals(clientIp(reqWith({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' })), '203.0.113.9');
});

Deno.test('clientIp handles a single entry and padding', () => {
  assertEquals(clientIp(reqWith({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  assertEquals(clientIp(reqWith({ 'x-forwarded-for': '  203.0.113.9 ,, 10.0.0.1  ' })), '203.0.113.9');
});

Deno.test('two requests from one client land on ONE bucket', () => {
  // The property that actually matters, and the one the old implementation
  // broke: the same caller crossing different internal hops must still be
  // counted together, or the cap is silently multiplied by the size of the
  // proxy fleet.
  const a = clientIp(reqWith({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));
  const b = clientIp(reqWith({ 'x-forwarded-for': '203.0.113.9, 10.0.0.99' }));
  assertEquals(a, b);
});

Deno.test('clientIp falls back through x-real-ip, then to a constant', () => {
  assertEquals(clientIp(reqWith({ 'x-real-ip': '198.51.100.8' })), '198.51.100.8');
  // Everyone unidentifiable shares one bucket. Stricter than letting an
  // unidentifiable caller through unmetered.
  assertEquals(clientIp(reqWith({})), 'unknown');
});

Deno.test('clientIp never returns a value that is not address-shaped', () => {
  // Whatever this returns becomes `api_rate_limit.subject`, which is unbounded
  // TEXT inside the primary key. Without a shape test an anonymous caller on
  // get-shared-reel writes one row per distinct header value, of any length —
  // storage amplification against our own table, and separate from whether the
  // header can be spoofed past the gateway at all.
  //
  // Each of these must fall THROUGH to the shared bucket rather than becoming
  // one of its own.
  for (
    const junk of [
      'a'.repeat(4096),
      'not-an-ip',
      "'; DROP TABLE api_rate_limit; --",
      '203.0.113.9 <script>',
      '  ',
    ]
  ) {
    assertEquals(clientIp(reqWith({ 'cf-connecting-ip': junk })), 'unknown');
    assertEquals(clientIp(reqWith({ 'x-forwarded-for': junk })), 'unknown');
    assertEquals(clientIp(reqWith({ 'x-real-ip': junk })), 'unknown');
  }

  // A junk value must not shadow a good one further down the chain — otherwise
  // the guard would hand every caller sending junk the same bucket as every
  // caller sending nothing, which is a different bug.
  assertEquals(
    clientIp(reqWith({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '203.0.113.9' })),
    '203.0.113.9',
  );

  // Real values of every shape are keyed exactly as before — this guard must be
  // invisible to legitimate traffic.
  assertEquals(clientIp(reqWith({ 'cf-connecting-ip': '203.0.113.9' })), '203.0.113.9');
  assertEquals(
    clientIp(reqWith({ 'cf-connecting-ip': '2001:db8::8a2e:370:7334' })),
    '2001:db8::8a2e:370:7334',
  );
  assertEquals(
    clientIp(reqWith({ 'cf-connecting-ip': '::ffff:203.0.113.9' })),
    '::ffff:203.0.113.9',
  );
});

Deno.test('one host cannot spell itself into more than one rate-limit bucket', () => {
  // The cap on get-shared-reel is per SUBJECT, so anything that lets one host
  // render its own address two ways multiplies the cap by two. This needs no
  // forged ingress — it is not a different address, just a different spelling of
  // the caller's own, which is why a character-class check ("does it look
  // addressy?") is not enough and the value has to be CANONICALISED.
  const bucketFor = (ip: string) => clientIp(reqWith({ 'cf-connecting-ip': ip }));
  const one = bucketFor('1.2.3.4');
  for (const spelling of ['1.2.3.4', '01.2.3.4', '001.2.3.4']) {
    assertEquals(bucketFor(spelling), one, `${spelling} must key the same bucket`);
  }
  // Same for IPv6 case and zero-padding.
  const six = bucketFor('2001:db8::1');
  for (const spelling of ['2001:DB8::1', '2001:0db8::0001', '2001:db8::1']) {
    assertEquals(bucketFor(spelling), six, `${spelling} must key the same bucket`);
  }

  // Structure, not character class: these were all accepted by the earlier
  // /^[0-9A-Fa-f:.]+$/ test and each one was a free extra bucket.
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
      'ffffffffffffffffffffffffffffffffffffffff',
    ]
  ) {
    assertEquals(canonicalIp(notAnAddress), null, `${notAnAddress} is not an address`);
    assertEquals(bucketFor(notAnAddress), 'unknown', `${notAnAddress} must share the fallback bucket`);
  }

  // Malformed IPv6 must not slip through on the colon branch either.
  for (const bad of ['2001:db8:::1', '2001:db8::1::2', '2001:zzzz::1', '1:2:3:4:5:6:7:8:9', '12345::1']) {
    assertEquals(canonicalIp(bad), null, `${bad} is not an address`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// consumeRateLimit — reading the RPC result
// ─────────────────────────────────────────────────────────────────────────────

const RULE: RateLimitRule = { bucket: 'test', limit: 3, windowSeconds: 60 };

Deno.test('consumeRateLimit passes the rule through to the RPC', async () => {
  let seen: Record<string, unknown> | null = null;
  const client = stubClient((fn, args) => {
    if (fn === 'consume_rate_limit') seen = args as Record<string, unknown>;
    return { data: [{ allowed: true, current_count: 1, retry_after_seconds: 59 }], error: null };
  });

  await consumeRateLimit(client, RULE, 'user-1');

  assertEquals(seen!.p_bucket, 'test');
  assertEquals(seen!.p_subject, 'user-1');
  assertEquals(seen!.p_limit, 3);
  assertEquals(seen!.p_window_seconds, 60);
});

Deno.test('consumeRateLimit reads a single-row result set', async () => {
  const client = stubClient(() => ({
    data: [{ allowed: false, current_count: 4, retry_after_seconds: 12 }],
    error: null,
  }));
  const d = await consumeRateLimit(client, RULE, 'user-1');
  assertEquals(d.allowed, false);
  assertEquals(d.count, 4);
  assertEquals(d.retryAfterSeconds, 12);
});

Deno.test('consumeRateLimit fails OPEN by default when the limiter errors', async () => {
  // A limiter outage must not take the product down. If Postgres is unreachable
  // most of these endpoints cannot do their work anyway.
  const client = stubClient(() => ({ data: null, error: new Error('connection refused') }));
  const d = await consumeRateLimit(client, RULE, 'user-1');
  assertEquals(d.allowed, true);
});

Deno.test('consumeRateLimit fails CLOSED when the rule says so', async () => {
  // Reserved for endpoints where one call spends real money — an unmetered flood
  // against Stripe is worse than a few minutes of refused checkouts.
  const client = stubClient(() => ({ data: null, error: new Error('connection refused') }));
  const d = await consumeRateLimit(client, { ...RULE, onError: 'closed' }, 'user-1');
  assertEquals(d.allowed, false);
});

Deno.test('consumeRateLimit treats an empty result set as a limiter failure', async () => {
  const client = stubClient(() => ({ data: [], error: null }));
  const d = await consumeRateLimit(client, RULE, 'user-1');
  // Fails open under the default rule, but must not report allowed on nonsense
  // data by accident — the count stays 0 rather than being read off undefined.
  assertEquals(d.allowed, true);
  assertEquals(d.count, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// enforceRateLimit — the response
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('enforceRateLimit returns null while under the limit', async () => {
  const client = stubClient(() => ({
    data: [{ allowed: true, current_count: 1, retry_after_seconds: 59 }],
    error: null,
  }));
  assertEquals(await enforceRateLimit(client, RULE, 'user-1'), null);
});

Deno.test('enforceRateLimit returns 429 with Retry-After when over', async () => {
  const client = stubClient(() => ({
    data: [{ allowed: false, current_count: 4, retry_after_seconds: 42 }],
    error: null,
  }));
  const res = await enforceRateLimit(client, RULE, 'user-1');
  assert(res !== null);
  assertEquals(res!.status, 429);
  // Spec 7.5 asks for 429 WITH Retry-After; without it, well-behaved clients back
  // off by guessing and end up retrying in lockstep.
  assertEquals(res!.headers.get('Retry-After'), '42');
});

Deno.test('Retry-After is never zero', async () => {
  // A zero would tell a client to retry immediately, turning a rate limit into a
  // busy loop.
  const client = stubClient(() => ({
    data: [{ allowed: false, current_count: 9, retry_after_seconds: 0 }],
    error: null,
  }));
  const res = await enforceRateLimit(client, RULE, 'user-1');
  assertEquals(res!.headers.get('Retry-After'), '1');
});

Deno.test('the 429 body does not disclose the limit or the current count', async () => {
  // Telling a prober exactly how much room they have left is free reconnaissance.
  const client = stubClient(() => ({
    data: [{ allowed: false, current_count: 4, retry_after_seconds: 42 }],
    error: null,
  }));
  const res = await enforceRateLimit(client, RULE, 'user-1');
  const body = await res!.text();
  assert(!body.includes('4'), `body leaked the count: ${body}`);
  assert(!body.includes('3'), `body leaked the limit: ${body}`);
});

Deno.test('enforceRateLimit preserves caller headers such as CORS', async () => {
  // get-shared-reel is called from a browser. A 429 without the CORS headers
  // surfaces in the page as an opaque network error rather than a clean message.
  const client = stubClient(() => ({
    data: [{ allowed: false, current_count: 4, retry_after_seconds: 42 }],
    error: null,
  }));
  const res = await enforceRateLimit(client, RULE, 'ip', {
    'Access-Control-Allow-Origin': 'https://clippargolf.com',
  });
  assertEquals(res!.headers.get('Access-Control-Allow-Origin'), 'https://clippargolf.com');
});

// ─────────────────────────────────────────────────────────────────────────────
// The configured limits
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('every configured rule is sane', () => {
  for (const [name, rule] of Object.entries(RATE_LIMITS)) {
    assert(rule.limit > 0, `${name}: limit must be positive`);
    assert(rule.windowSeconds > 0, `${name}: window must be positive`);
    assert(rule.bucket.length > 0, `${name}: bucket must be named`);
  }
});

Deno.test('bucket names are unique across rules', () => {
  // A duplicate bucket would silently merge two endpoints' counters, so the
  // stricter limit would apply to both and the looser one would appear broken.
  const buckets = Object.values(RATE_LIMITS).map((r) => r.bucket);
  assertEquals(new Set(buckets).size, buckets.length);
});

Deno.test('the payment endpoint is the one that fails closed', () => {
  // If this ever flips to fail-open, an attacker who can stress the database gets
  // an unmetered path to our Stripe account.
  assertEquals(RATE_LIMITS.createPaymentIntent.onError, 'closed');
});

Deno.test('the public endpoint is keyed by IP, not user', () => {
  // A reminder in test form: get-shared-reel has no JWT, so its bucket name must
  // reflect that it is IP-keyed and can never be merged with a user-keyed one.
  assert(RATE_LIMITS.getSharedReel.bucket.includes('ip'));
});
