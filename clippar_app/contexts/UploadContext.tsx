import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { Platform } from 'react-native';
import type { ReactNode } from 'react';

let NetInfo: any = null;
try {
  NetInfo = require('@react-native-community/netinfo').default;
} catch {}

import { getUnuploadedClips, markClipUploaded, incrementClipRetryCount } from '@/lib/storage';
import { uploadClipToStorage } from '@/lib/r2';
import { createShot, updateRound } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { config } from '@/constants/config';

type UploadStage =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'submitting'
  | 'processing'
  | 'completed'
  | 'error';

export interface UploadState {
  stage: UploadStage;
  roundId: string | null;
  courseName: string | null;
  currentClip: number;
  totalClips: number;
  progress: number; // 0-100
  stageLabel: string;
  error: string | null;
  reelUrl: string | null;
}

interface UploadContextType {
  upload: UploadState;
  startUpload: (roundId: string, courseName: string) => void;
  cancelUpload: () => void;
  retryUpload: () => void;
  dismissUpload: () => void;
}

const INITIAL_STATE: UploadState = {
  stage: 'idle',
  roundId: null,
  courseName: null,
  currentClip: 0,
  totalClips: 0,
  progress: 0,
  stageLabel: '',
  error: null,
  reelUrl: null,
};

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const MAX_RETRIES = config.upload.maxRetries;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return 'Unknown error'; }
}

const UploadContext = createContext<UploadContextType>({
  upload: INITIAL_STATE,
  startUpload: () => {},
  cancelUpload: () => {},
  retryUpload: () => {},
  dismissUpload: () => {},
});

