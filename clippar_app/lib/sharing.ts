import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Haptics from 'expo-haptics';
import { supabase } from '@/lib/supabase';

// react-native-share requires native module — not available in Expo Go
let RNShare: any = null;
try {
  RNShare = require('react-native-share').default;
} catch {
  // Native module not available
}

/**
 * Download a video from a signed URL to a local temp file.
 * Caches by roundId so re-shares don't re-download.
 */
export async function getLocalVideoUri(
  signedUrl: string,
  roundId: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const filename = `clippar_reel_${roundId}.mp4`;
  const localUri = FileSystem.cacheDirectory + filename;

  // Check cache
  const info = await FileSystem.getInfoAsync(localUri);
  if (info.exists && (info as any).size > 0) {
    return localUri;
  }

  // Download with progress
  const download = FileSystem.createDownloadResumable(
    signedUrl,
    localUri,
    {},
    (progress) => {
      if (onProgress && progress.totalBytesExpectedToWrite > 0) {
        onProgress(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
      }
    }
  );

  const result = await download.downloadAsync();
  if (!result?.uri) {
    throw new Error('Video download failed. Please check your connection and try again.');
  }
  return result.uri;
}

/**
 * Save a video to the device camera roll / photo library.
 * Creates a "Clippar" album on iOS.
 */
export async function saveToGallery(
  signedUrl: string,
  roundId: string,
  onProgress?: (pct: number) => void
): Promise<boolean> {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== 'granted') {
    return false;
  }

  // If the URL is already a local file, use it directly — no download needed
  let localUri: string;
  if (signedUrl.startsWith('file://') || signedUrl.startsWith('/')) {
    localUri = signedUrl;
  } else {
    localUri = await getLocalVideoUri(signedUrl, roundId, onProgress);
  }

  const asset = await MediaLibrary.createAssetAsync(localUri);

  // Save to a "Clippar" album
  try {
    const album = await MediaLibrary.getAlbumAsync('Clippar');
    if (album) {
      await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
    } else {
      await MediaLibrary.createAlbumAsync('Clippar', asset, false);
    }
  } catch {
    // Album creation may fail in Expo Go — asset is still saved to camera roll
  }

  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  return true;
}

/**
 * Share a reel via the system share sheet.
 * Downloads to local file first (share sheet needs a local file, not a URL).
 */
export async function shareReel(params: {
  reelUrl: string;
  roundId: string;
  courseName: string;
  score?: number;
  onProgress?: (pct: number) => void;
}) {
  if (!RNShare) return;

  // If the URL is already a local file, use it directly — no download needed
  let localUri: string;
  if (params.reelUrl.startsWith('file://') || params.reelUrl.startsWith('/')) {
    localUri = params.reelUrl;
  } else {
    localUri = await getLocalVideoUri(params.reelUrl, params.roundId, params.onProgress);
  }

  await RNShare.open({
    title: `My round at ${params.courseName}`,
    message: params.score
      ? `Check out my round at ${params.courseName} — shot ${params.score}!`
      : `Check out my round at ${params.courseName}!`,
    url: Platform.OS === 'android' ? `file://${localUri}` : localUri,
    type: 'video/mp4',
  }).catch(() => {});
}

/**
 * Share to Instagram Stories with video as background.
 */
export async function shareToInstagramStories(
  signedUrl: string,
  roundId: string
) {
  if (!RNShare) return;

  try {
    // If the URL is already a local file, use it directly — no download needed
    let localUri: string;
    if (signedUrl.startsWith('file://') || signedUrl.startsWith('/')) {
      localUri = signedUrl;
    } else {
      localUri = await getLocalVideoUri(signedUrl, roundId);
    }
    await RNShare.shareSingle({
      social: 'instagramstories' as any,
      backgroundVideo: Platform.OS === 'android' ? `file://${localUri}` : localUri,
      type: 'video/mp4',
    });
  } catch {
    // Instagram not installed or share failed
  }
}

/**
 * Generate a shareable link for a round.
 */
export async function getShareUrl(roundId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke('create-share-link', {
      body: { round_id: roundId },
    });
    if (error || !data) return null;
    return data.share_url ?? null;
  } catch {
    return null;
  }
}
