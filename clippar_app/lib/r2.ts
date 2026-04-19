import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { config } from '@/constants/config';
import { resolveAssetUri } from '@/lib/media';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

let ExpoFS: typeof import('expo-file-system') | null = null;
if (isNative) {
  ExpoFS = require('expo-file-system') as typeof import('expo-file-system');
}

let Compressor: typeof import('react-native-compressor') | null = null;
try {
  if (isNative) {
    Compressor = require('react-native-compressor') as typeof import('react-native-compressor');
  }
} catch {}

const CHUNK_SIZE = 6 * 1024 * 1024; // 6MB — Supabase TUS minimum chunk
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024; // Use simple upload below 5MB
const MAX_FILE_SIZE = 50 * 1024 * 1024; // Supabase free plan limit
const COMPRESS_THRESHOLD = 10 * 1024 * 1024; // Compress files over 10MB

/**
 * Upload a clip to Supabase Storage.
 *
 * 1. If file >10MB and skipCompression is false, compress to 720p/medium quality first
 * 2. Files <5MB: single POST request
 * 3. Files 5-50MB: TUS resumable upload in 6MB chunks
 *
 * @param skipCompression - Set true for pre-trimmed clips to preserve original quality
 */
export async function uploadClipToStorage(
  roundId: string,
  filename: string,
  fileUri: string,
  onProgress?: (progress: number) => void,
  skipCompression?: boolean,
): Promise<string> {
  const storagePath = `${roundId}/${filename}`;

  if (!isNative || !ExpoFS) {
    onProgress?.(1);
    return storagePath;
  }

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  // Normalize ph:// / assets-library:// → file://. Without this the File()
  // check below throws "File not found: ph://..." for any clip imported from
  // Photos that was never normalized at persist time.
  const resolvedUri = await resolveAssetUri(fileUri);

  // Compress large clips before uploading
  let uploadUri = resolvedUri;
  const file = new ExpoFS.File(resolvedUri);
  if (!file.exists) throw new Error(`File not found: ${resolvedUri}`);
  const originalSize = file.size ?? 0;
  if (!originalSize) throw new Error('Cannot determine file size');

  if (originalSize > COMPRESS_THRESHOLD && Compressor && !skipCompression) {
    try {
      const compressed = await Compressor.Video.compress(resolvedUri, {
        compressionMethod: 'auto',
        maxSize: 720,
        bitrate: 2_000_000, // 2 Mbps — ~3.5MB per 15s
      }, (progress) => {
        // Compression is 0-40% of total progress (leave 10% for potential re-compress)
        onProgress?.(progress * 0.4);
      });
      uploadUri = compressed;

      const compFile = new ExpoFS.File(compressed);
      const compSize = compFile.size ?? originalSize;
      const ratio = Math.round((1 - compSize / originalSize) * 100);
      console.log(`[Upload] Compressed ${Math.round(originalSize / 1024 / 1024)}MB → ${Math.round(compSize / 1024 / 1024)}MB (${ratio}% smaller)`);
    } catch (err) {
      console.log('[Upload] Compression failed, uploading original:', err);
      uploadUri = resolvedUri;
    }
  }

  // Check final size
  let uploadFile = new ExpoFS.File(uploadUri);
  let fileSize = uploadFile.size ?? originalSize;

  // Second-pass re-compress if the first pass didn't get under the ceiling.
  // Long clips at 1080p can still exceed 50MB after one 720p/2Mbps pass — try
  // 540p/1Mbps before giving up so the user doesn't get blocked at the queue.
  if (fileSize > MAX_FILE_SIZE && Compressor && !skipCompression) {
    console.log(
      `[Upload] Still ${Math.round(fileSize / 1024 / 1024)}MB after first pass — re-compressing harder (540p/1Mbps)`
    );
    try {
      const recompressed = await Compressor.Video.compress(uploadUri, {
        compressionMethod: 'auto',
        maxSize: 540,
        bitrate: 1_000_000, // 1 Mbps — ~1.8MB per 15s
      }, (progress) => {
        onProgress?.(0.4 + progress * 0.1);
      });
      const recompFile = new ExpoFS.File(recompressed);
      const recompSize = recompFile.size ?? fileSize;
      console.log(
        `[Upload] Re-compressed ${Math.round(fileSize / 1024 / 1024)}MB → ${Math.round(recompSize / 1024 / 1024)}MB`
      );
      uploadUri = recompressed;
      uploadFile = recompFile;
      fileSize = recompSize;
    } catch (err) {
      console.log('[Upload] Second-pass compression failed:', err);
    }
  }

  if (fileSize > MAX_FILE_SIZE) {
    const sizeMB = Math.round(fileSize / 1024 / 1024);
    throw new Error(
      `Clip is ${sizeMB}MB after two compression passes — max is 50MB. Try recording at a shorter duration.`
    );
  }

  // Adjust progress: compression was 0-50%, upload is 50-100%
  const uploadProgress = originalSize > COMPRESS_THRESHOLD && Compressor && !skipCompression
    ? (p: number) => onProgress?.(0.5 + p * 0.5)
    : onProgress;

  if (fileSize < SIMPLE_UPLOAD_LIMIT) {
    return _simpleUpload(storagePath, uploadUri, filename, token, uploadProgress);
  }

  return _tusUpload(storagePath, uploadFile, fileSize, token, uploadProgress);
}

