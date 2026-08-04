/**
 * Pure orchestration for the recording screen's "Discard Round" (and the
 * "Discard" on a recovered/orphaned round, which is the same action).
 *
 * WHY THIS EXISTS: discard used to be one `deleteLocalRound()` call inside a
 * `try` whose `catch` only logged. Two separate defects lived in that line.
 *
 *  1. IT DELETED THE WRONG COPY. `startRound` creates the round in Supabase
 *     first and refuses to start at all if that insert fails, so every round
 *     has a remote `rounds` row. Home lists rounds from `getRounds()` (remote),
 *     using local SQLite only to enrich clip counts and thumbnails. Deleting
 *     just the local rows therefore left the remote row standing: the round
 *     came back on Home after a relaunch, now reading "0 clips" because the
 *     footage really had been destroyed. Nothing threw — the delete simply
 *     never reached the copy the list is built from.
 *  2. NOTHING COULD REPORT IT. The caller was told success either way, so the
 *     UI dismissed and the user believed the round was gone.
 *
 * The delete itself is `runDeleteRound` — the remote-first, timeout-bounded
 * contract the round-detail screen already uses, and the one App Review
 * confirmed actually removes a round. This module adds the two things discard
 * needs on top of it:
 *
 *  - The "Delete last shot" undo stack is purged as part of the LOCAL step, so
 *    it is only destroyed once the remote row is confirmed gone. A discard that
 *    fails leaves the round AND its undo history exactly as they were, and the
 *    user can retry. A round is recorded once, on a course, and can never be
 *    re-recorded: nothing may be destroyed on a path that might not complete.
 *  - The result is classified into an outcome the caller must handle, so a
 *    half-completed discard can never be reported as a clean one.
 *
 * Dependencies are injected and nothing here imports React or a native module,
 * so tests/roundDiscard.test.ts can exercise every outcome with no device, no
 * database and no network. The SQLite/Supabase/haptics glue lives in
 * hooks/useRound.ts.
 */
import { runDeleteRound, type TimerApi } from './roundDeleteLogic';

/**
 * What actually happened, in the user's terms.
 *
 * 'discarded' — remote row gone, local rows and footage gone. It's over.
 * 'partial'   — remote row gone (so the round can never resurrect on a sync or
 *               a relaunch), but local cleanup failed part-way. The in-memory
 *               round is still cleared, because a round whose remote row has
 *               been deleted cannot be recorded into any further — every
 *               `upsertScore` would fail its foreign key. But the leftover
 *               local row keeps `status = 'in_progress'`, which is exactly what
 *               `getOrphanedRounds` looks for, so the recording screen may
 *               offer to resume a round the server no longer has. Tell the
 *               user rather than claiming a clean discard.
 * 'failed'    — the remote delete failed or timed out, so NOTHING was deleted
 *               anywhere and the round is untouched. Never dismiss the UI on
 *               this one; the user is meant to retry.
 */
export type DiscardOutcome = 'discarded' | 'partial' | 'failed';

export interface RunDiscardRoundDeps {
  /** Remove the round from Supabase (storage buckets + DB rows). */
  deleteRemote: () => Promise<void>;
  /** Remove the round from local SQLite (rows + clip files). */
  deleteLocal: () => Promise<void>;
  /**
   * Release the "Delete last shot" undo stack: commits the deferred clip
   * deletions and unlinks the footage they were holding onto. Destructive, so
   * it runs only on the branch where the discard is actually going through.
   */
  purgeUndoStack: () => void;
  /** Drop the in-memory round. Runs only once the remote row is gone. */
  clearState: () => void;
  /** Upper bound on the cloud call. Defaults to the round-delete timeout. */
  timeoutMs?: number;
  /** Injectable timer (tests). Defaults to real setTimeout/clearTimeout. */
  timers?: TimerApi;
}

export async function runDiscardRound(
  deps: RunDiscardRoundDeps,
): Promise<DiscardOutcome> {
  const { deleteRemote, deleteLocal, purgeUndoStack, clearState, timeoutMs, timers } =
    deps;

  const result = await runDeleteRound({
    deleteRemote,
    deleteLocal: async () => {
      // Inside the local step on purpose: `runDeleteRound` only calls this
      // after the remote row is confirmed gone, so a discard that never
      // completes cannot cost the user their undo history or its footage.
      purgeUndoStack();
      await deleteLocal();
    },
    // Reached only when the remote row is gone. Clearing here (rather than
    // before the awaits) is what stops a failed discard from making the round
    // vanish from the screen while both copies of it still exist.
    onSuccess: clearState,
    // Classified below and messaged by the caller, which knows whether it is
    // discarding the live round or an orphan card.
    onFailure: () => {},
    // No "Deleting…" overlay on the recording screen to tear down.
    finalize: () => {},
    timeoutMs,
    timers,
  });

  if (!result.remoteOk) return 'failed';
  return result.localOk ? 'discarded' : 'partial';
}
