import { Platform } from 'react-native';
import { clearLocalDatabase, listLocalRoundIdsForCurrentUser, deleteLocalRound, setSetting, currentSessionUserId } from './storage';
import { clearRoundPrefetch } from './roundPrefetch';

/**
 * Local, app-owned secure-store keys that survive a Supabase sign-out (sign-out
 * only clears the auth-session keys). On account deletion we clear these too so
 * nothing from the deleted user lingers on the device.
 *   • clippar_biometric_enabled — lib/biometrics.ts
 *   • ble_device_id             — hooks/useBLE.ts (last paired clicker)
 */
const SECURE_STORE_KEYS = ['clippar_biometric_enabled', 'ble_device_id'];

/**
 * local_settings keys that hold ANSWERS ABOUT A PERSON rather than app state:
 * the onboarding funnel's home course (free text), handicap and age range, what
 * they want out of the app and their most memorable shot. They are written
 * unscoped (lib/onboardingProfile.ts, lib/salesFlow.ts) and read straight back,
 * so without this the next account to sign in on the handset is greeted with
 * the previous golfer's home course and handicap already filled in.
 *
 * Deliberately NOT the "seen/done" flags (onboarding.sales_done,
 * onboarding.v2.completed_at, mount-card dismissals): those gate flow, not
 * identity, and clearing them would replay the tour at every sign-out. The Pro
 * entitlement cache needs nothing here — lib/subscription.ts already keys it by
 * user id.
 */
const ACCOUNT_LINKED_SETTING_KEYS = [
  'onboarding.v2.intent',
  'onboarding.v2.memorable_shot',
  'onboarding.v2.home_course',
  'onboarding.v2.handicap',
  'onboarding.v2.age_range',
  'onboarding.v2.vibe',
  'onboarding.sales_handicap',
  'onboarding.sales_goal',
];

/**
 * Directories we own outright, both under documentDirectory:
 *   clips/   — every raw and trimmed swing video (lib/media.ts)
 *   exports/ — durable copies made for share sheets (lib/clipShare.ts)
 * Removed recursively as a backstop to the per-row unlink in
 * clearLocalDatabase: a clip whose row was lost to a failed migration, or a
 * partial file left by a crash mid-export, has no DB row pointing at it and
 * would otherwise survive an "erased forever" account deletion untouched.
 */
const OWNED_MEDIA_DIRS = ['clips/', 'exports/'];

async function removeOwnedMediaDirectories(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const root = FS.documentDirectory;
    if (!root) return;
    for (const dir of OWNED_MEDIA_DIRS) {
      try {
        await FS.deleteAsync(`${root}${dir}`, { idempotent: true });
      } catch {
        // A locked or already-absent directory must not abort the wipe.
      }
    }
  } catch {
    // expo-file-system unavailable — the per-row unlink already ran.
  }
}

/**
 * Delete every temporary export in Library/Caches, ignoring the usual 24h age
 * grace. Those files (trim_/stitch_/tracer_/clippar_reel_) are full-fidelity
 * copies of the golfer's footage that no SQLite row references, so nothing else
 * in a wipe reaches them. `inUseUris: []` is correct ONLY here, where the rows
 * that could be "in use" have just been deleted.
 */
async function removeTemporaryExports(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const shotDetector =
      require('../modules/shot-detector') as typeof import('../modules/shot-detector');
    await shotDetector.reclaimTemporaryExports({ inUseUris: [], maxAgeMs: 0 });
  } catch {
    // Native module unavailable (web/dev) — nothing to sweep.
  }
}

/**
 * Wipe all local state tied to the signed-in user: the SQLite database
 * (rounds/clips/scores/queue/settings), every video file those rows pointed at,
 * the directories they lived in, cached temporary exports, and the app's
 * secure-store keys.
 *
 * Call this AFTER the server-side delete succeeds and BEFORE signing out, so
 * the next session — same device, possibly a different user — starts clean.
 * The order matters twice over: the file sweeps need the session to resolve the
 * user's rows, and clearLocalDatabase must harvest clip URIs before it drops
 * the rows that hold them.
 *
 * Best-effort and never throws: a wipe failure must not block the sign-out and
 * redirect that follow it.
 */
