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
if (isNative) {
  try { MediaLibrary = require('expo-media-library'); } catch {}
  try { RNShare = require('react-native-share').default; } catch {}
}

/**
 * Save a single clip's video file to the user's Photos library.
 * Returns true on success, false if permission was denied or save failed.
 */
export async function saveClipToPhotos(uri: string): Promise<boolean> {
  if (!isNative || !MediaLibrary) return false;
  try {
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (perm.status !== 'granted') return false;
    await MediaLibrary.saveToLibraryAsync(uri);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
