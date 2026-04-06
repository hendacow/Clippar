/**
 * Web stubs for pipeline — processing is native-only.
 */

export async function submitJob(_params: {
  roundId: string;
  clipCount: number;
  userName?: string;
  userEmail?: string;
}): Promise<string> {
  throw new Error('Pipeline submission is not available on web');
}

export async function getJobStatus(_jobId: string): Promise<{
  status: string;
  clipCount?: number;
  reelUrl?: string;
  error?: string;
}> {
  throw new Error('Pipeline status is not available on web');
}
