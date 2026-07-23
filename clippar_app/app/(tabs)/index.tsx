/**
 * Home — content view of the user's rounds.
 *
 * Top → bottom: header (compact Clippar logo mark + greeting) ·
 * latest-reel hero (always above the
 * fold, H1) · pipeline card (one, max — severity FAILED > PROCESSING >
 * backup) · stats strip (4 tiles whose counts share the list filter's
 * predicate) · "Your rounds" vertical list, newest first.
 *
 * Removed by design (see redesign spec): bell icon, the green text
 * wordmark line (a compact logo mark is kept in the header), the
 * three horizontal shelves with no-op "See All"s, the mock-data feed,
 * ScoreCollection (an editing surface — lives on round detail), and
 * StatsFilterBar below 11 rounds.
 *
 * The Record tab button is the app's single dominant CTA — Home has no
 * "Start Round" button outside the first-run empty state.
 */
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  Dimensions,
  Alert,
  Platform,
  Image,
  StyleSheet,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Play, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { HeroReel } from '@/components/library/HeroReel';
import { RoundListCard } from '@/components/library/RoundListCard';
import { RoundStatusCard } from '@/components/shared/RoundStatusCard';
import { ShareSheet } from '@/components/shared/ShareSheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { getRounds, deleteRound, getFirstClipSignedUrl, getProfile } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { computeRoundStatuses, type RoundStatusResult } from '@/lib/roundStatus';
import { formatScoreToPar, type RoundStatus } from '@/lib/roundStatusLogic';
import { subscribePipeline } from '@/lib/pipelineEvents';
import { useUploadContext } from '@/contexts/UploadContext';
import { StatsFilterBar } from '@/components/stats/StatsFilterBar';
import { CompilationPlayer } from '@/components/stats/CompilationPlayer';
import { useStatsFilter, type StatCategoryKey } from '@/hooks/useStatsFilter';
import { processUploadQueue } from '@/lib/uploadQueue';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Conditionally import local storage (only works on native with expo-sqlite)
let storage: typeof import('@/lib/storage') | null = null;
if (isNative) {
  storage = require('@/lib/storage') as typeof import('@/lib/storage');
}

const VideoThumbnails = isNative
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface HomeRound {
  id: string;
  course_name: string;
  course_id?: string | null;
  date: string;
  holes_played?: number | null;
  clips_count: number;
  total_score?: number | null;
  score_to_par?: number | null;
  reel_url?: string | null;
  status?: string | null;
  updated_at?: string | null;
  best_hole: { hole: number; par: number; score: number; label: string } | null;
  [key: string]: any;
}

// ---- Session-level thumbnail cache (rows never do per-render I/O) ----
const thumbCache = new Map<string, string>();
async function getVideoThumb(uri: string): Promise<string | null> {
  if (!isNative || !VideoThumbnails) return null;
  const cached = thumbCache.get(uri);
  if (cached) return cached;
  try {
    const r = await VideoThumbnails.getThumbnailAsync(uri, { time: 500 });
    thumbCache.set(uri, r.uri);
    return r.uri;
  } catch {
    return null;
  }
}

// ---- Loading skeleton — layout-matching, fixed heights (H13) ----
function HomeSkeleton() {
  return (
    <View style={{ paddingHorizontal: theme.spacing.md, gap: theme.spacing.md }}>
      <Skeleton width={SCREEN_WIDTH - 32} height={300} borderRadius={theme.radius.lg} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Skeleton width={(SCREEN_WIDTH - 56) / 4} height={72} borderRadius={theme.radius.md} />
        <Skeleton width={(SCREEN_WIDTH - 56) / 4} height={72} borderRadius={theme.radius.md} />
        <Skeleton width={(SCREEN_WIDTH - 56) / 4} height={72} borderRadius={theme.radius.md} />
        <Skeleton width={(SCREEN_WIDTH - 56) / 4} height={72} borderRadius={theme.radius.md} />
      </View>
      <Skeleton width="40%" height={20} />
      <Skeleton width={SCREEN_WIDTH - 32} height={88} borderRadius={theme.radius.lg} />
      <Skeleton width={SCREEN_WIDTH - 32} height={88} borderRadius={theme.radius.lg} />
      <Skeleton width={SCREEN_WIDTH - 32} height={88} borderRadius={theme.radius.lg} />
    </View>
  );
}

