/**
 * Tests for redeem-code.
 *
 * Run from clippar_app/ :
 *
 *   deno test --allow-env --no-check=remote --node-modules-dir=none \
 *     supabase/functions/redeem-code/index.test.ts
 *
 * Add --allow-read to additionally run the check that migration 018 still
 * carries the atomic guard these tests assume (it self-skips without it).
 *
 * Network-free. No Supabase, no Postgres: the handler is built through
 * createHandler() with a fake client, and the module reads no environment at
 * import (the real client is constructed lazily) so nothing needs stubbing.
 *
 * WHAT CAN AND CANNOT BE TESTED HERE
 * Postgres does the actual arbitration between two concurrent redemptions, and
 * that cannot be unit tested without a database — same limitation the shared
 * limiter's tests call out. So the concurrency test below models the migration's
 * WHERE-clause guard exactly and asserts the property that IS the function's
 * responsibility: it consumes a code with ONE guarded call and never with a
 * read-then-write of its own, so interleaving anywhere else cannot produce two
 * winners. The `migration 018` test keeps the modelled guard honest by checking
 * the real SQL still says what the model says.
 */
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { createHandler, type RedeemClient } from './index.ts';
import {
  bytesToCode,
  CODE_LENGTH,
  formatCodeForDisplay,
  hashCode,
  isWellFormedCode,
  normalizeCode,
} from './codeFormat.ts';

const USER = 'user-aaaa-bbbb';
const OTHER_USER = 'user-cccc-dddd';
const PEPPER = 'test-pepper-not-a-real-secret';
const CODE = '4T7Q9XKM2WRBJ5NH';

// ─────────────────────────────────────────────────────────────────────────────
// A fake service client that models migration 018 closely enough to be useful
// ─────────────────────────────────────────────────────────────────────────────

interface FakeCode {
  id: string;
  code_hash: string;
  grant_type: string;
  max_uses: number;
  use_count: number;
  revoked_at: string | null;
  expires_at: string | null;
}

interface FakeOptions {
  /** null → every Authorization header resolves to no user (bad JWT). */
  user?: string | null;
  codes?: FakeCode[];
  /** Force the limiter to refuse the Nth consume call (1-based). */
  refuseLimitOnCall?: number;
  /** Make the redeem_code RPC fail with a chatty Postgres-style error. */
  redeemError?: { message: string; code?: string; details?: string; hint?: string };
}

function makeFake(opts: FakeOptions = {}) {
  const codes = opts.codes ?? [];
  // user_id -> set of code ids, standing in for user_entitlements.
  const entitlements = new Map<string, Set<string>>();
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  let consumeCalls = 0;

  const client: RedeemClient = {
    auth: {
      getUser: async (_token: string) => ({
        data: { user: opts.user === null ? null : { id: opts.user ?? USER } },
      }),
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      // A real round trip yields to the event loop. Yielding here is what lets
      // two concurrent handler invocations genuinely interleave, so the
      // single-winner assertion below is not an artefact of synchronous code.
      await Promise.resolve();

      if (fn === 'consume_rate_limit') {
        consumeCalls++;
        const refuse = opts.refuseLimitOnCall === consumeCalls;
        return {
          data: [{ allowed: !refuse, current_count: consumeCalls, retry_after_seconds: 900 }],
          error: null,
        };
      }

      if (fn === 'refund_rate_limit') {
        return { data: 0, error: null };
      }

      if (fn === 'redeem_code') {
        if (opts.redeemError) return { data: null, error: opts.redeemError };

        const hash = args.p_code_hash as string;
        const user = args.p_user as string;
        const now = Date.now();

        // The migration's atomic step, modelled: one indivisible
        // compare-and-increment over the whole eligibility predicate. No await
        // between the test and the write — that is the point of the SQL.
        const code = codes.find(
          (c) =>
            c.code_hash === hash &&
            c.use_count < c.max_uses &&
            c.revoked_at === null &&
            (c.expires_at === null || Date.parse(c.expires_at) > now),
        );

        if (code) {
          code.use_count += 1;
          const held = entitlements.get(user) ?? new Set<string>();
          held.add(code.id);
          entitlements.set(user, held);
          return {
            data: [{ status: 'granted', grant_type: code.grant_type, code_id: code.id }],
            error: null,
          };
        }

        // The replay branch: same user, same code, still entitled.
        const replay = codes.find(
          (c) => c.code_hash === hash && c.revoked_at === null && entitlements.get(user)?.has(c.id),
        );
        if (replay) {
          return {
            data: [{ status: 'already_granted', grant_type: replay.grant_type, code_id: replay.id }],
            error: null,
          };
        }

        return { data: [{ status: 'unavailable', grant_type: null, code_id: null }], error: null };
      }

      throw new Error(`unexpected rpc ${fn}`);
    },
  };

  return {
    client,
    rpcCalls,
    entitlements,
    get redeemCalls() {
      return rpcCalls.filter((c) => c.fn === 'redeem_code');
    },
    get refundCalls() {
      return rpcCalls.filter((c) => c.fn === 'refund_rate_limit');
    },
  };
}

