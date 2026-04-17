import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  Platform,
  StyleSheet,
  Animated,
  Dimensions,
  PanResponder,
  Image,
  type ViewStyle,
} from 'react-native';
import { Scissors, RotateCcw, X, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

const VideoThumbnails = isNative
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

const ExpoAV = isNative
  ? (require('expo-av') as typeof import('expo-av'))
  : null;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Trim panel constants
const TIMELINE_PADDING = 24;
const TIMELINE_WIDTH = SCREEN_WIDTH - TIMELINE_PADDING * 2;
const HANDLE_WIDTH = 24;
const MIN_TRIM_MS = 500;
const THUMB_COUNT = 10;
const THUMB_WIDTH = Math.floor(TIMELINE_WIDTH / THUMB_COUNT);
const LOOP_POLL_MS = 50;

// ---- Types ----

export interface PreviewClip {
  uri: string;
  startMs?: number;
  endMs?: number;
  holeNumber: number;
  shotNumber: number;
  // Trim metadata
  localClipId?: number;
  trimStartMs?: number;
  trimEndMs?: number;
  durationMs?: number;
  originalUri?: string;
  autoTrimmed?: boolean;
  autoTrimStartMs?: number;
  autoTrimEndMs?: number;
}

export interface RoundGroupMeta {
  roundId: string;
  courseName: string;
  date: string;
  startIndex: number;
  endIndex: number;
}

interface PreviewPlayerProps {
  clips: PreviewClip[];
  startIndex?: number;
  onDismiss?: () => void;
  style?: ViewStyle;
  hideOverlay?: boolean;
  // Round-group mode
  roundGroups?: RoundGroupMeta[];
  // Trim support
  enableTrim?: boolean;
  onTrimSave?: (clipIndex: number, trimStartMs: number, trimEndMs: number) => void;
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

// ---- Round Transition Card ----

function RoundTransitionCard({
  courseName,
  date,
  visible,
}: {
  courseName: string;
  date: string;
  visible: boolean;
}) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.delay(1000),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      opacity.setValue(0);
    }
  }, [visible, opacity]);

  if (!visible) return null;

  const formattedDate = (() => {
    try {
      return new Date(date).toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return date;
    }
  })();

  return (
    <Animated.View
      style={[styles.transitionOverlay, { opacity }]}
      pointerEvents="none"
    >
      <View style={styles.transitionCard}>
        <Text style={styles.transitionCourseName}>{courseName}</Text>
        <Text style={styles.transitionDate}>{formattedDate}</Text>
      </View>
    </Animated.View>
  );
}

// ---- Inline Trim Panel (simplified) ----

