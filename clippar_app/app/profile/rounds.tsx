import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  SectionList,
  Pressable,
  Alert,
  RefreshControl,
} from 'react-native';
import { router, Stack } from 'expo-router';
import {
  Film,
  Clock,
  CheckCircle,
  AlertCircle,
  Trash2,
  ChevronRight,
  Disc,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { getRounds, deleteRound, getProcessingJob } from '@/lib/api';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Skeleton } from '@/components/ui/Skeleton';
import type { Round } from '@/types/round';

type RoundStatus = 'recording' | 'uploading' | 'processing' | 'ready' | 'failed';

interface RoundWithProgress extends Round {
  progressPercent?: number;
}

interface Section {
  title: string;
  icon: React.ReactNode;
  statusColor: string;
  data: RoundWithProgress[];
}

const STATUS_CONFIG: Record<RoundStatus, { label: string; color: string }> = {
  recording: { label: 'Drafts', color: theme.colors.textSecondary },
  uploading: { label: 'Uploading', color: theme.colors.accentBlue },
  processing: { label: 'Processing', color: theme.colors.processing },
  ready: { label: 'Completed', color: theme.colors.primary },
  failed: { label: 'Failed', color: theme.colors.accentRed },
};

function getStatusIcon(status: RoundStatus, size: number = 18) {
  switch (status) {
    case 'recording':
      return <Disc size={size} color={STATUS_CONFIG.recording.color} />;
    case 'uploading':
      return <Clock size={size} color={STATUS_CONFIG.uploading.color} />;
    case 'processing':
      return <Film size={size} color={STATUS_CONFIG.processing.color} />;
    case 'ready':
      return <CheckCircle size={size} color={STATUS_CONFIG.ready.color} />;
    case 'failed':
      return <AlertCircle size={size} color={STATUS_CONFIG.failed.color} />;
  }
}

function StatusBadge({ status }: { status: RoundStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: `${config.color}15`,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: theme.radius.full,
      }}
    >
      {getStatusIcon(status, 12)}
      <Text style={{ color: config.color, fontSize: 11, fontWeight: '600' }}>
        {config.label}
      </Text>
    </View>
  );
}

