/**
 * ############################################################################
 * ## SUPERSEDED — DO NOT DEPLOY. Replaced by App Store Offer Codes.         ##
 * ############################################################################
 *
 * Henry's call, 2026-08-04. Guideline 3.1.1 prohibits unlocking features with
 * a developer's own license keys; redemption now runs through StoreKit's code
 * sheet (app/profile/redeem.tsx → lib/iap presentCodeRedemption) against
 * one-time-use Offer Codes generated in App Store Connect.
 *
 * This function has never been deployed, and the table it reads
 * (migrations/018_redemption_codes.sql) has never been applied. Deploying it
 * would 500 on every call for want of `redemption_codes`. Kept for the rate
 * limiting and constant-time comparison patterns, which are reusable.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import { clientIp } from '../_shared/rateLimit.ts';
import { hashCode, isWellFormedCode, normalizeCode } from './codeFormat.ts';
import { chargeRedeemLimits, refundCharges } from './limits.ts';

/**
 * redeem-code — turn a printed code into lifetime Clippar Pro.
 *
 * POST /functions/v1/redeem-code   { "code": "CLIP-4T7Q-9XKM-2WRB-J5NH" }
 * Deploy with verify_jwt ON (the default): the caller must be signed in.
 *
 * THE ONE RULE THIS FUNCTION EXISTS TO ENFORCE
 * The user who gets the grant is the user in the VERIFIED JWT. There is no
 * user id in the request body, there is no code path that reads one, and there
 * must never be. `p_user` below comes from supabase.auth.getUser(token) — a
 * server-side verification against the auth server — and from nowhere else. If
 * a user id were ever accepted from the body, this endpoint would let anyone
 * spend a code they hold on any account they like, which is both a griefing
 * tool and the obvious way to launder a stolen code.
 *
 * Shape of the work, in order, and the order is load-bearing:
 *   1. authenticate  — who is this? (401 before anything else happens)
 *   2. validate      — is this even a code? (400 malformed, no DB round trip,
 *                      and no garbage in the rate-limit buckets)
 *   3. rate limit    — charge the budget BEFORE the lookup, so an over-budget
 *                      caller never reaches the codes table (429)
 *   4. hash + redeem — one atomic RPC (see 018_redemption_codes.sql)
 *   5. refund        — success hands its rate-limit units back; a wrong guess
 *                      keeps its charge
 *
 * Related: ../_shared/rateLimit.ts (the limiter this reuses), ./limits.ts (the
 * numbers and the arithmetic behind them), ./codeFormat.ts (the single shared
 * normalise + hash).
 */

/** Supabase Function secret. Never in the database, never in a migration. */
const PEPPER_ENV = 'REDEMPTION_CODE_PEPPER';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders, ...extraHeaders },
  });

/**
 * The wire vocabulary, in one place, because the client switches on these exact
 * strings (CODES_CONTRACT.md). A typo here is a client bug that only shows up
 * on the unhappy path.
 */
export const RESPONSES = {
  granted: (grant: string) => json({ ok: true, grant }, 200),
  alreadyOwned: (grant: string) => json({ ok: true, grant, alreadyOwned: true }, 200),
  /**
   * ONE answer for four different failures: no such code, already spent by
   * someone else, revoked, expired.
   *
   * Merging them costs a little clarity — a user whose code expired is told the
   * same thing as a user who typo'd — and buys the removal of an oracle. Be
   * honest about the size of that purchase: against 80-bit codes the oracle is
   * weak, because an attacker who cannot find a code at all gains almost
   * nothing from learning that the string they invented is "not found" rather
   * than "used". The real reasons are the ones that survive a change of
   * circumstances: it removes a probe that tells a holder of a leaked list
   * which entries are still live and worth selling; it keeps support answers
   * from being derivable by anyone; and it means the security of this endpoint
   * does not silently depend on the code length, so a future decision to print
   * shorter cards, or to let someone choose a memorable code, cannot quietly
   * turn a weak oracle into a real one.
   */
  invalid: () => json({ ok: false, error: 'invalid' }, 400),
  malformed: () => json({ ok: false, error: 'malformed' }, 400),
  unauthorized: () => json({ ok: false, error: 'unauthorized' }, 401),
  rateLimited: (retryAfterSeconds: number) =>
    json({ ok: false, error: 'rate_limited', retryAfterSeconds }, 429, {
      // A 429 without Retry-After makes well-behaved clients guess, and they
      // guess in lockstep. Same reasoning as _shared/rateLimit.ts.
      'Retry-After': String(Math.max(1, retryAfterSeconds)),
    }),
  /**
   * Never carries the cause. Postgres error strings name tables, columns,
   * constraints and sometimes the offending values — a `redeem_code` failure
   * could hand a caller the schema of the table holding every code, and a
   * unique-violation message can echo the input back. Log it, return a
   * constant. This is the standard set by stripe-webhook/index.ts:134-138,
   * where the signature-verification catch swallows Stripe's message for the
   * same reason.
   */
  server: () => json({ ok: false, error: 'server' }, 500),
};

