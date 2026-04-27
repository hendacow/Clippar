/**
 * Per-clip and per-hole share / download helpers.
 *
 * Reuses `MediaLibrary.saveToLibraryAsync` for save-to-Photos and the
 * native `stitchClips` Swift function for "stitch this hole's clips".
 * Uses the iOS share sheet (react-native-share) for the share flow.
 */
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { stitchClips } from 'shot-detector';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

let MediaLibrary: typeof import('expo-media-library') | null = null;
let RNShare: any = null;
let FileSystemLegacy: typeof import('expo-file-system/legacy') | null = null;
if (isNative) {
  try { MediaLibrary = require('expo-media-library'); } catch {}
  try { RNShare = require('react-native-share').default; } catch {}
  try { FileSystemLegacy = require('expo-file-system/legacy'); } catch {}
}

/**
 * Save a single clip's video file to the user's Photos library.
 *
 * Trim files written by detectAndTrim live in cachesDirectory which iOS
 * may evict at any time. Earlier versions of this function called
 * MediaLibrary.saveToLibraryAsync directly — when the cache file had
 * been purged, the call resolved successfully (no exception) but
 * nothing actually appeared in Photos. The user only saw a fake
 * "Saved" alert.
 *
 * Fix: explicitly check the file exists, and if it's in cachesDirectory
 * copy it into documentDirectory (durable) before handing off to
 * MediaLibrary. The Photos save then has a stable path even if iOS
 * decides to evict the original cache copy mid-save.
 *
 * Returns true on success, false on any failure (permission, file
 * missing, copy failed, save failed).
 */
export async function saveClipToPhotos(uri: string): Promise<boolean> {
  if (!isNative || !MediaLibrary || !FileSystemLegacy) return false;
  try {
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (perm.status !== 'granted') {
      console.warn('[clipShare] saveClipToPhotos: Photos permission not granted');
      return false;
    }

    // 1. Confirm the file actually exists.
    const info = await FileSystemLegacy.getInfoAsync(uri);
    if (!info.exists) {
      console.warn(
        `[clipShare] saveClipToPhotos: file does not exist at ${uri.slice(-60)} — likely evicted from iOS cache`,
      );
      return false;
    }

    // 2. If the file is in cachesDirectory or tmp, copy to documentDirectory
    //    so the save has a stable path. Saves done from cache directly can
    //    silently fail if iOS evicts mid-save.
    let saveUri = uri;
    const isPurgeable = uri.includes('/Library/Caches/') || uri.includes('/tmp/');
    if (isPurgeable) {
      const filename = uri.split('/').pop() ?? `clip_${Date.now()}.mp4`;
      const destDir = `${FileSystemLegacy.documentDirectory}exports/`;
      const destInfo = await FileSystemLegacy.getInfoAsync(destDir);
      if (!destInfo.exists) {
        await FileSystemLegacy.makeDirectoryAsync(destDir, { intermediates: true });
      }
      const dest = `${destDir}${filename}`;
      try {
        await FileSystemLegacy.copyAsync({ from: uri, to: dest });
        saveUri = dest;
      } catch (copyErr) {
        console.warn('[clipShare] copy-to-documents failed, falling back to original uri:', copyErr);
      }
    }

    // 3. Hand off to Photos. saveToLibraryAsync resolves once the asset
    //    has been added to the Photos database — at that point the file
    //    is independent of our app sandbox.
    await MediaLibrary.saveToLibraryAsync(saveUri);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    console.log(`[clipShare] saveClipToPhotos: saved ${saveUri.slice(-60)}`);
    return true;
  } catch (err) {
    console.warn('[clipShare] saveClipToPhotos failed:', err);
    return false;
  }
}

/**
 * Open the iOS share sheet for a single clip — covers AirDrop, Messages,
 * WhatsApp, Mail, Save Video, etc. Sends the actual video file (not a URL).
 */
export async function shareClip(uri: string, title: string): Promise<void> {
  if (!isNative || !RNShare) return;
  await RNShare.open({
    title,
    message: title,
    url: Platform.OS === 'android' ? `file://${uri}` : uri,
    type: 'video/mp4',
  }).catch(() => {});
}

/**
 * Stitch all clips for one hole into a single video and return its file URI.
 * Caller decides whether to save / share / preview the result.
 *
 * The native side concatenates the clips with no overlay or music — for
 * "Hole N highlight" use this is the right behaviour. Returns null on
 * failure (e.g., empty input or stitch error).
 */
export async function stitchHoleClips(clipUris: string[]): Promise<string | null> {
  if (clipUris.length === 0) return null;
  try {
    const result = await stitchClips(clipUris);
    return result.stitchedUri ?? null;
  } catch (err) {
    console.warn('[clipShare] stitchHoleClips failed:', err);
    return null;
  }
}

/**
 * Stitch the hole's clips and save the result to Photos.
 */
export async function saveHoleToPhotos(clipUris: string[]): Promise<boolean> {
  const stitched = await stitchHoleClips(clipUris);
  if (!stitched) return false;
  return saveClipToPhotos(stitched);
}

/**
 * Stitch the hole's clips and open the iOS share sheet so the user
 * can pick the destination (AirDrop, iMessage, WhatsApp, etc.).
 */
export async function shareHole(
  clipUris: string[],
  holeNumber: number,
  courseName: string,
): Promise<void> {
  const stitched = await stitchHoleClips(clipUris);
  if (!stitched) return;
  await shareClip(stitched, `Hole ${holeNumber} – ${courseName}`);
}
