import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import {
  allowedClientIds,
  decodeJwtPayload,
  exchangeAuthorizationCode,
  generateAppleClientSecret,
  getAppleConfig,
} from '../_shared/apple.ts';

/**
 * apple-link — capture an Apple refresh token at Sign-in-with-Apple time so the
 * account can later be revoked on deletion (App Store 5.1.1(v)).
 *
 * The native SiwA flow signs the user in with the identity token only; the
 * one-time `authorizationCode` is the sole way to obtain a refresh token. The
 * client posts that code (plus the identity token, to read its `aud`/`sub`)
 * here right after signing in. We exchange the code with Apple using a
 * server-generated client secret, then store the refresh token in
 * `apple_credentials` (service-role only) keyed to the user.
 *
 * Auth: the caller's own Supabase JWT. We never trust a user id from the body.
 * Best-effort by design — a failure here must not break sign-in; the client
 * calls it fire-and-forget. We still return a clear status for observability.
 */
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);
    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const appleConfig = getAppleConfig();
    if (!appleConfig) {
      // Feature not configured (no Apple secrets) — succeed as a no-op so the
      // client never treats sign-in as broken.
      return json({ linked: false, reason: 'not_configured' });
    }

    const { authorizationCode, identityToken } = await req
      .json()
      .catch(() => ({}));
    if (!authorizationCode || !identityToken) {
      return json({ error: 'authorizationCode and identityToken required' }, 400);
    }

    // The token was issued for the app's bundle id — read it from the identity
    // token's `aud` and allowlist it (the client secret's `sub` must match).
    let clientId: string;
    let appleSub: string | null = null;
    try {
      const claims = decodeJwtPayload(identityToken);
      clientId = String(claims.aud ?? '');
      appleSub = claims.sub ? String(claims.sub) : null;
    } catch {
      return json({ error: 'Invalid identity token' }, 400);
    }
    if (!allowedClientIds().includes(clientId)) {
      return json({ error: 'Unrecognized client_id' }, 400);
    }

    const clientSecret = await generateAppleClientSecret(appleConfig, clientId);
    const tokenResp = await exchangeAuthorizationCode({
      code: authorizationCode,
      clientId,
      clientSecret,
    });

    if (!tokenResp.refresh_token) {
      // Code already redeemed/expired, or Apple returned an error. Non-fatal:
      // we just can't revoke later. Log for diagnostics.
      console.warn('apple-link: no refresh_token', tokenResp.error ?? '');
      return json({ linked: false, reason: tokenResp.error ?? 'no_refresh_token' });
    }

    const { error: upsertError } = await supabase
      .from('apple_credentials')
      .upsert(
        {
          user_id: user.id,
          client_id: clientId,
          refresh_token: tokenResp.refresh_token,
          apple_sub: appleSub,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );
    if (upsertError) {
      console.error('apple-link: upsert failed', upsertError);
      return json({ error: 'Failed to store credentials' }, 500);
    }

    return json({ linked: true });
  } catch (err) {
    console.error('apple-link error', err);
    return json({ error: 'Internal error' }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}
