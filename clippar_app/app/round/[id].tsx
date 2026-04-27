import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Platform,
  ScrollView,
  Animated,
  Alert,
  ActivityIndicator,
  StyleSheet,
  Image,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Share2,
  Trash2,
  Play,
  Loader,
  Upload,
  Film,
  ChevronDown,
  ChevronUp,
  XCircle,
  RefreshCw,
  Download,
  Check,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { PreviewPlayer } from '@/components/editor/PreviewPlayer';
import { ShareSheet } from '@/components/shared/ShareSheet';
import { ClipTrimModal } from '@/components/editor/ClipTrimModal';
import { getRound, deleteRound } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { isReelStale } from '@/lib/storage';
import { saveToGallery } from '@/lib/sharing';
import { useUploadContext } from '@/contexts/UploadContext';
import { useEditorState } from '@/hooks/useEditorState';
import type { EditorClip } from '@/types/editor';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const VideoThumbnails = isNative
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

// ---- Animated progress bar for processing ----
function ProcessingProgress({ upload }: { upload: { stage: string; currentClip: number; totalClips: number; progress: number; stageLabel: string } }) {
  const progressAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: upload.progress / 100,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [upload.progress]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 0.6, duration: 800, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const isUploading = upload.stage === 'uploading';
  const isProcessing = upload.stage === 'processing';
  const isSubmitting = upload.stage === 'submitting';

  let eta = '';
  if (isUploading && upload.totalClips > 0 && upload.currentClip > 0) {
    const remaining = upload.totalClips - upload.currentClip;
    const secs = remaining * 8;
    eta = secs < 60 ? `~${secs}s left` : `~${Math.ceil(secs / 60)} min left`;
  } else if (isProcessing) {
    if (upload.progress < 50) eta = 'Usually 2-4 minutes';
    else if (upload.progress < 70) eta = 'About 1-2 minutes left';
    else if (upload.progress < 90) eta = 'Less than a minute';
    else eta = 'Almost done...';
  }

  return (
    <View style={{ alignItems: 'center', width: '100%', paddingHorizontal: 24 }}>
      <Animated.View style={{ opacity: pulseAnim }}>
        {isUploading ? (
          <Upload size={32} color={theme.colors.primary} />
        ) : (
          <Loader size={32} color={theme.colors.primary} />
        )}
      </Animated.View>

      <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '700', marginTop: 14 }}>
        {upload.stageLabel || 'Processing...'}
      </Text>

      {isUploading && upload.totalClips > 0 && (
        <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 4 }}>
          Clip {upload.currentClip} of {upload.totalClips}
        </Text>
      )}

      {isProcessing && (
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 4 }}>
          Your highlight reel is being created
        </Text>
      )}

      {isSubmitting && (
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 4 }}>
          Sending clips for processing...
        </Text>
      )}

      <View style={{ width: '100%', marginTop: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>{eta}</Text>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>{upload.progress}%</Text>
        </View>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface, overflow: 'hidden' }}>
          <Animated.View
            style={{
              height: '100%',
              borderRadius: 3,
              backgroundColor: theme.colors.primary,
              width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            }}
          />
        </View>
      </View>
    </View>
  );
}

