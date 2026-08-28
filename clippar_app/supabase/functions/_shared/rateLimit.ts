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
 * Parse a header value into its ONE canonical address string, or null.
 *
 * What this defends is not the trust question the docblock above leaves open — a
 * forged but well-formed address still buys a fresh bucket, and only the
 * trusted-ingress decision closes that. What it defends is the rate limit's
 * KEYSPACE, and through it the `api_rate_limit` table.
 *
 * Whatever this returns is passed as `p_subject` to `consume_rate_limit`, and
 * `api_rate_limit.subject` is TEXT inside the primary key (migration 016). So a
 * subject the caller can vary at all is a row they can multiply, and — worse — a
 * bucket they can escape. On `get-shared-reel`, the one endpoint with no JWT, the
 * cap is per SUBJECT, so anything that lets one host spell itself two ways makes
 * the cap that many times larger.
 *
 * An earlier version of this was a character-class test
 * (`/^[0-9A-Fa-f:.]+$/`), which bounded the LENGTH and not the shape. It
 * accepted `dead`, `....`, `0` and 45 characters of arbitrary hex, so the
 * keyspace stayed effectively unbounded — and it accepted `1.2.3.4`,
 * `01.2.3.4`, `1.2.3.4.` and `.1.2.3.4` as four different subjects for one
 * host. That is a 4x (or 120x) cap for anyone who noticed, needing no forged
 * ingress at all: not a different address, just a different rendering of your
 * own. This is a real STRUCTURE test, and it CANONICALISES rather than merely
 * accepting, so every spelling of one address collapses onto one bucket.
 *
 * A value that fails falls through to the next header and ultimately to the
 * shared 'unknown' bucket. That is the safe direction for JUNK — it over-counts
 * a malformed caller rather than handing them a private allowance — but it is
 * NOT safe as the destination for a FORMAT this parser does not handle, because
 * that case is all-or-nothing across every caller at once rather than per
 * caller. Hence the wrapper peeling below (port, brackets, zone index) and the
 * warning in clientIp when a header was present and parsed as nothing.
 */
