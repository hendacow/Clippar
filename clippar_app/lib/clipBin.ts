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
import { getSetting, setSetting, deleteLocalClip, restoreLocalClip, commitClipDeletion, currentSessionUserId, type LocalClipRow } from '@/lib/storage';
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

async function readBin(): Promise<BinnedClip[]> {
  try {
    const key = await binKey();
    if (!key) return [];
    const raw = await getSetting(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as BinnedClip[]) : [];
  } catch {
    // A corrupt bin must never block a delete or wedge the editor. Losing the
    // recovery list is bad; refusing to delete because we cannot read it is
    // worse, and the clip rows themselves are unaffected either way.
    return [];
  }
}

/** Throws when no session resolves, so a caller cannot write a shared bin. */
async function writeBin(entries: BinnedClip[]): Promise<void> {
  const key = await binKey();
  if (!key) throw new Error('clipBin: no signed-in user to scope the bin to');
  await setSetting(key, JSON.stringify(entries));
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
    // Checked BEFORE the row is touched. With no session there is nowhere to
    // record the recovery entry, and a delete we cannot undo is exactly what
    // this module exists to prevent — so refuse rather than remove the row and
    // rely on the rollback below.
    if (!(await binKey())) return null;
    const { fileUris, row } = await deleteLocalClip(clipId, false);
    if (!row) return null;
    const entry: BinnedClip = { row, fileUris, deletedAt: new Date().toISOString(), roundId };
    const entries = [entry, ...(await readBin())];
    const kept = entries.slice(0, MAX_ENTRIES);
    const evicted = entries.slice(MAX_ENTRIES);
    try {
      await writeBin(kept);
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
    const entries = await readBin();
    const entry = entries.find((e) => Number(e.row?.id) === clipId);
    if (!entry) return false;
    const restored = await restoreLocalClip(entry.row);
    await writeBin(entries.filter((e) => Number(e.row?.id) !== clipId));
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
    const entries = await readBin();
    const entry = entries.find((e) => Number(e.row?.id) === clipId);
    if (!entry) return;
    await writeBin(entries.filter((e) => Number(e.row?.id) !== clipId));
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
      const entries = await readBin();
      if (entries.length === 0) return 0;
      // Clear the list first: if a file unlink stalls, the entries must not be
      // left pointing at videos the user has already asked us to remove.
      await writeBin([]);
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