// ---- First-run empty state (H10): one headline, one sentence, one CTA ----
function FirstRunEmptyState() {
  return (
    <View style={styles.emptyRoot}>
      <View style={styles.emptyVisual}>
        <Play size={44} color={theme.colors.primary} fill={theme.colors.primary} />
      </View>
      <Text style={styles.emptyHeadline}>Play golf. Get the highlights.</Text>
      <Text style={styles.emptyBody}>
        Record or import your shots and Clippar cuts them into a shareable reel.
      </Text>
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.push('/(tabs)/record');
        }}
        style={styles.emptyCta}
        accessibilityLabel="Record your first round"
        accessibilityRole="button"
      >
        <Text style={styles.emptyCtaText}>Record your first round</Text>
      </Pressable>
      <Pressable
        onPress={() => router.push('/round/import')}
        hitSlop={8}
        accessibilityRole="button"
      >
        <Text style={styles.emptyImportLink}>Already have clips? Import from Photos</Text>
      </Pressable>
    </View>
  );
}

// ---- Stats strip tiles ----
type TileKey = 'rounds' | 'best' | 'birdies' | 'clips';

const TILE_LABELS: Record<TileKey, string> = {
  rounds: 'Rounds',
  best: 'Best round',
  birdies: 'Birdies+',
  clips: 'Clips',
};

function isBirdieRound(r: HomeRound): boolean {
  return r.best_hole?.label === 'Birdie' || r.best_hole?.label === 'Eagle';
}

