/**
 * Media URI normalization helpers.
 *
 * The Photos picker (expo-image-picker) returns URIs that can be:
 *   - `ph://<asset-id>`               — iOS PhotoKit reference (NOT a real file)
 *   - `assets-library://...`          — legacy iOS format (NOT a real file)
 *   - `file:///.../tmp/ImagePicker/…` — iOS writes a temp copy (purged on reinstall)
 *   - `file:///.../DocumentDirectory/…` — already durable
 *
 * AVFoundation (used by our native trim / stitch) and `expo-file-system.File`
 * do not accept `ph://` — passing it through causes silent failures that
 * surface as "videos won't load" and "File not found: ph://..." upload errors.
 *
 * `resolveAssetUri` promotes any picker URI to a durable `file://` path by
 * either (a) asking MediaLibrary for the PhotoKit `localUri`, or (b) copying
 * the asset into our persistent `documentDirectory/clips/` folder if localUri
 * isn't stable.
 *
 * Called from:
 *   - `app/round/import.tsx` (before saveLocalClip)
 *   - `hooks/useCamera.ts` (before saveLocalClip — expo-camera writes the
 *     recording into Library/Caches/…/Camera, which is just as purgeable as
 *     the picker's copy; see lib/clipPaths)
 *   - `lib/uriMigration.ts` (rescuing rows written before either path did)
 *   - `lib/r2.ts` (before the ExpoFS.File existence check)
 */

import { Platform } from 'react-native';
import { isPurgeableAppPath } from '@/lib/clipPaths';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Metro can't handle `require(variable)` — it inlines static strings at bundle
// time. Guard with isNative so web builds don't try to pull in native-only
// Expo modules, but use literal require() so Metro knows what to bundle.
let MediaLibrary: typeof import('expo-media-library') | null = null;
let FileSystemLegacy: typeof import('expo-file-system/legacy') | null = null;
if (isNative) {
  try { MediaLibrary = require('expo-media-library'); } catch {}
  try { FileSystemLegacy = require('expo-file-system/legacy'); } catch {}
}

/**
 * Convert any picker URI to a durable `file://` path.
 * Returns the original uri if it's already a file:// path or if resolution
 * fails (caller decides how to handle the failure).
 */
export async function resolveAssetUri(uri: string): Promise<string> {
  if (!uri) return uri;

  // Already a durable path — nothing to do.
  if (uri.startsWith('file://') || uri.startsWith('/')) {
    return uri;
  }

  // Photos-backed URI — ask MediaLibrary for the real file.
  if (uri.startsWith('ph://') || uri.startsWith('assets-library://')) {
    if (!MediaLibrary) return uri;

    try {
      // Extract the asset id. ph://<uuid>/L0/001 → <uuid>
      const match = uri.match(/ph:\/\/([\w-]+)/);
      const assetId = match ? match[1] : uri;
      const info = await MediaLibrary.getAssetInfoAsync(assetId);
      if (info?.localUri && info.localUri.startsWith('file://')) {
        return info.localUri;
      }
    } catch (err) {
      console.warn('[media] getAssetInfoAsync failed for', uri, err);
    }
  }

  // Unknown scheme — fall back to original (downstream may still work).
  return uri;
}

/**
 * Ensure documentDirectory/clips/ exists — ONCE per app session (memoized).
 *
 * NEVER call getInfoAsync on the clips directory: on iOS the legacy module
 * recursively sizes the directory's contents, so the "does it exist" check
 * costs seconds once the folder holds a round's worth of video (measured
 * ~3.5s/call with ~40 clips — 12 parallel imports serialized on the native
 * module queue into a 42s stall). makeDirectoryAsync with intermediates:true
 * is mkdir -p: cheap, and a no-op when the directory already exists.
 */
