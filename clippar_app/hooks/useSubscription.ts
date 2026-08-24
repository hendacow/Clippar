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
      // getSession() is a LOCAL read — the old getUser() here was a full
      // Auth-server round trip that gated the whole chain (see lib/api.ts's
      // note on the same swap). The entitlement check and the status-string
      // read don't depend on each other, so they run together: this chain
      // was 4 serial round trips (auth + entitlement pair + status) and is
      // now 2 in parallel. Screens gate on `loading` (e.g. the Cloud-backup
      // switch renders off+disabled until it clears), so every trip shaved
      // here is UI-visible.
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id ?? null;

      const [subscribed, statusRow] = await Promise.all([
        // Single source of truth (lib/subscription.getProStatus): RevenueCat
        // entitlement / Supabase profile, offline cache, dev-only override.
        getProStatus(),
        userId
          ? supabase
              .from('profiles')
              .select('subscription_status')
              .eq('id', userId)
              .single()
              .then(
                (r) => r.data,
                () => null,
              )
          : Promise.resolve(null),
      ]);

      setIsSubscribed(subscribed);
      if (statusRow) setStatus(statusRow.subscription_status as SubscriptionStatus);
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
