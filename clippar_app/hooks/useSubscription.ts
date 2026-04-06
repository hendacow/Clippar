import { useEffect, useState, useCallback } from 'react';
import { checkSubscription, SubscriptionStatus } from '@/lib/subscription';
import { supabase } from '@/lib/supabase';

export function useSubscription() {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [status, setStatus] = useState<SubscriptionStatus>('free');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const subscribed = await checkSubscription();
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
  }, [refresh]);

  return { isSubscribed, status, loading, refresh };
}
