import { useEffect, useState, useRef, useCallback } from 'react';
import { getProcessingJob } from '@/lib/api';

interface ProcessingStatus {
  status: string;
  progressPercent: number;
  errorMessage: string | null;
  clipsDetected: number | null;
}

export function useProcessingStatus(roundId: string | null) {
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (!roundId) return;

    try {
      const job = await getProcessingJob(roundId);
      if (job) {
        setProcessingStatus({
          status: job.status,
          progressPercent: job.progress_percent,
          errorMessage: job.error_message,
          clipsDetected: job.clips_detected,
        });

        // Stop polling if completed or failed
        if (job.status === 'completed' || job.status === 'failed') {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        }
      }
    } catch {
      // Silently fail — will retry on next poll
    }
  }, [roundId]);

  const startPolling = useCallback(() => {
    if (!roundId) return;
    setLoading(true);
    poll().then(() => setLoading(false));

    // Poll every 5 seconds
    intervalRef.current = setInterval(poll, 5000);
  }, [roundId, poll]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return { processingStatus, loading, startPolling, stopPolling };
}
