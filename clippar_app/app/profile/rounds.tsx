/**
 * Backup & status — the ops view (Drafts / Backing up / Backup failed /
 * All synced), while Home is the content view. Rows reuse RoundListCard
 * + the canonical status chips; backup state is carried separately and
 * is never presented as a reel problem.
 *
 * The failed-backup retry re-drains the GATED queue
 * (processUploadQueue) — there is no per-round upload call anywhere.
 */
import { useState, useCallback } from 'react';
import { View, Text, SectionList, Pressable, RefreshControl, Platform } from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { Film, Clock, CheckCircle, AlertCircle, Disc, RefreshCw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { getRounds, deleteRound } from '@/lib/api';
import { computeRoundStatuses, type RoundStatusResult } from '@/lib/roundStatus';
import { subscribePipeline } from '@/lib/pipelineEvents';
import { processUploadQueue } from '@/lib/uploadQueue';
import { useUploadContext } from '@/contexts/UploadContext';
import { RoundListCard, type RoundListItem } from '@/components/library/RoundListCard';
import { Skeleton } from '@/components/ui/Skeleton';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

type BackupBucket = 'drafts' | 'backing-up' | 'backup-failed' | 'synced';

interface OpsRound extends RoundListItem {
  status?: string | null;
  reel_url?: string | null;
  updated_at?: string | null;
}

interface Section {
  key: BackupBucket;
  title: string;
  icon: React.ReactNode;
  statusColor: string;
  data: OpsRound[];
}

const BUCKET_CONFIG: Record<BackupBucket, { title: string; color: string }> = {
  drafts: { title: 'Drafts', color: theme.colors.textSecondary },
  'backing-up': { title: 'Backing up', color: theme.colors.accentBlue },
  'backup-failed': { title: 'Backup failed', color: theme.colors.processing },
  synced: { title: 'All synced', color: theme.colors.primary },
};

function bucketIcon(bucket: BackupBucket, size = 16) {
  const color = BUCKET_CONFIG[bucket].color;
  switch (bucket) {
    case 'drafts':
      return <Disc size={size} color={color} />;
    case 'backing-up':
      return <Clock size={size} color={color} />;
    case 'backup-failed':
      return <AlertCircle size={size} color={color} />;
    case 'synced':
      return <CheckCircle size={size} color={color} />;
  }
}

export default function BackupStatusScreen() {
  const { backup } = useUploadContext();
  const [rounds, setRounds] = useState<OpsRound[]>([]);
  const [statuses, setStatuses] = useState<Map<string, RoundStatusResult>>(new Map());
  const [queueByRound, setQueueByRound] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingBackup, setRetryingBackup] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const data = await getRounds();
      const mapped: OpsRound[] = (data ?? []).map((r: any) => ({
        ...r,
        clips_count: r.clips_count ?? 0,
      }));
      setRounds(mapped);

      const statusMap = await computeRoundStatuses(mapped);
      setStatuses(statusMap);

      // Backup queue state (SQLite) — pending/error rows.
      if (isNative) {
        try {
          const storage = require('@/lib/storage') as typeof import('@/lib/storage');
          const queued = await storage.getQueuedRoundUploads();
          setQueueByRound(new Map(queued.map((q) => [q.round_id, q.status])));
        } catch {
          setQueueByRound(new Map());
        }
      }
    } catch {
      // Offline — keep what we had
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchData();
      return subscribePipeline((event) => {
        if (
          event.type === 'backup:complete' ||
          event.type === 'backup:idle' ||
          event.type === 'compose:complete'
        ) {
          fetchData();
        }
      });
    }, [fetchData]),
  );

  const handleDelete = useCallback(
    async (roundId: string) => {
      try {
        await deleteRound(roundId);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setRounds((prev) => prev.filter((r) => r.id !== roundId));
      } catch {}
    },
    [],
  );

  const handleRetryBackup = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setRetryingBackup(true);
    try {
      // The ONLY backup path: re-drain the gated queue. It exits
      // immediately for free-tier / backup-off users.
      await processUploadQueue();
      await fetchData();
    } finally {
      setRetryingBackup(false);
    }
  }, [fetchData]);

  // Bucket assignment
  const bucketOf = (r: OpsRound): BackupBucket => {
    const queueStatus = queueByRound.get(r.id);
    if (queueStatus === 'error') return 'backup-failed';
    if (
      queueStatus === 'pending' ||
      queueStatus === 'in_progress' ||
      (backup.status === 'uploading' && backup.roundId === r.id)
    ) {
      return 'backing-up';
    }
    if (r.status === 'recording') return 'drafts';
    return 'synced';
  };

  const sections: Section[] = [];
  for (const key of ['drafts', 'backing-up', 'backup-failed', 'synced'] as BackupBucket[]) {
    const bucketRounds = rounds.filter((r) => bucketOf(r) === key);
    if (bucketRounds.length > 0) {
      sections.push({
        key,
        title: BUCKET_CONFIG[key].title,
        icon: bucketIcon(key),
        statusColor: BUCKET_CONFIG[key].color,
        data: bucketRounds,
      });
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Stack.Screen options={{ title: 'Backup & status' }} />

      {loading ? (
        <View style={{ padding: 16, gap: 10 }}>
          <Skeleton width="40%" height={18} style={{ marginBottom: 8 }} />
          <Skeleton width="100%" height={88} borderRadius={theme.radius.lg} />
          <Skeleton width="100%" height={88} borderRadius={theme.radius.lg} />
          <Skeleton width="40%" height={18} style={{ marginTop: 16, marginBottom: 8 }} />
          <Skeleton width="100%" height={88} borderRadius={theme.radius.lg} />
        </View>
      ) : rounds.length === 0 ? (
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
              ...theme.typography.h3,
              color: theme.colors.textPrimary,
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            Nothing here yet
          </Text>
          <Text
            style={{
              ...theme.typography.bodySmall,
              color: theme.colors.textSecondary,
              textAlign: 'center',
              maxWidth: 260,
            }}
          >
            Your drafts, backup progress, and synced rounds will all appear here.
          </Text>
        </View>
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
              <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '700' }}>
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
                <Text style={{ color: section.statusColor, fontSize: 12, fontWeight: '600' }}>
                  {section.data.length}
                </Text>
              </View>
              {section.key === 'backup-failed' && (
                <Pressable
                  onPress={handleRetryBackup}
                  disabled={retryingBackup}
                  style={{
                    marginLeft: 'auto',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: theme.radius.full,
                    backgroundColor: theme.colors.surfaceElevated,
                    borderWidth: 1,
                    borderColor: theme.colors.surfaceBorder,
                    opacity: retryingBackup ? 0.5 : 1,
                  }}
                  accessibilityLabel="Retry backup"
                  accessibilityRole="button"
                >
                  <RefreshCw size={12} color={theme.colors.textPrimary} />
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 12, fontWeight: '600' }}>
                    Retry backup
                  </Text>
                </Pressable>
              )}
            </View>
          )}
          renderItem={({ item }) => {
            const status = statuses.get(item.id)?.status ?? 'NO_CONTENT';
            return (
              <RoundListCard
                round={item}
                status={status}
                onPress={() => router.push(`/round/${item.id}`)}
                onDelete={() => handleDelete(item.id)}
                onRetry={
                  status === 'FAILED'
                    ? () => router.push(`/round/editor?roundId=${item.id}&recompose=1`)
                    : undefined
                }
              />
            );
          }}
          contentContainerStyle={{ paddingBottom: 40 }}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchData();
              }}
              tintColor={theme.colors.primary}
            />
          }
        />
      )}
    </View>
  );
}
