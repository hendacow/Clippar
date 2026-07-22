import { supabase } from './supabase';
import { iap } from './iap';
import { currentVariant, getDevProOverride } from './devPro';
import { getSetting, setSetting } from './storage';
import { resolveProStatus } from './proStatusLogic';

/** Last successfully computed entitlement result, for offline reads. */
const PRO_STATUS_CACHE_KEY = 'pro.status_cache';

/**
 * SINGLE SOURCE OF TRUTH for "is this user Pro right now". Every gate
 * (export gate, editor, upload queue, useSubscription) must call this —
 * never iap.isProActive() or the Supabase profile directly.
 *
 * Precedence (pure logic in lib/proStatusLogic.ts, unit-tested):
 *  1. Live entitlement (RevenueCat "Clippar Pro", else Supabase profile —
 *     covers web/Stripe subs and the ASC free-trial period, since Apple
 *     grants the entitlement for the whole intro-offer window).
 *  2. Dev-only paywall bypass (lib/devPro.ts, fail-closed on the
 *     app-variant check; the flag is never even read outside dev builds).
 *
 * Expiry behaves lazily by design: when the trial lapses or the user
 * cancels, the entitlement simply stops being active, so the NEXT refresh
 * (app foreground, customerInfo listener, screen mount) re-locks gated
 * features. Nothing revokes access mid-session, so no mid-session crashes.
 *
 * Offline: the last successful result is cached locally; if the live check
 * throws (no network), the cached value answers instead of locking a paying
 * user out.
 */
export async function getProStatus(): Promise<boolean> {
  // Fail-closed dev bypass input: getDevProOverride() returns false — without
  // even reading the persisted flag — unless the binary is the dev variant,
  // and resolveProStatus() re-checks the variant as defense in depth.
  const devOverride = await getDevProOverride();
  const variant = currentVariant();
  try {
    const entitled = await checkSubscription();
    setSetting(PRO_STATUS_CACHE_KEY, entitled ? '1' : '0').catch(() => {});
    return resolveProStatus({ entitlementActive: entitled, variant, devOverride });
  } catch {
    const cached = (await getSetting(PRO_STATUS_CACHE_KEY).catch(() => null)) === '1';
    return resolveProStatus({ entitlementActive: cached, variant, devOverride });
  }
}

export async function checkSubscription(): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  // StoreKit entitlement (RevenueCat) — the in-app purchase path. Checked
  // first because it's the live store truth; the Supabase profile keeps
  // covering web (Stripe) subscriptions until the RC webhook unifies them.
  if (await iap.isProActive().catch(() => false)) return true;

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_status, subscription_expires_at')
    .eq('id', user.id)
    .single();

  if (!profile) return false;

  if (profile.subscription_status === 'active') {
    // Lifetime / perpetual subscriptions have no expiry date — grant access.
    if (!profile.subscription_expires_at) return true;
    if (new Date(profile.subscription_expires_at) > new Date()) {
      return true;
    }
    // Expired — update status
    await supabase
      .from('profiles')
      .update({ subscription_status: 'expired' })
      .eq('id', user.id);
    return false;
  }

  // Trial users get access
  if (profile.subscription_status === 'trial') {
    if (profile.subscription_expires_at && new Date(profile.subscription_expires_at) > new Date()) {
      return true;
    }
    await supabase
      .from('profiles')
      .update({ subscription_status: 'expired' })
      .eq('id', user.id);
    return false;
  }

  return false;
}

export type SubscriptionStatus = 'free' | 'trial' | 'active' | 'cancelled' | 'expired';
