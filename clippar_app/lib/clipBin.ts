/**
 * Recently deleted clips — the recoverable bin.
 *
 * Deleting a clip used to be cosmetic: `useEditorState.removeClip` filtered it
 * out of React state and never touched SQLite, so the editor's focus reload
 * put it straight back. Making the delete persist fixes that, but on its own
 * it turns a bug that lost nothing into one that loses a shot permanently on a
 * single tap. This module is the other half: every persisted delete lands here
 * first, and the underlying video files are deliberately NOT unlinked until a
 * clip leaves the bin.
 *
 * Storage is the existing `local_settings` key/value table rather than a new
 * column, so this needs no migration and cannot fail a schema check on a
 * device that already has rounds on it. The value is the JSON array of whole
 * rows that `deleteLocalClip` hands back — which is exactly the shape
 * `restoreLocalClip` wants, primary key included, so a restore lines back up
 * with anything still holding that id.
 */
import { getSetting, setSetting, deleteLocalClip, restoreLocalClip, commitClipDeletion, currentSessionUserId, getLocalRound, getLocalRoundOwner, getLocalClipRound, SQL_IDENTIFIER, type LocalClipRow } from '@/lib/storage';
import { deleteFile } from 'shot-detector';
import { createSerialQueue } from '@/lib/serialQueue';

/**
 * The bin is keyed PER ACCOUNT, not per handset.
 *
 * One `clippar.db` is shared by every account that ever signs in, and sign-out
 * deliberately does not wipe it — `lib/localScope.ts` explains why (this app
 * holds the only copy of footage that cannot be re-recorded) and scopes the
 * round reads instead. A single `clips.bin.v1` row would have walked straight
 * past that: user A deletes shots and hands the phone over; B signs in, opens
 * Profile → Recently deleted, and sees A's entries — because
 * `listBinnedClips()` had no ownership filter. "Delete for good" would then
 * unlink A's video files, and "Put back" would reinsert A's row under B's
 * session. Irreversible destruction of another account's footage from an
 * ordinary screen.
 *
 * `local_settings` has no owner column, so ownership lives in the key, exactly
 * as `pro.status_cache.<userId>` already does. `clearLocalDatabase` deletes
 * this key for the account it wipes.
 */
const BIN_KEY_PREFIX = 'clips.bin.v1.';

/**
 * Fails CLOSED. With no resolvable session there is no bin — never the shared
 * one — so a read returns nothing and a delete refuses rather than removing a
 * row it cannot record.
 */
async function binKey(): Promise<string | null> {
  try {
    const userId = await currentSessionUserId();
    return userId ? BIN_KEY_PREFIX + userId : null;
  } catch {
    return null;
  }
}

/**
 * Every mutation below is read-bin → change it → write-bin, over a single
 * `local_settings` row with no transaction around it (see lib/serialQueue).
 * Two overlapping deletes would both read the same array and the second write
 * would drop the first one's entry — leaving that clip deleted from SQLite
 * with no recovery record, moments after the UI promised one.
 *
 * The window is small (both delete affordances in the editor confirm through
 * an Alert first, so back-to-back taps are hundreds of ms apart) and
 * `useEditorState.removeClip` fires this WITHOUT awaiting, which is what makes
 * overlap possible at all. Serialising costs nothing at these call rates and
 * removes the failure mode rather than relying on the user being slow.
 */
const binQueue = createSerialQueue();

/**
 * How many deletes we keep recoverable. Each entry pins its video files on
 * disk, so this is a storage cost, not just a list length — a golfer who
 * deletes fifty shots is holding fifty clips' worth of video. When the cap is
 * passed the OLDEST entries are committed for real: predecessor tracer stale
 * applied, files unlinked. That is the only place this module destroys
 * anything, and it is why the number is small rather than generous.
 */
const MAX_ENTRIES = 30;

export interface BinnedClip {
  /** The clip row exactly as SQLite held it — restoreLocalClip's input. */
  row: LocalClipRow;
  /** Video files kept alive for this entry. Unlinked only on purge. */
  fileUris: string[];
  /** ISO timestamp of the delete, for "deleted 5 minutes ago". */
  deletedAt: string;
  /** Round it came from, so the bin can be filtered per round. */
  roundId: string;
}

