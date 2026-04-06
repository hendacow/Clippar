/**
 * Web stubs for sharing — react-native-share is native-only.
 */

import { supabase } from '@/lib/supabase';

export async function shareReel(_params: {
  reelUrl: string;
  courseName: string;
  score?: number;
}) {}

export async function shareToInstagramStories(_videoUrl: string) {}

export async function getShareUrl(roundId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke('create-share-link', {
      body: { round_id: roundId },
    });
    if (error || !data) return null;
    return data.share_url ?? null;
  } catch {
    return null;
  }
}
