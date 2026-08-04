// redeem-code/limits.ts
//
// Brute-force budget for redemption, and the refund that keeps the budget
// honest. Built on the shared limiter in ../_shared/rateLimit.ts — same
// `RateLimitRule` shape, same `consume_rate_limit` RPC, same atomic counter
// table from migration 016. Nothing here is a second limiter; it is this
// endpoint's numbers plus one compensating call the shared module has no reason
// to carry.
//
// WHY THE RULES ARE HERE AND NOT IN `RATE_LIMITS`
// `_shared/rateLimit.ts` keeps every limit in one place so they can be reviewed
// together, and these three belong in that list once this feature lands. They
// are parked here for now because these numbers are derived from one specific
// threat model — an 80-bit code space — rather than from "what a golfer does in
// a day" like every entry in RATE_LIMITS, and because the shared file is being
// edited elsewhere in this branch. Folding them in is a mechanical move.

import {
  consumeRateLimit,
  type RateLimitDecision,
  type RateLimitRule,
} from '../_shared/rateLimit.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';

const QUARTER_HOUR = 900;

/**
 * THE ARITHMETIC, so the numbers below are arguable rather than vibes.
 *
 * A code is 16 Crockford base32 symbols = 5 bits each = 2^80 ≈ 1.21e24
 * possibilities, drawn from a CSPRNG. Guessing is a search for ANY live code,
 * not one particular one, so the expected number of attempts is the space
 * divided by the number of codes outstanding. Henry will print codes in tens;
 * take a deliberately pessimistic 1,000 live at once:
 *
 *     1.21e24 / 1000  ≈  1.2e21 attempts expected before the first hit.
 *
 * Against that, the caps below:
 *
 *   per user   20/hour → 1.8e20 user-years, i.e. an attacker with a million
 *                        bot accounts is still looking at ~1.8e14 years.
 *   per IP     60/hour → same order; the point of this one is not the exponent
 *                        but making one host's 20/hour not become 20/hour x
 *                        (however many free accounts they can mint).
 *   global    480/hour → 4.2e6 attempts a year across the entire internet, so
 *                        1.2e21 / 4.2e6 ≈ 2.9e14 years. This is the bucket that
 *                        survives a distributed attempt, where per-user and
 *                        per-IP each look innocent.
 *
 * The exponents are absurd on purpose: the cost of being wrong is a permanent
 * free subscription, and the cost of being generous is nothing, because a real
 * ambassador types one code once. Even the tightest bucket allows five attempts
 * a quarter-hour — enough to fat-finger a printed card repeatedly and still get
 * in, with a wait of at most 15 minutes if they somehow burn it.
 *
 * Windows are a quarter-hour rather than a day so a locked-out human is locked
 * out for minutes, not until tomorrow. The exponents above are unaffected by
 * that choice; only the recovery time is.
 *
 * ALL THREE FAIL CLOSED, which is the unusual choice and the deliberate one.
 * `_shared/rateLimit.ts` defaults to fail-open because a limiter outage must not
 * take the product down — right for sharing a reel, wrong here. If the counter
 * cannot be consulted we cannot bound guessing, and the thing being guessed at
 * is a permanent, unrevoked-by-default subscription. The failure modes are not
 * symmetric: refusing redemptions for the minutes the limiter is broken costs
 * an ambassador one retry, while accepting them unmetered opens the only window
 * in which the arithmetic above stops applying. Same reasoning as
 * RATE_LIMITS.createPaymentIntent, which fails closed because a call spends
 * money. Note the common case is moot anyway — the limiter and the codes table
 * are the same Postgres, so an outage usually takes both — but "the RPC is
 * missing because 016 was not applied" is a real state where the DB answers
 * fine and nothing counts.
 */
