import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';

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
 * cancellations, transfers, refunds and expirations only arrive here.
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
 * Idempotent: every event re-derives the full (status, expires_at) for every
 * affected identity from the event itself and writes it, so duplicate /
 * out-of-order deliveries converge.
 *
 * Env:
 *   REVENUECAT_WEBHOOK_AUTH          shared secret (required)
 *   REVENUECAT_ALLOW_SANDBOX         'true' on staging only
 *   REVENUECAT_LIFETIME_PRODUCT_IDS  comma-separated App Store product ids of
 *                                    the genuine non-consumables. ONLY these
 *                                    may be written with a NULL expiry — see
 *                                    deriveUpdates().
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
export function resolveUserId(event: RcEvent): string | null {
  if (event.app_user_id && UUID_RE.test(event.app_user_id)) {
    return event.app_user_id;
  }
  for (const alias of event.aliases ?? []) {
    if (UUID_RE.test(alias)) return alias;
  }
  return null;
}

/** Keep only the Supabase UUIDs out of a RevenueCat identity list. */
function uuidsIn(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id));
}

export interface RcEvent {
  type: string;
  app_user_id?: string;
  aliases?: string[];
  expiration_at_ms?: number | null;
  product_id?: string;
  // 'TRIAL' | 'INTRO' | 'NORMAL' — used to record a free trial as 'trial'.
  period_type?: string;
  store?: string;
  environment?: string;
  // CANCELLATION only. 'UNSUBSCRIBE' | 'BILLING_ERROR' | 'DEVELOPER_INITIATED'
  // | 'PRICE_INCREASE' | 'CUSTOMER_SUPPORT' | 'UNKNOWN'. A store *refund* or
  // Apple revoke arrives as a CANCELLATION with a reason, not its own type.
  cancel_reason?: string;
  // TRANSFER only. The identities the entitlement moved off / onto.
  transferred_from?: string[];
  transferred_to?: string[];
}

/** One profile row write derived from an event. */
export interface EntitlementUpdate {
  userId: string;
  status: 'active' | 'trial' | 'expired';
  expires_at: string | null;
}

export interface DeriveConfig {
  /** Product ids that are genuine non-consumables (may hold a NULL expiry). */
  lifetimeProductIds: Set<string>;
  allowSandbox: boolean;
}

/**
 * CANCELLATION reasons that mean the money went back, not "auto-renew off".
 * RevenueCat reports an App Store refund and an Apple revoke as a CANCELLATION
 * with cancel_reason 'CUSTOMER_SUPPORT'; 'UNKNOWN' is the catch-all it uses
 * when it cannot classify the store's reason, which has historically included
 * revokes. Both revoke here. Revoking a user who was in fact only unsubscribing
 * is safe: their live StoreKit entitlement is checked FIRST in
 * lib/subscription.ts, so they keep access until the store says otherwise.
 */
const REFUND_CANCEL_REASONS = new Set(['CUSTOMER_SUPPORT', 'UNKNOWN']);

