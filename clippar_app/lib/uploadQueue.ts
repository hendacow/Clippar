/**
 * Persistent background upload queue.
 *
 * Goal: every clip a user records or imports lands in Supabase Storage so the
 * round survives reinstall, device swap, and cross-device sign-in. The queue
 * is persisted in SQLite (`local_upload_queue` + `local_clips.upload_error`)
 * so progress survives app kill.
 *
 * Triggers:
 *   - `enqueueRoundUpload` — called from import.tsx after handleImport and
 *     from useCamera.ts after a clip is saved. Adds the round to the queue
 *     and kicks off a processing pass.
 *   - NetInfo restore — when the device comes back online, we process any
 *     queued rounds automatically.
 *   - App startup — `initializeUploadQueueProcessor` drains the queue once
 *     and wires the NetInfo listener.
 */
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { uploadClipToStorage } from '@/lib/r2';
import { createShot } from '@/lib/api';
import {
  enqueueRoundForUpload,
  getQueuedRoundUploads,
  markQueuedRoundStatus,
  removeQueuedRoundUpload,
  getUnuploadedClips,
  markClipUploaded,
  markClipUploadError,
  clearClipUploadError,
  incrementClipRetryCount,
} from '@/lib/storage';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Single-flight guard — multiple triggers shouldn't spin up concurrent passes
// through the queue (that would duplicate uploads and trash retry counters).
let inFlight: Promise<void> | null = null;

let netInfoSubscribed = false;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return 'Unknown error'; }
}

/**
 * Register a round for background upload. Safe to call multiple times (the
 * queue is idempotent via ON CONFLICT). Kicks off a processing pass
 * immediately — callers don't need to await.
 */
export async function enqueueRoundUpload(
  roundId: string,
  courseName: string | null,
  mode: 'local-only' | 'highlight-reel' = 'local-only'
): Promise<void> {
  if (!roundId) return;
  try {
    await enqueueRoundForUpload(roundId, courseName, mode);
  } catch (err) {
    console.warn('[uploadQueue] enqueueRoundForUpload failed:', err);
    return;
  }
  // Don't await — run in background
  void processUploadQueue();
}

/**
 * Drain the queue: iterate pending rounds, upload each unuploaded clip.
 * Records per-clip errors in SQLite (`upload_error` column) so the user can
 * see what failed and retry.
 */
export async function processUploadQueue(): Promise<void> {
  if (!isNative) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // Connectivity gate — avoid burning retries when offline.
      const online = await isConnected();
      if (!online) {
        console.log('[uploadQueue] offline, deferring queue processing');
        return;
      }

      const queued = await getQueuedRoundUploads();
      if (queued.length === 0) return;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.log('[uploadQueue] no authed user, skipping (will retry on next trigger)');
        return;
      }

      for (const item of queued) {
        try {
          await markQueuedRoundStatus(item.round_id, 'in_progress');
          await uploadRoundClips(item.round_id, user.id);
          await markQueuedRoundStatus(item.round_id, 'done');
          // Keep the row briefly so /verifyRoundReachable can see the state;
          // a future startup will clear 'done' rows.
          await removeQueuedRoundUpload(item.round_id);
        } catch (err) {
          const msg = toErrorMessage(err);
          console.warn(`[uploadQueue] round ${item.round_id} failed:`, msg);
          try {
            await markQueuedRoundStatus(item.round_id, 'error', msg);
          } catch {}
          // Don't abort other queued rounds — move on.
        }
      }
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Upload all unuploaded clips for a single round. Updates the corresponding
 * `shots` rows with the storage path so the editor can render the round from
 * Supabase after a reinstall.
 */
