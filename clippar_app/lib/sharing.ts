import { supabase } from '@/lib/supabase';

// react-native-share requires native module — not available in Expo Go
let RNShare: any = null;
try {
  RNShare = require('react-native-share').default;
} catch {
  // Native module not available
}

/**
 * Share a reel or clip via the system share sheet.
 */
export async function shareReel(params: {
  reelUrl: string;
  courseName: string;
  score?: number;
}) {
  if (!RNShare) return;

  await RNShare.open({
    title: `My round at ${params.courseName}`,
    message: params.score
      ? `Check out my round at ${params.courseName} — shot ${params.score}!`
      : `Check out my round at ${params.courseName}!`,
    url: params.reelUrl,
    type: 'video/mp4',
  }).catch(() => {});
}

/**
 * Share to Instagram Stories.
 */
export async function shareToInstagramStories(videoUrl: string) {
  if (!RNShare) return;

  try {
    await RNShare.shareSingle({
      stickerImage: videoUrl,
      social: 'instagramstories' as any,
      appId: '',
    });
  } catch {
    // Instagram not installed or share failed
  }
}

/**
 * Generate a shareable link for a round.
 */
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
