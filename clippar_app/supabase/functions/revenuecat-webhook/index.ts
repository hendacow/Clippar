import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * revenuecat-webhook — server-authoritative entitlement sync for Clippar Pro.
 *
 * RevenueCat is the system of record for *purchases*; this function projects
 * each purchase event onto the columns `lib/subscription.ts` already reads:
 *   profiles.subscription_status     ('active' | 'cancelled' | 'expired' | …)
 *   profiles.subscription_expires_at (TIMESTAMPTZ, null = lifetime/perpetual)
 * so the rest of the app keeps working unchanged. The client also does an
 * optimistic refresh on purchase/restore (checkSubscription() hits the live
 * RevenueCat entitlement), but THIS is the authoritative path — renewals,
 * cancellations, billing issues and expirations only arrive here.
 *
 * Auth: RevenueCat sends the exact Authorization header value you configure in
 * the dashboard webhook settings. We compare it against
 * REVENUECAT_WEBHOOK_AUTH. There is no signature scheme — the shared secret IS
 * the auth. Deploy with `--no-verify-jwt` because RevenueCat does not send a
 * Supabase JWT; the shared secret below is what secures the endpoint.
 *
 * app_user_id: the client calls Purchases.logIn(<supabase user id>) on session
 * load (see hooks/useAuth.ts + lib/iap.identify), so app_user_id is normally
 * the Supabase UUID. If a purchase happened while still anonymous, the UUID
 * shows up in `aliases` instead — we scan there as a fallback. Anything that
 * never resolves to a UUID is acked (200) and skipped, never retried forever.
 *
 * Idempotent: every event re-derives the full (status, expires_at) from the
 * event itself and writes it, so duplicate / out-of-order deliveries converge.
 */

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pick the Supabase user id out of app_user_id, falling back to aliases. */
function resolveUserId(event: RcEvent): string | null {
  if (event.app_user_id && UUID_RE.test(event.app_user_id)) {
    return event.app_user_id;
  }
  for (const alias of event.aliases ?? []) {
    if (UUID_RE.test(alias)) return alias;
  }
  return null;
}

interface RcEvent {
  type: string;
  app_user_id?: string;
  aliases?: string[];
  expiration_at_ms?: number | null;
  product_id?: string;
  // 'TRIAL' | 'INTRO' | 'NORMAL' — used to record a free trial as 'trial'.
  period_type?: string;
  store?: string;
  environment?: string;
}

/**
 * Map a RevenueCat event to the profile row state. Returns null when the event
 * carries no entitlement change we project (TEST, SUBSCRIBER_ALIAS, TRANSFER).
 *
 * Status is always one of 'active' | 'trial' | 'expired' — a subset of the
 * profiles CHECK constraint ('free','trial','active','cancelled','expired').
 * We never write 'cancelled': CANCELLATION means auto-renew was turned OFF —
 * the user keeps access
 * until expiration_at_ms, so it stays 'active' (downgrading to 'cancelled'
 * would revoke a period they already paid for, since checkSubscription()
 * only grants 'active'/'trial').
 */
function deriveState(
  event: RcEvent,
  now: number
): { status: 'active' | 'trial' | 'expired'; expires_at: string | null } | null {
  switch (event.type) {
    case 'TEST':
    case 'SUBSCRIBER_ALIAS':
      return null;
    // TRANSFER moves an entitlement between identities (re-login on a new
    // account, family sharing). The payload carries no reliable per-user
    // expiry, so deriving state here risks over-granting (a finite sub written
    // with null expiry reads as lifetime) or — worse — wrongly revoking a
    // paying user whose id lands in transferred_from. Transfers are rare and
    // the on-device live entitlement (iap.isProActive, checked first) already
    // reflects them; we ack-and-skip and let the next RENEWAL reconcile the
    // authoritative columns rather than guess.
    case 'TRANSFER':
      return null;
    default:
      break;
  }

  const expiresMs = event.expiration_at_ms ?? null;
  const expires_at = expiresMs ? new Date(expiresMs).toISOString() : null;

  // EXPIRATION is terminal regardless of timestamps. Everything else is
  // active while there's no expiry (lifetime) or the expiry is still ahead;
  // a stale event whose window already closed lands as 'expired'.
  if (event.type === 'EXPIRATION') {
    return { status: 'expired', expires_at };
  }
  if (expiresMs !== null && expiresMs <= now) {
    return { status: 'expired', expires_at };
  }
  // A free trial grants access just like 'active' (lib/subscription.ts treats
  // them identically) but we record it as 'trial' so the distinction survives
  // for UI/analytics.
  const status = event.period_type === 'TRIAL' ? 'trial' : 'active';
  return { status, expires_at };
}

async function applyState(
  userId: string,
  state: { status: string; expires_at: string | null }
) {
  const { error } = await supabase
    .from('profiles')
    .update({
      subscription_status: state.status,
      subscription_expires_at: state.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (error) {
    console.error(`profiles update failed for ${userId}`, error);
    throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Shared-secret auth. Configured in the RevenueCat dashboard under the
  // webhook's Authorization header. Missing server secret = misconfiguration,
  // fail closed.
  const expected = Deno.env.get('REVENUECAT_WEBHOOK_AUTH');
  if (!expected) {
    console.error('REVENUECAT_WEBHOOK_AUTH not set — rejecting');
    return json({ error: 'Server not configured' }, 500);
  }
  if (req.headers.get('Authorization') !== expected) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let payload: { event?: RcEvent };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const event = payload.event;
  if (!event?.type) return json({ error: 'Missing event' }, 400);

  const now = Date.now();

  try {
    const state = deriveState(event, now);
    if (!state) return json({ received: true, skipped: event.type });

    const userId = resolveUserId(event);
    if (!userId) {
      // Anonymous purchase that never aliased to a Supabase user. Ack so
      // RevenueCat stops retrying; a later SUBSCRIBER_ALIAS/login reconciles.
      console.warn(`No Supabase UUID for event ${event.type}; acked + skipped`);
      return json({ received: true, skipped: 'no_user' });
    }

    await applyState(userId, state);
    return json({ received: true, user: userId, status: state.status });
  } catch (err) {
    // 500 → RevenueCat retries with backoff, which is what we want for a
    // transient DB failure.
    console.error('revenuecat-webhook error', err);
    return json({ error: 'Internal error' }, 500);
  }
});