function handlerFor(fake: { client: RedeemClient }, pepper: string | null = PEPPER) {
  return createHandler({ client: () => fake.client, pepper: () => pepper });
}

function post(body: unknown, headers: Record<string, string> = { Authorization: 'Bearer tok' }) {
  return new Request('https://example.test/redeem-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function liveCode(): Promise<FakeCode> {
  return {
    id: 'code-1',
    code_hash: await hashCode(CODE, PEPPER),
    grant_type: 'lifetime',
    max_uses: 1,
    use_count: 0,
    revoked_at: null,
    expires_at: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation — the generator and the verifier must agree exactly
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('normalizeCode: the printed form round-trips to the canonical form', () => {
  assertEquals(normalizeCode('CLIP-4T7Q-9XKM-2WRB-J5NH'), CODE);
  assertEquals(normalizeCode(formatCodeForDisplay(CODE)), CODE);
});

Deno.test('normalizeCode: lowercase, spacing and stray punctuation', () => {
  assertEquals(normalizeCode('clip-4t7q-9xkm-2wrb-j5nh'), CODE);
  assertEquals(normalizeCode('  4t7q 9xkm 2wrb j5nh  '), CODE);
  assertEquals(normalizeCode('4T7Q_9XKM.2WRB/J5NH'), CODE);
  // A copy-paste out of Notes can carry a zero-width space; it must not make a
  // valid code read as malformed.
  assertEquals(normalizeCode('4T7Q​9XKM2WRBJ5NH'), CODE);
});

Deno.test('normalizeCode: the I/L/O misreadings map to digits', () => {
  // These are the characters the alphabet deliberately omits, so a user who
  // types one has misread the card and means the digit.
  assertEquals(normalizeCode('IL0O'.repeat(4)), '1100'.repeat(4));
  assertEquals(normalizeCode('il0o'.repeat(4)), '1100'.repeat(4));
  // Same code typed with an l for a 1 still redeems.
  assertEquals(normalizeCode('4T7Q9XKM2WRBJ5NH'.replace('5', 'S')), '4T7Q9XKM2WRBJSNH');
  assertEquals(normalizeCode('CLIP-1T7Q-9XKM-2WRB-J5NH'), '1T7Q9XKM2WRBJ5NH');
  assertEquals(normalizeCode('CLIP-IT7Q-9XKM-2WRB-J5NH'), '1T7Q9XKM2WRBJ5NH');
});

Deno.test('normalizeCode: the prefix is matched in its MAPPED spelling', () => {
  // CLIP contains an L and an I, so by the time the prefix is stripped it reads
  // C11P. A user who mistypes the prefix itself still gets through.
  assertEquals(normalizeCode('C11P-4T7Q-9XKM-2WRB-J5NH'), CODE);
  assertEquals(normalizeCode('CL1P-4T7Q-9XKM-2WRB-J5NH'), CODE);
  // And a real code that merely BEGINS with C11P is 16 characters, not 20, so
  // the length guard leaves it alone.
  const looksLikePrefix = 'C11P9XKM2WRBJ5NH';
  assertEquals(normalizeCode(looksLikePrefix), looksLikePrefix);
  assert(isWellFormedCode(normalizeCode(looksLikePrefix)));
});

Deno.test('isWellFormedCode: length and alphabet', () => {
  assert(isWellFormedCode(CODE));
  assert(!isWellFormedCode(''));
  assert(!isWellFormedCode(CODE.slice(0, 15)));
  assert(!isWellFormedCode(CODE + 'X'));
  // U is not in the alphabet.
  assert(!isWellFormedCode('U'.repeat(CODE_LENGTH)));
});

Deno.test('bytesToCode: 10 bytes become 16 in-alphabet symbols, no modulo bias', () => {
  assertEquals(bytesToCode(new Uint8Array(10)), '0'.repeat(16));
  assertEquals(bytesToCode(new Uint8Array(10).fill(0xff)), 'Z'.repeat(16));
  const code = bytesToCode(new Uint8Array([0x00, 0x44, 0x32, 0x14, 0xc7, 0x42, 0x54, 0xb6, 0x35, 0xcf]));
  assertEquals(code.length, CODE_LENGTH);
  assert(isWellFormedCode(code));
});

Deno.test('hashCode: deterministic, pepper-dependent, and refuses an empty pepper', async () => {
  const a = await hashCode(CODE, PEPPER);
  const b = await hashCode(CODE, PEPPER);
  assertEquals(a, b);
  assertEquals(a.length, 64); // SHA-256 as hex
  assert(a !== (await hashCode(CODE, 'a different pepper')));
  assert(a !== (await hashCode('4T7Q9XKM2WRBJ5NJ', PEPPER)));
  // A silent fallback here would reduce every stored digest to a plain,
  // brute-forceable SHA-256 while looking perfectly healthy.
  await assertRejects(() => hashCode(CODE, ''), Error, 'REDEMPTION_CODE_PEPPER');
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('no Authorization header → 401 unauthorized, and no DB work', async () => {
  const fake = makeFake();
  const res = await handlerFor(fake)(post({ code: CODE }, {}));
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { ok: false, error: 'unauthorized' });
  assertEquals(fake.rpcCalls.length, 0);
});

Deno.test('a token that does not resolve to a user → 401 unauthorized', async () => {
  const fake = makeFake({ user: null });
  const res = await handlerFor(fake)(post({ code: CODE }));
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { ok: false, error: 'unauthorized' });
  assertEquals(fake.rpcCalls.length, 0);
});

Deno.test('the granted user comes from the JWT, NEVER from the body', async () => {
  // The single most important property of this endpoint. A body-supplied id
  // would let anyone spend a code they hold on any account they choose.
  const code = await liveCode();
  const fake = makeFake({ codes: [code], user: USER });
  const res = await handlerFor(fake)(
    post({ code: CODE, user_id: OTHER_USER, userId: OTHER_USER, p_user: OTHER_USER }),
  );
  assertEquals(res.status, 200);
  assertEquals(fake.redeemCalls[0].args.p_user, USER);
  assert(fake.entitlements.get(USER)?.has('code-1'));
  assertEquals(fake.entitlements.get(OTHER_USER), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed input — rejected before any database round trip
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('malformed input is rejected with no DB round trip at all', async () => {
  const cases: unknown[] = [
    {},                          // no code
    { code: 12345 },             // not a string
    { code: null },
    { code: '' },
    { code: 'CLIP-TOO-SHORT' },
    { code: 'CLIP-4T7Q-9XKM-2WRB-J5NH-EXTRA' },
    { code: 'UUUU-UUUU-UUUU-UUUU' }, // every character outside the alphabet
    { code: '!!!!' },
  ];
  for (const body of cases) {
    const fake = makeFake();
    const res = await handlerFor(fake)(post(body));
    assertEquals(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assertEquals(await res.json(), { ok: false, error: 'malformed' });
    // No lookup AND no rate-limit consumption: junk must not be able to burn a
    // real user's redemption budget.
    assertEquals(fake.rpcCalls.length, 0, `expected no RPC for ${JSON.stringify(body)}`);
  }
});

Deno.test('a body that is not JSON at all → malformed', async () => {
  const fake = makeFake();
  const res = await handlerFor(fake)(post('not json at all'));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { ok: false, error: 'malformed' });
  assertEquals(fake.rpcCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// The happy path, the replay, and the single-use guarantee
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('a live code grants lifetime Pro, hashed and normalised', async () => {
  const code = await liveCode();
  const fake = makeFake({ codes: [code] });
  // Deliberately the printed form, lowercase, to prove the hash is taken over
  // the NORMALISED value and not the raw string.
  const res = await handlerFor(fake)(post({ code: 'clip-4t7q-9xkm-2wrb-j5nh' }));

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, grant: 'lifetime' });
  assertEquals(fake.redeemCalls.length, 1);
  assertEquals(fake.redeemCalls[0].args.p_code_hash, await hashCode(CODE, PEPPER));
  // The plaintext must never travel to the database.
  assertEquals(JSON.stringify(fake.redeemCalls[0].args).includes(CODE), false);
});

Deno.test('the same user replaying the same code gets success, not an error', async () => {
  const code = await liveCode();
  const fake = makeFake({ codes: [code] });
  const handler = handlerFor(fake);

  const first = await handler(post({ code: CODE }));
  assertEquals(await first.json(), { ok: true, grant: 'lifetime' });

  const second = await handler(post({ code: CODE }));
  assertEquals(second.status, 200);
  assertEquals(await second.json(), { ok: true, grant: 'lifetime', alreadyOwned: true });
  // Still consumed exactly once.
  assertEquals(code.use_count, 1);
});

Deno.test('a code already spent by SOMEONE ELSE reads as invalid, not "used"', async () => {
  const code = await liveCode();
  const fake = makeFake({ codes: [code] });
  await handlerFor(fake)(post({ code: CODE }));

  // Same fake store, different authenticated user.
  const attacker = makeFake({ codes: [code], user: OTHER_USER });
  const res = await handlerFor(attacker)(post({ code: CODE }));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { ok: false, error: 'invalid' });
});

Deno.test('revoked and expired codes are indistinguishable from "no such code"', async () => {
  const revoked = { ...(await liveCode()), id: 'code-revoked', revoked_at: new Date().toISOString() };
  const expired = {
    ...(await liveCode()),
    id: 'code-expired',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  };
  for (const code of [revoked, expired]) {
    const fake = makeFake({ codes: [code] });
    const res = await handlerFor(fake)(post({ code: CODE }));
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { ok: false, error: 'invalid' });
  }
  // And a code that simply does not exist gives the identical answer.
  const empty = makeFake({ codes: [] });
  const res = await handlerFor(empty)(post({ code: CODE }));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { ok: false, error: 'invalid' });
});

Deno.test('two concurrent redemptions of one code produce exactly ONE winner', async () => {
  // The guard lives in the single UPDATE in migration 018; here the fake store
  // models that same predicate as one indivisible compare-and-increment. What
  // this actually proves about the function is the property that makes the SQL
  // guard sufficient: it consumes with ONE guarded call and never with a
  // read-then-write of its own, so the interleaving that happens across every
  // other await (auth, three rate-limit round trips, the hash) cannot produce a
  // second winner.
  const code = await liveCode();
  const a = makeFake({ codes: [code], user: USER });
  const b = makeFake({ codes: [code], user: OTHER_USER }); // shares the same `code` object

  const [resA, resB] = await Promise.all([
    handlerFor(a)(post({ code: CODE })),
    handlerFor(b)(post({ code: CODE })),
  ]);

  const bodies = [await resA.json(), await resB.json()];
  const winners = bodies.filter((x) => x.ok === true);
  const losers = bodies.filter((x) => x.ok === false);
  assertEquals(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(bodies)}`);
  assertEquals(losers.length, 1);
  assertEquals(losers[0].error, 'invalid');
  assertEquals(code.use_count, 1);
  // One guarded call each — no SELECT-then-UPDATE anywhere in the function.
  assertEquals(a.redeemCalls.length, 1);
  assertEquals(b.redeemCalls.length, 1);
});

Deno.test('a spent multi-use code stops at max_uses', async () => {
  const code = { ...(await liveCode()), max_uses: 2 };
  const fake1 = makeFake({ codes: [code], user: USER });
  const fake2 = makeFake({ codes: [code], user: OTHER_USER });
  const fake3 = makeFake({ codes: [code], user: 'user-third' });

  assertEquals((await handlerFor(fake1)(post({ code: CODE }))).status, 200);
  assertEquals((await handlerFor(fake2)(post({ code: CODE }))).status, 200);
  const third = await handlerFor(fake3)(post({ code: CODE }));
  assertEquals(third.status, 400);
  assertEquals(await third.json(), { ok: false, error: 'invalid' });
  assertEquals(code.use_count, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting: charged on a wrong guess, handed back on a right one
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('all three buckets are charged before the code is ever looked up', async () => {
  const fake = makeFake({ codes: [] });
  await handlerFor(fake)(post({ code: CODE }));

  const order = fake.rpcCalls.map((c) => c.fn);
  const buckets = fake.rpcCalls
    .filter((c) => c.fn === 'consume_rate_limit')
    .map((c) => c.args.p_bucket);
  assertEquals(buckets, ['redeem-code:user', 'redeem-code:ip', 'redeem-code:global']);
  assert(
    order.indexOf('consume_rate_limit') < order.indexOf('redeem_code'),
    'the budget must be charged before the lookup, not after',
  );
});

Deno.test('an over-budget caller is refused before reaching the codes table', async () => {
  const code = await liveCode();
  const fake = makeFake({ codes: [code], refuseLimitOnCall: 1 });
  const res = await handlerFor(fake)(post({ code: CODE }));

  assertEquals(res.status, 429);
  assertEquals(await res.json(), { ok: false, error: 'rate_limited', retryAfterSeconds: 900 });
  assertEquals(res.headers.get('Retry-After'), '900');
  assertEquals(fake.redeemCalls.length, 0, 'a refused caller must not reach redeem_code');
  // And the code is untouched.
  assertEquals(code.use_count, 0);
});

Deno.test('a wrong guess KEEPS its charge; a correct code gets it back', async () => {
  const wrong = makeFake({ codes: [] });
  await handlerFor(wrong)(post({ code: CODE }));
  assertEquals(wrong.refundCalls.length, 0, 'a wrong guess must burn the budget');

  const right = makeFake({ codes: [await liveCode()] });
  await handlerFor(right)(post({ code: CODE }));
  assertEquals(
    right.refundCalls.map((c) => c.args.p_bucket),
    ['redeem-code:user', 'redeem-code:ip', 'redeem-code:global'],
  );
});

Deno.test('a replay is a correct code too, so it is refunded', async () => {
  const fake = makeFake({ codes: [await liveCode()] });
  const handler = handlerFor(fake);
  await handler(post({ code: CODE }));
  const before = fake.refundCalls.length;
  await handler(post({ code: CODE }));
  assertEquals(fake.refundCalls.length, before + 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Nothing about the database ever reaches the caller
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('a Postgres error never appears in the response body', async () => {
  // A real PostgREST error object: message, code, details and hint, any of
  // which would hand a caller the schema of the table holding every code.
  const redeemError = {
    message: 'duplicate key value violates unique constraint "user_entitlements_user_id_key"',
    code: '23505',
    details: 'Key (user_id, entitlement, source, source_id)=(user-aaaa-bbbb, pro, …) already exists.',
    hint: 'Perhaps you meant public.redemption_codes.code_hash',
  };
  const fake = makeFake({ codes: [await liveCode()], redeemError });
  const res = await handlerFor(fake)(post({ code: CODE }));

  assertEquals(res.status, 500);
  const text = await res.text();
  assertEquals(text, JSON.stringify({ ok: false, error: 'server' }));
  for (const leak of [
    'duplicate key',
    '23505',
    'user_entitlements',
    'redemption_codes',
    'code_hash',
    'constraint',
    'Key (',
  ]) {
    assertEquals(text.includes(leak), false, `response leaked "${leak}"`);
  }
});

Deno.test('a thrown client error is also swallowed into `server`', async () => {
  const fake = makeFake({ codes: [] });
  const exploding: RedeemClient = {
    auth: fake.client.auth,
    // The limiter answers normally; only the redemption blows up, with a
    // message naming the actual database host.
    rpc: (fn, args) => {
      if (fn !== 'redeem_code') return fake.client.rpc(fn, args);
      throw new Error('connection to server at "db.xdefwnqyjffgclzqmvax.supabase.co" failed');
    },
  };
  const res = await createHandler({ client: () => exploding, pepper: () => PEPPER })(
    post({ code: CODE }),
  );
  assertEquals(res.status, 500);
  const text = await res.text();
  assertEquals(text, JSON.stringify({ ok: false, error: 'server' }));
  assertEquals(text.includes('supabase.co'), false);
});

Deno.test('an unavailable limiter fails CLOSED, not open', async () => {
  // The shared limiter defaults to fail-open so an outage cannot take the
  // product down. Wrong trade here: if nothing is counting, nothing bounds
  // guessing, and the prize is a permanent subscription. Refusing for a few
  // minutes is the cheaper failure.
  const code = await liveCode();
  const fake = makeFake({ codes: [code] });
  const brokenLimiter: RedeemClient = {
    auth: fake.client.auth,
    rpc: (fn, args) => {
      if (fn === 'consume_rate_limit') throw new Error('function consume_rate_limit does not exist');
      return fake.client.rpc(fn, args);
    },
  };
  const res = await createHandler({ client: () => brokenLimiter, pepper: () => PEPPER })(
    post({ code: CODE }),
  );
  assertEquals(res.status, 429);
  assertEquals((await res.json()).error, 'rate_limited');
  assertEquals(fake.redeemCalls.length, 0, 'an uncountable attempt must not reach the codes table');
  assertEquals(code.use_count, 0);
});

Deno.test('a missing pepper fails closed as `server`, and says nothing about why', async () => {
  const fake = makeFake({ codes: [await liveCode()] });
  const res = await handlerFor(fake, null)(post({ code: CODE }));
  assertEquals(res.status, 500);
  const text = await res.text();
  assertEquals(text, JSON.stringify({ ok: false, error: 'server' }));
  assertEquals(text.includes('PEPPER'), false);
  assertEquals(fake.redeemCalls.length, 0);
});

Deno.test('a non-POST method never reaches the database', async () => {
  const fake = makeFake({ codes: [await liveCode()] });
  const res = await handlerFor(fake)(
    new Request('https://example.test/redeem-code', { method: 'GET' }),
  );
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { ok: false, error: 'malformed' });
  assertEquals(fake.rpcCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// The modelled guard vs. the real migration
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION_URL = new URL('../../migrations/018_redemption_codes.sql', import.meta.url);
const canReadMigration =
  (await Deno.permissions.query({ name: 'read', path: MIGRATION_URL })).state === 'granted';

Deno.test({
  name: 'migration 018 still consumes the code in ONE guarded UPDATE',
  // Self-skips under the documented `--allow-env` command; run with
  // --allow-read to include it.
  ignore: !canReadMigration,
  fn: async () => {
    const sql = await Deno.readTextFile(MIGRATION_URL);
    const update = sql.slice(sql.indexOf('UPDATE public.redemption_codes'));
    const guard = update.slice(0, update.indexOf('RETURNING'));

    // Every eligibility condition must be inside the WHERE of the same
    // statement that increments use_count. Any one of them hoisted into an IF
    // above reintroduces the read-then-write race.
    for (const clause of [
      'c.code_hash = p_code_hash',
      'c.use_count < c.max_uses',
      'c.revoked_at IS NULL',
      'c.expires_at IS NULL OR c.expires_at > now()',
    ]) {
      assert(guard.includes(clause), `the atomic guard no longer contains: ${clause}`);
    }

    // And the privileged surfaces stay service-role only.
    assert(sql.includes('REVOKE ALL ON public.redemption_codes FROM anon, authenticated;'));
    assert(sql.includes('REVOKE ALL ON public.user_entitlements FROM anon, authenticated;'));
    assert(sql.includes('GRANT EXECUTE ON FUNCTION public.redeem_code(TEXT, UUID) TO service_role;'));
    assert(!/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*user_entitlements[^;]*authenticated/i.test(sql));
  },
});
