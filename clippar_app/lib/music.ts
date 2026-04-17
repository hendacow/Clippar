import { Platform } from 'react-native';
import { supabase } from './supabase';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Conditionally import expo-file-system (native only, v19+ API)
let ExpoFS: typeof import('expo-file-system') | null = null;
if (isNative) {
  try {
    ExpoFS = require('expo-file-system') as typeof import('expo-file-system');
  } catch {}
}

/**
 * Bundled music track IDs and their corresponding asset require() calls.
 * These are royalty-free tracks shipped with the app binary.
 */
const BUNDLED_ASSET_MAP: Record<string, number> = {
  chill_vibes: require('@/assets/music/chill_vibes.m4a'),
  victory_lap: require('@/assets/music/victory_lap.m4a'),
  focus_mode: require('@/assets/music/focus_mode.m4a'),
};

/**
 * Check if a track ID refers to a bundled (on-device) music asset.
 */
export function isBundledTrack(trackId: string): boolean {
  return trackId in BUNDLED_ASSET_MAP;
}

/**
 * Resolve a bundled track to its local file URI using Expo Asset.
 * Downloads the asset from the bundle to a local cache directory if needed.
 */
async function resolveBundledTrackUri(trackId: string): Promise<string | null> {
  if (!isNative) return null;

  const assetModule = BUNDLED_ASSET_MAP[trackId];
  if (!assetModule) return null;

  try {
    // Use Expo's Asset system to resolve the bundled file to a local URI.
    const { Asset } = require('expo-asset') as typeof import('expo-asset');
    const asset = Asset.fromModule(assetModule);
    await asset.downloadAsync();
    return asset.localUri ?? null;
  } catch {
    console.warn(`[Music] Could not resolve bundled track ${trackId} via expo-asset`);
    return null;
  }
}

/**
 * Download a remote music file (e.g. Supabase Storage URL) to local cache.
 * Returns the local file:// URI, or null if download failed.
 *
 * Caches by track ID so repeated exports don't re-download.
 */
async function downloadRemoteTrack(
  trackId: string,
  fileUrl: string,
): Promise<string | null> {
  if (!isNative || !ExpoFS) return null;

  const extension = fileUrl.includes('.mp3') ? '.mp3' : '.m4a';
  const musicDir = new ExpoFS.Directory(ExpoFS.Paths.cache, 'music');
  const localFile = new ExpoFS.File(musicDir, `${trackId}${extension}`);

  // Check if already cached
  if (localFile.exists) {
    return localFile.uri;
  }

  // Ensure cache directory exists
  if (!musicDir.exists) {
    musicDir.create();
  }

  // If file_url is a Supabase storage path (not a full URL), sign it
  let downloadUrl = fileUrl;
  if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
    // It's a storage path like "music/track_id.m4a" — sign it
    const { data, error } = await supabase.storage
      .from('music')
      .createSignedUrl(fileUrl, 3600);
    if (error || !data?.signedUrl) {
      console.warn(`[Music] Failed to sign URL for ${fileUrl}:`, error?.message);
      return null;
    }
    downloadUrl = data.signedUrl;
  }

  try {
    // Download using fetch + write to file
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      console.warn(`[Music] Download failed with status ${response.status} for ${trackId}`);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Write to local file
    localFile.write(bytes);
    return localFile.uri;
  } catch (err) {
    console.warn(`[Music] Download error for ${trackId}:`, err);
    return null;
  }
}

/**
 * Resolve a music track to a local file URI that can be passed to the native
 * composition engine. Handles both bundled and server-hosted tracks.
 *
 * @param trackId - The track's unique ID
 * @param fileUrl - The track's file_url from the database (may be a storage path or full URL)
 * @returns Local file:// URI or absolute path, or null if resolution failed
 */
export async function resolveTrackToLocalUri(
  trackId: string,
  fileUrl?: string | null,
): Promise<string | null> {
  // 1. Try bundled asset first
  if (isBundledTrack(trackId)) {
    const bundledUri = await resolveBundledTrackUri(trackId);
    if (bundledUri) return bundledUri;
  }

  // 2. Download from server if we have a file_url
  if (fileUrl) {
    return downloadRemoteTrack(trackId, fileUrl);
  }

  console.warn(`[Music] No file_url and not a bundled track: ${trackId}`);
  return null;
}
