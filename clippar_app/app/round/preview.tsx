import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Dimensions,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { useEditorState } from '@/hooks/useEditorState';
import type { EditorClip } from '@/types/editor';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

// ---- Progress dots ----
function ProgressDots({
  total,
  current,
}: {
  total: number;
  current: number;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 3,
        paddingHorizontal: 8,
      }}
    >
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: 3,
            borderRadius: 1.5,
            backgroundColor:
              i < current
                ? theme.colors.primary
                : i === current
                  ? '#fff'
                  : 'rgba(255,255,255,0.3)',
          }}
        />
      ))}
    </View>
  );
}

// ---- Native video clip player ----
// ExpoVideo is guaranteed to be non-null because the caller gates on `isNative`.
// Hooks are called unconditionally to respect the Rules of Hooks.
function NativeClipPlayer({
  uri,
  onEnd,
}: {
  uri: string;
  onEnd: () => void;
}) {
  const { useVideoPlayer, VideoView } = ExpoVideo!;
  const player = useVideoPlayer(uri, (p) => {
    p.play();
  });

  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      onEnd();
    });
    return () => sub.remove();
  }, [player, onEnd]);

  return (
    <VideoView
      player={player}
      style={{ flex: 1 }}
      contentFit="contain"
      nativeControls={false}
    />
  );
}

// ---- Web fallback ----
function WebClipPlaceholder({ clip }: { clip: EditorClip }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: '#000',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>
        Hole {clip.holeNumber} · Stroke {clip.shotNumber}
      </Text>
      <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 4 }}>
        Video preview on device only
      </Text>
    </View>
  );
}

// ============================================================
// PREVIEW SCREEN
// ============================================================
export default function PreviewScreen() {
  const { roundId, startIndex } = useLocalSearchParams<{
    roundId: string;
    startIndex: string;
  }>();
  const insets = useSafeAreaInsets();
  const editor = useEditorState(roundId);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const parsed = parseInt(startIndex ?? '0', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allClips = editor.getAllClipsInOrder();
  const currentClip = allClips[currentIndex];

  // Auto-advance for web (no video player to fire onEnd)
  useEffect(() => {
    if (!isNative && currentClip) {
      autoAdvanceRef.current = setTimeout(() => {
        if (currentIndex < allClips.length - 1) {
          setCurrentIndex((i) => i + 1);
        }
      }, 3000);
      return () => {
        if (autoAdvanceRef.current) clearTimeout(autoAdvanceRef.current);
      };
    }
  }, [currentIndex, currentClip, allClips.length]);

  const handleTapLeft = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
    }
  }, [currentIndex]);

  const handleTapRight = useCallback(() => {
    if (currentIndex < allClips.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      router.back();
    }
  }, [currentIndex, allClips.length]);

  const handleVideoEnd = useCallback(() => {
    if (currentIndex < allClips.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      router.back();
    }
  }, [currentIndex, allClips.length]);

  if (editor.state.loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#000',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (allClips.length === 0) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#000',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 16 }}>No clips to preview</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: theme.colors.primary }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Video player fills screen */}
      {currentClip?.sourceUri && isNative ? (
        <NativeClipPlayer
          key={currentClip.id}
          uri={currentClip.sourceUri}
          onEnd={handleVideoEnd}
        />
      ) : currentClip ? (
        <WebClipPlaceholder clip={currentClip} />
      ) : null}

      {/* Tap zones (left/right halves) */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          flexDirection: 'row',
        }}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={handleTapLeft}
          style={{ flex: 1 }}
        />
        <Pressable
          onPress={handleTapRight}
          style={{ flex: 1 }}
        />
      </View>

      {/* Top overlay: progress + close + clip info */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          paddingTop: insets.top + 8,
          paddingHorizontal: 8,
          paddingBottom: 12,
        }}
        pointerEvents="box-none"
      >
        {/* Progress dots */}
        <ProgressDots total={allClips.length} current={currentIndex} />

        {/* Close + clip info */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 12,
            paddingHorizontal: 8,
          }}
        >
          <View>
            {currentClip && (
              <>
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                  Hole {currentClip.holeNumber} · Stroke {currentClip.shotNumber}
                </Text>
                <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
                  {currentIndex + 1} of {allClips.length}
                </Text>
              </>
            )}
          </View>

          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: 'rgba(0,0,0,0.5)',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <X size={18} color="#fff" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
