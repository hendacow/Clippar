import { useState, useCallback, useEffect, useRef } from 'react';
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
import { X, Plus, XCircle, Film, Upload, Music, Monitor, Check, Download, Share2, ListChecks, CircleCheck, Circle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { useEditorState } from '@/hooks/useEditorState';
import { emitPipelineEvent } from '@/lib/pipelineEvents';
import { composeFailureCause, FAILURE_CAUSE } from '@/lib/roundStatusLogic';
import { ClipTrimModal } from '@/components/editor/ClipTrimModal';
import { MusicPicker, type MusicTrack } from '@/components/editor/MusicPicker';
import type { EditorClip, EditorHoleSection } from '@/types/editor';
import { composeReel, addStitchProgressListener, type ScorecardData, type StitchProgressEvent } from '@/modules/shot-detector';
import { updateRound, getSignedClipUrls } from '@/lib/api';
import { markReelFresh } from '@/lib/storage';
import { saveClipToPhotos, saveHoleToPhotos, shareHole, stitchHoleClips, shareClip } from '@/lib/clipShare';
// `uploadReelToStorage` is now invoked lazily by the share-link flow rather
// than at compose time. Imported there, not here.
import { resolveTrackToLocalUri } from '@/lib/music';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

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
}: {
  clip: EditorClip;
  onEdit: () => void;
  onRemove: () => void;
  onLongPress: () => void;
  onDownload: () => void;
  /** Select mode: per-clip actions are inert; a tap toggles the hole. */
  disabled?: boolean;
  onPressWhenDisabled?: () => void;
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

  return (
    <View style={{ width: 100, marginRight: 10 }}>
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

          {/* Remove button (top-right X) */}
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onRemove();
            }}
            hitSlop={6}
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
            }}
          >
            <XCircle size={18} color="rgba(255,255,255,0.8)" fill="rgba(0,0,0,0.5)" />
          </Pressable>

          {/* Download button (top-right, below the X) — saves this single
              clip to the user's Photos library. Hidden while clip is
              waiting for auto-trim or has no playable file. */}
          {!clip.needsTrim && clip.sourceUri && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onDownload();
              }}
              hitSlop={6}
              style={{
                position: 'absolute',
                top: 26,
                right: 3,
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: 'rgba(0,0,0,0.55)',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Download size={12} color="rgba(255,255,255,0.95)" />
            </Pressable>
          )}

          {/* Bottom label: "Edit", "Excluded", or "Trimmed" badge */}
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              paddingVertical: 6,
              backgroundColor: clip.isExcluded
                ? 'rgba(180,0,0,0.7)'
                : clip.autoTrimmed && !clip.needsTrim
                  ? 'rgba(46,125,50,0.85)'
                  : 'rgba(0,0,0,0.6)',
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 3,
            }}
          >
            {clip.autoTrimmed && !clip.needsTrim && !clip.isExcluded && (
              <Check size={12} color="#fff" />
            )}
            <Text
              style={{
                color: '#fff',
                fontSize: 12,
                fontWeight: '600',
                textDecorationLine: clip.isExcluded ? 'line-through' : 'none',
              }}
            >
              {clip.isExcluded ? 'Excluded' : clip.autoTrimmed && !clip.needsTrim ? 'Trimmed' : 'Edit'}
            </Text>
          </View>
        </View>
      </Pressable>
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
  selected: boolean;
  onToggleSelect: () => void;
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
          Hole {hole.holeNumber}
        </Text>
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontSize: 16,
            fontWeight: '700',
          }}
        >
          Par {hole.par}
        </Text>
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontSize: 16,
            fontWeight: '700',
          }}
        >
          Score {hole.strokes}
        </Text>

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
                width: 28,
                height: 28,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                backgroundColor: theme.colors.surfaceElevated,
                justifyContent: 'center',
                alignItems: 'center',
                opacity: isBusy ? 0.5 : 1,
              }}
            >
              {isBusy ? (
                <ActivityIndicator size="small" color={theme.colors.textPrimary} />
              ) : (
                <Download size={14} color={theme.colors.textPrimary} />
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onHoleShare(hole);
              }}
              disabled={isBusy}
              hitSlop={8}
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                backgroundColor: theme.colors.surfaceElevated,
                justifyContent: 'center',
                alignItems: 'center',
                opacity: isBusy ? 0.5 : 1,
              }}
            >
              <Share2 size={14} color={theme.colors.textPrimary} />
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
            // whole hole, so per-clip edit/remove/long-press are inert.
            disabled={selectMode}
            onPressWhenDisabled={onToggleSelect}
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

