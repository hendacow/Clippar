/**
 * Web stubs for R2 — upload functionality is native-only.
 */

export async function getUploadUrl(
  _roundId: string,
  _filename: string
): Promise<{ uploadUrl: string; key: string }> {
  throw new Error('R2 uploads are not available on web');
}

export async function uploadFileToR2(
  _presignedUrl: string,
  _fileUri: string,
  onProgress?: (progress: number) => void
): Promise<void> {
  onProgress?.(1);
}

export async function getReelUrl(_roundId: string): Promise<string | null> {
  return null;
}
