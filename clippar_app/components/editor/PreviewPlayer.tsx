import { View, Text, Platform } from 'react-native';
import { theme } from '@/constants/theme';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Dynamic import: expo-video may not bundle correctly on web
const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

interface PreviewPlayerProps {
  source: string | null;
}

export function PreviewPlayer({ source }: PreviewPlayerProps) {
  if (!source || !isNative || !ExpoVideo) {
    return (
      <View
        style={{
          height: 240,
          backgroundColor: '#000',
          borderRadius: theme.radius.lg,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Text style={{ color: theme.colors.textTertiary }}>
          {source ? 'Video preview (device only)' : 'No video available'}
        </Text>
      </View>
    );
  }

  return <NativePreviewPlayer source={source} />;
}

function NativePreviewPlayer({ source }: { source: string }) {
  const { useVideoPlayer, VideoView } = ExpoVideo!;
  const player = useVideoPlayer(source);

  return (
    <View
      style={{
        height: 240,
        backgroundColor: '#000',
        borderRadius: theme.radius.lg,
        overflow: 'hidden',
      }}
    >
      <VideoView
        player={player}
        style={{ flex: 1 }}
        contentFit="contain"
        nativeControls
        allowsFullscreen
      />
    </View>
  );
}
