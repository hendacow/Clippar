// _shared/rateLimit.ts
//
// One rate limiter for every edge function, backed by the atomic
// public.consume_rate_limit() RPC added in migration 016.
//
// Use it like this, immediately after you have established WHO is calling:
//
//   const limited = await enforceRateLimit(supabase, RATE_LIMITS.createShareLink, user.id, corsHeaders);
//   if (limited) return limited;
//
// Order matters. Authenticate first so the counter is keyed to a real account,
// then rate limit, then do the expensive work. Limiting before authentication
// would key every caller to the same subject; doing the work before limiting
// defeats the point.

// Version pinned to match what the functions themselves import. A floating or
// mismatched specifier would pull a second copy of the library into the bundle.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';

export interface RateLimitRule {
  /** Namespace for the counter. Keep it stable — changing it resets everyone's window. */
  bucket: string;
  /** Requests permitted per window, per subject. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * What to do when the limiter itself is broken (DB unreachable, RPC missing).
   *
   * 'open' lets the request through. This is the right default: a limiter outage
   * must not take the product down, and if Postgres is unreachable then most of
   * these endpoints cannot do their job anyway.
   *
   * 'closed' refuses. Reserve it for endpoints where one call spends real money
   * or third-party quota, where letting an unmetered flood through is worse than
   * a few minutes of failed requests.
   */
  onError?: 'open' | 'closed';
}

const DAY = 86_400;
const HOUR = 3_600;
const MINUTE = 60;

/**
 * Every limit in one place so they can be reviewed together rather than hunted
 * for across ten files.
 *
 * The numbers are sized against what a real golfer does, with a wide margin, and
 * then sanity-checked against what one call costs us:
 *
 *   a round is 18 holes, a few clips a hole, and a keen player plays a handful of
 *   rounds a week. Nothing here is a hot path — the app makes these calls at human
 *   speed, on human decisions (tap Share, tap Subscribe, tap Delete account).
 *
 * If a legitimate user ever hits one of these, the limit is wrong, not the user.
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  /**
   * Creating a share link mints a 128-bit token and writes it to the round. A
   * user sharing every hole of every round of a big week is nowhere near 60.
   * Unbounded, this is free unbounded row-writing on someone else's database.
   */
  createShareLink: { bucket: 'create-share-link', limit: 60, windowSeconds: DAY },

  /**
   * Each call reaches Stripe's API. That is a third-party quota we do not control
   * and a bill we do. A user buying a phone mount does this once, maybe three
   * times if a card fails. Ten a day is already generous.
   *
   * fail-CLOSED: this is the endpoint where an unmetered flood costs actual money
   * and could get our Stripe account rate limited or flagged. Refusing checkout
   * for the few minutes the database is down is the cheaper failure.
   */
  createPaymentIntent: { bucket: 'create-payment-intent', limit: 10, windowSeconds: DAY, onError: 'closed' },

  /**
   * Account deletion cascades across auth, database rows and an Apple token
   * revocation call. It is idempotent and self-scoped, so abuse potential is low,
   * but a loop here is a loop against Apple's revocation endpoint on our
   * credentials. Five a day is far beyond any real use.
   */
  deleteAccount: { bucket: 'delete-account', limit: 5, windowSeconds: DAY },

  /**
   * Apple credential linking. Happens at most a couple of times per account in
   * its lifetime; a burst means someone is probing.
   */
  appleLink: { bucket: 'apple-link', limit: 20, windowSeconds: DAY },

  /**
   * THE PUBLIC ONE — no JWT, so this is keyed by client IP, not user id.
   *
   * Each call does a database lookup and mints a signed storage URL. The share
   * tokens are 128-bit random so enumeration was never viable, but nothing
   * currently stops one host pulling this endpoint in a loop, and every call is a
   * query we pay for.
   *
   * Sized for the real sharing pattern: a link goes in a group chat and a dozen
   * mates open it, several of them behind one carrier NAT, some reloading. 120 an
   * hour absorbs that comfortably while ending sustained scraping.
   */
  getSharedReel: { bucket: 'get-shared-reel-ip', limit: 120, windowSeconds: HOUR },

  /**
   * Short burst guard layered UNDER the daily caps above. The daily cap stops
   * sustained abuse; this stops a single-second hammering that would otherwise be
   * spent all at once.
   */
  burst: { bucket: 'burst', limit: 30, windowSeconds: MINUTE },
};

