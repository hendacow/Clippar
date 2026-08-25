/**
 * search-courses — server-side proxy for GolfCourseAPI.com.
 *
 * WHY THIS EXISTS
 * lib/golfCourseApi.ts used to call api.golfcourseapi.com DIRECTLY from the
 * device, authenticating with `EXPO_PUBLIC_GOLF_COURSE_API_KEY`. Expo inlines
 * every EXPO_PUBLIC_* value into the JS bundle at build time, so that key is
 * recoverable from the shipped IPA with `strings` on the Hermes bundle. The free
 * tier is 300 requests per day ACCOUNT-WIDE, which means anybody who pulled the
 * key out of the binary could exhaust a day's quota in seconds with a curl loop,
 * from no account and no install, every day, for free — and course search is the
 * first screen of onboarding and the entry point to recording a round. Because
 * no Clippar server was in the path, no rate limiter could ever see those calls.
 *
 * With the key held here as a Supabase secret (GOLF_COURSE_API_KEY, the same
 * secret sync-courses already uses) the quota is only reachable through this
 * function, which is rate limited per caller AND against a project-wide daily
 * upstream budget. Rotating the key is now a secret change, not an App Review
 * cycle.
 *
 * PUBLIC-ISH: the onboarding funnel runs BEFORE signup, so callers may present
 * only the project anon key. Requests are keyed by user id when there is a real
 * user and by client IP otherwise. Nothing here reads or writes user data, and
 * the upstream key never leaves this function.
 *
 * Input:  POST { action: 'search', query: string, country?: string }
 *         POST { action: 'detail', course_id: string }
 * Output: 200 { courses: [...] }  |  { course: {...} | null }
 *
 * Deploy normally (`supabase functions deploy search-courses`) — NOT with
 * --no-verify-jwt. supabase-js sends the project anon key as the Authorization
 * bearer when there is no session, and the anon key is itself a project-signed
 * JWT, so the gateway's verify_jwt check passes for signed-out onboarding
 * callers without the endpoint being opened to unauthenticated traffic outright.
 *
 * REQUIRES the GOLF_COURSE_API_KEY secret on the project
 * (`supabase secrets set GOLF_COURSE_API_KEY=...`); sync-courses already uses
 * the same name. Without it this returns empty results and course search
 * degrades to the local `courses` table.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import { clientIp, consumeRateLimit, enforceRateLimits } from '../_shared/rateLimit.ts';

const GCAPI_BASE = 'https://api.golfcourseapi.com/v1';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Content-Type': 'application/json',
};

/**
 * Per-caller cap. Both call sites are 300 ms-debounced type-aheads, so a user
 * setting up a round makes a handful of these; 200 an hour absorbs a heavy
 * session and several people behind one carrier NAT while ending scripted use.
 * Layered under the shared 30/minute burst guard by enforceRateLimits.
 */
const PER_CALLER = { bucket: 'search-courses', limit: 200, windowSeconds: 3_600 };

/**
 * PROJECT-WIDE daily budget for calls that actually reach GolfCourseAPI.
 *
 * The per-caller cap above bounds one identity; this bounds all of them
 * together, which is the limit that matters because the vendor's quota is
 * per-ACCOUNT and IPs are cheap.
 *
 * THE FREE TIER IS 50 REQUESTS PER DAY, not 300. Read off golfcourseapi.com's
 * own pricing page on 2026-07-29: "Free — $0 — Up to 50 requests per day"
 * (Pro $9.99 = 10,000/day, Enterprise $24.99 = 100,000/day). This budget was
 * set to 250 against the older 300 figure, which made it useless: it could
 * never fire before the vendor's own limit did, so instead of degrading
 * gracefully to the local catalog, course search would start returning upstream
 * 429s mid-round.
 *
 * 40 leaves 10/day of headroom for sync-courses, which shares
 * GOLF_COURSE_API_KEY. If Clippar moves to the Pro tier, raise this to a few
 * thousand — the mechanism is right, only the ceiling was wrong.
 *
 * Fails CLOSED — see the call site: when this is exhausted we return an empty
 * result rather than an error, so search degrades to the local `courses` table
 * instead of breaking. Spending quota we do not have would break it for
 * everyone, for the rest of the day.
 */
const UPSTREAM_BUDGET = {
  bucket: 'golfcourseapi-upstream',
  limit: 40,
  windowSeconds: 86_400,
  onError: 'closed' as const,
};

/** Validate the free-text search term before it reaches a paid third party. */
export function parseQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 80) return null;
  return trimmed;
}

/**
 * Coerce a region code to 2–3 ASCII letters. Unencoded interpolation of a
 * caller-supplied country into the upstream query string is how you append
 * arbitrary parameters to a request that carries our paid key; the value is
 * both shape-checked here and encoded at the call site.
 */
export function safeRegionCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2,3}$/.test(trimmed) ? trimmed : fallback;
}

