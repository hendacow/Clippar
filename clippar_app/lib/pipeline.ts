import { config } from '@/constants/config';

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.pipeline.apiKey}`,
});

/**
 * Submit a processing job to the pipeline.
 * Uses the Supabase round ID as the pipeline job ID for cross-referencing.
 */
export async function submitJob(params: {
  roundId: string;
  clipCount: number;
  userName?: string;
  userEmail?: string;
}): Promise<string> {
  const response = await fetch(`${config.pipeline.url}/api/mobile/submit-job`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      round_id: params.roundId,
      clip_count: params.clipCount,
      user_name: params.userName ?? 'App User',
      user_email: params.userEmail ?? '',
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to submit job: ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Failed to submit job');
  return data.job_id;
}

/**
 * Get the processing status of a job.
 */
export async function getJobStatus(jobId: string): Promise<{
  status: string;
  clipCount?: number;
  reelUrl?: string;
  error?: string;
}> {
  const response = await fetch(
    `${config.pipeline.url}/api/mobile/job-status/${jobId}`,
    { headers: headers() }
  );

  if (!response.ok) {
    throw new Error(`Failed to get job status: ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Failed to get status');

  return {
    status: data.status,
    clipCount: data.clip_count,
    reelUrl: data.reel_url,
    error: data.error_message,
  };
}
