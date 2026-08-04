/**
 * One-shot migration: resolve legacy `ph://`, `assets-library://`, `/tmp/…`
 * and cache-directory URIs stored in local_clips to durable `file://` paths.
 * Without this, any clip whose row was written before the corresponding
 * capture path learned to persist its footage silently fails when iOS purges
 * the directory (reinstall, simulator reset, storage pressure) and the editor
 * shows an empty timeline.
 *
 * That covers imports from before the URI-normalization fix, and — the reason
 * the rule moved into lib/clipPaths — every clip RECORDED before this change,
 * which sat in expo-camera's `Library/Caches/…/Camera/` for its whole life.
 * Those rows exist on installed phones right now, so hooks/useCamera.ts
 * persisting new recordings is only half the fix; this is the other half.
 *
 * Called once from app startup (`_layout.tsx`). Idempotent — rows that
 * already have a durable file:// path are ignored.
 */
import { Platform } from 'react-native';
import { resolveAssetUri, persistAsset } from '@/lib/media';
import { isEvictableUri, isPurgeableAppPath, videoExtension } from '@/lib/clipPaths';
import {
  getClipsWithLegacyUris,
  updateClipFileUris,
} from '@/lib/storage';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

export async function migrateLegacyUris(): Promise<{ scanned: number; migrated: number }> {
  if (!isNative) return { scanned: 0, migrated: 0 };

  let scanned = 0;
  let migrated = 0;

  try {
    const rows = await getClipsWithLegacyUris();
    scanned = rows.length;
    if (rows.length === 0) return { scanned, migrated };

    console.log(`[uriMigration] Found ${rows.length} clip(s) with legacy URIs — resolving...`);

    for (const row of rows) {
      try {
        // isEvictableUri / isPurgeableAppPath come from lib/clipPaths, which
        // also generates the SELECT above. They used to be two closures right
        // here listing the same four patterns as the query; keeping the answer
        // in one place is what lets the camera cache be added once.
        const needsFileUri = isEvictableUri(row.file_uri);

        const needsOriginal =
          !!row.original_file_uri && isEvictableUri(row.original_file_uri);

        let nextFileUri = row.file_uri;
        let nextOriginalUri: string | null | undefined = row.original_file_uri;

        // For purgeable on-disk paths (tmp/, the picker cache, the camera
        // cache) we MOVE into documentDirectory so we're not at iOS's mercy.
        // ph:// is stable once resolved to localUri so plain resolveAssetUri
        // is enough (localUri is in the PhotoKit sandbox which iOS doesn't
        // purge on memory pressure).
        //
        // ONCE PER DISTINCT SOURCE. Both columns hold the SAME path for every
        // clip that hasn't been trimmed yet — that is how useCamera and
        // import.tsx write the row — and persistAsset's rescue is a move. Run
        // independently, the file_uri pass would relocate the file and the
        // original_file_uri pass would then find nothing at the old path, take
        // persistAsset's swallow-and-return-source fallback, and leave the
        // column pointing into a directory we had just emptied ourselves.
        //
        // The extension is carried across rather than assumed: these rows are
        // now mostly `.mov` recordings, and the previous hardcoded `.mp4`
        // would have mislabelled every one of them.
        const rescued = new Map<string, string>();
        const rescue = async (uri: string, prefix: string): Promise<string> => {
          const already = rescued.get(uri);
          if (already) return already;
          const resolved = isPurgeableAppPath(uri)
            ? await persistAsset(
                uri,
                `${prefix}_${row.id}_${Date.now()}.${videoExtension(uri)}`
              )
            : await resolveAssetUri(uri);
          rescued.set(uri, resolved);
          return resolved;
        };

        if (needsFileUri) {
          const resolved = await rescue(row.file_uri, 'clip');
          if (resolved && resolved !== row.file_uri) nextFileUri = resolved;
        }

        if (needsOriginal && row.original_file_uri) {
          const resolved = await rescue(row.original_file_uri, 'orig');
          if (resolved && resolved !== row.original_file_uri) nextOriginalUri = resolved;
        }

        // trimmed_file_uri is a duplicate of file_uri (markClipTrimmed writes
        // both), so it needs no rescue of its own — but it does need to follow,
        // or it is left naming a cache file we just moved away. The `rescued`
        // map makes that automatic: the same source resolves to the same
        // destination rather than attempting a second move.
        let nextTrimmedUri: string | null | undefined = row.trimmed_file_uri;
        if (row.trimmed_file_uri && isEvictableUri(row.trimmed_file_uri)) {
          const resolved = await rescue(row.trimmed_file_uri, 'trimmed');
          if (resolved && resolved !== row.trimmed_file_uri) nextTrimmedUri = resolved;
        }

        const changed =
          nextFileUri !== row.file_uri ||
          nextOriginalUri !== row.original_file_uri ||
          nextTrimmedUri !== row.trimmed_file_uri;

        if (changed) {
          await updateClipFileUris(row.id, nextFileUri, nextOriginalUri, nextTrimmedUri);
          migrated++;
          console.log(`[uriMigration] clip ${row.id}: ${row.file_uri.slice(0, 40)}... → ${nextFileUri.slice(0, 40)}...`);
        }
      } catch (err) {
        console.warn(`[uriMigration] failed for clip ${row.id}:`, err);
      }
    }

    console.log(`[uriMigration] Migrated ${migrated}/${scanned} clip URIs`);
  } catch (err) {
    console.warn('[uriMigration] scan failed:', err);
  }

  return { scanned, migrated };
}
