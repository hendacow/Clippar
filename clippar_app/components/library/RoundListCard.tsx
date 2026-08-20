/**
 * Round list row — extracted from app/(tabs)/index.tsx and shared with
 * the Backup & status screen. 88pt: thumbnail · course/meta/status chip ·
 * score circle. Swipe-left reveals Delete; long-press retained as a
 * shortcut. FAILED rows carry an inline Retry (H5/H9: "which round has
 * the failed reel?" is answerable from the list with zero taps).
 */
import { View, Text, Pressable, Image, StyleSheet } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Flag, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { StatusChip } from '@/components/shared/StatusChip';
import { confirmDeleteRound } from '@/lib/confirmDeleteRound';
import {
  formatRoundMeta,
  formatScoreToPar,
  type RoundStatus,
} from '@/lib/roundStatusLogic';

export interface RoundListItem {
  id: string;
  course_name?: string | null;
  date: string;
  holes_played?: number | null;
  clips_count?: number | null;
  total_score?: number | null;
  score_to_par?: number | null;
}

function getScoreColor(scoreToPar: number | null | undefined): string {
  if (scoreToPar == null) return theme.colors.textSecondary;
  if (scoreToPar < 0) return theme.colors.birdie;
  if (scoreToPar === 0) return theme.colors.par;
  if (scoreToPar <= 4) return theme.colors.bogey;
  return theme.colors.doubleBogey;
}

export function RoundListCard({
  round,
  status,
  composePercent,
  thumbUri,
  onPress,
  onDelete,
  onRetry,
}: {
  round: RoundListItem;
  status: RoundStatus;
  /** Real compose percent for the PROCESSING chip (never faked). */
  composePercent?: number | null;
  /** Precomputed cached thumbnail — rows never do per-render I/O. */
  thumbUri?: string | null;
  onPress: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
}) {
  const scoreColor = getScoreColor(round.score_to_par);
  const clipsCount = round.clips_count ?? 0;

  const requestDelete = () => {
    if (!onDelete) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    confirmDeleteRound(onDelete);
  };

  const row = (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      onLongPress={onDelete ? requestDelete : undefined}
      delayLongPress={500}
    >
      <View style={styles.card}>
        {/* Thumbnail — never a broken image: flag-on-green placeholder */}
        <View style={styles.thumbWrap}>
          {thumbUri && status !== 'NO_CONTENT' ? (
            <Image source={{ uri: thumbUri }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Flag size={20} color={theme.colors.primary} />
            </View>
          )}
        </View>

        {/* Course + meta + status */}
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={styles.courseName} numberOfLines={1}>
            {round.course_name || 'Unknown course'}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {formatRoundMeta(round)}
          </Text>
          {status !== 'READY' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <StatusChip
                status={status}
                clipsCount={clipsCount}
                composePercent={composePercent}
              />
              {status === 'FAILED' && onRetry && (
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    onRetry();
                  }}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Try building this reel again"
                >
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>

        {/* Score circle */}
        <View
          style={[
            styles.scoreCircle,
            { backgroundColor: `${scoreColor}15`, borderColor: `${scoreColor}40` },
          ]}
        >
          <Text style={[styles.scoreText, { color: scoreColor }]}>
            {round.total_score ?? '—'}
          </Text>
        </View>
      </View>
    </Pressable>
  );

  if (!onDelete) return row;

  return (
    <Swipeable
      renderRightActions={() => (
        <Pressable
          onPress={requestDelete}
          style={styles.deleteAction}
          accessibilityLabel="Delete round"
          accessibilityRole="button"
        >
          <Trash2 size={20} color="#FFFFFF" />
          <Text style={styles.deleteText}>Delete</Text>
        </Pressable>
      )}
      overshootRight={false}
    >
      {row}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: 10,
    height: 88,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  thumbWrap: {
    width: 56,
    height: 56,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    marginRight: 12,
    backgroundColor: theme.colors.surface,
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  thumbPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.primaryMuted,
  },
  courseName: {
    ...theme.typography.body,
    lineHeight: 20,
    fontWeight: '600',
    color: theme.colors.textPrimary,
  },
  meta: {
    ...theme.typography.caption,
    color: theme.colors.textTertiary,
    marginTop: 3,
  },
  retryText: {
    ...theme.typography.caption,
    color: theme.colors.accentRed,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  scoreCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scoreText: {
    fontSize: 18,
    fontWeight: '900',
  },
  deleteAction: {
    width: 88,
    marginBottom: 10,
    marginRight: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.accentRed,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  deleteText: {
    ...theme.typography.caption,
    color: '#FFFFFF',
    fontWeight: '700',
  },
});