/**
 * Read/write take the key as an ARGUMENT rather than resolving it themselves.
 *
 * Each mutation used to resolve the owner up to three times across await
 * points — the guard, then `readBin`, then `writeBin` — and `binQueue`
 * serialises jobs against each other, not against auth changes.
 * The session resolver can also disagree with itself across await points, so
 * consecutive calls inside one job are not guaranteed to return the same
 * account — which on a shared handset is a cross-account destruction path.
 * Mechanism not spelled out here (public file, unfixed finding): see findings
 * 31 and 32 in `org/cto/SECURITY-2026-08-30-unfixed.md`, private repo.
 *
 * So every queued job resolves the key ONCE and threads it through.
 */
/**
 * A bin entry is only trustworthy if it still looks like one after a round
 * trip through JSON — and this module is what put a JSON round trip in the
 * middle of it.
 *
 * `restoreLocalClip` interpolates `Object.keys(row)` into
 * `INSERT INTO local_clips (...)` unescaped, and its docstring justifies that
 * as safe because "column names come from the row the database itself handed
 * us". That was true when the row came straight from a `SELECT *`. It stopped
 * being true when the bin started persisting the row as text in
 * `local_settings`: the keys now come from `JSON.parse`, so a key like
 * `id) VALUES (1); DROP TABLE local_rounds; --` would be spliced in as an
 * identifier. Writing that blob needs sandbox access, at which point the
 * attacker can write the database directly — so this is not an exploit path
 * so much as an invariant this feature quietly broke and nothing recorded.
 *
 * `restoreLocalClip` now applies the same `SQL_IDENTIFIER` check itself, and
 * that is the one that closes the injection — a sink guards its own splice, so
 * a future caller cannot reopen this by forgetting. The check stays here as
 * well, and not merely for belt and braces: `isValidEntry` decides whether an
 * entry may be PURGED, not only whether it may be restored, and purging
 * unlinks video files without going near `restoreLocalClip`. Deleting this
 * would leave the destructive half of the boundary unguarded.
 *
 * The regex is imported rather than redeclared so the two halves cannot drift
 * apart into two different definitions of "safe".
 *
 * `fileUris` is re-checked for the `file://` prefix that `deleteLocalClip`
 * applied on the way IN, because `purgeEntry` unlinks them on the way out and
 * was not re-applying it.
 */

function isValidEntry(v: unknown): v is BinnedClip {
  if (!v || typeof v !== 'object') return false;
  const e = v as BinnedClip;
  if (typeof e.roundId !== 'string') return false;
  if (!e.row || typeof e.row !== 'object' || typeof e.row.id !== 'number') return false;
  // Bind the two. `drainLegacyBin` decides mine-vs-theirs from `e.roundId`,
  // but everything destructive then acts on `e.row` and `e.fileUris` —
  // `purgeEntry` reaches `markPredecessorTracerStale(db, row.round_id, …)`,
  // which is unscoped. An entry pairing an owned `roundId` with a foreign
  // `row.round_id` would authorise on one field and destroy another. Same
  // shape as the `deleteClipToBin` gate that validated `roundId` while the
  // delete keyed on `clipId`; a gate has to constrain the thing it protects.
  if (e.row.round_id !== e.roundId) return false;
  if (!Object.keys(e.row).every((c) => SQL_IDENTIFIER.test(c))) return false;
  if (!Array.isArray(e.fileUris)) return false;
  return e.fileUris.every((u) => typeof u === 'string' && u.startsWith('file://'));
}

/**
 * `null` means THE ROW COULD NOT BE READ — never "the bin is empty".
 *
 * The lenient reader below was written for a CORRUPT bin, and the trade in its
 * comment is about corruption: losing an unreadable recovery list beats
 * refusing to delete. **It silently covered a transient read failure too**, and
 * there the trade was never considered — `getSetting` is a bare
 * `getDatabase()` + `getFirstAsync` with no catch of its own, so a busy
 * database rejects. `deleteClipToBin` then wrote `[newEntry]` back over a bin
 * holding up to MAX_ENTRIES valid records **whose clip rows it had already
 * deleted**, orphaning their video files with nothing left naming them.
 *
 * Same split as `readRegistryStrict` in lib/training.ts, and the same reason a
 * read failure and an unreadable blob are different answers: nobody could read
 * a corrupt row either way, so overwriting it destroys nothing recoverable,
 * while refusing forever would wedge deletion permanently.
 */