/**
 * Map a RevenueCat event to the profile row writes it implies. Returns [] when
 * the event carries no entitlement change we can safely project.
 *
 * Status is always one of 'active' | 'trial' | 'expired' — a subset of the
 * profiles CHECK constraint ('free','trial','active','cancelled','expired').
 * We never write 'cancelled': an ordinary CANCELLATION means auto-renew was
 * turned OFF — the user keeps access until expiration_at_ms, so it stays
 * 'active' (downgrading would revoke a period they already paid for, since
 * checkSubscription() only grants 'active'/'trial').
 *
 * Three things here are load-bearing security controls, not tidying:
 *
 * 1. TRANSFER REVOKES THE SOURCE. This used to ack-and-skip. That made one
 *    purchase entitle unlimited accounts: buy Pro on account A (profiles(A)
 *    written 'active'), sign out, sign up B on the same device, tap "Restore
 *    Purchases". RevenueCat moves the entitlement to B and fires TRANSFER —
 *    and because nothing was written, A's row stayed 'active' forever while B
 *    became live-entitled too. Repeat for C, D, E. With the lifetime SKU
 *    (expiry NULL) each abandoned account kept Pro permanently. The source
 *    identities in transferred_from demonstrably no longer hold the
 *    entitlement, so they are expired as of now.
 *
 * 2. THE TRANSFER TARGET IS ONLY GRANTED A FINITE, EVENT-CARRIED WINDOW. The
 *    original ack-and-skip existed because a TRANSFER payload may carry no
 *    expiry, and writing a finite sub with a NULL expiry reads as lifetime
 *    downstream. So we grant transferred_to only when the event itself carries
 *    a future expiration_at_ms. Otherwise the recipient still has the live
 *    on-device entitlement (iap.isProActive, checked first) and the next
 *    RENEWAL reconciles the columns. Revoke eagerly, grant conservatively.
 *
 * 3. A NULL EXPIRY REQUIRES AN ALLOWLISTED NON-CONSUMABLE. Any event with no
 *    expiration_at_ms used to be written as status='active', expires_at=NULL,
 *    which lib/subscription.ts reads as perpetual access. A refunded lifetime
 *    purchase, a malformed payload or a truncated event therefore minted
 *    permanent Pro. Perpetual access is now only writable for a product id in
 *    REVENUECAT_LIFETIME_PRODUCT_IDS.
 */
export function deriveUpdates(
  event: RcEvent,
  now: number,
  primaryUserId: string | null,
  cfg: DeriveConfig
): EntitlementUpdate[] {
  // Sandbox purchases (StoreKit sandbox / TestFlight Apple IDs) cost nothing
  // but RevenueCat delivers their events to this same production webhook with
  // environment:'SANDBOX'. Granting entitlements from them would hand out free
  // Pro on real production profiles, so ack + skip them. A staging deployment
  // can opt back in with REVENUECAT_ALLOW_SANDBOX=true.
  if (event.environment === 'SANDBOX' && !cfg.allowSandbox) return [];

  const nowIso = new Date(now).toISOString();
  const expiresMs = event.expiration_at_ms ?? null;
  const expiresIso = expiresMs !== null ? new Date(expiresMs).toISOString() : null;

  switch (event.type) {
    case 'TEST':
    case 'SUBSCRIBER_ALIAS':
      return [];
    case 'TRANSFER': {
      const to = uuidsIn(event.transferred_to);
      // An identity that is both source and target (alias merge) must not be
      // revoked — it still holds the entitlement.
      const from = uuidsIn(event.transferred_from).filter((id) => !to.includes(id));
      const updates: EntitlementUpdate[] = from.map((userId) => ({
        userId,
        status: 'expired' as const,
        expires_at: nowIso,
      }));
      if (expiresMs !== null && expiresMs > now) {
        for (const userId of to) {
          updates.push({ userId, status: 'active', expires_at: expiresIso });
        }
      }
      return updates;
    }
    default:
      break;
  }

  if (!primaryUserId) return [];

  // Refund / revoke: the purchase was reversed, so access ends NOW regardless
  // of the period the user paid for. Checked before the future-expiry branch
  // below, which would otherwise keep a refunded subscriber 'active' for the
  // rest of the (refunded) period, every month, for free.
  if (
    event.type === 'REFUND' ||
    (event.type === 'CANCELLATION' &&
      REFUND_CANCEL_REASONS.has(event.cancel_reason ?? ''))
  ) {
    return [{ userId: primaryUserId, status: 'expired', expires_at: nowIso }];
  }

  // EXPIRATION is terminal regardless of timestamps.
  if (event.type === 'EXPIRATION') {
    return [{ userId: primaryUserId, status: 'expired', expires_at: expiresIso ?? nowIso }];
  }

  if (expiresMs === null) {
    // No expiry = perpetual access downstream. Only a genuine non-consumable
    // may claim that; anything else (refunded lifetime, malformed payload,
    // unknown SKU) writes nothing and leaves the row as it was. The live
    // on-device entitlement still covers the user until a dated event lands.
    if (!event.product_id || !cfg.lifetimeProductIds.has(event.product_id)) {
      console.warn(
        `event ${event.type} has no expiry and product_id ${event.product_id ?? '(none)'} ` +
          `is not in REVENUECAT_LIFETIME_PRODUCT_IDS — refusing to write perpetual access`
      );
      return [];
    }
    return [{ userId: primaryUserId, status: 'active', expires_at: null }];
  }

  // A stale event whose window already closed lands as 'expired'.
  if (expiresMs <= now) {
    return [{ userId: primaryUserId, status: 'expired', expires_at: expiresIso }];
  }

  // A free trial grants access just like 'active' (lib/subscription.ts treats
  // them identically) but we record it as 'trial' so the distinction survives
  // for UI/analytics.
  const status = event.period_type === 'TRIAL' ? 'trial' : 'active';
  return [{ userId: primaryUserId, status, expires_at: expiresIso }];
}

