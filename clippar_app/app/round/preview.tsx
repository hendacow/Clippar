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
import { X, RotateCcw, Music, VolumeX, PersonStanding, Pause } from 'lucide-react-native';
import { PoseOverlay } from '@/components/editor/PoseOverlay';
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

/** Two sets of trim bounds this close together are the SAME edit. The panel
 *  works in whole milliseconds and the handles snap, so a scrub out-and-back
 *  lands a millisecond or two off where it started; without a tolerance that
 *  would auto-save (and re-encode) a clip nobody actually changed. */
const BOUNDS_EPSILON_MS = 25;

/** Taps closer together than this are dropped. Each accepted tap tears down
 *  one expo-video player and builds another; letting a burst through stacks
 *  live native players on top of each other. See the crash notes on
 *  `NativeClipPlayer`. */
const TAP_DEBOUNCE_MS = 220;

function boundsEqual(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): boolean {
  return (
    Math.abs(a.startMs - b.startMs) <= BOUNDS_EPSILON_MS &&
    Math.abs(a.endMs - b.endMs) <= BOUNDS_EPSILON_MS
  );
}

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
  bottomOffset = 0,
}: {
  clip: EditorClip;
  clipIndex: number;
  allClips: EditorClip[];
  holes: EditorHoleSection[];
  courseName: string;
  /** Lift above the docked trim panel. Measured rather than assumed — the
   *  panel's height changes with the safe-area inset and the clip's labels. */
  bottomOffset?: number;
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
        bottom: 24 + bottomOffset,
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
// NATIVE VIDEO PLAYER — respects trim bounds, ALWAYS loops.
// ExpoVideo is guaranteed non-null because the caller gates on `isNative`.
// Hooks are called unconditionally to respect the Rules of Hooks.
//
// Auto-advance is gone: when a clip reaches its trim end (or the end of the
// file) it loops back to the trim start. Moving between clips is the tap
// zones' job and nothing else's, so this component no longer takes an `onEnd`.
//
// ---- WHY EVERY PLAYER CALL IS GUARDED ----
// `useVideoPlayer` is `useReleasingSharedObject` underneath, and that hook
// releases the previous player *during render* when the source uri changes:
//
//     const object = useMemo(() => {
//       if (!newObject || !dependenciesAreEqual) {
//         objectRef.current?.release();   // <-- render phase
//         newObject = factory();
//       ...
//     }, [JSON.stringify(parsedSource)]);
//
// The 50 ms poll below and the `playToEnd` listener are still bound to that
// instance until React flushes passive effects — a separate task — so there is
// a real window in which they fire against a released object. Per
// expo-modules-core, a released SharedObject throws on *any* native call
// ("no longer associated with its native counterpart"), and an uncaught throw
// inside a timer callback is fatal in a release build.
//
// `livePlayerRef` is written during render, so a stale callback can tell it is
// stale before it touches native at all; the try/catch covers the remaining
// teardown orderings (on unmount React runs this hook's release cleanup BEFORE
// the clearInterval / listener-removal cleanups declared after it).
// ============================================================
function NativeClipPlayer({
  uri,
  trimStartMs,
  trimEndMs,
  durationMs,
  seekTarget = 'start',
  draggingHandle = 'none',
  showPoseOverlay = false,
  paused = false,
}: {
  uri: string;
  trimStartMs: number;
  trimEndMs: number; // -1 = full
  durationMs: number;
  seekTarget?: 'start' | 'end';
  draggingHandle?: 'none' | 'start' | 'end';
  showPoseOverlay?: boolean;
  /** Press-and-hold anywhere on the video. Held separately from the trim
   *  seeking above, which drives the player from the handles. */
  paused?: boolean;
}) {
  // CRITICAL: never early-return before calling hooks. ExpoVideo is non-null
  // because the caller gates on `isNative`; the non-null assertion is safe.
  const { useVideoPlayer, VideoView } = ExpoVideo!;

  const effectiveEnd = trimEndMs === -1 ? durationMs : trimEndMs;
  const startSec = trimStartMs / 1000;
  const endSec = effectiveEnd / 1000;

  const startSecRef = useRef(startSec);
  const endSecRef = useRef(endSec);
  const draggingHandleRef = useRef(draggingHandle);
  const pausedRef = useRef(paused);
  startSecRef.current = startSec;
  endSecRef.current = endSec;
  draggingHandleRef.current = draggingHandle;
  pausedRef.current = paused;

  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.currentTime = startSecRef.current;
    p.play();
  });

  type PlayerHandle = typeof player;

  const livePlayerRef = useRef<PlayerHandle>(player);
  livePlayerRef.current = player;

  /** Run `fn` against `target` only while it is still this component's live
   *  player, and never let a released-object throw escape. */
  const runOnPlayer = useCallback(
    (target: PlayerHandle, fn: (p: PlayerHandle) => void) => {
      if (livePlayerRef.current !== target) return;
      try {
        fn(target);
      } catch {
        // Released mid-call (unmount / source swap race) — nothing to do.
      }
    },
    [],
  );

  // When trim bounds change, seek based on which handle is being dragged
  useEffect(() => {
    runOnPlayer(player, (p) => {
      if (draggingHandle === 'end') {
        // Dragging right handle: pause and show end frame
        p.pause();
        p.currentTime = Math.max(0, endSec - 0.1);
      } else if (draggingHandle === 'start') {
        // Dragging left handle: pause and show start frame
        p.pause();
        p.currentTime = startSec;
      } else {
        // Not dragging (handle released): seek and play — unless a finger is
        // holding the video paused, which must win over the handle seek.
        p.currentTime = seekTarget === 'end'
          ? Math.max(0, endSec - 0.1)
          : startSec;
        if (!pausedRef.current) p.play();
      }
    });
  }, [startSec, endSec, player, seekTarget, draggingHandle, runOnPlayer]);

  // Press-and-hold to pause. Kept out of the seek effect above so releasing
  // resumes from where the finger landed rather than jumping to a handle.
  useEffect(() => {
    runOnPlayer(player, (p) => {
      if (paused) p.pause();
      else if (draggingHandleRef.current === 'none') p.play();
    });
  }, [paused, player, runOnPlayer]);

  // Poll the trim end boundary and LOOP. Never advances — the reel only moves
  // when the user taps a tap zone.
  useEffect(() => {
    const interval = setInterval(() => {
      // Don't interfere with playback while user is dragging a handle, or
      // while a finger is holding the video paused.
      if (draggingHandleRef.current !== 'none' || pausedRef.current) return;

      runOnPlayer(player, (p) => {
        if (p.currentTime >= endSecRef.current - 0.05) {
          p.currentTime = startSecRef.current;
          p.play();
        }
      });
    }, LOOP_POLL_MS);

    return () => clearInterval(interval);
  }, [player, runOnPlayer]);

  // Natural end of the file — loop rather than advance.
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      sub = player.addListener('playToEnd', () => {
        runOnPlayer(player, (p) => {
          p.currentTime = startSecRef.current;
          p.play();
        });
      });
    } catch {
      // Player already released — nothing to subscribe to.
    }
    return () => {
      try {
        sub?.remove();
      } catch {}
    };
  }, [player, runOnPlayer]);

  return (
    <View style={{ flex: 1 }}>
      <VideoView
        player={player}
        style={{ flex: 1 }}
        contentFit="contain"
        nativeControls={false}
      />
      {/* LIVE pose-overlay (toggle). Render-only; never baked into exports.
          The playhead getter checks liveness first and still try/catches,
          because the player can be released mid-poll on a clip change. */}
      {showPoseOverlay && (
        <PoseOverlay
          uri={uri}
          getCurrentTimeSec={() => {
            if (livePlayerRef.current !== player) return null;
            try {
              return player.currentTime;
            } catch {
              return null;
            }
          }}
        />
      )}
    </View>
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
  onNoChange,
  onBusyChange,
  onBoundsChange,
  onSeekTarget,
  onDraggingHandle,
  onHeight,
}: {
  clip: EditorClip;
  onSave: (startMs: number, endMs: number, sourceOverride?: { sourceUri: string; durationMs: number }) => void;
  /** The user let go of a handle but landed back on the committed bounds, so
   *  there is nothing to save. The parent still needs telling, to drop out of
   *  "mid-edit" — but it must not touch the clip. */
  onNoChange?: () => void;
  /** An auto-save is re-encoding. The parent holds the reel still until it
   *  lands, so a tap can't navigate away from a half-written clip. */
  onBusyChange?: (busy: boolean) => void;
  onBoundsChange: (startMs: number, endMs: number) => void;
  onSeekTarget?: (target: 'start' | 'end') => void;
  onDraggingHandle?: (handle: 'none' | 'start' | 'end') => void;
  /** Measured height, so the scorecard can sit above the panel instead of
   *  underneath it. */
  onHeight?: (h: number) => void;
}) {
  const initialBounds = getInitialTrimBounds(clip, clip.durationMs || 5000);
  const [durationMs, setDurationMs] = useState(clip.durationMs || 5000);
  const [startMs, setStartMs] = useState(initialBounds.startMs);
  const [endMs, setEndMs] = useState(initialBounds.endMs);
  const [activeUri, setActiveUri] = useState<string | null>(clip.sourceUri);
  const [savingTrim, setSavingTrim] = useState(false);

  // The bounds this clip arrived with — its auto-detected or previously saved
  // window. Revert puts the clip back to exactly this. The panel is keyed on
  // clip.id by the parent, so this is naturally per-clip.
  const originalBoundsRef = useRef({ ...initialBounds });
  // The bounds currently committed to the editor. Auto-save diffs against
  // these, so scrubbing out and back re-encodes nothing.
  const committedBoundsRef = useRef({ ...initialBounds });

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
            // The probe re-bases the whole timeline onto the original file, so
            // the revert target and the auto-save baseline move with it.
            originalBoundsRef.current = { ...bounds };
            committedBoundsRef.current = { ...bounds };
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

  // Callback + value mirrors, so the PanResponders (memoised once) and the
  // commit routine always see the latest props without being rebuilt mid-drag.
  const activeUriRef = useRef(activeUri);
  activeUriRef.current = activeUri;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onNoChangeRef = useRef(onNoChange);
  onNoChangeRef.current = onNoChange;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  /** Filled in below; declared up here so the PanResponders and the commit's
   *  own re-entrancy check can reach it. */
  const commitTrimRef = useRef<() => void>(() => {});

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
          // AUTO-SAVE: commit on release, not on every drag frame.
          commitTrimRef.current();
        },
        onPanResponderTerminate: () => {
          onDraggingHandle?.('none');
          onSeekTarget?.('start');
          commitTrimRef.current();
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
          commitTrimRef.current();
        },
        onPanResponderTerminate: () => {
          onDraggingHandle?.('none');
          onSeekTarget?.('end');
          commitTrimRef.current();
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

  // ---- AUTO-SAVE ----------------------------------------------------------
  // There is no Save button. Letting go of a handle commits, and committing
  // bounds that match what is already stored is a complete no-op: no
  // trimVideo, no file write, no editor update, no player remount.
  const commitInFlightRef = useRef(false);
  const commitPendingRef = useRef(false);

  const commitTrim = useCallback(async () => {
    // A re-encode can outlast the next drag. Queue rather than interleave.
    if (commitInFlightRef.current) {
      commitPendingRef.current = true;
      return;
    }

    const dur = durationMsRef.current;
    const nextStart = Math.max(0, startMsRef.current);
    const nextEnd = endMsRef.current;

    if (boundsEqual({ startMs: nextStart, endMs: nextEnd }, committedBoundsRef.current)) {
      // Nothing moved (or it moved and came back) — leave the video as is.
      onNoChangeRef.current?.();
      return;
    }

    commitInFlightRef.current = true;
    committedBoundsRef.current = { startMs: nextStart, endMs: nextEnd };
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

    const finalEnd = nextEnd >= dur - BOUNDS_EPSILON_MS ? -1 : nextEnd;
    const finalStart = nextStart <= BOUNDS_EPSILON_MS ? 0 : nextStart;
    const source = activeUriRef.current;

    try {
      // Editing against the original file, so a new trimmed file is needed.
      if (clip.autoTrimmed && source && source === clip.originalUri) {
        setSavingTrim(true);
        const trimEnd = finalEnd === -1 ? dur : finalEnd;
        try {
          const result = await trimVideo(source, finalStart, trimEnd);
          onSaveRef.current(finalStart, finalEnd, {
            sourceUri: result.trimmedUri,
            durationMs: trimEnd - finalStart,
          });
        } catch {
          onSaveRef.current(finalStart, finalEnd);
        }
      } else {
        onSaveRef.current(finalStart, finalEnd);
      }
    } catch {
      // Nothing here may reject: the PanResponder calls this fire-and-forget,
      // so an escaping rejection would surface as an unhandled promise.
    } finally {
      setSavingTrim(false);
      commitInFlightRef.current = false;
      if (commitPendingRef.current) {
        commitPendingRef.current = false;
        commitTrimRef.current();
      }
    }
  }, [clip.autoTrimmed, clip.originalUri]);

  commitTrimRef.current = commitTrim;

  // Keep the parent's "mid-edit" flag alive for the whole re-encode, not just
  // until the finger lifts.
  useEffect(() => {
    onBusyChangeRef.current?.(savingTrim);
  }, [savingTrim]);
  useEffect(() => () => { onBusyChangeRef.current?.(false); }, []);

  // ---- REVERT -------------------------------------------------------------
  // Puts the clip back to the bounds it had when this screen opened it — its
  // auto-detected window, or whatever was saved previously. (This replaces the
  // old "Reset", which stretched the handles to the whole file — a different,
  // and less useful, thing.)
  const atOriginalBounds = boundsEqual(
    { startMs, endMs: effectiveEndMs },
    originalBoundsRef.current,
  );

  const handleRevert = useCallback(() => {
    const target = originalBoundsRef.current;
    // Write the mirrors too: commitTrim reads refs, and those are only synced
    // during render, which has not happened yet at this point.
    startMsRef.current = target.startMs;
    endMsRef.current = target.endMs;
    setStartMs(target.startMs);
    setEndMs(target.endMs);
    commitTrimRef.current();
  }, []);

  return (
    <View
      onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
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

      {/* Buttons — trims save themselves when a handle is released, so there
          is no Save/tick. The only action left is putting the clip back the
          way it was found. */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 12, minHeight: 34 }}>
        <Pressable
          onPress={handleRevert}
          disabled={savingTrim || atOriginalBounds}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 6,
            paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
            backgroundColor: 'rgba(255,255,255,0.12)',
            opacity: savingTrim || atOriginalBounds ? 0.4 : 1,
          }}
        >
          <RotateCcw size={14} color="rgba(255,255,255,0.7)" />
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' }}>Revert</Text>
        </Pressable>

        {savingTrim && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' }}>
              Saving
            </Text>
          </View>
        )}
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

  // Trim state.
  //
  // The panel is DOCKED — always on screen, no scissors button to press first.
  // `trimMode` therefore no longer means "the trim UI is up" (it always is); it
  // means "the user is mid-edit", which is what has to hold the reel still
  // while a handle is moving or an auto-save is encoding.
  const [trimDirty, setTrimDirty] = useState(false);
  // An auto-save is re-encoding in the trim panel.
  const [trimBusy, setTrimBusy] = useState(false);
  const [trimPanelHeight, setTrimPanelHeight] = useState(0);
  // A finger held on the video pauses playback until it lifts.
  const [isHeld, setIsHeld] = useState(false);
  // Live trim bounds from the trim panel (drives the video player in real time)
  const [liveTrimStart, setLiveTrimStart] = useState(0);
  const [liveTrimEnd, setLiveTrimEnd] = useState(-1);
  // Player remount key — bump this after saving trim so the player re-initializes
  const [playerGeneration, setPlayerGeneration] = useState(0);
  // Track which handle was last released for seek direction
  const [seekTarget, setSeekTarget] = useState<'start' | 'end'>('start');
  // Track which handle is actively being dragged (for live frame seeking)
  const [draggingHandle, setDraggingHandle] = useState<'none' | 'start' | 'end'>('none');
  const draggingHandleRef = useRef(draggingHandle);
  draggingHandleRef.current = draggingHandle;
  // URI to use in trim mode (original for auto-trimmed clips)
  const [trimModeUri, setTrimModeUri] = useState<string | null>(null);

  // "The user is mid-edit." Dragging a handle, or having moved one whose
  // auto-save has not landed yet. While true the tap zones are withdrawn, so a
  // stray tap can't navigate away from an edit that is still encoding, and the
  // player runs off the ORIGINAL file over the live handle positions.
  const trimMode = trimDirty || trimBusy || draggingHandle !== 'none';

  // Music state
  const [musicEnabled, setMusicEnabled] = useState(false);
  const soundRef = useRef<any>(null);

  // LIVE pose-overlay toggle (analytical replay). Off by default → byte-identical
  // playback. When on, draws the detected skeleton over the clip while it plays.
  const [showPoseOverlay, setShowPoseOverlay] = useState(false);

  // Reload editor state on focus to pick up trim changes from other screens
  useFocusEffect(
    useCallback(() => {
      editor.reload();
    }, [editor.reload])
  );

  const allClips = editor.getAllClipsInOrder();

  // Clamp on read. `currentIndex` can briefly sit past the end — clips can be
  // excluded from under us by a reload, and rapid taps used to overshoot via
  // stale closures. Rendering `undefined` blanked the whole screen, which read
  // as a crash; clamping keeps a clip on screen and the effect below pulls the
  // state back in line.
  const safeIndex = allClips.length > 0
    ? Math.min(Math.max(currentIndex, 0), allClips.length - 1)
    : 0;
  const currentClip = allClips[safeIndex];

  const clipCountRef = useRef(allClips.length);
  clipCountRef.current = allClips.length;

  useEffect(() => {
    if (allClips.length > 0 && currentIndex !== safeIndex) {
      setCurrentIndex(safeIndex);
    }
  }, [currentIndex, safeIndex, allClips.length]);

  // Initialise live bounds and URI for the CURRENT CLIP. This used to fire on
  // entering trim mode; with the panel docked there is no such moment, so it
  // now runs per clip — otherwise clip 2 onwards would inherit clip 1's bounds.
  useEffect(() => {
    if (!currentClip) {
      setTrimModeUri(null);
      return;
    }
    // Default trim bounds to the detected swing window when the user
    // hasn't customized — InlineTrimPanel re-runs the same calculation
    // against the actual probed duration once it loads.
    const initialBounds = getInitialTrimBounds(currentClip, currentClip.durationMs);
    setLiveTrimStart(initialBounds.startMs);
    setLiveTrimEnd(initialBounds.endMs);
    // Show the ORIGINAL video for auto-trimmed clips so the handles have
    // something to move over — a pre-trimmed file has nothing left to cut.
    if (currentClip.autoTrimmed && currentClip.originalUri && currentClip.originalUri !== currentClip.sourceUri) {
      setTrimModeUri(currentClip.originalUri);
    } else {
      setTrimModeUri(currentClip.sourceUri);
    }
    setSeekTarget('start');
    setTrimDirty(false);
    lastBoundsAppliedRef.current = null;
  }, [currentClip?.id]);

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

  // NO AUTO-ADVANCE, anywhere. Clips loop until the user taps. (The web
  // fallback used to run a 3s timer here; it advanced the reel by itself, so
  // it is gone too — web shows the placeholder and waits like native does.)

  /** Swallow taps that arrive inside the previous tap's remount window. Each
   *  accepted tap changes the player's key, which tears one expo-video player
   *  down and stands another up; a burst stacks live native players because
   *  React does not run the old one's cleanup until the next passive-effect
   *  flush. */
  const tapLockUntilRef = useRef(0);
  const claimTap = useCallback(() => {
    const now = Date.now();
    if (now < tapLockUntilRef.current) return false;
    tapLockUntilRef.current = now + TAP_DEBOUNCE_MS;
    return true;
  }, []);

  // Both handlers clamp INSIDE the updater. The old code tested the captured
  // `currentIndex` and then applied `i => i + 1`, so two taps batched into one
  // render both passed a guard computed from the same stale index and the
  // reel stepped twice — straight past the end of the array.
  const handleTapLeft = useCallback(() => {
    if (trimMode) return;
    if (!claimTap()) return;
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, [trimMode, claimTap]);

  const handleTapRight = useCallback(() => {
    if (trimMode) return;
    if (!claimTap()) return;
    // The last clip holds. Tapping past the end used to call router.back(),
    // which meant a stray tap dropped you out of the reel — and a burst of
    // taps called it repeatedly. Leaving is the X button's job now.
    setCurrentIndex((i) => Math.min(i + 1, Math.max(0, clipCountRef.current - 1)));
  }, [trimMode, claimTap]);

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
    // First real movement marks the clip dirty, which is what holds the reel
    // here. Two reports must NOT count: `last === null` is the panel announcing
    // its initial bounds on mount, and a report with no handle down is the
    // panel moving the handles itself (Revert) — that one commits immediately,
    // so marking it dirty would leave the screen stuck mid-edit forever.
    if (last && draggingHandleRef.current !== 'none') setTrimDirty(true);
  }, []);

  const handleSeekTarget = useCallback((target: 'start' | 'end') => {
    setSeekTarget(target);
  }, []);

  const handleTrimSave = useCallback(
    (startMs: number, endMs: number, sourceOverride?: { sourceUri: string; durationMs: number }) => {
      if (!currentClip) return;

      // Second line of defence for "never re-encode when nothing changed": the
      // panel already refuses to run trimVideo for an unchanged window, and
      // this refuses to write state or remount the player for one. A remount
      // is not free — it disposes and rebuilds a native AVPlayer.
      const committedStart = currentClip.trimStartMs ?? 0;
      const committedEnd = currentClip.trimEndMs ?? -1;
      const unchanged =
        !sourceOverride &&
        Math.abs(startMs - committedStart) <= BOUNDS_EPSILON_MS &&
        (endMs === committedEnd ||
          (endMs !== -1 &&
            committedEnd !== -1 &&
            Math.abs(endMs - committedEnd) <= BOUNDS_EPSILON_MS));

      if (unchanged) {
        setTrimDirty(false);
        return;
      }

      editor.updateTrim(currentClip.id, startMs, endMs, sourceOverride);
      // The panel stays docked; the save just commits and releases the reel.
      setTrimDirty(false);
      // Bump the generation so the player remounts with the new trim bounds
      setPlayerGeneration((g) => g + 1);
    },
    [currentClip, editor]
  );

  /** The panel released a handle back onto the bounds it already had. Drop out
   *  of "mid-edit" and touch absolutely nothing else — no editor write, no
   *  remount. */
  const handleTrimNoChange = useCallback(() => {
    setTrimDirty(false);
  }, []);

  // Press-and-hold anywhere on the video to pause; lifting resumes.
  const handleHoldStart = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsHeld(true);
  }, []);
  const handleHoldEnd = useCallback(() => setIsHeld(false), []);

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
          seekTarget={seekTarget}
          draggingHandle={draggingHandle}
          showPoseOverlay={showPoseOverlay && !trimMode}
          paused={isHeld}
        />
      ) : currentClip ? (
        <WebClipPlaceholder clip={currentClip} />
      ) : null}

      {/* Tap zones: tap to move between clips, hold anywhere to pause. Only
          suppressed mid-edit, so that adjusting a handle cannot navigate the
          unsaved edit away. Bounded above the docked panel so a drag on the
          timeline is never stolen by the tap zone. */}
      {!trimMode && (
        <View
          style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            bottom: trimPanelHeight,
            flexDirection: 'row',
          }}
          pointerEvents="box-none"
        >
          <Pressable
            onPress={handleTapLeft}
            onLongPress={handleHoldStart}
            onPressOut={handleHoldEnd}
            delayLongPress={250}
            style={{ flex: 1 }}
          />
          <Pressable
            onPress={handleTapRight}
            onLongPress={handleHoldStart}
            onPressOut={handleHoldEnd}
            delayLongPress={250}
            style={{ flex: 1 }}
          />
        </View>
      )}

      {/* Paused affordance — without it a held finger just looks like a freeze. */}
      {isHeld && (
        <View
          style={{
            position: 'absolute', top: insets.top + 64, alignSelf: 'center',
            flexDirection: 'row', alignItems: 'center', gap: 6,
            paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
            backgroundColor: 'rgba(0,0,0,0.65)',
          }}
          pointerEvents="none"
        >
          <Pause size={14} color="#fff" />
          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>Paused</Text>
        </View>
      )}

      {/* Scorecard overlay — stays up while trimming now that the panel is
          docked, lifted clear of it by the panel's measured height. */}
      {currentClip && (
        <ScorecardOverlay
          clip={currentClip}
          clipIndex={safeIndex}
          allClips={allClips}
          holes={editor.state.holes}
          courseName={editor.state.courseName}
          bottomOffset={trimPanelHeight}
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
        <ProgressDots total={allClips.length} current={safeIndex} />

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
                  {safeIndex + 1} of {allClips.length}
                </Text>
              </>
            )}
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {/* Pose-overlay toggle (analytical replay). Native only; hidden in
                trim mode where the skeleton would distract from handle drags. */}
            {isNative && (
              <Pressable
                onPress={() => setShowPoseOverlay((v) => !v)}
                hitSlop={10}
                style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: showPoseOverlay ? theme.colors.primary + '40' : 'rgba(0,0,0,0.5)',
                  justifyContent: 'center', alignItems: 'center',
                }}
              >
                <PersonStanding size={18} color={showPoseOverlay ? theme.colors.primary : 'rgba(255,255,255,0.7)'} />
              </Pressable>
            )}

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

            {/* The scissors button is gone — the trim panel is docked at the
                bottom, so there is nothing left to open. */}

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

      {/* Trim panel — DOCKED. Keyed on the clip so the handles reset to the
          new clip's bounds instead of carrying the previous clip's over. */}
      {currentClip && (
        <InlineTrimPanel
          key={currentClip.id}
          clip={currentClip}
          onSave={handleTrimSave}
          onNoChange={handleTrimNoChange}
          onBusyChange={setTrimBusy}
          onBoundsChange={handleTrimBoundsChange}
          onSeekTarget={handleSeekTarget}
          onDraggingHandle={setDraggingHandle}
          onHeight={setTrimPanelHeight}
        />
      )}
    </View>
  );
}
