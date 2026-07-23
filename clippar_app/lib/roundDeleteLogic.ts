/**
 * Pure orchestration for deleting a round from the round-detail screen.
 *
 * Storage, network and navigation are all injected so the node test runner
 * can exercise the ordering + resilience guarantees without a device
 * (tests/roundDelete.test.ts). The SQLite / Supabase / expo-router glue lives
 * in app/round/[id].tsx.
 *
 * A round recorded on the free tier lives in TWO places: the local SQLite
 * `local_rounds` row (+ clip files) and the remote Supabase `rounds` row.
 * Deleting only the remote row (the old behaviour) orphaned the local copy,
 * and the remote storage `.list()` call could hang on a flaky/absent network
 * — wedging the "Deleting round..." overlay forever. This orchestrator fixes
 * both, with three guarantees, in order:
 *
 *  1. The LOCAL delete runs FIRST — the round leaves the on-device library
 *     instantly, even fully offline. A local failure is swallowed
 *     (best-effort) and never blocks the rest.
 *  2. The REMOTE delete runs next but is BOUNDED by `timeoutMs` — a Supabase
 *     storage list/remove that hangs can never wedge the UI. A slow, failing
 *     or timed-out cloud call is swallowed; the round is already gone locally.
 *  3. `finalize` ALWAYS runs exactly once (in a `finally`), so the deleting
 *     overlay is torn down and navigation happens no matter what.
 */

/** How long the cloud delete may run before we stop waiting on it. */
export const DELETE_ROUND_CLOUD_TIMEOUT_MS = 8000;

export interface TimerApi {
  set: (cb: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: TimerApi = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface RunDeleteRoundDeps {
  /** Remove the round from local SQLite (rows + clip metadata). */
  deleteLocal: () => Promise<void>;
  /** Remove the round from Supabase (storage buckets + DB rows). */
  deleteRemote: () => Promise<void>;
  /** Tear down the overlay + navigate away. MUST always be safe to call. */
  finalize: () => void;
  /** Optional success side-effect (e.g. success haptic). */
  onSuccess?: () => void;
  /** Upper bound on the cloud call. Defaults to DELETE_ROUND_CLOUD_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injectable timer (tests). Defaults to real setTimeout/clearTimeout. */
  timers?: TimerApi;
}

export interface RunDeleteRoundResult {
  /** Local delete resolved without throwing. */
  localOk: boolean;
  /** Remote delete resolved (within the timeout) without throwing. */
  remoteOk: boolean;
  /** Remote delete did not settle before `timeoutMs` elapsed. */
  remoteTimedOut: boolean;
}

/**
 * Run the remote delete but never wait longer than `timeoutMs`. Resolves with
 * 'ok' when it succeeds, 'error' when it throws, or 'timeout' when the bound
 * elapses first. A hanging remote promise is simply abandoned (left pending);
 * the timer is cleared on the fast path so nothing leaks when it wins.
 */
function boundedRemote(
  deleteRemote: () => Promise<void>,
  timeoutMs: number,
  timers: TimerApi,
): Promise<'ok' | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const handle = timers.set(() => {
      if (settled) return;
      settled = true;
      resolve('timeout');
    }, timeoutMs);

    deleteRemote().then(
      () => {
        if (settled) return;
        settled = true;
        timers.clear(handle);
        resolve('ok');
      },
      () => {
        if (settled) return;
        settled = true;
        timers.clear(handle);
        resolve('error');
      },
    );
  });
}

export async function runDeleteRound(
  deps: RunDeleteRoundDeps,
): Promise<RunDeleteRoundResult> {
  const {
    deleteLocal,
    deleteRemote,
    finalize,
    onSuccess,
    timeoutMs = DELETE_ROUND_CLOUD_TIMEOUT_MS,
    timers = defaultTimers,
  } = deps;

  const result: RunDeleteRoundResult = {
    localOk: false,
    remoteOk: false,
    remoteTimedOut: false,
  };

  try {
    // 1. Local first — instant, offline-safe. Best-effort.
    try {
      await deleteLocal();
      result.localOk = true;
    } catch {
      // Swallow: a local failure must not block the remote delete or finalize.
    }

    // 2. Remote, bounded so a hanging cloud call can't wedge the overlay.
    const outcome = await boundedRemote(deleteRemote, timeoutMs, timers);
    result.remoteOk = outcome === 'ok';
    result.remoteTimedOut = outcome === 'timeout';

    // Celebrate only if at least one side actually removed something.
    if (result.localOk || result.remoteOk) {
      onSuccess?.();
    }
  } finally {
    // 3. Always tear down the overlay + navigate — the overlay can't wedge.
    finalize();
  }

  return result;
}
