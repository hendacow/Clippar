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
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Share2,
  Play,
  Film,
  RefreshCw,
  Download,
  MoreVertical,
  Eye,
  EyeOff,
  Check,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { ShareSheet } from '@/components/shared/ShareSheet';
import { ReelStage } from '@/components/shared/ReelStage';
import { ClipTrimModal } from '@/components/editor/ClipTrimModal';
import { getRound, deleteRound } from '@/lib/api';
import { deleteLocalRound } from '@/lib/storage';
import { runDeleteRound } from '@/lib/roundDeleteLogic';
import { computeRoundStatus, type RoundStatusResult } from '@/lib/roundStatus';
import { formatRoundDate, FAILURE_CAUSE } from '@/lib/roundStatusLogic';
import { subscribePipeline } from '@/lib/pipelineEvents';
import { confirmDeleteRound } from '@/lib/confirmDeleteRound';
import { saveClipToPhotos, saveHoleToPhotos, shareHole } from '@/lib/clipShare';
import { saveToGallery } from '@/lib/sharing';
import { useUploadContext } from '@/contexts/UploadContext';
import { useEditorState } from '@/hooks/useEditorState';
import type { EditorClip } from '@/types/editor';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const VideoThumbnails = isNative
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

// ---- Clip thumbnail card with a visible hide/show (eye) toggle ----
function ClipThumb({
  clip,
  onPress,
  onToggleExclude,
  onDownload,
}: {
  clip: EditorClip;
  onPress: () => void;
  onToggleExclude: () => void;
  onDownload: () => void;
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
        // Long-press retained as a shortcut for the eye toggle.
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        onToggleExclude();
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
          opacity: clip.isExcluded ? 0.4 : 1,
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
        {/* Download button (top-right) — hidden if the clip isn't playable. */}
        {clip.sourceUri && !clip.needsTrim && !clip.isExcluded && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onDownload();
            }}
            hitSlop={6}
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: 'rgba(0,0,0,0.55)',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Download size={11} color="rgba(255,255,255,0.95)" />
          </Pressable>
        )}
      </View>

      {/* Label + visible eye toggle */}
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 8,
          paddingVertical: 4,
          paddingHorizontal: 6,
          backgroundColor: 'rgba(0,0,0,0.55)',
          borderBottomLeftRadius: theme.radius.md,
          borderBottomRightRadius: theme.radius.md,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>
          {clip.isExcluded ? 'Hidden' : `Shot ${clip.shotNumber}`}
        </Text>
        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onToggleExclude();
          }}
          hitSlop={12}
          accessibilityLabel={clip.isExcluded ? 'Include this clip' : 'Hide this clip'}
          accessibilityRole="button"
        >
          {clip.isExcluded ? (
            <EyeOff size={13} color="rgba(255,255,255,0.9)" />
          ) : (
            <Eye size={13} color="rgba(255,255,255,0.9)" />
          )}
        </Pressable>
      </View>
    </Pressable>
  );
}

