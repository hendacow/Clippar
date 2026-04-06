import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Image,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Plus, XCircle, Film, Upload, Music } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { useEditorState } from '@/hooks/useEditorState';
import { useUploadContext } from '@/contexts/UploadContext';
import { ClipTrimModal } from '@/components/editor/ClipTrimModal';
import { MusicPicker } from '@/components/editor/MusicPicker';
import type { EditorClip, EditorHoleSection } from '@/types/editor';

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

// ---- Clip Card (matches GolfCam style) ----
function ClipCard({
  clip,
  onEdit,
  onRemove,
  onToggleExclude,
}: {
  clip: EditorClip;
  onEdit: () => void;
  onRemove: () => void;
  onToggleExclude: () => void;
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
          if (clip.isExcluded) return;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onEdit();
        }}
        onLongPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          onToggleExclude();
        }}
        delayLongPress={500}
      >
        <View
          style={{
            width: 100,
            height: 140,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surface,
            overflow: 'hidden',
            opacity: clip.isExcluded ? 0.4 : 1,
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

          {/* "Edit" or "Excluded" label at bottom */}
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              paddingVertical: 6,
              backgroundColor: clip.isExcluded ? 'rgba(180,0,0,0.7)' : 'rgba(0,0,0,0.6)',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: '#fff',
                fontSize: 12,
                fontWeight: '600',
                textDecorationLine: clip.isExcluded ? 'line-through' : 'none',
              }}
            >
              {clip.isExcluded ? 'Excluded' : 'Edit'}
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
  onToggleExclude,
}: {
  hole: EditorHoleSection;
  onClipEdit: (clip: EditorClip) => void;
  onRemoveClip: (clipId: string) => void;
  onToggleExclude: (clipId: string) => void;
}) {
  return (
    <View style={{ marginBottom: 24 }}>
      {/* Hole header — bold left-aligned like GolfCam */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          paddingHorizontal: 16,
          marginBottom: 10,
          gap: 12,
        }}
      >
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
      </View>

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
            onToggleExclude={() => onToggleExclude(clip.id)}
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
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  const insets = useSafeAreaInsets();
  const editor = useEditorState(roundId);
  const { startUpload } = useUploadContext();
  const { state } = editor;

  const totalClips = state.holes.reduce((sum, h) => sum + h.clips.length, 0);
  const [trimClip, setTrimClip] = useState<EditorClip | null>(null);
  const [exporting, setExporting] = useState(false);
  const [musicPickerVisible, setMusicPickerVisible] = useState(false);
  const [selectedMusic, setSelectedMusic] = useState<{ id: string; title: string; file_url?: string | null } | null>(null);

  const handleClipEdit = useCallback((clip: EditorClip) => {
    setTrimClip(clip);
  }, []);

  const handlePreviewAll = useCallback(() => {
    if (totalClips === 0) return;
    router.push({
      pathname: '/round/preview',
      params: { roundId: state.roundId, startIndex: '0' },
    });
  }, [state.roundId, totalClips]);

  const handleExport = useCallback(async () => {
    const allClips = editor.getAllClipsInOrder();
    const clipsWithPaths = allClips.filter((c) => c.storagePath);

    if (clipsWithPaths.length === 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (isNative) {
        Alert.alert('No Clips', 'Upload your clips first before exporting a highlight reel.');
      }
      return;
    }

    setExporting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      if (config.concat.url) {
        // Concat service available — send clips for server-side stitching
        const response = await fetch(`${config.concat.url}/api/concat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roundId: state.roundId,
            musicTrackId: selectedMusic?.id ?? null,
            clips: clipsWithPaths.map((c) => ({
              storagePath: c.storagePath,
              trimStartMs: c.trimStartMs,
              trimEndMs: c.trimEndMs,
            })),
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Export failed' }));
          throw new Error(err.error || 'Export failed');
        }

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (isNative) {
          Alert.alert('Export Started', 'Your highlight reel is being processed. You\'ll be notified when it\'s ready.', [
            { text: 'OK', onPress: () => router.replace(`/round/${state.roundId}`) },
          ]);
        } else {
          router.replace(`/round/${state.roundId}`);
        }
      } else {
        // No concat service — trigger upload pipeline as fallback
        startUpload(state.roundId, state.courseName);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (isNative) {
          Alert.alert('Clips Uploading', 'Your clips are being uploaded. You can edit the reel once processing is complete.', [
            { text: 'OK', onPress: () => router.replace('/(tabs)') },
          ]);
        } else {
          router.replace('/(tabs)');
        }
      }
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (isNative) {
        Alert.alert('Export Failed', err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setExporting(false);
    }
  }, [editor, state.roundId, state.courseName, selectedMusic, startUpload]);

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
          onPress={() => router.back()}
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

        {/* Course name + clip count */}
        <View style={{ alignItems: 'center', flex: 1, marginHorizontal: 8 }}>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontWeight: '700',
              fontSize: 15,
            }}
            numberOfLines={1}
          >
            {state.courseName || 'Edit Reel'}
          </Text>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
            {totalClips} clips · {state.holes.length} holes
          </Text>
        </View>

        {/* Preview + Export buttons */}
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Pressable
            onPress={handlePreviewAll}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
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

          <Pressable
            onPress={handleExport}
            disabled={exporting}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: '#000',
            }}
          >
            {exporting ? (
              <ActivityIndicator size={12} color="#fff" />
            ) : (
              <Upload size={13} color="#fff" />
            )}
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
              {exporting ? '...' : 'Export'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* ---- SCROLLABLE CONTENT ---- */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: 16,
          paddingBottom: insets.bottom + 80,
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
            onToggleExclude={editor.toggleExclude}
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

      {/* Trim modal */}
      <ClipTrimModal
        visible={!!trimClip}
        clip={trimClip}
        onSave={(startMs, endMs) => {
          if (trimClip) {
            editor.updateTrim(trimClip.id, startMs, endMs);
          }
          setTrimClip(null);
        }}
        onDismiss={() => setTrimClip(null)}
      />

      {/* Music picker */}
      <MusicPicker
        visible={musicPickerVisible}
        selectedTrackId={selectedMusic?.id ?? null}
        onSelect={(track) => {
          setSelectedMusic(track ? { id: track.id, title: track.title } : null);
          setMusicPickerVisible(false);
        }}
        onDismiss={() => setMusicPickerVisible(false)}
      />
    </View>
  );
}
