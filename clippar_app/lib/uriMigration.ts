/**
 * One-shot migration: resolve legacy `ph://`, `assets-library://`, and
 * `/tmp/...` URIs stored in local_clips to durable `file://` paths. Without
 * this, any clip imported before the URI-normalization fix silently fails
 * when the iOS tmp directory is purged (reinstall, simulator reset, iOS
 * cleaning up storage) and the editor shows an empty timeline.
 *
 * Called once from app startup (`_layout.tsx`). Idempotent — rows that
 * already have a file:// path are ignored.
 */
import { Platform } from 'react-native';
import { resolveAssetUri, persistAsset } from '@/lib/media';
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
        const isEvictable = (uri: string) =>
          uri.startsWith('ph://') ||
          uri.startsWith('assets-library://') ||
          uri.includes('/tmp/') ||
          uri.includes('/Library/Caches/ImagePicker/');

        const needsFileUri = isEvictable(row.file_uri);

        const needsOriginal =
          !!row.original_file_uri && isEvictable(row.original_file_uri);

        let nextFileUri = row.file_uri;
        let nextOriginalUri: string | null | undefined = row.original_file_uri;

        // For purgeable on-disk paths (tmp/ or Library/Caches/ImagePicker/)
        // we want to COPY into documentDirectory so we're not at iOS's
        // mercy. ph:// is stable once resolved to localUri so plain
        // resolveAssetUri is enough (localUri is in the PhotoKit sandbox
        // which iOS doesn't purge on memory pressure).
        const needsCopy = (uri: string) =>
          uri.includes('/tmp/') || uri.includes('/Library/Caches/ImagePicker/');

        if (needsFileUri) {
          const resolved = needsCopy(row.file_uri)
            ? await persistAsset(row.file_uri, `clip_${row.id}_${Date.now()}.mp4`)
            : await resolveAssetUri(row.file_uri);
          if (resolved && resolved !== row.file_uri) nextFileUri = resolved;
        }

        if (needsOriginal && row.original_file_uri) {
          const resolved = needsCopy(row.original_file_uri)
            ? await persistAsset(row.original_file_uri, `orig_${row.id}_${Date.now()}.mp4`)
            : await resolveAssetUri(row.original_file_uri);
          if (resolved && resolved !== row.original_file_uri) nextOriginalUri = resolved;
        }

        const changed =
          nextFileUri !== row.file_uri ||
          nextOriginalUri !== row.original_file_uri;

        if (changed) {
          await updateClipFileUris(row.id, nextFileUri, nextOriginalUri);
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