// ---- Intro/Outro placeholder ----
function SlotCard({ label }: { label: string }) {
  return (
    <View
      style={{
        width: 100,
        height: 130,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.colors.surfaceBorder,
        borderStyle: 'dashed',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Plus size={20} color={theme.colors.textTertiary} />
      <Text
        style={{
          color: theme.colors.textTertiary,
          fontSize: 12,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// ============================================================
// MAIN EDITOR SCREEN
// ============================================================
export default function EditorScreen() {
  const { roundId, recompose, review } = useLocalSearchParams<{ roundId: string; recompose?: string; review?: string }>();
  // Review mode: opened mid-round from the recording screen's "Review round
  // so far". Hides the final Export action so the user can't accidentally
  // finalize a reel while the round is still in progress.
  const isReview = review === '1';
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

  // Gather the usable clip URIs for the selected holes, in hole then shot
  // order. Excluded / still-trimming clips are skipped.
  const collectSelectedUris = useCallback((): string[] => {
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
  }, [selectedHoles, state.holes]);

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
          `Highlight saved to Photos — ${selectedHoles.length} hole${selectedHoles.length > 1 ? 's' : ''}, ${uris.length} clip${uris.length > 1 ? 's' : ''}.`,
        );
        exitSelectMode();
      } else {
        Alert.alert('Save Failed', 'Could not stitch + save the highlight. Check Photos access in Settings and try again.');
      }
    } finally {
      setSelectionBusy(false);
    }
  }, [collectSelectedUris, selectedHoles.length, exitSelectMode, isTracing]);

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
      const label = [...selectedHoles].sort((a, b) => a - b).join(', ');
      await shareClip(stitched, `Holes ${label} – ${state.courseName || 'Round'}`);
    } finally {
      setSelectionBusy(false);
    }
  }, [collectSelectedUris, selectedHoles, state.courseName, isTracing]);

  const handlePreviewAll = useCallback(() => {
    if (hasUntrimmedClips) {
      Alert.alert(
        'Auto-Trim in Progress',
        'Please wait — clips are still being auto-trimmed. This usually takes a few seconds per clip.'
      );
      return;
    }
    if (totalClips === 0) return;
    router.push({
      pathname: '/round/preview',
      params: { roundId: state.roundId, startIndex: '0' },
    });
  }, [state.roundId, totalClips, hasUntrimmedClips]);

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

    // Pro gate (config.subscription.enforceExportGate — OFF until StoreKit
    // IAP ships; flipping it without purchases would lock exports for all).
    if (config.subscription.enforceExportGate) {
      const isPro = await getProStatus().catch(() => false);
      if (!isPro) {
        setExportModalVisible(false);
        router.push('/paywall');
        return;
      }
    }

    if (exportMode === 'local-compose') {
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

      setComposing(true);
      setComposeProgress('Checking clip files...');
      // Broadcast to the pipeline bus so Home / round detail can render
      // live compose state (and the 30s watchdog can supervise it).
      emitPipelineEvent({
        type: 'compose:start',
        roundId: state.roundId,
        courseName: state.courseName ?? null,
      });

      // Verify clip files exist on disk; for any that are missing, try to
      // recover by downloading from Supabase Storage. iOS routinely evicts
      // files from the app's tmp directory (especially after reinstall or
      // background purges), so clips that were uploaded remain recoverable
      // even though the local path is gone. Only clips that never uploaded
      // AND are missing locally are dropped.
      let validClipUris = clipUris;
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

        if (missingRecoverable.length > 0) {
          console.warn(
            `[Editor] ${missingRecoverable.length} clip(s) missing locally — re-downloading from Supabase`
          );
          setComposeProgress(
            `Recovering ${missingRecoverable.length} missing clip${missingRecoverable.length > 1 ? 's' : ''}...`
          );

          const paths = missingRecoverable.map(({ clip }) => clip.storagePath!);
          const signed = await getSignedClipUrls(paths);

          const cacheDir = `${FileSystem.cacheDirectory}recovered-clips/`;
          try {
            const dirInfo = await FileSystem.getInfoAsync(cacheDir);
            if (!dirInfo.exists) {
              await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
            }
          } catch {}

          // Download each missing clip to the cache dir and patch the uri.
          const recoveredUris = new Map<number, string>();
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

          // Rebuild validClipUris preserving order.
          validClipUris = orderedForCompose.map((c, idx) => {
            if (existence[idx]) return c.sourceUri!;
            const recovered = recoveredUris.get(idx);
            return recovered ?? null;
          }).filter((u): u is string => u !== null);
        } else {
          validClipUris = existence
            .map((exists, idx) => (exists ? orderedForCompose[idx].sourceUri! : null))
            .filter((u): u is string => u !== null);
        }

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
        // Build scorecard data with per-hole timing
        let cumulativeMs = 0;
        const scorecardHoles = state.holes.map((hole) => {
          const holeClips = hole.clips.filter((c) => !c.isExcluded);
          const holeDurationMs = holeClips.reduce((sum, c) => {
            // Pre-trimmed clips: sourceUri IS the trim file, so its
            // durationMs (now correctly written by markClipTrimmed) is
            // the right number. trimEndMs - trimStartMs would give the
            // same value but in original-timeline coords, which are
            // duplicate info — use durationMs as the source of truth.
            const isPreTrimmed = !!(c.autoTrimmed && c.originalUri);
            const dur = isPreTrimmed
              ? c.durationMs
              : (c.trimEndMs === -1 ? c.durationMs : (c.trimEndMs - c.trimStartMs));
            return sum + dur;
          }, 0);
          const startMs = cumulativeMs;
          cumulativeMs += holeDurationMs;
          return {
            holeNumber: hole.holeNumber,
            par: hole.par,
            strokes: hole.strokes,
            startMs,
            endMs: cumulativeMs,
          };
        });

        const scorecardData: ScorecardData = {
          courseName: state.courseName || 'Round',
          totalPar: state.holes.reduce((sum, h) => sum + h.par, 0),
          totalStrokes: state.holes.reduce((sum, h) => sum + h.strokes, 0),
          holes: scorecardHoles,
        };

        // Resolve music to a local file path the native engine can read
        let musicFileUri: string | null = null;
        if (selectedMusic) {
          setComposeProgress('Preparing music track...');
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
        // Map each entry in `validClipUris` (which may include recovered
        // URIs that differ from clip.sourceUri) back to its EditorClip so
        // we can attach trim bounds. Walk both lists in order and skip
        // any orderedForCompose entry whose URI didn't make it into
        // validClipUris (i.e. dropped during recovery as unrecoverable).
        const orderedForCompose = allClips.filter((c) => c.sourceUri);
        const composeClips: { uri: string; trimStartMs: number; trimEndMs: number }[] = [];
        let orderedIdx = 0;
        for (const uri of validClipUris) {
          // Advance the source pointer to the next clip whose original
          // sourceUri matches OR whose id is implicitly recovered. Since
          // both arrays preserve order and the recovery flow keeps clips
          // in their original positions (just rewriting URIs), aligning
          // by index is correct as long as we step orderedIdx forward.
          let clip: EditorClip | undefined = orderedForCompose[orderedIdx];
          // Skip past any clips that were dropped (unrecoverable) so we
          // land on the one that produced this URI.
          while (
            clip &&
            clip.sourceUri !== uri &&
            !uri.includes(`${clip.id}.mp4`)
          ) {
            orderedIdx++;
            clip = orderedForCompose[orderedIdx];
          }
          // When a clip has been auto-trimmed (or the user re-trimmed),
          // sourceUri IS the trim file already and trimStartMs/trimEndMs
          // are bounds in the ORIGINAL video's timeline — out-of-range
          // for the trim file. Pass full range so the native composer
          // uses the entire pre-trimmed clip.
          const isPreTrimmed = !!(clip?.autoTrimmed && clip?.originalUri);
          composeClips.push({
            uri,
            trimStartMs: isPreTrimmed ? 0 : (clip?.trimStartMs ?? 0),
            trimEndMs: isPreTrimmed ? -1 : (clip?.trimEndMs ?? -1),
          });
          orderedIdx++;
        }
        console.log(
          `[Editor:Compose] composeClips trim ranges:`,
          composeClips.map((c, i) => `[${i}] ${c.trimStartMs}..${c.trimEndMs}`).join(', '),
        );

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
            {selectMode ? 'Select holes' : state.courseName || 'Edit Reel'}
          </Text>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
            {selectMode
              ? `${selectedHoles.length} selected`
              : `${totalClips} clips · ${state.holes.length} holes`}
          </Text>
        </View>

        {/* Right cluster: in select mode just a Done/Cancel; otherwise
            Select + Preview + Export. */}
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
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {/* Select holes → custom highlight */}
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setSelectMode(true);
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: theme.colors.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                opacity: hasUntrimmedClips || isTracing || totalClips === 0 ? 0.4 : 1,
              }}
              disabled={hasUntrimmedClips || isTracing || totalClips === 0}
            >
              <ListChecks size={13} color={theme.colors.textPrimary} />
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>
                Select
              </Text>
            </Pressable>

            <Pressable
              onPress={handlePreviewAll}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: theme.colors.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                opacity: hasUntrimmedClips ? 0.4 : 1,
              }}
            >
              <Text
                style={{
                  color: theme.colors.textPrimary,
                  fontSize: 13,
                  fontWeight: '600',
                }}
              >
                Preview
              </Text>
            </Pressable>

            {/* Export hidden in review mode (round still in progress) — the
                user is just checking/fixing clips, not finalizing the reel. */}
            {!isReview && (
              <Pressable
                onPress={handleExportPress}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 8,
                  backgroundColor: '#000',
                  opacity: hasUntrimmedClips || isTracing ? 0.4 : 1,
                }}
              >
                <Upload size={13} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
                  Export
                </Text>
              </Pressable>
            )}
          </View>
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
          // cover the last hole.
          paddingBottom: insets.bottom + (selectMode ? 120 : 80),
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

        {/* Intro / Outro slots */}
        <View
          style={{
            flexDirection: 'row',
            gap: 12,
            paddingHorizontal: 16,
            marginBottom: 24,
          }}
        >
          <SlotCard label="Intro" />
          <SlotCard label="Outro" />
        </View>

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
            onToggleSelect={() => toggleHoleSelected(hole.holeNumber)}
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
                  Move to hole
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginBottom: 18 }}
                  contentContainerStyle={{ gap: 8, paddingRight: 8 }}
                >
                  {state.holes
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
                          {h.holeNumber}
                        </Text>
                      </Pressable>
                    ))}
                  {state.holes.filter((h) => h.holeNumber !== movingClip.holeNumber).length === 0 && (
                    <Text style={{ color: theme.colors.textTertiary, fontSize: 13, paddingVertical: 16 }}>
                      No other holes yet.
                    </Text>
                  )}
                </ScrollView>

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
                    const id = movingClip.id;
                    setMovingClip(null);
                    Alert.alert('Delete clip', 'Remove this clip from the round?', [
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