export function useUploadContext() {
  return useContext(UploadContext);
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UploadState>(INITIAL_STATE);
  const cancelledRef = useRef(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastRoundIdRef = useRef<string | null>(null);
  const lastCourseNameRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const update = useCallback((partial: Partial<UploadState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  // Map pipeline statuses to user-friendly labels and progress ranges
  const PIPELINE_STAGES: Record<string, { label: string; progress: number }> = {
    pending: { label: 'Queued for processing...', progress: 42 },
    downloading: { label: 'Server downloading clips...', progress: 45 },
    detecting: { label: 'Analysing clips for golf shots...', progress: 52 },
    processing: { label: 'Running shot detection...', progress: 55 },
    merging: { label: 'Stitching shots together...', progress: 62 },
    post_processing: { label: 'Adding scorecard & music...', progress: 72 },
    transcoding: { label: 'Transcoding to mobile format...', progress: 80 },
    uploading_reel: { label: 'Uploading your highlight reel...', progress: 88 },
    ready_for_review: { label: 'Highlight reel ready!', progress: 98 },
  };

  const startPolling = useCallback((roundId: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    let pollCount = 0;
    const MAX_POLLS = 60; // ~10 minutes at 10s intervals

    pollingRef.current = setInterval(async () => {
      if (cancelledRef.current) {
        if (pollingRef.current) clearInterval(pollingRef.current);
        return;
      }

      pollCount++;

      try {
        // First, poll the pipeline's job-status endpoint for granular progress
        if (config.pipeline.url) {
          try {
            const resp = await fetch(`${config.pipeline.url}/api/mobile/job-status/${roundId}`, {
              headers: { Authorization: `Bearer ${config.pipeline.apiKey}` },
            });
            if (resp.ok) {
              const data = await resp.json();
              if (data.ok) {
                const pipelineStatus = data.status as string;
                const serverProgress = data.progress as number | undefined;
                const stageDetail = data.stage_detail as string | undefined;

                // Check for failure
                if (pipelineStatus === 'processing_failed' || pipelineStatus === 'download_failed') {
                  if (pollingRef.current) clearInterval(pollingRef.current);
                  update({
                    stage: 'error',
                    stageLabel: 'Processing failed',
                    error: data.error_message ?? 'Processing failed on server.',
                  });
                  return;
                }

                // Check for completion — pipeline sets ready_for_review, then worker updates Supabase
                if (pipelineStatus === 'ready_for_review' || pipelineStatus === 'delivered' || pipelineStatus === 'approved') {
                  // Don't mark complete yet — wait for reel_url in Supabase
                  // But show near-complete progress
                  update({
                    stage: 'processing',
                    progress: 95,
                    stageLabel: 'Finalising your highlight reel...',
                  });
                  // Fall through to Supabase check below
                } else {
                  // Active pipeline stage — use server progress if available, else mapped progress
                  const mapped = PIPELINE_STAGES[pipelineStatus];
                  const displayProgress = serverProgress != null && serverProgress > 0
                    ? Math.min(serverProgress, 92) // Cap at 92 — never near 100 until truly done
                    : mapped?.progress ?? 50;
                  const displayLabel = stageDetail || mapped?.label || `Processing (${pipelineStatus})...`;

                  update({
                    stage: 'processing',
                    progress: Math.max(displayProgress, 42), // Never go below upload-complete baseline
                    stageLabel: displayLabel,
                  });
                }
              }
            }
          } catch {
            // Pipeline unreachable — fall back to Supabase polling below
          }
        }

        // Check Supabase rounds table for final completion (reel_url)
        const { data: round } = await supabase
          .from('rounds')
          .select('status, reel_url')
          .eq('id', roundId)
          .single();

        if (round?.reel_url) {
          if (pollingRef.current) clearInterval(pollingRef.current);
          update({
            stage: 'completed',
            progress: 100,
            stageLabel: 'Highlight reel ready!',
            reelUrl: round.reel_url,
          });
          return;
        }

        if (round?.status === 'ready' && !round?.reel_url) {
          // Ready but no URL yet — keep polling briefly
          update({
            stage: 'processing',
            progress: 96,
            stageLabel: 'Almost there...',
          });
        }

        if (round?.status === 'failed') {
          if (pollingRef.current) clearInterval(pollingRef.current);
          update({ stage: 'error', stageLabel: 'Processing failed', error: 'Processing failed on server.' });
          return;
        }
      } catch {}

      // Timeout after MAX_POLLS
      if (pollCount >= MAX_POLLS) {
        if (pollingRef.current) clearInterval(pollingRef.current);
        update({
          stage: 'completed',
          progress: 100,
          stageLabel: 'Clips uploaded — check back soon',
          reelUrl: null,
        });
      }
    }, 10_000); // Poll every 10s for more responsive updates
  }, [update]);

  const runUpload = useCallback(async (roundId: string, courseName: string) => {
    cancelledRef.current = false;
    lastRoundIdRef.current = roundId;
    lastCourseNameRef.current = courseName;

    update({
      stage: 'preparing',
      roundId,
      courseName,
      currentClip: 0,
      totalClips: 0,
      progress: 0,
      stageLabel: 'Checking connection...',
      error: null,
      reelUrl: null,
    });

    try {
      // Check connectivity
      if (isNative && NetInfo) {
        try {
          const netState = await NetInfo.fetch();
          if (!netState.isConnected) {
            update({ stage: 'error', stageLabel: 'No connection', error: 'No internet connection. Please connect and try again.' });
            return;
          }
        } catch {}
      }

      // Get clips
      let clips: Awaited<ReturnType<typeof getUnuploadedClips>> = [];
      try {
        clips = await getUnuploadedClips(roundId);
      } catch {}

      if (clips.length === 0) {
        update({ stage: 'submitting', totalClips: 0, progress: 39, stageLabel: 'Submitting for processing...' });
      } else {
        update({
          stage: 'uploading',
          totalClips: clips.length,
          currentClip: 0,
          progress: 0,
          stageLabel: `Uploading clip 1 of ${clips.length}`,
        });
      }

      // Get user
      const { data: { user } } = await supabase.auth.getUser();

      // Upload each clip
      for (let i = 0; i < clips.length; i++) {
        if (cancelledRef.current) return;

        const clip = clips[i];
        let retries = 0;
        let uploaded = false;

        while (retries < MAX_RETRIES && !uploaded && !cancelledRef.current) {
          try {
            update({
              currentClip: i + 1,
              stageLabel: `Uploading clip ${i + 1} of ${clips.length}`,
            });

            const filename = `hole${clip.hole_number}_shot${clip.shot_number}_${clip.id}.mp4`;

            await uploadClipToStorage(roundId, filename, clip.file_uri, (clipProgress) => {
              const overall = ((i + clipProgress) / clips.length) * 38; // 0-38% for uploads
              update({ progress: Math.round(overall) });
            });

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
              } catch {}
            }

            uploaded = true;
          } catch (err) {
            retries++;
            try { await incrementClipRetryCount(clip.id); } catch {}
            if (retries >= MAX_RETRIES) {
              update({
                stage: 'error',
                stageLabel: 'Upload failed',
                error: `Failed to upload clip ${i + 1}: ${toErrorMessage(err)}`,
              });
              return;
            }
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, retries)));
          }
        }
      }

      if (cancelledRef.current) return;

      // Submit processing job
      update({ stage: 'submitting', progress: 39, stageLabel: 'Submitting for processing...' });

      try {
        await supabase.from('processing_jobs').insert({
          round_id: roundId,
          status: 'queued',
        });
      } catch {}

      try {
        await updateRound(roundId, {
          status: 'processing',
          clips_count: clips.length,
        } as any);
      } catch {}

      // Submit for processing: try CV pipeline, then concat service, then just mark uploaded
      let processingSubmitted = false;

      // Try CV pipeline (shot detection + scorecard + music)
      if (!processingSubmitted && config.pipeline.url && clips.length > 0) {
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
          processingSubmitted = response.ok;
        } catch {}
      }

      // Fallback: try concat service (simple stitching, no CV)
      if (!processingSubmitted && config.concat.url && clips.length > 0) {
        try {
          const response = await fetch(`${config.concat.url}/api/concat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roundId,
              clips: clips.map((c) => ({
                storagePath: `${roundId}/hole${c.hole_number}_shot${c.shot_number}_${c.id}.mp4`,
                trimStartMs: 0,
                trimEndMs: -1,
              })),
            }),
          });
          processingSubmitted = response.ok;
        } catch {}
      }

      if (processingSubmitted) {
        update({ stage: 'processing', progress: 42, stageLabel: 'Queued for processing...' });
        startPolling(roundId);
      } else {
        // Clips uploaded — user can edit the reel in the editor
        try {
          await supabase.from('processing_jobs')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('round_id', roundId)
            .eq('status', 'queued');
        } catch {}
        try {
          await updateRound(roundId, { status: 'ready' } as any);
        } catch {}
        update({
          stage: 'completed',
          progress: 100,
          stageLabel: clips.length > 0 ? 'Clips uploaded — edit your reel' : 'Round saved',
          reelUrl: null,
        });
      }
    } catch (err) {
      update({ stage: 'error', stageLabel: 'Upload failed', error: toErrorMessage(err) });
    }
  }, [update, startPolling]);

  const startUpload = useCallback((roundId: string, courseName: string) => {
    runUpload(roundId, courseName);
  }, [runUpload]);

  const cancelUpload = useCallback(() => {
    cancelledRef.current = true;
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setState(INITIAL_STATE);
  }, []);

  const retryUpload = useCallback(() => {
    if (lastRoundIdRef.current && lastCourseNameRef.current) {
      runUpload(lastRoundIdRef.current, lastCourseNameRef.current);
    }
  }, [runUpload]);

  const dismissUpload = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setState(INITIAL_STATE);
  }, []);

  return (
    <UploadContext.Provider value={{ upload: state, startUpload, cancelUpload, retryUpload, dismissUpload }}>
      {children}
    </UploadContext.Provider>
  );
}