/**
 * GolfCourseAPI ids are numeric. Anything else is rejected outright rather than
 * encoded and sent, so a caller cannot steer the path component of a request
 * made on our credentials.
 */
export function parseCourseId(value: unknown): string | null {
  const asString = typeof value === 'number' ? String(value) : value;
  if (typeof asString !== 'string') return null;
  const trimmed = asString.trim();
  return /^[0-9]{1,20}$/.test(trimmed) ? trimmed : null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const handler = async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Identify the caller before limiting, so a signed-in user gets their own
    // bucket instead of sharing one with everyone behind the same NAT. The
    // onboarding funnel is pre-signup, so a missing/anon token is expected and
    // falls back to IP — clientIp() prefers `cf-connecting-ip` (set by the
    // Cloudflare edge, unforgeable) and only then the FIRST X-Forwarded-For
    // entry, because Supabase's gateway OVERWRITES that header rather than
    // appending to it. See _shared/rateLimit.ts clientIp() for the measurement
    // — and for the KNOWN LIMIT: unforgeable is a property of the edge, not of
    // the header, so off that ingress the fallback is caller-writable.
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    let subject = `ip:${clientIp(req)}`;
    if (token) {
      const { data } = await supabase.auth.getUser(token);
      if (data?.user) subject = data.user.id;
    }

    const limited = await enforceRateLimits(supabase, PER_CALLER, subject, corsHeaders);
    if (limited) return limited;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json({ error: 'Invalid request body' }, 400);
    }
    const action = (body as Record<string, unknown>).action ?? 'search';

    const apiKey = Deno.env.get('GOLF_COURSE_API_KEY');
    // No key configured → behave exactly as the old client did with no key:
    // empty result, no error, caller falls back to the local catalog.
    if (!apiKey) {
      console.error('[search-courses] GOLF_COURSE_API_KEY is not set');
      return json(action === 'detail' ? { course: null } : { courses: [] });
    }

    // VALIDATE FIRST, THEN SPEND.
    //
    // The project-wide budget used to be consumed here, above the DTO checks, so
    // a request with a junk body still burned one of the day's 250 upstream
    // units. That made the proxy a CHEAPER denial of service than the exposed
    // key it replaced: two IPs sending 250 malformed POSTs — no key, no account,
    // no install — exhausted the whole day's budget in under an hour, after
    // which every real user got an empty course list until UTC midnight.
    //
    // A request that cannot reach upstream must not cost upstream quota. The
    // per-caller limiter above already charged for the attempt, so junk traffic
    // is still bounded; it just no longer spends the shared resource.
    const detail = action === 'detail';
    const courseId = detail ? parseCourseId((body as Record<string, unknown>).course_id) : null;
    const query = detail ? null : parseQuery((body as Record<string, unknown>).query);
    if (detail && !courseId) return json({ error: 'Invalid course id' }, 400);
    if (!detail && !query) return json({ error: 'Invalid query' }, 400);

    // Only now is an upstream call certain.
    const budget = await consumeRateLimit(supabase, UPSTREAM_BUDGET, 'global');
    if (!budget.allowed) {
      console.warn('[search-courses] daily GolfCourseAPI budget exhausted');
      // Degrade, do not fail: the callers merge these results with the local
      // `courses` table, so an empty list means "fewer suggestions", not a
      // broken screen.
      return json(detail ? { course: null } : { courses: [] });
    }

    if (detail) {
      const res = await fetch(`${GCAPI_BASE}/courses/${encodeURIComponent(courseId!)}`, {
        headers: { Authorization: `Key ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(`[search-courses] detail failed: ${res.status}`);
        return json({ course: null });
      }
      return json({ course: await res.json() });
    }

    const country = safeRegionCode((body as Record<string, unknown>).country, 'AU');

    const url = `${GCAPI_BASE}/search?search_query=${encodeURIComponent(query!)}` +
      `&country_code=${encodeURIComponent(country)}`;
    const res = await fetch(url, {
      headers: {
        // GolfCourseAPI uses the `Key` scheme, NOT `Bearer`. `Bearer <key>`
        // returns 401 "API Key is missing or invalid".
        Authorization: `Key ${apiKey}`,
        Accept: 'application/json',
      },
      // Spec 7.5: every outbound call gets a timeout. Without one a slow vendor
      // holds an edge worker open indefinitely.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`[search-courses] search failed: ${res.status}`);
      return json({ courses: [] });
    }

    const data = await res.json();
    return json({ courses: data.courses ?? data.results ?? [] });
  } catch (err) {
    // Fixed public string; the detail goes to our log. Relaying a vendor or
    // Postgres error here would leak request ids, hostnames and dependency
    // versions (spec 5.3).
    console.error('[search-courses]', err instanceof Error ? err.message : err);
    return json({ error: 'Internal error' }, 500);
  }
};

if (import.meta.main) {
  Deno.serve(handler);
}