async function readBinAtStrict(key: string): Promise<BinnedClip[] | null> {
  let raw: string | null;
  try {
    raw = await getSetting(key);
  } catch {
    return null;
  }
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Drop malformed entries rather than the whole list: one bad entry must
    // not cost the golfer every other recoverable clip.
    return parsed.filter(isValidEntry);
  } catch {
    // A corrupt bin must never block a delete or wedge the editor. Losing the
    // recovery list is bad; refusing to delete because we cannot read it is
    // worse, and the clip rows themselves are unaffected either way.
    return [];
  }
}

/**
 * The lenient view. Correct for callers that only LOOK UP an entry — a failed
 * read there means "not found", which they already handle without writing.
 */
async function readBinAt(key: string): Promise<BinnedClip[]> {
  return (await readBinAtStrict(key)) ?? [];
}

async function writeBinAt(key: string, entries: BinnedClip[]): Promise<void> {
  await setSetting(key, JSON.stringify(entries));
}

/** Convenience for the read-only, unqueued `listBinnedClips`. */
async function readBin(): Promise<BinnedClip[]> {
  const key = await binKey();
  return key ? readBinAt(key) : [];
}

/**
 * The pre-scoping, device-wide bin key.
 *
 * Renaming to `clips.bin.v1.<userId>` left every entry written by an earlier
 * build stranded: nothing reads the old row, so nothing ever unlinks the video
 * files it pins. `purgeAllBinnedClips` could not reach them, which means
 * "remove my videos from this phone" walked straight past up to MAX_ENTRIES
 * videos and reported success — a failed erasure on the one screen a user is
 * told to trust before handing the phone on.
 *
 * Leaving it orphaned was my first call and it was wrong: the choice is not
 * "adopt or ignore". These entries cannot be attributed to an account, so they
 * are PURGED rather than adopted — and they are clips whose owner already
 * chose to delete them, so destroying them is the correct end state, not a
 * loss. Adopting them would hand the next account the previous one's clips,
 * which is the bug this scoping fixed.
 */
const LEGACY_BIN_KEY = 'clips.bin.v1';

/**
 * Only the signed-in account's own entries are destroyed.
 *
 * The first version of this drain purged the whole legacy list, on the
 * reasoning that its entries "cannot be attributed to an account". That was
 * wrong, and wrong in the dangerous direction: the legacy row is DEVICE-WIDE,
 * so draining it wholesale under B unlinks A's video files — reintroducing
 * precisely the cross-account destruction this scoping exists to prevent.
 *
 * Ownership is in fact recoverable. Only the CLIP row was deleted; the ROUND
 * row survives, and `getLocalRound` is scoped through `ownedRoundsClause` and
 * fails closed. So entries are partitioned by round ownership: mine are
 * purged, everyone else's are written back untouched and destroyed when that
 * account next signs in.
 *
 * No latch: with entries left behind for other accounts, this has to run again
 * for whoever signs in next. It is a single settings read when the key is
 * absent, which is the steady state after the first drain.
 */