/** Minimal shape of the service-role client used by applyUpdates (test seam). */
export interface ProfileClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

export async function applyUpdates(
  client: ProfileClient,
  updates: EntitlementUpdate[]
): Promise<void> {
  for (const update of updates) {
    const { error } = await client
      .from('profiles')
      .update({
        subscription_status: update.status,
        subscription_expires_at: update.expires_at,
        updated_at: new Date().toISOString(),
      })
      .eq('id', update.userId);
    if (error) {
      console.error(`profiles update failed for ${update.userId}`, error);
      throw error;
    }
  }
}

/**
 * Constant-time secret comparison. Compares fixed-size SHA-256 digests so the
 * check leaks neither the secret's bytes (no early-exit branch) nor its length.
 */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

export function readDeriveConfig(): DeriveConfig {
  const raw = Deno.env.get('REVENUECAT_LIFETIME_PRODUCT_IDS') ?? '';
  return {
    lifetimeProductIds: new Set(
      raw.split(',').map((s) => s.trim()).filter(Boolean)
    ),
    allowSandbox: Deno.env.get('REVENUECAT_ALLOW_SANDBOX') === 'true',
  };
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Shared-secret auth. Configured in the RevenueCat dashboard under the
  // webhook's Authorization header. Missing server secret = misconfiguration,
  // fail closed.
  const expected = Deno.env.get('REVENUECAT_WEBHOOK_AUTH');
  if (!expected) {
    console.error('REVENUECAT_WEBHOOK_AUTH not set — rejecting');
    return json({ error: 'Server not configured' }, 500);
  }
  const provided = req.headers.get('Authorization') ?? '';
  if (!(await secretsMatch(provided, expected))) {
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
    // resolveUserId is now computed BEFORE deriving: a TRANSFER has no single
    // subject, so the derivation needs the primary id as an input rather than
    // looking it up afterwards.
    const primaryUserId = resolveUserId(event);
    const updates = deriveUpdates(event, now, primaryUserId, readDeriveConfig());
    if (updates.length === 0) {
      // Nothing to project (TEST/alias/sandbox), or an anonymous purchase that
      // never aliased to a Supabase user. Ack so RevenueCat stops retrying; a
      // later SUBSCRIBER_ALIAS/login or RENEWAL reconciles.
      return json({ received: true, skipped: event.type });
    }

    await applyUpdates(supabase as unknown as ProfileClient, updates);
    return json({
      received: true,
      applied: updates.map((u) => ({ user: u.userId, status: u.status })),
    });
  } catch (err) {
    // 500 → RevenueCat retries with backoff, which is what we want for a
    // transient DB failure.
    console.error('revenuecat-webhook error', err);
    return json({ error: 'Internal error' }, 500);
  }
}

// Only bind the server when run as the entry module (Edge Function runtime).
// Importing this file from a test must not start a listener.
if (import.meta.main) {
  Deno.serve(handler);
}