// ============================================================
// MAIN SCREEN
// ============================================================
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { compose } = useUploadContext();
  const [refreshing, setRefreshing] = useState(false);
  const [rounds, setRounds] = useState<HomeRound[]>([]);
  const [statuses, setStatuses] = useState<Map<string, RoundStatusResult>>(new Map());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [activeTile, setActiveTile] = useState<TileKey | null>(null);
  const [compilingCategory, setCompilingCategory] = useState<StatCategoryKey | null>(null);
  const [showHeroShare, setShowHeroShare] = useState(false);

  const roundsRef = useRef<HomeRound[]>([]);

  const composeFlags = useMemo(
    () => ({
      activeComposeRoundId: compose.active ? compose.roundId : null,
      failedComposeRoundId: compose.failed ? compose.failedRoundId : null,
    }),
    [compose.active, compose.roundId, compose.failed, compose.failedRoundId],
  );

  const fetchRounds = useCallback(async () => {
    try {
      const data = await getRounds();
      if (data) {
        let mapped: HomeRound[] = data.map((r: any) => ({
          ...r,
          course_name: r.course_name ?? '',
          clips_count: r.clips_count ?? 0,
          best_hole: null,
        }));

        // Compute best_hole for each round from scores (feeds the Birdies+
        // tile predicate — the SAME predicate filters the list, so counts
        // and results match by construction).
        const roundIds = data.map((r: any) => r.id);
        if (roundIds.length > 0) {
          const { data: scores } = await supabase
            .from('scores')
            .select('round_id, hole_number, strokes, par, score_to_par')
            .in('round_id', roundIds);

          if (scores) {
            const bestHoleMap = new Map<string, HomeRound['best_hole']>();
            for (const s of scores) {
              if (s.score_to_par == null) continue;
              const existing = bestHoleMap.get(s.round_id);
              if (!existing || s.score_to_par < existing.score - existing.par) {
                let label = 'Par';
                if (s.score_to_par <= -2) label = 'Eagle';
                else if (s.score_to_par === -1) label = 'Birdie';
                else if (s.score_to_par === 1) label = 'Bogey';
                else if (s.score_to_par >= 2) label = 'Double Bogey';
                bestHoleMap.set(s.round_id, { hole: s.hole_number, par: s.par, score: s.strokes, label });
              }
            }
            mapped = mapped.map((r) => ({ ...r, best_hole: bestHoleMap.get(r.id) ?? null }));
          }
        }

        // Local SQLite fallback for clips_count (clips saved locally only).
        if (isNative && storage) {
          await Promise.all(
            mapped
              .filter((r) => r.clips_count === 0)
              .slice(0, 10)
              .map(async (r) => {
                try {
                  const localClips = await storage!.getClipsForRound(r.id);
                  if (localClips && localClips.length > 0) {
                    r.clips_count = localClips.length;
                  }
                } catch {}
              }),
          );
        }

        roundsRef.current = mapped;
        // Rounds render immediately; statuses/thumbnails hydrate after.
        setRounds(mapped);

        // Canonical statuses — all I/O (file checks, signing, stale flags)
        // happens here, once per fetch.
        const statusMap = await computeRoundStatuses(mapped, composeFlags);
        setStatuses(statusMap);

        // Poster/thumbnail hydration for the hero + first rows.
        const thumbEntries: Record<string, string> = {};
        await Promise.all(
          mapped.slice(0, 8).map(async (r, idx) => {
            const source = statusMap.get(r.id)?.source;
            let previewUri = source?.uri ?? null;
            if (!previewUri) {
              // No reel — fall back to the first clip (cloud, then local).
              if (idx < 5) {
                previewUri = await getFirstClipSignedUrl(r.id).catch(() => null);
              }
              if (!previewUri && isNative && storage) {
                try {
                  const localClips = await storage.getClipsForRound(r.id);
                  const raw = localClips?.[0]?.file_uri ?? '';
                  if (raw.startsWith('file://') || raw.startsWith('/')) previewUri = raw;
                } catch {}
              }
            }
            if (previewUri) {
              const thumb = await getVideoThumb(previewUri);
              if (thumb) thumbEntries[r.id] = thumb;
            }
          }),
        );
        if (Object.keys(thumbEntries).length > 0) {
          setThumbs((prev) => ({ ...prev, ...thumbEntries }));
        }
      }
    } catch {
      // Network error — keep whatever we had (offline: cached rounds render)
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [composeFlags]);

  const fetchName = useCallback(async () => {
    try {
      const p: any = await getProfile();
      const name = (p?.display_name ?? '').toString().trim();
      if (name) setDisplayName(name.split(' ')[0]);
    } catch {}
  }, []);

  const handleDeleteRound = useCallback(async (roundId: string) => {
    try {
      await deleteRound(roundId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setRounds((prev) => prev.filter((r) => r.id !== roundId));
      roundsRef.current = roundsRef.current.filter((r) => r.id !== roundId);
    } catch {
      Alert.alert('Error', 'Failed to delete round. Please try again.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchRounds();
    }, [fetchRounds]),
  );

  // Initial fetch + drain the GATED backup queue (free tier / backup-off
  // users exit immediately inside processUploadQueue).
  useEffect(() => {
    fetchRounds();
    fetchName();
    processUploadQueue()
      .then(() => fetchRounds())
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Broadcaster: refetch when a compose/backup completes anywhere.
  useEffect(() => {
    return subscribePipeline((event) => {
      if (event.type === 'compose:complete' || event.type === 'backup:complete') {
        fetchRounds();
      }
    });
  }, [fetchRounds]);

  // Live status recompute when compose state flips (start/finish/fail).
  useEffect(() => {
    if (roundsRef.current.length === 0) return;
    computeRoundStatuses(roundsRef.current, composeFlags)
      .then(setStatuses)
      .catch(() => {});
  }, [composeFlags]);

  // ---- Course/timeframe filter bar (only rendered above 10 rounds, H14) ----
  const {
    filters,
    setTimeframe,
    setCourseId,
    setHole,
    setClipsOnly,
    filteredRounds: statsFilteredRounds,
    availableCourses,
  } = useStatsFilter<HomeRound>(rounds);

  const showFilterBar = rounds.length > 10;
  const baseRounds = showFilterBar ? statsFilteredRounds : rounds;

  // ---- Stats tiles: counts and list share ONE predicate ----
  const minScore = useMemo(() => {
    const vals = baseRounds
      .map((r) => r.score_to_par)
      .filter((v): v is number => typeof v === 'number');
    return vals.length > 0 ? Math.min(...vals) : null;
  }, [baseRounds]);

  const tilePredicates = useMemo<Record<TileKey, (r: HomeRound) => boolean>>(
    () => ({
      rounds: () => true,
      best: (r) => minScore != null && r.score_to_par === minScore,
      birdies: isBirdieRound,
      clips: (r) => (r.clips_count ?? 0) > 0,
    }),
    [minScore],
  );

  const tileValues = useMemo<Record<TileKey, string>>(() => {
    const clipRounds = baseRounds.filter(tilePredicates.clips);
    return {
      rounds: String(baseRounds.length),
      best: minScore != null ? formatScoreToPar(minScore) : '—',
      birdies: String(baseRounds.filter(tilePredicates.birdies).length),
      clips: String(clipRounds.reduce((s, r) => s + (r.clips_count ?? 0), 0)),
    };
  }, [baseRounds, tilePredicates, minScore]);

  const listRounds = useMemo(
    () => (activeTile ? baseRounds.filter(tilePredicates[activeTile]) : baseRounds),
    [baseRounds, activeTile, tilePredicates],
  );

  // ---- Hero + pipeline card precedence ----
  // A round's state appears in exactly ONE place: hero if it's the latest
  // round, else the pipeline card; row chips are always-on and don't count.
  const heroRound = rounds[0] ?? null;
  const heroStatus: RoundStatus = heroRound
    ? (statuses.get(heroRound.id)?.status ?? 'NO_CONTENT')
    : 'NO_CONTENT';
  const heroSource = heroRound ? statuses.get(heroRound.id)?.source : undefined;

  const failedRound = useMemo(() => {
    const r = rounds.find(
      (x) => x.id !== heroRound?.id && statuses.get(x.id)?.status === 'FAILED',
    );
    return r ? { id: r.id, courseName: r.course_name || 'Unknown course' } : null;
  }, [rounds, statuses, heroRound?.id]);

  const processingRound = useMemo(() => {
    const r = rounds.find(
      (x) => x.id !== heroRound?.id && statuses.get(x.id)?.status === 'PROCESSING',
    );
    return r ? { id: r.id, courseName: r.course_name || 'Unknown course' } : null;
  }, [rounds, statuses, heroRound?.id]);

  const goEditorRecompose = useCallback((id: string) => {
    router.push(`/round/editor?roundId=${id}&recompose=1`);
  }, []);

  // ---- Render ----
  if (!loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top + 16 }}>
        <View style={styles.header}>
          <Image
            source={require('@/assets/images/clippar-logo-mark.png')}
            style={styles.headerLogo}
            resizeMode="contain"
            accessible
            accessibilityRole="image"
            accessibilityLabel="Clippar Golf"
          />
          <Text style={styles.greeting} numberOfLines={1}>G'day{displayName ? `, ${displayName}` : ''}</Text>
        </View>
        <HomeSkeleton />
      </View>
    );
  }

  if (rounds.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <View style={styles.header}>
          <Image
            source={require('@/assets/images/clippar-logo-mark.png')}
            style={styles.headerLogo}
            resizeMode="contain"
            accessible
            accessibilityRole="image"
            accessibilityLabel="Clippar Golf"
          />
          <Text style={styles.greeting} numberOfLines={1}>G'day{displayName ? `, ${displayName}` : ''}</Text>
        </View>
        <FirstRunEmptyState />
      </View>
    );
  }

  const activeFilterLabel =
    activeTile && activeTile !== 'rounds' ? TILE_LABELS[activeTile] : null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient
        colors={['rgba(76, 175, 80, 0.06)', 'transparent']}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 300 }}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
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
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: 120 }}
      >
        {/* ---- HEADER (56pt): compact logo mark + greeting ---- */}
        <View style={styles.header}>
          <Image
            source={require('@/assets/images/clippar-logo-mark.png')}
            style={styles.headerLogo}
            resizeMode="contain"
            accessible
            accessibilityRole="image"
            accessibilityLabel="Clippar Golf"
          />
          <Text style={styles.greeting} numberOfLines={1}>
            G'day{displayName ? `, ${displayName}` : ''}
          </Text>
        </View>

        {/* ---- LATEST-REEL HERO ---- */}
        {heroRound && (
          <HeroReel
            round={heroRound}
            status={heroStatus}
            sourceUri={heroSource?.uri ?? null}
            posterUri={thumbs[heroRound.id] ?? null}
            offline={heroSource?.offline}
            failedCause={
              compose.failed && compose.failedRoundId === heroRound.id
                ? compose.failedCause
                : null
            }
            onOpen={() => router.push(`/round/${heroRound.id}`)}
            onShare={() => setShowHeroShare(true)}
            onRebuild={() => goEditorRecompose(heroRound.id)}
            onMakeReel={() => router.push(`/round/editor?roundId=${heroRound.id}`)}
            onRetry={() => goEditorRecompose(heroRound.id)}
          />
        )}

        {/* ---- PIPELINE CARD (one max; hero state never duplicated) ---- */}
        <RoundStatusCard
          excludeRoundId={heroRound?.id}
          failedRound={failedRound}
          processingRound={processingRound}
        />

        {/* ---- STATS STRIP (hidden under 2 rounds, H12 ≤90pt) ---- */}
        {rounds.length >= 2 && (
          <View style={styles.tileRow}>
            {(Object.keys(TILE_LABELS) as TileKey[]).map((key) => {
              const active = activeTile === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setActiveTile(active ? null : key);
                  }}
                  onLongPress={
                    key === 'birdies' ? () => setCompilingCategory('birdie') : undefined
                  }
                  style={[styles.tile, active && styles.tileActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={styles.tileLabel}>{TILE_LABELS[key]}</Text>
                  <Text style={styles.tileValue}>{tileValues[key]}</Text>
                  {active && key === 'birdies' && (
                    <Pressable
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setCompilingCategory('birdie');
                      }}
                      style={styles.playAllChip}
                      accessibilityLabel="Play all birdie highlights"
                      accessibilityRole="button"
                    >
                      <Play size={9} color="#FFFFFF" fill="#FFFFFF" />
                      <Text style={styles.playAllText}>Play all</Text>
                    </Pressable>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}

        {/* ---- COURSE/TIMEFRAME FILTERS (rounds > 10 only, H14) ---- */}
        {showFilterBar && (
          <StatsFilterBar
            filters={filters}
            courses={availableCourses}
            onTimeframe={setTimeframe}
            onCourse={setCourseId}
            onHole={setHole}
            onClipsOnly={setClipsOnly}
          />
        )}

        {/* ---- YOUR ROUNDS ---- */}
        <View style={styles.listHeader}>
          <Text style={styles.listTitle}>Your rounds</Text>
          <View style={styles.countPill}>
            <Text style={styles.countPillText}>{listRounds.length}</Text>
          </View>
          {activeFilterLabel && (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setActiveTile(null);
              }}
              style={styles.filterChip}
              accessibilityLabel={`Clear ${activeFilterLabel} filter`}
              accessibilityRole="button"
            >
              <Text style={styles.filterChipText}>{activeFilterLabel}</Text>
              <X size={12} color={theme.colors.textSecondary} />
            </Pressable>
          )}
        </View>

        {listRounds.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 32, gap: 12 }}>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 14 }}>
              No rounds match
            </Text>
            <Pressable
              onPress={() => setActiveTile(null)}
              style={styles.clearFiltersButton}
              accessibilityRole="button"
            >
              <Text style={styles.clearFiltersText}>Clear filters</Text>
            </Pressable>
          </View>
        ) : (
          listRounds.map((round) => {
            const result = statuses.get(round.id);
            const status = result?.status ?? 'NO_CONTENT';
            return (
              <RoundListCard
                key={round.id}
                round={round}
                status={status}
                composePercent={
                  compose.active && compose.roundId === round.id ? compose.percent : null
                }
                thumbUri={thumbs[round.id]}
                onPress={() => router.push(`/round/${round.id}`)}
                onDelete={() => handleDeleteRound(round.id)}
                onRetry={status === 'FAILED' ? () => goEditorRecompose(round.id) : undefined}
              />
            );
          })
        )}
      </ScrollView>

      {/* ---- Hero share sheet (cold open → Share → native sheet: 2 taps) ---- */}
      {heroRound && (
        <ShareSheet
          visible={showHeroShare}
          roundId={heroRound.id}
          reelUrl={heroSource?.uri ?? null}
          courseName={heroRound.course_name ?? ''}
          score={heroRound.total_score ?? undefined}
          onDismiss={() => setShowHeroShare(false)}
        />
      )}

      {/* ---- Stitched compilation ("Play all" on the Birdies+ tile) ---- */}
      <CompilationPlayer
        visible={compilingCategory != null}
        category={compilingCategory}
        courseId={filters.courseId}
        hole={filters.hole}
        timeframe={filters.timeframe}
        courseName={
          filters.courseId
            ? (availableCourses.find((c) => c.id === filters.courseId)?.name ?? null)
            : null
        }
        onClose={() => setCompilingCategory(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: theme.spacing.md,
  },
  headerLogo: {
    width: 40,
    height: 30,
  },
  greeting: {
    ...theme.typography.h2,
    color: theme.colors.textPrimary,
  },

  // Stats tiles
  tileRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.md,
    maxHeight: 90,
  },
  tile: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  tileActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primaryMuted,
  },
  tileLabel: {
    ...theme.typography.caption,
    color: theme.colors.textTertiary,
  },
  tileValue: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
    marginTop: 2,
  },
  playAllChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primary,
  },
  playAllText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },

  // List header
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    marginBottom: 14,
  },
  listTitle: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
  },
  countPill: {
    backgroundColor: theme.colors.surfaceBorder,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
  },
  countPillText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  filterChip: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  filterChipText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  clearFiltersButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  clearFiltersText: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },

  // First-run empty state
  emptyRoot: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.xl,
    paddingBottom: 80,
  },
  emptyVisual: {
    width: 240,
    height: 160,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  },
  emptyHeadline: {
    ...theme.typography.h1,
    color: theme.colors.textPrimary,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  emptyBody: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    maxWidth: 300,
    marginBottom: theme.spacing.lg,
  },
  emptyCta: {
    alignSelf: 'stretch',
    height: 52,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...theme.shadows.glow,
  },
  emptyCtaText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 16,
  },
  emptyImportLink: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    textDecorationLine: 'underline',
    marginTop: theme.spacing.md,
  },
});
