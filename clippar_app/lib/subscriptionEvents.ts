import { DeviceEventEmitter } from 'react-native';

/**
 * Lightweight in-process bus so a successful purchase/restore (in app/paywall)
 * can tell every mounted useSubscription() to re-check entitlement immediately
 * — an optimistic client refresh. The authoritative sync is the
 * revenuecat-webhook Edge Function; this just avoids a stale UI until the next
 * natural refetch. checkSubscription() reads the live RevenueCat entitlement,
 * so the refetch reflects the new purchase even before the webhook lands.
 */
const EVENT = 'clippar:subscription-changed';

export function emitSubscriptionChanged(): void {
  DeviceEventEmitter.emit(EVENT);
}

export function onSubscriptionChanged(listener: () => void): () => void {
  const sub = DeviceEventEmitter.addListener(EVENT, listener);
  return () => sub.remove();
}