function SimpleTrimPanel({
  clip,
  onSave,
  onCancel,
}: {
  clip: PreviewClip;
  onSave: (startMs: number, endMs: number) => void;
  onCancel: () => void;
}) {
  const rawDurationMs = clip.durationMs || 5000;
  const [durationMs, setDurationMs] = useState(rawDurationMs);
  const [startMs, setStartMs] = useState(clip.trimStartMs ?? 0);
  const [endMs, setEndMs] = useState(
    clip.trimEndMs != null && clip.trimEndMs !== -1 ? clip.trimEndMs : rawDurationMs
  );
  const [activeUri, setActiveUri] = useState<string | null>(clip.uri);

  // Probe original for full-timeline if auto-trimmed
  useEffect(() => {
    if (clip.autoTrimmed && clip.originalUri && clip.originalUri !== clip.uri && ExpoAV) {
      let cancelled = false;
      (async () => {
        try {
          const { sound, status } = await ExpoAV!.Audio.Sound.createAsync(
            { uri: clip.originalUri! }, {}, undefined, false,
          );
          const dur = status.isLoaded && status.durationMillis ? status.durationMillis : rawDurationMs;
          await sound.unloadAsync();
          if (!cancelled) {
            setDurationMs(dur);
            setActiveUri(clip.originalUri!);
            setStartMs(clip.trimStartMs ?? 0);
            setEndMs(clip.trimEndMs != null && clip.trimEndMs !== -1 ? clip.trimEndMs : dur);
          }
        } catch {}
      })();
      return () => { cancelled = true; };
    }
  }, [clip.autoTrimmed, clip.originalUri, clip.uri, rawDurationMs, clip.trimStartMs, clip.trimEndMs]);

  const effectiveEndMs = endMs === -1 ? durationMs : endMs;
  const trimmedDuration = effectiveEndMs - startMs;

  const startMsRef = useRef(startMs);
  const endMsRef = useRef(effectiveEndMs);
  const durationMsRef = useRef(durationMs);
  startMsRef.current = startMs;
  endMsRef.current = effectiveEndMs;
  durationMsRef.current = durationMs;

  const startHandleOriginRef = useRef(0);
  const endHandleOriginRef = useRef(0);

  const startPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startHandleOriginRef.current = startMsRef.current;
        },
        onPanResponderMove: (_, gestureState) => {
          const dur = durationMsRef.current;
          const originMs = startHandleOriginRef.current;
          const deltaMs = (gestureState.dx / TIMELINE_WIDTH) * dur;
          const newMs = Math.round(originMs + deltaMs);
          setStartMs(Math.max(0, Math.min(newMs, endMsRef.current - MIN_TRIM_MS)));
        },
        onPanResponderRelease: () => {},
        onPanResponderTerminate: () => {},
      }),
    []
  );

  const endPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          endHandleOriginRef.current = endMsRef.current;
        },
        onPanResponderMove: (_, gestureState) => {
          const dur = durationMsRef.current;
          const originMs = endHandleOriginRef.current;
          const deltaMs = (gestureState.dx / TIMELINE_WIDTH) * dur;
          const newMs = Math.round(originMs + deltaMs);
          setEndMs(Math.min(dur, Math.max(newMs, startMsRef.current + MIN_TRIM_MS)));
        },
        onPanResponderRelease: () => {},
        onPanResponderTerminate: () => {},
      }),
    []
  );

  const msToX = (ms: number) => (ms / durationMs) * TIMELINE_WIDTH;

  // Filmstrip thumbnails
  const [filmstripThumbs, setFilmstripThumbs] = useState<(string | null)[]>([]);

  useEffect(() => {
    const videoUri = activeUri || clip.uri;
    if (!videoUri || !isNative || !VideoThumbnails) {
      setFilmstripThumbs([]);
      return;
    }
    let cancelled = false;
    const generateThumbs = async () => {
      const thumbs: (string | null)[] = new Array(THUMB_COUNT).fill(null);
      const interval = durationMs / THUMB_COUNT;
      const promises = Array.from({ length: THUMB_COUNT }, async (_, i) => {
        if (cancelled) return;
        try {
          const time = Math.round(i * interval + interval / 2);
          const result = await VideoThumbnails!.getThumbnailAsync(videoUri, {
            time,
            quality: 0.3,
          });
          if (!cancelled) thumbs[i] = result.uri;
        } catch {}
      });
      await Promise.all(promises);
      if (!cancelled) setFilmstripThumbs([...thumbs]);
    };
    generateThumbs();
    return () => { cancelled = true; };
  }, [activeUri, clip.uri, durationMs]);

  const handleReset = useCallback(() => {
    setStartMs(0);
    setEndMs(durationMs);
  }, [durationMs]);

  const handleSave = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const finalEnd = endMs >= durationMs ? -1 : endMs;
    const finalStart = startMs <= 0 ? 0 : startMs;
    onSave(finalStart, finalEnd);
  }, [startMs, endMs, durationMs, onSave]);

  const formatMs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const formatMsFull = (ms: number): string => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const frac = Math.floor((ms % 1000) / 100);
    return `${m}:${s.toString().padStart(2, '0')}.${frac}`;
  };

  return (
    <View style={styles.trimPanelContainer}>
      {/* Duration info */}
      <View style={{ alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>
          {formatMsFull(trimmedDuration)}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
          {formatMs(startMs)} — {formatMs(effectiveEndMs)}
        </Text>
      </View>

      {/* Timeline */}
      <View style={{ paddingHorizontal: TIMELINE_PADDING, marginBottom: 12 }}>
        <View style={styles.timelineTrack}>
          {/* Filmstrip */}
          {filmstripThumbs.length > 0 && (
            <View style={styles.filmstripRow}>
              {filmstripThumbs.map((thumbUri, i) => (
                <View key={i} style={{ width: THUMB_WIDTH, height: 44 }}>
                  {thumbUri ? (
                    <Image
                      source={{ uri: thumbUri }}
                      style={{ width: THUMB_WIDTH, height: 44 }}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={{ width: THUMB_WIDTH, height: 44, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                  )}
                </View>
              ))}
            </View>
          )}

          {/* Dimmed left */}
          {startMs > 0 && (
            <View
              style={{
                position: 'absolute', left: 0, width: msToX(startMs), height: '100%',
                backgroundColor: 'rgba(0,0,0,0.55)',
                borderTopLeftRadius: 8, borderBottomLeftRadius: 8,
              }}
            />
          )}

          {/* Dimmed right */}
          {effectiveEndMs < durationMs && (
            <View
              style={{
                position: 'absolute', left: msToX(effectiveEndMs),
                width: TIMELINE_WIDTH - msToX(effectiveEndMs), height: '100%',
                backgroundColor: 'rgba(0,0,0,0.55)',
                borderTopRightRadius: 8, borderBottomRightRadius: 8,
              }}
            />
          )}

          {/* Selected region */}
          <View
            style={{
              position: 'absolute', left: msToX(startMs),
              width: msToX(effectiveEndMs) - msToX(startMs), height: '100%',
              borderWidth: 2, borderColor: theme.colors.primary, borderRadius: 6,
            }}
          />

          {/* Start handle */}
          <View
            {...startPanResponder.panHandlers}
            style={{
              position: 'absolute', left: msToX(startMs) - HANDLE_WIDTH / 2,
              top: -4, width: HANDLE_WIDTH, height: 52,
              justifyContent: 'center', alignItems: 'center', zIndex: 10,
            }}
          >
            <View style={styles.handleBar} />
          </View>

          {/* End handle */}
          <View
            {...endPanResponder.panHandlers}
            style={{
              position: 'absolute', left: msToX(effectiveEndMs) - HANDLE_WIDTH / 2,
              top: -4, width: HANDLE_WIDTH, height: 52,
              justifyContent: 'center', alignItems: 'center', zIndex: 10,
            }}
          >
            <View style={styles.handleBar} />
          </View>
        </View>
      </View>

      {/* Buttons */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12 }}>
        <Pressable onPress={handleReset} style={styles.trimButton}>
          <RotateCcw size={14} color="rgba(255,255,255,0.7)" />
          <Text style={styles.trimButtonText}>Reset</Text>
        </Pressable>
        <Pressable
          onPress={onCancel}
          style={styles.trimButton}
        >
          <X size={14} color="rgba(255,255,255,0.7)" />
          <Text style={styles.trimButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={handleSave}
          style={[styles.trimButton, { backgroundColor: theme.colors.primary + '30' }]}
        >
          <Check size={14} color={theme.colors.primary} />
          <Text style={[styles.trimButtonText, { color: theme.colors.primary }]}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---- Native video clip player ----

function NativeClipPlayer({
  clip,
  isTrimming,
  onEnd,
}: {
  clip: PreviewClip;
  isTrimming: boolean;
  onEnd: () => void;
}) {
  if (!ExpoVideo) return null;

  const { useVideoPlayer, VideoView } = ExpoVideo;

  const effectiveStart = clip.trimStartMs ?? clip.startMs ?? 0;
  const rawEnd = clip.trimEndMs != null && clip.trimEndMs !== -1
    ? clip.trimEndMs
    : clip.endMs ?? 0;
  const effectiveEnd = rawEnd > 0 ? rawEnd : 0;

  const startSec = effectiveStart / 1000;
  const endSec = effectiveEnd > 0 ? effectiveEnd / 1000 : 0;

  const startSecRef = useRef(startSec);
  const endSecRef = useRef(endSec);
  const isTrimmingRef = useRef(isTrimming);
  startSecRef.current = startSec;
  endSecRef.current = endSec;
  isTrimmingRef.current = isTrimming;

  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const hasErrorRef = useRef(false);

  const player = useVideoPlayer(clip.uri, (p) => {
    if (startSec > 0) {
      p.currentTime = startSec;
    }
    p.play();
  });

  // Monitor for endMs or natural end, with trim-mode looping
  useEffect(() => {
    hasErrorRef.current = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    if (endSecRef.current > 0) {
      interval = setInterval(() => {
        if (hasErrorRef.current) return;
        if (player.currentTime >= endSecRef.current - 0.05) {
          if (isTrimmingRef.current) {
            player.currentTime = startSecRef.current;
            player.play();
          } else {
            onEndRef.current();
          }
        }
      }, LOOP_POLL_MS);
    }

    const sub = player.addListener('playToEnd', () => {
      if (hasErrorRef.current) return;
      if (isTrimmingRef.current) {
        player.currentTime = startSecRef.current;
        player.play();
      } else {
        onEndRef.current();
      }
    });

    // Auto-advance on error (clip missing, can't decode, etc.)
    const errSub = player.addListener('statusChange', (status: any) => {
      if (status?.error || status?.status === 'error') {
        if (!hasErrorRef.current) {
          hasErrorRef.current = true;
          console.warn('[PreviewPlayer] Clip failed to load, skipping:', clip.uri?.slice(-40));
          // Auto-advance after a short delay so user sees a brief flash, not infinite black
          setTimeout(() => onEndRef.current(), 300);
        }
      }
    });

    return () => {
      sub.remove();
      errSub.remove();
      if (interval) clearInterval(interval);
    };
  }, [player, clip.uri]);

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
        {clip.holeNumber >= 0
          ? `Hole ${clip.holeNumber} \u00B7 Stroke ${clip.shotNumber}`
          : 'Highlight Reel'}
      </Text>
      <Text style={styles.webPlaceholderSub}>
        Video preview on device only
      </Text>
    </View>
  );
}

// ---- Helper: find which round group a clip index belongs to ----

function findRoundGroup(
  index: number,
  roundGroups?: RoundGroupMeta[],
): RoundGroupMeta | undefined {
  if (!roundGroups) return undefined;
  return roundGroups.find(
    (g) => index >= g.startIndex && index < g.endIndex,
  );
}

// ---- Main component ----

export function PreviewPlayer({
  clips,
  startIndex = 0,
  onDismiss,
  style,
  hideOverlay = false,
  roundGroups,
  enableTrim = false,
  onTrimSave,
}: PreviewPlayerProps) {
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [isTrimming, setIsTrimming] = useState(false);
  const [showTransition, setShowTransition] = useState(false);
  const [transitionMeta, setTransitionMeta] = useState<{
    courseName: string;
    date: string;
  } | null>(null);

  const stableOnDismiss = useRef(onDismiss);
  stableOnDismiss.current = onDismiss;
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clamp index if clips array changes
  useEffect(() => {
    if (currentIndex >= clips.length && clips.length > 0) {
      setCurrentIndex(clips.length - 1);
    }
  }, [clips.length, currentIndex]);

  // Clean up transition timer
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    };
  }, []);

  const currentClip = clips[currentIndex];
  const isLast = currentIndex >= clips.length - 1;

  // Check if we need a round transition before advancing
  const maybeShowTransition = useCallback(
    (nextIndex: number) => {
      if (!roundGroups || roundGroups.length <= 1) return false;

      const currentGroup = findRoundGroup(currentIndex, roundGroups);
      const nextGroup = findRoundGroup(nextIndex, roundGroups);

      if (
        currentGroup &&
        nextGroup &&
        currentGroup.roundId !== nextGroup.roundId
      ) {
        setTransitionMeta({
          courseName: nextGroup.courseName,
          date: nextGroup.date,
        });
        setShowTransition(true);

        transitionTimerRef.current = setTimeout(() => {
          setShowTransition(false);
          setTransitionMeta(null);
          setCurrentIndex(nextIndex);
        }, 1500);

        return true;
      }
      return false;
    },
    [currentIndex, roundGroups],
  );

  const advance = useCallback(() => {
    if (isTrimming) return; // Don't auto-advance while trimming

    if (!isLast) {
      const nextIdx = currentIndex + 1;
      const didTransition = maybeShowTransition(nextIdx);
      if (!didTransition) {
        setCurrentIndex(nextIdx);
      }
    } else {
      stableOnDismiss.current?.();
    }
  }, [isLast, isTrimming, currentIndex, maybeShowTransition]);

  const handleTapLeft = useCallback(() => {
    if (isTrimming || showTransition) return;
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, [isTrimming, showTransition]);

  const handleTapRight = useCallback(() => {
    if (isTrimming || showTransition) return;
    advance();
  }, [advance, isTrimming, showTransition]);

  const handleVideoEnd = useCallback(() => {
    advance();
  }, [advance]);

  const handleTrimToggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsTrimming((prev) => !prev);
  }, []);

  const handleTrimSave = useCallback(
    (startMs: number, endMs: number) => {
      setIsTrimming(false);
      onTrimSave?.(currentIndex, startMs, endMs);
    },
    [currentIndex, onTrimSave],
  );

  const handleTrimCancel = useCallback(() => {
    setIsTrimming(false);
  }, []);

  if (!clips.length || !currentClip) {
    return (
      <View style={[styles.container, style, styles.centered]}>
        <Text style={styles.emptyText}>No clips to preview</Text>
      </View>
    );
  }

  // Determine current round group for info display
  const currentRoundGroup = findRoundGroup(currentIndex, roundGroups);

  return (
    <View style={[styles.container, style]}>
      {/* Video layer */}
      {isNative && ExpoVideo ? (
        <NativeClipPlayer
          key={`${currentIndex}-${currentClip.uri}`}
          clip={currentClip}
          isTrimming={isTrimming}
          onEnd={handleVideoEnd}
        />
      ) : (
        <WebClipPlaceholder
          key={`${currentIndex}-${currentClip.uri}`}
          clip={currentClip}
          onEnd={handleVideoEnd}
        />
      )}

      {/* Tap zones (disabled when trimming or in transition) */}
      {!isTrimming && !showTransition && (
        <View style={styles.tapZoneRow} pointerEvents="box-none">
          <Pressable onPress={handleTapLeft} style={styles.tapZone} />
          <Pressable onPress={handleTapRight} style={styles.tapZone} />
        </View>
      )}

      {/* Top overlay */}
      {!hideOverlay && (
        <View style={styles.topOverlay} pointerEvents="box-none">
          <ProgressBars total={clips.length} current={currentIndex} />

          <View style={styles.infoRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.clipTitle}>
                {currentClip.holeNumber >= 0
                  ? `Hole ${currentClip.holeNumber} \u00B7 Stroke ${currentClip.shotNumber}`
                  : 'Highlight Reel'}
              </Text>
              <Text style={styles.clipCounter}>
                {currentIndex + 1} of {clips.length}
                {currentRoundGroup
                  ? `  \u00B7  ${currentRoundGroup.courseName}`
                  : ''}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {/* Scissors button */}
              {enableTrim && !isTrimming && (
                <Pressable onPress={handleTrimToggle} style={styles.scissorsBtn}>
                  <Scissors size={18} color={theme.colors.textPrimary} />
                </Pressable>
              )}

              {/* Close button (inside PreviewPlayer so it never overlaps scissors) */}
              {onDismiss && !isTrimming && (
                <Pressable onPress={onDismiss} style={styles.scissorsBtn}>
                  <X size={18} color={theme.colors.textPrimary} />
                </Pressable>
              )}
            </View>
          </View>
        </View>
      )}

      {/* Round transition overlay */}
      {transitionMeta && (
        <RoundTransitionCard
          courseName={transitionMeta.courseName}
          date={transitionMeta.date}
          visible={showTransition}
        />
      )}

      {/* Trim panel */}
      {isTrimming && currentClip && (
        <SimpleTrimPanel
          clip={currentClip}
          onSave={handleTrimSave}
          onCancel={handleTrimCancel}
        />
      )}
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
    paddingTop: 54,
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

  // Scissors button
  scissorsBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Round transition
  transitionOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.85)',
    zIndex: 20,
  },
  transitionCard: {
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 32,
    paddingVertical: 24,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    alignItems: 'center',
  },
  transitionCourseName: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  transitionDate: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    marginTop: 6,
  },

  // Trim panel
  trimPanelContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.92)',
    paddingTop: 12,
    paddingBottom: 32,
    zIndex: 15,
  },
  timelineTrack: {
    height: 44,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
    overflow: 'visible',
  },
  filmstripRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    borderRadius: 8,
    overflow: 'hidden',
  },
  handleBar: {
    width: 6,
    height: 28,
    borderRadius: 3,
    backgroundColor: theme.colors.primary,
  },
  trimButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  trimButtonText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    fontWeight: '600',
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