export const REDEEM_LIMITS = {
  /**
   * THE STRONGEST SIGNAL. Redemption requires a verified JWT, so unlike most
   * abuse this always has a real account behind it. An attacker who wants more
   * than this budget must mint more accounts, which is a different, noisier and
   * more expensive problem than rotating an IP.
   */
  perUser: {
    bucket: 'redeem-code:user',
    limit: 5,
    windowSeconds: QUARTER_HOUR,
    onError: 'closed',
  } as RateLimitRule,

  /**
   * Catches the cheap way around the per-user bucket: one script, many
   * throwaway accounts, one host. Sized to leave a shared household or a golf
   * club's guest wifi alone — 15 in a quarter-hour is three separate people
   * fumbling their cards at once.
   */
  perIp: {
    bucket: 'redeem-code:ip',
    limit: 15,
    windowSeconds: QUARTER_HOUR,
    onError: 'closed',
  } as RateLimitRule,

  /**
   * The distributed catcher: one counter for the whole endpoint, keyed to a
   * constant. Per-user and per-IP both look innocent when the attempts are
   * spread across a botnet; this one does not care where they came from.
   *
   * 120 a quarter-hour is roughly two orders of magnitude more redemption
   * traffic than this feature will ever legitimately see — the entire scheme is
   * a few hundred printed cards — so if this bucket ever refuses anyone, that
   * IS the alarm.
   */
  global: {
    bucket: 'redeem-code:global',
    limit: 120,
    windowSeconds: QUARTER_HOUR,
    onError: 'closed',
  } as RateLimitRule,
} as const;

/** Subject for the global bucket. Constant by design — one counter for everyone. */
export const GLOBAL_SUBJECT = 'all';

/** One charged bucket, remembered so a successful redemption can hand it back. */
export interface ChargedLimit {
  rule: RateLimitRule;
  subject: string;
}

export interface LimitOutcome {
  /** Non-null when some bucket refused; carries the Retry-After to report. */
  refusedRetryAfterSeconds: number | null;
  /** Everything actually charged, in order, for refundCharges(). */
  charged: ChargedLimit[];
}

/**
 * Charge every bucket in turn and stop at the first refusal.
 *
 * Charging BEFORE the code lookup is what makes this a defence rather than a
 * label: an over-budget caller never reaches the codes table at all. Stopping at
 * the first refusal keeps the compensating refund small and avoids spending
 * three round trips to say no.
 *
 * Order is cheapest-signal-first only in the sense that the per-user bucket is
 * the one that identifies a real attacker soonest.
 */
export async function chargeRedeemLimits(
  supabase: SupabaseClient,
  userId: string,
  ip: string,
): Promise<LimitOutcome> {
  const toCharge: ChargedLimit[] = [
    { rule: REDEEM_LIMITS.perUser, subject: userId },
    { rule: REDEEM_LIMITS.perIp, subject: ip },
    { rule: REDEEM_LIMITS.global, subject: GLOBAL_SUBJECT },
  ];

  const charged: ChargedLimit[] = [];
  for (const entry of toCharge) {
    const decision: RateLimitDecision = await consumeRateLimit(supabase, entry.rule, entry.subject);
    charged.push(entry);
    if (!decision.allowed) {
      return {
        refusedRetryAfterSeconds: Math.max(1, decision.retryAfterSeconds || entry.rule.windowSeconds),
        charged,
      };
    }
  }

  return { refusedRetryAfterSeconds: null, charged };
}

/**
 * Hand back the units a SUCCESSFUL redemption spent.
 *
 * The budget is meant to bound wrong guesses. Someone who mistypes their card
 * twice and gets it right on the third go has not abused anything, and should
 * not be left one attempt from a lockout the next time they need this endpoint.
 * A wrong guess keeps its charge; a right one does not.
 *
 * Never throws and never blocks the response on a failure — the user has
 * already been granted Pro by the time this runs, and a limiter hiccup must not
 * turn a completed redemption into a 500. Awaited rather than fire-and-forget
 * because an edge isolate can be torn down the moment the response is returned,
 * which would drop the refund on the floor.
 */
export async function refundCharges(
  supabase: SupabaseClient,
  charged: ChargedLimit[],
): Promise<void> {
  for (const entry of charged) {
    try {
      const { error } = await supabase.rpc('refund_rate_limit', {
        p_bucket: entry.rule.bucket,
        p_subject: entry.subject,
        p_window_seconds: entry.rule.windowSeconds,
      });
      if (error) throw error;
    } catch (err) {
      // No subject in the log line: it is a user id or an IP.
      console.error(
        `[redeem-code] refund failed for bucket=${entry.rule.bucket}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