/** The slice of the service client this function uses. Also the test seam. */
export interface RedeemClient {
  auth: {
    getUser(token: string): Promise<{ data: { user: { id: string } | null } }>;
  };
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export interface RedeemDeps {
  /** Lazy so importing this module never constructs a client or reads env. */
  client: () => RedeemClient;
  /** Lazy for the same reason; returns null when the secret is not configured. */
  pepper: () => string | null;
}

/** Shape returned by the redeem_code RPC (a one-row set). */
interface RedeemRow {
  status?: string;
  grant_type?: string | null;
  code_id?: string | null;
}

export function createHandler(deps: RedeemDeps): (req: Request) => Promise<Response> {
  return async function handleRedeem(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    try {
      // The app only ever POSTs. Answered with the client's own `malformed`
      // branch rather than a bespoke string so the client switch stays total.
      if (req.method !== 'POST') return RESPONSES.malformed();

      const client = deps.client();

      // ── 1. WHO IS THIS ────────────────────────────────────────────────────
      // getUser() verifies the token against the auth server; it is not a local
      // decode. Authentication comes first because the per-user rate limit is
      // the strongest bucket and it needs a real subject — limiting before
      // authenticating would key every caller to the same counter, exactly as
      // _shared/rateLimit.ts warns.
      const token = req.headers.get('Authorization')?.replace('Bearer ', '');
      if (!token) return RESPONSES.unauthorized();

      const { data: { user } } = await client.auth.getUser(token);
      if (!user) return RESPONSES.unauthorized();

      // THE LINE. Everything downstream grants to this id and only this id.
      const userId = user.id;

      // ── 2. IS IT EVEN A CODE ──────────────────────────────────────────────
      // Before any database work: a malformed body costs one JSON parse and
      // nothing else. It also keeps junk out of the rate-limit buckets, so
      // pasting nonsense cannot burn a legitimate user's redemption budget.
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return RESPONSES.malformed();
      }
      const rawCode = (body as { code?: unknown } | null)?.code;
      if (typeof rawCode !== 'string') return RESPONSES.malformed();

      const normalized = normalizeCode(rawCode);
      if (!isWellFormedCode(normalized)) return RESPONSES.malformed();

      // ── 3. BUDGET ─────────────────────────────────────────────────────────
      const outcome = await chargeRedeemLimits(
        client as unknown as SupabaseClient,
        userId,
        clientIp(req),
      );
      if (outcome.refusedRetryAfterSeconds !== null) {
        return RESPONSES.rateLimited(outcome.refusedRetryAfterSeconds);
      }

      // ── 4. HASH AND REDEEM ────────────────────────────────────────────────
      const pepper = deps.pepper();
      if (!pepper) {
        // Fail closed and loudly. Hashing without the pepper would produce
        // digests that match nothing (so every real code reads as invalid) and,
        // worse, would look like a working endpoint.
        console.error(`[redeem-code] ${PEPPER_ENV} is not configured; refusing to redeem`);
        return RESPONSES.server();
      }

      const codeHash = await hashCode(normalized, pepper);

      // Comparison happens on the HASH, inside the atomic UPDATE in
      // public.redeem_code. The plaintext never travels to Postgres and is
      // never string-compared anywhere.
      const { data, error } = await client.rpc('redeem_code', {
        p_code_hash: codeHash,
        p_user: userId,
      });

      if (error) {
        console.error(
          '[redeem-code] redeem_code RPC failed:',
          error instanceof Error ? error.message : JSON.stringify(error),
        );
        return RESPONSES.server();
      }

      const row = (Array.isArray(data) ? data[0] : data) as RedeemRow | null | undefined;
      const status = row?.status ?? 'unavailable';
      const grant = row?.grant_type ?? 'lifetime';

      // ── 5. SETTLE THE BUDGET ──────────────────────────────────────────────
      // Only a correct code gets its units back. 'unavailable' keeps its
      // charge — that is the guess this whole budget exists to meter.
      if (status === 'granted' || status === 'already_granted') {
        await refundCharges(client as unknown as SupabaseClient, outcome.charged);
      }

      if (status === 'granted') return RESPONSES.granted(grant);
      if (status === 'already_granted') return RESPONSES.alreadyOwned(grant);
      return RESPONSES.invalid();
    } catch (err) {
      // Catch-all. Anything that reaches here is a bug or an outage, and either
      // way the caller learns only that it was ours.
      console.error('[redeem-code] unhandled error:', err instanceof Error ? err.message : err);
      return RESPONSES.server();
    }
  };
}

/**
 * The real service-role client, built on first use rather than at import.
 *
 * Lazy on purpose: constructing it at module scope makes the module unusable
 * without SUPABASE_URL in the environment, which would force every test run to
 * carry stub credentials just to import the file.
 */
let cachedClient: RedeemClient | null = null;
function serviceClient(): RedeemClient {
  if (!cachedClient) {
    cachedClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    ) as unknown as RedeemClient;
  }
  return cachedClient;
}

export const handler = createHandler({
  client: serviceClient,
  pepper: () => Deno.env.get(PEPPER_ENV) ?? null,
});

// Only bind the server when run as the entry module (Edge Function runtime).
// Importing this file from a test must not start a listener.
if (import.meta.main) {
  Deno.serve(handler);
}
