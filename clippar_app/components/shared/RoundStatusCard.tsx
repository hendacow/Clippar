/**
 * Pipeline card — the ONE inline card that surfaces an active/failed
 * local compose or background backup on Home. Replaces UploadProgressCard
 * (and consolidates its three copy-pasted ETA heuristics into honest
 * stage labels — no fake percents, no invented minutes).
 *
 * Rendering rules (precedence, one card max):
 *   FAILED compose > PROCESSING compose > backup activity.
 * A round whose state is already shown on the Home hero is excluded —
 * a round's state appears in exactly one place (row chips aside).
 *
 * Backup is low-priority chrome: blue accent, dismissible, never red —
 * backup problems are never styled as reel problems.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Animated } from 'react-native';
import { router } from 'expo-router';
import { X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { useUploadContext } from '@/contexts/UploadContext';

/**
 * Shared stage-label + progress bar. Determinate only when `percent` is a
 * real number from the pipeline; otherwise an animated indeterminate bar.
 * Used here and inside ReelStage's PROCESSING treatment.
 */
export function ComposeProgressBar({
  stageLabel,
  percent,
}: {
  stageLabel: string;
  percent: number | null;
}) {
  const progressAnim = useRef(new Animated.Value(0)).current;
  const indeterminateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (percent != null) {
      Animated.timing(progressAnim, {
        toValue: Math.min(percent, 100) / 100,
        duration: 300,
        useNativeDriver: false,
      }).start();
    }
  }, [percent, progressAnim]);

  useEffect(() => {
    if (percent != null) return;
    const loop = Animated.loop(
      Animated.timing(indeterminateAnim, {
        toValue: 1,
        duration: 1200,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [percent, indeterminateAnim]);

  return (
    <View style={{ width: '100%' }}>
      <Text
        style={{ ...theme.typography.caption, color: theme.colors.textSecondary }}
        numberOfLines={1}
      >
        {percent != null ? `${stageLabel} ${Math.round(percent)}%` : stageLabel}
      </Text>
      <View
        style={{
          marginTop: 6,
          height: 4,
          borderRadius: 2,
          backgroundColor: theme.colors.surfaceBorder,
          overflow: 'hidden',
        }}
      >
        {percent != null ? (
          <Animated.View
            style={{
              height: '100%',
              borderRadius: 2,
              backgroundColor: theme.colors.primary,
              width: progressAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            }}
          />
        ) : (
          <Animated.View
            style={{
              height: '100%',
              width: '30%',
              borderRadius: 2,
              backgroundColor: theme.colors.primary,
              transform: [
                {
                  translateX: indeterminateAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-80, 320],
                  }),
                },
              ],
            }}
          />
        )}
      </View>
    </View>
  );
}

interface RoundRef {
  id: string;
  courseName: string;
}

export function RoundStatusCard({
  excludeRoundId,
  failedRound,
  processingRound,
}: {
  /** The hero round — its state is shown there, never duplicated here. */
  excludeRoundId?: string | null;
  /** Highest-severity FAILED round from the list (already excludes hero). */
  failedRound?: RoundRef | null;
  /** A PROCESSING round from the list (already excludes hero). */
  processingRound?: RoundRef | null;
}) {
  const { compose, backup } = useUploadContext();
  const [backupDismissed, setBackupDismissed] = useState(false);

  // Live compose state takes priority over row-derived state, but only
  // when it isn't the hero's round.
  const liveFailed =
    compose.failed && compose.failedRoundId && compose.failedRoundId !== excludeRoundId
      ? { id: compose.failedRoundId, courseName: compose.courseName ?? 'your' }
      : null;
  const liveProcessing =
    compose.active && compose.roundId && compose.roundId !== excludeRoundId
      ? { id: compose.roundId, courseName: compose.courseName ?? 'your' }
      : null;

  const failed = liveFailed ?? failedRound ?? null;
  const processing = liveProcessing ?? processingRound ?? null;
  const backupActive =
    !backupDismissed && (backup.status === 'uploading' || backup.status === 'paused');

  // Severity: FAILED > PROCESSING > backup. At most one card.
  let accent: string;
  let title: string;
  let sub: string;
  let onPress: () => void;
  let showBar = false;
  let dismissible = false;

  if (failed) {
    accent = theme.colors.accentRed;
    title = `${failed.courseName} reel didn't finish`;
    sub = 'Tap to try again';
    const id = failed.id;
    onPress = () => router.push(`/round/editor?roundId=${id}&recompose=1`);
  } else if (processing) {
    accent = theme.colors.processing;
    title = `Building your ${processing.courseName} reel`;
    sub = compose.active ? compose.stageLabel : 'Building reel…';
    showBar = compose.active;
    const id = processing.id;
    onPress = () => router.push(`/round/${id}`);
  } else if (backupActive) {
    accent = theme.colors.accentBlue;
    dismissible = true;
    if (backup.status === 'paused') {
      title = 'Backup paused — no connection';
    } else {
      title = `Backing up clips — ${backup.currentClip} of ${backup.totalClips}`;
    }
    sub = 'Your reels are safe on this phone. Backup runs in the background.';
    onPress = () => router.push('/profile/rounds');
  } else {
    return null;
  }

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={{
        marginHorizontal: theme.spacing.md,
        marginBottom: theme.spacing.md,
        minHeight: 64,
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: theme.radius.md,
        flexDirection: 'row',
        overflow: 'hidden',
      }}
    >
      {/* 3pt left accent bar in state color */}
      <View style={{ width: 3, backgroundColor: accent }} />
      <View
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm + 2,
          justifyContent: 'center',
        }}
      >
        <Text
          style={{ ...theme.typography.body, lineHeight: 20, color: theme.colors.textPrimary }}
          numberOfLines={1}
        >
          {title}
        </Text>
        {showBar ? (
          <View style={{ marginTop: 4 }}>
            <ComposeProgressBar stageLabel={sub} percent={compose.percent} />
          </View>
        ) : (
          <Text
            style={{ ...theme.typography.caption, color: theme.colors.textSecondary, marginTop: 3 }}
            numberOfLines={2}
          >
            {sub}
          </Text>
        )}
      </View>
      {dismissible && (
        <Pressable
          onPress={() => setBackupDismissed(true)}
          hitSlop={12}
          style={{ padding: theme.spacing.sm, justifyContent: 'center' }}
          accessibilityLabel="Dismiss backup status"
          accessibilityRole="button"
        >
          <X size={16} color={theme.colors.textTertiary} />
        </Pressable>
      )}
    </Pressable>
  );
}
