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
import { getSetting, setSetting, deleteLocalClip, restoreLocalClip, commitClipDeletion, currentSessionUserId, getLocalRound, type LocalClipRow } from '@/lib/storage';
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
 * `sessionUserId()` also falls back to a cached `lastKnownUserId` when
 * `getSession()` transiently fails, so consecutive calls inside one job are
 * not guaranteed to agree. A sign-out landing mid-job could therefore read
 * from A's bin and write to B's — filing A's clip row into B's recovery list,
 * where B's "Delete for good" unlinks A's video. That is the cross-account
 * destruction this module exists to prevent, reached through a narrower door.
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
 * Column names are checked against the SQL identifier SHAPE rather than an
 * allow-list of known columns: `local_clips` has picked up 25 columns through
 * `ALTER TABLE` migrations, so a hardcoded list would drift and start
 * silently refusing valid restores. The shape check is what closes the
 * injection; an unknown-but-well-formed column just fails at INSERT.
 *
 * `fileUris` is re-checked for the `file://` prefix that `deleteLocalClip`
 * applied on the way IN, because `purgeEntry` unlinks them on the way out and
 * was not re-applying it.
 */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isValidEntry(v: unknown): v is BinnedClip {
  if (!v || typeof v !== 'object') return false;
  const e = v as BinnedClip;
  if (typeof e.roundId !== 'string') return false;
  if (!e.row || typeof e.row !== 'object' || typeof e.row.id !== 'number') return false;
  if (!Object.keys(e.row).every((c) => SQL_IDENTIFIER.test(c))) return false;
  if (!Array.isArray(e.fileUris)) return false;
  return e.fileUris.every((u) => typeof u === 'string' && u.startsWith('file://'));
}

async function readBinAt(key: string): Promise<BinnedClip[]> {
  try {
    const raw = await getSetting(key);
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
async function drainLegacyBin(): Promise<void> {
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
      // would keep an unreadable blob alive for the life of the install. Any
      // real files it pinned are caught by wipeLocalUserData's clips/ sweep.
      if (!isValidEntry(entry)) continue;
      const owned = await getLocalRound(entry.roundId).catch(() => null);
      (owned ? mine : others).push(entry);
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
    await drainLegacyBin();
    // Resolved ONCE, and BEFORE the row is touched. Once, so every read and
    // write below belongs to this account even if the session changes
    // underneath us. Before, because with no session there is nowhere to
    // record the recovery entry, and a delete we cannot undo is exactly what
    // this module exists to prevent — so refuse rather than remove the row and
    // rely on the rollback below.
    const key = await binKey();
    if (!key) return null;
    // And the round has to be ours. `deleteLocalClip` is
    // `DELETE FROM local_clips WHERE id = ?` with no ownership predicate, and
    // clip ids are small sequential integers — so this is the destructive
    // primitive, and every caller gating it upstream is a property of today's
    // call sites rather than of the function. Same argument lib/training.ts
    // makes: the gate belongs at the data layer, not in the screens.
    if (!(await getLocalRound(roundId).catch(() => null))) return null;
    const { fileUris, row } = await deleteLocalClip(clipId, false);
    if (!row) return null;
    const entry: BinnedClip = { row, fileUris, deletedAt: new Date().toISOString(), roundId };
    const entries = [entry, ...(await readBinAt(key))];
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
    for (const old of evicted) await purgeEntry(old);
    return entry;
  });
}

/** Put a binned clip back. Returns false if its row already exists again. */
export async function restoreClipFromBin(clipId: number): Promise<boolean> {
  return binQueue.run(async () => {
    await drainLegacyBin();
    const key = await binKey();
    if (!key) return false;
    const entries = await readBinAt(key);
    const entry = entries.find((e) => Number(e.row?.id) === clipId);
    if (!entry) return false;
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
    if (typeof uri !== 'string' || !uri.startsWith('file://')) continue;
    try {
      await deleteFile(uri);
    } catch {
      // A file already gone, or locked, is not a reason to keep the entry.
    }
  }
}

/** Remove one clip from the bin permanently — files unlinked, no way back. */
export async function purgeClipFromBin(clipId: number): Promise<void> {
  return binQueue.run(async () => {
    await drainLegacyBin();
    const key = await binKey();
    if (!key) return;
    const entries = await readBinAt(key);
    const entry = entries.find((e) => Number(e.row?.id) === clipId);
    if (!entry) return;
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
      await drainLegacyBin();
      const key = await binKey();
      if (!key) return 0;
      const entries = await readBinAt(key);
      if (entries.length === 0) return 0;
      // Clear the list first: if a file unlink stalls, the entries must not be
      // left pointing at videos the user has already asked us to remove.
      await writeBinAt(key, []);
      for (const entry of entries) await purgeEntry(entry);
      return entries.length;
    } catch {
      return 0;
    }
  });
}

/** Newest first. Pass a roundId to see only that round's deletions. */
export async function listBinnedClips(roundId?: string): Promise<BinnedClip[]> {
  const entries = await readBin();
  return roundId ? entries.filter((e) => e.roundId === roundId) : entries;
}
