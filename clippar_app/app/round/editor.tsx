import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Image,
  ActivityIndicator,
  Platform,
  Alert,
  Modal,
} from 'react-native';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { getProStatus } from '@/lib/subscription';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, ArrowLeft, XCircle, Film, Upload, Music, Monitor, Check, Download, Share2, ListChecks, CircleCheck, Circle , CheckCircle2, MoreHorizontal } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { useEditorState } from '@/hooks/useEditorState';
import { emitPipelineEvent, subscribePipeline } from '@/lib/pipelineEvents';
import { buildReelScorecard, holeReelDurationMs } from '@/lib/reelScorecard';
import { composeFailureCause, FAILURE_CAUSE } from '@/lib/roundStatusLogic';
import { ClipTrimModal } from '@/components/editor/ClipTrimModal';
import { SCORECARD_TEMPLATES, TemplateSwatch } from '@/components/editor/ScorecardTemplates';
import type { ScorecardTemplate } from '@/modules/shot-detector';
import { supabase } from '@/lib/supabase';
import { MusicPicker, type MusicTrack } from '@/components/editor/MusicPicker';
import type { EditorClip, EditorHoleSection } from '@/types/editor';
import { trainingHoleLabel, CLUBS } from '@/lib/training';
import { composeReel, addStitchProgressListener, type ScorecardData, type StitchProgressEvent } from '@/modules/shot-detector';
import { updateRound, getSignedClipUrls } from '@/lib/api';
import { markReelFresh } from '@/lib/storage';
import { saveClipToPhotos, saveHoleToPhotos, shareHole, stitchHoleClips, shareClip } from '@/lib/clipShare';
// `uploadReelToStorage` is now invoked lazily by the share-link flow rather
// than at compose time. Imported there, not here.
import { resolveTrackToLocalUri } from '@/lib/music';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// ---------------------------------------------------------------------------
// Concurrent-compose guard (F2c).
//
// A native composeReel is expensive and must never run twice at once for the
// same round. The classic trigger: the stall watchdog surfaces FAILED, the
// user taps Retry (which deep-links back here with ?recompose=1), and a second
// compose launches while the first is still running. This lock is module-scoped
// so it holds across editor remounts / separate navigations, not just within
// one component instance.
//
// It is RELEASED reactively from the pipeline bus on the job's terminal event
// (compose:complete or compose:error, including a watchdog-fired error) so it
// can never strand across a real failure — no matter which code path or which
// editor instance ended the job.
const inFlightComposeRoundIds = new Set<string>();
let composeLockReleaserInstalled = false;
function installComposeLockReleaser() {
  if (composeLockReleaserInstalled) return;
  composeLockReleaserInstalled = true;
  subscribePipeline((event) => {
    if (event.type === 'compose:complete' || event.type === 'compose:error') {
      inFlightComposeRoundIds.delete(event.roundId);
    }
  });
}
installComposeLockReleaser();

// Conditionally import thumbnail generator
const VideoThumbnails = isNative
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

// Conditionally import image picker (native only)
const ImagePicker = isNative
  ? (require('expo-image-picker') as typeof import('expo-image-picker'))
  : null;

function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Shared row style for the clip-actions menu (move/exclude/delete).
const menuRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 12,
  paddingVertical: 14,
  paddingHorizontal: 14,
  borderRadius: theme.radius.md,
  backgroundColor: theme.colors.surfaceElevated,
  borderWidth: 1,
  borderColor: theme.colors.surfaceBorder,
  marginBottom: 10,
};

// ---- Clip Card (matches GolfCam style) ----
function ClipCard({
  clip,
  onEdit,
  onRemove,
  onLongPress,
  onDownload,
  disabled = false,
  onPressWhenDisabled,
  selectable = false,
  selected = false,
}: {
  clip: EditorClip;
  onEdit: () => void;
  onRemove: () => void;
  onLongPress: () => void;
  onDownload: () => void;
  /** Select mode: per-clip actions are inert; a tap toggles the hole. */
  disabled?: boolean;
  onPressWhenDisabled?: () => void;
  /** Training select mode: the clip ITSELF is the selectable unit —
      "select individual shots, including multiple different ones". */
  selectable?: boolean;
  selected?: boolean;
}) {
  const [thumbnail, setThumbnail] = useState<string | null>(clip.thumbnailUri ?? null);

  // Generate thumbnail on native
  useEffect(() => {
    if (thumbnail || !clip.sourceUri || !isNative || !VideoThumbnails) return;
    VideoThumbnails.getThumbnailAsync(clip.sourceUri, { time: 500 })
      .then((result) => setThumbnail(result.uri))
      .catch(() => {});
  }, [clip.sourceUri, thumbnail]);

  const duration = formatDuration(clip.durationMs);

  // Was anything actually cut? Manual bounds narrower than the file, or an
  // auto-trim that produced a different (shorter) file than the original.
  const wasTrimmed =
    !clip.needsTrim &&
    ((clip.trimStartMs ?? 0) > 0 ||
      (clip.trimEndMs !== -1 && clip.trimEndMs > 0 && clip.trimEndMs < clip.durationMs) ||
      (!!clip.autoTrimmed && !!clip.originalUri && clip.originalUri !== clip.sourceUri));

  // 4 Sep, Henry: a visible Options button on every shot instead of a hold.
  const optionsButton = !disabled && !selectable ? (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onLongPress();
      }}
      hitSlop={6}
      style={{
        marginTop: 6,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        paddingVertical: 5,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceElevated,
        borderWidth: 1,
        borderColor: theme.colors.surfaceBorder,
      }}
    >
      <MoreHorizontal size={14} color={theme.colors.textPrimary} />
      <Text style={{ color: theme.colors.textPrimary, fontSize: 11, fontWeight: '600' }}>Options</Text>
    </Pressable>
  ) : null;

  return (
    <View
      style={{
        width: 100,
        marginRight: 10,
        borderRadius: theme.radius.md,
        borderWidth: selectable ? 2 : 0,
        borderColor: selectable && selected ? theme.colors.primary : 'transparent',
        opacity: selectable && !selected ? 0.75 : 1,
      }}
    >
      {selectable && selected && (
        <View style={{ position: 'absolute', top: 22, left: 4, zIndex: 2, backgroundColor: theme.colors.primary, borderRadius: 10, padding: 2 }}>
          <CheckCircle2 size={14} color="#fff" />
        </View>
      )}
      {/* Stroke label */}
      <Text
        style={{
          color: theme.colors.textTertiary,
          fontSize: 11,
          fontWeight: '500',
          textAlign: 'center',
          marginBottom: 4,
        }}
      >
        Stroke {clip.shotNumber}
      </Text>

      <Pressable
        onPress={() => {
          if (disabled) {
            onPressWhenDisabled?.();
            return;
          }
          if (clip.isExcluded) return;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onEdit();
        }}
        onLongPress={() => {
          if (disabled) return;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          onLongPress();
        }}
        delayLongPress={400}
      >
        <View
          style={{
            width: 100,
            height: 140,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surface,
            overflow: 'hidden',
            opacity: clip.isExcluded ? 0.4 : clip.needsTrim ? 0.6 : 1,
          }}
        >
          {/* Thumbnail or placeholder */}
          {thumbnail ? (
            <Image
              source={{ uri: thumbnail }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: theme.colors.surface,
              }}
            >
              <Film size={24} color={theme.colors.textTertiary} />
            </View>
          )}

          {/* Spinner overlay while waiting for auto-trim */}
          {clip.needsTrim && (
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.35)',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <ActivityIndicator size="small" color="#fff" />
              <Text
                style={{
                  color: 'rgba(255,255,255,0.85)',
                  fontSize: 10,
                  fontWeight: '600',
                  marginTop: 4,
                }}
              >
                Waiting...
              </Text>
            </View>
          )}

          {/* Spinner overlay while the shot-tracer arc renders (config.tracer
              — tracerStatus is only ever set when the flag is on). Same
              treatment as the auto-trim "Waiting..." overlay above. */}
          {!clip.needsTrim && clip.tracerStatus === 'pending' && (
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.35)',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <ActivityIndicator size="small" color="#fff" />
              <Text
                style={{
                  color: 'rgba(255,255,255,0.85)',
                  fontSize: 10,
                  fontWeight: '600',
                  marginTop: 4,
                }}
              >
                Tracing...
              </Text>
            </View>
          )}

          {/* Duration badge (top-left, like GolfCam) */}
          {duration ? (
            <View
              style={{
                position: 'absolute',
                top: 4,
                left: 4,
                backgroundColor: 'rgba(0,0,0,0.7)',
                paddingHorizontal: 5,
                paddingVertical: 2,
                borderRadius: 4,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>
                {duration}
              </Text>
            </View>
          ) : null}

          {/* Remove button (top-right X).
              Confirms before deleting. It did not until 30 Aug, and until the
              same day the delete never reached SQLite, so a mis-tap was
              harmless — the clip came back on the next focus reload. Now that
              the delete persists, a single stray tap on an 18px target at the
              corner of a thumbnail would destroy a shot, so the prompt is not
              politeness, it is the thing standing between a fat finger and a
              lost hole-in-one. The clip-actions menu's Delete has asked since
              it shipped; this control is now consistent with it. */}
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              Alert.alert('Delete this shot?', 'You can put it back from Profile → Recently deleted.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => onRemove() },
              ]);
            }}
            hitSlop={8}
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
            }}
          >
            {/* One control on the tile: a red X. Download lives in Options
                now (Henry, 4 Sep). */}
            <XCircle size={26} color={theme.colors.accentRed} fill="rgba(0,0,0,0.6)" />
          </Pressable>

          {/* Bottom label: "Excluded", or "Trimmed" ONLY when something was
              actually cut — a manual trim narrower than the file, or an auto
              trim that produced a shorter file. An untouched clip (a putt the
              detector left whole, an import not yet cut) shows NO band, so
              the ones still at full length stand out when scanning the list
              (Henry, 4 Sep). */}
          {(clip.isExcluded || wasTrimmed) && (
            <View
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                paddingVertical: 6,
                backgroundColor: clip.isExcluded ? 'rgba(180,0,0,0.7)' : 'rgba(46,125,50,0.85)',
                alignItems: 'center',
                flexDirection: 'row',
                justifyContent: 'center',
                gap: 3,
              }}
            >
              {!clip.isExcluded && <Check size={12} color="#fff" />}
              <Text
                style={{
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: '600',
                  textDecorationLine: clip.isExcluded ? 'line-through' : 'none',
                }}
              >
                {clip.isExcluded ? 'Excluded' : 'Trimmed'}
              </Text>
            </View>
          )}
        </View>
      </Pressable>
      {optionsButton}
    </View>
  );
}

