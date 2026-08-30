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

// ---------------------------------------------------------------------------
// Account scoping. One clippar.db is shared by every account that signs in on
// the handset and sign-out deliberately does not wipe it (lib/localScope.ts),
// so a device-wide bin would show user A's deleted shots to user B — and B's
// "Delete for good" would unlink A's video files.
// ---------------------------------------------------------------------------

test('the bin key is per account, not per handset', () => {
  assert.doesNotMatch(
    bin,
    /const BIN_KEY = ['"]clips\.bin\.v1['"]/,
    'a single device-wide key leaks one account’s deletions to the next'
  );
  assert.match(bin, /BIN_KEY_PREFIX/, 'the key must carry the owning user id');
  assert.match(bin, /currentSessionUserId/, 'ownership comes from the session, not the caller');
});

test('the bin fails closed when no session resolves', () => {
  const key = bin.match(/async function binKey[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(key, '', 'binKey should exist');
  assert.match(key, /userId \?.*: null/s, 'no session must yield no key, never a shared one');

  const del = bin.match(/export async function deleteClipToBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(
    del,
    /const userId = await currentSessionUserId\(\)\.catch\(\(\) => null\);\s*\n\s*if \(!userId\) return null;/,
    'a delete with nowhere to record recovery must refuse, not proceed'
  );
  // The refusal has to come before deleteLocalClip, or the row is already gone.
  assert.ok(
    del.indexOf('if (!userId) return null;') < del.indexOf('await deleteLocalClip('),
    'the ownership check must precede the row delete'
  );
});

// Counting binKey() call sites is not the same as counting session
// resolutions. deleteClipToBin resolved once through binKey and a SECOND time
// inside getLocalRound, and the two authorised different halves of the job —
// which bin to write, and whether the clip may be deleted. Those two answers
// are not guaranteed to agree (finding 32, private tracker — unfixed and live,
// so not restated in a public repo), and a divergence there makes the
// operation looser rather than stricter. The property to pin is that ONE id
// decides both.
test('the bin key and the ownership gate are decided by the same resolution', () => {
  const del = bin.match(/export async function deleteClipToBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(del, '', 'deleteClipToBin should still exist');
  assert.equal(
    (del.match(/await currentSessionUserId\(\)/g) ?? []).length,
    1,
    'exactly one session resolution may decide this job'
  );
  assert.match(
    del,
    /const key = BIN_KEY_PREFIX \+ userId;/,
    'the bin written must be built from that one resolution'
  );
  assert.match(
    del,
    /if \(!round \|\| round\.user_id !== userId\) return null;/,
    'and the gate must close against it, not against getLocalRound’s own resolution'
  );
  assert.ok(
    del.indexOf('round.user_id !== userId') < del.indexOf('await deleteLocalClip('),
    'the binding must be asserted before the row is removed'
  );
});

// binQueue orders jobs against each other, not against auth changes, and two
// resolutions inside one job are not guaranteed to agree (finding 32, private
// tracker) — so resolving the owner more than once per job means a read and a
// write can straddle two accounts.
test('each queued job resolves the owning account exactly once', () => {
  // deleteClipToBin is not in this list: it resolves the id directly so the
  // gate can close against the same value, and the test above pins that
  // stronger property instead.
  for (const fn of ['restoreClipFromBin', 'purgeClipFromBin', 'purgeAllBinnedClips']) {
    const body = bin.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.notEqual(body, '', `${fn} should still exist`);
    assert.equal(
      (body.match(/await binKey\(\)/g) ?? []).length,
      1,
      `${fn} must resolve the account once and thread the key`
    );
    assert.doesNotMatch(
      body,
      /await (readBin|writeBin)\(/,
      `${fn} must use the key-taking readBinAt/writeBinAt, which cannot re-resolve`
    );
  }
});

// Renaming the key stranded every entry written by an earlier build: nothing
// read the old row, so nothing unlinked the videos it pinned — and
// "remove my videos from this phone" walked straight past them.
test('the pre-scoping device-wide bin is drained, not orphaned', () => {
  assert.match(bin, /const LEGACY_BIN_KEY = 'clips\.bin\.v1'/);
  assert.match(bin, /async function drainLegacyBin/);
  // Purged, never adopted: adopting would hand the next account the previous
  // one's entries, which is the bug the scoping fixed.
  assert.doesNotMatch(
    bin.match(/async function drainLegacyBin[\s\S]*?\n}/)?.[0] ?? '',
    /writeBinAt/,
    'legacy entries must be destroyed, not migrated into a scoped bin'
  );
  for (const fn of ['deleteClipToBin', 'restoreClipFromBin', 'purgeClipFromBin', 'purgeAllBinnedClips']) {
    const body = bin.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.match(body, /await drainLegacyBin\(\)/, `${fn} must drain the legacy bin first`);
  }
  // And the wipe must NOT blanket-delete it: the row is device-wide, so
  // dropping it under B loses A's recovery records and orphans A's files.
  // drainLegacyBin's owner partition is the only correct treatment.
  const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
  const scoped = storage.match(/const scopedDeletes[\s\S]*?\n  \];/)?.[0] ?? '';
  assert.notEqual(scoped, '', 'scopedDeletes should still exist');
  assert.doesNotMatch(
    scoped,
    /\['clips\.bin\.v1'\]/,
    'a blanket delete of the device-wide legacy key destroys other accounts’ entries'
  );
  assert.match(scoped, /clips\.bin\.v1\.\$\{ownerUserId\}/, 'the per-account key still goes');
});

// The first drain purged the WHOLE legacy list, on the reasoning that its
// entries could not be attributed to an account. Wrong, and in the dangerous
// direction: the legacy row is device-wide, so draining it under B unlinks A's
// video files — the very cross-account destruction the scoping exists to stop.
// Ownership IS recoverable: only the clip row was deleted, the round row
// survives, and getLocalRound is scoped and fails closed.
test('the legacy drain destroys only the signed-in account’s own entries', () => {
  const body = bin.match(/async function drainLegacyBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(body, '', 'drainLegacyBin should exist');
  assert.match(body, /getLocalRound\(/, 'ownership must be decided by the scoped round read');
  assert.match(body, /others/, 'entries belonging to other accounts must be kept');
  assert.match(
    body,
    /others\.length \? JSON\.stringify\(others\) : null/,
    'other accounts’ entries must be written back, not dropped'
  );
  // A latch would skip the retry that other accounts depend on.
  assert.doesNotMatch(body, /legacyDrained/, 'no latch: later accounts still need their drain');
});

// The splice is guarded where the splicing happens. Deferring this rested on
// "it changes a shared primitive with a caller outside the diff" — but all
// three call sites pass rows from `SELECT * FROM local_clips`, whose every
// column (schema + 25 ALTER TABLE migrations) is plain snake_case, so no
// existing caller's behaviour moves at all.
test('restoreLocalClip validates the identifiers it splices, not its callers', () => {
  const store = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
  const body = store.match(/export async function restoreLocalClip[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(body, '', 'restoreLocalClip should still exist');
  assert.match(store, /export const SQL_IDENTIFIER = \/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$\//);
  assert.match(body, /columns\.every\(\(c\) => SQL_IDENTIFIER\.test\(c\)\)/);
  // The check must precede the interpolation, or it guards nothing.
  assert.ok(
    body.indexOf('SQL_IDENTIFIER.test') < body.indexOf('columns.join'),
    'validate before splicing'
  );
  // A refusal must NOT return false. `false` already means "the row is
  // already back, nothing to undo", and restoreClipFromBin drops the bin entry
  // on it — so overloading false with "I refused" would destroy the clip.
  assert.match(body, /throw new Error\('restoreLocalClip: refusing/);
  const restoreFromBin = bin.match(/export async function restoreClipFromBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(
    restoreFromBin,
    /const restored = await restoreLocalClip\(entry\.row\);\s*\n\s*await writeBinAt/,
    'the entry is dropped after a false return — which is why a refusal throws'
  );
});

// restoreLocalClip interpolates Object.keys(row) into INSERT ... unescaped,
// justified by a docstring saying the keys "come from the row the database
// itself handed us". This module broke that invariant by persisting the row as
// JSON in local_settings, so the keys now come from JSON.parse.
test('bin entries are validated where the JSON blob re-enters', () => {
  assert.match(bin, /function isValidEntry/, 'the trust boundary needs a shape check');
  const read = bin.match(/async function readBinAt[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(read, /parsed\.filter\(isValidEntry\)/, 'readBinAt must validate, not cast');
  assert.doesNotMatch(read, /as BinnedClip\[\]/, 'a cast is not a shape check');

  const validator = bin.match(/function isValidEntry[\s\S]*?\n}/)?.[0] ?? '';
  // Column names reach SQL as identifiers, so they get an identifier check.
  // The source-side check stays because isValidEntry also gates PURGING, which
  // unlinks files without ever reaching restoreLocalClip — but the regex is
  // imported, not redeclared, so the two halves cannot drift.
  assert.match(validator, /SQL_IDENTIFIER\.test\(c\)/);
  assert.doesNotMatch(
    bin,
    /const SQL_IDENTIFIER = /,
    'one definition, imported — two copies drift into two ideas of "safe"'
  );
  assert.match(bin, /import \{[^}]*SQL_IDENTIFIER[^}]*\} from '@\/lib\/storage'/);
  // fileUris reach a file delete, so they are re-checked here.
  //
  // Matched loosely, and that is the point. `startsWith('file://')` is a
  // PREFIX test, not containment — finding 35, still open. Pinning it by name
  // would turn this assertion red the moment someone lands the containment
  // predicate, which is a security test punishing the security fix: exactly
  // the defect fixed in `reportsCarryNoSecrets.test.ts` at 26c0517, in another
  // file, missed here. What must hold is that SOME uri guard runs before a
  // uri can reach a delete — not which one.
  assert.match(
    validator,
    /startsWith\('file:\/\/'\)|isInside[A-Za-z]*\(/,
    'fileUris must be checked before they can reach an unlink'
  );
  // The ownership decision is made on e.roundId; everything destructive acts
  // on e.row. Unbound, the gate authorises one field and destroys another.
  assert.match(validator, /e\.row\.round_id !== e\.roundId/, 'the two round ids must be bound');

  // purgeEntry is the unlink side of the same boundary.
  const purge = bin.match(/async function purgeEntry[\s\S]*?\n}/)?.[0] ?? '';
  // Same loose match, same reason — and the ordering matters more than the
  // predicate: whatever the guard is, `continue` must precede `deleteFile`.
  assert.match(
    purge,
    /startsWith\('file:\/\/'\)|isInside[A-Za-z]*\(/,
    'the unlink side must re-check the uri too'
  );
  assert.ok(
    purge.indexOf('continue') < purge.indexOf('deleteFile('),
    'the uri guard must reject before the delete, not after'
  );

  // The legacy drain reads the same shape and also feeds purgeEntry.
  const drain = bin.match(/async function drainLegacyBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(drain, /isValidEntry\(entry\)/);
});

// deleteLocalClip is `DELETE FROM local_clips WHERE id = ?` with no ownership
// predicate and clip ids are small sequential integers, so callers gating it
// upstream is a property of today's call sites, not of the function.
// And the gate has to constrain the thing being deleted. The first version
// checked `roundId` while the delete keyed on `clipId` — two independent
// arguments with nothing binding them, so an owned round id paired with any
// other clip id passed. That read as protection and provided none.
test('the destructive primitive derives the round from the clip, not the caller', () => {
  const del = bin.match(/export async function deleteClipToBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(del, /getLocalClipRound\(clipId\)/, 'the round must come off the clip');
  assert.doesNotMatch(
    del,
    /getLocalRound\(roundId\)/,
    'validating the caller-supplied roundId proves nothing about clipId'
  );
  assert.match(del, /getLocalRound\(ownerRoundId\)/, 'the clip’s own round must be the one checked');
  // Match the CALLS, not prose — the comment above the guard names
  // deleteLocalClip while explaining why the guard is there.
  assert.ok(
    del.indexOf('await getLocalRound(ownerRoundId)') < del.indexOf('await deleteLocalClip('),
    'the ownership check must precede the delete'
  );
  // The stored entry must not carry a round the caller invented, or
  // listBinnedClips(roundId) filters on a made-up value.
  assert.match(del, /roundId: typeof row\.round_id === 'string'/);
});

// local_rounds.user_id is reassignable by another account's sign-in (the
// NULL-owner backfill), so the row alone cannot decide ownership.
test('training ownership requires the registry stamp as well as the row', () => {
  const training = readFileSync(join(root, 'lib/training.ts'), 'utf8');
  const owns = training.match(/async function ownsRound[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(owns, /ref\.userId !== me/, 'the stamp must be checked');
  assert.match(owns, /getLocalRound\(roundId\)/, 'and so must the row');
  assert.match(owns, /if \(!me\) return false;/, 'no session owns nothing');
  assert.match(
    training,
    /export async function startTrainingSession[\s\S]*?userId: owner/,
    'sessions must be stamped at creation'
  );
});

// getLocalRound returns null for "already gone" AND "not yours"; deleteLocalRound
// is unscoped and unlinks clip files by round_id alone.
test('the tutorial sweep never runs the unscoped delete on a null row', () => {
  const tutorial = readFileSync(join(root, 'lib/tutorialRound.ts'), 'utf8');
  const sweep = tutorial.match(/export async function sweepTutorialRounds[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(
    sweep,
    /const localOk = row\s*\n?\s*\?/,
    'the local delete must be conditional on the scoped read returning a row'
  );
});

// removeLocalMediaForCurrentUser walks rounds via deleteLocalRound, and a
// binned clip has no local_clips row — so without an explicit purge its video
// files survive the one action whose purpose is removing them.
test('"remove my videos" empties the bin too', () => {
  const wipe = readFileSync(join(root, 'lib/localWipe.ts'), 'utf8');
  const body = wipe.match(/export async function removeLocalMediaForCurrentUser[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(body, /purgeAllBinnedClips/, 'binned videos must go with the rest');
  assert.match(bin, /export async function purgeAllBinnedClips/);
});

// The sign-out wipe drops rows by owner; the bin's metadata must go with it.
test('clearLocalDatabase drops the departing account’s bin key', () => {
  const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
  assert.match(storage, /clips\.bin\.v1\.\$\{ownerUserId\}/);
});
