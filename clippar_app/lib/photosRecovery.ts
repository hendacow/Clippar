/**
 * Re-hydrate clips from the user's Photos library after a reinstall.
 *
 * On reinstall, `documentDirectory` is wiped — every clip's `file_uri` points
 * at a path that no longer exists. If the clip was originally imported from
 * Photos (we stored `photos_asset_id` from the picker) OR mirrored to Photos
 * via the "Save raw clips to Photos" toggle, the Photos asset is still there
 * and we can copy it back into documentDirectory automatically.
 *
 * Called from app/_layout.tsx during startup, after migrateLegacyUris.
 *
 * Cloud-backed clips (Pro tier) are recovered separately by the editor's
 * existing storagePath-based download flow — this module only deals with
 * the local Photos-library route.
 */
import { Platform } from 'react-native';
import { getClipsWithPhotosAssetId } from '@/lib/storage';
import { persistAsset } from '@/lib/media';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

let MediaLibrary: typeof import('expo-media-library') | null = null;
let FS: typeof import('expo-file-system/legacy') | null = null;
if (isNative) {
  try { MediaLibrary = require('expo-media-library'); } catch {}
  try { FS = require('expo-file-system/legacy'); } catch {}
}

export async function hydrateMissingClipsFromPhotos(): Promise<{
  scanned: number;
  recovered: number;
}> {
  if (!isNative || !MediaLibrary || !FS) return { scanned: 0, recovered: 0 };

  let scanned = 0;
  let recovered = 0;

  try {
    // Need read permission to call getAssetInfoAsync.
    const perm = await MediaLibrary.getPermissionsAsync();
    if (perm.status !== 'granted') {
      // Don't prompt on launch — defer to next user-initiated action that
      // already requests Photos permission. Skip silently for now.
      return { scanned: 0, recovered: 0 };
    }

    const rows = await getClipsWithPhotosAssetId();
    if (rows.length === 0) return { scanned: 0, recovered: 0 };

    const { updateClipFileUris } = await import('@/lib/storage');

    for (const row of rows) {
      scanned++;
      try {
        // Skip if the on-disk file is still there (most clips post-launch).
        const info = await FS.getInfoAsync(row.file_uri);
        if (info.exists) continue;

        if (!row.photos_asset_id) continue;

        // Resolve the Photos asset back to a usable file:// path, then
        // copy into documentDirectory so future runs are stable.
        const assetInfo = await MediaLibrary.getAssetInfoAsync(row.photos_asset_id);
        const localUri = assetInfo?.localUri;
        if (!localUri) continue;

        const filename = `recovered_${row.id}_${Date.now()}.mp4`;
        const durable = await persistAsset(localUri, filename);
        if (!durable || durable === localUri) continue;

        await updateClipFileUris(row.id, durable, durable);
        recovered++;
        console.log(`[photosRecovery] clip ${row.id} re-hydrated from Photos`);
      } catch (err) {
        console.warn(`[photosRecovery] clip ${row.id} failed:`, err);
      }
    }

    if (recovered > 0) {
      console.log(`[photosRecovery] recovered ${recovered}/${scanned} clips from Photos`);
    }
  } catch (err) {
    console.warn('[photosRecovery] scan failed:', err);
  }

  return { scanned, recovered };
}
