import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Modal,
  StyleSheet,
  Platform,
  Alert,
} from 'react-native';
import { Play, Film } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import {
  getScoreHighlights,
  getSignedClipUrls,
  type ScoreCategory,
  type ScoreHighlightGroup,
} from '@/lib/api';
import {
  PreviewPlayer,
  type PreviewClip,
  type RoundGroupMeta,
} from '@/components/editor/PreviewPlayer';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Conditionally import local storage (only works on native with expo-sqlite)
let storage: typeof import('@/lib/storage') | null = null;
if (isNative) {
  storage = require('@/lib/storage') as typeof import('@/lib/storage');
}

// ---- Types ----

type DateFilter = 'month' | '3months' | 'all';

interface CategoryDef {
  key: ScoreCategory;
  label: string;
  emoji: string;
  color: string;
}

const CATEGORIES: CategoryDef[] = [
  { key: 'eagle', label: 'Eagles', emoji: '', color: theme.colors.eagle },
  { key: 'birdie', label: 'Birdies', emoji: '', color: theme.colors.birdie },
  { key: 'par', label: 'Pars', emoji: '', color: theme.colors.par },
  { key: 'bogey', label: 'Bogeys', emoji: '', color: theme.colors.bogey },
  { key: 'double_bogey', label: 'Double+', emoji: '', color: theme.colors.doubleBogey },
];

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'month', label: 'This Month' },
  { key: '3months', label: 'Last 3 Months' },
  { key: 'all', label: 'All Time' },
];

function scoreCategoryLabel(scoreToPar: number): string {
  if (scoreToPar <= -2) return 'Eagle';
  if (scoreToPar === -1) return 'Birdie';
  if (scoreToPar === 0) return 'Par';
  if (scoreToPar === 1) return 'Bogey';
  return 'Double Bogey+';
}

function scoreCategoryColor(scoreToPar: number): string {
  if (scoreToPar <= -2) return theme.colors.eagle;
  if (scoreToPar === -1) return theme.colors.birdie;
  if (scoreToPar === 0) return theme.colors.par;
  if (scoreToPar === 1) return theme.colors.bogey;
  return theme.colors.doubleBogey;
}

// ---- Category Tab Bar ----

