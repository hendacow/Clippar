import { useState, useCallback, useRef, useEffect } from 'react';
import { Platform } from 'react-native';
// NetInfo requires native module — not available in Expo Go or web
let NetInfo: any = null;
try {
  NetInfo = require('@react-native-community/netinfo').default;
} catch {
  // Native module not available
}
import { getUnuploadedClips, markClipUploaded, incrementClipRetryCount } from '@/lib/storage';
import { uploadClipToStorage } from '@/lib/r2';
import { createShot, updateRound } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { config } from '@/constants/config';

type UploadStatus =
  | 'idle'
  | 'checking_wifi'
  | 'uploading'
  | 'submitting'
  | 'processing'
  | 'completed'
  | 'error';

interface UploadState {
  status: UploadStatus;
  currentClip: number;
  totalClips: number;
  overallProgress: number;
  error: string | null;
  reelUrl: string | null;
}

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const MAX_RETRIES = config.upload.maxRetries;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return 'Unknown error'; }
}

export function useUpload(roundId: string) {
  const [state, setState] = useState<UploadState>({
    status: 'idle',
    currentClip: 0,
    totalClips: 0,
    overallProgress: 0,
    error: null,
    reelUrl: null,
  });

  const cancelledRef = useRef(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const update = useCallback((partial: Partial<UploadState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    pollingRef.current = setInterval(async () => {
      if (cancelledRef.current) {
        if (pollingRef.current) clearInterval(pollingRef.current);
        return;
      }

      try {
        // Poll Supabase processing_jobs table
        const { data: job } = await supabase
          .from('processing_jobs')
          .select('status, error_message')
          .eq('round_id', roundId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (!job) return;

        if (job.status === 'completed') {
          if (pollingRef.current) clearInterval(pollingRef.current);

          // Get reel URL from rounds table
          const { data: round } = await supabase
            .from('rounds')
            .select('reel_url')
            .eq('id', roundId)
            .single();

          update({ status: 'completed', reelUrl: round?.reel_url ?? null });
        } else if (job.status === 'failed') {
          if (pollingRef.current) clearInterval(pollingRef.current);
          update({ status: 'error', error: job.error_message ?? 'Processing failed.' });
        }
      } catch {
        // Polling errors are non-fatal, keep trying
      }
    }, 15_000);
  }, [roundId, update]);

  const startUpload = useCallback(async () => {
    cancelledRef.current = false;
    update({ status: 'checking_wifi', error: null });

    try {
      // 1. Check connectivity
      if (isNative && NetInfo) {
        try {
          const netState = await NetInfo.fetch();
          if (!netState.isConnected) {
            update({
              status: 'error',
              error: 'No internet connection. Please connect and try again.',
            });
            return;
          }
        } catch {
          // Skip connectivity check if NetInfo fails
        }
      }

      // 2. Get unuploaded clips from local DB
      let clips: Awaited<ReturnType<typeof getUnuploadedClips>> = [];
      try {
        clips = await getUnuploadedClips(roundId);
      } catch {
        // If SQLite fails (web), proceed with empty clips
      }

      if (clips.length === 0) {
        update({ status: 'submitting', totalClips: 0, overallProgress: 100 });
      } else {
        update({
          status: 'uploading',
          totalClips: clips.length,
          currentClip: 0,
          overallProgress: 0,
        });
      }

      // 3. Get user
      const { data: { user } } = await supabase.auth.getUser();

      // 4. Upload each clip to Supabase Storage
      for (let i = 0; i < clips.length; i++) {
        if (cancelledRef.current) return;

        const clip = clips[i];
        let retries = 0;
        let uploaded = false;

        while (retries < MAX_RETRIES && !uploaded && !cancelledRef.current) {
          try {
            update({ currentClip: i + 1 });

            const filename = `hole${clip.hole_number}_shot${clip.shot_number}_${clip.id}.mp4`;

            await uploadClipToStorage(
              roundId,
              filename,
              clip.file_uri,
              (clipProgress) => {
                const overall = ((i + clipProgress) / clips.length) * 100;
                update({ overallProgress: Math.round(overall) });
              }
            );

            await markClipUploaded(clip.id, filename);

            if (user) {
              try {
                await createShot({
                  round_id: roundId,
                  user_id: user.id,
                  hole_number: clip.hole_number,
                  shot_number: clip.shot_number,
                  clip_url: `clips/${roundId}/${filename}`,
                  gps_latitude: clip.gps_latitude ?? undefined,
                  gps_longitude: clip.gps_longitude ?? undefined,
                });
              } catch {
                // Shot record creation is non-critical
              }
            }

            uploaded = true;
          } catch (err) {
            retries++;
            try {
              await incrementClipRetryCount(clip.id);
            } catch {
              // Ignore SQLite errors
            }
            if (retries >= MAX_RETRIES) {
              update({
                status: 'error',
                error: `Failed to upload clip ${i + 1}: ${toErrorMessage(err)}`,
              });
              return;
            }
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, retries)));
          }
        }
      }

      if (cancelledRef.current) return;

      // 5. Create processing job in Supabase
      update({ status: 'submitting', overallProgress: 100 });
      try {
        await supabase.from('processing_jobs').insert({
          round_id: roundId,
          status: 'queued',
        });
      } catch {
        // Non-critical if it fails — round status is the fallback
      }

      // 6. Update round status
      try {
        await updateRound(roundId, {
          status: 'processing',
          clips_count: clips.length,
        } as any);
      } catch {
        // Non-critical
      }

      // 7. Also try submitting to Flask pipeline if available
      if (config.pipeline.url) {
        try {
          const response = await fetch(`${config.pipeline.url}/api/mobile/submit-job`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.pipeline.apiKey}`,
            },
            body: JSON.stringify({
              round_id: roundId,
              clip_count: clips.length,
              user_name: user?.user_metadata?.full_name ?? 'App User',
              user_email: user?.email ?? '',
            }),
          });
          // If pipeline is available, it'll process the clips
          if (response.ok) {
            console.log('[Upload] Pipeline job submitted successfully');
          }
        } catch {
          // Pipeline not available — clips are safely in Supabase Storage
          console.log('[Upload] Pipeline not reachable, clips saved to Supabase Storage');
        }
      }

      // 8. Poll for completion
      update({ status: 'processing' });
      startPolling();
    } catch (err) {
      update({
        status: 'error',
        error: toErrorMessage(err),
      });
    }
  }, [roundId, update, startPolling]);

  const cancelUpload = useCallback(() => {
    cancelledRef.current = true;
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    update({ status: 'idle' });
  }, [update]);

  const retry = useCallback(() => {
    startUpload();
  }, [startUpload]);

  return {
    ...state,
    startUpload,
    cancelUpload,
    retry,
  };
}
