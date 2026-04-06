import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { supabase } from '@/lib/supabase';
import { config } from '@/constants/config';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * Upload a clip to Supabase Storage.
 * Uses expo-file-system to read files on native (fetch+blob produces 0-byte uploads).
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

  // Read file as base64 using expo-file-system (reliable on React Native)
  // Use string literal 'base64' — FileSystem.EncodingType may be undefined in some Expo versions
  const base64Data = await FileSystem.readAsStringAsync(fileUri, {
    encoding: 'base64' as any,
  });

  if (!base64Data || base64Data.length === 0) {
    throw new Error(`File is empty or unreadable: ${fileUri}`);
  }

  // Convert base64 to ArrayBuffer for Supabase upload
  const arrayBuffer = decode(base64Data);

  const { error } = await supabase.storage
    .from('clips')
    .upload(storagePath, arrayBuffer, {
      contentType: 'video/mp4',
      upsert: true,
    });

  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
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

