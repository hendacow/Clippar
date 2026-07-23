import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runDeleteRound,
  DELETE_ROUND_CLOUD_TIMEOUT_MS,
  type TimerApi,
} from '../lib/roundDeleteLogic';

// The round-detail "Delete round" flow must (1) remove the LOCAL copy first so
// the round leaves the library even offline, (2) never let a hanging cloud
// call wedge the "Deleting round..." overlay, and (3) ALWAYS finalize
// (setDeleting(false) + navigate). These tests lock those guarantees down.

// Timers that never auto-fire: the remote promise wins the race normally.
const noFireTimers: TimerApi = { set: () => 'h', clear: () => {} };
// Timers that fire the timeout synchronously: simulates the bound elapsing
// before a hanging remote settles.
const instantTimeout: TimerApi = {
  set: (cb) => {
    cb();
    return 'h';
  },
  clear: () => {},
};

const hangs = () => new Promise<void>(() => {}); // never resolves

test('local delete runs before the remote delete', async () => {
  const calls: string[] = [];
  await runDeleteRound({
    deleteLocal: async () => {
      // Force a microtask hop so a mis-ordered impl would interleave.
      await Promise.resolve();
      calls.push('local');
    },
    deleteRemote: async () => {
      calls.push('remote');
    },
    finalize: () => {},
    timers: noFireTimers,
  });
  assert.deepEqual(calls, ['local', 'remote']);
});

test('happy path: both delete, onSuccess + finalize fire once each', async () => {
  let success = 0;
  let finalize = 0;
  const res = await runDeleteRound({
    deleteLocal: async () => {},
    deleteRemote: async () => {},
    onSuccess: () => success++,
    finalize: () => finalize++,
    timers: noFireTimers,
  });
  assert.equal(res.localOk, true);
  assert.equal(res.remoteOk, true);
  assert.equal(res.remoteTimedOut, false);
  assert.equal(success, 1);
  assert.equal(finalize, 1);
});

test('hanging cloud call times out — finalize still runs (overlay cannot wedge)', async () => {
  let finalize = 0;
  let success = 0;
  const res = await runDeleteRound({
    deleteLocal: async () => {},
    deleteRemote: hangs, // would wedge the overlay without a bound
    onSuccess: () => success++,
    finalize: () => finalize++,
    timers: instantTimeout,
  });
  assert.equal(res.localOk, true);
  assert.equal(res.remoteOk, false);
  assert.equal(res.remoteTimedOut, true);
  // Local delete succeeded, so the round IS gone from the library — celebrate.
  assert.equal(success, 1);
  assert.equal(finalize, 1);
});

test('offline: local succeeds even though the cloud call never settles', async () => {
  let localDeleted = false;
  const res = await runDeleteRound({
    deleteLocal: async () => {
      localDeleted = true;
    },
    deleteRemote: hangs,
    finalize: () => {},
    timers: instantTimeout,
  });
  assert.equal(localDeleted, true);
  assert.equal(res.localOk, true);
});

test('both sides throw — finalize still runs, onSuccess does not', async () => {
  let finalize = 0;
  let success = 0;
  const res = await runDeleteRound({
    deleteLocal: async () => {
      throw new Error('sqlite locked');
    },
    deleteRemote: async () => {
      throw new Error('network down');
    },
    onSuccess: () => success++,
    finalize: () => finalize++,
    timers: noFireTimers,
  });
  assert.equal(res.localOk, false);
  assert.equal(res.remoteOk, false);
  assert.equal(res.remoteTimedOut, false);
  assert.equal(success, 0);
  assert.equal(finalize, 1);
});

test('remote throws but local succeeded — round still removed, finalize runs', async () => {
  let finalize = 0;
  let success = 0;
  const res = await runDeleteRound({
    deleteLocal: async () => {},
    deleteRemote: async () => {
      throw new Error('supabase 500');
    },
    onSuccess: () => success++,
    finalize: () => finalize++,
    timers: noFireTimers,
  });
  assert.equal(res.localOk, true);
  assert.equal(res.remoteOk, false);
  assert.equal(success, 1);
  assert.equal(finalize, 1);
});

test('default real timer path bounds a hanging cloud call', async () => {
  let finalize = 0;
  const res = await runDeleteRound({
    deleteLocal: async () => {},
    deleteRemote: hangs,
    finalize: () => finalize++,
    timeoutMs: 5, // real setTimeout, kept tiny so the test stays fast
  });
  assert.equal(res.remoteTimedOut, true);
  assert.equal(finalize, 1);
});

test('the cloud timeout default is a sane, bounded value', () => {
  assert.ok(DELETE_ROUND_CLOUD_TIMEOUT_MS > 0);
  assert.ok(DELETE_ROUND_CLOUD_TIMEOUT_MS <= 15000);
});
