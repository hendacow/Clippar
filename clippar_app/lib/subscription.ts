import { supabase } from './supabase';
import { iap } from './iap';

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
