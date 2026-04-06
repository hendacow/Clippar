import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, Pressable, Platform, ScrollView, Animated } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Share2, Edit3, Play, Loader, Upload, CheckCircle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { PreviewPlayer } from '@/components/editor/PreviewPlayer';
import { ShareSheet } from '@/components/shared/ShareSheet';
import { getRound } from '@/lib/api';
import { Scorecard } from '@/components/round/Scorecard';
import { useUploadContext } from '@/contexts/UploadContext';

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

  // Estimate time
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

      {/* Clip counter */}
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

      {/* Progress bar */}
      <View style={{ width: '100%', marginTop: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
            {eta}
          </Text>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
            {upload.progress}%
          </Text>
        </View>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface, overflow: 'hidden' }}>
          <Animated.View
            style={{
              height: '100%',
              borderRadius: 3,
              backgroundColor: theme.colors.primary,
              width: progressAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            }}
          />
        </View>
      </View>
    </View>
  );
}

export default function RoundViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { upload } = useUploadContext();
  const [round, setRound] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showShare, setShowShare] = useState(false);

  // Check if this round has an active upload
  const hasActiveUpload = upload.roundId === id &&
    ['preparing', 'uploading', 'submitting', 'processing'].includes(upload.stage);

  const fetchRound = useCallback(() => {
    if (!id) return;
    getRound(id)
      .then(setRound)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    fetchRound();
  }, [fetchRound]);

  // Poll for processing completion every 10s
  useEffect(() => {
    if (!round || round.status !== 'processing') return;
    const interval = setInterval(fetchRound, 10_000);
    return () => clearInterval(interval);
  }, [round?.status, fetchRound]);

  return (
    <GradientBackground>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 12,
          }}
        >
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 16 }}>
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
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                if (id) router.push(`/round/editor?roundId=${id}`);
              }}
              hitSlop={12}
            >
              <Edit3 size={22} color={theme.colors.textPrimary} />
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
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
            {/* Video player or status */}
            {round.reel_url ? (
              <View style={{ marginBottom: 16 }}>
                <PreviewPlayer
                  clips={[{ uri: round.reel_url, holeNumber: 0, shotNumber: 0 }]}
                  style={{ height: 240, borderRadius: theme.radius.lg, overflow: 'hidden' }}
                />
              </View>
            ) : (
              <View
                style={{
                  height: 260,
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: theme.colors.surfaceBorder,
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginBottom: 16,
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
                    <Text
                      style={{
                        color: theme.colors.accentRed,
                        fontWeight: '600',
                        marginBottom: 8,
                      }}
                    >
                      Processing Failed
                    </Text>
                    <Button
                      title="Retry"
                      onPress={() =>
                        router.push(`/round/upload?roundId=${round.id}`)
                      }
                      variant="secondary"
                    />
                  </>
                ) : (
                  <>
                    <Play size={32} color={theme.colors.textTertiary} />
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 14,
                        fontWeight: '600',
                        marginTop: 12,
                      }}
                    >
                      No highlight reel yet
                    </Text>
                    <Pressable
                      onPress={() => {
                        if (id) router.push(`/round/editor?roundId=${id}`);
                      }}
                      style={{
                        marginTop: 12,
                        paddingHorizontal: 20,
                        paddingVertical: 10,
                        backgroundColor: theme.colors.primary,
                        borderRadius: theme.radius.md,
                      }}
                    >
                      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>
                        Edit Reel
                      </Text>
                    </Pressable>
                  </>
                )}
              </View>
            )}

            {/* Scorecard */}
            {id && (
              <View style={{ marginBottom: 16 }}>
                <Scorecard
                  roundId={id}
                  courseId={round.course_id}
                  holesPlayed={round.holes_played}
                />
              </View>
            )}

            {/* Round details */}
            <Card>
              <Text
                style={{
                  color: theme.colors.textPrimary,
                  fontWeight: '700',
                  fontSize: 18,
                }}
              >
                {round.course_name}
              </Text>
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 13,
                  marginTop: 4,
                }}
              >
                {new Date(round.date).toLocaleDateString('en-AU', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>

              {round.total_score !== null && (
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-around',
                    marginTop: 16,
                    paddingTop: 16,
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.surfaceBorder,
                  }}
                >
                  <View style={{ alignItems: 'center' }}>
                    <Text
                      style={{ color: theme.colors.textSecondary, fontSize: 12 }}
                    >
                      Score
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.textPrimary,
                        fontWeight: '800',
                        fontSize: 28,
                      }}
                    >
                      {round.total_score}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'center' }}>
                    <Text
                      style={{ color: theme.colors.textSecondary, fontSize: 12 }}
                    >
                      To Par
                    </Text>
                    <Text
                      style={{
                        fontWeight: '800',
                        fontSize: 28,
                        color:
                          (round.score_to_par ?? 0) < 0
                            ? theme.colors.birdie
                            : (round.score_to_par ?? 0) === 0
                              ? theme.colors.par
                              : theme.colors.bogey,
                      }}
                    >
                      {round.score_to_par === 0
                        ? 'E'
                        : (round.score_to_par ?? 0) > 0
                          ? `+${round.score_to_par}`
                          : round.score_to_par}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'center' }}>
                    <Text
                      style={{ color: theme.colors.textSecondary, fontSize: 12 }}
                    >
                      Holes
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.textPrimary,
                        fontWeight: '800',
                        fontSize: 28,
                      }}
                    >
                      {round.holes_played}
                    </Text>
                  </View>
                </View>
              )}
            </Card>
          </ScrollView>
        )}
      </View>

      <ShareSheet
        visible={showShare}
        roundId={id ?? ''}
        reelUrl={round?.reel_url ?? null}
        courseName={round?.course_name ?? ''}
        score={round?.total_score}
        onDismiss={() => setShowShare(false)}
      />
    </GradientBackground>
  );
}
