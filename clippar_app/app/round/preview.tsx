import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  Dimensions,
  Platform,
  ActivityIndicator,
  PanResponder,
  Image,
} from 'react-native';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Scissors, Check, RotateCcw, Music, VolumeX } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { useEditorState } from '@/hooks/useEditorState';
import { trimVideo } from 'shot-detector';
import { type EditorClip, type EditorHoleSection, getInitialTrimBounds } from '@/types/editor';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const LOOP_POLL_MS = 50;

const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

const VideoThumbnails = isNative
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

const ExpoAV = isNative
  ? (require('expo-av') as typeof import('expo-av'))
  : null;

// ---- Constants for inline trim ----
const TIMELINE_PADDING = 24;
const TIMELINE_WIDTH = SCREEN_WIDTH - TIMELINE_PADDING * 2;
const HANDLE_WIDTH = 24;
const MIN_TRIM_MS = 500;
const THUMB_COUNT = 12;
const THUMB_WIDTH = Math.floor(TIMELINE_WIDTH / THUMB_COUNT);

// ============================================================
// SCORECARD OVERLAY — persistent, looks like a real scorecard
// ============================================================
// Shows: course name, hole grid, shot label, running score.
// Score only updates AFTER a hole finishes (not during).

function ScorecardOverlay({
  clip,
  clipIndex,
  allClips,
  holes,
  courseName,
}: {
  clip: EditorClip;
  clipIndex: number;
  allClips: EditorClip[];
  holes: EditorHoleSection[];
  courseName: string;
}) {
  const currentHole = holes.find((h) => h.holeNumber === clip.holeNumber);
  if (!currentHole) return null;

  const holeClips = currentHole.clips.filter((c) => !c.isExcluded);
  const shotIndex = holeClips.findIndex((c) => c.id === clip.id);
  const shotLabel = `Shot ${shotIndex + 1}`;
  const totalShots = holeClips.length;
  const isLastShotOfHole = shotIndex === totalShots - 1;

  // Running score = sum of strokes for all COMPLETED holes BEFORE this one.
  // A hole is "completed" if the current clip is past the last shot of that hole.
  // During a hole's shots the running score doesn't include that hole yet.
  let runningStrokes = 0;
  let runningPar = 0;
  for (const h of holes) {
    if (h.holeNumber < clip.holeNumber) {
      runningStrokes += h.strokes;
      runningPar += h.par;
    }
  }

  // If this is the LAST shot of the current hole, include this hole's score
  // (user sees the score update after the last shot plays)
  if (isLastShotOfHole) {
    runningStrokes += currentHole.strokes;
    runningPar += currentHole.par;
  }

  const scoreToPar = runningStrokes - runningPar;
  const scoreColor =
    scoreToPar < 0 ? '#4ADE80' : scoreToPar === 0 ? '#FFFFFF' : '#FF7366';
  const scoreLabel =
    runningStrokes === 0
      ? '-'
      : scoreToPar < 0
        ? `${scoreToPar}`
        : scoreToPar === 0
          ? 'E'
          : `+${scoreToPar}`;

  // Hole score for current hole (only show if last shot)
  const holeScoreToPar = currentHole.strokes - currentHole.par;
  const holeScoreColor =
    holeScoreToPar < 0 ? '#4ADE80' : holeScoreToPar === 0 ? '#FFFFFF' : '#FF7366';
  const holeScoreLabel =
    holeScoreToPar < 0
      ? scoreName(holeScoreToPar)
      : holeScoreToPar === 0
        ? 'Par'
        : holeScoreToPar === 1
          ? 'Bogey'
          : holeScoreToPar === 2
            ? 'Double Bogey'
            : `+${holeScoreToPar}`;

  return (
    <View
      style={{
        position: 'absolute',
        bottom: 24,
        left: 12,
        right: 12,
      }}
      pointerEvents="none"
    >
      {/* Main scorecard container */}
      <View
        style={{
          backgroundColor: 'rgba(0,0,0,0.75)',
          borderRadius: 16,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.1)',
        }}
      >
        {/* Top row: course name + running score */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
          }}
        >
          <Text
            style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' }}
            numberOfLines={1}
          >
            {courseName || 'Round'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
              TOTAL
            </Text>
            <Text style={{ color: scoreColor, fontWeight: '800', fontSize: 14 }}>
              {runningStrokes > 0 ? runningStrokes : '-'}
            </Text>
            {runningStrokes > 0 && (
              <View
                style={{
                  backgroundColor: scoreColor + '25',
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: 4,
                }}
              >
                <Text style={{ color: scoreColor, fontWeight: '800', fontSize: 11 }}>
                  {scoreLabel}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Divider */}
        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginHorizontal: 12 }} />

        {/* Hole mini-grid — shows recent holes with scores */}
        <View
          style={{
            flexDirection: 'row',
            paddingHorizontal: 8,
            paddingTop: 8,
            paddingBottom: 4,
          }}
        >
          {holes.slice(0, Math.min(holes.length, 9)).map((h) => {
            const isCurrent = h.holeNumber === clip.holeNumber;
            const isCompleted = h.holeNumber < clip.holeNumber || (isCurrent && isLastShotOfHole);
            const hSTP = h.strokes - h.par;
            const hColor = !isCompleted
              ? 'rgba(255,255,255,0.25)'
              : hSTP < 0
                ? '#4ADE80'
                : hSTP === 0
                  ? '#FFFFFF'
                  : '#FF7366';

            return (
              <View
                key={h.holeNumber}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor: isCurrent ? 'rgba(255,255,255,0.1)' : 'transparent',
                }}
              >
                <Text
                  style={{
                    color: isCurrent ? '#fff' : 'rgba(255,255,255,0.4)',
                    fontSize: 10,
                    fontWeight: '600',
                  }}
                >
                  {h.holeNumber}
                </Text>
                <Text
                  style={{
                    color: hColor,
                    fontSize: 13,
                    fontWeight: '800',
                    marginTop: 1,
                  }}
                >
                  {isCompleted ? h.strokes : '-'}
                </Text>
                <Text
                  style={{
                    color: 'rgba(255,255,255,0.25)',
                    fontSize: 9,
                  }}
                >
                  {h.par}
                </Text>
              </View>
            );
          })}
        </View>

        {/* Bottom row: current hole + shot info */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingTop: 6,
            paddingBottom: 12,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>
              Hole {currentHole.holeNumber}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '500' }}>
              Par {currentHole.par}
            </Text>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={{
                backgroundColor: theme.colors.primary + '30',
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: theme.colors.primary, fontWeight: '700', fontSize: 13 }}>
                {shotLabel} of {totalShots}
              </Text>
            </View>

            {/* Show hole result on last shot */}
            {isLastShotOfHole && (
              <View
                style={{
                  backgroundColor: holeScoreColor + '25',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                }}
              >
                <Text style={{ color: holeScoreColor, fontWeight: '800', fontSize: 12 }}>
                  {holeScoreLabel}
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

function scoreName(toPar: number): string {
  if (toPar === -3) return 'Albatross';
  if (toPar === -2) return 'Eagle';
  if (toPar === -1) return 'Birdie';
  return `${toPar}`;
}

// ============================================================
// PROGRESS DOTS
// ============================================================
function ProgressDots({ total, current }: { total: number; current: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 3, paddingHorizontal: 8 }}>
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

// ============================================================
// FORMAT HELPERS
// ============================================================
function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatMsFull(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const frac = Math.floor((ms % 1000) / 100);
  return `${m}:${s.toString().padStart(2, '0')}.${frac}`;
}

// ============================================================
// NATIVE VIDEO PLAYER — respects trim bounds, loops in trim mode
// ExpoVideo is guaranteed non-null because the caller gates on `isNative`.
// Hooks are called unconditionally to respect the Rules of Hooks.
// ============================================================
function NativeClipPlayer({
  uri,
  trimStartMs,
  trimEndMs,
  durationMs,
  isTrimming,
  onEnd,
  seekTarget = 'start',
  draggingHandle = 'none',
}: {
  uri: string;
  trimStartMs: number;
  trimEndMs: number; // -1 = full
  durationMs: number;
  isTrimming: boolean;
  onEnd: () => void;
  seekTarget?: 'start' | 'end';
  draggingHandle?: 'none' | 'start' | 'end';
}) {
  // CRITICAL: never early-return before calling hooks. ExpoVideo is non-null
  // because the caller gates on `isNative`; the non-null assertion is safe.
  const { useVideoPlayer, VideoView } = ExpoVideo!;

  const effectiveEnd = trimEndMs === -1 ? durationMs : trimEndMs;
  const startSec = trimStartMs / 1000;
  const endSec = effectiveEnd / 1000;

  const startSecRef = useRef(startSec);
  const endSecRef = useRef(endSec);
  const isTrimmingRef = useRef(isTrimming);
  const draggingHandleRef = useRef(draggingHandle);
  startSecRef.current = startSec;
  endSecRef.current = endSec;
  isTrimmingRef.current = isTrimming;
  draggingHandleRef.current = draggingHandle;

  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.currentTime = startSecRef.current;
    p.play();
  });

  // When trim bounds change, seek based on which handle is being dragged
  useEffect(() => {
    if (draggingHandle === 'end') {
      // Dragging right handle: pause and show end frame
      player.pause();
      player.currentTime = Math.max(0, endSec - 0.1);
    } else if (draggingHandle === 'start') {
      // Dragging left handle: pause and show start frame
      player.pause();
      player.currentTime = startSec;
    } else {
      // Not dragging (handle released): seek and play
      player.currentTime = seekTarget === 'end'
        ? Math.max(0, endSec - 0.1)
        : startSec;
      player.play();
    }
  }, [startSec, endSec, player, seekTarget, draggingHandle]);

  // Poll to enforce trim end boundary + loop in trim mode
  useEffect(() => {
    const interval = setInterval(() => {
      // Don't interfere with playback while user is dragging a handle
      if (draggingHandleRef.current !== 'none') return;

      const currentTime = player.currentTime;
      const end = endSecRef.current;
      const start = startSecRef.current;

      if (currentTime >= end - 0.05) {
        if (isTrimmingRef.current) {
          // In trim mode: loop back to start
          player.currentTime = start;
          player.play();
        }
        // In normal mode: onEnd fires via playToEnd listener
      }
    }, LOOP_POLL_MS);

    return () => clearInterval(interval);
  }, [player]);

  // Handle natural end of video
  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      if (isTrimmingRef.current) {
        player.currentTime = startSecRef.current;
        player.play();
      } else {
        onEnd();
      }
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

// ============================================================
// WEB FALLBACK
// ============================================================
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
// INLINE TRIM PANEL
// ============================================================
function InlineTrimPanel({
  clip,
  onSave,
  onCancel,
  onBoundsChange,
  onSeekTarget,
  onDraggingHandle,
}: {
  clip: EditorClip;
  onSave: (startMs: number, endMs: number, sourceOverride?: { sourceUri: string; durationMs: number }) => void;
  onCancel: () => void;
  onBoundsChange: (startMs: number, endMs: number) => void;
  onSeekTarget?: (target: 'start' | 'end') => void;
  onDraggingHandle?: (handle: 'none' | 'start' | 'end') => void;
}) {
  const initialBounds = getInitialTrimBounds(clip, clip.durationMs || 5000);
  const [durationMs, setDurationMs] = useState(clip.durationMs || 5000);
  const [startMs, setStartMs] = useState(initialBounds.startMs);
  const [endMs, setEndMs] = useState(initialBounds.endMs);
  const [activeUri, setActiveUri] = useState<string | null>(clip.sourceUri);
  const [savingTrim, setSavingTrim] = useState(false);

  // Auto-probe original for full-timeline.
  // Dep must be `clip.id` (stable primitive), NOT the `clip` object — the
  // parent re-renders whenever the live trim bounds update, and each render
  // creates a fresh `currentClip` reference. Depending on `clip` refired this
  // effect on every parent tick, which called setStartMs(clip.trimStartMs)
  // mid-drag — reverting the user's drag and triggering the bounds-change
  // effect below, which pushed new bounds back to the parent, which
  // re-rendered, repeating until React threw "Maximum update depth exceeded."
  useEffect(() => {
    if (clip.autoTrimmed && clip.originalUri && clip.originalUri !== clip.sourceUri && ExpoAV) {
      let cancelled = false;
      (async () => {
        try {
          const { sound, status } = await ExpoAV!.Audio.Sound.createAsync(
            { uri: clip.originalUri! }, {}, undefined, false,
          );
          const dur = status.isLoaded && status.durationMillis ? status.durationMillis : clip.durationMs || 5000;
          await sound.unloadAsync();
          if (!cancelled) {
            setDurationMs(dur);
            setActiveUri(clip.originalUri!);
            // Default to detected swing window when user hasn't customized;
            // user can drag handles outward to include more of the original.
            const bounds = getInitialTrimBounds(clip, dur);
            setStartMs(bounds.startMs);
            setEndMs(bounds.endMs);
          }
        } catch {}
      })();
      return () => { cancelled = true; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

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

  // Notify parent of bounds changes so the video player can seek.
  // Ref-guarded: skip when the values haven't actually moved. Without
  // this, edge cases (auto-trim completing while the trim modal is open,
  // re-renders that happen to recompute effectiveEndMs to the same number,
  // etc.) can fire onBoundsChange with no real change, which then sets
  // parent state, which re-renders this child — and depending on render
  // timing React can flag it as a max-update-depth loop.
  const lastReportedBoundsRef = useRef<{ startMs: number; endMs: number } | null>(null);
  useEffect(() => {
    const last = lastReportedBoundsRef.current;
    if (last && last.startMs === startMs && last.endMs === effectiveEndMs) {
      return;
    }
    lastReportedBoundsRef.current = { startMs, endMs: effectiveEndMs };
    onBoundsChange(startMs, effectiveEndMs);
  }, [startMs, effectiveEndMs]);

  const startPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startHandleOriginRef.current = startMsRef.current;
          onDraggingHandle?.('start');
        },
        onPanResponderMove: (_, gestureState) => {
          const dur = durationMsRef.current;
          const originMs = startHandleOriginRef.current;
          const deltaMs = (gestureState.dx / TIMELINE_WIDTH) * dur;
          const newMs = Math.round(originMs + deltaMs);
          setStartMs(Math.max(0, Math.min(newMs, endMsRef.current - MIN_TRIM_MS)));
        },
        onPanResponderRelease: () => {
          onDraggingHandle?.('none');
          onSeekTarget?.('start');
        },
        onPanResponderTerminate: () => {
          onDraggingHandle?.('none');
          onSeekTarget?.('start');
        },
      }),
    [onSeekTarget, onDraggingHandle]
  );

  const endPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          endHandleOriginRef.current = endMsRef.current;
          onDraggingHandle?.('end');
        },
        onPanResponderMove: (_, gestureState) => {
          const dur = durationMsRef.current;
          const originMs = endHandleOriginRef.current;
          const deltaMs = (gestureState.dx / TIMELINE_WIDTH) * dur;
          const newMs = Math.round(originMs + deltaMs);
          setEndMs(Math.min(dur, Math.max(newMs, startMsRef.current + MIN_TRIM_MS)));
        },
        onPanResponderRelease: () => {
          onDraggingHandle?.('none');
          onSeekTarget?.('end');
        },
        onPanResponderTerminate: () => {
          onDraggingHandle?.('none');
          onSeekTarget?.('end');
        },
      }),
    [onSeekTarget, onDraggingHandle]
  );

  const msToX = (ms: number) => (ms / durationMs) * TIMELINE_WIDTH;

  // Filmstrip thumbnails
  const [filmstripThumbs, setFilmstripThumbs] = useState<(string | null)[]>([]);

  useEffect(() => {
    const videoUri = activeUri || clip.sourceUri;
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
  }, [activeUri, clip.sourceUri, durationMs]);

  const handleReset = useCallback(() => {
    setStartMs(0);
    setEndMs(durationMs);
  }, [durationMs]);

  const handleSave = useCallback(async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const finalEnd = endMs >= durationMs ? -1 : endMs;
    const finalStart = startMs <= 0 ? 0 : startMs;

    // If editing from original, re-trim to create a new file
    if (clip.autoTrimmed && activeUri && activeUri === clip.originalUri) {
      setSavingTrim(true);
      try {
        const trimEnd = finalEnd === -1 ? durationMs : finalEnd;
        const result = await trimVideo(activeUri, finalStart, trimEnd);
        onSave(finalStart, finalEnd, {
          sourceUri: result.trimmedUri,
          durationMs: trimEnd - finalStart,
        });
      } catch {
        onSave(finalStart, finalEnd);
      } finally {
        setSavingTrim(false);
      }
    } else {
      onSave(finalStart, finalEnd);
    }
  }, [startMs, endMs, durationMs, onSave, clip.autoTrimmed, clip.originalUri, activeUri]);

  return (
    <View
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: 'rgba(0,0,0,0.92)',
        paddingTop: 12,
        paddingBottom: 32,
      }}
    >
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
        <View
          style={{
            height: 44,
            backgroundColor: 'rgba(255,255,255,0.1)',
            borderRadius: 8,
            overflow: 'visible',
          }}
        >
          {/* Filmstrip */}
          {filmstripThumbs.length > 0 && (
            <View
              style={{
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                flexDirection: 'row', borderRadius: 8, overflow: 'hidden',
              }}
            >
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
            <View
              style={{ width: 6, height: 28, borderRadius: 3, backgroundColor: theme.colors.primary }}
            />
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
            <View
              style={{ width: 6, height: 28, borderRadius: 3, backgroundColor: theme.colors.primary }}
            />
          </View>
        </View>
      </View>

      {/* Buttons */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12 }}>
        <Pressable
          onPress={handleReset}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 6,
            paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
            backgroundColor: 'rgba(255,255,255,0.12)',
          }}
        >
          <RotateCcw size={14} color="rgba(255,255,255,0.7)" />
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' }}>Reset</Text>
        </Pressable>

        <Pressable
          onPress={onCancel}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 6,
            paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
            backgroundColor: 'rgba(255,255,255,0.12)',
          }}
        >
          <X size={14} color="rgba(255,255,255,0.7)" />
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' }}>Cancel</Text>
        </Pressable>

        <Pressable
          onPress={handleSave}
          disabled={savingTrim}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 6,
            paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
            backgroundColor: theme.colors.primary,
            opacity: savingTrim ? 0.5 : 1,
          }}
        >
          <Check size={14} color="#fff" />
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
            {savingTrim ? 'Saving...' : 'Save'}
          </Text>
        </Pressable>
      </View>
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

  // Trim state
  const [trimMode, setTrimMode] = useState(false);
  // Live trim bounds from the trim panel (drives the video player in real time)
  const [liveTrimStart, setLiveTrimStart] = useState(0);
  const [liveTrimEnd, setLiveTrimEnd] = useState(-1);
  // Player remount key — bump this after saving trim so the player re-initializes
  const [playerGeneration, setPlayerGeneration] = useState(0);
  // Track which handle was last released for seek direction
  const [seekTarget, setSeekTarget] = useState<'start' | 'end'>('start');
  // Track which handle is actively being dragged (for live frame seeking)
  const [draggingHandle, setDraggingHandle] = useState<'none' | 'start' | 'end'>('none');
  // URI to use in trim mode (original for auto-trimmed clips)
  const [trimModeUri, setTrimModeUri] = useState<string | null>(null);

  // Music state
  const [musicEnabled, setMusicEnabled] = useState(false);
  const soundRef = useRef<any>(null);

  // Reload editor state on focus to pick up trim changes from other screens
  useFocusEffect(
    useCallback(() => {
      editor.reload();
    }, [editor.reload])
  );

  const allClips = editor.getAllClipsInOrder();
  const currentClip = allClips[currentIndex];

  // When entering trim mode, initialize live bounds and URI
  useEffect(() => {
    if (trimMode && currentClip) {
      // Default trim bounds to the detected swing window when the user
      // hasn't customized — InlineTrimPanel re-runs the same calculation
      // against the actual probed duration once it loads.
      const initialBounds = getInitialTrimBounds(currentClip, currentClip.durationMs);
      setLiveTrimStart(initialBounds.startMs);
      setLiveTrimEnd(initialBounds.endMs);
      // Use original URI for auto-trimmed clips so the trimmer shows full video
      if (currentClip.autoTrimmed && currentClip.originalUri && currentClip.originalUri !== currentClip.sourceUri) {
        setTrimModeUri(currentClip.originalUri);
      } else {
        setTrimModeUri(currentClip.sourceUri);
      }
      setSeekTarget('start');
    } else {
      setTrimModeUri(null);
    }
  }, [trimMode]);

  // Background music
  useEffect(() => {
    if (!isNative || !ExpoAV || !musicEnabled) {
      if (soundRef.current) {
        soundRef.current.stopAsync().catch(() => {});
        soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const loadMusic = async () => {
      try {
        const { Audio } = ExpoAV!;
        const { sound } = await Audio.Sound.createAsync(
          { uri: '' }, // placeholder — real music from editor selection
          { shouldPlay: true, isLooping: true, volume: 0.3 }
        );
        if (cancelled) {
          await sound.unloadAsync();
          return;
        }
        soundRef.current = sound;
      } catch {}
    };
    loadMusic();

    return () => {
      cancelled = true;
      if (soundRef.current) {
        soundRef.current.stopAsync().catch(() => {});
        soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
    };
  }, [musicEnabled]);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.stopAsync().catch(() => {});
        soundRef.current.unloadAsync().catch(() => {});
      }
    };
  }, []);

  // Auto-advance for web
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
    if (trimMode) return;
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }, [currentIndex, trimMode]);

  const handleTapRight = useCallback(() => {
    if (trimMode) return;
    if (currentIndex < allClips.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      router.back();
    }
  }, [currentIndex, allClips.length, trimMode]);

  const handleVideoEnd = useCallback(() => {
    if (trimMode) return;
    if (currentIndex < allClips.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      router.back();
    }
  }, [currentIndex, allClips.length, trimMode]);

  // Ref-guarded handler — drops calls where nothing changed. The
  // setState calls below would normally short-circuit on identical
  // values, but the ref check also prevents the React reconciler
  // from queueing a (no-op) update in the first place, which is
  // what was triggering "Maximum update depth" during rapid drag
  // events compounded with auto-trim state updates.
  const lastBoundsAppliedRef = useRef<{ startMs: number; endMs: number } | null>(null);
  const handleTrimBoundsChange = useCallback((startMs: number, endMs: number) => {
    const last = lastBoundsAppliedRef.current;
    if (last && last.startMs === startMs && last.endMs === endMs) return;
    lastBoundsAppliedRef.current = { startMs, endMs };
    setLiveTrimStart(startMs);
    setLiveTrimEnd(endMs);
  }, []);

  const handleSeekTarget = useCallback((target: 'start' | 'end') => {
    setSeekTarget(target);
  }, []);

  const handleTrimSave = useCallback(
    (startMs: number, endMs: number, sourceOverride?: { sourceUri: string; durationMs: number }) => {
      if (currentClip) {
        editor.updateTrim(currentClip.id, startMs, endMs, sourceOverride);
      }
      setTrimMode(false);
      // Bump the generation so the player remounts with the new trim bounds
      setPlayerGeneration((g) => g + 1);
    },
    [currentClip, editor]
  );

  const handleTrimCancel = useCallback(() => {
    setTrimMode(false);
    // Bump generation to restart playback cleanly
    setPlayerGeneration((g) => g + 1);
  }, []);

  const toggleTrimMode = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTrimMode((prev) => !prev);
  }, []);

  const toggleMusic = useCallback(() => {
    Haptics.selectionAsync();
    setMusicEnabled((prev) => !prev);
  }, []);

  // Determine the trim bounds the player should use.
  // For auto-trimmed clips where sourceUri is already the trimmed file,
  // don't apply original-relative offsets — play the whole trimmed file.
  const isAlreadyTrimmedFile = !trimMode && currentClip?.autoTrimmed &&
    currentClip?.originalUri && currentClip?.originalUri !== currentClip?.sourceUri;

  const playerTrimStart = trimMode ? liveTrimStart :
    (isAlreadyTrimmedFile ? 0 : (currentClip?.trimStartMs ?? 0));
  const playerTrimEnd = trimMode ? liveTrimEnd :
    (isAlreadyTrimmedFile ? -1 : (currentClip?.trimEndMs ?? -1));
  const playerDuration = currentClip?.durationMs || 10000;

  if (editor.state.loading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (allClips.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 16 }}>No clips to preview</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: theme.colors.primary }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Video player */}
      {currentClip?.sourceUri && isNative ? (
        <NativeClipPlayer
          key={`${currentClip.id}_${playerGeneration}`}
          uri={trimMode && trimModeUri ? trimModeUri : currentClip.sourceUri}
          trimStartMs={playerTrimStart}
          trimEndMs={playerTrimEnd}
          durationMs={playerDuration}
          isTrimming={trimMode}
          onEnd={handleVideoEnd}
          seekTarget={trimMode ? seekTarget : 'start'}
          draggingHandle={trimMode ? draggingHandle : 'none'}
        />
      ) : currentClip ? (
        <WebClipPlaceholder clip={currentClip} />
      ) : null}

      {/* Tap zones — disabled in trim mode */}
      {!trimMode && (
        <View
          style={{
            position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
            flexDirection: 'row',
          }}
          pointerEvents="box-none"
        >
          <Pressable onPress={handleTapLeft} style={{ flex: 1 }} />
          <Pressable onPress={handleTapRight} style={{ flex: 1 }} />
        </View>
      )}

      {/* Scorecard overlay — always visible, hides during trim */}
      {currentClip && !trimMode && (
        <ScorecardOverlay
          clip={currentClip}
          clipIndex={currentIndex}
          allClips={allClips}
          holes={editor.state.holes}
          courseName={editor.state.courseName}
        />
      )}

      {/* Top overlay */}
      <View
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          paddingTop: insets.top + 8, paddingHorizontal: 8, paddingBottom: 12,
        }}
        pointerEvents="box-none"
      >
        <ProgressDots total={allClips.length} current={currentIndex} />

        <View
          style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 12, paddingHorizontal: 8,
          }}
        >
          <View style={{ flex: 1 }}>
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

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {/* Music toggle */}
            <Pressable
              onPress={toggleMusic}
              hitSlop={10}
              style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: musicEnabled ? theme.colors.primary + '40' : 'rgba(0,0,0,0.5)',
                justifyContent: 'center', alignItems: 'center',
              }}
            >
              {musicEnabled ? (
                <Music size={16} color={theme.colors.primary} />
              ) : (
                <VolumeX size={16} color="rgba(255,255,255,0.7)" />
              )}
            </Pressable>

            {/* Trim toggle */}
            <Pressable
              onPress={toggleTrimMode}
              hitSlop={10}
              style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: trimMode ? theme.colors.primary : 'rgba(0,0,0,0.5)',
                justifyContent: 'center', alignItems: 'center',
              }}
            >
              <Scissors size={16} color="#fff" />
            </Pressable>

            {/* Close */}
            <Pressable
              onPress={() => router.back()}
              hitSlop={12}
              style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: 'rgba(0,0,0,0.5)',
                justifyContent: 'center', alignItems: 'center',
              }}
            >
              <X size={18} color="#fff" />
            </Pressable>
          </View>
        </View>
      </View>

      {/* Inline trim panel */}
      {trimMode && currentClip && (
        <InlineTrimPanel
          clip={currentClip}
          onSave={handleTrimSave}
          onCancel={handleTrimCancel}
          onBoundsChange={handleTrimBoundsChange}
          onSeekTarget={handleSeekTarget}
          onDraggingHandle={setDraggingHandle}
        />
      )}
    </View>
  );
}
