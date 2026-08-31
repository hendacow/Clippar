/**
 * Copy a raw clip into the user's Photos library — the ONLY implementation of
 * "Save raw clips to Photos" (app/profile/storage-settings.tsx).
 *
 * The setting used to be honoured on the import path and nowhere else, so
 * every clip the app itself recorded was saved with no `photos_asset_id` and
 * was invisible to reinstall recovery (lib/photosRecovery.ts) — while the
 * settings screen showed a green tick claiming the opposite. See
 * lib/photosMirrorPolicy.ts for the full history and for the WHEN decision,
 * which is pure and shared so the two paths cannot drift apart again.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. MIRRORING IS NEVER LOAD-BEARING. The clip file and its SQLite row come
 *    first, always. A denied permission, a full library or a MediaLibrary
 *    throw costs the user an asset id — never the footage, which was shot on a
 *    golf course and cannot be shot again. Every failure path returns null and
 *    logs; none of them rethrow, and none of them touch the clip.
 *
 * 2. THE RECORD PATH NEVER RAISES A PERMISSION DIALOG. It runs moments after a
 *    shot, often triggered by a clicker press, over a live camera — spec 6.5
 *    (a clicker event must not raise a permission dialog) and the in-context
 *    prompting rule in app/(tabs)/record.tsx both forbid it. Permission is
 *    asked for at the moment the user turns the setting ON, which is the
 *    in-context moment for both paths; here the record path only READS the
 *    verdict (getPermissionsAsync, non-prompting).
 */
import { Platform } from 'react-native';
import { getMirrorClipsToPhotos, setClipPhotosAssetId } from '@/lib/storage';

export const CLIPPAR_ALBUM = 'Clippar';
import {
  resolveMirrorPlan,
  resolvePersistedAssetId,
} from '@/lib/photosMirrorPolicy';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Metro inlines static require() strings at bundle time, so keep the literal
// and guard on platform — same shape as lib/media.ts and lib/photosRecovery.ts.
let MediaLibrary: typeof import('expo-media-library') | null = null;
if (isNative) {
  try {
    MediaLibrary = require('expo-media-library');
  } catch {}
}

export type PhotosMirrorPermission =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'unavailable';

/**
 * Read the Photos permission WITHOUT prompting. Safe to call from anywhere,
 * including mid-round.
 */
