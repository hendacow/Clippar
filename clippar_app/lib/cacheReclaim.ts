/**
 * The real work behind Profile → "Clear Cache".
 *
 * That row used to promise "Cached thumbnails and temp files will be removed"
 * and then run a single Haptics success buzz — it freed zero bytes and told the
 * user it had worked. A golfer low on storage tapped it, believed it, and was
 * no better off. This module is the honest version: it deletes only artefacts
 * the app can rebuild, and it measures and returns the bytes it actually
 * reclaimed so the caller can say a number rather than a reassurance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MUST NEVER DELETE, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * A round is recorded ONCE, on a golf course, and can never be re-recorded.
 * Losing a source clip is not a bug the user can work around — the footage is
 * gone. So the rule for anything added here is: delete it only if the app can
 * regenerate it from something it still holds. If you cannot prove that, leave
 * it. Under-deleting disappoints someone for an afternoon; over-deleting ends
 * their round.
 *
 * Specifically OFF LIMITS, however tempting they look sitting in Library/Caches:
 *
 *   • documentDirectory/clips/ and exports/ — the raw and trimmed swing videos
 *     themselves (lib/media.ts, lib/clipShare.ts). With cloud backup off (the
 *     default — it is Pro-gated) these are the ONLY copy in existence. Only the
 *     explicit "remove my videos from this phone" choice may touch them; see
 *     removeLocalMediaForCurrentUser in lib/localWipe.ts.
 *
 *   • cacheDirectory/reel_<uuid>.mp4 — the composed highlight reel. It lives in
 *     the cache directory but it is NOT a cache: app/round/editor.tsx writes
 *     that file:// path straight into rounds.reel_url and upload is opt-in, so
 *     for a user who never asked for a share link this is the reel. It is
 *     deliberately absent from the temp-export prefixes swept below — do not
 *     "tidy up" by adding a reel_ prefix or by wiping the cache directory
 *     wholesale. That single change would shred footage.
 *
 *   • The SQLite database (clippar.db) and any local_settings row. Rounds,
 *     scores, the upload queue and the user's own onboarding answers are not
 *     caches. Note that lib/localWipe.ts's clearAccountLinkedCaches() has
 *     "cache" in its name but forgets the golfer's home course and handicap —
 *     that belongs to sign-out, never to a storage cleanup.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES DELETE
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. cacheDirectory/VideoThumbnails/ — JPEGs expo-video-thumbnails renders
 *      from a video the app still has. Purely derived; regenerated on next
 *      render at the cost of a frame grab.
 *   2. Aged-out trim_/stitch_/tracer_/clippar_reel_ temporaries, via
 *      reclaimTemporaryExports, with a real in-use set read out of SQLite.
 *   3. Aged-out cacheDirectory/recovered-clips/ downloads — clips pulled back
 *      from cloud storage during a compose. They exist only for clips that ARE
 *      in the cloud, so re-downloading them is always possible.
 *
 * This module is deliberately importable under plain node (no top-level
 * react-native / expo-sqlite import; everything native is required lazily) so
 * the pure helpers below can be unit-tested — see tests/cacheReclaim.test.ts.
 */

import {
  TEMP_EXPORT_MAX_AGE_MS,
  reclaimTemporaryExports,
} from '@/modules/shot-detector';

export type CacheClearResult = {
  /** Bytes measured on disk before deletion, for files that are now gone. */
  bytesFreed: number;
  /** Files removed. Diagnostic only — the user is shown bytes. */
  filesRemoved: number;
  /**
   * At least one sweep step failed. The counts above are then a FLOOR, not a
   * total, and a caller reporting `bytesFreed === 0` must say "failed" rather
   * than "nothing to clear".
   */
  hadErrors: boolean;
};

/** Derived JPEG thumbnails — see saveImage() in expo-video-thumbnails. */
const THUMBNAIL_DIR = 'VideoThumbnails/';

/** Cloud clip re-downloads made during compose — see app/round/editor.tsx. */
const RECOVERED_CLIPS_DIR = 'recovered-clips/';

// ─── Pure helpers (unit-tested; no filesystem, no native modules) ───

/**
 * Whether a cached file is old enough that no operation can still be using it.
 *
 * Fails CLOSED on an unreadable modification time: a missing or zero mtime
 * means we could not establish the file's age, and reading that as epoch 0
 * would make every such file look ancient and delete it. Same rule, and the
 * same reasoning, as isReclaimableTempExport in modules/shot-detector.
 */
export function isStaleEnoughToReclaim(opts: {
  modifiedAtMs: number;
  nowMs: number;
  maxAgeMs: number;
}): boolean {
  if (!opts.modifiedAtMs) return false;
  return opts.nowMs - opts.modifiedAtMs >= opts.maxAgeMs;
}

