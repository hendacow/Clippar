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
 * Account hygiene (security review, PR #136/#145): a cached payload is another
 * query's RESULT handed out without re-running RLS, so the cache must never
 * outlive or cross the session that warmed it. Three guards enforce that:
 *   1. every entry records the userId that warmed it (resolved from the local
 *      session), and a take by any other (or no) user resolves null — the
 *      consumer then falls back to a live getRound, which RLS authorises;
 *   2. clearRoundPrefetch() runs on EVERY way a session ends — the sign-out
 *      button (clearAccountLinkedCaches), account deletion (wipeLocalUserData),
 *      and the auth listener's SIGNED_OUT branch (hooks/useAuth.ts), which
 *      catches remote revokes and refresh-token failures that never pass
 *      through the button;
 *   3. retention is bounded by a per-entry expiry timer (an untaken entry is
 *      deleted when its TTL lapses, on every platform, foregrounded or not),
 *      plus dropping the whole cache when a native app backgrounds.
 */
import { AppState, Platform } from 'react-native';
import { getRound } from '@/lib/api';
import { supabase } from '@/lib/supabase';

interface Entry {
  at: number;
  /**
   * The signed-in user who warmed this entry, resolved from the local session
   * asynchronously — a promise so the entry itself can be registered
   * SYNCHRONOUSLY at press time. If registration waited on getSession, the
   * detail screen (mounting right behind router.push) could miss the cache,
   * start a live fetch, and leave this warm's own fetch behind as a cached
   * duplicate that a later focus would wrongly consume.
   */
  owner: Promise<string | null>;
  promise: Promise<any>;
}

// Short window — just long enough to bridge press → screen mount. Anything
// older is treated as absent so the detail screen fetches fresh.
const TTL_MS = 15_000;
const cache = new Map<string, Entry>();

// Bumped by every scrub. A warm that started before the bump must not
// proceed: without this, a prefetch whose getSession was still in flight when
// clearRoundPrefetch() ran would go on to fetch (and briefly retain) the
// departed user's payload — the TOCTOU the security review flagged. getSession
// can be a full refresh round-trip wide, not just a tick, so the window is
// real. Checked before the fetch is issued and again before a take is served,
// making the scrub authoritative over everything in flight.
let generation = 0;

// Pending expiry timers. Tracked so a scrub can cancel them: each timer
// closure holds its entry (and the payload its promise resolves to), so a
// bare clear() of the Map would leave scrubbed payloads reachable in the
// heap for up to TTL_MS until the timer fired — data remanence the security
// review flagged. Cancelling drops the closures with the timers.
const timers = new Set<ReturnType<typeof setTimeout>>();

// Nothing warmed is worth keeping across a backgrounding — the press → mount
// window it bridges is long gone by the time the app comes back. The per-entry
// expiry timers below already bound retention everywhere; these hooks just
// drop the memory sooner. Web has no AppState, so tab-hidden is its analogue.
if (Platform.OS === 'ios' || Platform.OS === 'android') {
  try {
    AppState.addEventListener('change', (state) => {
      if (state === 'background') clearRoundPrefetch();
    });
  } catch {
    // AppState unavailable (tests/SSR) — the expiry timers still bound retention.
  }
} else if (Platform.OS === 'web') {
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') clearRoundPrefetch();
    });
  } catch {
    // Non-DOM environment — the expiry timers still bound retention.
  }
}

/**
 * Warm the round-detail payload for `id`. Fire from a row's onPress. Cheap to
 * call repeatedly — an in-flight/fresh entry short-circuits. Never throws; a
 * failed fetch (or a signed-out warm) resolves to null and the consumer falls
 * back to a live fetch. The entry is registered synchronously so a take
 * immediately after the press can never miss it.
 */
export function prefetchRound(id: string | null | undefined): void {
  if (!id) return;
  const existing = cache.get(id);
  if (existing && Date.now() - existing.at < TTL_MS) return;

  // Resolve the owner in the entry rather than before registration (see
  // Entry.owner). No owner → no fetch at all — and a scrub that lands while
  // getSession is in flight (generation bump) kills the warm the same way,
  // so the departed session's payload is never even requested.
  const startedAt = generation;
  const owner = supabase.auth
    .getSession()
    .then(({ data }) =>
      generation === startedAt ? (data.session?.user?.id ?? null) : null,
    )
    .catch(() => null);
  const entry: Entry = {
    at: Date.now(),
    owner,
    promise: owner.then((userId) => (userId ? getRound(id).catch(() => null) : null)),
  };
  cache.set(id, entry);

  // Hard retention bound: delete at expiry even if nothing ever takes it and
  // no other cache call runs (idle foreground, web). Identity-checked so a
  // newer entry for the same round is never deleted by an older timer.
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (cache.get(id) === entry) cache.delete(id);
  }, TTL_MS + 500);
  timers.add(timer);
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
  const hit = cache.get(id);
  if (!hit) return null;
  cache.delete(id);
  if (Date.now() - hit.at > TTL_MS) return null;
  // Ownership gate: the cached payload is served without re-running RLS, so
  // it must never cross an account boundary. Compare the warming user against
  // the current session; a scrub arriving while these resolve (generation
  // bump) also voids the take. Fail closed on any doubt.
  const takenAt = generation;
  return Promise.all([
    hit.owner,
    supabase.auth
      .getSession()
      .then(({ data }) => data.session?.user?.id ?? null)
      .catch(() => null),
  ])
    .then(([warmedBy, current]) => {
      if (generation !== takenAt) return null;
      if (!warmedBy || !current || warmedBy !== current) return null;
      return hit.promise;
    })
    .catch(() => null);
}

/**
 * Drops all warmed entries AND voids everything in flight (generation bump),
 * so a warm racing this scrub can neither land nor be served. Wired into
 * every path a session can end on, plus the background/hidden hooks above.
 */
export function clearRoundPrefetch(): void {
  generation++;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  cache.clear();
}