// ---- Hole Section (matches GolfCam: "Hole 1  Par 4  Score 4") ----
function HoleSection({
  hole,
  onClipEdit,
  onRemoveClip,
  onClipLongPress,
  onClipDownload,
  onHoleSave,
  onHoleShare,
  busyHoleNumber,
  selectMode,
  selected,
  onToggleSelect,
  training,
  selectedClipIds,
  onToggleClipSelect,
}: {
  hole: EditorHoleSection;
  onClipEdit: (clip: EditorClip) => void;
  onRemoveClip: (clipId: string) => void;
  onClipLongPress: (clip: EditorClip) => void;
  onClipDownload: (clip: EditorClip) => void;
  onHoleSave: (hole: EditorHoleSection) => void;
  onHoleShare: (hole: EditorHoleSection) => void;
  busyHoleNumber: number | null;
  selectMode: boolean;
  /** Trainee mode: this "hole" is a club — label it as one, and drop
      Par/Score, which are course concepts a range session doesn't have. */
  training: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  /** Training select mode: per-clip selection instead of per-hole. */
  selectedClipIds?: Set<string>;
  onToggleClipSelect?: (clipId: string) => void;
}) {
  // F17: clips mid-tracer-render are excluded the same way untrimmed clips
  // are — their arc would be missing from the stitched output.
  const usableClips = hole.clips.filter(
    (c) => !c.isExcluded && c.sourceUri && !c.needsTrim && c.tracerStatus !== 'pending'
  );
  const canStitchHole = usableClips.length > 0;
  const isBusy = busyHoleNumber === hole.holeNumber;
  return (
    <View
      style={{
        marginBottom: 24,
        // Highlight the whole section when picked in select mode.
        backgroundColor: selectMode && selected ? theme.colors.primaryMuted : 'transparent',
        borderRadius: selectMode ? 12 : 0,
        paddingVertical: selectMode ? 8 : 0,
      }}
    >
      {/* Hole header — bold left-aligned like GolfCam. In select mode the
          whole header is a toggle and shows a checkbox. */}
      <Pressable
        onPress={selectMode ? onToggleSelect : undefined}
        disabled={!selectMode}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          marginBottom: 10,
          gap: 12,
        }}
      >
        {selectMode && (
          selected ? (
            <CircleCheck size={22} color={theme.colors.primary} />
          ) : (
            <Circle size={22} color={theme.colors.textTertiary} />
          )
        )}
        <Text
          style={{
            color: theme.colors.primary,
            fontSize: 18,
            fontWeight: '800',
          }}
        >
          {training ? trainingHoleLabel(hole.holeNumber) : `Hole ${hole.holeNumber}`}
        </Text>
        {!training && (
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontSize: 16,
              fontWeight: '700',
            }}
          >
            Par {hole.par}
          </Text>
        )}
        {!training && (
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontSize: 16,
              fontWeight: '700',
            }}
          >
            Score {hole.strokes}
          </Text>
        )}
        {training && (
          <Text style={{ color: theme.colors.textSecondary, fontSize: 14, fontWeight: '600' }}>
            {hole.clips.length} shot{hole.clips.length === 1 ? '' : 's'}
          </Text>
        )}

        {/* Per-hole stitch + share / save actions. Hidden in select mode
            (the bottom bar handles the multi-hole action there) and when
            there's nothing usable on this hole. Disabled while another
            hole is mid-stitch. */}
        {!selectMode && canStitchHole && (
          <View
            style={{
              flexDirection: 'row',
              gap: 6,
              marginLeft: 'auto',
            }}
          >
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onHoleSave(hole);
              }}
              disabled={isBusy}
              hitSlop={8}
              style={{
                height: 32,
                paddingHorizontal: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                backgroundColor: theme.colors.surfaceElevated,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                opacity: isBusy ? 0.5 : 1,
              }}
            >
              {isBusy ? (
                <ActivityIndicator size="small" color={theme.colors.textPrimary} />
              ) : (
                <Download size={14} color={theme.colors.textPrimary} />
              )}
              <Text style={{ color: theme.colors.textPrimary, fontSize: 12, fontWeight: '700' }}>Save hole</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onHoleShare(hole);
              }}
              disabled={isBusy}
              hitSlop={8}
              style={{
                height: 32,
                paddingHorizontal: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                backgroundColor: theme.colors.surfaceElevated,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                opacity: isBusy ? 0.5 : 1,
              }}
            >
              <Share2 size={14} color={theme.colors.textPrimary} />
              <Text style={{ color: theme.colors.textPrimary, fontSize: 12, fontWeight: '700' }}>Share hole</Text>
            </Pressable>
          </View>
        )}
      </Pressable>

      {/* Clip cards row */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16 }}
      >
        {hole.clips.map((clip) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            onEdit={() => onClipEdit(clip)}
            onRemove={() => onRemoveClip(clip.id)}
            onLongPress={() => onClipLongPress(clip)}
            onDownload={() => onClipDownload(clip)}
            // In select mode tapping anywhere on the hole toggles the
            // whole hole — EXCEPT in training, where the clip itself is the
            // selectable unit (Henry: pick arbitrary individual shots).
            disabled={selectMode}
            onPressWhenDisabled={
              training && onToggleClipSelect ? () => onToggleClipSelect(clip.id) : onToggleSelect
            }
            selectable={selectMode && training}
            selected={selectedClipIds?.has(clip.id) ?? false}
          />
        ))}

        {hole.clips.length === 0 && (
          <View
            style={{
              width: 100,
              height: 140,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              borderStyle: 'dashed',
              justifyContent: 'center',
              alignItems: 'center',
              marginTop: 18, // offset for missing "Stroke X" label
            }}
          >
            <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
              No clips
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// The "+ Intro" / "+ Outro" slot cards used to render here. There is no
// intro/outro feature: nothing picks or records such a clip, nothing
// persists one (no column, no storage path), and useEditorState.setIntro /
// setOutro have zero call sites — state.intro and state.outro are null for
// the entire life of the screen. The cards were a dashed, plus-iconed,
// tappable-looking View with no onPress, so tapping them did nothing. A dead
// affordance on a paid product reads as a broken app, so they are gone until
// the feature actually exists.

// ============================================================
// MAIN EDITOR SCREEN
// ============================================================
export default function EditorScreen() {
  const { roundId, recompose, review, training } = useLocalSearchParams<{ roundId: string; recompose?: string; review?: string; training?: string }>();
  // Review mode: opened mid-round from the recording screen's "Review round
  // so far". Hides the final Export action so the user can't accidentally
  // finalize a reel while the round is still in progress.
  const isReview = review === '1';
  // Trainee mode: holes are clubs (lib/training's mapping) — same data, same
  // export machinery, different words.
  const isTraining = training === '1';
  const insets = useSafeAreaInsets();
  const editor = useEditorState(roundId);
  const { state } = editor;

  // Re-read trim state from SQLite when returning from another screen
  const hasMountedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      // Skip the first focus (useEditorState already loads on mount)
      if (!hasMountedRef.current) {
        hasMountedRef.current = true;
        return;
      }
      editor.reload();
    }, [editor.reload])
  );

  const totalClips = state.holes.reduce((sum, h) => sum + h.clips.length, 0);
  const [trimClip, setTrimClip] = useState<EditorClip | null>(null);
  // Which scorecard the reel gets (5 Sep). Persisted on the round; the
  // preview mirrors it; native burns it in. Training rounds always use the
  // club-name look and never show this picker.
  const [scorecardTemplate, setScorecardTemplate] = useState<ScorecardTemplate>('classic');
  const [playerName, setPlayerName] = useState('');
  useEffect(() => {
    if (!roundId) return;
    (async () => {
      try {
        const storage = require('@/lib/storage') as typeof import('@/lib/storage');
        const r = await storage.getLocalRound(roundId);
        const t = r?.scorecard_template as ScorecardTemplate | null | undefined;
        if (t && t !== 'training') setScorecardTemplate(t);
      } catch {}
      try {
        const { data } = await supabase.auth.getSession();
        const u = data.session?.user;
        const name = (u?.user_metadata?.full_name as string | undefined) || u?.email?.split('@')[0] || '';
        setPlayerName(name);
      } catch {}
    })();
  }, [roundId]);
  const chooseTemplate = useCallback((t: ScorecardTemplate) => {
    setScorecardTemplate(t);
    Haptics.selectionAsync();
    if (!roundId) return;
    try {
      const storage = require('@/lib/storage') as typeof import('@/lib/storage');
      void storage.updateLocalRound(roundId, { scorecard_template: t }).catch(() => {});
      void storage.markReelStale(roundId).catch(() => {});
    } catch {}
  }, [roundId]);
  // Every clip in play order (holes ascending, shots ascending) — the
  // trimmer's swipe/chevron navigation walks this, across holes.
  const flatClips = useMemo(() => state.holes.flatMap((h) => h.clips), [state.holes]);
  // Long-press a clip → opens the clip-actions menu (move to hole / exclude
  // / delete). Holds the clip whose menu is open; null = closed.
  const [movingClip, setMovingClip] = useState<EditorClip | null>(null);

  // Derive trim progress from current state
  const allClips = state.holes.flatMap((h) => h.clips);
  const untrimmedCount = allClips.filter((c) => c.needsTrim).length;
  const isTrimming = untrimmedCount > 0;
  const hasUntrimmedClips = isTrimming;

  // F17: while any tracer render is pending, Export / per-hole save+share /
  // multi-select must wait — composeReel and the tracer batch would
  // otherwise run concurrent AVAssetExportSessions, and the output would be
  // missing arcs about to land. tracerStatus is only populated when
  // config.tracer.enabled, so this is 0 (and all gates inert) day-zero.
  const tracerPendingCount = allClips.filter((c) => c.tracerStatus === 'pending').length;
  const isTracing = tracerPendingCount > 0;

  // Start processAllUntrimmed once when loading finishes (guarded by ref)
  const trimStartedRef = useRef(false);
  useEffect(() => {
    if (state.loading || trimStartedRef.current) return;
    const untrimmed = state.holes.flatMap((h) => h.clips).filter((c) => c.needsTrim);
    if (untrimmed.length === 0) return;
    trimStartedRef.current = true;
    editor.processAllUntrimmed();
  }, [state.loading]);

  // Start the shot-tracer batch once auto-trim has fully settled (tracers
  // pair clips by GPS and render onto the TRIMMED files, so they must run
  // last). Skipped in review mode — mid-round battery burn for arcs the
  // user isn't finalizing yet.
  const tracerStartedRef = useRef(false);
  useEffect(() => {
    if (!config.tracer.enabled || state.loading || tracerStartedRef.current) return;
    if (untrimmedCount > 0 || isReview) return;
    tracerStartedRef.current = true;
    editor.processAllTracers();
  }, [state.loading, untrimmedCount]);
  const [musicPickerVisible, setMusicPickerVisible] = useState(false);
  const [selectedMusic, setSelectedMusic] = useState<Pick<MusicTrack, 'id' | 'title' | 'file_url'> | null>(null);

  // Export settings
  const [exportModalVisible, setExportModalVisible] = useState(false);
  // Export resolution/frame-rate UI was removed — clips render at their
  // captured quality. See the export-settings JSX comment below.
  // Vocabulary law: "reel"/"build"/"stitch" = on-device compose, never a
  // cloud upload. This export flow composes locally, full stop.
  const exportMode = 'local-compose' as const;
  const [composing, setComposing] = useState(false);
  const [composeProgress, setComposeProgress] = useState('');
  const [exportProgress, setExportProgress] = useState<StitchProgressEvent | null>(null);

  // Navigate back if there's a screen to go back to, otherwise drop to the
  // library tab. The editor is reachable via `router.replace`
  // (e.g. straight from the upload flow after recording), in which case the
  // navigation stack is empty and `router.back()` is a silent no-op that
  // emits "The action 'GO_BACK' was not handled by any navigator" — the
  // user-visible effect is "tap Leave does nothing".
  const leaveEditor = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  }, []);

  // Review mode only: pop straight back to the LIVE round. record.tsx opens
  // the editor with router.push precisely so the record screen stays mounted
  // underneath — router.back() therefore resumes the same in-memory round
  // (hole/shot pointers, camera, clicker) with nothing reset. Any other
  // navigation call would remount record.tsx and restart the round setup, so
  // don't "simplify" this to a replace. The fallback only fires if the stack
  // is somehow empty, and lands on the record tab rather than the library so
  // the golfer is at least back where the round lives.
  const backToRound = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/record');
    }
  }, []);

  const handleClose = useCallback(() => {
    if (totalClips === 0) {
      leaveEditor();
      return;
    }
    Alert.alert(
      'Leave Editor?',
      'Your edits are saved as a draft. You can come back to finish later.',
      [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'default', onPress: leaveEditor },
      ]
    );
  }, [totalClips, leaveEditor]);

  const handleClipEdit = useCallback((clip: EditorClip) => {
    setTrimClip(clip);
  }, []);

  // Per-clip download — saves the trimmed file directly to the user's
  // Photos library. Trimmed files live in cacheDirectory or document
  // directory; saveToLibraryAsync takes either.
  const handleClipDownload = useCallback(async (clip: EditorClip) => {
    if (!clip.sourceUri) {
      Alert.alert('Not Ready', 'This clip is still processing. Try again in a moment.');
      return;
    }
    const ok = await saveClipToPhotos(clip.sourceUri);
    if (ok) {
      Alert.alert('Saved', `Hole ${clip.holeNumber} · Stroke ${clip.shotNumber} saved to Photos.`);
    } else {
      Alert.alert('Save Failed', 'Could not save to Photos. Check that Clippar has Photos access in Settings.');
    }
  }, []);

  // Per-hole stitch + save — runs the native stitcher on this hole's
  // (non-excluded, non-pending) clips, saves the result to Photos.
  const [busyHoleNumber, setBusyHoleNumber] = useState<number | null>(null);
  const handleHoleSave = useCallback(async (hole: EditorHoleSection) => {
    // F17: wait for tracer renders — mirrors the needsTrim gating below.
    if (isTracing) {
      Alert.alert(
        'Tracers Rendering',
        'Shot tracers are still being added to your clips. Try again in a moment.'
      );
      return;
    }
    const usableClips = hole.clips.filter(
      (c) => !c.isExcluded && c.sourceUri && !c.needsTrim && c.tracerStatus !== 'pending'
    );
    if (usableClips.length === 0) return;
    setBusyHoleNumber(hole.holeNumber);
    try {
      const ok = await saveHoleToPhotos(usableClips.map((c) => c.sourceUri!));
      if (ok) {
        Alert.alert(
          'Saved',
          `Hole ${hole.holeNumber} highlight saved to Photos (${usableClips.length} clip${usableClips.length > 1 ? 's' : ''}).`,
        );
      } else {
        Alert.alert('Save Failed', 'Could not stitch + save this hole. Try again.');
      }
    } finally {
      setBusyHoleNumber(null);
    }
  }, [isTracing]);

  // Per-hole share — stitches and opens the iOS share sheet.
  const handleHoleShare = useCallback(async (hole: EditorHoleSection) => {
    // F17: wait for tracer renders — mirrors the needsTrim gating below.
    if (isTracing) {
      Alert.alert(
        'Tracers Rendering',
        'Shot tracers are still being added to your clips. Try again in a moment.'
      );
      return;
    }
    const usableClips = hole.clips.filter(
      (c) => !c.isExcluded && c.sourceUri && !c.needsTrim && c.tracerStatus !== 'pending'
    );
    if (usableClips.length === 0) return;
    setBusyHoleNumber(hole.holeNumber);
    try {
      await shareHole(
        usableClips.map((c) => c.sourceUri!),
        hole.holeNumber,
        state.courseName || 'Round',
      );
    } finally {
      setBusyHoleNumber(null);
    }
  }, [state.courseName, isTracing]);

  // ---- Multi-hole selection → custom highlight reel ----
  // "Select" mode lets the user tick a subset of holes (e.g. 3, 6, 14),
  // then stitch JUST those holes into one video they can save to Photos or
  // share. Reuses the same stitch/save/share plumbing as the per-hole
  // buttons — a multi-hole reel is just a wider list of clip URIs.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedHoles, setSelectedHoles] = useState<number[]>([]);
  // Training select mode selects CLIPS; a club header tap toggles all of its
  // clips at once (select-the-whole-club is still one tap).
  const [selectedClips, setSelectedClips] = useState<Set<string>>(new Set());
  const toggleClipSelected = useCallback((clipId: string) => {
    setSelectedClips((prev) => {
      const next = new Set(prev);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  }, []);
  const [selectionBusy, setSelectionBusy] = useState(false);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedHoles([]);
  }, []);

  const toggleHoleSelected = useCallback((holeNumber: number) => {
    Haptics.selectionAsync();
    setSelectedHoles((prev) =>
      prev.includes(holeNumber)
        ? prev.filter((h) => h !== holeNumber)
        : [...prev, holeNumber]
    );
  }, []);

  const toggleClubClipsSelected = useCallback(
    (holeNumber: number) => {
      const hole = state.holes.find((h) => h.holeNumber === holeNumber);
      if (!hole) return;
      setSelectedClips((prev) => {
        const next = new Set(prev);
        const ids = hole.clips.map((c) => c.id);
        const allIn = ids.every((id) => next.has(id));
        for (const id of ids) {
          if (allIn) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    },
    [state.holes]
  );

  // Gather the usable clip URIs for the selected holes, in hole then shot
  // order. Excluded / still-trimming clips are skipped.
  const collectSelectedUris = useCallback((): string[] => {
    if (isTraining) {
      // Clip-level selection, in club order then shot order.
      const uris: string[] = [];
      for (const hole of state.holes) {
        hole.clips
          .filter((c) => selectedClips.has(c.id))
          .filter((c) => !c.isExcluded && c.sourceUri && !c.needsTrim && c.tracerStatus !== 'pending')
          .forEach((c) => uris.push(c.sourceUri!));
      }
      return uris;
    }
    const order = [...selectedHoles].sort((a, b) => a - b);
    const uris: string[] = [];
    for (const hn of order) {
      const hole = state.holes.find((h) => h.holeNumber === hn);
      if (!hole) continue;
      hole.clips
        .filter((c) => !c.isExcluded && c.sourceUri && !c.needsTrim && c.tracerStatus !== 'pending')
        .forEach((c) => uris.push(c.sourceUri!));
    }
    return uris;
  }, [selectedHoles, state.holes, isTraining, selectedClips]);

  const handleSaveSelected = useCallback(async () => {
    // F17: wait for tracer renders before building a multi-hole highlight.
    if (isTracing) {
      Alert.alert(
        'Tracers Rendering',
        'Shot tracers are still being added to your clips. Try again in a moment.'
      );
      return;
    }
    const uris = collectSelectedUris();
    if (uris.length === 0) {
      Alert.alert('No clips ready', 'The selected holes have no finished clips to include yet.');
      return;
    }
    setSelectionBusy(true);
    try {
      const ok = await saveHoleToPhotos(uris);
      if (ok) {
        Alert.alert(
          'Saved',
          isTraining
            ? `Saved to Photos — ${uris.length} shot${uris.length > 1 ? 's' : ''}.`
            : `Highlight saved to Photos — ${selectedHoles.length} hole${selectedHoles.length > 1 ? 's' : ''}, ${uris.length} clip${uris.length > 1 ? 's' : ''}.`,
        );
        exitSelectMode();
      } else {
        Alert.alert('Save Failed', 'Could not stitch + save the highlight. Check Photos access in Settings and try again.');
      }
    } finally {
      setSelectionBusy(false);
    }
  }, [collectSelectedUris, selectedHoles.length, isTraining, exitSelectMode, isTracing]);

  const handleShareSelected = useCallback(async () => {
    // F17: wait for tracer renders before building a multi-hole highlight.
    if (isTracing) {
      Alert.alert(
        'Tracers Rendering',
        'Shot tracers are still being added to your clips. Try again in a moment.'
      );
      return;
    }
    const uris = collectSelectedUris();
    if (uris.length === 0) {
      Alert.alert('No clips ready', 'The selected holes have no finished clips to include yet.');
      return;
    }
    setSelectionBusy(true);
    try {
      const stitched = await stitchHoleClips(uris);
      if (!stitched) {
        Alert.alert('Share Failed', 'Could not build the highlight. Try again.');
        return;
      }
      const label = isTraining
        ? `${collectSelectedUris().length} shots`
        : `Holes ${[...selectedHoles].sort((a, b) => a - b).join(', ')}`;
      await shareClip(stitched, `${label} – ${state.courseName || 'Round'}`);
    } finally {
      setSelectionBusy(false);
    }
  }, [collectSelectedUris, selectedHoles, state.courseName, isTraining, isTracing]);

  const handlePreviewAll = useCallback(() => {
    if (hasUntrimmedClips) {
      Alert.alert(
        'Auto-Trim in Progress',
        'Please wait — clips are still being auto-trimmed. This usually takes a few seconds per clip.'
      );
      return;
    }
    if (totalClips === 0) return;
    if (isTraining) {
      // Henry, 31 Aug: previewing practice "should be exactly like the watch
      // mode but in the editor". One playback behaviour for practice content
      // everywhere — so this IS the watch mode: the same ASMR player, same
      // per-shot play length control (0.5/1/2/3s), same club labels, not a
      // round-preview variant of it. No scorecard, because that screen has
      // never had one.
      router.push(`/training/play?roundId=${state.roundId}`);
      return;
    }
    router.push({
      pathname: '/round/preview',
      params: { roundId: state.roundId, startIndex: '0' },
    });
  }, [state.roundId, totalClips, hasUntrimmedClips, isTraining]);

  const handleExportPress = useCallback(() => {
    if (hasUntrimmedClips) {
      Alert.alert(
        'Auto-Trim in Progress',
        'Please wait — clips are still being auto-trimmed. This usually takes a few seconds per clip.'
      );
      return;
    }
    // F17: composeReel must not run while the tracer batch holds an
    // AVAssetExportSession of its own (and the reel would miss arcs that
    // are about to finish rendering).
    if (isTracing) {
      Alert.alert(
        'Tracers Rendering',
        'Shot tracers are still being added to your clips. Export will be ready in a moment.'
      );
      return;
    }
    const allClips = editor.getAllClipsInOrder();
    if (allClips.length === 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (isNative) {
        Alert.alert('No Clips', 'Add clips to your reel before exporting.');
      }
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExportModalVisible(true);
  }, [editor, hasUntrimmedClips, isTracing]);

  // Auto-open the export modal when arriving with `?recompose=1` (the
  // round detail page's "Reel out of date" banner deep-links here when
  // clips have been edited after the last compose). Wait for loading
  // and auto-trim to settle so the user doesn't see the alert.
  const recomposeAutoTriggeredRef = useRef(false);
  useEffect(() => {
    if (recompose !== '1') return;
    if (recomposeAutoTriggeredRef.current) return;
    if (state.loading || hasUntrimmedClips || isTracing) return;
    if (totalClips === 0) return;
    recomposeAutoTriggeredRef.current = true;
    setExportModalVisible(true);
  }, [recompose, state.loading, hasUntrimmedClips, isTracing, totalClips]);

  const handleExportConfirm = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Pro gate — OFF as of 2026-08-05: the whole reel pipeline including
    // export is free for v1 (Henry's call, made after hitting his own gate on
    // a real round). The branch stays because re-gating is a config flip, and
    // the flag's comment in constants/config.ts explains the paywall-copy
    // coupling that has to move with it.
    if (config.subscription.enforceExportGate) {
      const isPro = await getProStatus().catch(() => false);
      if (!isPro) {
        setExportModalVisible(false);
        router.push('/paywall');
        return;
      }
    }

    if (exportMode === 'local-compose') {
      // F2c: never launch a second native compose for a round that is already
      // composing (e.g. a stale watchdog FAILED + a Retry tap). Focus the
      // existing progress instead of starting a concurrent job.
      if (state.roundId && inFlightComposeRoundIds.has(state.roundId)) {
        console.log(
          `[Editor] compose already in-flight for round ${state.roundId} — ignoring duplicate export`,
        );
        setExportModalVisible(false);
        return;
      }
      // On-device reel composition
      const allClips = editor.getAllClipsInOrder();
      const clipUris = allClips
        .filter((c) => c.sourceUri)
        .map((c) => c.sourceUri!);

      if (clipUris.length === 0) {
        Alert.alert('No Clips', 'No video files available to compose.');
        return;
      }

      // DIAGNOSTIC: log per-clip exclusion + classification state to track
      // down the "par-hole clips skipped from reel" bug. If clips are vanishing
      // we want to know whether they were filtered by isExcluded, were classified
      // as putts, or have suspicious trim bounds. Remove once the bug is found.
      console.log('[Editor:Compose] allClips by hole/score/exclusion:');
      const allClipsRaw = state.holes.flatMap((h) => h.clips);
      allClipsRaw.forEach((c) => {
        console.log(
          `[Editor:Compose]   hole=${c.holeNumber} shot=${c.shotNumber} ` +
          `isExcluded=${!!c.isExcluded} ` +
          `trim=${c.trimStartMs}..${c.trimEndMs} ` +
          `dur=${c.durationMs} sourceUri=${c.sourceUri ? 'yes' : 'NO'} ` +
          `id=${c.id}`,
        );
      });
      const excludedCount = allClipsRaw.filter((c) => c.isExcluded).length;
      const includedCount = allClipsRaw.length - excludedCount;
      console.log(
        `[Editor:Compose] passing ${includedCount} of ${allClipsRaw.length} clips ` +
        `(${excludedCount} excluded, ${allClipsRaw.length - clipUris.length - excludedCount} missing sourceUri)`,
      );

      // F2c: claim the concurrent-compose lock BEFORE any async work so a
      // rapid second tap can't slip past the guard above. Released reactively
      // on the job's terminal compose:complete / compose:error event.
      inFlightComposeRoundIds.add(state.roundId);

      setComposing(true);
      setComposeProgress('Checking clip files...');
      // Broadcast to the pipeline bus so Home / round detail can render live
      // compose state. This is the "preparing" phase (clip recovery + music
      // resolution) — it emits liveness but does NOT arm the 30s watchdog; the
      // watchdog only supervises the native stage below (F2a).
      emitPipelineEvent({
        type: 'compose:start',
        roundId: state.roundId,
        courseName: state.courseName ?? null,
      });
      emitPipelineEvent({
        type: 'compose:stage',
        roundId: state.roundId,
        stage: 'preparing',
        stageLabel: 'Getting your clips…',
      });

      // Verify clip files exist on disk; for any that are missing, try to
      // recover by downloading from Supabase Storage. iOS routinely evicts
      // files from the app's tmp directory (especially after reinstall or
      // background purges), so clips that were uploaded remain recoverable
      // even though the local path is gone. Only clips that never uploaded
      // AND are missing locally are dropped.
      // `validClips[i]` is the EditorClip that produced `validClipUris[i]` —
      // the two stay in lockstep so both the trim bounds and the scorecard's
      // per-hole timeline can be derived from exactly the set of clips that
      // reaches the composer.
      let validClipUris = clipUris;
      let validClips: EditorClip[] = allClips.filter((c) => c.sourceUri);
      if (isNative) {
        // `expo-file-system`'s new top-level module no longer exports
        // `cacheDirectory` / `downloadAsync`. Pull those from the legacy
        // entry (same pattern as lib/media.ts).
        const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');

        // Build ordered list of clips-with-metadata so we can fall back to
        // storagePath for missing ones without losing playback order.
        const orderedForCompose = allClips.filter((c) => c.sourceUri);

        // First pass: check local disk existence.
        const existence = await Promise.all(
          orderedForCompose.map(async (c) => {
            try {
              const info = await FileSystem.getInfoAsync(c.sourceUri!);
              return info.exists;
            } catch {
              return false;
            }
          })
        );

        // Collect storage paths for missing clips that can be re-downloaded.
        const missingRecoverable: { index: number; clip: EditorClip }[] = [];
        const missingUnrecoverable: EditorClip[] = [];
        existence.forEach((exists, idx) => {
          if (exists) return;
          const clip = orderedForCompose[idx];
          if (clip.storagePath) {
            missingRecoverable.push({ index: idx, clip });
          } else {
            missingUnrecoverable.push(clip);
          }
        });

        // Recovered local paths, keyed by index into `orderedForCompose`.
        // Declared out here so the rebuild below is one expression for both
        // the "something was recovered" and "nothing needed recovering" cases.
        const recoveredUris = new Map<number, string>();

        if (missingRecoverable.length > 0) {
          console.warn(
            `[Editor] ${missingRecoverable.length} clip(s) missing locally — re-downloading from Supabase`
          );
          const recoverLabel =
            `Recovering ${missingRecoverable.length} missing clip${missingRecoverable.length > 1 ? 's' : ''}...`;
          setComposeProgress(recoverLabel);
          // Liveness during recovery (still the "preparing" phase — watchdog
          // stays disarmed while clips download over slow LTE).
          emitPipelineEvent({
            type: 'compose:stage',
            roundId: state.roundId,
            stage: 'preparing',
            stageLabel: recoverLabel,
          });

          const paths = missingRecoverable.map(({ clip }) => clip.storagePath!);
          // Never let a signing failure throw out of the compose flow — that
          // would leak the concurrent-compose lock. On failure, treat those
          // clips as unrecoverable (they fall through to the no-URL branch).
          const signed = await getSignedClipUrls(paths).catch((err) => {
            console.warn('[Editor] getSignedClipUrls failed during recovery:', err);
            return {} as Record<string, string>;
          });

          const cacheDir = `${FileSystem.cacheDirectory}recovered-clips/`;
          try {
            const dirInfo = await FileSystem.getInfoAsync(cacheDir);
            if (!dirInfo.exists) {
              await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
            }
          } catch {}

          // Download each missing clip to the cache dir and patch the uri.
          await Promise.all(
            missingRecoverable.map(async ({ index, clip }) => {
              const url = signed[clip.storagePath!];
              if (!url) {
                console.warn(`[Editor] No signed URL for ${clip.storagePath}`);
                return;
              }
              try {
                const dest = `${cacheDir}${clip.id}.mp4`;
                const result = await FileSystem.downloadAsync(url, dest);
                if (result.status === 200) {
                  recoveredUris.set(index, result.uri);
                } else {
                  console.warn(`[Editor] Download failed (status=${result.status}) for clip ${clip.id}`);
                }
              } catch (err) {
                console.warn(`[Editor] Download errored for clip ${clip.id}:`, err);
              }
            })
          );

        }

        // Rebuild the URI list and its clip list together, preserving order.
        // `recoveredUris` is empty when nothing needed recovering, so this one
        // expression covers both cases. Pairing here — where the drop decision
        // is actually made, and the index is still in hand — is what keeps
        // `validClips[i]` guaranteed to be the clip behind `validClipUris[i]`.
        const survivors = orderedForCompose
          .map((clip, idx) => {
            const uri = existence[idx] ? clip.sourceUri! : recoveredUris.get(idx) ?? null;
            return uri === null ? null : { uri, clip };
          })
          .filter((s): s is { uri: string; clip: EditorClip } => s !== null);
        validClipUris = survivors.map((s) => s.uri);
        validClips = survivors.map((s) => s.clip);

        const totalMissing = missingUnrecoverable.length +
          (missingRecoverable.length - (validClipUris.length - existence.filter(Boolean).length));

        if (missingUnrecoverable.length > 0) {
          console.warn(
            `[Editor] ${missingUnrecoverable.length} clip(s) missing on disk and never uploaded:`,
            missingUnrecoverable.map((c) => c.id)
          );
        }

        if (validClipUris.length === 0) {
          Alert.alert(
            'No Playable Clips',
            'All clips are missing from this device and could not be recovered. Try re-importing or re-recording the round.'
          );
          setComposing(false);
          emitPipelineEvent({
            type: 'compose:error',
            roundId: state.roundId,
            cause: FAILURE_CAUSE.missingClips,
          });
          return;
        }

        if (totalMissing > 0 && validClipUris.length < clipUris.length) {
          const dropped = clipUris.length - validClipUris.length;
          setComposeProgress(
            `${dropped} clip${dropped > 1 ? 's' : ''} unrecoverable — skipping...`
          );
        }
      }

      setComposeProgress('Composing reel on device...');

      try {
        // Build scorecard data with per-hole timing.
        //
        // `hasScore` rides along so the reel's card can obey the same rule as
        // the preview card: a hole shows nothing until it was actually ended.
        // buildReelScorecard does the totals (completed holes only) — see
        // lib/reelScorecard.ts.
        //
        // The timeline must be built from `validClips`, NOT from every
        // non-excluded clip: anything dropped above as missing-and-
        // unrecoverable is not in the reel, so counting its duration here
        // pushes every later hole boundary past where the video actually is,
        // and shots start carrying an earlier hole's card.
        const inReelClipIds = new Set(validClips.map((c) => c.id));
        const scorecardData: ScorecardData = buildReelScorecard(
          state.courseName,
          state.holes.map((hole) => ({
            holeNumber: hole.holeNumber,
            par: hole.par,
            strokes: hole.strokes,
            hasScore: hole.hasScore,
            durationMs: holeReelDurationMs(hole.clips, (c) => inReelClipIds.has(c.id)),
            // Practice: the club name is what the reel shows over each segment.
            ...(isTraining ? { label: trainingHoleLabel(hole.holeNumber) } : {}),
          })),
          { template: isTraining ? 'training' : scorecardTemplate, playerName },
        );

        // Resolve music to a local file path the native engine can read
        let musicFileUri: string | null = null;
        if (selectedMusic) {
          setComposeProgress('Preparing music track...');
          // Still the "preparing" phase — resolving a remote track can be slow
          // on LTE, but it isn't the native render, so keep the watchdog off.
          emitPipelineEvent({
            type: 'compose:stage',
            roundId: state.roundId,
            stage: 'preparing',
            stageLabel: 'Preparing music track…',
          });
          musicFileUri = await resolveTrackToLocalUri(
            selectedMusic.id,
            selectedMusic.file_url,
          );
          if (!musicFileUri) {
            console.warn('[Editor] Could not resolve music track, composing without music');
          }
        }

        setComposeProgress(`Stitching ${clipUris.length} clips + overlay...`);
        setExportProgress(null);

        // Subscribe to native stitch/compose progress events
        const progressSub = addStitchProgressListener((event) => {
          setExportProgress(event);
          if (event.phase === 'composing') {
            setComposeProgress(`Composing clip ${event.current} of ${event.total}...`);
          } else {
            setComposeProgress(`Exporting: ${Math.round(event.percent)}%...`);
          }
          // Broadcast real native progress only — never a fake percent.
          const percent =
            typeof event.percent === 'number' && event.percent > 0
              ? Math.min(event.percent, 100)
              : event.phase === 'composing' && event.total > 0
                ? (event.current / event.total) * 100
                : null;
          emitPipelineEvent({
            type: 'compose:progress',
            roundId: state.roundId,
            stageLabel: 'Stitching your reel…',
            percent,
          });
        });

        // Build per-clip compose inputs that carry trim metadata into the
        // native composer. Without this, trim edits made in the trim modal
        // are saved to SQLite but ignored on stitch — the reel plays full
        // source clips even though the user trimmed them.
        //
        // `validClips` was paired with `validClipUris` by index at the point
        // the drop decision was made, so index i of one is index i of the
        // other by construction. This replaced a walk that re-derived the
        // pairing by string-matching each URI back against the clip list —
        // which had to guess at recovered URIs (`uri.includes(id + '.mp4')`)
        // and, on any miss, ran its cursor off the end and silently handed
        // every remaining clip the default 0..-1 bounds, discarding the
        // user's trims for the rest of the reel.
        const composeClips = validClips.map((clip, idx) => {
          // When a clip has been auto-trimmed (or the user re-trimmed),
          // sourceUri IS the trim file already and trimStartMs/trimEndMs
          // are bounds in the ORIGINAL video's timeline — out-of-range
          // for the trim file. Pass full range so the native composer
          // uses the entire pre-trimmed clip.
          const isPreTrimmed = !!(clip.autoTrimmed && clip.originalUri);
          return {
            uri: validClipUris[idx],
            trimStartMs: isPreTrimmed ? 0 : clip.trimStartMs,
            trimEndMs: isPreTrimmed ? -1 : clip.trimEndMs,
          };
        });
        console.log(
          `[Editor:Compose] composeClips trim ranges:`,
          composeClips.map((c, i) => `[${i}] ${c.trimStartMs}..${c.trimEndMs}`).join(', '),
        );

        // The native render is about to begin — this is the ONLY signal that
        // arms the 30s stall watchdog (F2a). Everything above (clip recovery,
        // music resolution) ran without a watchdog so a slow LTE prep phase
        // can't be misread as a stalled render.
        emitPipelineEvent({
          type: 'compose:stage',
          roundId: state.roundId,
          stage: 'composing',
          stageLabel: 'Stitching your reel…',
        });

        let result;
        try {
          result = await composeReel(composeClips, scorecardData, musicFileUri);
        } finally {
          progressSub.remove();
        }

        if (result.reelUri) {
          setComposeProgress('Reel complete!');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

          // Save to camera roll if available
          if (isNative) {
            try {
              const MediaLibrary = require('expo-media-library') as typeof import('expo-media-library');
              const { status } = await MediaLibrary.requestPermissionsAsync();
              if (status === 'granted') {
                await MediaLibrary.saveToLibraryAsync(result.reelUri);
                setComposeProgress('Saved to camera roll!');
              }
            } catch {
              // Camera roll save failed — reel is still in cache
            }
          }

          // Reel upload is now opt-in — handled by the "Get share link" /
          // "Share" flow rather than running automatically on every compose.
          // The reel always lives in Photos (above) so it survives a
          // reinstall regardless. We persist the local path for in-session
          // playback; the share flow will lazily upload + replace this with
          // a storage path the first time the user requests a public link.
          try {
            await updateRound(state.roundId, {
              reel_url: result.reelUri,
              status: 'ready',
            });
          } catch (e) {
            console.log('[Editor] Failed to save reel_url:', e);
          }

          // The freshly-composed reel reflects the current clip state, so
          // clear the stale flag — round detail page will hide the
          // "Re-compose reel" button.
          markReelFresh(state.roundId).catch(() => {});

          // Notify subscribers (Home + round detail refetch on this) so
          // the new reel shows without a manual refresh.
          emitPipelineEvent({ type: 'compose:complete', roundId: state.roundId });

          setTimeout(() => {
            setComposing(false);
            setExportProgress(null);
            setExportModalVisible(false);
            // Land straight on the reel with the one-tap Save & Share CTA
            // instead of an alert that dumps the user back on Home.
            router.replace(`/round/${state.roundId}?exported=1`);
          }, 800);
        } else {
          throw new Error('No reel URI returned');
        }
      } catch (err) {
        setComposing(false);
        setExportProgress(null);
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error('[Editor] Compose failed:', err);
        emitPipelineEvent({
          type: 'compose:error',
          roundId: state.roundId,
          cause: composeFailureCause(msg),
        });
        if (msg.includes('native rebuild') || msg.includes('not available')) {
          Alert.alert(
            'Native Build Required',
            'The highlight reel composer needs a native build. Please rebuild: npx expo run:ios --device'
          );
        } else if (msg.includes('-11847') || /interrupt/i.test(msg) || /cancelled/i.test(msg)) {
          // -11847 = AVErrorOperationInterrupted, fired when iOS suspended
          // the export because the app stayed in the background too long.
          // The clips and trim settings are still saved — they just need
          // re-composing now that the app is foregrounded again.
          Alert.alert(
            'Export Paused',
            "Your reel was being made when the app went to the background and iOS interrupted it. Tap Export again to finish — your clips are saved.",
          );
        } else {
          Alert.alert('Export Failed', `Reel composition failed: ${msg}`);
        }
      }
      return;
    }
  }, [state, editor, selectedMusic]);

  // ---- Loading ----
  if (state.loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text
          style={{ color: theme.colors.textSecondary, marginTop: 12, fontSize: 14 }}
        >
          Loading clips...
        </Text>
      </View>
    );
  }

  // ---- Error ----
  if (state.error) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 32,
        }}
      >
        <Film size={40} color={theme.colors.textTertiary} />
        <Text
          style={{
            color: theme.colors.textSecondary,
            fontSize: 16,
            fontWeight: '600',
            textAlign: 'center',
            marginTop: 16,
          }}
        >
          {state.error}
        </Text>
        <Pressable
          onPress={() => router.replace('/(tabs)/record')}
          style={{
            marginTop: 20,
            paddingHorizontal: 24,
            paddingVertical: 12,
            backgroundColor: theme.colors.primary,
            borderRadius: theme.radius.md,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>
            Record a Round
          </Text>
        </Pressable>
        <Pressable onPress={() => router.back()} style={{ marginTop: 12 }}>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 14 }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {/* ---- HEADER (matches GolfCam: X close, title, Save, Export) ---- */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 12,
          paddingTop: insets.top + 4,
          paddingBottom: 10,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.surfaceBorder,
        }}
      >
        {/* Close */}
        <Pressable
          onPress={handleClose}
          hitSlop={12}
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            backgroundColor: theme.colors.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <X size={18} color={theme.colors.textPrimary} />
        </Pressable>

        {/* Course name + clip count (or selection status in select mode) */}
        <View style={{ alignItems: 'center', flex: 1, marginHorizontal: 8 }}>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontWeight: '700',
              fontSize: 15,
            }}
            numberOfLines={1}
          >
            {selectMode ? (isTraining ? 'Select shots' : 'Select holes') : state.courseName || 'Edit Reel'}
          </Text>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
            {selectMode
              ? (isTraining ? `${selectedClips.size} shot${selectedClips.size === 1 ? '' : 's'} selected` : `${selectedHoles.length} selected`)
              : `${totalClips} clips · ${state.holes.length} ${isTraining ? 'clubs' : 'holes'}`}
          </Text>
        </View>

        {/* Right cluster: Cancel in select mode. Select / Preview / Export
            moved to the sticky bottom bar (Henry, 4 Sep) — bigger, in the
            thumb arc, not in a cluster of small buttons up here. */}
        {selectMode ? (
          <Pressable
            onPress={exitSelectMode}
            hitSlop={8}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
            }}
          >
            <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>
              Cancel
            </Text>
          </Pressable>
        ) : (
          <View style={{ width: 34 }} />
        )}
      </View>

      {/* ---- AUTO-TRIM PROGRESS BANNER ---- */}
      {isTrimming && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 10,
            backgroundColor: 'rgba(76, 175, 80, 0.1)',
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(76, 175, 80, 0.2)',
          }}
        >
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '600', flex: 1 }}>
            Auto-trimming clips... {allClips.length - untrimmedCount} of {allClips.length}
          </Text>
        </View>
      )}

      {/* ---- SHOT-TRACER PROGRESS BANNER (config.tracer) ---- */}
      {/* Mirrors the auto-trim banner so the user knows why Export / Save /
          Share are momentarily disabled (F17). */}
      {!isTrimming && isTracing && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 10,
            backgroundColor: 'rgba(76, 175, 80, 0.1)',
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(76, 175, 80, 0.2)',
          }}
        >
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '600', flex: 1 }}>
            Adding shot tracers...
          </Text>
        </View>
      )}

      {/* ---- SCROLLABLE CONTENT ---- */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{

          paddingTop: 16,
          // Extra bottom room in select mode so the action bar doesn't
          // cover the last hole; likewise for the review-mode "Back to
          // round" bar, which is pinned over the same space.
          paddingBottom: insets.bottom + 112, // clears the sticky action bar
        }}
      >
        {/* Music selection row */}
        <Pressable
          onPress={() => {
            Haptics.selectionAsync();
            setMusicPickerVisible(true);
          }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            marginHorizontal: 16,
            marginBottom: 16,
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
          }}
        >
          <Music size={16} color={selectedMusic ? theme.colors.primary : theme.colors.textTertiary} />
          <Text
            style={{
              color: selectedMusic ? theme.colors.textPrimary : theme.colors.textTertiary,
              fontSize: 13,
              fontWeight: '600',
              flex: 1,
            }}
            numberOfLines={1}
          >
            {selectedMusic ? selectedMusic.title : 'Add Background Music'}
          </Text>
          {selectedMusic && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
                setSelectedMusic(null);
              }}
              hitSlop={8}
            >
              <XCircle size={16} color={theme.colors.textTertiary} />
            </Pressable>
          )}
        </Pressable>

        {/* Scorecard style (5 Sep) — hidden for practice, which has its own look. */}
        {!isTraining && (
          <View style={{ marginBottom: 16 }}>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginLeft: 16, marginBottom: 8 }}>
              Scorecard style
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
              {SCORECARD_TEMPLATES.map((t) => (
                <Pressable key={t.key} onPress={() => chooseTemplate(t.key)} style={{ alignItems: 'center', width: 108 }}>
                  <TemplateSwatch template={t.key} selected={scorecardTemplate === t.key} />
                  <Text style={{ color: scorecardTemplate === t.key ? theme.colors.textPrimary : theme.colors.textTertiary, fontSize: 12, fontWeight: '700', marginTop: 6 }}>{t.name}</Text>
                  <Text style={{ color: theme.colors.textTertiary, fontSize: 10 }} numberOfLines={1}>{t.blurb}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Hole sections */}
        {state.holes.map((hole) => (
          <HoleSection
            key={hole.holeNumber}
            hole={hole}
            onClipEdit={handleClipEdit}
            onRemoveClip={editor.removeClip}
            onClipLongPress={setMovingClip}
            onClipDownload={handleClipDownload}
            onHoleSave={handleHoleSave}
            onHoleShare={handleHoleShare}
            busyHoleNumber={busyHoleNumber}
            selectMode={selectMode}
            selected={selectedHoles.includes(hole.holeNumber)}
            onToggleSelect={() =>
              isTraining ? toggleClubClipsSelected(hole.holeNumber) : toggleHoleSelected(hole.holeNumber)
            }
            training={isTraining}
            selectedClipIds={isTraining ? selectedClips : undefined}
            onToggleClipSelect={isTraining ? toggleClipSelected : undefined}
          />
        ))}

        {state.holes.length === 0 && (
          <View
            style={{
              alignItems: 'center',
              paddingVertical: 40,
              paddingHorizontal: 32,
            }}
          >
            <Film size={40} color={theme.colors.textTertiary} />
            <Text
              style={{
                color: theme.colors.textTertiary,
                fontSize: 15,
                textAlign: 'center',
                marginTop: 12,
              }}
            >
              No clips recorded for this round
            </Text>
          </View>
        )}
      </ScrollView>

      {/* ---- SELECT-MODE ACTION BAR ---- */}
      {/* Fixed bar over the bottom while picking holes for a custom reel.
          Save stitches the selected holes into one video saved to Photos;
          Share opens the iOS share sheet (Instagram, Snap, Messages, etc.). */}
      {selectMode && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
            backgroundColor: theme.colors.surface,
            borderTopWidth: 1,
            borderTopColor: theme.colors.surfaceBorder,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: '700' }}>
              {selectedHoles.length === 0
                ? 'Pick holes for a highlight'
                : `${selectedHoles.length} hole${selectedHoles.length > 1 ? 's' : ''} selected`}
            </Text>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
              {selectionBusy ? 'Building your highlight…' : 'Save to Photos or share'}
            </Text>
          </View>

          {/* Save to Photos */}
          <Pressable
            onPress={handleSaveSelected}
            disabled={selectedHoles.length === 0 || selectionBusy}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 14,
              paddingVertical: 11,
              borderRadius: 10,
              backgroundColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              opacity: selectedHoles.length === 0 || selectionBusy ? 0.4 : 1,
            }}
          >
            {selectionBusy ? (
              <ActivityIndicator size="small" color={theme.colors.textPrimary} />
            ) : (
              <Download size={16} color={theme.colors.textPrimary} />
            )}
            <Text style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: '700' }}>
              Save
            </Text>
          </Pressable>

          {/* Share */}
          <Pressable
            onPress={handleShareSelected}
            disabled={selectedHoles.length === 0 || selectionBusy}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 16,
              paddingVertical: 11,
              borderRadius: 10,
              backgroundColor: theme.colors.primary,
              opacity: selectedHoles.length === 0 || selectionBusy ? 0.4 : 1,
            }}
          >
            <Share2 size={16} color="#000" />
            <Text style={{ color: '#000', fontSize: 14, fontWeight: '800' }}>Share</Text>
          </Pressable>
        </View>
      )}

      {/* ---- STICKY ACTION BAR: Select · Preview · Export / Back to round ---- */}
      {!selectMode && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
            backgroundColor: theme.colors.surface,
            borderTopWidth: 1,
            borderTopColor: theme.colors.surfaceBorder,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setSelectMode(true);
            }}
            disabled={hasUntrimmedClips || isTracing || totalClips === 0}
            style={{
              flex: 1,
              height: 56,
              borderRadius: 14,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              backgroundColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              opacity: hasUntrimmedClips || isTracing || totalClips === 0 ? 0.4 : 1,
            }}
          >
            <ListChecks size={18} color={theme.colors.textPrimary} />
            <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '700' }}>Select</Text>
          </Pressable>
          <Pressable
            onPress={handlePreviewAll}
            disabled={hasUntrimmedClips}
            style={{
              flex: 1,
              height: 56,
              borderRadius: 14,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              opacity: hasUntrimmedClips ? 0.4 : 1,
            }}
          >
            <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '700' }}>Preview</Text>
          </Pressable>
          {isReview ? (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                backToRound();
              }}
              style={{ flex: 1.3, height: 56, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: theme.colors.primary }}
            >
              <ArrowLeft size={18} color="#000" />
              <Text style={{ color: '#000', fontSize: 15, fontWeight: '800' }}>Back to round</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={handleExportPress}
              disabled={hasUntrimmedClips || isTracing}
              style={{
                flex: 1.3,
                height: 56,
                borderRadius: 14,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                backgroundColor: theme.colors.primary,
                opacity: hasUntrimmedClips || isTracing ? 0.4 : 1,
              }}
            >
              <Upload size={18} color="#000" />
              <Text style={{ color: '#000', fontSize: 15, fontWeight: '800' }}>Export</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* ---- BACK TO ROUND (review mode) — folded into the sticky bar above ---- */}
      {/* The golfer is standing on a tee, one-handed, in sunlight: the way
          back to the live round has to be pinned in the thumb arc, not a
          14px X in the top-left corner. Hidden in select mode so it can't
          sit under that bar. Deliberately no "Leave Editor?" confirm —
          going back to your own round in progress isn't leaving anything,
          and edits are already saved as a draft. */}
      {false && isReview && !selectMode && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
            backgroundColor: theme.colors.surface,
            borderTopWidth: 1,
            borderTopColor: theme.colors.surfaceBorder,
          }}
        >
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              backToRound();
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              // 56pt tall — a gloved/sweaty thumb target, not a 44pt minimum.
              height: 56,
              borderRadius: 14,
              backgroundColor: theme.colors.primary,
            }}
          >
            <ArrowLeft size={20} color="#000" />
            <Text style={{ color: '#000', fontSize: 17, fontWeight: '800' }}>
              Back to round
            </Text>
          </Pressable>
        </View>
      )}

      {/* Trim modal */}
      <ClipTrimModal
        visible={!!trimClip}
        clip={trimClip}
        onSave={(startMs, endMs, sourceOverride) => {
          if (trimClip) {
            editor.updateTrim(trimClip.id, startMs, endMs, sourceOverride);
          }
          setTrimClip(null);
        }}
        onDismiss={() => setTrimClip(null)}
        // 4 Sep, Henry: swipe left/right inside the trimmer to move to the
        // next/previous shot on the same hole. The current trim is applied
        // (offsets) before moving so nothing is lost on the way.
        positionLabel={(() => {
          if (!trimClip) return undefined;
          const clips = state.holes.find((h) => h.holeNumber === trimClip.holeNumber)?.clips ?? [];
          const i = clips.findIndex((c) => c.id === trimClip.id);
          return i >= 0 ? `${isTraining ? trainingHoleLabel(trimClip.holeNumber) : `Hole ${trimClip.holeNumber}`} · Shot ${i + 1} of ${clips.length}` : undefined;
        })()}
        // Swipes and chevrons walk the WHOLE round in play order — the last
        // shot of hole 10 leads to the first of hole 11 (Henry, 4 Sep: "they
        // shouldn't be confined to that hole's shots").
        hasPrev={!!trimClip && flatClips.findIndex((c) => c.id === trimClip.id) > 0}
        hasNext={!!trimClip && flatClips.findIndex((c) => c.id === trimClip.id) < flatClips.length - 1}
        onNavigate={(dir, startMs, endMs) => {
          if (!trimClip) return;
          const i = flatClips.findIndex((c) => c.id === trimClip.id);
          const next = flatClips[i + (dir === 'next' ? 1 : -1)];
          if (!next) return;
          editor.updateTrim(trimClip.id, startMs, endMs);
          Haptics.selectionAsync();
          setTrimClip(next);
        }}
      />

      {/* Clip actions menu (long-press a clip): move to a different hole,
          exclude/include from the reel, or delete. Move-to-hole is the
          headline action — it's how you fix a clip that auto-landed on the
          wrong hole. */}
      <Modal
        visible={!!movingClip}
        transparent
        animationType="fade"
        onRequestClose={() => setMovingClip(null)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}
          onPress={() => setMovingClip(null)}
        >
          <Pressable
            style={{
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 20,
              paddingBottom: insets.bottom + 20,
            }}
            onPress={(e) => e.stopPropagation()}
          >
            {movingClip && (
              <>
                <Text
                  style={{
                    color: theme.colors.textPrimary,
                    fontSize: 17,
                    fontWeight: '700',
                    marginBottom: 2,
                  }}
                >
                  Stroke {movingClip.shotNumber}
                </Text>
                <Text style={{ color: theme.colors.textTertiary, fontSize: 13, marginBottom: 16 }}>
                  Currently on Hole {movingClip.holeNumber}
                </Text>

                {/* Move to hole */}
                <Text
                  style={{
                    ...theme.typography.caption,
                    color: theme.colors.textTertiary,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    marginBottom: 8,
                  }}
                >
                  {isTraining ? 'Move to club' : 'Move to hole'}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginBottom: 18 }}
                  contentContainerStyle={{ gap: 8, paddingRight: 8 }}
                >
                  {/* Training: offer EVERY club, not just ones with clips —
                      moveClipToHole creates the target section if missing,
                      and re-filing a bulk import is exactly when the target
                      club has nothing in it yet. */}
                  {(isTraining
                    ? CLUBS.map((c) => ({ holeNumber: c.holeNumber, label: c.short }))
                    : state.holes.map((h) => ({ holeNumber: h.holeNumber, label: String(h.holeNumber) }))
                  )
                    .filter((h) => h.holeNumber !== movingClip.holeNumber)
                    .map((h) => (
                      <Pressable
                        key={h.holeNumber}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          editor.moveClipToHole(movingClip.id, h.holeNumber);
                          setMovingClip(null);
                        }}
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: 12,
                          backgroundColor: theme.colors.surfaceElevated,
                          borderWidth: 1,
                          borderColor: theme.colors.surfaceBorder,
                          justifyContent: 'center',
                          alignItems: 'center',
                        }}
                      >
                        <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '700' }}>
                          {h.label}
                        </Text>
                      </Pressable>
                    ))}
                  {state.holes.filter((h) => h.holeNumber !== movingClip.holeNumber).length === 0 && (
                    <Text style={{ color: theme.colors.textTertiary, fontSize: 13, paddingVertical: 16 }}>
                      No other holes yet.
                    </Text>
                  )}
                </ScrollView>

                {/* Change the shot's number within its hole (4 Sep, Henry). */}
                {(() => {
                  const n = state.holes.find((h) => h.holeNumber === movingClip.holeNumber)?.clips.length ?? 1;
                  if (n < 2) return null;
                  return (
                    <>
                      <Text
                        style={{
                          ...theme.typography.caption,
                          color: theme.colors.textTertiary,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 8,
                        }}
                      >
                        {isTraining ? 'Shot order' : 'Shot number on this hole'}
                      </Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={{ marginBottom: 18 }}
                        contentContainerStyle={{ gap: 8, paddingRight: 8 }}
                      >
                        {Array.from({ length: n }, (_, i) => i + 1).map((num) => {
                          const current = num === movingClip.shotNumber;
                          return (
                            <Pressable
                              key={num}
                              disabled={current}
                              onPress={() => {
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                editor.setClipShotNumber(movingClip.id, num);
                                setMovingClip(null);
                              }}
                              style={{
                                width: 52,
                                height: 52,
                                borderRadius: 12,
                                backgroundColor: current ? theme.colors.primary : theme.colors.surfaceElevated,
                                borderWidth: 1,
                                borderColor: current ? theme.colors.primary : theme.colors.surfaceBorder,
                                justifyContent: 'center',
                                alignItems: 'center',
                              }}
                            >
                              <Text style={{ color: current ? '#fff' : theme.colors.textPrimary, fontSize: 16, fontWeight: '700' }}>
                                {num}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                    </>
                  );
                })()}

                {/* Exclude / include + delete */}
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    editor.toggleExclude(movingClip.id);
                    setMovingClip(null);
                  }}
                  style={menuRowStyle}
                >
                  <XCircle size={18} color={theme.colors.textSecondary} />
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}>
                    {movingClip.isExcluded ? 'Include in reel' : 'Exclude from reel'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const c = movingClip;
                    setMovingClip(null);
                    // Let this sheet finish dismissing before Photos asks for
                    // permission / presents anything of its own.
                    setTimeout(() => void handleClipDownload(c), 400);
                  }}
                  style={menuRowStyle}
                >
                  <Download size={18} color={theme.colors.textPrimary} />
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}>
                    Save to Photos
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const c = movingClip;
                    setMovingClip(null);
                    if (!c.sourceUri) return;
                    // iOS refuses to present the share sheet while this modal
                    // is still animating away — which is why "Share this shot"
                    // silently did nothing. Wait for the dismiss, then present,
                    // and say so if the file is gone.
                    setTimeout(async () => {
                      const ok = await shareClip(c.sourceUri!, `${isTraining ? trainingHoleLabel(c.holeNumber) : `Hole ${c.holeNumber}`} · Shot ${c.shotNumber}`);
                      if (!ok) Alert.alert('Could not share', 'This clip\u2019s file is missing or the share sheet could not open.');
                    }, 450);
                  }}
                  style={menuRowStyle}
                >
                  <Share2 size={18} color={theme.colors.textPrimary} />
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}>
                    Share this shot
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const id = movingClip.id;
                    setMovingClip(null);
                    Alert.alert('Delete clip', 'Remove this clip from the round? You can put it back from Profile \u2192 Recently deleted.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => editor.removeClip(id) },
                    ]);
                  }}
                  style={menuRowStyle}
                >
                  <X size={18} color={theme.colors.accentRed} />
                  <Text style={{ color: theme.colors.accentRed, fontSize: 15, fontWeight: '600' }}>
                    Delete clip
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => setMovingClip(null)}
                  style={{ paddingVertical: 14, alignItems: 'center', marginTop: 4 }}
                >
                  <Text style={{ color: theme.colors.textTertiary, fontSize: 15, fontWeight: '600' }}>
                    Cancel
                  </Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Music picker */}
      <MusicPicker
        visible={musicPickerVisible}
        selectedTrackId={selectedMusic?.id ?? null}
        onSelect={(track) => {
          setSelectedMusic(track ? { id: track.id, title: track.title, file_url: track.file_url } : null);
          setMusicPickerVisible(false);
        }}
        onDismiss={() => setMusicPickerVisible(false)}
      />

      {/* Export Settings Modal */}
      <Modal
        visible={exportModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setExportModalVisible(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}
          onPress={() => setExportModalVisible(false)}
        >
          <Pressable
            onPress={() => {}} // Prevent closing when tapping inside the sheet
            style={{
              backgroundColor: theme.colors.background,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: insets.bottom + 20,
            }}
          >
            {/* Handle bar */}
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.colors.surfaceBorder,
                alignSelf: 'center',
                marginBottom: 20,
              }}
            />

            <Text style={{ color: theme.colors.textPrimary, fontWeight: '800', fontSize: 18, marginBottom: 20 }}>
              Export Settings
            </Text>

            {/* Resolution & frame-rate pickers removed — never wired into the
                native composer. The reel inherits the source clips' resolution
                and frame rate (1080p / 30fps from the iPhone camera by
                default), so exposing a "4K vs 720p" choice was misleading. */}

            <View
              style={{
                backgroundColor: theme.colors.surfaceElevated,
                borderRadius: theme.radius.md,
                padding: 12,
                marginBottom: 20,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <Monitor size={16} color={theme.colors.primary} />
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12, flex: 1 }}>
                Composed on your phone — stitches clips, adds scorecard overlay and background music.
              </Text>
            </View>

            {/* Composing progress */}
            {composing && (
              <View
                style={{
                  marginBottom: 16,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  backgroundColor: theme.colors.surfaceElevated,
                  borderRadius: theme.radius.md,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                  }}
                >
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>
                    {composeProgress}
                  </Text>
                </View>

                {/* Progress bar */}
                {exportProgress && (
                  <View
                    style={{
                      marginTop: 10,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: 'rgba(255,255,255,0.1)',
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      style={{
                        height: '100%',
                        borderRadius: 3,
                        backgroundColor: theme.colors.primary,
                        width: `${Math.min(100, Math.max(0, exportProgress.percent))}%`,
                      }}
                    />
                  </View>
                )}
              </View>
            )}

            {/* Export button */}
            <Pressable
              onPress={handleExportConfirm}
              disabled={composing}
              style={{
                backgroundColor: composing ? theme.colors.surfaceBorder : theme.colors.primary,
                paddingVertical: 16,
                borderRadius: theme.radius.lg,
                alignItems: 'center',
                opacity: composing ? 0.6 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>
                {composing ? 'Composing...' : 'Create Highlight Reel'}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
