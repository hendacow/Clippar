/**
 * Latest-reel hero — the top-of-Home card (H1: always above the fold).
 * Renders the newest round per its canonical status (lib/roundStatus.ts).
 *
 * Player rule: exactly one video instance app-wide — the inline player
 * mounts only while actively playing and is released when the screen
 * blurs. No autoplay: first tap plays muted, second tap unmutes; the
 * expand glyph opens the round fullscreen with sound.
 */
import { View, Text, Pressable, Dimensions, StyleSheet, Image, Platform } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Play, Share2, Maximize2, RefreshCw, Film } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { theme } from '@/constants/theme';
import { ComposeProgressBar } from '@/components/shared/RoundStatusCard';
import { useUploadContext } from '@/contexts/UploadContext';
import { formatRoundDate, FAILURE_CAUSE, type RoundStatus } from '@/lib/roundStatusLogic';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const HERO_WIDTH = SCREEN_WIDTH - theme.spacing.md * 2;
const HERO_HEIGHT = 300;

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const ExpoVideo = isNative ? (require('expo-video') as typeof import('expo-video')) : null;

export interface HeroRound {
  id: string;
  course_name?: string | null;
  date: string;
  holes_played?: number | null;
  clips_count?: number | null;
}

interface HeroReelProps {
  round: HeroRound;
  status: RoundStatus;
  /** Playable reel source (READY / stale-but-valid NEEDS_REBUILD). */
  sourceUri: string | null;
  /** Poster thumbnail (reel frame or first clip). */
  posterUri?: string | null;
  offline?: boolean;
  /** Human failure cause for FAILED. */
  failedCause?: string | null;
  onOpen: () => void;
  onShare: () => void;
  onRebuild: () => void;
  onMakeReel: () => void;
  onRetry: () => void;
}

/** Mounted only while playing — the app's single video instance. */
function HeroInlinePlayer({ uri, muted }: { uri: string; muted: boolean }) {
  const { useVideoPlayer, VideoView } = ExpoVideo!;
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.volume = 0; // First tap always starts muted.
    p.play();
  });
  useEffect(() => {
    try {
      player.volume = muted ? 0 : 1;
    } catch {}
  }, [muted, player]);
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

