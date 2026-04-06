import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { config } from '@/constants/config';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * Upload a clip to Supabase Storage.
 * Uses FormData with file URI on native — React Native's fetch streams the file
 * directly from disk without reading it all into memory.
 */
export async function uploadClipToStorage(
  roundId: string,
  filename: string,
  fileUri: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  const storagePath = `${roundId}/${filename}`;

  if (!isNative) {
    onProgress?.(1);
    return storagePath;
  }

  // Get auth token for direct REST upload
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    throw new Error('Not authenticated');
  }

  // Use FormData with file URI — React Native handles streaming from disk
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
 * Get a signed download URL for a clip in storage.
 */
export async function getClipUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('clips')
    .createSignedUrl(storagePath, 86400 * 7); // 7 days

  if (error) return null;
  return data.signedUrl;
}

/**
 * Get the highlight reel URL.
 * First checks Supabase rounds.reel_url, then tries pipeline API.
 */
export async function getReelUrl(roundId: string): Promise<string | null> {
  // Check if reel_url is stored in rounds table
  const { data: round } = await supabase
    .from('rounds')
    .select('reel_url')
    .eq('id', roundId)
    .single();

  if (round?.reel_url) return round.reel_url;

  // Fallback: try pipeline API if configured
  if (config.pipeline.url) {
    try {
      const response = await fetch(
        `${config.pipeline.url}/api/mobile/reel-url/${roundId}`,
        {
          headers: {
            Authorization: `Bearer ${config.pipeline.apiKey}`,
          },
        }
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

