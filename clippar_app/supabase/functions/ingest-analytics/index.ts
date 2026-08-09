/**
 * ingest-analytics — server-side PostHog proxy.
 *
 * WHY THIS EXISTS: so the PostHog project API key never ships in the app
 * bundle. The client (lib/analytics.ts) posts KEYLESS, PostHog-shaped events
 * here; this function injects the key from a Supabase secret and forwards to
 * PostHog's batch endpoint. Same posture as our other secret-holding
 * functions (process-round, create-payment-intent, …).
 *
 * Secrets (set with `supabase secrets set`, NOT in the app .env):
 *   POSTHOG_API_KEY   required — the phc_… project (write-only) key
 *   POSTHOG_HOST      optional — defaults to https://us.i.posthog.com
 *
 * Auth: intentionally OPEN (no JWT required) because the first funnel event,
 * `app_opened`, fires before sign-in. Deploy with:
 *   supabase functions deploy ingest-analytics --no-verify-jwt
 * The body carries no privileged operation — worst case is junk events, which
 * PostHog/its own rate limits absorb.
 *
 * Request body: { batch: PostHogEvent[] }  (max 100 events/request)
 * Response: 202 on accepted, 204 when analytics isn't configured (no-op),
 *           4xx on malformed input. The client treats any error as a drop.
 */

const POSTHOG_HOST = Deno.env.get('POSTHOG_HOST') ?? 'https://us.i.posthog.com';
const POSTHOG_API_KEY = Deno.env.get('POSTHOG_API_KEY');

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_EVENTS = 100;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Not configured → quietly accept and drop, so the client degrades to a
  // no-op instead of erroring on every event before the secret is set.
  if (!POSTHOG_API_KEY) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let batch: unknown;
  try {
    ({ batch } = await req.json());
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!Array.isArray(batch) || batch.length === 0) {
    return json({ error: 'Expected non-empty `batch` array' }, 400);
  }
  if (batch.length > MAX_EVENTS) {
    return json({ error: `Too many events (max ${MAX_EVENTS})` }, 413);
  }

  try {
    const res = await fetch(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The key is injected HERE, server-side — never sent by the client.
      body: JSON.stringify({ api_key: POSTHOG_API_KEY, batch }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[ingest-analytics] PostHog ${res.status}: ${detail}`);
      return json({ error: 'Upstream rejected events' }, 502);
    }
  } catch (e) {
    console.error('[ingest-analytics] forward failed:', e);
    return json({ error: 'Forward failed' }, 502);
  }

  return json({ ok: true, count: batch.length }, 202);
});