async function uploadRoundClips(roundId: string, userId: string): Promise<void> {
  const clips = await getUnuploadedClips(roundId);
  if (clips.length === 0) return;

  // Guard: do NOT push shots for a round that doesn't exist in Supabase.
  // Historically `useRound` would fall back to a `local_${Date.now()}` ID
  // when createRound failed, and the queue would then try to createShot()
  // against that ID — producing `shots_round_id_fkey` violations and the
  // "no video on every round" bug. The fallback is now removed, but older
  // rounds recorded under the fallback may still be lurking in SQLite.
  if (roundId.startsWith('local_')) {
    throw new Error(
      `Round ${roundId} is local-only (never reached Supabase); skipping upload. ` +
      `Delete the round or re-record with a live connection.`
    );
  }

  const { data: roundRow, error: roundErr } = await supabase
    .from('rounds')
    .select('id')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) {
    throw new Error(`Round lookup failed: ${toErrorMessage(roundErr)}`);
  }
  if (!roundRow?.id) {
    throw new Error(
      `Round ${roundId} not found in Supabase — cannot upload clips (would violate shots.round_id FK).`
    );
  }

  for (const clip of clips) {
    // Basic per-clip retry throttle — cap attempts so a single bad file
    // doesn't spin forever.
    if ((clip as any).upload_retry_count >= 6) {
      console.warn(`[uploadQueue] giving up on clip ${clip.id} after 6 attempts`);
      continue;
    }

    const filename = `hole${clip.hole_number}_shot${clip.shot_number}_${clip.id}.mp4`;
    const storagePath = `${roundId}/${filename}`;

    try {
      // Skip compression — clips from auto-trim/record are already sized for mobile.
      await uploadClipToStorage(roundId, filename, clip.file_uri, undefined, true);
      await markClipUploaded(clip.id, filename);
      await clearClipUploadError(clip.id);

      // Update the existing shot row (import pre-creates with empty clip_url),
      // else insert a new one.
      try {
        const { data: existing } = await supabase
          .from('shots')
          .select('id')
          .eq('round_id', roundId)
          .eq('hole_number', clip.hole_number)
          .eq('shot_number', clip.shot_number)
          .limit(1)
          .maybeSingle();

        if (existing?.id) {
          await supabase
            .from('shots')
            .update({
              clip_url: storagePath,
              gps_latitude: clip.gps_latitude ?? null,
              gps_longitude: clip.gps_longitude ?? null,
            })
            .eq('id', existing.id);
        } else {
          await createShot({
            round_id: roundId,
            user_id: userId,
            hole_number: clip.hole_number,
            shot_number: clip.shot_number,
            clip_url: storagePath,
            gps_latitude: clip.gps_latitude ?? undefined,
            gps_longitude: clip.gps_longitude ?? undefined,
          });
        }
      } catch (err) {
        // The clip IS in storage; failing to upsert `shots` is recoverable —
        // log but don't re-throw (we don't want to delete the uploaded blob).
        console.warn(`[uploadQueue] shots upsert failed for clip ${clip.id}:`, err);
      }
    } catch (err) {
      const msg = toErrorMessage(err);
      try { await incrementClipRetryCount(clip.id); } catch {}
      try { await markClipUploadError(clip.id, msg); } catch {}
      throw err; // Let caller mark the round status as 'error'
    }
  }
}

/**
 * Retry a specific round's failed uploads. Clears `upload_error` on each clip
 * first so the UI updates immediately. Safe to call from a "Retry upload"
 * button.
 */
export async function retryRoundUpload(
  roundId: string,
  courseName: string | null
): Promise<void> {
  await enqueueRoundUpload(roundId, courseName);
}

/**
 * Register a single freshly-recorded clip for upload. The hook-level call
 * from useCamera only knows which round it belongs to — the queue takes
 * care of enumerating and uploading via getUnuploadedClips.
 */
export async function enqueueClipUpload(roundId: string, courseName?: string | null) {
  return enqueueRoundUpload(roundId, courseName ?? null, 'local-only');
}

/**
 * App startup hook — drain queue once and subscribe to NetInfo so we retry
 * when connectivity returns. Idempotent.
 */
export function initializeUploadQueueProcessor(): void {
  if (!isNative) return;

  // Drain on startup
  void processUploadQueue();

  if (netInfoSubscribed) return;
  netInfoSubscribed = true;

  let NetInfo: any = null;
  try {
    NetInfo = require('@react-native-community/netinfo').default;
  } catch {
    console.log('[uploadQueue] NetInfo unavailable, skipping online-restore listener');
    return;
  }

  try {
    NetInfo.addEventListener((state: any) => {
      if (state?.isConnected) {
        void processUploadQueue();
      }
    });
  } catch (err) {
    console.warn('[uploadQueue] NetInfo.addEventListener failed:', err);
  }
}

async function isConnected(): Promise<boolean> {
  let NetInfo: any = null;
  try {
    NetInfo = require('@react-native-community/netinfo').default;
  } catch {
    // Without NetInfo we can't tell — assume online and let the upload itself fail loudly.
    return true;
  }
  try {
    const state = await NetInfo.fetch();
    return state?.isConnected !== false;
  } catch {
    return true;
  }
}
