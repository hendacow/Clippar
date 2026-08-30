import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createSerialQueue } from '../lib/serialQueue';

const root = join(import.meta.dirname, '..');
const bin = readFileSync(join(root, 'lib/clipBin.ts'), 'utf8');

// ---------------------------------------------------------------------------
// The primitive, tested for real (no expo imports, so this actually runs).
// ---------------------------------------------------------------------------

test('queued jobs never overlap', async () => {
  const q = createSerialQueue();
  let running = 0;
  let maxConcurrent = 0;

  const job = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
  };

  await Promise.all([q.run(job), q.run(job), q.run(job), q.run(job)]);
  assert.equal(maxConcurrent, 1, 'jobs must not interleave');
});

// This is the bug the queue exists to prevent, reproduced against a fake of
// the settings table: read the list, mutate in JS, write it back. Without
// serialisation the second writer computes from a pre-first-write snapshot
// and the first entry vanishes — in clipBin that entry is the only record of
// a clip that has ALREADY been removed from SQLite.
test('unserialised read-modify-write loses an entry; the queue does not', async () => {
  const makeStore = () => {
    let value: string[] = [];
    return {
      read: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return value;
      },
      write: async (next: string[]) => {
        await new Promise((r) => setTimeout(r, 1));
        value = next;
      },
      get current() {
        return value;
      },
    };
  };

  const unsafe = makeStore();
  const append = (store: ReturnType<typeof makeStore>, id: string) => async () => {
    const entries = await store.read();
    await store.write([id, ...entries]);
  };

  await Promise.all([append(unsafe, 'a')(), append(unsafe, 'b')()]);
  assert.equal(unsafe.current.length, 1, 'the unserialised version loses one — this is the bug');

  const safe = makeStore();
  const q = createSerialQueue();
  await Promise.all([q.run(append(safe, 'a')), q.run(append(safe, 'b'))]);
  assert.equal(safe.current.length, 2, 'both entries survive when serialised');
  assert.deepEqual([...safe.current].sort(), ['a', 'b']);
});

test('a rejected job does not wedge the queue for later callers', async () => {
  const q = createSerialQueue();
  await assert.rejects(q.run(async () => { throw new Error('boom'); }));
  assert.equal(await q.run(async () => 'still works'), 'still works');
});

// ---------------------------------------------------------------------------
// The bin has to actually use it, or the above proves nothing about clip loss.
// ---------------------------------------------------------------------------

test('every clip-bin mutation runs through the queue', () => {
  assert.match(bin, /createSerialQueue/, 'clipBin must import the queue');
  for (const fn of ['deleteClipToBin', 'restoreClipFromBin', 'purgeClipFromBin']) {
    const body = bin.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.notEqual(body, '', `${fn} should still exist`);
    assert.match(body, /binQueue\.run\(/, `${fn} must serialise its read-modify-write`);
  }
});

// deleteLocalClip runs BEFORE the bin write. If the write fails the row is
// already gone, so the delete must be undone rather than left unrecoverable.
test('a failed bin write puts the clip row back', () => {
  const body = bin.match(/export async function deleteClipToBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(body, /catch/, 'the bin write needs a failure path');
  assert.match(body, /restoreLocalClip\(row\)/, 'a failed bin write must restore the deleted row');
});
