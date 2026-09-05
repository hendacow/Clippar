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
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check, RotateCcw, Music, VolumeX, PersonStanding, Pause, Scissors } from 'lucide-react-native';
import { ClipTrimModal } from '@/components/editor/ClipTrimModal';
import { TEMPLATE_PALETTE } from '@/components/editor/ScorecardTemplates';
import type { ScorecardTemplate } from '@/modules/shot-detector';
import { PoseOverlay } from '@/components/editor/PoseOverlay';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { useEditorState } from '@/hooks/useEditorState';
import { trimVideo } from 'shot-detector';
import { type EditorClip, type EditorHoleSection, getInitialTrimBounds } from '@/types/editor';
import {
  getScoreColor,
  formatDiff,
  holeResultLabel,
  isHoleComplete,
  completedTotals,
} from '@/lib/scoreDisplay';

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
const HANDLE_WIDTH = 40; // touch target; the bar inside is 14 wide (thumb-proof, 4 Sep)
const MIN_TRIM_MS = 500;
const THUMB_COUNT = 12;
// How long a clip must stay on screen before its filmstrip starts decoding.
// Swiping through a round should cost nothing; only a clip you stop on earns
// twelve video decodes. See the filmstrip effect for why this exists.
const FILMSTRIP_SETTLE_MS = 350;
const THUMB_WIDTH = Math.floor(TIMELINE_WIDTH / THUMB_COUNT);

// ============================================================
// SCORECARD CARD — docked at the TOP, looks like a real scorecard
// ============================================================
// Shows: course name, TOTAL over completed holes, hole grid, current
// hole + shot chip. A hole shows NO score indication until it has
// actually been finished — "finished" means a score row exists for it
// (EditorHoleSection.hasScore, written when the hole is ended), never
// the playback position. Completed holes are colour-coded by result vs
// par with the same colours as components/round/Scorecard.tsx.

// How many hole cells fit across the card before the grid scrolls.
const GRID_VISIBLE_HOLES = 9;
// Card grid width: screen minus top-overlay padding (8+8) and the grid's
// own horizontal padding (8+8).
const GRID_CELL_WIDTH = Math.floor((SCREEN_WIDTH - 32) / GRID_VISIBLE_HOLES);

function HoleCell({
  hole,
  isCurrent,
  width,
  skin,
}: {
  hole: EditorHoleSection;
  isCurrent: boolean;
  width?: number;
  skin?: { text: string; dim: string; accent: string; under: string; over: string; line: string; markers: boolean; serif: boolean } | null;
}) {
  const complete = isHoleComplete(hole);
  const diff = hole.strokes - hole.par;
  const cellColor = skin
    ? (complete ? (diff < 0 ? skin.under : diff > 0 ? skin.over : skin.text) : skin.dim)
    : complete
      ? getScoreColor(diff)
      : 'rgba(255,255,255,0.25)';
  // Tour-style markers: a circle for under par, a square for over par.
  const marker = skin?.markers && complete && diff !== 0
    ? { borderWidth: 1.5, borderColor: cellColor, borderRadius: diff < 0 ? 10 : 3, width: 20, height: 20, justifyContent: 'center' as const, alignItems: 'center' as const }
    : null;

  return (
    <View
      style={{
        ...(width ? { width } : { flex: 1 }),
        alignItems: 'center',
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: isCurrent ? (skin ? skin.line : 'rgba(255,255,255,0.1)') : 'transparent',
        borderBottomWidth: isCurrent && skin ? 2 : 0,
        borderBottomColor: skin?.accent,
      }}
    >
      <Text
        style={{
          color: skin ? (isCurrent ? skin.text : skin.dim) : isCurrent ? '#fff' : 'rgba(255,255,255,0.4)',
          fontSize: 10,
          fontWeight: '600',
        }}
      >
        {hole.holeNumber}
      </Text>
      <View style={[{ marginTop: 1, height: 20, justifyContent: 'center', alignItems: 'center' }, marker]}>
        <Text
          style={{
            color: cellColor,
            fontSize: 13,
            fontWeight: '800',
            fontFamily: skin?.serif ? 'Georgia-Bold' : undefined,
          }}
        >
          {complete ? hole.strokes : '-'}
        </Text>
      </View>
      <Text
        style={{
          color: skin ? skin.dim : 'rgba(255,255,255,0.25)',
          fontSize: 9,
        }}
      >
        {hole.par}
      </Text>
    </View>
  );
}

