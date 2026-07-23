/**
 * Shared reel_url → playable source resolution (the three-way decode that
 * used to be duplicated across Home and round detail).
 *
 * rounds.reel_url can be:
 *   1. file:// or absolute path — on-device compose output. Playable only
 *      while the file still exists (wiped on reinstall).
 *   2. Full https URL — legacy rows; re-sign the underlying storage path
 *      so it doesn't expire, else pass through.
 *   3. Bare storage path (e.g. "reels/xxx.mp4") — sign against Supabase.
 *
 * Async/caching rule: existence checks and URL signing happen once per
 * fetch (inside fetchRounds/fetchRound); results are memoized in a
 * module-level Map for the session. List rows never perform per-render
 * filesystem I/O — they render from the precomputed result.
 */
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

export interface ReelSource {
  /** Playable URI (local path or signed URL), or null when unresolvable. */
  uri: string | null;
  /**
   * true  — verified playable
   * false — verified dead (missing file / unsignable while online)
   * null  — unknown (offline, couldn't verify) — treat as playable, show
   *         the offline overlay instead of a scary rebuild prompt.
   */
  playable: boolean | null;
  /** Set when resolution failed because the device is offline. */
  offline?: boolean;
}

// Session-level memo. Only conclusive results are cached: positive
// resolutions and dead file:// paths (a deleted file won't come back).
// Failed signing while offline is NOT cached so connectivity restore
// re-resolves naturally on the next fetch.
const cache = new Map<string, ReelSource>();

/** Test/refresh hook — clears the session cache. */
export function clearReelSourceCache(): void {
  cache.clear();
}

async function isOffline(): Promise<boolean> {
  try {
    const NetInfo = require('@react-native-community/netinfo').default;
    const state = await NetInfo.fetch();
    return state?.isConnected === false;
  } catch {
    return false;
  }
}

async function localFileExists(uri: string): Promise<boolean> {
  if (!isNative) return false;
  try {
    const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const info = await FileSystem.getInfoAsync(uri);
    return !!info.exists;
  } catch {
    return false;
  }
}

async function signStoragePath(bucket: string, path: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 86_400);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

export async function resolveReelSource(reelUrl: string | null | undefined): Promise<ReelSource> {
  if (!reelUrl) return { uri: null, playable: false };

  const cached = cache.get(reelUrl);
  if (cached) return cached;

  let result: ReelSource;
  let cacheable = true;

  if (reelUrl.startsWith('file://') || reelUrl.startsWith('/')) {
    // Local compose output — playable only if still on disk.
    const exists = await localFileExists(reelUrl);
    result = { uri: exists ? reelUrl : null, playable: exists };
  } else if (reelUrl.startsWith('http')) {
    // Full URL — re-sign the underlying storage path so it doesn't expire.
    const match = reelUrl.match(/\/object\/(?:public\/)?clips\/(.+?)(?:\?|$)/);
    if (match) {
      const signed = await signStoragePath('clips', match[1]);
      if (signed) {
        result = { uri: signed, playable: true };
      } else {
        const offline = await isOffline();
        result = { uri: null, playable: offline ? null : false, offline };
        cacheable = false;
      }
    } else {
      // Unknown host/shape — pass through and let the player try.
      result = { uri: reelUrl, playable: true };
    }
  } else {
    // Bare storage path. Historical rows live in either the `clips` or the
    // `reels` bucket — try clips first (round detail's behaviour), then reels.
    const path = reelUrl.startsWith('clips/') ? reelUrl.slice(6) : reelUrl;
    const signed =
      (await signStoragePath('clips', path)) ?? (await signStoragePath('reels', reelUrl));
    if (signed) {
      result = { uri: signed, playable: true };
    } else {
      const offline = await isOffline();
      result = { uri: null, playable: offline ? null : false, offline };
      cacheable = false;
    }
  }

  if (cacheable) cache.set(reelUrl, result);
  return result;
}
