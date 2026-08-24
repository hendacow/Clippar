/**
 * Round-detail prefetch cache.
 *
 * Home → round detail is the app's most-travelled navigation edge, and today
 * the detail screen only starts fetching its round (getRound: rounds + shots)
 * once it has mounted — a guaranteed spinner on every tap. But the moment a
 * golfer's finger lands on a row, which round they want is known. This warms
 * getRound on press-in so the payload is usually in hand by the time the screen
 * mounts, turning the tap's spinner into an instant paint.
 *
 * Purely additive and safe: it is the identical query the detail screen runs,
 * the entry is consumed once (single-use), and a miss / stale / failed prefetch
 * falls straight back to a live fetch. Round detail already refetches on focus,
 * so the freshness contract is unchanged — the prefetch only affects the very
 * first paint, milliseconds after the press.
 */
import { getRound } from '@/lib/api';

interface Entry {
  at: number;
  promise: Promise<any>;
}

// Short window — just long enough to bridge press-in → screen mount. Anything
// older is treated as absent so the detail screen fetches fresh.
const TTL_MS = 15_000;
const cache = new Map<string, Entry>();

/**
 * Warm the round-detail payload for `id`. Fire from a row's onPressIn. Cheap to
 * call repeatedly — an in-flight/fresh entry short-circuits. Never throws; a
 * failed fetch resolves to null and is retried live by the consumer.
 */
export function prefetchRound(id: string | null | undefined): void {
  if (!id) return;
  const existing = cache.get(id);
  if (existing && Date.now() - existing.at < TTL_MS) return;
  cache.set(id, { at: Date.now(), promise: getRound(id).catch(() => null) });
}

/**
 * Consume a warmed payload for `id`, or null if there is no fresh one. The
 * entry is removed on read (single-use) so subsequent focus fetches go live.
 * The returned promise may still resolve to null (a prefetch that errored) —
 * callers should fall back to a live getRound in that case.
 */
export function takePrefetchedRound(id: string | null | undefined): Promise<any> | null {
  if (!id) return null;
  const hit = cache.get(id);
  if (!hit) return null;
  cache.delete(id);
  if (Date.now() - hit.at > TTL_MS) return null;
  return hit.promise;
}

/** Test/refresh hook — drops all warmed entries. */
export function clearRoundPrefetch(): void {
  cache.clear();
}