// ---- Clip thumbnail card for the editor section ----
function ClipThumb({
  clip,
  onPress,
  onLongPress,
}: {
  clip: EditorClip;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(clip.thumbnailUri ?? null);

  useEffect(() => {
    if (thumb || !clip.sourceUri || !isNative || !VideoThumbnails) return;
    VideoThumbnails.getThumbnailAsync(clip.sourceUri, { time: 500 })
      .then((r) => setThumb(r.uri))
      .catch(() => {});
  }, [clip.sourceUri, thumb]);

  const durationSec = Math.round(
    ((clip.trimEndMs > 0 ? clip.trimEndMs : clip.durationMs) - clip.trimStartMs) / 1000
  );
  const durationLabel = durationSec > 0 ? `${durationSec}s` : '';

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        onLongPress();
      }}
      delayLongPress={500}
    >
      <View
        style={{
          width: 80,
          height: 110,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surface,
          overflow: 'hidden',
          marginRight: 8,
          opacity: clip.isExcluded ? 0.35 : 1,
        }}
      >
        {thumb ? (
          <Image source={{ uri: thumb }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Film size={18} color={theme.colors.textTertiary} />
          </View>
        )}
        {/* Duration badge */}
        {durationLabel ? (
          <View
            style={{
              position: 'absolute',
              top: 3,
              left: 3,
              backgroundColor: 'rgba(0,0,0,0.7)',
              paddingHorizontal: 4,
              paddingVertical: 1,
              borderRadius: 3,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{durationLabel}</Text>
          </View>
        ) : null}
        {/* Shot label */}
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            paddingVertical: 4,
            backgroundColor: clip.isExcluded ? 'rgba(180,0,0,0.7)' : 'rgba(0,0,0,0.55)',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>
            {clip.isExcluded ? 'Excluded' : `Shot ${clip.shotNumber}`}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function RoundViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { upload, startUpload } = useUploadContext();
  const editor = useEditorState(id);

  const [round, setRound] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showShare, setShowShare] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reelSignedUrl, setReelSignedUrl] = useState<string | null>(null);
  const [clipsExpanded, setClipsExpanded] = useState(false);
  const [trimClip, setTrimClip] = useState<EditorClip | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [reelStale, setReelStale] = useState<boolean>(false);

  // Refresh stale flag whenever the round id changes or the editor state
  // loads — the user may have trimmed clips since the last visit.
  useEffect(() => {
    if (!id) return;
    isReelStale(id).then(setReelStale).catch(() => {});
  }, [id, editor.state.holes]);

  const hasActiveUpload = upload.roundId === id &&
    ['preparing', 'uploading', 'submitting', 'processing'].includes(upload.stage);

  // Video player height: ~55% of screen minus safe areas
  const videoHeight = Math.round((screenHeight - insets.top - insets.bottom) * 0.55);

  const fetchRound = useCallback(() => {
    if (!id) return;
    getRound(id)
      .then((data) => {
        setRound(data);
        if (data?.reel_url) {
          const reelUrl = data.reel_url;

          if (reelUrl.startsWith('file://') || reelUrl.startsWith('/')) {
            // Legacy: local file URI from on-device composition.  This only
            // works while the app has the original install — wiped on rebuild.
            setReelSignedUrl(reelUrl);
          } else if (reelUrl.startsWith('http')) {
            // Full URL — re-sign the underlying storage path so it doesn't expire.
            const match = reelUrl.match(/\/object\/(?:public\/)?clips\/(.+?)(?:\?|$)/);
            if (match) {
              supabase.storage.from('clips').createSignedUrl(match[1], 86400)
                .then(({ data: signed }) => {
                  if (signed?.signedUrl) setReelSignedUrl(signed.signedUrl);
                });
            } else {
              setReelSignedUrl(reelUrl);
            }
          } else {
            // Bare storage path within the `clips` bucket (e.g. "reels/xxx.mp4").
            // Strip any redundant "clips/" prefix for forward compatibility.
            const path = reelUrl.startsWith('clips/') ? reelUrl.slice(6) : reelUrl;
            supabase.storage.from('clips').createSignedUrl(path, 86400)
              .then(({ data: signed }) => {
                if (signed?.signedUrl) setReelSignedUrl(signed.signedUrl);
              });
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { fetchRound(); }, [fetchRound]);

  const handleDelete = useCallback(() => {
    Alert.alert(
      'Delete this round?',
      'This will permanently delete the round, all clips, and the highlight reel. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!id) return;
            setDeleting(true);
            try {
              await deleteRound(id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              router.back();
            } catch (err) {
              Alert.alert('Error', 'Failed to delete round. Please try again.');
              setDeleting(false);
            }
          },
        },
      ]
    );
  }, [id]);

  const handleSave = useCallback(async () => {
    if (!reelSignedUrl || !id) return;
    setSaveState('saving');
    try {
      const saved = await saveToGallery(reelSignedUrl, id);
      if (saved) {
        setSaveState('done');
        setTimeout(() => setSaveState('idle'), 2500);
      } else {
        Alert.alert('Permission Required', 'Allow Clippar to save videos in Settings.');
        setSaveState('idle');
      }
    } catch {
      Alert.alert('Error', 'Failed to save video.');
      setSaveState('idle');
    }
  }, [reelSignedUrl, id]);

  const handleReRender = useCallback(() => {
    if (!id || !round) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startUpload(id, round.course_name ?? '');
    setReelSignedUrl(null);
  }, [id, round, startUpload]);

  // Poll for processing completion
  useEffect(() => {
    if (!round || round.status !== 'processing') return;
    const interval = setInterval(fetchRound, 10_000);
    return () => clearInterval(interval);
  }, [round?.status, fetchRound]);

  const totalEditorClips = editor.state.holes.reduce((s, h) => s + h.clips.length, 0);

  return (
    <GradientBackground>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {round?.course_name ?? ''}
          </Text>
          <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
            {reelSignedUrl && (
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  handleSave();
                }}
                hitSlop={12}
                disabled={saveState === 'saving'}
              >
                {saveState === 'saving' ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : saveState === 'done' ? (
                  <Check size={22} color={theme.colors.primary} />
                ) : (
                  <Download size={22} color={theme.colors.textPrimary} />
                )}
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setShowShare(true);
              }}
              hitSlop={12}
            >
              <Share2 size={22} color={theme.colors.textPrimary} />
            </Pressable>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                handleDelete();
              }}
              hitSlop={12}
            >
              <Trash2 size={22} color={theme.colors.accentRed} />
            </Pressable>
          </View>
        </View>

        {loading ? (
          <View style={{ padding: 16, gap: 12 }}>
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : !round ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Text style={{ color: theme.colors.textSecondary }}>Round not found</Text>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {/* ===== Stale-reel banner — shown when clips were edited
                 after the last compose. Tapping navigates to the editor
                 where the user can re-export. ===== */}
            {reelStale && reelSignedUrl && (
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push(`/round/editor?roundId=${id}`);
                }}
                style={{
                  marginHorizontal: 16,
                  marginTop: 12,
                  marginBottom: 4,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: theme.colors.primary + '60',
                  backgroundColor: theme.colors.primary + '15',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <RefreshCw size={18} color={theme.colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      color: theme.colors.textPrimary,
                      fontWeight: '700',
                      fontSize: 14,
                    }}
                  >
                    Reel out of date
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.textSecondary,
                      fontSize: 12,
                      marginTop: 2,
                    }}
                  >
                    Trims have been changed. Tap to open the editor and re-compose.
                  </Text>
                </View>
                <Text style={{ color: theme.colors.primary, fontWeight: '700', fontSize: 13 }}>
                  Edit
                </Text>
              </Pressable>
            )}

            {/* ===== VIDEO PLAYER (near fullscreen) ===== */}
            {reelSignedUrl ? (
              <View style={{ height: videoHeight, backgroundColor: '#000' }}>
                <PreviewPlayer
                  clips={[{ uri: reelSignedUrl, holeNumber: -1, shotNumber: -1 }]}
                  style={{ flex: 1 }}
                  hideOverlay
                />
              </View>
            ) : (
              <View
                style={{
                  height: videoHeight,
                  backgroundColor: theme.colors.surface,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                {hasActiveUpload ? (
                  <ProcessingProgress upload={upload} />
                ) : round.status === 'processing' ? (
                  <ProcessingProgress
                    upload={{
                      stage: 'processing',
                      currentClip: 0,
                      totalClips: round.clips_count ?? 0,
                      progress: 50,
                      stageLabel: 'Processing your highlight reel...',
                    }}
                  />
                ) : round.status === 'failed' ? (
                  <>
                    <Text style={{ color: theme.colors.accentRed, fontWeight: '600', marginBottom: 8 }}>
                      Processing Failed
                    </Text>
                    <Button
                      title="Retry"
                      onPress={() => router.push(`/round/upload?roundId=${round.id}`)}
                      variant="secondary"
                    />
                  </>
                ) : (
                  <>
                    <Play size={40} color={theme.colors.textTertiary} />
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 15, fontWeight: '600', marginTop: 12 }}>
                      No highlight reel yet
                    </Text>
                    <Pressable
                      onPress={() => { if (id) router.push(`/round/editor?roundId=${id}`); }}
                      style={{
                        marginTop: 14,
                        paddingHorizontal: 24,
                        paddingVertical: 10,
                        backgroundColor: theme.colors.primary,
                        borderRadius: theme.radius.md,
                      }}
                    >
                      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Edit Reel</Text>
                    </Pressable>
                  </>
                )}
              </View>
            )}

            {/* ===== SCORE STRIP ===== */}
            {typeof round.total_score === 'number' && (
              <View style={styles.scoreStrip}>
                <View style={styles.scoreStat}>
                  <Text style={styles.scoreLabel}>Score</Text>
                  <Text style={styles.scoreValue}>{round.total_score}</Text>
                </View>
                <View style={styles.scoreDivider} />
                <View style={styles.scoreStat}>
                  <Text style={styles.scoreLabel}>To Par</Text>
                  <Text
                    style={[
                      styles.scoreValue,
                      {
                        color:
                          (round.score_to_par ?? 0) < 0
                            ? theme.colors.birdie
                            : (round.score_to_par ?? 0) === 0
                              ? theme.colors.par
                              : theme.colors.bogey,
                      },
                    ]}
                  >
                    {typeof round.score_to_par !== 'number'
                      ? '—'
                      : round.score_to_par === 0
                        ? 'E'
                        : round.score_to_par > 0
                          ? `+${round.score_to_par}`
                          : round.score_to_par}
                  </Text>
                </View>
                <View style={styles.scoreDivider} />
                <View style={styles.scoreStat}>
                  <Text style={styles.scoreLabel}>Holes</Text>
                  <Text style={styles.scoreValue}>{round.holes_played ?? '—'}</Text>
                </View>
                <View style={styles.scoreDivider} />
                <View style={styles.scoreStat}>
                  <Text style={styles.scoreLabel}>Date</Text>
                  <Text style={[styles.scoreValue, { fontSize: 14 }]}>
                    {round.date
                      ? new Date(round.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
                      : '—'}
                  </Text>
                </View>
              </View>
            )}

            {/* ===== EDIT CLIPS SECTION ===== */}
            {totalEditorClips > 0 && (
              <View style={{ marginTop: 8 }}>
                {/* Section header — tap to expand */}
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync();
                    setClipsExpanded((v) => !v);
                  }}
                  style={styles.clipsSectionHeader}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.clipsSectionTitle}>Edit Clips</Text>
                    <Text style={styles.clipsSectionSub}>
                      {totalEditorClips} clips across {editor.state.holes.length} holes
                    </Text>
                  </View>
                  {clipsExpanded ? (
                    <ChevronUp size={20} color={theme.colors.textTertiary} />
                  ) : (
                    <ChevronDown size={20} color={theme.colors.textTertiary} />
                  )}
                </Pressable>

                {clipsExpanded && (
                  <View style={{ paddingBottom: 16 }}>
                    {editor.state.holes.map((hole) => (
                      <View key={hole.holeNumber} style={{ marginBottom: 16 }}>
                        {/* Hole label */}
                        <View style={styles.holeHeader}>
                          <Text style={styles.holeLabel}>Hole {hole.holeNumber}</Text>
                          <Text style={styles.holeInfo}>Par {hole.par}</Text>
                          {hole.strokes > 0 && (
                            <Text style={styles.holeInfo}>Score {hole.strokes}</Text>
                          )}
                        </View>
                        {/* Clips row */}
                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={{ paddingHorizontal: 16 }}
                        >
                          {hole.clips.map((clip) => (
                            <ClipThumb
                              key={clip.id}
                              clip={clip}
                              onPress={() => setTrimClip(clip)}
                              onLongPress={() => editor.toggleExclude(clip.id)}
                            />
                          ))}
                          {hole.clips.length === 0 && (
                            <View style={styles.emptyClipSlot}>
                              <Text style={{ color: theme.colors.textTertiary, fontSize: 10 }}>No clips</Text>
                            </View>
                          )}
                        </ScrollView>
                      </View>
                    ))}

                    {/* Re-render button */}
                    <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
                      <Pressable
                        onPress={handleReRender}
                        style={styles.reRenderBtn}
                      >
                        <RefreshCw size={16} color="#fff" />
                        <Text style={styles.reRenderText}>Re-render Highlight Reel</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            )}

            {/* Bottom padding */}
            <View style={{ height: insets.bottom + 24 }} />
          </ScrollView>
        )}
      </View>

      {/* Deleting overlay */}
      {deleting && (
        <View style={styles.deletingOverlay}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={{ color: theme.colors.textPrimary, marginTop: 12, fontSize: 15, fontWeight: '600' }}>
            Deleting round...
          </Text>
        </View>
      )}

      {/* Share sheet */}
      <ShareSheet
        visible={showShare}
        roundId={id ?? ''}
        reelUrl={reelSignedUrl ?? null}
        courseName={round?.course_name ?? ''}
        score={round?.total_score}
        onDismiss={() => setShowShare(false)}
      />

      {/* Trim modal */}
      <ClipTrimModal
        visible={!!trimClip}
        clip={trimClip}
        onSave={(startMs, endMs, sourceOverride) => {
          if (trimClip) editor.updateTrim(trimClip.id, startMs, endMs, sourceOverride);
          setTrimClip(null);
        }}
        onDismiss={() => setTrimClip(null)}
      />
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 16,
    textAlign: 'center',
    marginHorizontal: 12,
  },

  // Score strip
  scoreStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  scoreStat: {
    alignItems: 'center',
  },
  scoreLabel: {
    color: theme.colors.textTertiary,
    fontSize: 11,
    fontWeight: '500',
  },
  scoreValue: {
    color: theme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 22,
    marginTop: 2,
  },
  scoreDivider: {
    width: 1,
    height: 28,
    backgroundColor: theme.colors.surfaceBorder,
  },

  // Clips section
  clipsSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surfaceBorder,
  },
  clipsSectionTitle: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 16,
  },
  clipsSectionSub: {
    color: theme.colors.textTertiary,
    fontSize: 12,
    marginTop: 2,
  },

  // Hole rows
  holeHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: 16,
    marginBottom: 8,
    gap: 10,
  },
  holeLabel: {
    color: theme.colors.primary,
    fontSize: 15,
    fontWeight: '800',
  },
  holeInfo: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyClipSlot: {
    width: 80,
    height: 110,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Re-render button
  reRenderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  reRenderText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },

  // Deleting overlay
  deletingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
});
