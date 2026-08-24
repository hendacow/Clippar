/**
 * Round-detail prefetch cache.
 *
 * Home → round detail is the app's most-travelled navigation edge, and today
 * the detail screen only starts fetching its round (getRound: rounds + shots)
 * once it has mounted — a guaranteed spinner on every tap. But the moment a
 * golfer's finger lands on a row, which round they want is known. This warms
 * getRound on press so the payload is usually in hand by the time the screen
 * mounts, turning the tap's spinner into an instant paint.
 *
 * Purely additive and safe: it is the identical query the detail screen runs,
 * the entry is consumed once (single-use), and a miss / stale / failed prefetch
 * falls straight back to a live fetch. Round detail already refetches on focus,
 * so the freshness contract is unchanged — the prefetch only affects the very
 * first paint, milliseconds after the press.
 *
 * Account hygiene (security review, PR #136): a cached payload is another
 * query's RESULT handed out without re-running RLS, so the cache must never
 * outlive or cross the session that warmed it. Three guards enforce that:
 *   1. every entry is stamped with the userId that warmed it, and a take by
 *      any other (or no) user resolves null — the consumer then falls back to
 *      a live getRound, which RLS authorises;
 *   2. clearRoundPrefetch() runs on EVERY way a session ends — the sign-out
 *      button (clearAccountLinkedCaches), account deletion (wipeLocalUserData),
 *      and the auth listener's SIGNED_OUT branch (hooks/useAuth.ts), which
 *      catches remote revokes and refresh-token failures that never pass
 *      through the button;
 *   3. retention is bounded: expired entries are swept opportunistically on
 *      every prefetch/take, and the whole cache is dropped when the app goes
 *      to the background — an untaken entry can't sit in memory for the life
 *      of the process.
 */
import { AppState, Platform } from 'react-native';
import { getRound } from '@/lib/api';
import { supabase } from '@/lib/supabase';

interface Entry {
  at: number;
  /** The signed-in user who warmed this entry — a take by anyone else misses. */
  userId: string;
  promise: Promise<any>;
}

// Short window — just long enough to bridge press → screen mount. Anything
// older is treated as absent so the detail screen fetches fresh.
const TTL_MS = 15_000;
const cache = new Map<string, Entry>();

/** Drop entries past their serve-by time so the map never accumulates. */
function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > TTL_MS) cache.delete(key);
  }
}

// Nothing warmed is worth keeping across a backgrounding — the press → mount
// window it bridges is long gone by the time the app comes back, and dropping
// it bounds how long a payload (GPS + clip paths) can sit in memory.
if (Platform.OS === 'ios' || Platform.OS === 'android') {
  try {
    AppState.addEventListener('change', (state) => {
      if (state === 'background') cache.clear();
    });
  } catch {
    // AppState unavailable (tests/SSR) — the TTL sweep still bounds retention.
  }
}

/**
 * Warm the round-detail payload for `id`. Fire from a row's onPress. Cheap to
 * call repeatedly — an in-flight/fresh entry short-circuits. Never throws; a
 * failed fetch resolves to null and is retried live by the consumer. No-op
 * when signed out (there is no user to bind the entry to).
 */
export function prefetchRound(id: string | null | undefined): void {
  if (!id) return;
  sweepExpired();
  const existing = cache.get(id);
  if (existing && Date.now() - existing.at < TTL_MS) return;
  // getSession is a local read — resolve the owner first so the entry is
  // bound to the account that warmed it, then fetch.
  void supabase.auth
    .getSession()
    .then(({ data }) => {
      const userId = data.session?.user?.id;
      if (!userId) return;
      const race = cache.get(id);
      if (race && Date.now() - race.at < TTL_MS) return;
      cache.set(id, {
        at: Date.now(),
        userId,
        promise: getRound(id).catch(() => null),
      });
    })
    .catch(() => {});
}

/**
 * Consume a warmed payload for `id`, or null if there is no fresh one. The
 * entry is removed on read (single-use) so subsequent focus fetches go live.
 * The returned promise resolves null when the prefetch errored OR when the
 * entry was warmed by a different account than the one now signed in — in
 * both cases callers must fall back to a live getRound, which enforces RLS.
 */
export function takePrefetchedRound(id: string | null | undefined): Promise<any> | null {
  if (!id) return null;
  sweepExpired();
  const hit = cache.get(id);
  if (!hit) return null;
  cache.delete(id);
  if (Date.now() - hit.at > TTL_MS) return null;
  // Ownership gate: the cached payload is served without re-running RLS, so
  // it must never cross an account boundary. Local session read, then compare
  // against the user who warmed the entry.
  return supabase.auth
    .getSession()
    .then(({ data }) => {
      const userId = data.session?.user?.id;
      if (!userId || userId !== hit.userId) return null;
      return hit.promise;
    })
    .catch(() => null);
}

/** Drops all warmed entries. Wired into every path a session can end on. */
export function clearRoundPrefetch(): void {
  cache.clear();
}