function CategoryTabs({
  selected,
  onSelect,
  counts,
}: {
  selected: ScoreCategory;
  onSelect: (cat: ScoreCategory) => void;
  counts: Record<ScoreCategory, number>;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingVertical: 4 }}
      style={{ marginBottom: 12 }}
    >
      {CATEGORIES.map((cat) => {
        const isActive = selected === cat.key;
        const count = counts[cat.key];
        return (
          <Pressable
            key={cat.key}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(cat.key);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: theme.radius.full,
              backgroundColor: isActive ? cat.color : theme.colors.surface,
              borderWidth: 1,
              borderColor: isActive ? cat.color : theme.colors.surfaceBorder,
            }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: isActive ? '#FFFFFF' : cat.color,
              }}
            />
            <Text
              style={{
                color: isActive ? '#FFFFFF' : theme.colors.textSecondary,
                fontSize: 13,
                fontWeight: '600',
              }}
            >
              {cat.label}
            </Text>
            {count > 0 && (
              <View
                style={{
                  backgroundColor: isActive ? 'rgba(255,255,255,0.25)' : `${cat.color}20`,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: theme.radius.full,
                }}
              >
                <Text
                  style={{
                    color: isActive ? '#FFFFFF' : cat.color,
                    fontSize: 11,
                    fontWeight: '700',
                  }}
                >
                  {count}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ---- Date Filter Chips ----

function DateFilterChips({
  selected,
  onSelect,
}: {
  selected: DateFilter;
  onSelect: (f: DateFilter) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, marginBottom: 16 }}>
      {DATE_FILTERS.map((f) => {
        const isActive = selected === f.key;
        return (
          <Pressable
            key={f.key}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(f.key);
            }}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: theme.radius.full,
              backgroundColor: isActive ? theme.colors.surfaceElevated : 'transparent',
              borderWidth: 1,
              borderColor: isActive ? theme.colors.surfaceBorder : 'transparent',
            }}
          >
            <Text
              style={{
                color: isActive ? theme.colors.textPrimary : theme.colors.textTertiary,
                fontSize: 12,
                fontWeight: '600',
              }}
            >
              {f.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---- Hole Card ----

function HoleCard({
  hole,
  courseName,
  date,
  onPlay,
}: {
  hole: { holeNumber: number; strokes: number; scoreToPar: number; shots: { id: string; shotNumber: number; clipUrl: string | null }[] };
  courseName: string;
  date: string;
  onPlay: () => void;
}) {
  const color = scoreCategoryColor(hole.scoreToPar);
  const label = scoreCategoryLabel(hole.scoreToPar);
  const hasClips = hole.shots.some((s) => s.clipUrl);

  return (
    <Pressable
      onPress={() => {
        if (hasClips) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPlay();
        }
      }}
    >
      <View style={styles.holeCard}>
        {/* Score indicator */}
        <View
          style={[
            styles.holeScoreCircle,
            { backgroundColor: `${color}15`, borderColor: `${color}40` },
          ]}
        >
          <Text style={[styles.holeScoreText, { color }]}>{hole.strokes}</Text>
        </View>

        {/* Info */}
        <View style={{ flex: 1 }}>
          <Text style={styles.holeTitle}>
            Hole {hole.holeNumber}
          </Text>
          <Text style={styles.holeMeta}>
            {label} ({hole.scoreToPar > 0 ? '+' : ''}{hole.scoreToPar}) · {hole.shots.length} shot{hole.shots.length !== 1 ? 's' : ''}
          </Text>
        </View>

        {/* Play button */}
        {hasClips && (
          <View style={[styles.holePlayBtn, { backgroundColor: `${color}20` }]}>
            <Play size={14} color={color} fill={color} />
          </View>
        )}
      </View>
    </Pressable>
  );
}

// ---- Round Group ----

function RoundGroupView({
  group,
  signedUrls,
  onPlayHole,
}: {
  group: ScoreHighlightGroup;
  signedUrls: Record<string, string>;
  onPlayHole: (roundId: string, holeNumber: number) => void;
}) {
  return (
    <View style={styles.roundGroup}>
      {/* Round header */}
      <View style={styles.roundHeader}>
        <Text style={styles.roundCourseName}>{group.courseName}</Text>
        <Text style={styles.roundDate}>
          {new Date(group.date).toLocaleDateString('en-AU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </Text>
      </View>

      {/* Holes */}
      {group.holes.map((hole) => (
        <HoleCard
          key={`${group.roundId}-${hole.holeNumber}`}
          hole={hole}
          courseName={group.courseName}
          date={group.date}
          onPlay={() => onPlayHole(group.roundId, hole.holeNumber)}
        />
      ))}
    </View>
  );
}

// ---- Play All Button ----

function PlayAllButton({
  onPress,
  count,
  color,
  loading,
}: {
  onPress: () => void;
  count: number;
  color: string;
  loading?: boolean;
}) {
  return (
    <Pressable
      onPress={() => {
        if (!loading) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onPress();
        }
      }}
      style={[styles.playAllBtn, { backgroundColor: color, opacity: loading ? 0.7 : 1 }]}
    >
      {loading ? (
        <ActivityIndicator size="small" color="#FFFFFF" />
      ) : (
        <Play size={16} color="#FFFFFF" fill="#FFFFFF" />
      )}
      <Text style={styles.playAllText}>
        {loading ? 'Loading Clips...' : `Play All (${count} hole${count !== 1 ? 's' : ''})`}
      </Text>
    </Pressable>
  );
}

// ---- Video Player Modal ----

function VideoPlayerModal({
  visible,
  clips,
  roundGroups,
  enableTrim,
  onTrimSave,
  onDismiss,
}: {
  visible: boolean;
  clips: PreviewClip[];
  roundGroups?: RoundGroupMeta[];
  enableTrim?: boolean;
  onTrimSave?: (clipIndex: number, trimStartMs: number, trimEndMs: number) => void;
  onDismiss: () => void;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onDismiss}
    >
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <PreviewPlayer
          clips={clips}
          onDismiss={onDismiss}
          roundGroups={roundGroups}
          enableTrim={enableTrim}
          onTrimSave={onTrimSave}
        />
      </View>
    </Modal>
  );
}

// ---- Empty State ----

function EmptyCategory({ label, color }: { label: string; color: string }) {
  return (
    <View style={styles.emptyState}>
      <View style={[styles.emptyIcon, { backgroundColor: `${color}15` }]}>
        <Film size={28} color={color} />
      </View>
      <Text style={styles.emptyTitle}>No {label} Yet</Text>
      <Text style={styles.emptySubtitle}>
        Keep playing and your {label.toLowerCase()} will show up here
      </Text>
    </View>
  );
}

// ---- Helper: Build clips with local trim data ----

async function buildClipsWithLocalData(
  groups: ScoreHighlightGroup[],
  signedUrls: Record<string, string>,
  filterRoundId?: string,
  filterHoleNumber?: number,
): Promise<{ clips: PreviewClip[]; roundGroups: RoundGroupMeta[] }> {
  const roundIds = groups.map((g) => g.roundId);

  // Load local clip data if on native
  type LocalClipRow = {
    id: number;
    round_id: string;
    hole_number: number;
    shot_number: number;
    file_uri: string;
    trim_start_ms: number;
    trim_end_ms: number;
    duration_seconds: number | null;
    auto_trimmed: number;
    original_file_uri: string | null;
    auto_trim_start_ms: number | null;
    auto_trim_end_ms: number | null;
  };

  let localClips: LocalClipRow[] = [];
  if (storage && roundIds.length > 0) {
    try {
      localClips = await storage.getClipsForMultipleRounds(roundIds);
    } catch {
      // Fall back to no local data
    }
  }

  // Build a lookup: `roundId:holeNumber:shotNumber` -> local clip
  const localLookup = new Map<string, LocalClipRow>();
  for (const lc of localClips) {
    const key = `${lc.round_id}:${lc.hole_number}:${lc.shot_number}`;
    localLookup.set(key, lc);
  }

  const allClips: PreviewClip[] = [];
  const roundGroupsMeta: RoundGroupMeta[] = [];

  for (const group of groups) {
    // Filter to specific round if requested
    if (filterRoundId && group.roundId !== filterRoundId) continue;

    const groupStartIndex = allClips.length;

    for (const hole of group.holes) {
      // Filter to specific hole if requested
      if (filterHoleNumber !== undefined && hole.holeNumber !== filterHoleNumber) continue;

      for (const shot of hole.shots) {
        const localKey = `${group.roundId}:${hole.holeNumber}:${shot.shotNumber}`;
        const localClip = localLookup.get(localKey);

        // Resolve the best available video source:
        // 1. Signed URL from Supabase Storage (works for all uploaded clips)
        // 2. Local file URI from SQLite (only if the file still exists on disk)
        // NOTE: raw shot.clipUrl is a storage PATH, not a URL — never use it directly
        const signedUrl = shot.clipUrl ? signedUrls[shot.clipUrl] : null;
        const localFileUri = localClip?.file_uri ?? null;
        const uri = signedUrl ?? localFileUri ?? null;

        // Skip if we have no playable video source
        if (!uri) continue;

        const clip: PreviewClip = {
          uri,
          holeNumber: hole.holeNumber,
          shotNumber: shot.shotNumber,
        };

        // Add trim metadata from local SQLite
        if (localClip) {
          clip.localClipId = localClip.id;
          clip.trimStartMs = localClip.trim_start_ms;
          clip.trimEndMs = localClip.trim_end_ms;
          clip.durationMs = localClip.duration_seconds != null
            ? localClip.duration_seconds * 1000
            : undefined;
          clip.originalUri = localClip.original_file_uri ?? undefined;
          clip.autoTrimmed = localClip.auto_trimmed === 1;
          clip.autoTrimStartMs = localClip.auto_trim_start_ms ?? undefined;
          clip.autoTrimEndMs = localClip.auto_trim_end_ms ?? undefined;
        }

        allClips.push(clip);
      }
    }

    const groupEndIndex = allClips.length;

    if (groupEndIndex > groupStartIndex) {
      roundGroupsMeta.push({
        roundId: group.roundId,
        courseName: group.courseName,
        date: group.date,
        startIndex: groupStartIndex,
        endIndex: groupEndIndex,
      });
    }
  }

  return { clips: allClips, roundGroups: roundGroupsMeta };
}

// ---- Main Component ----

export function ScoreCollection() {
  const [category, setCategory] = useState<ScoreCategory>('birdie');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [groups, setGroups] = useState<ScoreHighlightGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [playerClips, setPlayerClips] = useState<PreviewClip[] | null>(null);
  const [playerRoundGroups, setPlayerRoundGroups] = useState<RoundGroupMeta[] | undefined>(undefined);
  const [counts, setCounts] = useState<Record<ScoreCategory, number>>({
    eagle: 0,
    birdie: 0,
    par: 0,
    bogey: 0,
    double_bogey: 0,
  });

  // Fetch counts for all categories on mount / date filter change
  const fetchCounts = useCallback(async () => {
    const newCounts: Record<ScoreCategory, number> = {
      eagle: 0,
      birdie: 0,
      par: 0,
      bogey: 0,
      double_bogey: 0,
    };
    const promises = CATEGORIES.map(async (cat) => {
      try {
        const data = await getScoreHighlights(cat.key, dateFilter);
        const totalHoles = data.reduce((sum, g) => sum + g.holes.length, 0);
        newCounts[cat.key] = totalHoles;
      } catch {
        // leave at 0
      }
    });
    await Promise.all(promises);
    setCounts(newCounts);
  }, [dateFilter]);

  // Fetch highlights for selected category
  const fetchHighlights = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getScoreHighlights(category, dateFilter);
      setGroups(data);

      // Collect all clip paths and sign them
      const clipPaths: string[] = [];
      for (const group of data) {
        for (const hole of group.holes) {
          for (const shot of hole.shots) {
            if (shot.clipUrl) clipPaths.push(shot.clipUrl);
          }
        }
      }

      if (clipPaths.length > 0) {
        const urls = await getSignedClipUrls(clipPaths);
        setSignedUrls(urls);
      }
    } catch (err) {
      console.log('[ScoreCollection] fetch error:', err);
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [category, dateFilter]);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  useEffect(() => {
    fetchHighlights();
  }, [fetchHighlights]);

  const [playAllLoading, setPlayAllLoading] = useState(false);

  // Build "Play All" clips for the current category with local data
  const handlePlayAll = useCallback(async () => {
    setPlayAllLoading(true);
    try {
      const result = await buildClipsWithLocalData(groups, signedUrls);
      if (result.clips.length > 0) {
        setPlayerClips(result.clips);
        setPlayerRoundGroups(result.roundGroups.length > 1 ? result.roundGroups : undefined);
      } else {
        // Show feedback: no clips available
        Alert.alert(
          'No Clips Available',
          'The highlights for this category don\'t have any video clips yet. Record some rounds to see them here!',
        );
      }
    } catch (err) {
      console.warn('[ScoreCollection] Play All error:', err);
      Alert.alert('Error', 'Failed to load clips. Please try again.');
    } finally {
      setPlayAllLoading(false);
    }
  }, [groups, signedUrls]);

  // Build clips for a single hole with local data
  const handlePlayHole = useCallback(async (roundId: string, holeNumber: number) => {
    try {
      const result = await buildClipsWithLocalData(groups, signedUrls, roundId, holeNumber);
      if (result.clips.length > 0) {
        setPlayerClips(result.clips);
        setPlayerRoundGroups(undefined); // Single hole, no round groups needed
      } else {
        Alert.alert(
          'No Clips',
          'No video clips found for this hole. The clips may still be uploading.',
        );
      }
    } catch (err) {
      console.warn('[ScoreCollection] Play Hole error:', err);
    }
  }, [groups, signedUrls]);

  // Handle trim save from the player modal
  const handleTrimSave = useCallback(async (clipIndex: number, trimStartMs: number, trimEndMs: number) => {
    const clip = playerClips?.[clipIndex];
    if (!clip?.localClipId || !storage) return;

    await storage.updateClipEditorState(clip.localClipId, {
      trim_start_ms: trimStartMs,
      trim_end_ms: trimEndMs,
    });

    // Update the clip in state too
    setPlayerClips(prev => {
      if (!prev) return prev;
      const updated = [...prev];
      updated[clipIndex] = { ...updated[clipIndex], trimStartMs, trimEndMs };
      return updated;
    });
  }, [playerClips]);

  const handleDismiss = useCallback(() => {
    setPlayerClips(null);
    setPlayerRoundGroups(undefined);
  }, []);

  const activeCat = CATEGORIES.find((c) => c.key === category)!;
  const totalHoles = groups.reduce((sum, g) => sum + g.holes.length, 0);

  return (
    <View style={styles.sectionContainer}>
      {/* Section header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Score Highlights</Text>
      </View>

      {/* Category tabs */}
      <CategoryTabs selected={category} onSelect={setCategory} counts={counts} />

      {/* Date filter */}
      <DateFilterChips selected={dateFilter} onSelect={setDateFilter} />

      {/* Play All */}
      {totalHoles > 0 && !loading && (
        <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
          <PlayAllButton
            onPress={handlePlayAll}
            count={totalHoles}
            color={activeCat.color}
            loading={playAllLoading}
          />
        </View>
      )}

      {/* Content */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={theme.colors.primary} size="small" />
          <Text style={styles.loadingText}>Loading {activeCat.label.toLowerCase()}...</Text>
        </View>
      ) : groups.length === 0 ? (
        <EmptyCategory label={activeCat.label} color={activeCat.color} />
      ) : (
        groups.map((group) => (
          <RoundGroupView
            key={group.roundId}
            group={group}
            signedUrls={signedUrls}
            onPlayHole={handlePlayHole}
          />
        ))
      )}

      {/* Full-screen video player */}
      <VideoPlayerModal
        visible={playerClips !== null}
        clips={playerClips ?? []}
        roundGroups={playerRoundGroups}
        enableTrim={isNative}
        onTrimSave={handleTrimSave}
        onDismiss={handleDismiss}
      />
    </View>
  );
}

// ---- Styles ----

const styles = StyleSheet.create({
  sectionContainer: {
    marginTop: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitle: {
    color: theme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
  },

  // Round group
  roundGroup: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    overflow: 'hidden',
  },
  roundHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  roundCourseName: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  roundDate: {
    color: theme.colors.textTertiary,
    fontSize: 12,
  },

  // Hole card
  holeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  holeScoreCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  holeScoreText: {
    fontSize: 16,
    fontWeight: '800',
  },
  holeTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  holeMeta: {
    color: theme.colors.textTertiary,
    fontSize: 12,
    marginTop: 2,
  },
  holePlayBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Play all
  playAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
  },
  playAllText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },

  // Loading
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 8,
  },
  loadingText: {
    color: theme.colors.textTertiary,
    fontSize: 13,
  },

  // Empty
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 32,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  emptyTitle: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  emptySubtitle: {
    color: theme.colors.textTertiary,
    fontSize: 13,
    textAlign: 'center',
  },
});
