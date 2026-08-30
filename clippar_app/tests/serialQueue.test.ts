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
  // This used to require `binKey()` BY NAME in the two purge paths — so
  // giving them the stronger deleteClipToBin shape (resolve inline, then close
  // the gate against that same id) turned it red. Fifth assertion tonight
  // watching the shape of the code rather than the property.
  //
  // The property is: exactly one resolution decides the job, however it is
  // spelled. restoreClipFromBin still threads binKey(); the destructive paths
  // resolve inline because they must ALSO bind an ownership read to the same
  // id, which binKey() cannot hand back.
  for (const fn of ['restoreClipFromBin', 'purgeClipFromBin', 'purgeAllBinnedClips']) {
    const body = bin.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.notEqual(body, '', `${fn} should still exist`);
    const resolutions =
      (body.match(/await binKey\(\)/g) ?? []).length +
      (body.match(/await currentSessionUserId\(\)/g) ?? []).length;
    assert.equal(resolutions, 1, `${fn} must resolve the account exactly once per job`);
    assert.doesNotMatch(
      body,
      /await (readBin|writeBin)\(/,
      `${fn} must use the key-taking readBinAt/writeBinAt, which cannot re-resolve`
    );
  }
});

// Every path that touches an entry binds its key to a scoped ownership read,
// exactly as deleteClipToBin does — the key alone was the only thing naming
// whose footage got read, restored or destroyed.
//
// This test used to REQUIRE that restore was ungated, with the reason inline:
// "gating restore would make an entry whose round is gone unrecoverable". That
// is false, and the predicate's own null-tolerance is why — `round == null`
// passes. So the assertion was holding the weaker behaviour in place, which is
// the same defect as the four other tests of mine that pinned a buggy shape.
test('every bin path binds ownership, and the predicate stays null-tolerant', () => {
  const helper = bin.match(/async function entryOwnedBy[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(helper, '', 'the shared ownership gate should exist');
  assert.match(
    helper,
    /round == null \|\| round\.user_id === userId/,
    'a genuinely missing round stays purgeable; a foreign one does not'
  );

  for (const fn of ['purgeClipFromBin', 'purgeAllBinnedClips']) {
    const body = bin.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.match(body, /entryOwnedBy\(/, `${fn} must gate on ownership before unlinking`);
    assert.match(body, /const key = BIN_KEY_PREFIX \+ userId;/, `${fn} must build the key from that same id`);
  }

  // Partition, never blank: an entry this account cannot prove it owns is
  // written BACK, so refusing never destroys the record while leaving the files.
  const all = bin.match(/export async function purgeAllBinnedClips[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(all, /await writeBinAt\(key, kept\)/, 'unowned entries must be written back');
  assert.doesNotMatch(all, /writeBinAt\(key, \[\]\)/, 'blanking the key destroys other accounts’ records');
  assert.ok(
    all.indexOf('await writeBinAt(key, kept)') < all.indexOf('purgeEntry(entry)'),
    'shrink the list before unlinking, so a stalled unlink leaves no dangling entry'
  );

  const restore = bin.match(/export async function restoreClipFromBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(
    restore,
    /entryOwnedBy\(/,
    'restore must not hand one account a row from another account’s bin'
  );
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
  // This required `drainLegacyBin()` with EMPTY PARENS by name, so giving the
  // drain the ownership binding the other three gates have turned it red.
  // Sixth assertion tonight watching the shape of the code rather than the
  // property. The property is stronger now: every mutation drains, and the
  // drain is authorised by the SAME id that keys the job.
  for (const fn of ['deleteClipToBin', 'restoreClipFromBin', 'purgeClipFromBin', 'purgeAllBinnedClips']) {
    const body = bin.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.match(body, /await drainLegacyBin\(userId\)/, `${fn} must drain the legacy bin, bound to its own resolution`);
    assert.ok(
      body.indexOf('await drainLegacyBin(userId)') < body.indexOf('await readBinAt('),
      `${fn} must drain before reading its own bin`
    );
  }
  // The drain itself must bind, not merely check for a row coming back.
  const drain = bin.match(/async function drainLegacyBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(
    drain,
    /owned && owned\.user_id === userId \? mine : others/,
    'the drain unlinks files, so it needs the binding the other gates have'
  );
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

// A binned clip has no local_clips row, so no walk over rounds reaches its
// video files — both wipe entry points have to purge the bin explicitly, and
// both have to do it BEFORE clearLocalDatabase deletes the bin key, because
// once that metadata is gone nothing names those files.
//
// removeLocalMediaForCurrentUser got this in the original fix and
// wipeLocalUserData — the STRONGER promise, account deletion — did not. It
// leaned on the directory sweep that runs after it, and changing that sweep
// correctly would have silently stopped reclaiming a deleted account's binned
// videos with nothing going red. This pins the ordering so it cannot drift
// back. (Why the sweep must change: finding 12, private tracker — unfixed and
// live, so not restated in a public file.)
test('both wipe paths purge the bin, and before the metadata is dropped', () => {
  const wipe = readFileSync(join(root, 'lib/localWipe.ts'), 'utf8');

  for (const fn of ['wipeLocalUserData', 'removeLocalMediaForCurrentUser']) {
    const body = wipe.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.notEqual(body, '', `${fn} should still exist`);
    assert.match(body, /await purgeAllBinnedClips\(\)/, `${fn} must purge the bin explicitly`);
  }

  // Ordering, in the one path where the metadata delete is in the same
  // function. Anchored on the CALL form, not the bare name: the comments above
  // these lines discuss both functions by name, so an `indexOf` on the name
  // alone measures where the prose sits. (It did, and this assertion failed
  // against correct code until it was pinned properly — the same "the
  // assertion is not watching the property" mistake as the call-site count.)
  const full = wipe.match(/export async function wipeLocalUserData[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(
    full.indexOf('await purgeAllBinnedClips()') < full.indexOf('await clearLocalDatabase()'),
    'the purge must run before clearLocalDatabase drops the bin key'
  );
  assert.ok(
    full.indexOf('await purgeAllBinnedClips()') < full.indexOf('await removeOwnedMediaDirectories()'),
    'and must not depend on the wholesale directory sweep to reclaim the files'
  );
});

// This branch gave two device-wide local_settings registries an owner stamp
// (training.sessions.v1, tutorial.created_round_ids) AND extended
// clearLocalDatabase's scoped-delete list — and did not add these two to the
// list it extended. So account deletion left the departing user's id, every
// practice round id with its start timestamp, and every tutorial round id in
// plaintext on the handset. Permanently: both registries are only ever pruned
// for the account that is currently signed in, and a deleted account never
// signs in again.
//
// The scrub has to be a filter, not a key delete: the rows are shared, so
// dropping either key destroys the other account's entries — the same mistake
// already caught for the legacy bin row.
test('account deletion scrubs the departing account from both registries', () => {
  const wipe = readFileSync(join(root, 'lib/localWipe.ts'), 'utf8');
  const training = readFileSync(join(root, 'lib/training.ts'), 'utf8');
  const tutorial = readFileSync(join(root, 'lib/tutorialRound.ts'), 'utf8');

  const body = wipe.match(/export async function wipeLocalUserData[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(body, '', 'wipeLocalUserData should still exist');
  assert.match(body, /forgetTrainingSessionsFor\(me\)/, 'practice sessions must be scrubbed');
  assert.match(body, /forgetCreatedRoundsFor\(me\)/, 'tutorial round ids must be scrubbed');

  // Must resolve the departing account BEFORE clearLocalDatabase — after it,
  // there is nothing left to attribute the entries to.
  assert.ok(
    body.indexOf('forgetTrainingSessionsFor') < body.indexOf('await clearLocalDatabase()'),
    'the scrub must run while the session still resolves'
  );

  // Filter, never a blanket delete of the shared key.
  for (const [src, fn, name] of [
    [training, 'forgetTrainingSessionsFor', 'training.sessions.v1'],
    [tutorial, 'forgetCreatedRoundsFor', 'tutorial.created_round_ids'],
  ] as const) {
    const helper = src.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.notEqual(helper, '', `${fn} should exist in the module that owns the entry shape`);
    assert.match(
      helper,
      /\.filter\(\((?:s|e)\) => (?:s|e)\.userId !== userId\)/,
      `${name} must be filtered by owner, not deleted wholesale`
    );
  }
});

// The split-resolution defect, as a property over EVERY gate rather than one.
//
// deleteClipToBin diagnosed it and closed it: a stamp checked against one
// resolution of the session and a row returned by getLocalRound — which
// resolves the session again, internally — are two answers that were never
// compared. `!= null` only says "somebody's row came back".
//
// ownsRound and sweepTutorialRounds were written in the same sitting, over the
// same primitive, and neither got the line. Written as a loop over all three
// so the next gate cannot be the one that misses it — the previous version of
// this rule lived in one test about one function, which is how two siblings
// stayed open while the pattern was catalogued fourteen times.
test('every ownership gate binds the row owner back to its own resolution', () => {
  const training = readFileSync(join(root, 'lib/training.ts'), 'utf8');
  const tutorial = readFileSync(join(root, 'lib/tutorialRound.ts'), 'utf8');

  const owns = training.match(/async function ownsRound[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(owns, '', 'ownsRound should still exist');
  assert.match(
    owns,
    /round != null && round\.user_id === me/,
    'the row must be bound to the id that passed the stamp check, not merely non-null'
  );
  assert.doesNotMatch(
    owns,
    /return \(await getLocalRound\(roundId\)\) != null;/,
    'a bare non-null check accepts a row scoped to a DIFFERENT resolution'
  );

  const sweep = tutorial.match(/export async function sweepTutorialRounds[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(sweep, '', 'sweepTutorialRounds should still exist');
  assert.match(
    sweep,
    /if \(row && row\.user_id !== me\) continue;/,
    'the sweep must bind the row owner before the unscoped delete'
  );
  // `row &&` is load-bearing: a null row still means "already gone locally".
  assert.doesNotMatch(
    sweep,
    /if \(row\.user_id !== me\) continue;/,
    'dropping the row-null guard would break the offline-retry path'
  );
  assert.ok(
    sweep.indexOf('row.user_id !== me') < sweep.indexOf('deleteLocalRound(id)'),
    'the binding must precede the unscoped delete'
  );

  // And the one that already had it, so the property stays stated in one place.
  const del = bin.match(/export async function deleteClipToBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(del, /round\.user_id !== userId/, 'deleteClipToBin keeps its binding');
});