let clipsDirReady: Promise<string> | null = null;
function ensureClipsDir(): Promise<string> {
  if (!clipsDirReady) {
    const dir = `${FileSystemLegacy!.documentDirectory}clips/`;
    // intermediates:true is mkdir -p — succeeds when the dir already exists,
    // so a rejection here is a REAL failure. Don't cache it (the memoization
    // would otherwise turn one transient error into permanent copy failures);
    // reset and rethrow so persistAsset's catch falls back to the source uri
    // and the next call retries.
    clipsDirReady = FileSystemLegacy!
      .makeDirectoryAsync(dir, { intermediates: true })
      .then(async () => {
        await markClipsDirExcludedFromBackup(dir);
        return dir;
      })
      .catch((err) => {
        clipsDirReady = null;
        throw err;
      });
  }
  return clipsDirReady;
}

/**
 * MEDIA-002. `documentDirectory` is NSDocumentDirectory, which iOS includes in
 * iCloud/iTunes backups by default — so every raw clip we persist here is
 * copied to Apple and restored onto whatever device restores that backup, even
 * for a user who deliberately left Cloud backup OFF and is told on
 * profile/storage-settings that their clips are not in the cloud. Marking the
 * directory NSURLIsExcludedFromBackupKey once, at creation, makes that promise
 * true for everything written into it afterwards.
 *
 * expo-file-system cannot set that key, so it goes through the native
 * shot-detector module, which also raises the directory's Data Protection class
 * to CompleteUnlessOpen (see excludeFromBackupImpl in ShotDetectorModule.swift).
 * Both are directory-level, so every clip written afterwards inherits them and
 * no future write site has to remember.
 *
 * The native function is optional-by-arity, so a JS-only OTA update landing on
 * an older binary still reports `native-unavailable` rather than pretending —
 * a false here means the clips ARE still being backed up, and no caller may
 * report otherwise on its behalf.
 *
 * Still uncovered (different owning modules, not reachable from here):
 * documentDirectory/exports/ written by lib/clipShare.ts, and the clippar.db
 * SQLite file with its per-shot GPS columns.
 *
 * Failure here is never fatal: losing the exclusion must not stop a user from
 * saving their round.
 */
const attemptedPaths = new Set<string>();
async function markExcludedFromBackup(dir: string, label: string): Promise<void> {
  if (attemptedPaths.has(dir)) return;
  attemptedPaths.add(dir);
  try {
    const { excludeFromBackup } = await import('@/modules/shot-detector');
    const result = await excludeFromBackup(dir);
    if (!result.excluded) {
      console.warn(
        `[media] ${label} is NOT excluded from iCloud backup:`,
        result.reason ?? 'unknown'
      );
    }
  } catch (err) {
    console.warn(`[media] backup-exclusion attempt failed for ${label}`, err);
  }
}

async function markClipsDirExcludedFromBackup(dir: string): Promise<void> {
  await markExcludedFromBackup(dir, 'clips/');
}

/**
 * Exclude EVERY private-media location from iCloud backup, not just clips/.
 *
 * Covering only clips/ left the two directories carrying the sharpest data:
 *
 *   SQLite/clippar.db — every recorded clip writes gps_latitude / gps_longitude
 *   (hooks/useCamera.ts), so this one small file maps a named golfer to their
 *   home course and the times they play it. It is also the item that restores
 *   most cleanly onto a second device, because it is tiny.
 *
 *   exports/ — lib/clipShare.ts copies a full-fidelity clip here every time the
 *   user saves to Photos or shares a hole. These are precisely the clips the
 *   user believes are local-only.
 *
 * Until this ran, profile/storage-settings' "Cloud backup off — clips not in
 * the cloud" was false for both of them.
 *
 * Called at startup rather than lazily, because unlike clips/ these two exist
 * without anyone having persisted an asset this session — the database is
 * opened on first read, and exports/ survives from previous runs.
 *
 * Best-effort throughout: a missing directory resolves 'not-found' and is
 * skipped, and no failure here may block launch.
 */