export function canonicalIp(input: string): string | null {
  // 57 = 45 (longest v6 text form) plus brackets, a colon and a port. Peel the
  // wrappers first, then apply the real bound.
  if (input.length === 0 || input.length > 57) return null;
  let v = input;

  // A proxy may WRAP the address rather than change it: `[v6]:port`, `v4:port`,
  // or a `%zone` suffix. Strip those instead of rejecting them.
  //
  // Rejecting looks safer and is not: every rejected value keys the single
  // shared 'unknown' bucket, so an ingress that appends a source port — Azure
  // Front Door does exactly this — would put THE ENTIRE INTERNET into one
  // 120/hour pool on the share endpoint, and one popular link would 429 every
  // real visitor. A wrapper is a rendering difference, so it is peeled for the
  // same reason `::` is expanded below.
  // `%(?:25)?` and NOT `%25?`: the latter requires a literal `2`, so it strips
  // the percent-encoded `%25eth0` and leaves the plain `%eth0` — which then
  // fails to parse and lands in the shared bucket. Caught by a test.
  v = v.replace(/%(?:25)?[0-9A-Za-z._-]+$/, '');
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) {
    v = bracketed[1];
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) {
    v = v.slice(0, v.lastIndexOf(':'));
  }
  if (v.length === 0 || v.length > 45) return null;

  // ── IPv4 ──
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return null;
    // Rebuilt from the parsed numbers, so `01.2.3.4` and `1.2.3.4` return the
    // same string rather than being two subjects. Leading zeros are also how
    // some stacks read an octet as octal, so normalising is safer than
    // rejecting.
    return octets.join('.');
  }

  // ── IPv6 ──
  // Must contain a colon to be worth trying, and `::` may appear at most once.
  if (!v.includes(':')) return null;
  const halves = v.split('::');
  if (halves.length > 2) return null;

  // A trailing dotted quad (v4-mapped/compatible) counts as two groups. Recurse
  // through the v4 branch so it is canonicalised by the same rules.
  let tail = halves[halves.length - 1];
  let mappedV4 = '';
  const lastColon = tail.lastIndexOf(':');
  const maybeV4 = tail.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const canon4 = canonicalIp(maybeV4);
    if (!canon4 || canon4.includes(':')) return null;
    mappedV4 = canon4;
    tail = tail.slice(0, lastColon + 1);
    halves[halves.length - 1] = tail.replace(/:$/, '');
  }

  const parse = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    for (const g of groups) {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
    }
    // Lowercased and zero-stripped so `2001:DB8::1`, `2001:db8::1` and
    // `2001:0db8::0001` are one subject rather than three.
    return groups.map((g) => g.replace(/^0+(?=.)/, '').toLowerCase());
  };

  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || rest === null) return null;

  const mappedGroups = mappedV4 ? 2 : 0;
  const total = head.length + rest.length + mappedGroups;
  if (halves.length === 2) {
    // `::` must stand for at least one omitted group.
    if (total >= 8) return null;
  } else if (total !== 8) {
    return null;
  }

  // EXPAND to eight groups. NEVER re-emit the caller's `::`.
  //
  // Zero-run compression is a RENDERING choice, not part of the address, and
  // the earlier version copied whichever placement arrived. So `2001:db8::1`,
  // `2001:db8:0::1`, `2001:db8::0:1`, `2001:db8:0:0::1` and
  // `2001:db8:0:0:0:0:0:1` were five subjects for one host — and `::1`, with a
  // seven-group zero run, was a great many more. That is the exact defect this
  // function exists to close, moved from the v4 branch to the v6 branch, and
  // the docblock above claimed it was closed. Expanding is unique by
  // construction, which re-compressing per RFC 5952 is not without care.
  // 8 groups of 4 plus 7 colons = 39, still inside the 45 bound.
  const v4Groups = mappedV4
    ? (() => {
      const o = mappedV4.split('.').map(Number);
      return [
        (((o[0] << 8) | o[1]) >>> 0).toString(16),
        (((o[2] << 8) | o[3]) >>> 0).toString(16),
      ];
    })()
    : [];
  const full = halves.length === 2
    ? head.concat(new Array(8 - total).fill('0'), rest, v4Groups)
    : head.concat(rest, v4Groups);

  // `::ffff:a.b.c.d` IS a.b.c.d. Fold it onto the v4 form, or the v4
  // canonicalisation above is bypassable by spelling the same address through
  // this branch — `1.2.3.4`, `::ffff:1.2.3.4`, `0:0:0:0:0:ffff:1.2.3.4` and
  // `::ffff:102:304` would otherwise be four subjects for one host.
  if (full.slice(0, 5).every((g) => g === '0') && full[5] === 'ffff') {
    const hi = parseInt(full[6], 16);
    const lo = parseInt(full[7], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return full.join(':');
}

/**
 * The client's IP, for limits that have no authenticated subject.
 *
 * CAREFUL — and the care is the opposite of the usual advice. The standard rule
 * is "never take X-Forwarded-For entry [0], the caller controls it; take the
 * LAST entry your proxy appended". This docblock used to say exactly that, and
 * it was wrong *here*, which only a deployment showed: Supabase's gateway
 * OVERWRITES the header rather than appending to it, so entry [0] is
 * gateway-asserted and the last entry is Supabase's own load balancer. Keying on
 * the last entry fragmented one machine's requests across 14 buckets and never
 * saw the real client at all.
 *
 * So the order of preference below is `cf-connecting-ip`, then entry [0]. **Read
 * the measurement in the body before changing it** — the general principle will
 * tell you to invert this, and the general principle does not hold on this
 * deployment.
 *
 * The corollary matters too, and it is broader than the X-Forwarded-For branch.
 * **Every header this function reads is trustworthy only because of that gateway
 * — `cf-connecting-ip` included, and that one is consulted FIRST.** Off the
 * gateway — self-hosted, `supabase functions serve`, a custom domain terminating
 * elsewhere, or any future direct-to-origin route — all three of
 * `cf-connecting-ip`, X-Forwarded-For `[0]` and `x-real-ip` are plain
 * caller-supplied strings, and the cheapest bypass is the first branch, not the
 * second. Anyone hardening only the X-Forwarded-For path would leave the easier
 * door open. In that state a fresh header value per request keys a fresh bucket
 * and the cap stops existing, with no error and no log line to show it.
 *
 * Nothing here asserts that precondition at runtime; that is a known open
 * decision, not an oversight.
 */
export function clientIp(req: Request): string {
  // `cf-connecting-ip` first. Supabase fronts Edge Functions with Cloudflare,
  // which sets this to a SINGLE address it observed itself, so it needs no
  // parsing and is the most trustworthy value on offer.
  //
  // **HONEST SCOPE — this branch is NOT covered by the measurement below.** That
  // measurement spoofed X-Forwarded-For and watched it be discarded; nothing
  // here has ever spoofed `cf-connecting-ip`. Cloudflare *should* replace an
  // inbound value of its own header for proxied traffic, and that is the whole
  // basis for trusting this branch — but it is first-principles reasoning about
  // this gateway's header handling, which is exactly the reasoning the docblock
  // above records as having produced an inverted conclusion once already.
  //
  // One request settles it: send `cf-connecting-ip: 198.51.100.77` to the dev
  // project and log what this returns. Real address -> record it here beside the
  // X-Forwarded-For result and the question is closed. Echoed back -> it is a
  // live bypass on the hosted deployment, not an off-gateway hypothetical.
  //
  // OFF the gateway nothing replaces it either way and it is plainly a
  // caller-typed string, which is why the corollary names this branch first.
  const cf = canonicalIp(req.headers.get('cf-connecting-ip')?.trim() ?? '');
  if (cf) return cf;

  // Fallback: the FIRST X-Forwarded-For entry.
  //
  // This is the opposite of the usual advice, and the usual advice is right in
  // the usual case: where a proxy APPENDS to a caller-supplied header, entry [0]
  // is whatever the attacker typed, and keying a rate limit on it means they get
  // a fresh bucket per request. That is what this function used to guard against
  // by taking the LAST entry.
  //
  // It is wrong here, and only a deployment showed it. Measured against the dev
  // project: X-Forwarded-For arrives with three entries, the caller is at index
  // 0, and a request sent with `X-Forwarded-For: 198.51.100.77` produced the
  // same three entries with the caller still at index 0 — the spoof was
  // DISCARDED, not prepended. Supabase's gateway overwrites the header rather
  // than appending to it, so entry [0] is gateway-asserted and entries [1..] are
  // its own internal hops.
  //
  // Taking the last entry therefore keyed every limit on SUPABASE'S OWN
  // load-balancer address. The observed effect on dev: 133 requests from one
  // machine fragmented across 14 buckets (3.2.60.x, 13.248.109.x) and the real
  // client address never appeared once — so a 120/hour cap was really about
  // 120 x 14, and worse, unrelated visitors sharing a balancer shared a counter
  // and could throttle each other.
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    const first = parts.length > 0 ? canonicalIp(parts[0]) : null;
    if (first) return first;
  }

  const real = req.headers.get('x-real-ip')?.trim() ?? '';
  const canon = canonicalIp(real);
  if (canon) return canon;

  // 'unknown' is ONE bucket for the entire internet, so arriving here matters.
  // A caller that sent no address header at all is the case it is designed for.
  // A header that WAS present and parsed as nothing is a misconfiguration —
  // an ingress emitting a format this function does not handle — and it puts
  // every visitor into a single shared cap with no error and no log line.
  // Those two must not look identical, so say which one happened.
  if (real || req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')) {
    console.warn(
      'clientIp: an address header was present but unparseable — every caller ' +
        'now shares one rate-limit bucket. Check what the ingress is sending.',
    );
  }
  return 'unknown';
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