async function drainLegacyBin(userId: string): Promise<void> {
  try {
    const raw = await getSetting(LEGACY_BIN_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      // Unparseable: drop the row rather than carry a blob nothing can read.
      await setSetting(LEGACY_BIN_KEY, null);
      return;
    }
    const mine: BinnedClip[] = [];
    const others: BinnedClip[] = [];
    for (const entry of parsed) {
      // Same trust boundary as readBinAt — these entries feed purgeEntry.
      // A malformed entry is neither purged nor written back: it cannot be
      // trusted to name a file we should unlink, and carrying it forward
      // would keep an unreadable blob alive for the life of the install.
      //
      // This USED to claim wipeLocalUserData's clips/ sweep catches any real
      // files such an entry pinned. That is only half true and the half it
      // misses is the one that matters: wipeLocalUserData does sweep clips/
      // (localWipe.ts:108), but removeLocalMediaForCurrentUser — "remove my
      // videos from this phone", a caller this branch added — does not. It
      // walks owned rounds and calls removeTemporaryExports, and a binned clip
      // has no local_clips row for that walk to reach. So on the one screen
      // whose whole purpose is erasure there is NO fallback, and a malformed
      // entry's videos stay on disk with nothing pointing at them.
      //
      // Left as-is deliberately rather than silently widened: unlinking from
      // an entry that failed validation means deleting paths named by a blob
      // we just declined to trust, and purgeEntry's file:// check is a prefix
      // test rather than a containment one. That trade is Henry's to make.
      //
      // And the trade above is stated in FILES, which is only one half of what
      // `continue` does. The other half is the RECORD: an entry dropped here
      // is not written back to `others` either, so when this account has any
      // entry of its own the row is rewritten without it and a malformed entry
      // belonging to ANOTHER account is destroyed under us. `others.push(entry)`
      // is the one-line alternative and it was deliberately not taken — it
      // would push an unvalidated value into a `BinnedClip[]`, and the entry is
      // already unreachable by every reader (`readBinAt` filters on the same
      // `isValidEntry`), so what survives would be an unreadable blob kept for
      // the life of the install rather than a recoverable clip. Nothing is lost
      // that any code path could have restored.
      //
      // Recorded rather than fixed because it is a judgement call on an
      // unreachable path, not a defect: the legacy key has never been written
      // by a released build. Do not "fix" it without settling the type lie.
      if (!isValidEntry(entry)) continue;
      const owned = await getLocalRound(entry.roundId).catch(() => null);
      // BIND, same as the other three gates. `getLocalRound` resolves the
      // session itself, once per entry, across awaits — so `!= null` alone
      // only says "somebody's row came back", and `mine` goes straight to
      // purgeEntry, which unlinks video files with no bin entry and no undo.
      // This was the last destructive gate in the module without the binding.
      (owned && owned.user_id === userId ? mine : others).push(entry);
    }
    if (mine.length === 0) return;
    // Shrink the list BEFORE unlinking, so a stalled delete cannot leave an
    // entry pointing at a video the user has already asked us to remove.
    await setSetting(LEGACY_BIN_KEY, others.length ? JSON.stringify(others) : null);
    for (const entry of mine) await purgeEntry(entry);
  } catch {
    // Never throw from a migration path — a failed drain must not block a
    // delete. The row survives and the next attempt retries it.
  }
}

/**
 * Delete a clip for real, but recoverably.
 *
 * `stalePredecessor: false` is not optional here. Staling the same-hole
 * predecessor's tracer nulls a column AND unlinks a rendered file, so doing it
 * at delete time would make a later restore silently degrade the neighbouring
 * clip. deleteLocalClip documents this contract; we honour it by deferring to
 * commitClipDeletion at purge time.
 */