function Poster({ uri, dim }: { uri?: string | null; dim?: number }) {
  return (
    <View style={[StyleSheet.absoluteFill, { opacity: dim ?? 1 }]}>
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <LinearGradient
          colors={['#1a3a2a', '#0d1f15', '#0A0A0F']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
    </View>
  );
}

export function HeroReel({
  round,
  status,
  sourceUri,
  posterUri,
  offline,
  failedCause,
  onOpen,
  onShare,
  onRebuild,
  onMakeReel,
  onRetry,
}: HeroReelProps) {
  const { compose } = useUploadContext();
  const [playState, setPlayState] = useState<'idle' | 'muted' | 'unmuted'>('idle');

  // Release the player whenever Home blurs.
  useFocusEffect(
    useCallback(() => {
      return () => setPlayState('idle');
    }, []),
  );

  const courseName = round.course_name || 'Unknown course';
  const metaParts = [formatRoundDate(round.date)];
  if (round.holes_played) metaParts.push(`${round.holes_played} holes`);
  const meta = metaParts.filter(Boolean).join(' · ');
  const clipsCount = round.clips_count ?? 0;
  const playable = !!sourceUri && isNative && !!ExpoVideo;

  const handleSurfaceTap = () => {
    if (status !== 'READY' || !playable) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Tap 1: play inline, muted. Tap 2: unmute.
    setPlayState((prev) => (prev === 'idle' ? 'muted' : prev === 'muted' ? 'unmuted' : 'muted'));
  };

  return (
    <View style={styles.card}>
      {/* ---- Background per state ---- */}
      {status === 'READY' && playState !== 'idle' && playable ? (
        <HeroInlinePlayer uri={sourceUri!} muted={playState === 'muted'} />
      ) : (
        <Poster
          uri={posterUri}
          dim={
            status === 'NEEDS_REBUILD'
              ? 0.6
              : status === 'PROCESSING' || status === 'FAILED'
                ? 0.45
                : 1
          }
        />
      )}

      {/* Full-surface tap target (play / unmute) */}
      {status === 'READY' && (
        <Pressable style={StyleSheet.absoluteFill} onPress={handleSurfaceTap} />
      )}

      {/* ---- Top-left chip ---- */}
      {status === 'READY' && (
        <View style={[styles.topChip, { backgroundColor: theme.colors.primaryMuted }]}>
          <Text style={[styles.topChipText, { color: theme.colors.primaryLight }]}>
            Latest reel
          </Text>
        </View>
      )}
      {status === 'NEEDS_REBUILD' && (
        <View style={[styles.topChip, { backgroundColor: `${theme.colors.accentGold}20` }]}>
          <Text style={[styles.topChipText, { color: theme.colors.accentGold }]}>
            Needs rebuild
          </Text>
        </View>
      )}

      {/* ---- Expand glyph (READY) ---- */}
      {status === 'READY' && (
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setPlayState('idle');
            onOpen();
          }}
          hitSlop={10}
          style={styles.expandButton}
          accessibilityLabel="Open round fullscreen"
          accessibilityRole="button"
        >
          <Maximize2 size={16} color="#FFFFFF" />
        </Pressable>
      )}

      {/* ---- Center content per state ---- */}
      {status === 'READY' && playState === 'idle' && (
        <View style={styles.center} pointerEvents="none">
          {offline && !playable ? (
            <Text style={styles.offlineText}>Offline — reel will load when you're back</Text>
          ) : (
            <View style={styles.playGlyph}>
              <Play size={30} color="#FFFFFF" fill="#FFFFFF" style={{ marginLeft: 3 }} />
            </View>
          )}
        </View>
      )}

      {status === 'NEEDS_REBUILD' && (
        <View style={styles.center}>
          <Text style={styles.stateTitle}>This reel needs a rebuild</Text>
          <Text style={styles.stateSub}>
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
          {playable && (
            <Pressable onPress={onOpen} hitSlop={8}>
              <Text style={styles.textLink}>Watch old version</Text>
            </Pressable>
          )}
        </View>
      )}

      {status === 'PROCESSING' && (
        <View style={[styles.center, { paddingHorizontal: theme.spacing.lg }]}>
          <RefreshCw size={26} color={theme.colors.processing} />
          <View style={{ width: '100%', marginTop: theme.spacing.md }}>
            <ComposeProgressBar
              stageLabel={compose.active ? compose.stageLabel : 'Building reel…'}
              percent={compose.active ? compose.percent : null}
            />
          </View>
        </View>
      )}

      {status === 'FAILED' && (
        <View style={styles.center}>
          <Text style={styles.stateTitle}>That export didn't finish</Text>
          <Text style={styles.stateSub}>{failedCause ?? FAILURE_CAUSE.didNotFinish}</Text>
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
      )}

      {(status === 'NO_REEL' || status === 'NO_CONTENT') && (
        <View style={styles.center}>
          {status === 'NO_CONTENT' && <Film size={30} color={theme.colors.textTertiary} />}
          {status === 'NO_CONTENT' ? (
            <Text style={styles.stateTitle}>No highlights in this round</Text>
          ) : (
            <>
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
              <Text style={styles.stateSub}>
                {clipsCount} clip{clipsCount === 1 ? '' : 's'} from {courseName}
              </Text>
            </>
          )}
        </View>
      )}

      {/* ---- Bottom scrim: course / meta / Share pill ---- */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.85)']}
        style={styles.scrim}
        pointerEvents="box-none"
      >
        <View style={styles.scrimRow} pointerEvents="box-none">
          <Pressable style={{ flex: 1 }} onPress={onOpen} hitSlop={8}>
            <Text style={styles.courseName} numberOfLines={1}>
              {courseName}
            </Text>
            <Text style={styles.metaText} numberOfLines={1}>
              {meta}
            </Text>
          </Pressable>
          {status === 'READY' && !offline && (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onShare();
              }}
              style={styles.sharePill}
              accessibilityLabel="Share this reel"
              accessibilityRole="button"
            >
              <Share2 size={16} color="#FFFFFF" />
              <Text style={styles.sharePillText}>Share</Text>
            </Pressable>
          )}
        </View>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: HERO_WIDTH,
    height: HERO_HEIGHT,
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.md,
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface,
    ...theme.shadows.card,
  },
  topChip: {
    position: 'absolute',
    top: 12,
    left: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.full,
    zIndex: 2,
  },
  topChipText: {
    ...theme.typography.caption,
    fontWeight: '700',
  },
  expandButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  playGlyph: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(76, 175, 80, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    ...theme.shadows.glow,
  },
  stateTitle: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
    textAlign: 'center',
  },
  stateSub: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
    maxWidth: 280,
  },
  offlineText: {
    ...theme.typography.bodySmall,
    color: theme.colors.textTertiary,
    textAlign: 'center',
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
  scrim: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: theme.spacing.md,
    paddingTop: 40,
    paddingBottom: theme.spacing.md,
  },
  scrimRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.sm,
  },
  courseName: {
    ...theme.typography.h3,
    color: '#FFFFFF',
  },
  metaText: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  sharePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 18,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primary,
    justifyContent: 'center',
  },
  sharePillText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
});