/**
 * Bytes genuinely reclaimed: the sizes measured BEFORE a sweep, for the entries
 * that are no longer on disk AFTER it.
 *
 * Done as a before/after diff rather than by trusting a delete count, because
 * reclaimTemporaryExports reports how many files it removed but not which, and
 * a file it skipped as "in use" must not be counted as space we gave back.
 */
export function bytesFreedFrom(
  sizesBefore: ReadonlyMap<string, number>,
  remaining: ReadonlySet<string>
): number {
  let total = 0;
  for (const [name, size] of sizesBefore) {
    if (!remaining.has(name)) total += size;
  }
  return total;
}

/**
 * "24.3 MB" for the confirmation the user reads.
 *
 * Decimal units (1 MB = 1e6 bytes), matching what iOS shows in Settings →
 * General → iPhone Storage, so the number we claim to have freed is comparable
 * with the number the user can go and check.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${Math.round(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

// ─── Filesystem sweep ───

type LegacyFS = typeof import('expo-file-system/legacy');

function loadFileSystem(): LegacyFS | null {
  try {
    // On web `cacheDirectory` is null, which the caller treats as "nothing to
    // do" — so there is no need to import react-native just to check Platform.
    return require('expo-file-system/legacy') as LegacyFS;
  } catch {
    return null;
  }
}

/**
 * Every local URI that still has an owner, read straight out of SQLite.
 *
 * This is the argument reclaimTemporaryExports refuses to default: a caller
 * that passes `[]` is asserting nothing on this device is in use.
 * lib/localWipe.ts may legitimately pass `[]` because it is destroying the rows
 * that could have claimed those files. Clear Cache is the opposite — the rows
 * all survive — so it has to do the read.
 *
 * Throws rather than returning a partial list. A failed query read as "no clips
 * are in use" would delete every trimmed clip and tracer render the library
 * still points at, so the caller must abort the whole sweep on a throw.
 *
 * The SELECT covers all four URI columns on local_clips; tests/cacheReclaim.
 * test.ts pins that against the schema so a fifth column added later cannot
 * silently start ageing into deletion.
 */
async function readInUseClipUris(): Promise<Array<string | null>> {
  const { getDatabase } = require('./storage') as typeof import('./storage');
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    file_uri: string | null;
    trimmed_file_uri: string | null;
    original_file_uri: string | null;
    tracer_file_uri: string | null;
  }>(
    'SELECT file_uri, trimmed_file_uri, original_file_uri, tracer_file_uri FROM local_clips'
  );
  // No user scoping on purpose: another account's clips on this handset are
  // just as unrecoverable as the signed-in user's.
  return rows.flatMap((r) => [
    r.file_uri,
    r.trimmed_file_uri,
    r.original_file_uri,
    r.tracer_file_uri,
  ]);
}

/**
 * Size and mtime of one FILE in a single stat. Returns zeroes for a directory,
 * an absent path or an unreadable one — and both callers of this treat zeroes
 * as "leave it alone", so an unreadable entry can never be deleted or counted.
 *
 * One call rather than two on purpose: every getInfoAsync is a trip through the
 * serialized native queue that lib/media.ts got badly burned by.
 */
async function statFile(
  FS: LegacyFS,
  uri: string
): Promise<{ size: number; modifiedAtMs: number }> {
  const none = { size: 0, modifiedAtMs: 0 };
  try {
    const info = await FS.getInfoAsync(uri);
    if (!info.exists || (info as { isDirectory?: boolean }).isDirectory) return none;
    const seconds = (info as { modificationTime?: number }).modificationTime;
    return {
      size: (info as { size?: number }).size ?? 0,
      modifiedAtMs: seconds ? Math.round(seconds * 1000) : 0,
    };
  } catch {
    return none;
  }
}

async function listDirectory(FS: LegacyFS, dir: string): Promise<string[]> {
  try {
    return await FS.readDirectoryAsync(dir);
  } catch {
    // Absent directory (nothing cached yet) or an unreadable one — either way
    // there is nothing here we can safely act on.
    return [];
  }
}

/**
 * Wipe the derived-thumbnail directory.
 *
 * The only sweep here with no age guard, because a thumbnail is a JPEG rendered
 * from a video the app still holds: the worst case for deleting one mid-write
 * is a placeholder tile until the next render. expo-video-thumbnails calls
 * ensureDirExists on every save, so removing the directory itself is safe.
 *
 * getInfoAsync on a DIRECTORY recursively sizes its contents on iOS, which
 * lib/media.ts warns is pathologically slow on clips/ (~3.5s with a round's
 * worth of 4K video). It is the right call here and only here: this directory
 * holds small JPEGs, it is one call rather than one per file, and it happens
 * behind an explicit tap with a spinner — not on the import hot path.
 */
