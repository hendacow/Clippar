import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  Pressable,
  RefreshControl,
  Dimensions,
  Alert,
  Platform,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Bell, TrendingDown, Trophy, Flame, CircleDot, ArrowRight } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { MOCK_ROUNDS, MOCK_STATS } from '@/constants/mockData';
import type { MockRound } from '@/constants/mockData';
import { HeroReel } from '@/components/library/HeroReel';
import { UploadProgressCard } from '@/components/library/UploadProgressCard';
import { RoundCardHorizontal } from '@/components/library/RoundCardHorizontal';
import { SectionHeader } from '@/components/library/SectionHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  getRounds,
  getUserStats,
  deleteRound,
  getSignedReelUrl,
  getFirstClipSignedUrl,
  repairScoresParData,
  getProfile,
} from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { ScoreCollection } from '@/components/library/ScoreCollection';
import { StatsFilterBar } from '@/components/stats/StatsFilterBar';
import { StatsHero } from '@/components/stats/StatsHero';
import { CompilationPlayer } from '@/components/stats/CompilationPlayer';
import { useStatsFilter, type StatCategoryKey } from '@/hooks/useStatsFilter';
import { processUploadQueue } from '@/lib/uploadQueue';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Conditionally import local storage (only works on native with expo-sqlite)
let storage: typeof import('@/lib/storage') | null = null;
if (isNative) {
  storage = require('@/lib/storage') as typeof import('@/lib/storage');
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ---- Full-width list card for "All Rounds" section ----
function RoundListCard({ round, onPress, onDelete }: { round: MockRound; onPress: () => void; onDelete?: () => void }) {
  const scoreColor = getScoreColor(round.score_to_par);

  const handleLongPress = () => {
    if (!onDelete) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Alert.alert(
      'Delete this round?',
      'This will permanently delete the round, all clips, and the highlight reel. This cannot be undone.',
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
    >
      <View
        style={{
          marginHorizontal: 16,
          marginBottom: 10,
          backgroundColor: theme.colors.surfaceElevated,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.surfaceBorder,
          padding: 14,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        {/* Score circle */}
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: `${scoreColor}15`,
            borderWidth: 2,
            borderColor: `${scoreColor}40`,
            justifyContent: 'center',
            alignItems: 'center',
            marginRight: 14,
          }}
        >
          <Text style={{ fontSize: 20, fontWeight: '900', color: scoreColor }}>
            {round.total_score ?? '—'}
          </Text>
        </View>

        {/* Course + meta */}
        <View style={{ flex: 1 }}>
          <Text
            style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}
            numberOfLines={1}
          >
            {round.course_name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
              {new Date(round.date).toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
              })}
            </Text>
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
            <View
              style={{
                width: 3,
                height: 3,
                borderRadius: 1.5,
                backgroundColor: theme.colors.textTertiary,
              }}
            />
            <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
              {round.clips_count} clips
            </Text>
          </View>
        </View>

        {/* Score to par */}
        <View style={{ alignItems: 'flex-end' }}>
          {round.score_to_par != null && (
            <Text style={{ fontSize: 15, fontWeight: '700', color: scoreColor }}>
              {formatScoreToPar(round.score_to_par)}
            </Text>
          )}
          {round.best_hole && round.best_hole.label !== 'Par' && (
            <Text
              style={{
                fontSize: 10,
                fontWeight: '600',
                color:
                  round.best_hole.label === 'Eagle'
                    ? theme.colors.accentGold
                    : theme.colors.primary,
                marginTop: 2,
              }}
            >
              {round.best_hole.label} #{round.best_hole.hole}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

// ---- Horizontal scrollable round section ----
function HorizontalRoundSection({
  rounds,
  size = 'default',
  onDeleteRound,
  reelSignedUrls,
}: {
  rounds: MockRound[];
  size?: 'default' | 'large';
  onDeleteRound?: (id: string) => void;
  reelSignedUrls?: Record<string, string>;
}) {
  return (
    <FlatList
      horizontal
      showsHorizontalScrollIndicator={false}
      data={rounds}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
      style={{ marginBottom: 28 }}
      renderItem={({ item, index }) => (
        <RoundCardHorizontal
          round={item}
          index={index}
          size={size}
          onPress={() => router.push(`/round/${item.id}`)}
          onDelete={onDeleteRound ? () => onDeleteRound(item.id) : undefined}
          reelSignedUrl={reelSignedUrls?.[item.id]}
        />
      )}
    />
  );
}

// ---- Loading skeleton ----
function HomeSkeleton() {
  return (
    <View style={{ padding: 16, gap: 16 }}>
      <Skeleton width={SCREEN_WIDTH - 32} height={220} borderRadius={theme.radius.lg} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Skeleton width={80} height={60} borderRadius={theme.radius.md} />
        <Skeleton width={80} height={60} borderRadius={theme.radius.md} />
        <Skeleton width={80} height={60} borderRadius={theme.radius.md} />
        <Skeleton width={80} height={60} borderRadius={theme.radius.md} />
      </View>
      <Skeleton width="50%" height={20} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Skeleton width={170} height={180} borderRadius={theme.radius.lg} />
        <Skeleton width={170} height={180} borderRadius={theme.radius.lg} />
      </View>
    </View>
  );
}

// ---- Empty state ----
function EmptyState() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 48, marginTop: 60 }}>
      <View
        style={{
          width: 96,
          height: 96,
          borderRadius: 48,
          backgroundColor: theme.colors.primaryMuted,
          justifyContent: 'center',
          alignItems: 'center',
          marginBottom: 24,
          ...theme.shadows.glow,
        }}
      >
        <Trophy size={44} color={theme.colors.primary} />
      </View>
      <Text
        style={{
          ...theme.typography.h1,
          color: theme.colors.textPrimary,
          textAlign: 'center',
          marginBottom: 10,
        }}
      >
        Ready for your first round?
      </Text>
      <Text
        style={{
          ...theme.typography.body,
          color: theme.colors.textSecondary,
          textAlign: 'center',
          maxWidth: 300,
          marginBottom: 28,
        }}
      >
        Record your shots, let Clippar build the reel. Your highlights live right here.
      </Text>
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.push('/(tabs)/record');
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 24,
          paddingVertical: 14,
          borderRadius: theme.radius.full,
          backgroundColor: theme.colors.primary,
          opacity: pressed ? 0.85 : 1,
          ...theme.shadows.glow,
        })}
        accessibilityLabel="Start your first round"
        accessibilityRole="button"
      >
        <CircleDot size={20} color="#FFFFFF" strokeWidth={2.5} />
        <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 16 }}>
          Start a Round
        </Text>
        <ArrowRight size={18} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