/** Simple single-request upload for small files. */
async function _simpleUpload(
  storagePath: string,
  fileUri: string,
  filename: string,
  token: string,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const formData = new FormData();
  formData.append('', {
    uri: fileUri,
    name: filename,
    type: 'video/mp4',
  } as any);

  const response = await fetch(
    `${config.supabase.url}/storage/v1/object/clips/${storagePath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: config.supabase.anonKey,
        'x-upsert': 'true',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  onProgress?.(1);
  return storagePath;
}

/**
 * TUS resumable upload — reads file in 6MB chunks via FileHandle.
 * Only one chunk is in memory at a time.
 */
async function _tusUpload(
  storagePath: string,
  file: InstanceType<typeof import('expo-file-system').File>,
  fileSize: number,
  token: string,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const tusEndpoint = `${config.supabase.url}/storage/v1/upload/resumable`;

  // Step 1: Create the TUS upload session
  const createResp = await fetch(tusEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: config.supabase.anonKey,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(fileSize),
      'Upload-Metadata': [
        `bucketName ${btoa('clips')}`,
        `objectName ${btoa(storagePath)}`,
        `contentType ${btoa('video/mp4')}`,
      ].join(','),
      'x-upsert': 'true',
    },
  });

  if (createResp.status !== 201) {
    const text = await createResp.text();
    throw new Error(`TUS create failed (${createResp.status}): ${text}`);
  }

  const uploadUrl = createResp.headers.get('Location');
  if (!uploadUrl) throw new Error('TUS create did not return Location header');

  // Step 2: Upload in chunks using FileHandle for efficient disk reads
  const handle = file.open();
  try {
    let offset = 0;
    while (offset < fileSize) {
      const chunkLen = Math.min(CHUNK_SIZE, fileSize - offset);
      handle.offset = offset;
      const chunk = handle.readBytes(chunkLen);

      const patchResp = await fetch(uploadUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: config.supabase.anonKey,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: chunk,
      });

      if (patchResp.status !== 204) {
        const text = await patchResp.text();
        throw new Error(`TUS upload failed at ${offset}/${fileSize} (${patchResp.status}): ${text}`);
      }

      const newOffset = patchResp.headers.get('Upload-Offset');
      offset = newOffset ? parseInt(newOffset, 10) : offset + chunkLen;

      onProgress?.(offset / fileSize);
    }
  } finally {
    handle.close();
  }

  return storagePath;
}

/**
 * Upload a locally-stitched highlight reel to Supabase Storage under
 * `clips/reels/{roundId}.mp4`.  Skips compression (reel is already encoded)
 * and bypasses the 50MB check — reels from long rounds can be larger than
 * normal clips and we want them in the cloud so they survive an app reinstall.
 *
 * Returns the bucket-relative storage path (e.g. "reels/xxx.mp4") on success,
 * or throws if the upload fails.
 */
export async function uploadReelToStorage(
  roundId: string,
  fileUri: string,
  onProgress?: (progress: number) => void,
): Promise<string> {
  if (!isNative || !ExpoFS) {
    onProgress?.(1);
    return `reels/${roundId}.mp4`;
  }

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const resolvedReelUri = await resolveAssetUri(fileUri);
  const origFile = new ExpoFS.File(resolvedReelUri);
  if (!origFile.exists) throw new Error(`Reel file not found: ${resolvedReelUri}`);
  const origSize = origFile.size ?? 0;
  if (!origSize) throw new Error('Cannot determine reel file size');

  // Stitched reels from 12+ trimmed clips routinely exceed the 50MB Supabase
  // free-tier ceiling even at 720p, and the TUS endpoint returns a hard
  // 413 "Maximum size exceeded" before the first chunk lands. Pre-compress
  // so the upload actually succeeds. Reels are viewing-only output so the
  // quality drop from compression is acceptable.
  let uploadUri = resolvedReelUri;
  let uploadFile = origFile;
  let fileSize = origSize;

  if (origSize > COMPRESS_THRESHOLD && Compressor) {
    try {
      const compressed = await Compressor.Video.compress(resolvedReelUri, {
        compressionMethod: 'auto',
        maxSize: 720,
        bitrate: 2_000_000,
      }, (progress) => {
        onProgress?.(progress * 0.4);
      });
      const cFile = new ExpoFS.File(compressed);
      const cSize = cFile.size ?? origSize;
      console.log(`[Upload] Reel compressed ${Math.round(origSize / 1024 / 1024)}MB → ${Math.round(cSize / 1024 / 1024)}MB`);
      uploadUri = compressed;
      uploadFile = cFile;
      fileSize = cSize;
    } catch (err) {
      console.log('[Upload] Reel compression failed, uploading original:', err);
    }
  }

  // Second harsher pass if still too big for the 50MB ceiling.
  if (fileSize > MAX_FILE_SIZE && Compressor) {
    console.log(`[Upload] Reel still ${Math.round(fileSize / 1024 / 1024)}MB — re-compressing at 540p/1Mbps`);
    try {
      const recompressed = await Compressor.Video.compress(uploadUri, {
        compressionMethod: 'auto',
        maxSize: 540,
        bitrate: 1_000_000,
      }, (progress) => {
        onProgress?.(0.4 + progress * 0.1);
      });
      const rFile = new ExpoFS.File(recompressed);
      const rSize = rFile.size ?? fileSize;
      console.log(`[Upload] Reel re-compressed → ${Math.round(rSize / 1024 / 1024)}MB`);
      uploadUri = recompressed;
      uploadFile = rFile;
      fileSize = rSize;
    } catch (err) {
      console.log('[Upload] Reel second-pass compression failed:', err);
    }
  }

  if (fileSize > MAX_FILE_SIZE) {
    const sizeMB = Math.round(fileSize / 1024 / 1024);
    throw new Error(
      `Reel is ${sizeMB}MB after two compression passes — max is 50MB. ` +
      `Try excluding some clips or shortening the round.`
    );
  }

  const storagePath = `reels/${roundId}.mp4`;
  const uploadProgress = origSize > COMPRESS_THRESHOLD && Compressor
    ? (p: number) => onProgress?.(0.5 + p * 0.5)
    : onProgress;

  // Small reel → simple POST.  Large reel → TUS resumable upload.
  if (fileSize < SIMPLE_UPLOAD_LIMIT) {
    return _simpleUpload(storagePath, uploadUri, `${roundId}.mp4`, token, uploadProgress);
  }

  return _tusUpload(storagePath, uploadFile, fileSize, token, uploadProgress);
}

/**
 * Get a signed download URL for a clip in storage.
 */
export async function getClipUrl(storagePath: string): Promise<string | null> {
  if (!storagePath) {
    console.warn('[r2] getClipUrl called with empty path');
    return null;
  }
  // clip_url is stored as "clips/{roundId}/{filename}" but the bucket is already "clips",
  // so strip the redundant "clips/" prefix to avoid double-prefixing.
  const pathInBucket = storagePath.startsWith('clips/') ? storagePath.slice(6) : storagePath;

  const { data, error } = await supabase.storage
    .from('clips')
    .createSignedUrl(pathInBucket, 86400 * 7);

  if (error) {
    // Used to silently return null → clips became unplayable black cards with no
    // clue why. Surface the real reason (path missing, RLS block, expired JWT).
    console.warn(`[r2] getClipUrl failed for "${pathInBucket}":`, error.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * Get the highlight reel URL.
 */
export async function getReelUrl(roundId: string): Promise<string | null> {
  const { data: round } = await supabase
    .from('rounds')
    .select('reel_url')
    .eq('id', roundId)
    .single();

  if (round?.reel_url) return round.reel_url;

  if (config.pipeline.url) {
    try {
      const response = await fetch(
        `${config.pipeline.url}/api/mobile/reel-url/${roundId}`,
        { headers: { Authorization: `Bearer ${config.pipeline.apiKey}` } }
      );
      if (!response.ok) return null;
      const data = await response.json();
      return data.ok ? data.reel_url : null;
    } catch {
      return null;
    }
  }

  return null;
}
