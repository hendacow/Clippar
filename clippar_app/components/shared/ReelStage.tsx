/**
 * Reel stage — the round-detail media area. Renders exactly the six
 * canonical statuses (lib/roundStatus.ts) as four visually distinct
 * treatments (H11): READY player, PROCESSING progress, gold
 * NEEDS_REBUILD / red FAILED action states, and a neutral teaching
 * NO_CONTENT state (no red, no progress chrome).
 */
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useState } from 'react';
import { Play, RefreshCw, Film, Flag } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { PreviewPlayer } from '@/components/editor/PreviewPlayer';
import { ComposeProgressBar } from '@/components/shared/RoundStatusCard';
import { useUploadContext } from '@/contexts/UploadContext';
import { FAILURE_CAUSE, type RoundStatus } from '@/lib/roundStatusLogic';

export function ReelStage({
  status,
  sourceUri,
  offline,
  clipsCount,
  height,
  failedCause,
  onRebuild,
  onMakeReel,
  onRetry,
  onHowTaggingWorks,
}: {
  status: RoundStatus;
  /** Playable reel source (READY, or stale-but-valid NEEDS_REBUILD). */
  sourceUri: string | null;
  offline?: boolean;
  clipsCount: number;
  height: number;
  /** Human failure cause (copy sheet) for FAILED. */
  failedCause?: string | null;
  onRebuild: () => void;
  onMakeReel: () => void;
  onRetry: () => void;
  onHowTaggingWorks?: () => void;
}) {
  const { compose } = useUploadContext();
  const [watchingOldVersion, setWatchingOldVersion] = useState(false);

  // READY (or the user opted into the stale-but-valid old version)
  if ((status === 'READY' || (status === 'NEEDS_REBUILD' && watchingOldVersion)) && sourceUri) {
    return (
      <View style={{ height, backgroundColor: '#000' }}>
        <PreviewPlayer
          clips={[{ uri: sourceUri, holeNumber: -1, shotNumber: -1 }]}
          style={{ flex: 1 }}
          hideOverlay
        />
      </View>
    );
  }

  // READY but the signed URL couldn't be minted because we're offline.
  if (status === 'READY' && offline) {
    return (
      <View style={[styles.stage, { height }]}>
        <Film size={36} color={theme.colors.textTertiary} />
        <Text style={styles.tertiaryText}>Offline — reel will load when you're back</Text>
      </View>
    );
  }

  if (status === 'PROCESSING') {
    const stageLabel = compose.active ? compose.stageLabel : 'Building reel…';
    const percent = compose.active ? compose.percent : null;
    return (
      <View style={[styles.stage, { height, paddingHorizontal: theme.spacing.lg }]}>
        <RefreshCw size={30} color={theme.colors.processing} />
        <View style={{ width: '100%', marginTop: theme.spacing.md }}>
          <ComposeProgressBar stageLabel={stageLabel} percent={percent} />
        </View>
      </View>
    );
  }

  if (status === 'NEEDS_REBUILD') {
    return (
      <View style={[styles.stage, { height, paddingHorizontal: theme.spacing.lg }]}>
        <RefreshCw size={30} color={theme.colors.accentGold} />
        <Text style={styles.stageTitle}>This reel needs a rebuild</Text>
        <Text style={styles.stageSub}>
          Your clips changed since it was made — takes about a minute, right on your phone.
        </Text>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onRebuild();
          }}
          style={styles.primaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>Rebuild reel</Text>
        </Pressable>
        {sourceUri && (
          <Pressable onPress={() => setWatchingOldVersion(true)} hitSlop={8}>
            <Text style={styles.textLink}>Watch old version</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (status === 'FAILED') {
    return (
      <View
        style={[
          styles.stage,
          {
            height,
            paddingHorizontal: theme.spacing.lg,
            borderWidth: 1,
            borderColor: theme.colors.accentRed,
          },
        ]}
      >
        <Text style={styles.stageTitle}>That export didn't finish</Text>
        <Text style={styles.stageSub}>{failedCause ?? FAILURE_CAUSE.didNotFinish}</Text>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onRetry();
          }}
          style={styles.primaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (status === 'NO_REEL') {
    return (
      <View style={[styles.stage, { height, paddingHorizontal: theme.spacing.lg }]}>
        <Play size={36} color={theme.colors.textTertiary} />
        <Text style={styles.stageTitle}>
          No reel yet — you've got {clipsCount} clip{clipsCount === 1 ? '' : 's'} ready
        </Text>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onMakeReel();
          }}
          style={styles.primaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>Make my reel</Text>
        </Pressable>
      </View>
    );
  }

  // NO_CONTENT — neutral teaching state: no progress chrome, no red.
  return (
    <View style={[styles.stage, { height, paddingHorizontal: theme.spacing.lg }]}>
      <Flag size={36} color={theme.colors.textTertiary} />
      <Text style={styles.stageTitle}>No highlights in this round</Text>
      <Text style={styles.stageSub}>
        Tag shots with your clicker or the record button after a good shot — every tag becomes a
        clip.
      </Text>
      {onHowTaggingWorks && (
        <Pressable onPress={onHowTaggingWorks} hitSlop={8}>
          <Text style={styles.textLink}>How tagging works</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    backgroundColor: theme.colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stageTitle: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
    textAlign: 'center',
    marginTop: theme.spacing.md,
  },
  stageSub: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
    maxWidth: 300,
  },
  tertiaryText: {
    ...theme.typography.bodySmall,
    color: theme.colors.textTertiary,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
  },
  primaryButton: {
    marginTop: theme.spacing.md,
    height: 48,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 15,
  },
  textLink: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    textDecorationLine: 'underline',
    marginTop: theme.spacing.md,
  },
});