export default function RoundViewer() {
  const { id, exported } = useLocalSearchParams<{ id: string; exported?: string }>();
  const justExported = exported === '1';
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const { compose } = useUploadContext();
  const editor = useEditorState(id);

  const [round, setRound] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [statusResult, setStatusResult] = useState<RoundStatusResult | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [trimClip, setTrimClip] = useState<EditorClip | null>(null);
  const [busyHoleNumber, setBusyHoleNumber] = useState<number | null>(null);
  const [showToast, setShowToast] = useState(false);

  const status = statusResult?.status ?? null;
  const reelSourceUri = statusResult?.source.uri ?? null;
  const isReady = status === 'READY';

  const goEditorRecompose = useCallback(() => {
    if (!id) return;
    // The ONLY rebuild path: on-device compose via the editor's export
    // flow. Zero network I/O on tap.
    router.push(`/round/editor?roundId=${id}&recompose=1`);
  }, [id]);

  const goEditor = useCallback(() => {
    if (!id) return;
    router.push(`/round/editor?roundId=${id}`);
  }, [id]);

  // Safe back: `router.back()` is a silent no-op when the nav stack is empty
  // (the redesigned Home can reach this screen via a path with no history —
  // deep link / fresh nav), leaving the header arrow dead and stranding the
  // post-delete screen. Fall back to the library tab in that case.
  const safeBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  }, []);

  // ---- Fetch + canonical status ----
  const roundRef = useRef<any>(null);
  const computeStatus = useCallback(
    async (r: any) => {
      if (!r) return;
      try {
        const result = await computeRoundStatus(
          {
            id: r.id,
            reel_url: r.reel_url,
            status: r.status,
            updated_at: r.updated_at,
            clips_count: r.clips_count ?? r.shots?.length ?? 0,
          },
          {
            activeComposeRoundId: compose.active ? compose.roundId : null,
            failedComposeRoundId: compose.failed ? compose.failedRoundId : null,
          },
        );
        setStatusResult(result);
      } catch {}
    },
    [compose.active, compose.roundId, compose.failed, compose.failedRoundId],
  );

  const fetchRound = useCallback(() => {
    if (!id) return;
    getRound(id)
      .then((data) => {
        roundRef.current = data;
        setRound(data);
        return computeStatus(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id, computeStatus]);

  // Always refetch on focus — returning from the editor (?exported=1 or
  // otherwise) must never strand this screen on stale state.
  useFocusEffect(
    useCallback(() => {
      fetchRound();
    }, [fetchRound]),
  );

  // Broadcaster subscription: refetch when a compose/backup for THIS round
  // completes, and recompute on compose errors.
  useEffect(() => {
    return subscribePipeline((event) => {
      if (
        (event.type === 'compose:complete' ||
          event.type === 'backup:complete' ||
          event.type === 'compose:error') &&
        event.roundId === id
      ) {
        fetchRound();
      }
    });
  }, [id, fetchRound]);

  // Recompute status live when compose state flips or clips are edited
  // (edits set the stale flag → stage flips to NEEDS_REBUILD immediately).
  useEffect(() => {
    if (roundRef.current) computeStatus(roundRef.current);
  }, [computeStatus, editor.state.holes]);

  // Celebrate a freshly-exported reel + show the save toast once.
  const celebratedRef = useRef(false);
  useEffect(() => {
    if (justExported && !celebratedRef.current) {
      celebratedRef.current = true;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowToast(true);
      const t = setTimeout(() => setShowToast(false), 2000);
      return () => clearTimeout(t);
    }
  }, [justExported]);

  // Poll while a server-side processing row is live (legacy path).
  useEffect(() => {
    if (!round || round.status !== 'processing') return;
    const interval = setInterval(fetchRound, 10_000);
    return () => clearInterval(interval);
  }, [round?.status, fetchRound]);

  // ---- Actions ----
  const handleDelete = useCallback(() => {
    confirmDeleteRound(async () => {
      if (!id) return;
      setDeleting(true);
      // Delete BOTH copies of the round. `runDeleteRound` removes the local
      // SQLite round + clips FIRST (instant, offline-safe) so the round leaves
      // the library even with no network, then bounds the Supabase delete so a
      // hanging storage call can't wedge the overlay, and ALWAYS runs finalize
      // — so `setDeleting(false)` + navigation happen no matter what.
      await runDeleteRound({
        deleteLocal: () => deleteLocalRound(id),
        deleteRemote: () => deleteRound(id),
        onSuccess: () =>
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
        finalize: () => {
          setDeleting(false);
          safeBack();
        },
      });
    });
  }, [id, safeBack]);

  const handleDownloadReel = useCallback(async () => {
    if (!reelSourceUri || !id) return;
    try {
      const saved = await saveToGallery(reelSourceUri, id);
      if (!saved) {
        Alert.alert('Permission Required', 'Allow Clippar to save videos in Settings.');
      }
    } catch {
      Alert.alert('Error', 'Failed to save video.');
    }
  }, [reelSourceUri, id]);

  const handleOverflowMenu = useCallback(() => {
    Haptics.selectionAsync();
    const buttons: any[] = [];
    if (isReady && reelSourceUri) {
      buttons.push({ text: 'Download reel', onPress: handleDownloadReel });
    }
    buttons.push({ text: 'Delete round', style: 'destructive', onPress: handleDelete });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(round?.course_name ?? 'Round', undefined, buttons);
  }, [isReady, reelSourceUri, handleDownloadReel, handleDelete, round?.course_name]);

  const handleClipDownload = useCallback(async (clip: EditorClip) => {
    if (!clip.sourceUri) {
      Alert.alert('Not Ready', 'This clip is still processing. Try again in a moment.');
      return;
    }
    const ok = await saveClipToPhotos(clip.sourceUri);
    if (ok) {
      Alert.alert('Saved', `Hole ${clip.holeNumber} · Stroke ${clip.shotNumber} saved to Photos.`);
    } else {
      Alert.alert(
        'Save Failed',
        'Could not save to Photos. The trim file may have been evicted from cache — rebuild the reel to regenerate it.',
      );
    }
  }, []);

  const handleHoleSave = useCallback(async (hole: typeof editor.state.holes[number]) => {
    const usableClips = hole.clips.filter((c) => !c.isExcluded && c.sourceUri && !c.needsTrim);
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
  }, [editor.state.holes]);

  const handleHoleShare = useCallback(async (hole: typeof editor.state.holes[number]) => {
    const usableClips = hole.clips.filter((c) => !c.isExcluded && c.sourceUri && !c.needsTrim);
    if (usableClips.length === 0) return;
    setBusyHoleNumber(hole.holeNumber);
    try {
      await shareHole(
        usableClips.map((c) => c.sourceUri!),
        hole.holeNumber,
        round?.course_name ?? 'Round',
      );
    } finally {
      setBusyHoleNumber(null);
    }
  }, [editor.state.holes, round?.course_name]);

  // Video stage height: ~55% of screen minus safe areas
  const videoHeight = Math.round((screenHeight - insets.top - insets.bottom) * 0.55);
  const totalEditorClips = editor.state.holes.reduce((s, h) => s + h.clips.length, 0);
  const clipsCount = round?.clips_count ?? totalEditorClips;

  const failedCause =
    compose.failed && compose.failedRoundId === id
      ? compose.failedCause
      : status === 'FAILED'
        ? FAILURE_CAUSE.didNotFinish
        : null;

  return (
    <GradientBackground>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header: back · course + date · overflow. ONE share affordance
            per screen — the sticky CTA owns sharing. */}
        <View style={styles.header}>
          <Pressable onPress={safeBack} hitSlop={12} accessibilityLabel="Back">
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center', marginHorizontal: 12 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {round?.course_name ?? ''}
            </Text>
            {round?.date ? (
              <Text style={styles.headerDate}>{formatRoundDate(round.date)}</Text>
            ) : null}
          </View>
          <Pressable
            onPress={handleOverflowMenu}
            hitSlop={12}
            accessibilityLabel="More options"
            accessibilityRole="button"
          >
            <MoreVertical size={22} color={theme.colors.textPrimary} />
          </Pressable>
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
            {/* ===== Status banner — one slot, one banner ===== */}
            {status === 'NEEDS_REBUILD' && (
              <View style={[styles.statusBanner, { borderLeftColor: theme.colors.accentGold }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bannerTitle}>This reel needs a rebuild</Text>
                  <Text style={styles.bannerSub}>
                    Your clips changed since it was made — takes about a minute, right on your
                    phone.
                  </Text>
                </View>
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    goEditorRecompose();
                  }}
                  style={styles.bannerButton}
                  accessibilityRole="button"
                >
                  <Text style={styles.bannerButtonText}>Rebuild reel</Text>
                </Pressable>
              </View>
            )}
            {status === 'FAILED' && (
              <View style={[styles.statusBanner, { borderLeftColor: theme.colors.accentRed }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bannerTitle}>
                    {failedCause ?? FAILURE_CAUSE.didNotFinish}
                  </Text>
                </View>
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    goEditorRecompose();
                  }}
                  style={styles.bannerButton}
                  accessibilityRole="button"
                >
                  <Text style={styles.bannerButtonText}>Try again</Text>
                </Pressable>
              </View>
            )}

            {/* ===== REEL STAGE ===== */}
            {status && (
              <ReelStage
                status={status}
                sourceUri={reelSourceUri}
                offline={statusResult?.source.offline}
                clipsCount={clipsCount}
                height={videoHeight}
                failedCause={failedCause}
                onRebuild={goEditorRecompose}
                onMakeReel={goEditor}
                onRetry={goEditorRecompose}
              />
            )}

            {/* ===== SCORE STRIP (unchanged) ===== */}
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

            {/* ===== CLIPS (expanded by default) ===== */}
            {totalEditorClips > 0 && (
              <View style={{ marginTop: 8 }}>
                <View style={styles.clipsSectionHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.clipsSectionTitle}>Clips</Text>
                    <Text style={styles.clipsSectionSub}>
                      {totalEditorClips} clips across {editor.state.holes.length} holes
                    </Text>
                  </View>
                </View>

                <View style={{ paddingBottom: 16 }}>
                  {editor.state.holes.map((hole) => {
                    const usableClips = hole.clips.filter(
                      (c) => !c.isExcluded && c.sourceUri && !c.needsTrim,
                    );
                    const canStitchHole = usableClips.length > 0;
                    const isBusy = busyHoleNumber === hole.holeNumber;
                    return (
                      <View key={hole.holeNumber} style={{ marginBottom: 16 }}>
                        {/* Hole label + per-hole share/download (≥44pt) */}
                        <View style={styles.holeHeader}>
                          <Text style={styles.holeLabel}>Hole {hole.holeNumber}</Text>
                          <Text style={styles.holeInfo}>Par {hole.par}</Text>
                          {hole.strokes > 0 && (
                            <Text style={styles.holeInfo}>Score {hole.strokes}</Text>
                          )}
                          {canStitchHole && (
                            <View
                              style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 8,
                                marginLeft: 'auto',
                              }}
                            >
                              <Text style={styles.shareHoleLabel}>Share this hole</Text>
                              <Pressable
                                onPress={() => handleHoleSave(hole)}
                                disabled={isBusy}
                                style={[styles.holeActionButton, isBusy && { opacity: 0.5 }]}
                                accessibilityLabel={`Download hole ${hole.holeNumber} highlight`}
                                accessibilityRole="button"
                              >
                                {isBusy ? (
                                  <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                                ) : (
                                  <Download size={16} color={theme.colors.textPrimary} />
                                )}
                              </Pressable>
                              <Pressable
                                onPress={() => handleHoleShare(hole)}
                                disabled={isBusy}
                                style={[styles.holeActionButton, isBusy && { opacity: 0.5 }]}
                                accessibilityLabel={`Share hole ${hole.holeNumber} highlight`}
                                accessibilityRole="button"
                              >
                                <Share2 size={16} color={theme.colors.textPrimary} />
                              </Pressable>
                            </View>
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
                              onToggleExclude={() => editor.toggleExclude(clip.id)}
                              onDownload={() => handleClipDownload(clip)}
                            />
                          ))}
                          {hole.clips.length === 0 && (
                            <View style={styles.emptyClipSlot}>
                              <Text style={{ color: theme.colors.textTertiary, fontSize: 10 }}>No clips</Text>
                            </View>
                          )}
                        </ScrollView>
                      </View>
                    );
                  })}

                  {/* Footer: full editor entry point */}
                  <Pressable
                    onPress={goEditor}
                    style={{ alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16 }}
                    hitSlop={8}
                    accessibilityRole="button"
                  >
                    <Text style={styles.openEditorLink}>Open full editor</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Bottom padding — room for the sticky CTA. */}
            <View style={{ height: insets.bottom + 110 }} />
          </ScrollView>
        )}
      </View>

      {/* ===== Sticky bottom CTA ===== */}
      {!loading && !deleting && round && (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: insets.bottom + 16,
          }}
        >
          {!isReady && (
            <Text style={styles.ctaHelper}>Rebuild your reel to share it</Text>
          )}
          <Pressable
            disabled={!isReady}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setShowShare(true);
            }}
            style={({ pressed }) => [
              styles.shareCta,
              !isReady && styles.shareCtaDisabled,
              pressed && isReady && { opacity: 0.85 },
            ]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !isReady }}
          >
            <Share2 size={20} color={isReady ? '#fff' : theme.colors.textTertiary} />
            <Text style={[styles.shareCtaText, !isReady && { color: theme.colors.textTertiary }]}>
              Save & Share
            </Text>
          </Pressable>
        </View>
      )}

      {/* Export toast — replaces the old dismissable banner chrome */}
      {showToast && (
        <View style={[styles.toast, { top: insets.top + 60 }]}>
          <Check size={16} color={theme.colors.primary} />
          <Text style={styles.toastText}>Saved to your Camera Roll</Text>
        </View>
      )}

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
        reelUrl={reelSourceUri}
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
    color: theme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 16,
    textAlign: 'center',
  },
  headerDate: {
    ...theme.typography.caption,
    color: theme.colors.textTertiary,
    marginTop: 1,
  },

  // Status banner (one slot)
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    borderLeftWidth: 3,
    backgroundColor: theme.colors.surfaceElevated,
  },
  bannerTitle: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
  bannerSub: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  bannerButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  bannerButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
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
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
    gap: 10,
    minHeight: 44,
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
  shareHoleLabel: {
    ...theme.typography.caption,
    color: theme.colors.textTertiary,
  },
  holeActionButton: {
    width: 44,
    height: 44,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceElevated,
    justifyContent: 'center',
    alignItems: 'center',
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
  openEditorLink: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    textDecorationLine: 'underline',
  },

  // Sticky CTA
  shareCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 52,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  shareCtaDisabled: {
    backgroundColor: theme.colors.surfaceElevated,
    shadowOpacity: 0,
    elevation: 0,
  },
  shareCtaText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
    letterSpacing: 0.2,
  },
  ctaHelper: {
    ...theme.typography.caption,
    color: theme.colors.textTertiary,
    textAlign: 'center',
    marginBottom: 6,
  },

  // Toast
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  toastText: {
    color: theme.colors.textPrimary,
    fontWeight: '600',
    fontSize: 13,
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
