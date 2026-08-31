/**
 * ── THE ENTITLEMENT RULES — read before adding any gate ──────────────────
 * Set by Henry (via the CEO), 1 Sep 2026, while explicitly NOT deciding
 * pricing. They bind any future paywall built in or around this file:
 *
 * 1. NEVER gate access to content a user already has. Gate new capability
 *    only. The dangerous case is cloud backup: a user whose clips exist
 *    only in the cloud (restored phone, cleared storage) must ALWAYS be
 *    able to download their own footage — the download path
 *    (api.getSignedClipUrls and everything above it) carries no
 *    subscription check TODAY and must never gain one. Only the UPLOAD of
 *    new clips (lib/uploadQueue) is entitlement-gated. A lapsed
 *    subscriber keeps everything they ever backed up.
 *
 * 2. An app update never removes access. Entitlements and data survive
 *    updates and reinstalls; RevenueCat/Apple restore purchases.
 *
 * 3. Early users get grandfathered. The mechanism, decided now so nobody
 *    re-litigates it at paywall time: Supabase stamps a server-side
 *    created_at on every account by construction (email and Apple sign-in
 *    both create auth.users rows; there is no guest path), so the
 *    pre-paywall cohort is identifiable forever with zero schema work
 *    today. IF a paywall ships, grant an explicit boolean entitlement to
 *    that cohort in a one-time backfill at that moment — a flag granted
 *    once is unambiguous forever, where date arithmetic against a policy
 *    that later changes is how people get wrongly locked out. Until then,
 *    nothing to build.
 * ─────────────────────────────────────────────────────────────────────────
 */

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

  // getSession() is a LOCAL read (works offline); no session is a
  // DETERMINATE "not subscribed" — signed-out users have no entitlement.
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? null;
  if (!userId) {
    return resolveProStatus({ entitlementActive: false, variant, devOverride });
  }

  // Cache is USER-SCOPED so a cached '1' can never answer for a different
  // account after sign-out/sign-in.
  const cacheKey = `${PRO_STATUS_CACHE_KEY}.${userId}`;
  try {
    const entitled = await checkSubscriptionDeterminate(userId);
    // Write the cache ONLY on determinate answers. Indeterminate checks
    // (offline: store unreachable AND profile query failed) throw instead,
    // so a network blip can never poison the cache with a false '0'.
    setSetting(cacheKey, entitled ? '1' : '0').catch(() => {});
    return resolveProStatus({ entitlementActive: entitled, variant, devOverride });
  } catch {
    const cached = (await getSetting(cacheKey).catch(() => null)) === '1';
    return resolveProStatus({ entitlementActive: cached, variant, devOverride });
  }
}

/** Back-compat boolean wrapper; indeterminate reads as false (fail-closed). */
export async function checkSubscription(): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? null;
  if (!userId) return false;
  return checkSubscriptionDeterminate(userId).catch(() => false);
}

/**
 * Live entitlement check that DISTINGUISHES "authoritatively not subscribed"
 * (returns false) from "couldn't determine" (throws). Throwing routes
 * getProStatus() to the last determinate cached answer instead of locking a
 * paying subscriber out during a network blip — and instead of caching a
 * false negative.
 */
async function checkSubscriptionDeterminate(userId: string): Promise<boolean> {
  // StoreKit entitlement (RevenueCat) — the in-app purchase path, and the
  // path that covers the ASC free-trial period (an active trial IS the
  // active entitlement). Checked first because it's the live store truth;
  // the Supabase profile keeps covering web (Stripe) subscriptions until
  // the RC webhook unifies them.
  let storeIndeterminate = false;
  try {
    if (await iap.isProActive()) return true;
  } catch {
    storeIndeterminate = true;
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('subscription_status, subscription_expires_at')
    .eq('id', userId)
    .single();

  if (error) {
    // PGRST116 = zero rows: a determinate "no profile ⇒ not subscribed".
    // Anything else (network, 5xx) is indeterminate.
    if (error.code === 'PGRST116' && !storeIndeterminate) return false;
    throw new Error(`subscription check indeterminate: ${error.code ?? 'network'}`);
  }
  if (!profile) {
    if (storeIndeterminate) throw new Error('subscription check indeterminate');
    return false;
  }

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
      .eq('id', userId);
    if (storeIndeterminate) throw new Error('subscription check indeterminate');
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
      .eq('id', userId);
    if (storeIndeterminate) throw new Error('subscription check indeterminate');
    return false;
  }

  // Profile says not subscribed — but if the store check failed we can't be
  // sure (a StoreKit sub may not be mirrored into the profile), so stay
  // indeterminate rather than caching a possibly-false negative.
  if (storeIndeterminate) throw new Error('subscription check indeterminate');
  return false;
}

export type SubscriptionStatus = 'free' | 'trial' | 'active' | 'cancelled' | 'expired';