/**
 * The client's IP, for limits that have no authenticated subject.
 *
 * CAREFUL: X-Forwarded-For is a comma-separated list that grows left-to-right as
 * it crosses proxies, and the CLIENT can put anything it likes in the leftmost
 * position. Taking entry [0] — which is the obvious reading, and what most
 * examples do — means an attacker rotates a header value and gets a fresh bucket
 * per request, i.e. no limit at all.
 *
 * The last entry is the one appended by the proxy closest to us, which is the
 * peer address it actually observed. That is the only value here we did not let
 * the caller choose.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown';
}

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/** Consume one unit against a rule. Exposed for callers that want the numbers. */
export async function consumeRateLimit(
  supabase: SupabaseClient,
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitDecision> {
  try {
    const { data, error } = await supabase.rpc('consume_rate_limit', {
      p_bucket: rule.bucket,
      p_subject: subject,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });

    if (error) throw error;

    // The RPC returns a one-row set.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('consume_rate_limit returned no row');

    // Opportunistic housekeeping — roughly 1 call in 200 sweeps expired rows, so
    // the table does not grow forever without needing pg_cron. Deliberately not
    // awaited: the caller should never wait on cleanup.
    if (Math.random() < 0.005) {
      supabase.rpc('sweep_rate_limits', { p_older_than_seconds: 172_800 }).then(
        () => {},
        () => {},
      );
    }

    return {
      allowed: row.allowed === true,
      count: row.current_count ?? 0,
      retryAfterSeconds: row.retry_after_seconds ?? rule.windowSeconds,
    };
  } catch (err) {
    // Log without the subject — that is a user id or an IP, and this line goes to
    // a log we do not want carrying identifiers.
    console.error(`[rateLimit] bucket=${rule.bucket} limiter unavailable:`, err instanceof Error ? err.message : err);
    const failClosed = rule.onError === 'closed';
    return { allowed: !failClosed, count: 0, retryAfterSeconds: failClosed ? 60 : 0 };
  }
}

/**
 * Returns a ready-to-send 429 when the caller is over the limit, or null when the
 * request may proceed.
 *
 * The 429 body says only that a limit was hit and when to retry. It does not say
 * what the limit is or how many calls have been made — that is free reconnaissance
 * for someone probing how much room they have.
 */
export async function enforceRateLimit(
  supabase: SupabaseClient,
  rule: RateLimitRule,
  subject: string,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const decision = await consumeRateLimit(supabase, rule, subject);
  if (decision.allowed) return null;

  return new Response(
    JSON.stringify({ error: 'Too many requests. Please try again later.' }),
    {
      status: 429,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        // Spec 7.5 asks for 429 WITH Retry-After. Without it a client backs off by
        // guessing, and well-behaved clients end up retrying in lockstep.
        'Retry-After': String(Math.max(1, decision.retryAfterSeconds)),
      },
    },
  );
}

/**
 * Apply the per-minute burst guard and a per-endpoint rule together.
 *
 * Two windows because they stop different things: the daily cap bounds total
 * damage, the burst cap bounds how fast that damage can be done. An attacker with
 * a 60/day allowance can still spend all 60 in one second against a cold endpoint
 * unless something says otherwise.
 */
export async function enforceRateLimits(
  supabase: SupabaseClient,
  rule: RateLimitRule,
  subject: string,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const burst = await enforceRateLimit(
    supabase,
    { ...RATE_LIMITS.burst, bucket: `${rule.bucket}:burst`, onError: rule.onError },
    subject,
    headers,
  );
  if (burst) return burst;
  return enforceRateLimit(supabase, rule, subject, headers);
}
