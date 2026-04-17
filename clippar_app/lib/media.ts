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
 *   - `lib/r2.ts` (before the ExpoFS.File existence check)
 */

import { Platform } from 'react-native';

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
 * Copy an asset into our app's documentDirectory so it survives iOS
 * tmp-directory eviction and app reinstalls (where the tmp copy is wiped).
 * Use this if you need the strongest durability guarantee; resolveAssetUri
 * is enough for most cases.
 */
export async function persistAsset(uri: string, filename: string): Promise<string> {
  if (!FileSystemLegacy) return uri;

  try {
    const resolved = await resolveAssetUri(uri);
    const dir = `${FileSystemLegacy.documentDirectory}clips/`;
    const dirInfo = await FileSystemLegacy.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystemLegacy.makeDirectoryAsync(dir, { intermediates: true });
    }
    const dest = `${dir}${filename}`;
    const destInfo = await FileSystemLegacy.getInfoAsync(dest);
    if (destInfo.exists) return dest;
    await FileSystemLegacy.copyAsync({ from: resolved, to: dest });
    return dest;
  } catch (err) {
    console.warn('[media] persistAsset failed for', uri, err);
    return uri;
  }
}
