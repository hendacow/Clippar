import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiscardRound, type DiscardOutcome } from '../lib/roundDiscardLogic';
import type { TimerApi } from '../lib/roundDeleteLogic';

// "Discard Round" on the recording screen destroys footage that can never be
// re-recorded, and App Review caught it doing the opposite: it deleted the
// LOCAL round only, left the Supabase row Home lists from standing, and — via
// a catch that only logged — told the user it had worked. The round came back
// after a relaunch with its clips gone.
//
// These tests lock down what the fix guarantees:
//   1. REMOTE FIRST. The remote row is the one that decides whether a round
//      exists; nothing local is destroyed until it is confirmed gone.
//   2. NOTHING DESTROYED ON A FAILED DISCARD. No local delete, no undo-stack
//      purge, no state clear — the round stays exactly as it was, retryable.
//   3. HONEST OUTCOME. A discard that half-completed can never be reported as
//      a clean one, and a failure is never reported as a success.

// Timers that never auto-fire: the remote promise wins the race normally.
const noFireTimers: TimerApi = { set: () => 'h', clear: () => {} };
// Timers that fire the timeout synchronously: simulates the bound elapsing
// before a hanging (or very late) remote call settles.
const instantTimeout: TimerApi = {
  set: (cb) => {
    cb();
    return 'h';
  },
  clear: () => {},
};

const hangs = () => new Promise<void>(() => {}); // never resolves

/** Records the order of every side effect a discard can have. */
function spy(overrides: {
  deleteRemote?: () => Promise<void>;
  deleteLocal?: () => Promise<void>;
} = {}) {
  const calls: string[] = [];
  const deps = {
    deleteRemote:
      overrides.deleteRemote ??
      (async () => {
        // Force a microtask hop so a mis-ordered impl would interleave.
        await Promise.resolve();
        calls.push('remote');
      }),
    deleteLocal:
      overrides.deleteLocal ??
      (async () => {
        calls.push('local');
      }),
    purgeUndoStack: () => calls.push('purge'),
    clearState: () => calls.push('clearState'),
  };
  return { calls, deps };
}

test('happy path: remote deleted BEFORE local, then the undo stack, then state', async () => {
  const { calls, deps } = spy();
  const outcome = await runDiscardRound({ ...deps, timers: noFireTimers });

  assert.equal(outcome, 'discarded');
  // The bug was that 'remote' never appeared in this list at all.
  assert.deepEqual(calls, ['remote', 'purge', 'local', 'clearState']);
});

test('remote delete THROWS: nothing is destroyed and the caller is told it failed', async () => {
  const { calls, deps } = spy({
    deleteRemote: async () => {
      calls.push('remote');
      throw new Error('supabase 500 / RLS / expired session');
    },
  });
  const outcome = await runDiscardRound({ ...deps, timers: noFireTimers });

  assert.equal(outcome, 'failed');
  // No local delete, no purge (the undo stack survives), no state clear — the
  // round is exactly as it was and the user can try again.
  assert.deepEqual(calls, ['remote']);
});

test('hanging cloud call TIMES OUT: also "failed", and nothing local is touched', async () => {
  const { calls, deps } = spy({ deleteRemote: hangs });
  const outcome = await runDiscardRound({ ...deps, timers: instantTimeout });

  assert.equal(outcome, 'failed');
  assert.deepEqual(calls, []);
});

test('a late remote success cannot flip a timed-out discard into a success', async () => {
  // instantTimeout settles the race as 'timeout' synchronously; the remote
  // then resolves on a later microtask. If that late resolve won, we would
  // wipe local media for a discard we already told the user had failed.
  const { calls, deps } = spy({
    deleteRemote: async () => {
      /* resolves, but only after the timeout has already won */
    },
  });
  const outcome = await runDiscardRound({ ...deps, timers: instantTimeout });

  assert.equal(outcome, 'failed');
  assert.deepEqual(calls, []);
});

test('remote gone but local cleanup fails: "partial", never a clean "discarded"', async () => {
  const { calls, deps } = spy({
    deleteLocal: async () => {
      calls.push('local');
      throw new Error('sqlite locked');
    },
  });
  const outcome = await runDiscardRound({ ...deps, timers: noFireTimers });

  // The round can never resurrect — its remote row is gone — so the in-memory
  // round IS cleared (recording into it would fail every foreign key). But the
  // leftover local row still reads as an unfinished round, so this must not be
  // reported as a clean discard.
  assert.equal(outcome, 'partial');
  assert.deepEqual(calls, ['remote', 'purge', 'local', 'clearState']);
});

test('a never-synced local round still discards (0 remote rows deleted is success)', async () => {
  // Supabase treats a delete matching no rows as success, so a round whose
  // remote row is already absent must discard cleanly rather than stranding
  // its local copy forever.
  const { calls, deps } = spy({ deleteRemote: async () => {} });
  const outcome = await runDiscardRound({ ...deps, timers: noFireTimers });

  assert.equal(outcome, 'discarded');
  assert.deepEqual(calls, ['purge', 'local', 'clearState']);
});

test('every outcome is one the caller must branch on', () => {
  // Typo-proofing: the recording screen keys its alerts off these exact
  // strings, and 'failed' is the one that must NOT dismiss the UI.
  const all: DiscardOutcome[] = ['discarded', 'partial', 'failed'];
  assert.equal(new Set(all).size, 3);
});

test('the default (real timer) path bounds a hanging cloud call', async () => {
  const { calls, deps } = spy({ deleteRemote: hangs });
  const outcome = await runDiscardRound({ ...deps, timeoutMs: 5 });

  assert.equal(outcome, 'failed');
  assert.deepEqual(calls, []);
});
