/**
 * When does a raw clip get copied into the user's Photos library?
 *
 * WHY THIS IS ITS OWN MODULE. "Save raw clips to Photos"
 * (app/profile/storage-settings.tsx) shipped with exactly ONE reader —
 * app/round/import.tsx. The record path, which is how most footage actually
 * enters the app, never read the setting at all: a recorded clip was saved
 * with no `photos_asset_id`, so reinstall recovery (lib/photosRecovery.ts,
 * which selects on that column) could not see it. A golfer turned the toggle
 * on, recorded rounds, read a green tick saying they were safe, wiped their
 * phone, and lost the lot. A round is played once; the footage cannot be
 * re-shot.
 *
 * The cause was not a missing reader — it was a reader written for one path
 * while the label was written for two. So the answer to "should this clip be
 * mirrored?" lives here, dependency-free, and both capture paths get it from
 * the same call:
 *
 *   - hooks/useCamera.ts       (record) → lib/photosMirror.mirrorRecordedClip
 *   - app/round/import.tsx     (import) → lib/photosMirror.mirrorClipToPhotos
 *
 * Any THIRD capture path (share extension, watch companion, re-record) calls
 * the same helper and nothing else. Re-implementing this decision at a call
 * site is what caused the data loss; tests/photosMirror.test.ts fails if a
 * call site starts talking to MediaLibrary on its own again.
 *
 * Deliberately pure and import-free so the node test runner can execute it —
 * the rest of the pipeline (MediaLibrary, SQLite) cannot be reached from Node,
 * so this is the part of the agreement that can be proven rather than grepped.
 *
 * Permission is NOT decided here: it is an async fact about the device, not a
 * policy, and it is handled once in lib/photosMirror.ts so neither call site
 * can get it wrong on its own.
 */

export type MirrorPlan =
  /** Already in Photos — keep the id we have, don't write a second copy. */
  | { action: 'reuse'; assetId: string }
  /** Copy the file into Photos and record the resulting asset id. */
  | { action: 'mirror' }
  /** Nothing to do, and why. */
  | {
      action: 'skip';
      reason: 'setting-off' | 'unsupported-platform' | 'no-file';
    };

export interface MirrorPlanInput {
  /** The "Save raw clips to Photos" setting (lib/storage.getMirrorClipsToPhotos). */
  mirrorEnabled: boolean;
  /**
   * An asset id the clip already has. Set when the user picked the video out
   * of Photos — it is already in the library, so mirroring would only
   * duplicate their storage for the same recovery guarantee.
   */
  existingAssetId?: string | null;
  /** The file we would copy. */
  fileUri?: string | null;
  /** iOS/Android. Photos does not exist on web. */
  native: boolean;
  /** expo-media-library resolved (it is require()d lazily on native only). */
  mediaLibraryAvailable: boolean;
}

export function resolveMirrorPlan(input: MirrorPlanInput): MirrorPlan {
  const existing = input.existingAssetId?.trim();

  // Checked BEFORE the toggle on purpose. A clip picked from Photos is in
  // Photos whether or not the user asked us to mirror anything, and its id is
  // free recovery — dropping it because a setting is off would throw away a
  // restore path we already have. This is why the import path keeps
  // `clip.assetId` regardless of the toggle.
  if (existing) return { action: 'reuse', assetId: existing };

  if (!input.mirrorEnabled) return { action: 'skip', reason: 'setting-off' };
  if (!input.native || !input.mediaLibraryAvailable) {
    return { action: 'skip', reason: 'unsupported-platform' };
  }
  if (!input.fileUri?.trim()) return { action: 'skip', reason: 'no-file' };

  return { action: 'mirror' };
}

/**
 * What app/profile/storage-settings.tsx is allowed to claim about raw clips.
 *
 * The line this replaces read "Raw clips — mirrored to Photos, will re-import
 * on reinstall" and was keyed on the toggle alone. Wiring up the record path
 * makes that sentence true for clips captured from now on; it is still false
 * for every clip already on the device, which for a returning user is their
 * whole history. Someone reads this line and then wipes their phone, so it
 * states what is on disk, not what a switch is set to — and it never claims a
 * copy exists on the strength of a setting.
 *
 * Pure so the wording can be tested; `stats` null means the count could not be
 * read, and the copy falls back to describing the setting without asserting
 * anything about existing footage.
 */
export function describeRawClipStatus(input: {
  mirrorOn: boolean;
  permission: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  stats: { total: number; mirrored: number } | null;
}): { ok: boolean; text: string } {
  const willMirror = input.mirrorOn && input.permission === 'granted';
  const stats = input.stats;

  if (!stats || stats.total === 0) {
    if (willMirror) {
      return {
        ok: true,
        text: 'Raw clips — clips you record or import from now on are copied to your camera roll and re-import on reinstall.',
      };
    }
    if (input.mirrorOn) {
      return {
        ok: false,
        text: 'Raw clips — mirroring is on but Clippar cannot reach Photos, so nothing is being copied.',
      };
    }
    return {
      ok: false,
      text: 'Raw clips — not copied to Photos. Nothing to restore from after a reinstall unless cloud backup is on.',
    };
  }

  const mirrored = Math.max(0, Math.min(stats.mirrored, stats.total));
  const missing = stats.total - mirrored;

  if (missing === 0) {
    return {
      ok: true,
      text: `Raw clips — your camera roll has a copy of all ${stats.total} on this phone. They re-import on reinstall.`,
    };
  }

  // The honest half-sentence: a partial mirror is NOT a tick. Anything short
  // of every clip means a reinstall loses footage, so it reads as a warning.
  const tail = willMirror ? ' Clips captured from now on will be copied.' : '';
  if (mirrored === 0) {
    return {
      ok: false,
      text: `Raw clips — your camera roll has none of the ${stats.total} on this phone, so Photos cannot restore them.${tail}`,
    };
  }
  return {
    ok: false,
    text: `Raw clips — your camera roll has ${mirrored} of the ${stats.total} on this phone. Photos cannot restore the other ${missing}.${tail}`,
  };
}

/**
 * The asset id a clip row should carry, given a plan and the outcome of the
 * copy. `null` means the row genuinely has no Photos copy — and because
 * lib/photosRecovery.ts selects on `photos_asset_id IS NOT NULL AND != ''`,
 * null is the honest way of saying "this clip will not survive a reinstall".
 * Never substitute a placeholder here to make a row look recoverable.
 */
export function resolvePersistedAssetId(
  plan: MirrorPlan,
  createdAssetId: string | null | undefined
): string | null {
  if (plan.action === 'reuse') return plan.assetId;
  if (plan.action === 'mirror') return createdAssetId?.trim() || null;
  return null;
}