export async function getPhotosMirrorPermission(): Promise<PhotosMirrorPermission> {
  if (!isNative || !MediaLibrary) return 'unavailable';
  try {
    const perm = await MediaLibrary.getPermissionsAsync();
    if (perm.status === 'granted') return 'granted';
    // canAskAgain distinguishes "not asked yet" from "asked and refused".
    // iOS never re-prompts after a refusal, so the two need different copy:
    // one is a dialog away, the other needs a trip to Settings.
    return perm.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * PROMPTING. Call this only from a foreground, user-initiated moment — the
 * storage-settings toggle is the one that matters, because that is where the
 * user commits to the feature. Returns whether mirroring can actually work
 * from here on; a `false` means the caller must NOT leave the setting looking
 * enabled, or we are back to a switch that promises a backup it cannot make.
 */
export async function requestPhotosMirrorPermission(): Promise<boolean> {
  if (!isNative || !MediaLibrary) return false;
  try {
    const perm = await MediaLibrary.requestPermissionsAsync();
    return perm.status === 'granted';
  } catch (err) {
    console.warn('[photosMirror] permission request failed:', err);
    return false;
  }
}

export interface MirrorClipParams {
  /** The raw file to copy. Recorded clips: the untrimmed original. */
  fileUri: string;
  /** Asset id the clip already has (picked from Photos) — kept as-is. */
  existingAssetId?: string | null;
  /**
   * Pre-read value of the setting. Import reads it once for a whole batch
   * rather than once per clip; omit it and we read it ourselves, so a caller
   * cannot forget the toggle exists — forgetting is the original bug.
   */
  mirrorEnabled?: boolean;
  /**
   * Allow a system permission dialog. FALSE on any path that can run while the
   * camera is live (see rule 2 at the top of this file). Import passes true:
   * the user just tapped Import in the foreground, and users who enabled the
   * toggle before it asked for permission still rely on that prompt.
   */
  promptForPermission?: boolean;
  /** Log prefix so a failure names the path it came from. */
  label?: string;
}

/**
 * Returns the asset id the clip row should store, or null if there is no
 * Photos copy. Never throws.
 */
export async function mirrorClipToPhotos(
  params: MirrorClipParams
): Promise<string | null> {
  const {
    fileUri,
    existingAssetId = null,
    promptForPermission = false,
    label = 'mirror',
  } = params;

  let mirrorEnabled = params.mirrorEnabled;
  if (mirrorEnabled === undefined) {
    try {
      mirrorEnabled = await getMirrorClipsToPhotos();
    } catch {
      // Settings read failed. Fail CLOSED for the copy (we don't know the
      // user asked for it) but never for the clip — the caller carries on.
      mirrorEnabled = false;
    }
  }

  const plan = resolveMirrorPlan({
    mirrorEnabled,
    existingAssetId,
    fileUri,
    native: isNative,
    mediaLibraryAvailable: !!MediaLibrary,
  });

  if (plan.action !== 'mirror') {
    return resolvePersistedAssetId(plan, null);
  }

  try {
    let permission = await getPhotosMirrorPermission();
    if (permission === 'undetermined' && promptForPermission) {
      permission = (await requestPhotosMirrorPermission())
        ? 'granted'
        : 'denied';
    }
    if (permission !== 'granted') {
      // Loud on purpose. This is the exact state the old green tick hid: the
      // setting is on, the user believes their footage is being copied, and
      // it is not. The settings screen surfaces it too — it must never be
      // swallowed into a success.
      console.warn(
        `[photosMirror] ${label}: setting is ON but Photos access is ${permission} — clip NOT mirrored and will not survive a reinstall`
      );
      return null;
    }

    const asset = await MediaLibrary!.createAssetAsync(fileUri);
    // File into the "Clippar" album — the album IS the reinstall index
    // (durability plan §6): after a delete-and-reinstall the app rebuilds
    // rounds by scanning it. Album failure never fails the mirror; the
    // asset still exists in the library.
    try {
      const album = await MediaLibrary!.getAlbumAsync(CLIPPAR_ALBUM);
      if (album) {
        await MediaLibrary!.addAssetsToAlbumAsync([asset], album, false);
      } else if (asset) {
        await MediaLibrary!.createAlbumAsync(CLIPPAR_ALBUM, asset, false);
      }
    } catch (albumErr) {
      console.warn(`[photosMirror] ${label}: asset saved but album filing failed:`, albumErr);
    }
    return resolvePersistedAssetId(plan, asset?.id ?? null);
  } catch (err) {
    // Library full, iCloud stall, sandbox refusal — the clip and its row are
    // already safe, so this is a lost recovery hint, not a lost shot.
    console.warn(`[photosMirror] ${label}: mirror to Photos failed:`, err);
    return null;
  }
}

/**
 * Record path (hooks/useCamera.ts). The clip row already exists by the time we
 * get here — deliberately, so the Photos copy can never delay or fail the
 * save — so the asset id is written onto the row afterwards instead of being
 * passed to saveLocalClip the way import does it.
 *
 * Fire-and-forget: callers `void` this off the recording hot path so a Photos
 * write never sits between the golfer and their next shot.
 */
export async function mirrorRecordedClip(
  clipId: number,
  fileUri: string
): Promise<string | null> {
  if (!clipId) return null;
  const assetId = await mirrorClipToPhotos({
    fileUri,
    // Never prompts — see rule 2. A clip recorded while the permission is
    // undetermined is simply not mirrored, and storage-settings says so.
    promptForPermission: false,
    label: 'record',
  });
  if (!assetId) return null;
  try {
    await setClipPhotosAssetId(clipId, assetId);
  } catch (err) {
    // The copy is in Photos but the row lost its pointer, so recovery can't
    // find it. Worth knowing about; still not worth failing the clip over.
    console.warn(
      `[photosMirror] record: clip ${clipId} mirrored but asset id not persisted:`,
      err
    );
    return null;
  }
  return assetId;
}
