import { supabase } from './supabase';

export async function checkSubscription(): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

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