export async function deleteClipToBin(clipId: number, roundId: string): Promise<BinnedClip | null> {
  return binQueue.run(async () => {
    // Resolved ONCE, and BEFORE the row is touched. Once, so every read and
    // write below belongs to this account even if the session changes
    // underneath us. Before, because with no session there is nowhere to
    // record the recovery entry, and a delete we cannot undo is exactly what
    // this module exists to prevent — so refuse rather than remove the row and
    // rely on the rollback below.
    //
    // Resolved inline rather than through binKey() so the SAME id is available
    // to close the gate below. binKey() threaded the key through every read
    // and write, which fixed only half of this: getLocalRound re-resolves the
    // session internally, so the bin we write and the rounds we may delete
    // from were authorised by two independent resolutions, which are not
    // guaranteed to agree. Because they authorise different halves of one
    // operation, a divergence made this LOOSER rather than stricter.
    //
    // Why they can disagree is finding 32 in the private tracker
    // (`org/cto/SECURITY-2026-08-30-unfixed.md`, company-brain). Deliberately
    // not restated here: it is unfixed and live in shipped code, and this
    // repository is public.
    const userId = await currentSessionUserId().catch(() => null);
    if (!userId) return null;
    const key = BIN_KEY_PREFIX + userId;
    await drainLegacyBin(userId);
    // Ownership is decided by the CLIP'S OWN round, never by the caller's.
    //
    // The first version of this gate checked `roundId` and then deleted
    // `clipId` — two independent arguments with nothing binding them, so an
    // owned round id paired with any other clip id passed. `deleteLocalClip`
    // is `DELETE FROM local_clips WHERE id = ?` with no ownership predicate,
    // and `local_clips.id` is AUTOINCREMENT in the one database every account
    // on the handset shares, so another account's ids are small sequential
    // integers rather than secrets. That gate read as protection and provided
    // none — worse than having none, because it invited trust.
    //
    // `getLocalClipRound` reads the round off the clip, so the caller's
    // argument cannot widen what this deletes. Fails closed on a missing clip
    // or an unowned round.
    const ownerRoundId = await getLocalClipRound(clipId).catch(() => null);
    if (!ownerRoundId) return null;
    const round = await getLocalRound(ownerRoundId).catch(() => null);
    // getLocalRound only returns a row whose user_id equals ITS OWN
    // resolution of the session, so comparing that row's owner against the id
    // that built the key is what actually binds the two halves together. A
    // mid-job account change now fails the gate instead of splitting it — the
    // delete is refused and retried, never redirected.
    if (!round || round.user_id !== userId) return null;
    // Read the bin BEFORE the row leaves SQLite, and refuse if it cannot be
    // read — the same rule as the `if (!userId) return null` guard above, for
    // the same reason: with no readable bin there is nowhere to record
    // recovery, and the write below would replace up to MAX_ENTRIES valid
    // entries with this one, orphaning the files of clips already deleted.
    // Refusing leaves the clip in place, which is a visible no-op the user can
    // retry rather than a silent loss of someone's recoverable shots.
    const existing = await readBinAtStrict(key);
    if (existing === null) return null;
    const { fileUris, row } = await deleteLocalClip(clipId, false);
    if (!row) return null;
    // Stamped from the row too, so `listBinnedClips(roundId)` cannot be made
    // to filter on a value the caller invented.
    const entry: BinnedClip = {
      row,
      fileUris,
      deletedAt: new Date().toISOString(),
      roundId: typeof row.round_id === 'string' ? row.round_id : ownerRoundId,
    };
    const entries = [entry, ...existing];
    const kept = entries.slice(0, MAX_ENTRIES);
    const evicted = entries.slice(MAX_ENTRIES);
    try {
      await writeBinAt(key, kept);
    } catch (err) {
      // The row is already out of SQLite at this point, so a failed bin write
      // means an unrecoverable clip. Put the row back and report the delete as
      // not having happened — the clip reappears on the editor's next focus
      // reload, which is the same visible outcome as the bug this feature
      // replaced, and strictly better than losing the shot.
      await restoreLocalClip(row).catch(() => {});
      throw err;
    }
    // Same gate as every other path that unlinks files. Evicted entries are
    // this account's own by construction today — but that is an argument about
    // `local_rounds`, not about this module, and an emptiness argument resting
    // on another module's invariant is what finding 67 was. Asserted, not
    // assumed. `entryOwnedBy` allows a genuinely gone round, so this does not
    // strand an evicted entry (no 34/41 regression).
    for (const old of evicted) {
      if (await entryOwnedBy(old, userId)) await purgeEntry(old);
    }
    return entry;
  });
}

/** Put a binned clip back. Returns false if its row already exists again. */
export async function restoreClipFromBin(clipId: number): Promise<boolean> {
  return binQueue.run(async () => {
    // One resolution decides the drain and the key alike.
    const userId = await currentSessionUserId().catch(() => null);
    if (!userId) return false;
    const key = BIN_KEY_PREFIX + userId;
    await drainLegacyBin(userId);
    const entries = await readBinAt(key);
    const entry = entries.find((e) => Number(e.row?.id) === clipId);
    if (!entry) return false;
    // Before restoreLocalClip and before writeBinAt, so a refusal mutates
    // nothing and the entry stays in the bin for whoever actually owns it.
    if (!(await entryOwnedBy(entry, userId))) return false;
    const restored = await restoreLocalClip(entry.row);
    await writeBinAt(key, entries.filter((e) => Number(e.row?.id) !== clipId));
    return restored;
  });
}

