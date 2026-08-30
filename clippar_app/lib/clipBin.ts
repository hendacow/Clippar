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
import { getSetting, setSetting, deleteLocalClip, restoreLocalClip, commitClipDeletion, type LocalClipRow } from '@/lib/storage';
import { deleteFile } from 'shot-detector';
import { createSerialQueue } from '@/lib/serialQueue';

const BIN_KEY = 'clips.bin.v1';

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
    const raw = await getSetting(BIN_KEY);
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

async function writeBin(entries: BinnedClip[]): Promise<void> {
  await setSetting(BIN_KEY, JSON.stringify(entries));
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

/** Newest first. Pass a roundId to see only that round's deletions. */
export async function listBinnedClips(roundId?: string): Promise<BinnedClip[]> {
  const entries = await readBin();
  return roundId ? entries.filter((e) => e.roundId === roundId) : entries;
}
