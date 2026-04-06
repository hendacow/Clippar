import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Platform,
  StyleSheet,
  type ViewStyle,
} from 'react-native';
import { theme } from '@/constants/theme';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

// ---- Types ----

export interface PreviewClip {
  uri: string;
  startMs?: number;
  endMs?: number;
  holeNumber: number;
  shotNumber: number;
}

interface PreviewPlayerProps {
  clips: PreviewClip[];
  /** Index to start playback from (default 0) */
  startIndex?: number;
  /** Called when user taps right on the last clip, or playback finishes the last clip */
  onDismiss?: () => void;
  /** Optional style override for the container */
  style?: ViewStyle;
}

// ---- Progress bars (Instagram/Snapchat story style) ----

function ProgressBars({
  total,
  current,
}: {
  total: number;
  current: number;
}) {
  return (
    <View style={styles.progressContainer}>
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={[
            styles.progressDot,
            {
              backgroundColor:
                i < current
                  ? theme.colors.primary
                  : i === current
                    ? theme.colors.textPrimary
                    : 'rgba(255,255,255,0.3)',
            },
          ]}
        />
      ))}
    </View>
  );
}

// ---- Native video clip player ----

function NativeClipPlayer({
  clip,
  onEnd,
}: {
  clip: PreviewClip;
  onEnd: () => void;
}) {
  if (!ExpoVideo) return null;

  const { useVideoPlayer, VideoView } = ExpoVideo;

  const player = useVideoPlayer(clip.uri, (p) => {
    // If startMs is set, seek to it before playing
    if (clip.startMs && clip.startMs > 0) {
      p.currentTime = clip.startMs / 1000;
    }
    p.play();
  });

  // Monitor for endMs or natural end
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    if (clip.endMs && clip.endMs > 0) {
      interval = setInterval(() => {
        if (player.currentTime >= clip.endMs! / 1000) {
          onEnd();
        }
      }, 100);
    }

    const sub = player.addListener('playToEnd', () => {
      onEnd();
    });

    return () => {
      sub.remove();
      if (interval) clearInterval(interval);
    };
  }, [player, clip.endMs, onEnd]);

  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      nativeControls={false}
    />
  );
}

// ---- Web fallback with auto-advance ----

function WebClipPlaceholder({
  clip,
  onEnd,
}: {
  clip: PreviewClip;
  onEnd: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onEnd, 3000);
    return () => clearTimeout(timer);
  }, [onEnd]);

  return (
    <View style={styles.webPlaceholder}>
      <Text style={styles.webPlaceholderTitle}>
        Hole {clip.holeNumber} {'\u00B7'} Stroke {clip.shotNumber}
      </Text>
      <Text style={styles.webPlaceholderSub}>
        Video preview on device only
      </Text>
    </View>
  );
}

// ---- Main component ----

export function PreviewPlayer({
  clips,
  startIndex = 0,
  onDismiss,
  style,
}: PreviewPlayerProps) {
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const stableOnDismiss = useRef(onDismiss);
  stableOnDismiss.current = onDismiss;

  // Clamp index if clips array changes
  useEffect(() => {
    if (currentIndex >= clips.length && clips.length > 0) {
      setCurrentIndex(clips.length - 1);
    }
  }, [clips.length, currentIndex]);

  const currentClip = clips[currentIndex];
  const isLast = currentIndex >= clips.length - 1;

  const advance = useCallback(() => {
    if (!isLast) {
      setCurrentIndex((i) => i + 1);
    } else {
      stableOnDismiss.current?.();
    }
  }, [isLast]);

  const handleTapLeft = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const handleTapRight = useCallback(() => {
    advance();
  }, [advance]);

  const handleVideoEnd = useCallback(() => {
    advance();
  }, [advance]);

  if (!clips.length || !currentClip) {
    return (
      <View style={[styles.container, style, styles.centered]}>
        <Text style={styles.emptyText}>No clips to preview</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      {/* Video layer */}
      {isNative && ExpoVideo ? (
        <NativeClipPlayer
          key={`${currentIndex}-${currentClip.uri}`}
          clip={currentClip}
          onEnd={handleVideoEnd}
        />
      ) : (
        <WebClipPlaceholder
          key={`${currentIndex}-${currentClip.uri}`}
          clip={currentClip}
          onEnd={handleVideoEnd}
        />
      )}

      {/* Tap zones */}
      <View style={styles.tapZoneRow} pointerEvents="box-none">
        <Pressable onPress={handleTapLeft} style={styles.tapZone} />
        <Pressable onPress={handleTapRight} style={styles.tapZone} />
      </View>

      {/* Top overlay */}
      <View style={styles.topOverlay} pointerEvents="none">
        <ProgressBars total={clips.length} current={currentIndex} />

        <View style={styles.infoRow}>
          <View>
            <Text style={styles.clipTitle}>
              Hole {currentClip.holeNumber} {'\u00B7'} Stroke{' '}
              {currentClip.shotNumber}
            </Text>
            <Text style={styles.clipCounter}>
              {currentIndex + 1} of {clips.length}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ---- Full-screen wrapper ----

export function PreviewPlayerFullScreen(
  props: PreviewPlayerProps,
) {
  return (
    <View style={styles.fullScreen}>
      <PreviewPlayer {...props} style={StyleSheet.absoluteFill as ViewStyle} />
    </View>
  );
}

// ---- Styles ----

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: theme.colors.textTertiary,
    ...theme.typography.body,
  },

  // Progress bars
  progressContainer: {
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 8,
  },
  progressDot: {
    flex: 1,
    height: 3,
    borderRadius: 1.5,
  },

  // Tap zones
  tapZoneRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
  },
  tapZone: {
    flex: 1,
  },

  // Top overlay
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 54, // safe-area approximation; callers can use SafeAreaView externally
    paddingHorizontal: 8,
    paddingBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingHorizontal: 8,
  },
  clipTitle: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 15,
  },
  clipCounter: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },

  // Web placeholder
  webPlaceholder: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  webPlaceholderTitle: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 18,
  },
  webPlaceholderSub: {
    color: theme.colors.textTertiary,
    fontSize: 13,
    marginTop: 4,
  },

  // Full screen
  fullScreen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
});