/** Destroy one entry for good: finalise the tracer stale, unlink the files. */
async function purgeEntry(entry: BinnedClip): Promise<void> {
  try {
    await commitClipDeletion(entry.row);
  } catch {
    // Tracer bookkeeping failing must not strand the video files on disk.
  }
  for (const uri of entry.fileUris ?? []) {
    // Re-check the prefix deleteLocalClip applied on the way IN. This is the
    // unlink side of the same trust boundary isValidEntry guards: entries
    // reach here from a JSON blob, and this hands them to a file delete.
    //
    // ⚠️ KNOWN GAP, and the requirements are written here because three
    // independent proposals have now derived the wrong predicate from the
    // gap alone. This is a SCHEME test, not a CONTAINMENT one — see finding 35
    // in the report. Whoever closes it:
    //
    //   1. Contain against the app CONTAINER (the parent of documentDirectory),
    //      NOT against documentDirectory + cacheDirectory. `lib/clipPaths.ts`
    //      documents `/tmp/` (NSTemporaryDirectory) as a legitimate home for a
    //      stored clip URI, and Documents/, Library/Caches/ and tmp/ are all
    //      siblings under the container. A two-root predicate skips those
    //      unlinks, so "Delete for good" reports success with the video still
    //      on disk — the failure that is invisible until someone hands the
    //      phone on. That module also argues against enumerating subpaths at
    //      all, having been burned once by a list that missed the camera
    //      directory.
    //   2. decodeURI first (so `%2e%2e` cannot slip past), refuse on a decode
    //      throw, and reject `%00` on the raw string.
    //   3. NEVER build it on `new URL` — React Native's is a string shim that
    //      does no path resolution, so it accepts the traversal it targets
    //      (finding 85). And NOT `isPurgeableAppPath`: it is an inclusion test
    //      and answers a different question.
    //   4. THIS SINK ONLY. Do not tighten `isValidEntry` in the same change:
    //      it runs on READ, so a stricter predicate there drops entries and
    //      orphans the files they pin, which is finding 34. They land together
    //      or not at all (finding 70).
    //   5. One device confirmation: "Delete for good" must still unlink a clip
    //      whose file_uri is a pre-migration cache or tmp path.
    if (typeof uri !== 'string' || !uri.startsWith('file://')) continue;
    try {
      await deleteFile(uri);
    } catch {
      // A file already gone, or locked, is not a reason to keep the entry.
    }
  }
}

/** Remove one clip from the bin permanently — files unlinked, no way back. */
/**
 * Does this entry belong to this account?
 *
 * `binKey()` alone decided this before, so the key was the only thing naming
 * whose footage got read, restored or unlinked, with nothing cross-checking it
 * the way `deleteClipToBin` does. **All SIX paths that touch an entry now go
 * through here** — the two destructive ones, the read, the restore, the legacy
 * drain (which binds equivalently via `getLocalRound`) and the eviction purge.
 * This said "all five" and omitted eviction, which was ungated: a docstring
 * asserting total coverage that a reader takes as evidence is finding 45.
 *
 * A round that is genuinely GONE has no owner to compare, so it is allowed
 * through: refusing there would make the entry permanently unpurgeable and
 * unrestorable, which is a retention failure rather than a fix.
 *
 * **That null-tolerance is exactly why read and restore CAN be gated, and an
 * earlier version of this docstring argued the opposite three lines above the
 * clause that refutes it.** It said gating them would make an entry outliving
 * its round invisible and unrestorable — findings 34/41 recreated. It would
 * not: a genuinely gone round passes.
 *
 * **The same docstring then made a second claim that was false**: that the
 * predicate excludes entries whose round exists and belongs to somebody else.
 * Built on the scoped `getLocalRound`, that set was empty — a foreign round
 * reads as `null` and was admitted by the tolerance above. It now reads the
 * owner stamp UNSCOPED, so "gone" and "foreign" are finally different answers
 * and the claim is true for the first time.
 *
 * **What it still does not do:** both this and the caller's `userId` come from
 * the same session primitive, so a resolution that is wrong is wrong for both.
 * This binds two independent reads; it does not make either of them right.
 *
 * **Defence in depth, stated plainly:** `local_rounds.user_id` is not proof of
 * ownership on its own (finding 23, private tracker — unfixed and live, so the
 * reason is not written here), so this does not make the destructive paths
 * sound. It makes them require two things to go wrong rather than one, which is
 * strictly better than resting on the resolution alone.
 */
