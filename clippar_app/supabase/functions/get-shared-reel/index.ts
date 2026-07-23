import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';

/**
 * get-shared-reel — PUBLIC signer for the shared-reel viewer at
 * clippargolf.com/r/<token>.
 *
 * Anonymous web visitors can't read the reel themselves: reel_url points into
 * the PRIVATE `clips` bucket, whose storage read policy is TO authenticated
 * only, so the anon key can't sign the object. This function runs with the
 * SERVICE ROLE (auto-injected as SUPABASE_SERVICE_ROLE_KEY) to look up the
 * round and mint a short-lived signed URL — but only for rounds that are
 * genuinely public-shared. It re-checks the same predicate the public RLS
 * policy uses (share_token set AND is_published = true) so the service role
 * can't be used to leak private reels.
 *
 * Deployed with --no-verify-jwt so it works for anonymous visitors. It still
 * requires the project's anon apikey on the request (the platform gateway
 * needs it to route). The service key NEVER leaves this function.
 *
 * Input:  GET  ?token=<share_token>   or   POST { shareToken: "<share_token>" }
 * Output: 200  { courseName, totalScore, scoreToPar, playedAt, reelUrl }
 *         4xx  { error: "<friendly message>" }
 */

// Origins allowed to call this from a browser. Anything else falls back to the
// production origin so preflight still returns a valid (non-matching) value.
const ALLOWED_ORIGINS = new Set<string>([
  'https://clippargolf.com',
  'https://www.clippargolf.com',
  // local testing (static site served on these during development)
  'http://localhost:8731',
  'http://127.0.0.1:8731',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow =
    origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://clippargolf.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, apikey, content-type, x-client-info',
    Vary: 'Origin',
  };
}

// Signed reel URLs are short-lived — long enough to start playback and reload,
// short enough that a leaked URL expires quickly.
const SIGNED_URL_TTL_SECONDS = 3600;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('Origin'));

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  try {
    // ── Extract the share token from GET query or POST body ──
    let shareToken: string | null = null;
    if (req.method === 'GET') {
      shareToken = new URL(req.url).searchParams.get('token');
    } else if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      shareToken =
        (body?.shareToken as string) ?? (body?.token as string) ?? null;
    } else {
      return json({ error: 'Method not allowed.' }, 405);
    }

    if (!shareToken || typeof shareToken !== 'string' || !shareToken.trim()) {
      return json({ error: 'This reel link looks incomplete.' }, 400);
    }

    // A friendly, uniform "not available" — we never distinguish "no such
    // token" from "not published" from "no reel", so the endpoint can't be
    // used to probe which tokens exist.
    const notAvailable = () => json({ error: "This reel isn't available." }, 404);

    // ── Look up the round (service role bypasses RLS; we enforce the public
    //    predicate below ourselves) ──
    const { data: round, error } = await supabase
      .from('rounds')
      .select(
        'course_name, total_score, score_to_par, reel_url, created_at, is_published, share_token',
      )
      .eq('share_token', shareToken.trim())
      .maybeSingle();

    if (error || !round) return notAvailable();

    // Same rule as the "Shared rounds are publicly viewable" RLS policy.
    if (!round.share_token || round.is_published !== true) return notAvailable();
    if (!round.reel_url) return notAvailable();

    // ── Sign the reel in the private `clips` bucket ──
    const { data: signed, error: signErr } = await supabase.storage
      .from('clips')
      .createSignedUrl(round.reel_url, SIGNED_URL_TTL_SECONDS);

    if (signErr || !signed?.signedUrl) return notAvailable();

    return json({
      courseName: round.course_name,
      totalScore: round.total_score,
      scoreToPar: round.score_to_par,
      playedAt: round.created_at,
      reelUrl: signed.signedUrl,
    });
  } catch (_err) {
    // Never surface internals (which could include the service context).
    return json({ error: 'Something went wrong loading this reel.' }, 500);
  }
});