// ---- Helpers ----
function getScoreColor(scoreToPar: number | null): string {
  if (scoreToPar === null) return theme.colors.textSecondary;
  if (scoreToPar < 0) return theme.colors.birdie;
  if (scoreToPar === 0) return theme.colors.par;
  if (scoreToPar <= 4) return theme.colors.bogey;
  return theme.colors.doubleBogey;
}

function formatScoreToPar(scoreToPar: number): string {
  if (scoreToPar === 0) return 'E';
  return scoreToPar > 0 ? `+${scoreToPar}` : `${scoreToPar}`;
}

// ============================================================
// MAIN SCREEN
// ============================================================
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [liveRounds, setLiveRounds] = useState<MockRound[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState(MOCK_STATS);
  const [reelSignedUrls, setReelSignedUrls] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [activeStatCategory, setActiveStatCategory] = useState<StatCategoryKey | null>(null);
  const [compilingCategory, setCompilingCategory] = useState<StatCategoryKey | null>(null);

  // Always try real data first; only show mock if user has zero rounds
  const fetchRounds = useCallback(async () => {
    try {
      const data = await getRounds();
      if (data) {
        let mapped = data.map((r: any) => ({
          ...r,
          clips_count: r.clips_count ?? 0,
          best_hole: null as { hole: number; par: number; score: number; label: string } | null,
        }));

        // Compute best_hole for each round from scores
        const roundIds = data.map((r: any) => r.id);
        const { data: scores } = await supabase
          .from('scores')
          .select('round_id, hole_number, strokes, par, score_to_par')
          .in('round_id', roundIds);

        if (scores) {
          const bestHoleMap = new Map<string, { hole: number; par: number; score: number; label: string }>();
          for (const s of scores) {
            if (s.score_to_par == null) continue;
            const existing = bestHoleMap.get(s.round_id);
            if (!existing || s.score_to_par < (existing.score - existing.par)) {
              let label = 'Par';
              if (s.score_to_par <= -2) label = 'Eagle';
              else if (s.score_to_par === -1) label = 'Birdie';
              else if (s.score_to_par === 1) label = 'Bogey';
              else if (s.score_to_par >= 2) label = 'Double Bogey';
              bestHoleMap.set(s.round_id, { hole: s.hole_number, par: s.par, score: s.strokes, label });
            }
          }
          mapped = mapped.map((r) => ({
            ...r,
            best_hole: bestHoleMap.get(r.id) ?? null,
          }));
        }

        // Set rounds immediately so the screen isn't blank while we sign URLs
        setLiveRounds(mapped);

        // Sign reel URLs for rounds that have a reel
        const reelRounds = data.filter((r: any) => r.reel_url);
        const noReelRounds = data.filter((r: any) => !r.reel_url && (r.clips_count ?? 0) > 0);
        const signedMap: Record<string, string> = {};

        await Promise.all([
          // Sign reel URLs
          ...reelRounds.map(async (r: any) => {
            const signed = await getSignedReelUrl(r.reel_url);
            if (signed) signedMap[r.id] = signed;
          }),
          // For rounds without a reel but with clips, use the first clip as preview
          ...noReelRounds.slice(0, 5).map(async (r: any) => {
            const signed = await getFirstClipSignedUrl(r.id);
            if (signed) signedMap[r.id] = signed;
          }),
        ]);

        // Fallback: check local SQLite for rounds that still have no preview URL
        // Note: clips_count may be 0 for rounds where clips were only saved locally,
        // so we check ALL rounds without a preview URL, not just those with clips_count > 0
        if (isNative && storage) {
          const roundsWithoutPreview = data.filter(
            (r: any) => !signedMap[r.id]
          );
          await Promise.all(
            roundsWithoutPreview.slice(0, 10).map(async (r: any) => {
              try {
                const localClips = await storage!.getClipsForRound(r.id);
                if (localClips && localClips.length > 0) {
                  // Only use a local URI as preview if it's actually playable —
                  // `ph://`/`assets-library://` choke expo-video and produce the
                  // broken-play-icon watermark. Prefer normalized file:// paths.
                  const first = localClips[0];
                  const rawUri = first.file_uri ?? '';
                  const normalizedUri = rawUri.startsWith('file://') || rawUri.startsWith('/')
                    ? rawUri
                    : null;
                  if (normalizedUri) {
                    signedMap[r.id] = normalizedUri;
                  }
                  // Also update clips_count if the round shows 0
                  if ((r.clips_count ?? 0) === 0) {
                    const idx = mapped.findIndex((m: any) => m.id === r.id);
                    if (idx !== -1) {
                      mapped[idx] = { ...mapped[idx], clips_count: localClips.length };
                    }
                  }
                }
              } catch {
                // Local DB lookup failed — skip
              }
            })
          );
        }

        if (Object.keys(signedMap).length > 0) {
          setReelSignedUrls(signedMap);
        }

        // Re-set rounds if local clips_count was updated
        setLiveRounds([...mapped]);
      }
    } catch {
      // Network error — keep whatever we had
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const data = await getUserStats();
      if (data && data.roundsPlayed > 0) {
        setStats(data);
      }
    } catch {
      // Keep MOCK_STATS as fallback
    }
  }, []);

  const fetchName = useCallback(async () => {
    try {
      const p: any = await getProfile();
      const name = (p?.display_name ?? '').toString().trim();
      if (name) {
        // Just first name for the greeting
        setDisplayName(name.split(' ')[0]);
      }
    } catch {
      // Silently ignore — greeting will fall back to generic
    }
  }, []);

  const handleDeleteRound = useCallback(async (roundId: string) => {
    try {
      await deleteRound(roundId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLiveRounds((prev) => prev.filter((r) => r.id !== roundId));
    } catch (err) {
      console.log('[HomeScreen] delete failed:', err);
      Alert.alert('Error', 'Failed to delete round. Please try again.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchRounds();
      fetchStats();
    }, [fetchRounds, fetchStats])
  );

  // Initial data fetch on mount (par/score_to_par repair is already called
  // once at app startup in app/_layout.tsx). Also kick the upload queue so
  // any clips still sitting locally get pushed to Supabase — this is what
  // produces the signed URLs the preview cards need.
  useEffect(() => {
    fetchRounds();
    fetchStats();
    fetchName();
    processUploadQueue()
      // Re-fetch rounds after queue drain so any newly-signed URLs show up
      .then(() => fetchRounds())
      .catch(() => {});
  }, [fetchRounds, fetchStats, fetchName]);

  // Show real rounds if we have them, otherwise show mock as placeholder
  const useMock = loaded && liveRounds.length === 0;
  const rounds = useMock ? MOCK_ROUNDS : liveRounds;

  // ---- Shared stats filter (course / hole / timeframe / clips-only) ----
  const {
    filters,
    setTimeframe,
    setCourseId,
    setHole,
    setClipsOnly,
    filteredRounds: statsFilteredRounds,
    breakdown,
    trend,
    availableCourses,
  } = useStatsFilter(rounds);

  const avgScoreToPar = useMemo(() => {
    const vals = statsFilteredRounds
      .map((r) => r.score_to_par)
      .filter((v): v is number => typeof v === 'number');
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [statsFilteredRounds]);

  // Derived data for sections (use filtered list so the whole screen obeys the filter bar)
  const latestRound = statsFilteredRounds[0] ?? rounds[0];
  const recentRounds = statsFilteredRounds.slice(0, 5);
  const bestRounds = useMemo(
    () =>
      [...statsFilteredRounds]
        .sort((a, b) => (a.score_to_par ?? 99) - (b.score_to_par ?? 99))
        .slice(0, 5),
    [statsFilteredRounds],
  );
  const birdieRounds = useMemo(
    () =>
      statsFilteredRounds.filter(
        (r) =>
          r.best_hole &&
          (r.best_hole.label === 'Birdie' || r.best_hole.label === 'Eagle'),
      ),
    [statsFilteredRounds],
  );

  // Rounds list filtered further by the selected stat category tile (if any).
  const filteredRounds = useMemo(() => {
    if (!activeStatCategory) return statsFilteredRounds;
    // A round qualifies if any of its holes sits in the selected category.
    // Cheap heuristic from round-level data: for eagles/birdies we expose via
    // best_hole when available. Otherwise fall back to score_to_par ranges.
    return statsFilteredRounds.filter((r) => {
      const bhLabel = r.best_hole?.label;
      if (activeStatCategory === 'eagle') return bhLabel === 'Eagle';
      if (activeStatCategory === 'birdie')
        return bhLabel === 'Birdie' || bhLabel === 'Eagle';
      if (activeStatCategory === 'par')
        return r.score_to_par != null && r.score_to_par <= 2;
      if (activeStatCategory === 'bogey')
        return r.score_to_par != null && r.score_to_par >= 1;
      if (activeStatCategory === 'double')
        return r.score_to_par != null && r.score_to_par >= 5;
      if (activeStatCategory === 'triple')
        return r.score_to_par != null && r.score_to_par >= 10;
      return true;
    });
  }, [statsFilteredRounds, activeStatCategory]);

  if (!loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top + 16 }}>
        <HomeSkeleton />
      </View>
    );
  }

  if (!latestRound) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <EmptyState />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {/* Top fade gradient */}
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
              fetchStats();
            }}
            tintColor={theme.colors.primary}
          />
        }
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        {/* ---- HEADER ---- */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingTop: insets.top + 12,
            paddingBottom: 16,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text
              style={{
                fontSize: 12,
                fontWeight: '600',
                color: theme.colors.textTertiary,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              {getGreeting()}{displayName ? `, ${displayName}` : ''}
            </Text>
            <Text
              style={{
                fontSize: 26,
                fontWeight: '900',
                color: theme.colors.primary,
                letterSpacing: -0.8,
                marginTop: 2,
              }}
            >
              Clippar
            </Text>
          </View>
          <Pressable
            onPress={() => {
              Haptics.selectionAsync();
              router.push('/profile/notifications');
            }}
            hitSlop={10}
            accessibilityLabel="Notifications"
            accessibilityRole="button"
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Bell size={20} color={theme.colors.textSecondary} />
          </Pressable>
        </View>

        {/* ---- SAMPLE DATA BANNER ---- */}
        {useMock && (
          <View
            style={{
              marginHorizontal: 16,
              marginBottom: 12,
              paddingVertical: 10,
              paddingHorizontal: 14,
              backgroundColor: 'rgba(168, 230, 61, 0.08)',
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: 'rgba(168, 230, 61, 0.15)',
            }}
          >
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
              Sample data shown below — upload your first round to see your stats
            </Text>
          </View>
        )}

        {/* ---- HERO REEL (latest highlight — top of page) ---- */}
        <HeroReel
          round={latestRound}
          onPress={() => router.push(`/round/${latestRound.id}`)}
          reelSignedUrl={reelSignedUrls[latestRound.id]}
        />

        {/* ---- UPLOAD PROGRESS (shown when active) ---- */}
        <UploadProgressCard />

        {/* ---- STATS FILTER BAR (hero filters, after HeroReel per spec) ---- */}
        <StatsFilterBar
          filters={filters}
          courses={availableCourses}
          onTimeframe={setTimeframe}
          onCourse={setCourseId}
          onHole={setHole}
          onClipsOnly={setClipsOnly}
        />

        {/* ---- STATS HERO (chart above tiles per spec) ---- */}
        <StatsHero
          breakdown={breakdown}
          trend={trend}
          activeCategory={activeStatCategory}
          onSelectCategory={setActiveStatCategory}
          totalRounds={statsFilteredRounds.length}
          avgScoreToPar={avgScoreToPar}
          onCompileCategory={setCompilingCategory}
        />

        {activeStatCategory == null ? (
          <>
            {/* ---- RECENT ROUNDS (horizontal scroll) ---- */}
            {recentRounds.length > 0 && (
              <>
                <SectionHeader title="Recent Rounds" onSeeAll={() => { /* filters already applied */ }} />
                <HorizontalRoundSection
                  rounds={recentRounds}
                  size="large"
                  onDeleteRound={useMock ? undefined : handleDeleteRound}
                  reelSignedUrls={reelSignedUrls}
                />
              </>
            )}

            {/* ---- BEST ROUNDS (horizontal scroll) ---- */}
            {bestRounds.length > 0 && (
              <>
                <SectionHeader title="Best Rounds" onSeeAll={() => { /* filters already applied */ }} />
                <HorizontalRoundSection
                  rounds={bestRounds}
                  onDeleteRound={useMock ? undefined : handleDeleteRound}
                  reelSignedUrls={reelSignedUrls}
                />
              </>
            )}

            {/* ---- BIRDIES & EAGLES ---- */}
            {birdieRounds.length > 0 && (
              <>
                <SectionHeader title="Birdies & Eagles" onSeeAll={() => setActiveStatCategory('birdie')} />
                <HorizontalRoundSection
                  rounds={birdieRounds}
                  onDeleteRound={useMock ? undefined : handleDeleteRound}
                  reelSignedUrls={reelSignedUrls}
                />
              </>
            )}
          </>
        ) : null}

        {/* ---- FILTERED / ALL ROUNDS (vertical list) ---- */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, marginBottom: 14 }}>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontSize: 18,
              fontWeight: '700',
              letterSpacing: -0.2,
            }}
          >
            {activeStatCategory == null
              ? 'All Rounds'
              : activeStatCategory === 'eagle'
                ? 'Eagles'
                : activeStatCategory === 'birdie'
                  ? 'Birdies'
                  : activeStatCategory === 'par'
                    ? 'Pars'
                    : activeStatCategory === 'bogey'
                      ? 'Bogeys'
                      : activeStatCategory === 'double'
                        ? 'Doubles'
                        : 'Triples+'}
          </Text>
          <View
            style={{
              backgroundColor: theme.colors.surfaceBorder,
              paddingHorizontal: 8,
              paddingVertical: 2,
              borderRadius: theme.radius.full,
            }}
          >
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>
              {filteredRounds.length}
            </Text>
          </View>
          {activeStatCategory != null && (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setActiveStatCategory(null);
              }}
              style={{
                marginLeft: 'auto',
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: theme.radius.full,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
              }}
            >
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>
                Clear
              </Text>
            </Pressable>
          )}
        </View>

        {filteredRounds.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 32 }}>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 14 }}>
              No rounds match this filter
            </Text>
          </View>
        ) : (
          filteredRounds.map((round) => (
            <RoundListCard
              key={round.id}
              round={round}
              onPress={() => router.push(`/round/${round.id}`)}
              onDelete={useMock ? undefined : () => handleDeleteRound(round.id)}
            />
          ))
        )}

        {/* ---- SCORE HIGHLIGHTS (Birdies, Eagles, Bogeys collections) ---- */}
        {!useMock && <ScoreCollection />}
      </ScrollView>

      {/* ---- STITCHED COMPILATION (long-press on a stat tile) ---- */}
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