async function entryOwnedBy(entry: BinnedClip, userId: string): Promise<boolean> {
  // UNSCOPED read, and that is the whole point. The previous version asked
  // `getLocalRound`, which filters on `user_id = ?` and post-filters with
  // `isRowVisible` — so a round owned by ANOTHER account comes back as `null`,
  // indistinguishable from a round that does not exist, and the null-tolerance
  // below then admitted it. The docstring claimed this predicate excluded
  // "entries whose round exists and belongs to somebody else"; that set was
  // EMPTY BY CONSTRUCTION. The only thing it ever rejected was the narrow
  // split-resolution case, which is not what it advertised.
  const owner = await getLocalRoundOwner(entry.roundId).catch(() => undefined);
  // Genuinely GONE stays allowed: refusing here strands the files the entry
  // pins, which is findings 34/41 and is what the null-tolerance protects.
  if (owner === undefined) return true;
  // A pre-migration row that nothing has claimed yet is not another account's
  // round yet, so it passes. The rule that decides when it stops being
  // unclaimed is finding 23 — unfixed and live — and is named in the private
  // tracker rather than here.
  if (owner === null) return true;
  // Round EXISTS and is stamped to somebody else: refuse. This branch is new —
  // it is the one the old docstring promised and the scoped read made
  // unreachable.
  return owner === userId;
}

export async function purgeClipFromBin(clipId: number): Promise<void> {
  return binQueue.run(async () => {
    // Resolved once and inline, so the SAME id builds the key, closes the gate
    // below AND authorises the drain — the reason deleteClipToBin stopped
    // using binKey().
    const userId = await currentSessionUserId().catch(() => null);
    if (!userId) return;
    const key = BIN_KEY_PREFIX + userId;
    await drainLegacyBin(userId);
    const entries = await readBinAt(key);
    const entry = entries.find((e) => Number(e.row?.id) === clipId);
    if (!entry) return;
    if (!(await entryOwnedBy(entry, userId))) return;
    await writeBinAt(key, entries.filter((e) => Number(e.row?.id) !== clipId));
    await purgeEntry(entry);
  });
}

/**
 * Empty the signed-in user's whole bin for good — files unlinked.
 *
 * For `removeLocalMediaForCurrentUser` ("remove my videos from this phone").
 * That walks rounds through deleteLocalRound, and a binned clip no longer HAS
 * a local_clips row, so without this up to MAX_ENTRIES videos would survive
 * the one action whose entire purpose is removing them. Returns how many
 * entries were destroyed. Never throws — it is a cleanup path.
 */
export async function purgeAllBinnedClips(): Promise<number> {
  return binQueue.run(async () => {
    try {
      // Pre-scoping entries are this action's responsibility too — they are
      // exactly the videos it promises to remove.
      // Same single inline resolution as purgeClipFromBin, for the same reason.
      const userId = await currentSessionUserId().catch(() => null);
      if (!userId) return 0;
      const key = BIN_KEY_PREFIX + userId;
      await drainLegacyBin(userId);
      const entries = await readBinAt(key);
      if (entries.length === 0) return 0;
      // Partition rather than blanking the key. An entry this account cannot
      // prove it owns is written BACK, never unlinked — the safe direction,
      // and it is what lets the gate above exist at all: refusing without
      // writing back would destroy the record while leaving the files.
      const purgeable = await Promise.all(entries.map((e) => entryOwnedBy(e, userId)));
      const mine = entries.filter((_, i) => purgeable[i]);
      const kept = entries.filter((_, i) => !purgeable[i]);
      if (mine.length === 0) return 0;
      // Shrink the list BEFORE unlinking: if a file unlink stalls, no entry may
      // be left pointing at a video the user has already asked us to remove.
      await writeBinAt(key, kept);
      for (const entry of mine) await purgeEntry(entry);
      return mine.length;
    } catch {
      return 0;
    }
  });
}

/** Newest first. Pass a roundId to see only that round's deletions. */
export async function listBinnedClips(roundId?: string): Promise<BinnedClip[]> {
  // Resolved once and inline, so the SAME id builds the key and closes the
  // gate — the reason deleteClipToBin stopped using binKey(). Fails closed.
  const userId = await currentSessionUserId().catch(() => null);
  if (!userId) return [];
  const entries = await readBinAt(BIN_KEY_PREFIX + userId);
  const owned = await Promise.all(entries.map((e) => entryOwnedBy(e, userId)));
  const visible = entries.filter((_, i) => owned[i]);
  return roundId ? visible.filter((e) => e.roundId === roundId) : visible;
}
