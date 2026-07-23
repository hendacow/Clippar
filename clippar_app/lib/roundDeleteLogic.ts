/**
 * Pure orchestration for deleting a round from the round-detail screen.
 *
 * Storage, network and navigation are all injected so the node test runner
 * can exercise the ordering + resilience guarantees without a device
 * (tests/roundDelete.test.ts). The SQLite / Supabase / expo-router glue lives
 * in app/round/[id].tsx.
 *
 * A round shows on Home iff its REMOTE Supabase `rounds` row exists — Home's
 * `fetchRounds` lists rounds from `getRounds()` (remote) and local SQLite only
 * enriches clip counts/thumbnails of already-remote rounds. Round metadata
 * syncs to remote at round start; on the free tier the clips just stay local.
 *
 * So success MUST be gated on the REMOTE delete. If we deleted local first and
 * the remote call failed/timed out, we'd wipe the on-device media while the
 * remote row survived — the round would reappear on Home as a broken empty
 * shell, with the user wrongly told it worked. The contract, in order:
 *
 *  1. Delete REMOTE first, BOUNDED by `timeoutMs` — a Supabase storage
 *     list/remove that hangs on a flaky/absent network can never wedge the UI.
 *  2. If the remote delete SUCCEEDS: delete local (best-effort cleanup of the
 *     SQLite rows + clip files), then `onSuccess` (success haptic + navigate).
 *     The round is gone from remote, so it can't reappear on Home.
 *  3. If the remote delete FAILS or TIMES OUT: leave local intact, call
 *     `onFailure` (alert), and do NOT navigate — the user stays on-screen and
 *     can retry. This preserves the media for the retry.
 *  4. `finalize` ALWAYS runs exactly once (in a `finally`), so the deleting
 *     overlay is torn down no matter what — it can never wedge.
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
  /** Remove the round from Supabase (storage buckets + DB rows). */
  deleteRemote: () => Promise<void>;
  /** Remove the round from local SQLite (rows + clip files). */
  deleteLocal: () => Promise<void>;
  /** Remote succeeded: success side-effect (haptic) + navigate away. */
  onSuccess: () => void;
  /** Remote failed/timed out: alert the user; they stay on-screen to retry. */
  onFailure: () => void;
  /** Tear down the overlay (setDeleting(false)). MUST always be safe to call. */
  finalize: () => void;
  /** Upper bound on the cloud call. Defaults to DELETE_ROUND_CLOUD_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injectable timer (tests). Defaults to real setTimeout/clearTimeout. */
  timers?: TimerApi;
}

export interface RunDeleteRoundResult {
  /** Remote delete resolved (within the timeout) without throwing. */
  remoteOk: boolean;
  /** Remote delete did not settle before `timeoutMs` elapsed. */
  remoteTimedOut: boolean;
  /** Local cleanup ran and resolved (only attempted when `remoteOk`). */
  localOk: boolean;
}

/**
 * Run the remote delete but never wait longer than `timeoutMs`. Resolves with
 * 'ok' when it succeeds, 'error' when it throws, or 'timeout' when the bound
 * elapses first. A `settled` guard means a remote promise that resolves LATE
 * (after the timeout already won) can't double-resolve or flip the outcome; a
 * hanging remote promise is simply abandoned. The timer is cleared on the fast
 * path so nothing leaks when the remote wins.
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
    deleteRemote,
    deleteLocal,
    onSuccess,
    onFailure,
    finalize,
    timeoutMs = DELETE_ROUND_CLOUD_TIMEOUT_MS,
    timers = defaultTimers,
  } = deps;

  const result: RunDeleteRoundResult = {
    remoteOk: false,
    remoteTimedOut: false,
    localOk: false,
  };

  try {
    // 1. REMOTE first, bounded so a hanging cloud call can't wedge the overlay.
    const outcome = await boundedRemote(deleteRemote, timeoutMs, timers);

    if (outcome === 'ok') {
      result.remoteOk = true;
      // 2. Remote row is gone → best-effort local cleanup (rows + clip files).
      //    A local failure here is cosmetic — the round is already off Home.
      try {
        await deleteLocal();
        result.localOk = true;
      } catch {
        // Swallow: never block success on local orphan cleanup.
      }
      onSuccess();
    } else {
      // 3. Remote FAILED or TIMED OUT → keep local media intact, tell the
      //    user, and stay on-screen so they can retry. Never wipe local while
      //    the remote row may still exist (would resurface a broken shell).
      result.remoteTimedOut = outcome === 'timeout';
      onFailure();
    }
  } finally {
    // 4. Overlay can never wedge — always tear it down.
    finalize();
  }

  return result;
}
