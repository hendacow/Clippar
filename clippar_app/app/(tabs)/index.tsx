import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  Pressable,
  RefreshControl,
  Dimensions,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Bell, TrendingDown, Trophy, Flame } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { MOCK_ROUNDS, MOCK_STATS } from '@/constants/mockData';
import type { MockRound } from '@/constants/mockData';
import { HeroReel } from '@/components/library/HeroReel';
import { UploadProgressCard } from '@/components/library/UploadProgressCard';
import { StatsRow } from '@/components/library/StatsRow';
import { RoundCardHorizontal } from '@/components/library/RoundCardHorizontal';
import { SectionHeader } from '@/components/library/SectionHeader';
import { FilterChips, FILTERS, type FilterOption } from '@/components/library/FilterChips';
import { Skeleton } from '@/components/ui/Skeleton';
import { getRounds, getUserStats, deleteRound, getSignedReelUrl } from '@/lib/api';
import { ScoreCollection } from '@/components/library/ScoreCollection';

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
          width: 80,
          height: 80,
          borderRadius: 40,
          backgroundColor: theme.colors.primaryMuted,
          justifyContent: 'center',
          alignItems: 'center',
          marginBottom: 20,
        }}
      >
        <Trophy size={36} color={theme.colors.primary} />
      </View>
      <Text
        style={{
          ...theme.typography.h2,
          color: theme.colors.textPrimary,
          textAlign: 'center',
          marginBottom: 8,
        }}
      >
        Your Library is Empty
      </Text>
      <Text
        style={{
          ...theme.typography.body,
          color: theme.colors.textSecondary,
          textAlign: 'center',
          maxWidth: 280,
        }}
      >
        Play your first round with Clippar to start building your personal golf highlight library.
      </Text>
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
  const [activeFilter, setActiveFilter] = useState<FilterOption>('all');
  const [stats, setStats] = useState(MOCK_STATS);
  const [reelSignedUrls, setReelSignedUrls] = useState<Record<string, string>>({});

  // Always try real data first; only show mock if user has zero rounds
  const fetchRounds = useCallback(async () => {
    try {
      const data = await getRounds();
      if (data) {
        const mapped = data.map((r: any, i: number) => ({
          ...r,
          clips_count: r.clips_count ?? 0,
          best_hole: null,
        }));
        setLiveRounds(mapped);

        // Sign reel URLs for rounds that have a reel
        const reelRounds = data.filter((r: any) => r.reel_url);
        if (reelRounds.length > 0) {
          const signedMap: Record<string, string> = {};
          await Promise.all(
            reelRounds.map(async (r: any) => {
              const signed = await getSignedReelUrl(r.reel_url);
              if (signed) signedMap[r.id] = signed;
            })
          );
          setReelSignedUrls(signedMap);
        }
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

  useEffect(() => {
    fetchRounds();
    fetchStats();
  }, [fetchRounds, fetchStats]);

  // Show real rounds if we have them, otherwise show mock as placeholder
  const useMock = loaded && liveRounds.length === 0;
  const rounds = useMock ? MOCK_ROUNDS : liveRounds;

  // Derived data for sections
  const latestRound = rounds[0];
  const recentRounds = rounds.slice(0, 5);
  const bestRounds = useMemo(
    () => [...rounds].sort((a, b) => (a.score_to_par ?? 99) - (b.score_to_par ?? 99)).slice(0, 5),
    [rounds]
  );
  const birdieRounds = useMemo(
    () => rounds.filter((r) => r.best_hole && (r.best_hole.label === 'Birdie' || r.best_hole.label === 'Eagle')),
    [rounds]
  );

  // Filtered rounds for the "All Rounds" section
  const filteredRounds = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    switch (activeFilter) {
      case 'birdies':
        return rounds.filter((r) => r.best_hole?.label === 'Birdie');
      case 'eagles':
        return rounds.filter((r) => r.best_hole?.label === 'Eagle');
      case 'best':
        return [...rounds].sort((a, b) => (a.score_to_par ?? 99) - (b.score_to_par ?? 99));
      case 'month':
        return rounds.filter((r) => new Date(r.date) >= monthStart);
      default:
        return rounds;
    }
  }, [rounds, activeFilter]);

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
          <View>
            <Text
              style={{
                fontSize: 28,
                fontWeight: '900',
                color: theme.colors.primary,
                letterSpacing: -0.8,
              }}
            >
              Clippar
            </Text>
          </View>
          <Pressable
            onPress={() => Haptics.selectionAsync()}
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Bell size={18} color={theme.colors.textSecondary} />
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

        {/* ---- HERO REEL ---- */}
        <HeroReel
          round={latestRound}
          onPress={() => router.push(`/round/${latestRound.id}`)}
          reelSignedUrl={reelSignedUrls[latestRound.id]}
        />

        {/* ---- UPLOAD PROGRESS (shown when active) ---- */}
        <UploadProgressCard />

        {/* ---- QUICK STATS ---- */}
        <StatsRow stats={stats} />

        {/* ---- FILTER CHIPS ---- */}
        <FilterChips selected={activeFilter} onSelect={setActiveFilter} />

        {activeFilter === 'all' ? (
          <>
            {/* ---- RECENT ROUNDS (horizontal scroll) ---- */}
            <SectionHeader title="Recent Rounds" onSeeAll={() => setActiveFilter('all')} />
            <HorizontalRoundSection rounds={recentRounds} size="large" onDeleteRound={useMock ? undefined : handleDeleteRound} reelSignedUrls={reelSignedUrls} />

            {/* ---- BEST ROUNDS (horizontal scroll) ---- */}
            <SectionHeader title="Best Rounds" onSeeAll={() => setActiveFilter('best')} />
            <HorizontalRoundSection rounds={bestRounds} onDeleteRound={useMock ? undefined : handleDeleteRound} reelSignedUrls={reelSignedUrls} />

            {/* ---- BIRDIES & EAGLES ---- */}
            {birdieRounds.length > 0 && (
              <>
                <SectionHeader title="Birdies & Eagles" onSeeAll={() => setActiveFilter('birdies')} />
                <HorizontalRoundSection rounds={birdieRounds} onDeleteRound={useMock ? undefined : handleDeleteRound} reelSignedUrls={reelSignedUrls} />
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
            {activeFilter === 'all' ? 'All Rounds' : FILTERS.find((f) => f.key === activeFilter)?.label ?? 'Rounds'}
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
    </View>
  );
}
