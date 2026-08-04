/**
 * Canonical Supabase Storage bucket names and object keys — the ONE place the
 * shape of a key is written down.
 *
 * This module exists because of a data-deletion bug, and the bug is worth
 * recording so nobody rebuilds it. The reel uploader (lib/r2.ts) writes the
 * composed highlight reel to `clips/reels/<roundId>.mp4`. Both deleters —
 * lib/api.ts deleteRound and the delete-account Edge Function — re-typed their
 * own idea of where a reel lives, and what they typed was "list the folder
 * named `<roundId>`". That folder holds the per-hole clips and has never held
 * the reel: `reels/<roundId>.mp4` is a SIBLING of `<roundId>/`, not a child.
 * So every account deletion and every round deletion silently left the reel in
 * the bucket, while the privacy policy said it was gone.
 *
 * The literals were three files apart and no test could see all three at once,
 * which is exactly why they drifted. Two rules keep that from happening again:
 *
 *   1. Import the helper. Never re-type `reels/${id}.mp4` anywhere else. A
 *      second copy of that literal IS the bug.
 *   2. This file imports NOTHING, ever. Three different runtimes load it —
 *      Metro (the app), Deno (the Edge Function, via a relative `../../lib/…`
 *      import out of supabase/functions/), and node/tsx (the tests). Any
 *      dependency at all breaks at least one of them.
 */

/**
 * The only bucket the app ever uploads video to. Per-hole clips AND composed
 * reels both live here (lib/r2.ts uploads via both the simple POST endpoint
 * `/object/clips/…` and the TUS endpoint with `bucketName: clips`).
 *
 * There is deliberately no REELS_BUCKET. A bucket named `reels` is not created
 * by any migration and is never written to by any upload path — the old
 * deleters iterated it anyway, which meant half of every cleanup run was a 404
 * against a bucket that does not exist, logged as though work had been done.
 */
export const CLIPS_BUCKET = 'clips';

/**
 * Profile photos, keyed `<userId>/avatar.<ext>` (app/profile/edit.tsx). Created
 * from the Supabase dashboard — no migration in this repo makes it, so its
 * policies are invisible to code review (see migration 019 §6). It is PUBLIC
 * and the key is fully derivable from a user id, so an avatar left behind by a
 * deleted account stays fetchable by anyone who knows the id. Delete it.
 */
export const AVATARS_BUCKET = 'avatars';

/** Folder inside CLIPS_BUCKET that holds composed reels — one object per round. */
export const REELS_FOLDER = 'reels';

/**
 * Reject an id that would collapse a key into a bucket-root reference.
 * `list('')` enumerates the ENTIRE bucket — every user's rounds — and the
 * remove that follows would be aimed at objects belonging to strangers. An
 * empty id can only come from a bug, so fail loudly rather than sweep.
 */
function requireId(kind: string, id: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`storagePaths: refusing to build a ${kind} path from an empty id`);
  }
  return id;
}

/**
 * Key of a round's composed highlight reel inside CLIPS_BUCKET.
 * This is the single definition of that path — uploader and deleters alike.
 */
export function reelStoragePath(roundId: string): string {
  return `${REELS_FOLDER}/${requireId('reel', roundId)}.mp4`;
}

/**
 * Folder inside CLIPS_BUCKET holding a round's per-hole clips, i.e. the prefix
 * of `<roundId>/<filename>`. Named rather than inlined so that the difference
 * between "the clips FOLDER for a round" and "the reel KEY for a round" is
 * visible at every call site — conflating the two is the original bug.
 */
export function roundClipsFolder(roundId: string): string {
  return requireId('round clips', roundId);
}

/** Folder inside AVATARS_BUCKET holding a user's profile photo. */
export function avatarFolder(userId: string): string {
  return requireId('avatar', userId);
}