async function clearThumbnails(FS: LegacyFS, cacheDir: string) {
  const dir = `${cacheDir}${THUMBNAIL_DIR}`;
  const info = await FS.getInfoAsync(dir);
  if (!info.exists) return { bytes: 0, files: 0 };

  const names = await listDirectory(FS, dir);
  let bytes = (info as { size?: number }).size ?? 0;
  if (bytes === 0 && names.length > 0) {
    // Not every expo-file-system build reports a recursive size for a
    // directory. Falling back to per-file stats costs a few calls on small
    // JPEGs and keeps the reported figure true — a sweep that deletes files
    // and then claims "nothing to clear" is the same dishonesty in reverse.
    for (const name of names) bytes += (await statFile(FS, `${dir}${name}`)).size;
  }

  await FS.deleteAsync(dir, { idempotent: true });
  return { bytes, files: names.length };
}

/**
 * Delete files in `dir` that are older than `maxAgeMs`. Per-file, so one
 * unreadable entry cannot take the rest of the sweep — or the directory — with
 * it, and so anything written moments ago by an operation still in flight is
 * left where it is.
 */
async function clearStaleFilesIn(
  FS: LegacyFS,
  dir: string,
  opts: { nowMs: number; maxAgeMs: number }
) {
  let bytes = 0;
  let files = 0;
  for (const name of await listDirectory(FS, dir)) {
    const uri = `${dir}${name}`;
    try {
      const { size, modifiedAtMs } = await statFile(FS, uri);
      // size === 0 also covers "absent" and "a nested directory we do not own".
      if (size === 0) continue;
      if (!isStaleEnoughToReclaim({ modifiedAtMs, ...opts })) continue;
      await FS.deleteAsync(uri, { idempotent: true });
      bytes += size;
      files += 1;
    } catch {
      // Locked or vanished — skip it and keep going.
    }
  }
  return { bytes, files };
}

/**
 * Free every disposable byte we can prove is disposable, and report how many.
 *
 * REJECTS if the in-use read fails, before anything has been deleted, so the
 * caller can honestly tell the user nothing was removed. Individual sweep steps
 * are best-effort and set `hadErrors` instead of throwing.
 */
export async function clearDisposableCaches(
  opts: { nowMs?: number; maxAgeMs?: number } = {}
): Promise<CacheClearResult> {
  const nowMs = opts.nowMs ?? Date.now();
  // Same 24h grace the startup sweep uses. Not zero, even though the user asked
  // for this explicitly: a trim_/stitch_/tracer_ file written minutes ago most
  // likely belongs to an import or compose still running in the background, and
  // no amount of reclaimed storage is worth racing an export.
  const maxAgeMs = opts.maxAgeMs ?? TEMP_EXPORT_MAX_AGE_MS;

  const FS = loadFileSystem();
  const cacheDir = FS?.cacheDirectory;
  if (!FS || !cacheDir) return { bytesFreed: 0, filesRemoved: 0, hadErrors: false };

  // Fail closed: derive what is still owned BEFORE deleting anything.
  const inUseUris = await readInUseClipUris();

  let bytesFreed = 0;
  let filesRemoved = 0;
  let hadErrors = false;

  const step = async (run: () => Promise<{ bytes: number; files: number }>) => {
    try {
      const { bytes, files } = await run();
      bytesFreed += bytes;
      filesRemoved += files;
    } catch (err) {
      console.warn('[cacheReclaim] sweep step failed', err);
      hadErrors = true;
    }
  };

  await step(() => clearThumbnails(FS, cacheDir));

  await step(async () => {
    // Measure the candidates first, sweep, then diff: reclaimTemporaryExports
    // tells us how many files it removed but not which ones, and the ones it
    // kept as in-use or too recent must not be counted as space we freed.
    const before = new Map<string, number>();
    for (const name of await listDirectory(FS, cacheDir)) {
      if (!looksLikeTempExport(name)) continue;
      before.set(name, (await statFile(FS, `${cacheDir}${name}`)).size);
    }
    const { deletedCount } = await reclaimTemporaryExports({ inUseUris, maxAgeMs, nowMs });
    const remaining = new Set(await listDirectory(FS, cacheDir));
    return { bytes: bytesFreedFrom(before, remaining), files: deletedCount };
  });

  await step(() =>
    clearStaleFilesIn(FS, `${cacheDir}${RECOVERED_CLIPS_DIR}`, { nowMs, maxAgeMs })
  );

  return { bytesFreed, filesRemoved, hadErrors };
}

/**
 * Local mirror of the temp-export name shape, used ONLY to decide which files
 * are worth measuring before the sweep. The authority on what actually gets
 * deleted is isReclaimableTempExport in modules/shot-detector — this being
 * over-broad would inflate the byte count, never delete anything extra.
 */
function looksLikeTempExport(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    ['trim_', 'stitch_', 'tracer_', 'clippar_reel_'].some((p) => filename.startsWith(p)) &&
    (lower.endsWith('.mp4') || lower.endsWith('.mov'))
  );
}
