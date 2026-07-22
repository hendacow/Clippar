import { useEffect, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { getProStatus, SubscriptionStatus } from '@/lib/subscription';
import { supabase } from '@/lib/supabase';
import { onSubscriptionChanged } from '@/lib/subscriptionEvents';

export function useSubscription() {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [status, setStatus] = useState<SubscriptionStatus>('free');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Single source of truth (lib/subscription.getProStatus): RevenueCat
      // entitlement / Supabase profile, offline cache, dev-only override.
      const subscribed = await getProStatus();
      setIsSubscribed(subscribed);

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase
          .from('profiles')
          .select('subscription_status')
          .eq('id', user.id)
          .single();
        if (data) setStatus(data.subscription_status as SubscriptionStatus);
      }
    } catch {
      // Silently fail — user will see paywall
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Re-check when the app returns to the foreground: this is the moment a
    // lapsed trial / cancelled subscription re-locks features (RevenueCat
    // refreshes customerInfo on activation, and getProStatus reads it live).
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    // Re-check immediately after a purchase/restore (paywall emits) and on
    // RevenueCat customerInfo pushes (lib/iap re-broadcasts its listener),
    // so the UI reflects entitlement changes without waiting for a remount.
    const unsubscribe = onSubscriptionChanged(refresh);
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, [refresh]);

  return { isSubscribed, status, loading, refresh };
}
