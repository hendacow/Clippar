import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runDeleteRound,
  DELETE_ROUND_CLOUD_TIMEOUT_MS,
  type TimerApi,
} from '../lib/roundDeleteLogic';

// The round-detail "Delete round" flow is REMOTE-FIRST: a round shows on Home
// iff its remote `rounds` row exists, so success (success haptic + navigate)
// MUST be gated on the remote delete. Local media is wiped ONLY after the
// remote row is gone — never while it may still exist (that would resurface a
// broken empty shell on Home). A hanging cloud call must not wedge the
// "Deleting round..." overlay, and `finalize` must ALWAYS run. These tests
// lock those guarantees down.

// Timers that never auto-fire: the remote promise wins the race normally.
const noFireTimers: TimerApi = { set: () => 'h', clear: () => {} };
// Timers that fire the timeout synchronously: simulates the bound elapsing
// before a hanging (or late) remote settles.
const instantTimeout: TimerApi = {
  set: (cb) => {
    cb();
    return 'h';
  },
  clear: () => {},
};

const hangs = () => new Promise<void>(() => {}); // never resolves

test('remote succeeds: deletes remote BEFORE local, then onSuccess', async () => {
  const calls: string[] = [];
  let success = 0;
  let failure = 0;
  let finalize = 0;
  const res = await runDeleteRound({
    deleteRemote: async () => {
      // Force a microtask hop so a mis-ordered impl would interleave.
      await Promise.resolve();
      calls.push('remote');
    },
    deleteLocal: async () => {
      calls.push('local');
    },
    onSuccess: () => success++,
    onFailure: () => failure++,
    finalize: () => finalize++,
    timers: noFireTimers,
  });
  assert.deepEqual(calls, ['remote', 'local']);
  assert.equal(res.remoteOk, true);
  assert.equal(res.localOk, true);
  assert.equal(res.remoteTimedOut, false);
  assert.equal(success, 1);
  assert.equal(failure, 0);
  assert.equal(finalize, 1);
});

test('never-synced local-only round: remote no-ops (0 rows = success) → local cleanup + success', async () => {
  let localDeleted = false;
  let success = 0;
  const res = await runDeleteRound({
    deleteRemote: async () => {}, // Supabase delete of 0 matching rows: no error
    deleteLocal: async () => {
      localDeleted = true;
    },
    onSuccess: () => success++,
    onFailure: () => {},
    finalize: () => {},
    timers: noFireTimers,
  });
  assert.equal(res.remoteOk, true);
  assert.equal(localDeleted, true);
  assert.equal(success, 1);
});

test('remote THROWS: no success, no navigate, local left intact, finalize runs', async () => {
  const calls: string[] = [];
  let success = 0;
  let failure = 0;
  let finalize = 0;
  const res = await runDeleteRound({
    deleteRemote: async () => {
      calls.push('remote');
      throw new Error('supabase 500 / expired session');
    },
    deleteLocal: async () => {
      calls.push('local');
    },
    onSuccess: () => success++,
    onFailure: () => failure++,
    finalize: () => finalize++,
    timers: noFireTimers,
  });
  assert.equal(res.remoteOk, false);
  assert.equal(res.localOk, false);
  // Local media MUST be preserved so the user can retry — deleteLocal not run.
  assert.deepEqual(calls, ['remote']);
  assert.equal(success, 0); // no false success
  assert.equal(failure, 1); // alerted, stays on screen
  assert.equal(finalize, 1); // overlay still torn down
});

test('hanging cloud call TIMES OUT: no success, local intact, overlay cannot wedge', async () => {
  let localCalled = 0;
  let success = 0;
  let failure = 0;
  let finalize = 0;
  const res = await runDeleteRound({
    deleteRemote: hangs, // would wedge the overlay forever without the bound
    deleteLocal: async () => {
      localCalled++;
    },
    onSuccess: () => success++,
    onFailure: () => failure++,
    finalize: () => finalize++,
    timers: instantTimeout,
  });
  assert.equal(res.remoteOk, false);
  assert.equal(res.remoteTimedOut, true);
  assert.equal(localCalled, 0); // never wipe local when remote didn't confirm
  assert.equal(success, 0);
  assert.equal(failure, 1);
  assert.equal(finalize, 1);
});

test('double-resolve guard: timeout wins even if the remote resolves late', async () => {
  // instantTimeout resolves the race as 'timeout' synchronously; the remote
  // then resolves on a later microtask. The settled guard must ignore it so
  // the late success can't flip the outcome or double-fire callbacks.
  let localCalled = 0;
  let success = 0;
  let failure = 0;
  const res = await runDeleteRound({
    deleteRemote: async () => {
      /* resolves, but only after the timeout already won */
    },
    deleteLocal: async () => {
      localCalled++;
    },
    onSuccess: () => success++,
    onFailure: () => failure++,
    finalize: () => {},
    timers: instantTimeout,
  });
  assert.equal(res.remoteTimedOut, true);
  assert.equal(res.remoteOk, false);
  assert.equal(res.localOk, false);
  assert.equal(localCalled, 0);
  assert.equal(success, 0);
  assert.equal(failure, 1);
});

test('remote OK but local cleanup fails: still success (remote gone, orphan is cosmetic)', async () => {
  let success = 0;
  let failure = 0;
  let finalize = 0;
  const res = await runDeleteRound({
    deleteRemote: async () => {},
    deleteLocal: async () => {
      throw new Error('sqlite locked');
    },
    onSuccess: () => success++,
    onFailure: () => failure++,
    finalize: () => finalize++,
    timers: noFireTimers,
  });
  assert.equal(res.remoteOk, true);
  assert.equal(res.localOk, false);
  assert.equal(success, 1);
  assert.equal(failure, 0);
  assert.equal(finalize, 1);
});

test('default real timer path bounds a hanging cloud call → failure + finalize', async () => {
  let failure = 0;
  let finalize = 0;
  const res = await runDeleteRound({
    deleteRemote: hangs,
    deleteLocal: async () => {},
    onSuccess: () => {},
    onFailure: () => failure++,
    finalize: () => finalize++,
    timeoutMs: 5, // real setTimeout, kept tiny so the test stays fast
  });
  assert.equal(res.remoteTimedOut, true);
  assert.equal(failure, 1);
  assert.equal(finalize, 1);
});

test('the cloud timeout default is a sane, bounded value', () => {
  assert.ok(DELETE_ROUND_CLOUD_TIMEOUT_MS > 0);
  assert.ok(DELETE_ROUND_CLOUD_TIMEOUT_MS <= 15000);
});
