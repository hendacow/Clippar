import { useEffect, useState } from 'react';
import { View, Platform, ActivityIndicator, StyleSheet } from 'react-native';
import { theme } from '@/constants/theme';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

interface ReelPreviewProps {
  signedUrl: string;
  /** Height of the preview area (default 200) */
  height?: number;
}

/**
 * Looping silent video preview for round cards.
 * Auto-plays muted in a continuous loop, like Instagram Reels / TikTok thumbnails.
 */
export function ReelPreview({ signedUrl, height = 200 }: ReelPreviewProps) {
  if (!isNative || !ExpoVideo) {
    // Web fallback: show a placeholder
    return (
      <View style={[styles.container, { height }]}>
        <View style={styles.placeholder}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <NativeReelPreview
      key={signedUrl}
      signedUrl={signedUrl}
      height={height}
    />
  );
}

function NativeReelPreview({
  signedUrl,
  height,
}: {
  signedUrl: string;
  height: number;
}) {
  const { useVideoPlayer, VideoView } = ExpoVideo!;
  const [isLoading, setIsLoading] = useState(true);

  const player = useVideoPlayer(signedUrl, (p) => {
    p.loop = true;
    p.volume = 0;
    p.play();
  });

  // Ensure playback restarts after player recreation
  useEffect(() => {
    player.play();
  }, [player]);

  useEffect(() => {
    const sub = player.addListener('statusChange', (event: any) => {
      if (event.status === 'readyToPlay' || event.status === 'playing') {
        setIsLoading(false);
      }
    });
    return () => {
      sub.remove();
    };
  }, [player]);

  return (
    <View style={[styles.container, { height }]}>
      {isLoading && (
        <View style={[styles.placeholder, StyleSheet.absoluteFill]}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      )}
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface,
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
  },
});