export async function wipeLocalUserData(): Promise<void> {
  // FIRST, and for the same reason as in removeLocalMediaForCurrentUser: a
  // binned clip has no local_clips row, so nothing below reaches its video
  // files by walking rounds. It must also precede clearLocalDatabase, which
  // deletes this account's bin key — once that metadata is gone, the only
  // record naming those files is gone with it.
  //
  // This used to be left to the directory sweep further down. That worked, and
  // it was the wrong thing to rely on: whoever changes that sweep would have
  // silently stopped reclaiming a deleted account's binned videos, with no test
  // going red — a security fix quietly reintroducing a data-remanence bug. Now
  // this holds by construction.
  //
  // Why that sweep must change is deliberately not spelled out here: this file
  // is public and the finding is unfixed and live in shipped code. Read finding
  // 12 in `org/cto/SECURITY-2026-08-30-unfixed.md` (private company-brain repo)
  // before touching it.
  //
  // Runs before signOut (see above), so the session still resolves and the
  // purge finds the departing account's bin rather than none.
  try {
    const { purgeAllBinnedClips } =
      require('./clipBin') as typeof import('./clipBin');
    await purgeAllBinnedClips();
  } catch (err) {
    console.warn('[localWipe] purgeAllBinnedClips failed', err);
  }

  // Two device-wide local_settings registries this branch made
  // account-attributable. clearLocalDatabase's scoped-delete list was extended
  // in the same branch and these two were missed, so account deletion left the
  // departing user's id, every practice round id with its start timestamp, and
  // every tutorial round id in plaintext on the handset — permanently, since
  // both are only ever pruned for the account that is signed in.
  //
  // Scrubbed through the owning modules rather than by key here: they are
  // shared rows, so a blanket delete would destroy the other account's
  // entries, and the filter belongs where the entry shape is defined.
  //
  // Before signOut (see above), so the session still resolves to the departing
  // account. No session means nothing to attribute, so nothing is removed.
  try {
    const me = await currentSessionUserId();
    if (me) {
      const training = require('./training') as typeof import('./training');
      const tutorial = require('./tutorialRound') as typeof import('./tutorialRound');
      await training.forgetTrainingSessionsFor(me);
      await tutorial.forgetCreatedRoundsFor(me);
    }
  } catch (err) {
    console.warn('[localWipe] registry scrub failed', err);
  }

  try {
    await clearLocalDatabase();
  } catch (err) {
    console.warn('[localWipe] clearLocalDatabase failed', err);
  }

  await removeOwnedMediaDirectories();
  await removeTemporaryExports();

  // In-memory round-detail prefetch cache: carries the departing user's round
  // payloads (GPS + clip URLs) until taken, swept, or the app backgrounds.
  // Entries are also owner-stamped (a take by another account misses), but
  // drop the memory itself here rather than rely on that gate alone.
  clearRoundPrefetch();

  if (Platform.OS === 'web') return;

  try {
    const SecureStore = require('expo-secure-store');
    for (const key of SECURE_STORE_KEYS) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Key absent or keychain unavailable — nothing to clean up.
      }
    }
  } catch {
    // expo-secure-store not present (web/dev) — nothing to do.
  }
}

/**
 * Forget the personal answers this account gave, without touching a single
 * video. Called on EVERY sign-out (app/(tabs)/profile.tsx) — spec 5.5 requires
 * account-linked caches to be cleared when a session ends, and unlike media
 * these cost the user nothing to re-enter.
 *
 * Must run BEFORE supabase.auth.signOut(): once the session is gone the
 * storage layer can no longer resolve whose data this is.
 */
export async function clearAccountLinkedCaches(): Promise<void> {
  // The round-detail prefetch cache is account-linked residue too — it holds
  // the signed-in user's round payloads (GPS + clip URLs) in memory until
  // taken, swept, or the app backgrounds. Entries are owner-stamped so a take
  // by the next account misses, and hooks/useAuth.ts scrubs on SIGNED_OUT for
  // sessions that end without this button — but sign-out drops the memory here
  // too. Synchronous in-memory clear; nothing to await.
  clearRoundPrefetch();

  for (const key of ACCOUNT_LINKED_SETTING_KEYS) {
    try {
      await setSetting(key, null);
    } catch {
      // Missing table / closed db — never block a sign-out on a cache clear.
    }
  }
}

/**
 * The user's explicit "remove my videos from this phone" choice.
 *
 * This exists so sign-out never has to guess. Local video is NOT a cache here:
 * for a golfer who has not turned on cloud backup, the files under
 * documentDirectory/clips/ are the only copy of a round that cannot be
 * re-recorded, which is exactly why sign-out must not wipe them on its own.
 * Deleting them has to be a deliberate act, and this is it.
 *
 * Scoped to the signed-in user's own rounds (listLocalRoundIdsForCurrentUser)
 * and routed through deleteLocalRound so each round's clips, scores, queue row
 * and the four video files per clip go together. Returns the number of rounds
 * removed so the caller can tell the user what happened. Never throws.
 */
export async function removeLocalMediaForCurrentUser(): Promise<number> {
  let removed = 0;
  // Before the rounds, because a binned clip no longer has a local_clips row:
  // deleteLocalRound below would never reach its video files, so up to 30 of
  // them would survive the one action whose whole purpose is removing them.
  // Lazy require for the same import-cycle reason as the shot-detector calls.
  try {
    const { purgeAllBinnedClips } =
      require('./clipBin') as typeof import('./clipBin');
    await purgeAllBinnedClips();
  } catch (err) {
    console.warn('[localWipe] purgeAllBinnedClips failed', err);
  }
  try {
    const roundIds = await listLocalRoundIdsForCurrentUser();
    for (const id of roundIds) {
      try {
        await deleteLocalRound(id);
        removed++;
      } catch (err) {
        console.warn('[localWipe] deleteLocalRound failed for', id, err);
      }
    }
  } catch (err) {
    console.warn('[localWipe] removeLocalMediaForCurrentUser failed', err);
  }
  // Temp exports are per-device, not per-round: a stitched reel or shared hole
  // left in Library/Caches is the same footage the user just asked us to remove.
  await removeTemporaryExports();
  return removed;
}
