import { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, Platform, ScrollView } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Share2, Edit3, Play, Loader } from 'lucide-react-native';
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

export default function RoundViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [round, setRound] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showShare, setShowShare] = useState(false);

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

  // Poll for processing completion every 15s
  useEffect(() => {
    if (!round || round.status !== 'processing') return;
    const interval = setInterval(fetchRound, 15_000);
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
                  height: 240,
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: theme.colors.surfaceBorder,
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginBottom: 16,
                }}
              >
                {round.status === 'processing' ? (
                  <>
                    <Loader size={32} color={theme.colors.accent} />
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 14,
                        fontWeight: '600',
                        marginTop: 12,
                      }}
                    >
                      Processing...
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.textTertiary,
                        fontSize: 13,
                        marginTop: 4,
                      }}
                    >
                      Your highlight reel is being created
                    </Text>
                  </>
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