function RoundRow({
  round,
  onPress,
  onDelete,
}: {
  round: RoundWithProgress;
  onPress: () => void;
  onDelete: () => void;
}) {
  const dateStr = new Date(round.date).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Alert.alert(
      'Delete Round',
      `Delete "${round.course_name}"? This will permanently remove the round, all clips, and any highlight reel.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]
    );
  };

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      onLongPress={handleLongPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.colors.surface : theme.colors.surfaceElevated,
        marginHorizontal: 16,
        marginBottom: 8,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.surfaceBorder,
        padding: 14,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {/* Score circle or status icon */}
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            backgroundColor: theme.colors.surface,
            justifyContent: 'center',
            alignItems: 'center',
            marginRight: 12,
          }}
        >
          {round.status === 'ready' && round.total_score != null ? (
            <Text style={{ fontSize: 18, fontWeight: '900', color: theme.colors.textPrimary }}>
              {round.total_score}
            </Text>
          ) : (
            getStatusIcon(round.status, 22)
          )}
        </View>

        {/* Course details */}
        <View style={{ flex: 1 }}>
          <Text
            style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}
            numberOfLines={1}
          >
            {round.course_name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>{dateStr}</Text>
            <View
              style={{
                width: 3,
                height: 3,
                borderRadius: 1.5,
                backgroundColor: theme.colors.textTertiary,
              }}
            />
            <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
              {round.holes_played} holes
            </Text>
          </View>
        </View>

        {/* Status badge + arrow */}
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <StatusBadge status={round.status} />
          <ChevronRight size={16} color={theme.colors.textTertiary} />
        </View>
      </View>

      {/* Processing progress bar */}
      {(round.status === 'processing' || round.status === 'uploading') &&
        round.progressPercent != null && (
          <View style={{ marginTop: 10 }}>
            <ProgressBar
              progress={round.progressPercent}
              label={
                round.status === 'uploading'
                  ? `Uploading... ${round.progressPercent}%`
                  : `Processing... ${round.progressPercent}%`
              }
              color={
                round.status === 'uploading'
                  ? theme.colors.accentBlue
                  : theme.colors.processing
              }
            />
          </View>
        )}
    </Pressable>
  );
}

function EmptyState() {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 64, paddingHorizontal: 32 }}>
      <View
        style={{
          width: 80,
          height: 80,
          borderRadius: 40,
          backgroundColor: theme.colors.primaryMuted,
          justifyContent: 'center',
          alignItems: 'center',
          marginBottom: 20,
        }}
      >
        <Film size={34} color={theme.colors.primary} />
      </View>
      <Text
        style={{
          color: theme.colors.textPrimary,
          fontSize: 20,
          fontWeight: '800',
          textAlign: 'center',
          marginBottom: 8,
          letterSpacing: -0.3,
        }}
      >
        No Rounds Yet
      </Text>
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontSize: 14,
          textAlign: 'center',
          maxWidth: 260,
          marginBottom: 24,
          lineHeight: 20,
        }}
      >
        Your drafts, processing rounds, and completed reels will all appear here.
      </Text>
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.push('/(tabs)/record');
        }}
        style={({ pressed }) => ({
          paddingHorizontal: 24,
          paddingVertical: 12,
          borderRadius: theme.radius.full,
          backgroundColor: theme.colors.primary,
          opacity: pressed ? 0.85 : 1,
        })}
        accessibilityLabel="Record your first round"
        accessibilityRole="button"
      >
        <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 15 }}>
          Record Your First Round
        </Text>
      </Pressable>
    </View>
  );
}

export default function MyRoundsScreen() {
  const [rounds, setRounds] = useState<RoundWithProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchRounds = useCallback(async () => {
    try {
      const data = await getRounds();
      if (!data) {
        setRounds([]);
        return;
      }

      // Fetch processing progress for rounds in progress
      const enriched: RoundWithProgress[] = await Promise.all(
        data.map(async (r: any) => {
          if (r.status === 'processing' || r.status === 'uploading') {
            try {
              const job = await getProcessingJob(r.id);
              return { ...r, progressPercent: job?.progress_percent ?? 0 };
            } catch {
              return r;
            }
          }
          return r;
        })
      );

      setRounds(enriched);
    } catch (err) {
      console.log('[MyRounds] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchRounds();
  }, [fetchRounds]);

  // Refresh processing rounds periodically
  useEffect(() => {
    const hasActiveJobs = rounds.some(
      (r) => r.status === 'processing' || r.status === 'uploading'
    );
    if (!hasActiveJobs) return;

    const interval = setInterval(fetchRounds, 10000);
    return () => clearInterval(interval);
  }, [rounds, fetchRounds]);

  const handleDelete = useCallback(
    async (roundId: string) => {
      try {
        await deleteRound(roundId);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setRounds((prev) => prev.filter((r) => r.id !== roundId));
      } catch (err) {
        console.log('[MyRounds] delete error:', err);
        Alert.alert('Error', 'Failed to delete round. Please try again.');
      }
    },
    []
  );

  const handleRoundPress = useCallback((round: RoundWithProgress) => {
    // Navigate to round detail regardless of status
    router.push(`/round/${round.id}`);
  }, []);

  // Group rounds by status into sections
  const sections: Section[] = [];

  const drafts = rounds.filter((r) => r.status === 'recording');
  const uploading = rounds.filter((r) => r.status === 'uploading');
  const processing = rounds.filter((r) => r.status === 'processing');
  const failed = rounds.filter((r) => r.status === 'failed');
  const ready = rounds.filter((r) => r.status === 'ready');

  if (drafts.length > 0) {
    sections.push({
      title: 'Drafts',
      icon: <Disc size={16} color={STATUS_CONFIG.recording.color} />,
      statusColor: STATUS_CONFIG.recording.color,
      data: drafts,
    });
  }

  if (uploading.length > 0) {
    sections.push({
      title: 'Uploading',
      icon: <Clock size={16} color={STATUS_CONFIG.uploading.color} />,
      statusColor: STATUS_CONFIG.uploading.color,
      data: uploading,
    });
  }

  if (processing.length > 0) {
    sections.push({
      title: 'Processing',
      icon: <Film size={16} color={STATUS_CONFIG.processing.color} />,
      statusColor: STATUS_CONFIG.processing.color,
      data: processing,
    });
  }

  if (failed.length > 0) {
    sections.push({
      title: 'Failed',
      icon: <AlertCircle size={16} color={STATUS_CONFIG.failed.color} />,
      statusColor: STATUS_CONFIG.failed.color,
      data: failed,
    });
  }

  if (ready.length > 0) {
    sections.push({
      title: 'Completed',
      icon: <CheckCircle size={16} color={STATUS_CONFIG.ready.color} />,
      statusColor: STATUS_CONFIG.ready.color,
      data: ready,
    });
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Stack.Screen options={{ title: 'My Rounds' }} />

      {loading ? (
        <View style={{ padding: 16, gap: 10 }}>
          <Skeleton width="40%" height={18} style={{ marginBottom: 8 }} />
          <Skeleton width="100%" height={80} borderRadius={theme.radius.lg} />
          <Skeleton width="100%" height={80} borderRadius={theme.radius.lg} />
          <Skeleton width="40%" height={18} style={{ marginTop: 16, marginBottom: 8 }} />
          <Skeleton width="100%" height={80} borderRadius={theme.radius.lg} />
          <Skeleton width="100%" height={80} borderRadius={theme.radius.lg} />
        </View>
      ) : rounds.length === 0 ? (
        <EmptyState />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderSectionHeader={({ section }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 16,
                paddingTop: 20,
                paddingBottom: 10,
                backgroundColor: theme.colors.background,
              }}
            >
              {section.icon}
              <Text
                style={{
                  color: theme.colors.textPrimary,
                  fontSize: 16,
                  fontWeight: '700',
                }}
              >
                {section.title}
              </Text>
              <View
                style={{
                  backgroundColor: `${section.statusColor}20`,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderRadius: theme.radius.full,
                }}
              >
                <Text
                  style={{
                    color: section.statusColor,
                    fontSize: 12,
                    fontWeight: '600',
                  }}
                >
                  {section.data.length}
                </Text>
              </View>
            </View>
          )}
          renderItem={({ item }) => (
            <RoundRow
              round={item}
              onPress={() => handleRoundPress(item)}
              onDelete={() => handleDelete(item.id)}
            />
          )}
          contentContainerStyle={{ paddingBottom: 40 }}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchRounds();
              }}
              tintColor={theme.colors.primary}
            />
          }
        />
      )}
    </View>
  );
}