export async function excludePrivateMediaFromBackup(): Promise<void> {
  if (!FileSystemLegacy) return;
  const docs = FileSystemLegacy.documentDirectory;
  if (!docs) return;

  await Promise.all([
    markExcludedFromBackup(`${docs}clips/`, 'clips/'),
    // expo-sqlite puts databases in documentDirectory/SQLite/. Excluding the
    // directory covers the -wal and -shm sidecars too, which hold recently
    // written rows and would otherwise leak the newest GPS fixes on their own.
    markExcludedFromBackup(`${docs}SQLite/`, 'SQLite/ (clippar.db + GPS columns)'),
    markExcludedFromBackup(`${docs}exports/`, 'exports/'),
  ]);
}

/**
 * Copy an asset into our app's documentDirectory so it survives iOS
 * tmp-directory eviction and app reinstalls (where the tmp copy is wiped).
 * Use this if you need the strongest durability guarantee; resolveAssetUri
 * is enough for most cases.
 */
export async function persistAsset(
  uri: string,
  filename: string,
  opts?: {
    /**
     * Leave the source file where it is instead of renaming it away.
     *
     * Needed when a CALLER ALREADY HOLDS the source path and cannot be told
     * about the new one. hooks/useEditorState.ts puts `result.trimmedUri`
     * into React state (`updatedClip.sourceUri`) before markClipTrimmed is
     * ever called, so moving that file would leave the mounted editor
     * pointing at something that no longer exists — preview and export fail
     * until the screen is rebuilt from SQLite. Copying keeps the in-memory
     * path valid for the rest of the session; the row takes the durable copy,
     * and the cache original is left to reclaimTemporaryExports, which now
     * sees it as unreferenced and ages it out.
     *
     * The record path deliberately does NOT set this: nothing reads
     * `video.uri` after the move there, and it is a ~150MB file where the
     * O(1) rename is the difference between a beat and a stall between shots.
     */
    keepSource?: boolean;
  }
): Promise<string> {
  if (!FileSystemLegacy) return uri;

  const t0 = Date.now();
  let method = 'none';
  try {
    const resolved = await resolveAssetUri(uri);
    const dir = await ensureClipsDir();
    // No per-clip dest existence check: filenames embed Date.now() so they're
    // unique by construction, and every getInfoAsync is a trip through the
    // serialized native queue we just got burned by.
    const dest = `${dir}${filename}`;
    // When the source is one of our own cache copies — the picker's
    // (Library/Caches/ImagePicker), a tmp file, or expo-camera's recording in
    // Library/Caches/…/Camera — it lives on the SAME sandbox volume as
    // documentDirectory, and we were going to delete it right after copying
    // anyway — so MOVE (an O(1) rename) instead of copying every byte of the
    // video. For a 12-clip import this turns hundreds of MB of file copying
    // into a handful of renames, which is the dominant cost of import; on the
    // record path it is what lets useCamera persist a ~150MB clip without
    // adding a beat to the gap between shots. Sources outside our sandbox
    // (e.g. a Photos localUri we don't own, which moveAsync also can't cross
    // volumes to) are copied as before.
    //
    // The list of "our own cache" shapes is lib/clipPaths' to keep — the
    // camera directory was missing from the hand-written version here, from
    // uriMigration's copy of it, and from the SQL that feeds uriMigration.
    const inAppCache = isPurgeableAppPath(resolved) && !opts?.keepSource;
    if (inAppCache) {
      try {
        await FileSystemLegacy.moveAsync({ from: resolved, to: dest });
        method = 'move';
      } catch {
        // Rare cross-volume / locked-file edge case — fall back to copy+delete.
        await FileSystemLegacy.copyAsync({ from: resolved, to: dest });
        method = 'copy-fallback';
        try {
          await FileSystemLegacy.deleteAsync(resolved, { idempotent: true });
        } catch {}
      }
    } else {
      await FileSystemLegacy.copyAsync({ from: resolved, to: dest });
      method = 'copy';
    }
    console.log(`[persistAsset] ${method} ${Date.now() - t0}ms`);
    return dest;
  } catch (err) {
    console.warn('[media] persistAsset failed for', uri, err);
    return uri;
  }
}