function ScorecardOverlay({
  clip,
  holes,
  courseName,
  template = 'classic',
  playerName = '',
}: {
  clip: EditorClip;
  holes: EditorHoleSection[];
  courseName: string;
  template?: ScorecardTemplate;
  playerName?: string;
}) {
  const currentHole = holes.find((h) => h.holeNumber === clip.holeNumber);
  if (!currentHole) return null;

  // 5 Sep: the chosen design. 'minimal' is words only; the three tour
  // looks re-skin the same card; classic is unchanged below.
  if (template === 'minimal') {
    const done = isHoleComplete(currentHole);
    const diff = currentHole.strokes - currentHole.par;
    return (
      <View style={{ marginTop: 14, alignItems: 'center' }} pointerEvents="none">
        <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11, letterSpacing: 2, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 }}>
          {(courseName || 'ROUND').toUpperCase()}
        </Text>
        <Text style={{ color: '#fff', fontSize: 22, fontFamily: 'Georgia-Bold', letterSpacing: 1.5, marginTop: 4, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 8 }}>
          HOLE {currentHole.holeNumber} · PAR {currentHole.par}
        </Text>
        {done && (
          <Text style={{ color: getScoreColor(diff), fontSize: 28, fontFamily: 'Georgia-Bold', marginTop: 2, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 8 }}>
            {holeResultLabel(diff)}
          </Text>
        )}
      </View>
    );
  }
  const skin =
    template === 'euro' ? { ...TEMPLATE_PALETTE.euro, header: undefined as string | undefined, cream: undefined as string | undefined, under: TEMPLATE_PALETTE.euro.accent, over: TEMPLATE_PALETTE.euro.accent, markers: true, serif: false }
    : template === 'pga' ? { ...TEMPLATE_PALETTE.pga, header: undefined as string | undefined, cream: undefined as string | undefined, markers: true, serif: false }
    : template === 'masters' ? { ...TEMPLATE_PALETTE.masters, markers: false, serif: true }
    : null;

  const holeClips = currentHole.clips.filter((c) => !c.isExcluded);
  const shotIndex = holeClips.findIndex((c) => c.id === clip.id);
  const totalShots = holeClips.length;

  // TOTAL reflects only holes with a real score row. Mid-round, unfinished
  // holes contribute nothing; before any hole is finished it shows "-".
  const totals = completedTotals(holes);
  const totalColor = totals ? getScoreColor(totals.diff) : '#FFFFFF';

  // Current hole's result chip — only once the hole is actually finished.
  const currentHoleComplete = isHoleComplete(currentHole);
  const holeDiff = currentHole.strokes - currentHole.par;
  const holeColor = getScoreColor(holeDiff);

  // Up to 9 holes fit across the card; longer rounds scroll horizontally.
  const scrollable = holes.length > GRID_VISIBLE_HOLES;

  return (
    // pointerEvents: the card is normally tap-transparent so the left/right
    // clip-navigation tap zones keep working underneath it. When the grid
    // must scroll (18-hole rounds) it needs to own horizontal drags, so
    // touches over the card are kept.
    <View style={{ marginTop: 10 }} pointerEvents={scrollable ? 'auto' : 'none'}>
      {/* Main scorecard container */}
      <View
        style={{
          backgroundColor: skin ? skin.card : 'rgba(0,0,0,0.75)',
          borderRadius: 16,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: skin ? skin.line : 'rgba(255,255,255,0.1)',
        }}
      >
        {skin?.header && (
          <View style={{ backgroundColor: skin.header, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: skin.cream, fontSize: 14, fontFamily: 'Georgia-Bold' }} numberOfLines={1}>{playerName || 'Player'}</Text>
            <Text style={{ color: skin.cream, fontSize: 11, fontFamily: 'Georgia' }} numberOfLines={1}>{courseName || 'Round'}</Text>
          </View>
        )}
        {skin && !skin.header && !!playerName && (
          <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
            <Text style={{ color: skin.accent, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }} numberOfLines={1}>{playerName.toUpperCase()}</Text>
          </View>
        )}
        {/* Top row: course name + total over completed holes */}
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
            style={{ color: skin ? skin.dim : 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' }}
            numberOfLines={1}
          >
            {skin?.header ? 'SCORECARD' : courseName || 'Round'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: skin ? skin.dim : 'rgba(255,255,255,0.5)', fontSize: 11 }}>
              TOTAL
            </Text>
            <Text style={{ color: skin ? skin.text : totalColor, fontWeight: '800', fontSize: 14 }}>
              {totals ? totals.strokes : '-'}
            </Text>
            {totals && (
              <View
                style={{
                  backgroundColor: totalColor + '25',
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: 4,
                }}
              >
                <Text style={{ color: totalColor, fontWeight: '800', fontSize: 11 }}>
                  {formatDiff(totals.diff)}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Divider */}
        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginHorizontal: 12 }} />

        {/* Hole mini-grid — completed holes show their colour-coded score */}
        {scrollable ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 8,
              paddingTop: 8,
              paddingBottom: 4,
            }}
          >
            {holes.map((h) => (
              <HoleCell
                key={h.holeNumber}
                hole={h}
                isCurrent={h.holeNumber === clip.holeNumber}
                width={GRID_CELL_WIDTH}
                skin={skin}
              />
            ))}
          </ScrollView>
        ) : (
          <View
            style={{
              flexDirection: 'row',
              paddingHorizontal: 8,
              paddingTop: 8,
              paddingBottom: 4,
            }}
          >
            {holes.map((h) => (
              <HoleCell
                key={h.holeNumber}
                hole={h}
                isCurrent={h.holeNumber === clip.holeNumber}
                skin={skin}
              />
            ))}
          </View>
        )}

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
            <Text style={{ color: skin ? skin.text : '#fff', fontWeight: '800', fontSize: 16, fontFamily: skin?.serif ? 'Georgia-Bold' : undefined }}>
              Hole {currentHole.holeNumber}
            </Text>
            <Text style={{ color: skin ? skin.dim : 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '500' }}>
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
                Shot {shotIndex + 1} of {totalShots}
              </Text>
            </View>

            {/* Hole result — only once the hole is finished */}
            {currentHoleComplete && (
              <View
                style={{
                  backgroundColor: holeColor + '25',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                }}
              >
                <Text style={{ color: holeColor, fontWeight: '800', fontSize: 12 }}>
                  {holeResultLabel(holeDiff)}
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </View>
  );
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
  showPoseOverlay = false,
  paused = false,
}: {
  uri: string;
  trimStartMs: number;
  trimEndMs: number; // -1 = full
  durationMs: number;
  isTrimming: boolean;
  onEnd: () => void;
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
  const isTrimmingRef = useRef(isTrimming);
  const draggingHandleRef = useRef(draggingHandle);
  const pausedRef = useRef(paused);
  startSecRef.current = startSec;
  endSecRef.current = endSec;
  isTrimmingRef.current = isTrimming;
  draggingHandleRef.current = draggingHandle;
  pausedRef.current = paused;

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
      // Not dragging (handle released): seek and play — unless a finger is
      // holding the video paused, which must win over the handle seek.
      player.currentTime = seekTarget === 'end'
        ? Math.max(0, endSec - 0.1)
        : startSec;
      if (!pausedRef.current) player.play();
    }
  }, [startSec, endSec, player, seekTarget, draggingHandle]);

  // Press-and-hold to pause. Kept out of the seek effect above so releasing
  // resumes from where the finger landed rather than jumping to a handle.
  useEffect(() => {
    if (paused) player.pause();
    else if (draggingHandleRef.current === 'none') player.play();
  }, [paused, player]);

  // Poll to enforce trim end boundary + loop in trim mode
  useEffect(() => {
    const interval = setInterval(() => {
      // Don't interfere with playback while user is dragging a handle, or
      // while a finger is holding the video paused.
      if (draggingHandleRef.current !== 'none' || pausedRef.current) return;

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
    <View style={{ flex: 1 }}>
      <VideoView
        player={player}
        style={{ flex: 1 }}
        contentFit="contain"
        nativeControls={false}
      />
      {/* LIVE pose-overlay (toggle). Render-only; never baked into exports.
          getCurrentTimeSec is wrapped in try/catch because the expo-video
          player can be disposed mid-poll during a clip change / seek. */}
      {showPoseOverlay && (
        <PoseOverlay
          uri={uri}
          getCurrentTimeSec={() => {
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
// INLINE TRIM PANEL — permanently docked at the bottom
// ============================================================
function InlineTrimPanel({
  clip,
  dirty,
  onSave,
  onBoundsChange,
  onSeekTarget,
  onDraggingHandle,
  onHeight,
}: {
  clip: EditorClip;
  /** The user has grabbed a handle and not saved yet. Gates the Reset/Save
   *  row — a docked panel showing action buttons at rest would imply there
   *  is something to act on. */
  dirty: boolean;
  onSave: (startMs: number, endMs: number, sourceOverride?: { sourceUri: string; durationMs: number }) => void;
  onBoundsChange: (startMs: number, endMs: number) => void;
  onSeekTarget?: (target: 'start' | 'end') => void;
  onDraggingHandle?: (handle: 'none' | 'start' | 'end') => void;
  /** Measured height, so the tap zones can stop above the docked panel. */
  onHeight?: (h: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const initialBounds = getInitialTrimBounds(clip, clip.durationMs || 5000);
  const [durationMs, setDurationMs] = useState(clip.durationMs || 5000);
  const [startMs, setStartMs] = useState(initialBounds.startMs);
  const [endMs, setEndMs] = useState(initialBounds.endMs);
  const [activeUri, setActiveUri] = useState<string | null>(clip.sourceUri);
  const [savingTrim, setSavingTrim] = useState(false);

  // Whether we have a REAL duration to lay the timeline over. Supabase-loaded
  // clips arrive with durationMs 0 (useEditorState's loadFromSupabase never
  // probes); with the panel docked on every clip, laying handles over a fake
  // 5s timeline would let the user create a zero-length trim that loops at
  // frame 0. Until a real duration exists the bar renders without handles and
  // Save stays disabled.
  const [durationKnown, setDurationKnown] = useState((clip.durationMs ?? 0) > 0);

  // Auto-probe a real duration. Two cases share the one probe:
  //   - auto-trimmed clips probe the ORIGINAL file so the timeline covers the
  //     full recording, not just the pre-trimmed slice;
  //   - clips that arrived without a duration (Supabase-loaded rows carry
  //     durationMs 0) probe their own source so the handles get a real
  //     timeline at all.
  // Dep must be `clip.id` (stable primitive), NOT the `clip` object — the
  // parent re-renders whenever the live trim bounds update, and each render
  // creates a fresh `currentClip` reference. Depending on `clip` refired this
  // effect on every parent tick, which called setStartMs(clip.trimStartMs)
  // mid-drag — reverting the user's drag and triggering the bounds-change
  // effect below, which pushed new bounds back to the parent, which
  // re-rendered, repeating until React threw "Maximum update depth exceeded."
  useEffect(() => {
    const isOriginalProbe =
      !!(clip.autoTrimmed && clip.originalUri && clip.originalUri !== clip.sourceUri);
    const missingDuration = !clip.durationMs || clip.durationMs <= 0;
    const probeUri = isOriginalProbe
      ? clip.originalUri!
      : missingDuration
        ? clip.sourceUri
        : null;
    if (!probeUri || !ExpoAV) return;
    let cancelled = false;
    (async () => {
      try {
        const { sound, status } = await ExpoAV!.Audio.Sound.createAsync(
          { uri: probeUri }, {}, undefined, false,
        );
        const dur = status.isLoaded && status.durationMillis ? status.durationMillis : null;
        await sound.unloadAsync();
        if (cancelled || !dur) return;
        setDurationMs(dur);
        setDurationKnown(true);
        if (isOriginalProbe) setActiveUri(clip.originalUri!);
        // Default to detected swing window when user hasn't customized;
        // user can drag handles outward to include more of the original.
        const bounds = getInitialTrimBounds(clip, dur);
        setStartMs(bounds.startMs);
        setEndMs(bounds.endMs);
      } catch {}
    })();
    return () => { cancelled = true; };
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
    // No thumbnails until the duration is real — with a fake timeline the
    // frames would be sampled at meaningless timestamps.
    if (!videoUri || !isNative || !VideoThumbnails || !durationKnown) {
      setFilmstripThumbs([]);
      return;
    }
    let cancelled = false;

    // SEQUENTIAL, AND ONLY AFTER THE CLIP SETTLES. Both matter, and both are
    // consequences of docking the panel permanently (2fc88b0).
    //
    // This used to fire 12 getThumbnailAsync calls through Promise.all. That
    // was fine when the filmstrip existed only inside trim mode: the user
    // entered it deliberately, on one clip, and stayed. Now the effect re-runs
    // on EVERY clip they swipe past — and `cancelled` cannot stop a decode
    // already in flight, it only suppresses the result. Swiping through ten
    // clips could leave ~120 AVAssetImageGenerators decoding video at once,
    // which iOS answers by killing the app: no JS error, no red box, straight
    // to the home screen. That is the crash Henry hit on a 36-clip round.
    //
    // Sequential caps live decoders at one and makes the cancel flag actually
    // effective — it is checked between frames, so a swipe abandons the strip
    // after at most one more frame instead of after twelve.
    const generateThumbs = async () => {
      const thumbs: (string | null)[] = new Array(THUMB_COUNT).fill(null);
      const interval = durationMs / THUMB_COUNT;
      for (let i = 0; i < THUMB_COUNT; i += 1) {
        if (cancelled) return;
        try {
          const time = Math.round(i * interval + interval / 2);
          const result = await VideoThumbnails!.getThumbnailAsync(videoUri, {
            time,
            quality: 0.3,
          });
          if (cancelled) return;
          thumbs[i] = result.uri;
          // Paint as they arrive so the strip fills in rather than appearing
          // all at once at the end — sequential is slower per strip, and this
          // keeps it from reading as a stall.
          setFilmstripThumbs([...thumbs]);
        } catch {}
      }
    };

    // Fast swiping should generate nothing at all. A clip must hold still
    // before its filmstrip is worth decoding.
    const settleTimer = setTimeout(generateThumbs, FILMSTRIP_SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(settleTimer);
    };
  }, [activeUri, clip.sourceUri, durationMs, durationKnown]);

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
      onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: 'rgba(0,0,0,0.92)',
        paddingTop: 12,
        // Clear the home indicator so the Reset/Save row stays fully
        // visible and tappable at the true bottom of the screen.
        paddingBottom: Math.max(32, insets.bottom + 20),
      }}
    >
      {/* Duration info */}
      <View style={{ alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>
          {durationKnown ? formatMsFull(trimmedDuration) : '—'}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
          {durationKnown
            ? `${formatMs(startMs)} — ${formatMs(effectiveEndMs)}`
            : 'Loading clip…'}
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

          {/* Selected region + handles — only over a REAL timeline. Without a
              probed duration a drag would write bounds against a fake 5s
              timeline (worst case a zero-length trim looping at frame 0). */}
          {durationKnown && (
            <>
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
                  top: -10, width: HANDLE_WIDTH, height: 64,
                  justifyContent: 'center', alignItems: 'center', zIndex: 10,
                }}
              >
                <View
                  style={{ width: 14, height: 40, borderRadius: 5, backgroundColor: theme.colors.primary, borderWidth: 2, borderColor: '#000' }}
                />
              </View>

              {/* End handle */}
              <View
                {...endPanResponder.panHandlers}
                style={{
                  position: 'absolute', left: msToX(effectiveEndMs) - HANDLE_WIDTH / 2,
                  top: -10, width: HANDLE_WIDTH, height: 64,
                  justifyContent: 'center', alignItems: 'center', zIndex: 10,
                }}
              >
                <View
                  style={{ width: 14, height: 40, borderRadius: 5, backgroundColor: theme.colors.primary, borderWidth: 2, borderColor: '#000' }}
                />
              </View>
            </>
          )}
        </View>
      </View>

      {/* Buttons — only while there is an unsaved edit. The old Cancel
          button closed the panel; the docked panel has nothing to close and
          Reset already covers "undo my edit". */}
      {dirty && (
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
            onPress={handleSave}
            disabled={savingTrim || !durationKnown}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
              backgroundColor: theme.colors.primary,
              opacity: savingTrim || !durationKnown ? 0.5 : 1,
            }}
          >
            <Check size={14} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
              {savingTrim ? 'Saving...' : 'Save'}
            </Text>
          </Pressable>
        </View>
      )}
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

  // Trim state.
  //
  // The panel is DOCKED — always on screen, no scissors button to press first.
  // `trimMode` therefore no longer means "the trim UI is up" (it always is); it
  // means "the user is mid-edit", which is what has to suppress auto-advance
  // and clip navigation. Without that split, docking the panel would have
  // frozen the reel on its first clip, since every one of those behaviours was
  // gated on `!trimMode`.
  const [trimDirty, setTrimDirty] = useState(false);
  // Measured height of the docked panel, so tap zones stop above it.
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
  // URI shown while editing (original for auto-trimmed clips)
  const [trimModeUri, setTrimModeUri] = useState<string | null>(null);
  // The full trimmer (thick handles, hold-to-zoom, swipe between shots) —
  // one tap from the preview (Henry, 4 Sep: "give preview the better UI").
  const [fullTrimOpen, setFullTrimOpen] = useState(false);
  const [scorecardTemplate, setScorecardTemplate] = useState<ScorecardTemplate>('classic');
  const [playerName, setPlayerName] = useState('');
  useEffect(() => {
    if (!roundId) return;
    (async () => {
      try {
        const storage = require('@/lib/storage') as typeof import('@/lib/storage');
        const r = await storage.getLocalRound(roundId);
        const t = r?.scorecard_template as ScorecardTemplate | null | undefined;
        if (t) setScorecardTemplate(t);
      } catch {}
      try {
        const { supabase } = require('@/lib/supabase') as typeof import('@/lib/supabase');
        const { data } = await supabase.auth.getSession();
        const u = data.session?.user;
        setPlayerName((u?.user_metadata?.full_name as string | undefined) || u?.email?.split('@')[0] || '');
      } catch {}
    })();
  }, [roundId]);
  // Ref-guard for bounds reports — declared up here because the per-clip
  // init effect below must reset it when the clip changes.
  const lastBoundsAppliedRef = useRef<{ startMs: number; endMs: number } | null>(null);

  // "The user is mid-edit." Dragging a handle, or having moved one without
  // saving yet. While true the reel holds on this clip — it would be hostile
  // to advance out from under someone adjusting the handles — and the player
  // loops the trimmed range so the edit can be seen. Leaving the screen
  // entirely (the X) discards an unsaved edit silently: live bounds are never
  // persisted until Save.
  const trimMode = trimDirty || draggingHandle !== 'none';

  // Music state
  const [musicEnabled, setMusicEnabled] = useState(false);
  const soundRef = useRef<any>(null);

  // LIVE pose-overlay toggle (analytical replay). Off by default → byte-identical
  // playback. When on, draws the detected skeleton over the clip while it plays.
  const [showPoseOverlay, setShowPoseOverlay] = useState(false);

  // Reload editor state on RE-focus to pick up trim changes from other
  // screens. The first focus is skipped: it coincides with mount, where
  // useEditorState's own effect is already loading — running both meant the
  // entire load waterfall (round + scores + a signed URL per clip) executed
  // twice, concurrently, before first playback.
  const hasFocusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!hasFocusedRef.current) {
        hasFocusedRef.current = true;
        return;
      }
      editor.reload();
    }, [editor.reload])
  );

  const allClips = editor.getAllClipsInOrder();
  const currentClip = allClips[currentIndex];

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
    // Show the ORIGINAL video while editing auto-trimmed clips so the handles
    // have something to move over — a pre-trimmed file has nothing left to cut.
    if (currentClip.autoTrimmed && currentClip.originalUri && currentClip.originalUri !== currentClip.sourceUri) {
      setTrimModeUri(currentClip.originalUri);
    } else {
      setTrimModeUri(currentClip.sourceUri);
    }
    setSeekTarget('start');
    setTrimDirty(false);
    lastBoundsAppliedRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  //
  // Deliberately does NOT mark the clip dirty: bounds also change
  // programmatically (the panel's duration probe re-laying the timeline),
  // and a probe must never freeze the reel. Dirty is set only when a
  // handle is actually grabbed — see handleDraggingHandle.
  const handleTrimBoundsChange = useCallback((startMs: number, endMs: number) => {
    const last = lastBoundsAppliedRef.current;
    if (last && last.startMs === startMs && last.endMs === endMs) return;
    lastBoundsAppliedRef.current = { startMs, endMs };
    setLiveTrimStart(startMs);
    setLiveTrimEnd(endMs);
  }, []);

  // Grabbing a handle IS the edit intent — the moment one is touched the
  // clip is dirty, the reel holds here, and the Reset/Save row appears
  // until the edit is saved.
  const handleDraggingHandle = useCallback((handle: 'none' | 'start' | 'end') => {
    setDraggingHandle(handle);
    if (handle !== 'none') setTrimDirty(true);
  }, []);

  const handleSeekTarget = useCallback((target: 'start' | 'end') => {
    setSeekTarget(target);
  }, []);

  const handleTrimSave = useCallback(
    (startMs: number, endMs: number, sourceOverride?: { sourceUri: string; durationMs: number }) => {
      if (currentClip) {
        editor.updateTrim(currentClip.id, startMs, endMs, sourceOverride);
      }
      // The panel stays docked; saving just commits the edit and releases the
      // reel to carry on playing.
      setTrimDirty(false);
      // Bump the generation so the player remounts with the new trim bounds
      setPlayerGeneration((g) => g + 1);
    },
    [currentClip, editor]
  );

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
          isTrimming={trimMode}
          onEnd={handleVideoEnd}
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

      {/* Paused affordance — without it a held finger just looks like a
          freeze. Centered over the video, clear of the top card and the
          docked panel. */}
      {isHeld && (
        <View
          style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            bottom: trimPanelHeight,
            justifyContent: 'center', alignItems: 'center',
          }}
          pointerEvents="none"
        >
          <View
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
              backgroundColor: 'rgba(0,0,0,0.65)',
            }}
          >
            <Pause size={14} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>Paused</Text>
          </View>
        </View>
      )}

      {/* Top overlay — progress dots, action buttons, and the scorecard
          card (moved up from the bottom so the bottom edge stays free for
          the trim panel). Sits below the notch via insets.top. */}
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
              <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
                {currentIndex + 1} of {allClips.length}
              </Text>
            )}
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {/* Pose-overlay toggle (analytical replay). Native only. The
                skeleton itself still hides mid-edit (showPoseOverlay &&
                !trimMode on the player) so it can't distract from a drag. */}
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

            {/* Full trimmer */}
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setFullTrimOpen(true);
              }}
              hitSlop={10}
              style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: 'rgba(0,0,0,0.5)',
                justifyContent: 'center', alignItems: 'center',
              }}
            >
              <Scissors size={16} color="rgba(255,255,255,0.85)" />
            </Pressable>

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

        {/* Scorecard card — replaces the old "Hole N · Stroke M" header.
            Stays up while trimming: it lives at the top, the panel at the
            bottom, so the two never collide. */}
        {currentClip && (
          <ScorecardOverlay
            clip={currentClip}
            holes={editor.state.holes}
            courseName={editor.state.courseName} template={scorecardTemplate} playerName={playerName}
          />
        )}
      </View>

      {/* Trim panel — DOCKED, always on screen. Keyed on the clip so the
          handles reset to the new clip's bounds instead of carrying the
          previous clip's over. */}
      {currentClip && (
        <>
        <ClipTrimModal
          visible={fullTrimOpen && !!currentClip}
          clip={currentClip ?? null}
          onSave={(startMs, endMs, sourceOverride) => {
            handleTrimSave(startMs, endMs, sourceOverride);
            setFullTrimOpen(false);
          }}
          onDismiss={() => setFullTrimOpen(false)}
          positionLabel={currentClip ? `Hole ${currentClip.holeNumber} · Shot ${currentClip.shotNumber}` : undefined}
          hasPrev={currentIndex > 0}
          hasNext={currentIndex < allClips.length - 1}
          onNavigate={(dir, startMs, endMs) => {
            handleTrimSave(startMs, endMs);
            setCurrentIndex((i) => Math.max(0, Math.min(allClips.length - 1, i + (dir === 'next' ? 1 : -1))));
          }}
        />
        <InlineTrimPanel
          key={currentClip.id}
          clip={currentClip}
          dirty={trimDirty}
          onSave={handleTrimSave}
          onBoundsChange={handleTrimBoundsChange}
          onSeekTarget={handleSeekTarget}
          onDraggingHandle={handleDraggingHandle}
          onHeight={setTrimPanelHeight}
        />
        </>
      )}
    </View>
  );
}
