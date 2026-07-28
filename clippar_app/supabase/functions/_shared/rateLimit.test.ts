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

Deno.test('clientIp takes the LAST X-Forwarded-For entry, not the first', () => {
  // This is the whole point. A caller can send any X-Forwarded-For it likes; the
  // proxy APPENDS the address it actually observed. So the leftmost entry is
  // attacker-chosen and the rightmost is the only one we did not let them pick.
  // Reading [0] — the obvious choice, and what most examples do — would hand an
  // attacker a brand new counter bucket per request simply by varying a header,
  // which is the same as having no rate limit at all.
  const req = reqWith({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
  assertEquals(clientIp(req), '203.0.113.9');
});

Deno.test('clientIp handles a single entry', () => {
  assertEquals(clientIp(reqWith({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
});

Deno.test('clientIp tolerates padding and empty segments', () => {
  assertEquals(
    clientIp(reqWith({ 'x-forwarded-for': '  1.2.3.4 ,, 203.0.113.9  ' })),
    '203.0.113.9',
  );
});

Deno.test('clientIp is not fooled by a spoofed value appended by the caller', () => {
  // A caller trying to look like a different client on every request still lands
  // on the same bucket, because their own entries are all to the LEFT of the one
  // the proxy added.
  const a = clientIp(reqWith({ 'x-forwarded-for': 'fake-1, 203.0.113.9' }));
  const b = clientIp(reqWith({ 'x-forwarded-for': 'fake-2, 203.0.113.9' }));
  const c = clientIp(reqWith({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.9' }));
  assertEquals(a, b);
  assertEquals(b, c);
});

Deno.test('clientIp falls back through known proxy headers, then to a constant', () => {
  assertEquals(clientIp(reqWith({ 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
  assertEquals(clientIp(reqWith({ 'x-real-ip': '198.51.100.8' })), '198.51.100.8');
  // Everyone unidentifiable shares one bucket. That is intentional: it is a
  // stricter outcome than letting an unidentifiable caller through unmetered.
  assertEquals(clientIp(reqWith({})), 'unknown');
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
